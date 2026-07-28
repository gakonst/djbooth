use anyhow::{Result, bail};
use rayon::prelude::*;
use rustfft::{FftPlanner, num_complex::Complex32};
use serde::{Deserialize, Serialize};

use crate::anlz::BeatGridEntry;

const FFT_SIZE: usize = 2_048;
const HOP_SIZE: usize = 512;
const LOW_ONSET_MAX_BIN: usize = 7;
const BASS_ONSET_MAX_BIN: usize = 12;
const BODY_ONSET_MAX_BIN: usize = 93;
const KICK_ONSET_MIN_BIN: usize = 5;
const KICK_ONSET_MAX_BIN: usize = 12;
const MID_ONSET_MIN_BIN: usize = 33;
const MID_ONSET_MAX_BIN: usize = 64;
const FFT_CENTER_OFFSET_FRAMES: f32 = FFT_SIZE as f32 / (2 * HOP_SIZE) as f32;
const MIN_BPM: f32 = 70.0;
const MAX_BPM: f32 = 180.0;

/// Clean-room beat-grid estimate derived from decoded mono PCM.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BeatAnalysis {
    pub bpm: f64,
    pub confidence: f32,
    pub beats: Vec<BeatGridEntry>,
    /// Microsecond remainder paired by index with each floor-millisecond PQTZ entry.
    pub beat_time_residuals_us: Vec<u16>,
}

/// Estimate tempo, phase, bar position, and a complete Rekordbox beat grid.
///
/// Input samples must be finite mono PCM in `[-1, 1]`. The implementation uses
/// a 2,048-sample Hann STFT, positive spectral flux, an unbiased
/// autocorrelation tempo search, and a separate phase search.
pub fn analyze_beats(samples: &[f32], sample_rate: u32) -> Result<BeatAnalysis> {
    if sample_rate == 0 {
        bail!("beat analysis requires a non-zero sample rate");
    }
    if samples.len() < sample_rate as usize * 4 {
        bail!("beat analysis requires at least four seconds of audio");
    }
    if samples.iter().any(|sample| !sample.is_finite()) {
        bail!("beat analysis received non-finite PCM");
    }

    let onset = spectral_flux(samples);
    if onset.full.len() < 8 {
        bail!("beat analysis produced too few onset frames");
    }
    let onset_rate = sample_rate as f32 / HOP_SIZE as f32;
    let (initial_period, tempo_score, runner_up_score) = estimate_period(&onset.full, onset_rate)?;
    let (period, initial_phase, mut alignment) = refine_period_and_phase(&onset, initial_period);
    let phase = robust_phase(&onset, period, initial_phase);
    if phase != initial_phase {
        alignment = grid_alignment_score(&onset, period, phase);
    }
    let raw_beats = regular_grid(onset.full.len() as f64, period, phase);
    if raw_beats.len() < 4 {
        bail!("beat analysis produced too few beats");
    }

    let onset_beats = raw_beats
        .iter()
        .map(|frame| *frame as f32 - FFT_CENTER_OFFSET_FRAMES)
        .collect::<Vec<_>>();
    let bar_offset = estimate_bar_offset(&onset.low, &onset_beats, raw_beats[0] as f32, period);
    let bpm = 60.0 * onset_rate as f64 / period as f64;
    let bpm_hundredths = (bpm * 100.0).round().clamp(1.0, u16::MAX as f64) as u16;
    let duration_ms = samples.len() as f64 * 1_000.0 / sample_rate as f64;
    let timed_beats = raw_beats
        .iter()
        .enumerate()
        .filter_map(|(index, frame)| {
            let time_us = (*frame * HOP_SIZE as f64 * 1_000_000.0 / sample_rate as f64).round();
            let time_ms = time_us / 1_000.0;
            (time_ms <= duration_ms + 1.0).then_some((
                BeatGridEntry {
                    beat: ((index + bar_offset) % 4 + 1) as u16,
                    bpm_hundredths,
                    time_ms: (time_us / 1_000.0).floor().clamp(0.0, u32::MAX as f64) as u32,
                },
                time_us.rem_euclid(1_000.0) as u16,
            ))
        })
        .collect::<Vec<_>>();
    let (beats, beat_time_residuals_us) = timed_beats.into_iter().unzip();
    let tempo_margin = if tempo_score > 0.0 {
        ((tempo_score - runner_up_score) / tempo_score).max(0.0)
    } else {
        0.0
    };
    let confidence = (0.65 * tempo_margin + 0.35 * alignment).clamp(0.0, 1.0);

    Ok(BeatAnalysis {
        bpm,
        confidence,
        beats,
        beat_time_residuals_us,
    })
}

struct OnsetEnvelopes {
    full: Vec<f32>,
    low: Vec<f32>,
    body: Vec<f32>,
    kick: Vec<f32>,
    bass: Vec<f32>,
    mid: Vec<f32>,
}

fn spectral_flux(samples: &[f32]) -> OnsetEnvelopes {
    let frame_count = samples
        .len()
        .saturating_sub(FFT_SIZE)
        .checked_div(HOP_SIZE)
        .unwrap_or_default()
        + usize::from(samples.len() >= FFT_SIZE);
    if frame_count == 0 {
        return OnsetEnvelopes {
            full: Vec::new(),
            low: Vec::new(),
            body: Vec::new(),
            kick: Vec::new(),
            bass: Vec::new(),
            mid: Vec::new(),
        };
    }
    let window = (0..FFT_SIZE)
        .map(|index| {
            0.5 - 0.5 * (std::f32::consts::TAU * index as f32 / (FFT_SIZE - 1) as f32).cos()
        })
        .collect::<Vec<_>>();
    let worker_count = rayon::current_thread_index()
        .map(|_| rayon::current_num_threads())
        .unwrap_or(1)
        .min(frame_count);
    let chunk_len = frame_count.div_ceil(worker_count);
    let ranges = (0..frame_count)
        .step_by(chunk_len)
        .map(|start| start..(start + chunk_len).min(frame_count))
        .collect::<Vec<_>>();
    let chunks = ranges
        .into_par_iter()
        .map(|range| spectral_flux_range(samples, &window, range))
        .collect::<Vec<_>>();
    let mut full = Vec::with_capacity(frame_count);
    let mut low = Vec::with_capacity(frame_count);
    let mut body = Vec::with_capacity(frame_count);
    let mut kick = Vec::with_capacity(frame_count);
    let mut bass = Vec::with_capacity(frame_count);
    let mut mid = Vec::with_capacity(frame_count);
    for chunk in chunks {
        full.extend(chunk.full);
        low.extend(chunk.low);
        body.extend(chunk.body);
        kick.extend(chunk.kick);
        bass.extend(chunk.bass);
        mid.extend(chunk.mid);
    }

    OnsetEnvelopes {
        full: adaptive_normalize(&full, 8),
        low: adaptive_normalize(&low, 8),
        body: adaptive_normalize(&body, 8),
        kick: adaptive_normalize(&kick, 8),
        bass: adaptive_normalize(&bass, 8),
        mid: adaptive_normalize(&mid, 8),
    }
}

fn spectral_flux_range(
    samples: &[f32],
    window: &[f32],
    range: std::ops::Range<usize>,
) -> OnsetEnvelopes {
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let mut spectrum = vec![Complex32::default(); FFT_SIZE];
    let mut previous = vec![0.0f32; FFT_SIZE / 2 + 1];
    let mut full_flux = Vec::with_capacity(range.len());
    let mut low_flux = Vec::with_capacity(range.len());
    let mut body_flux = Vec::with_capacity(range.len());
    let mut kick_flux = Vec::with_capacity(range.len());
    let mut bass_flux = Vec::with_capacity(range.len());
    let mut mid_flux = Vec::with_capacity(range.len());

    if range.start > 0 {
        let previous_start = (range.start - 1) * HOP_SIZE;
        let frame = &samples[previous_start..previous_start + FFT_SIZE];
        for (index, value) in frame.iter().enumerate() {
            spectrum[index] = Complex32::new(*value * window[index], 0.0);
        }
        fft.process(&mut spectrum);
        for (magnitude, bin) in previous.iter_mut().zip(&spectrum).skip(1) {
            *magnitude = (1.0 + 10.0 * bin.norm()).ln();
        }
    }

    for frame_index in range {
        let frame_start = frame_index * HOP_SIZE;
        let frame = &samples[frame_start..frame_start + FFT_SIZE];
        for (index, value) in frame.iter().enumerate() {
            spectrum[index] = Complex32::new(*value * window[index], 0.0);
        }
        fft.process(&mut spectrum);
        let mut full_value = 0.0;
        let mut low_value = 0.0;
        let mut body_value = 0.0;
        let mut kick_value = 0.0;
        let mut bass_value = 0.0;
        let mut mid_value = 0.0;
        for (index, bin) in spectrum[..=FFT_SIZE / 2].iter().enumerate().skip(1) {
            let magnitude = (1.0 + 10.0 * bin.norm()).ln();
            let difference = (magnitude - previous[index]).max(0.0);
            full_value += difference;
            if index <= LOW_ONSET_MAX_BIN {
                low_value += difference;
            }
            if index <= BODY_ONSET_MAX_BIN {
                body_value += difference;
            }
            if (KICK_ONSET_MIN_BIN..=KICK_ONSET_MAX_BIN).contains(&index) {
                kick_value += difference;
            }
            if index <= BASS_ONSET_MAX_BIN {
                bass_value += difference;
            }
            if (MID_ONSET_MIN_BIN..=MID_ONSET_MAX_BIN).contains(&index) {
                mid_value += difference;
            }
            previous[index] = magnitude;
        }
        full_flux.push(full_value);
        low_flux.push(low_value);
        body_flux.push(body_value);
        kick_flux.push(kick_value);
        bass_flux.push(bass_value);
        mid_flux.push(mid_value);
    }
    OnsetEnvelopes {
        full: full_flux,
        low: low_flux,
        body: body_flux,
        kick: kick_flux,
        bass: bass_flux,
        mid: mid_flux,
    }
}

fn adaptive_normalize(values: &[f32], radius: usize) -> Vec<f32> {
    if values.is_empty() {
        return Vec::new();
    }
    let mut prefix = Vec::with_capacity(values.len() + 1);
    prefix.push(0.0);
    for value in values {
        prefix.push(prefix.last().copied().unwrap_or_default() + value);
    }
    let mut output = Vec::with_capacity(values.len());
    for (index, value) in values.iter().enumerate() {
        let start = index.saturating_sub(radius);
        let end = (index + radius + 1).min(values.len());
        let mean = (prefix[end] - prefix[start]) / (end - start) as f32;
        output.push((*value - mean * 1.05).max(0.0));
    }
    let mut sorted = output.clone();
    sorted.sort_by(f32::total_cmp);
    let scale = sorted[(sorted.len() * 95 / 100).min(sorted.len() - 1)].max(f32::EPSILON);
    for value in &mut output {
        *value = (*value / scale).clamp(0.0, 1.0);
    }
    output
}

fn estimate_period(onset: &[f32], onset_rate: f32) -> Result<(f32, f32, f32)> {
    let min_lag = (onset_rate * 60.0 / MAX_BPM).floor().max(2.0) as usize;
    let max_lag = (onset_rate * 60.0 / MIN_BPM).ceil() as usize;
    if onset.len() <= max_lag {
        bail!("audio is too short for the configured tempo range");
    }

    let mut correlations = vec![0.0f32; max_lag + 2];
    let correlation_start = min_lag.saturating_sub(1);
    let correlation_end = (max_lag + 1).min(onset.len() - 1);
    for (lag, value) in correlations
        .iter_mut()
        .enumerate()
        .take(correlation_end + 1)
        .skip(correlation_start)
    {
        *value = normalized_correlation(onset, lag);
    }

    let mut baseline_candidates =
        tempo_candidates(&correlations, onset_rate, min_lag, max_lag, 0.55, 0.15);
    let mut alternative_candidates =
        tempo_candidates(&correlations, onset_rate, min_lag, max_lag, 0.4, 0.10);
    baseline_candidates.sort_by(|left, right| right.1.total_cmp(&left.1));
    alternative_candidates.sort_by(|left, right| right.1.total_cmp(&left.1));
    let baseline_lag = baseline_candidates
        .first()
        .map(|value| value.0)
        .unwrap_or(min_lag);
    let alternative_lag = alternative_candidates
        .first()
        .map(|value| value.0)
        .unwrap_or(baseline_lag);
    let candidates = if canonical_tempo_ratio(alternative_lag as f32 / baseline_lag as f32) {
        &alternative_candidates
    } else {
        &baseline_candidates
    };
    let Some(&(best_lag, best_score)) = candidates.first() else {
        bail!("tempo search produced no candidates");
    };
    if best_score <= f32::EPSILON {
        bail!("audio has no measurable rhythmic onset energy");
    }
    let runner_up = candidates
        .iter()
        .find(|(lag, _)| lag.abs_diff(best_lag) > 2)
        .map(|(_, score)| *score)
        .unwrap_or_default();

    let left = correlations[best_lag - 1];
    let center = correlations[best_lag];
    let right = correlations[best_lag + 1];
    let denominator = left - 2.0 * center + right;
    let delta = if denominator.abs() > 1.0e-6 {
        (0.5 * (left - right) / denominator).clamp(-0.5, 0.5)
    } else {
        0.0
    };
    Ok((best_lag as f32 + delta, best_score, runner_up))
}

fn tempo_candidates(
    correlations: &[f32],
    onset_rate: f32,
    min_lag: usize,
    max_lag: usize,
    prior_sigma: f32,
    half_harmonic_weight: f32,
) -> Vec<(usize, f32)> {
    (min_lag..=max_lag)
        .map(|lag| {
            let bpm = 60.0 * onset_rate / lag as f32;
            let center_prior = (-0.5 * (bpm / 120.0).log2().powi(2) / prior_sigma.powi(2)).exp();
            let harmonic = correlations.get(lag * 2).copied().unwrap_or_default() * 0.10
                + correlations.get(lag / 2).copied().unwrap_or_default() * half_harmonic_weight;
            (
                lag,
                (correlations[lag] + harmonic) * (0.55 + 0.45 * center_prior),
            )
        })
        .collect()
}

fn canonical_tempo_ratio(ratio: f32) -> bool {
    (0.48..=0.52).contains(&ratio)
        || (0.64..=0.70).contains(&ratio)
        || (0.78..=0.81).contains(&ratio)
        || (1.30..=1.36).contains(&ratio)
}

fn normalized_correlation(values: &[f32], lag: usize) -> f32 {
    let mut cross = 0.0;
    let mut left_energy = 0.0;
    let mut right_energy = 0.0;
    for index in lag..values.len() {
        let left = values[index];
        let right = values[index - lag];
        cross += left * right;
        left_energy += left * left;
        right_energy += right * right;
    }
    let normalization = (left_energy * right_energy).sqrt();
    if normalization > f32::EPSILON {
        cross / normalization
    } else {
        0.0
    }
}

fn refine_period_and_phase(onset: &OnsetEnvelopes, initial_period: f32) -> (f32, f32, f32) {
    let mut best = (initial_period, 0.0, f32::NEG_INFINITY);
    for period_step in -100..=100 {
        let period = initial_period + period_step as f32 * 0.01;
        if period <= 2.0 {
            continue;
        }
        let phase_steps = (period * 2.0).ceil() as usize;
        for phase_step in 0..phase_steps {
            let phase = phase_step as f32 * 0.5;
            let score = grid_alignment_score(onset, period, phase);
            if score > best.2 {
                best = (period, phase, score);
            }
        }
    }

    let coarse = best;
    for period_step in -30..=30 {
        let period = coarse.0 + period_step as f32 * 0.001;
        for phase_step in -10..=10 {
            let phase = (coarse.1 + phase_step as f32 * 0.05).rem_euclid(period);
            let score = grid_alignment_score(onset, period, phase);
            if score > best.2 {
                best = (period, phase, score);
            }
        }
    }
    best
}

fn grid_alignment_score(onset: &OnsetEnvelopes, period: f32, phase: f32) -> f32 {
    let margin = period * 4.0;
    let mut frame = phase;
    while frame < margin {
        frame += period;
    }
    let end = onset.full.len() as f32 - margin;
    let mut score = 0.0;
    let mut count = 0usize;
    while frame < end {
        let low = interpolate(&onset.low, frame);
        let body = interpolate(&onset.body, frame);
        score += 0.65 * low + 0.35 * body;
        count += 1;
        frame += period;
    }
    score / count.max(1) as f32
}

fn robust_phase(onset: &OnsetEnvelopes, period: f32, selected_phase: f32) -> f32 {
    const MIN_SEGMENTS: usize = 8;
    const MIN_KICK_GAIN: f32 = 0.075;
    const MIN_KICK_VOTE_SHARE: f32 = 0.75;
    const MIN_BASS_RATIO: f32 = 1.12;
    const MIN_MID_MEAN_RATIO: f32 = 1.33;
    const MIN_MID_SQUARED_RATIO: f32 = 1.48;
    const MIN_MID_KICK_GAIN: f32 = -0.2;

    let selected_kick_score = kick_alignment_score(onset, period, selected_phase);
    let (kick_phase, kick_score) = best_opposite_phase(period, selected_phase, |phase| {
        kick_alignment_score(onset, period, phase)
    });
    let kick_gain = (kick_score - selected_kick_score) / kick_score.max(f32::EPSILON);
    let (selected_votes, kick_votes, tied_votes) =
        kick_segment_votes(onset, period, selected_phase, kick_phase, 16);
    let total_segments = selected_votes + kick_votes + tied_votes;
    let selected_bass = optimized_envelope_moments(&onset.bass, period, selected_phase).0;
    let kick_bass = optimized_envelope_moments(&onset.bass, period, kick_phase).0;
    if circular_distance(kick_phase, selected_phase, period) >= period * 0.35
        && kick_gain >= MIN_KICK_GAIN
        && total_segments >= MIN_SEGMENTS
        && kick_votes as f32 / total_segments as f32 >= MIN_KICK_VOTE_SHARE
        && kick_bass > f32::EPSILON
        && kick_bass >= selected_bass * MIN_BASS_RATIO
    {
        return kick_phase;
    }

    let (mid_phase, _) = best_opposite_phase(period, selected_phase, |phase| {
        envelope_alignment_moments(&onset.mid, period, phase).0
    });
    let selected_mid = optimized_envelope_moments(&onset.mid, period, selected_phase);
    let candidate_mid = optimized_envelope_moments(&onset.mid, period, mid_phase);
    if circular_distance(mid_phase, selected_phase, period) >= period * 0.35
        && candidate_mid.0 > f32::EPSILON
        && candidate_mid.1 > f32::EPSILON
        && candidate_mid.0 >= selected_mid.0 * MIN_MID_MEAN_RATIO
        && candidate_mid.1 >= selected_mid.1 * MIN_MID_SQUARED_RATIO
        && kick_gain >= MIN_MID_KICK_GAIN
    {
        return mid_phase;
    }

    selected_phase
}

fn best_opposite_phase(
    period: f32,
    selected_phase: f32,
    mut score: impl FnMut(f32) -> f32,
) -> (f32, f32) {
    let mut best = (selected_phase, f32::NEG_INFINITY);
    for step in 0..(period * 20.0).ceil() as usize {
        let phase = step as f32 * 0.05;
        if circular_distance(phase, selected_phase, period) < period * 0.35 {
            continue;
        }
        let candidate_score = score(phase);
        if candidate_score > best.1 {
            best = (phase, candidate_score);
        }
    }
    best
}

fn kick_alignment_score(onset: &OnsetEnvelopes, period: f32, phase: f32) -> f32 {
    let margin = period * 4.0;
    let mut frame = phase;
    while frame < margin {
        frame += period;
    }
    let end = onset.full.len() as f32 - margin;
    let mut score = 0.0;
    let mut count = 0usize;
    while frame < end {
        score += kick_alignment_value(onset, frame);
        count += 1;
        frame += period;
    }
    score / count.max(1) as f32
}

fn kick_alignment_value(onset: &OnsetEnvelopes, frame: f32) -> f32 {
    let current = 0.65 * interpolate(&onset.low, frame) + 0.35 * interpolate(&onset.body, frame);
    interpolate(&onset.kick, frame) + 0.1 * current
}

fn kick_segment_votes(
    onset: &OnsetEnvelopes,
    period: f32,
    selected_phase: f32,
    candidate_phase: f32,
    segment_beats: usize,
) -> (usize, usize, usize) {
    let margin = period * 4.0;
    let end = onset.full.len() as f32 - margin;
    let mut selected_frame = selected_phase;
    let mut candidate_frame = candidate_phase;
    while selected_frame < margin {
        selected_frame += period;
    }
    while candidate_frame < margin {
        candidate_frame += period;
    }

    let mut selected_votes = 0;
    let mut candidate_votes = 0;
    let mut tied_votes = 0;
    let mut selected_score = 0.0;
    let mut candidate_score = 0.0;
    let mut beat_count = 0;
    while selected_frame < end && candidate_frame < end {
        selected_score += kick_alignment_value(onset, selected_frame);
        candidate_score += kick_alignment_value(onset, candidate_frame);
        beat_count += 1;
        selected_frame += period;
        candidate_frame += period;
        if beat_count == segment_beats {
            record_phase_vote(
                selected_score,
                candidate_score,
                &mut selected_votes,
                &mut candidate_votes,
                &mut tied_votes,
            );
            selected_score = 0.0;
            candidate_score = 0.0;
            beat_count = 0;
        }
    }
    if beat_count > 0 {
        record_phase_vote(
            selected_score / beat_count as f32,
            candidate_score / beat_count as f32,
            &mut selected_votes,
            &mut candidate_votes,
            &mut tied_votes,
        );
    }
    (selected_votes, candidate_votes, tied_votes)
}

fn record_phase_vote(
    selected_score: f32,
    candidate_score: f32,
    selected_votes: &mut usize,
    candidate_votes: &mut usize,
    tied_votes: &mut usize,
) {
    if (selected_score - candidate_score).abs() <= 1.0e-6 {
        *tied_votes += 1;
    } else if selected_score > candidate_score {
        *selected_votes += 1;
    } else {
        *candidate_votes += 1;
    }
}

fn optimized_envelope_moments(envelope: &[f32], period: f32, phase: f32) -> (f32, f32) {
    let mut best_mean = f32::NEG_INFINITY;
    let mut best_squared = f32::NEG_INFINITY;
    let radius_steps = (period * 0.2 / 0.25).ceil() as i32;
    for step in -radius_steps..=radius_steps {
        let (mean, squared) =
            envelope_alignment_moments(envelope, period, phase + step as f32 * 0.25);
        best_mean = best_mean.max(mean);
        best_squared = best_squared.max(squared);
    }
    (best_mean, best_squared)
}

fn envelope_alignment_moments(envelope: &[f32], period: f32, phase: f32) -> (f32, f32) {
    let margin = period * 4.0;
    let mut frame = phase;
    while frame < margin {
        frame += period;
    }
    let end = envelope.len() as f32 - margin;
    let mut sum = 0.0;
    let mut squared = 0.0;
    let mut count = 0;
    while frame < end {
        let value = interpolate(envelope, frame);
        sum += value;
        squared += value * value;
        count += 1;
        frame += period;
    }
    let denominator = count.max(1) as f32;
    (sum / denominator, squared / denominator)
}

fn circular_distance(left: f32, right: f32, period: f32) -> f32 {
    let distance = (left - right).abs().rem_euclid(period);
    distance.min(period - distance)
}

fn regular_grid(onset_len: f64, period: f32, phase: f32) -> Vec<f64> {
    let mut beats = Vec::new();
    let period = f64::from(period);
    let mut predicted = f64::from(phase.rem_euclid(period as f32) + FFT_CENTER_OFFSET_FRAMES);
    let backfilled = predicted - period;
    if backfilled >= 1.0 {
        predicted = backfilled;
    }
    while predicted < onset_len + f64::from(FFT_CENTER_OFFSET_FRAMES) {
        beats.push(predicted);
        predicted += period;
    }
    beats
}

fn estimate_bar_offset(
    onset: &[f32],
    beats: &[f32],
    first_centered_beat: f32,
    period: f32,
) -> usize {
    let mut scores = (0..4)
        .map(|offset| {
            let mut values = beats
                .iter()
                .skip(offset)
                .step_by(4)
                .map(|frame| interpolate(onset, *frame))
                .collect::<Vec<_>>();
            values.sort_by(|left, right| right.total_cmp(left));
            let retained = (values.len() / 2).max(1);
            let score = values.iter().take(retained).sum::<f32>() / retained as f32;
            (offset, score)
        })
        .collect::<Vec<_>>();
    scores.sort_by(|left, right| right.1.total_cmp(&left.1));
    let (strongest, strongest_score) = scores[0];
    let runner_up_score = scores.get(1).map(|(_, score)| *score).unwrap_or_default();
    let relative_margin =
        (strongest_score - runner_up_score).max(0.0) / strongest_score.max(f32::EPSILON);
    if relative_margin <= 0.02 {
        // Native grids overwhelmingly start on beat one, except when analysis
        // begins just before the next full beat and omits a negative-time beat.
        return usize::from(first_centered_beat >= period * 0.9);
    }
    (4 - strongest) % 4
}

fn interpolate(values: &[f32], position: f32) -> f32 {
    let left = position.floor().max(0.0) as usize;
    let right = (left + 1).min(values.len().saturating_sub(1));
    let fraction = position - left as f32;
    values.get(left).copied().unwrap_or_default() * (1.0 - fraction)
        + values.get(right).copied().unwrap_or_default() * fraction
}

#[cfg(test)]
mod tests {
    use super::*;

    fn phase_fixture(
        selected_kick: f32,
        candidate_kick: f32,
        selected_bass: f32,
        candidate_bass: f32,
        selected_mid: f32,
        candidate_mid: f32,
    ) -> OnsetEnvelopes {
        const PERIOD: usize = 40;
        const BEATS: usize = 200;
        let mut low = vec![0.0; PERIOD * BEATS];
        let mut body = low.clone();
        let mut kick = low.clone();
        let mut bass = low.clone();
        let mut mid = low.clone();
        for beat in 0..BEATS {
            let selected = beat * PERIOD + 10;
            let candidate = beat * PERIOD + 30;
            low[selected] = 0.6;
            low[candidate] = 0.6;
            body[selected] = 0.6;
            body[candidate] = 0.6;
            kick[selected] = selected_kick;
            kick[candidate] = candidate_kick;
            bass[selected] = selected_bass;
            bass[candidate] = candidate_bass;
            mid[selected] = selected_mid;
            mid[candidate] = candidate_mid;
        }
        OnsetEnvelopes {
            full: body.clone(),
            low,
            body,
            kick,
            bass,
            mid,
        }
    }

    fn clicks(bpm: f32, seconds: usize, downbeat_gain: f32) -> Vec<f32> {
        let sample_rate = 44_100usize;
        let period = sample_rate as f32 * 60.0 / bpm;
        let mut output = vec![0.0f32; sample_rate * seconds];
        let mut beat = 0usize;
        let mut position = 0.0f32;
        while position < output.len() as f32 {
            let start = position.round() as usize;
            let gain = if beat.is_multiple_of(4) {
                downbeat_gain
            } else {
                0.7
            };
            for offset in 0..256usize {
                if let Some(sample) = output.get_mut(start + offset) {
                    *sample += gain
                        * (-(offset as f32) / 32.0).exp()
                        * (std::f32::consts::TAU * 1_200.0 * offset as f32 / 44_100.0).sin();
                }
            }
            beat += 1;
            position += period;
        }
        output
    }

    #[test]
    fn tracks_clean_click_grids_and_downbeats() {
        for expected in [90.0f32, 120.0, 127.0, 140.0] {
            let result = analyze_beats(&clicks(expected, 24, 1.0), 44_100).expect("beat analysis");
            assert!(
                (result.bpm - expected as f64).abs() < 0.8,
                "expected {expected}, got {}",
                result.bpm
            );
            assert!(result.beats.len() > 30);
            assert!(result.beats.iter().any(|beat| beat.beat == 1));
            assert!(
                result
                    .beats
                    .windows(2)
                    .all(|pair| pair[1].beat == pair[0].beat % 4 + 1)
            );
            assert!(result.beats[0].time_ms < (60_000.0 / expected) as u32 + 30);
            assert_eq!(result.beats.len(), result.beat_time_residuals_us.len());
            assert!(
                result
                    .beat_time_residuals_us
                    .iter()
                    .all(|residual| *residual <= 999)
            );
            let precise_times = result
                .beats
                .iter()
                .zip(&result.beat_time_residuals_us)
                .map(|(beat, residual)| u64::from(beat.time_ms) * 1_000 + u64::from(*residual))
                .collect::<Vec<_>>();
            let intervals = precise_times
                .windows(2)
                .map(|pair| pair[1] - pair[0])
                .collect::<Vec<_>>();
            let shortest = intervals.iter().min().copied().expect("beat interval");
            let longest = intervals.iter().max().copied().expect("beat interval");
            assert!(
                longest - shortest <= 1,
                "straight grids must not independently snap or jitter: {shortest}..={longest} us"
            );
        }
    }

    #[test]
    fn ambiguous_meter_uses_native_start_boundary_prior() {
        let onset = vec![0.0; 256];
        let beats = (0..16).map(|index| index as f32 * 40.0).collect::<Vec<_>>();
        assert_eq!(estimate_bar_offset(&onset, &beats, 38.0, 40.0), 1);
        assert_eq!(estimate_bar_offset(&onset, &beats, 20.0, 40.0), 0);
    }

    #[test]
    fn metrical_tempo_gate_only_accepts_validated_ratio_families() {
        for ratio in [0.5, 2.0 / 3.0, 0.8, 4.0 / 3.0] {
            assert!(canonical_tempo_ratio(ratio));
        }
        for ratio in [0.6, 0.75, 1.0, 1.5] {
            assert!(!canonical_tempo_ratio(ratio));
        }
    }

    #[test]
    fn kick_phase_requires_bass_and_segment_consensus() {
        let supported = phase_fixture(0.4, 1.0, 0.4, 1.0, 0.0, 0.0);
        assert!(circular_distance(robust_phase(&supported, 40.0, 10.0), 30.0, 40.0) < 0.1);

        let offbeat_bass = phase_fixture(0.4, 1.0, 1.0, 1.0, 0.0, 0.0);
        assert_eq!(robust_phase(&offbeat_bass, 40.0, 10.0), 10.0);
    }

    #[test]
    fn mid_band_phase_requires_noncontradictory_kick_evidence() {
        let supported = phase_fixture(0.6, 0.55, 1.0, 1.0, 0.4, 0.8);
        assert!(circular_distance(robust_phase(&supported, 40.0, 10.0), 30.0, 40.0) < 0.1);

        let contradicted = phase_fixture(1.0, 0.4, 1.0, 1.0, 0.4, 0.8);
        assert_eq!(robust_phase(&contradicted, 40.0, 10.0), 10.0);
    }

    #[test]
    fn rejects_silence() {
        let error = analyze_beats(&vec![0.0; 44_100 * 8], 44_100).expect_err("silence");
        assert!(error.to_string().contains("rhythmic onset"));
    }
}
