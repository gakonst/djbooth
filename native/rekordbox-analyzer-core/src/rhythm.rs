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
    let selected_phase = robust_phase(&onset, period, initial_phase);
    let energy_phase = robust_energy_phase(&onset, period, selected_phase);
    let time_domain = time_domain_envelopes(samples, sample_rate, onset.full.len());
    let time_domain_phase = select_time_domain_phase(&time_domain, period, selected_phase);
    let phase = if energy_phase != selected_phase {
        energy_phase
    } else {
        time_domain_phase
    };
    let phase = robust_body_phase(&onset, period, phase);
    let phase = robust_peak_cadence_phase(&time_domain, period, phase);
    if phase != initial_phase {
        alignment = grid_alignment_score(&onset, period, phase);
    }
    let regular_beats = regular_grid(onset.full.len() as f64, period, phase);
    if regular_beats.len() < 4 {
        bail!("beat analysis produced too few beats");
    }
    let variable_candidate = barwise_tempo_grid(&onset, period, &regular_beats);
    let refined_coherent_candidate = coherent_backward_drift(&variable_candidate)
        .then(|| refine_coherent_drift_grid(&onset, period, &regular_beats, &variable_candidate));
    let use_variable_grid = should_select_variable_grid(&variable_candidate);
    let selected_variable_candidate = refined_coherent_candidate
        .as_ref()
        .unwrap_or(&variable_candidate);
    let raw_beats = if use_variable_grid {
        selected_variable_candidate.beats.as_slice()
    } else {
        regular_beats.as_slice()
    };

    let onset_beats = raw_beats
        .iter()
        .map(|frame| *frame as f32 - FFT_CENTER_OFFSET_FRAMES)
        .collect::<Vec<_>>();
    let bar_offset = if refined_coherent_candidate.is_some() {
        let initial_onset_beats = variable_candidate
            .beats
            .iter()
            .map(|frame| *frame as f32 - FFT_CENTER_OFFSET_FRAMES)
            .collect::<Vec<_>>();
        let initial_bar_offset = estimate_bar_offset(
            &onset.low,
            &initial_onset_beats,
            variable_candidate.beats[0] as f32,
            period,
        );
        preserve_bar_offset(
            initial_bar_offset,
            variable_candidate.beats[0],
            raw_beats[0],
            f64::from(period),
        )
    } else {
        estimate_bar_offset(&onset.low, &onset_beats, raw_beats[0] as f32, period)
    };
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
                    bpm_hundredths: if use_variable_grid {
                        let interval = raw_beats
                            .get(index + 1)
                            .map(|next| *next - *frame)
                            .unwrap_or_else(|| *frame - raw_beats[index - 1]);
                        (60.0 * f64::from(onset_rate) / interval * 100.0)
                            .round()
                            .clamp(1.0, u16::MAX as f64) as u16
                    } else {
                        bpm_hundredths
                    },
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
    kick_energy: Vec<f32>,
    bass_energy: Vec<f32>,
}

struct TimeDomainEnvelopes {
    peak: Vec<f32>,
    rms: Vec<f32>,
    low_rms_local: Vec<f32>,
    mid_rms: Vec<f32>,
    high_rms: Vec<f32>,
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
            kick_energy: Vec::new(),
            bass_energy: Vec::new(),
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
    let mut kick_energy = Vec::with_capacity(frame_count);
    let mut bass_energy = Vec::with_capacity(frame_count);
    for chunk in chunks {
        full.extend(chunk.full);
        low.extend(chunk.low);
        body.extend(chunk.body);
        kick.extend(chunk.kick);
        bass.extend(chunk.bass);
        mid.extend(chunk.mid);
        kick_energy.extend(chunk.kick_energy);
        bass_energy.extend(chunk.bass_energy);
    }

    OnsetEnvelopes {
        full: adaptive_normalize(&full, 8),
        low: adaptive_normalize(&low, 8),
        body: adaptive_normalize(&body, 8),
        kick: adaptive_normalize(&kick, 8),
        bass: adaptive_normalize(&bass, 8),
        mid: adaptive_normalize(&mid, 8),
        kick_energy: adaptive_normalize(&kick_energy, 8),
        bass_energy: adaptive_normalize(&bass_energy, 8),
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
    let mut kick_energy = Vec::with_capacity(range.len());
    let mut bass_energy = Vec::with_capacity(range.len());

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
        let mut kick_power = 0.0;
        let mut bass_power = 0.0;
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
            if (KICK_ONSET_MIN_BIN..=KICK_ONSET_MAX_BIN).contains(&index) {
                kick_power += bin.norm_sqr();
            }
            if index <= BASS_ONSET_MAX_BIN {
                bass_power += bin.norm_sqr();
            }
            previous[index] = magnitude;
        }
        full_flux.push(full_value);
        low_flux.push(low_value);
        body_flux.push(body_value);
        kick_flux.push(kick_value);
        bass_flux.push(bass_value);
        mid_flux.push(mid_value);
        kick_energy.push(kick_power.ln_1p());
        bass_energy.push(bass_power.ln_1p());
    }
    OnsetEnvelopes {
        full: full_flux,
        low: low_flux,
        body: body_flux,
        kick: kick_flux,
        bass: bass_flux,
        mid: mid_flux,
        kick_energy,
        bass_energy,
    }
}

fn robust_energy_phase(onset: &OnsetEnvelopes, period: f32, selected_phase: f32) -> f32 {
    const MIN_SEGMENTS: usize = 8;
    const MIN_KICK_RATIO: f32 = 1.25;
    const MIN_KICK_CONCENTRATION: f32 = 1.2;
    const MIN_VOTE_SHARE: f32 = 0.75;

    let (candidate_phase, _) = best_opposite_phase(period, selected_phase, |phase| {
        envelope_alignment_moments(&onset.kick_energy, period, phase).0
    });
    let selected_kick = optimized_envelope_moments(&onset.kick_energy, period, selected_phase);
    let candidate_kick = optimized_envelope_moments(&onset.kick_energy, period, candidate_phase);
    let selected_bass = optimized_envelope_moments(&onset.bass_energy, period, selected_phase);
    let candidate_bass = optimized_envelope_moments(&onset.bass_energy, period, candidate_phase);
    let (selected_votes, candidate_votes, tied_votes) = phase_segment_votes(
        onset.kick_energy.len(),
        period,
        selected_phase,
        candidate_phase,
        16,
        |frame| interpolate(&onset.kick_energy, frame),
    );
    let total_segments = selected_votes + candidate_votes + tied_votes;
    let kick_ratio = candidate_kick.0 / selected_kick.0.max(f32::EPSILON);
    let bass_ratio = candidate_bass.0 / selected_bass.0.max(f32::EPSILON);
    if circular_distance(candidate_phase, selected_phase, period) >= period * 0.35
        && total_segments >= MIN_SEGMENTS
        && candidate_votes as f32 / total_segments as f32 >= MIN_VOTE_SHARE
        && candidate_kick.0 >= selected_kick.0 * MIN_KICK_RATIO
        && candidate_bass.0 > f32::EPSILON
        && candidate_bass.0 >= selected_bass.0
        && kick_ratio >= bass_ratio * MIN_KICK_CONCENTRATION
    {
        candidate_phase
    } else {
        selected_phase
    }
}

fn select_time_domain_phase(
    envelopes: &TimeDomainEnvelopes,
    period: f32,
    selected_phase: f32,
) -> f32 {
    const MIN_RMS_TOP_HALF_RATIO: f32 = 1.20;
    const MIN_MID_SQUARED_RATIO: f32 = 1.40;
    const MIN_PEAK_MEAN_RATIO: f32 = 1.05;
    const MIN_HIGH_TOP_HALF_RATIO: f32 = 1.84;

    let candidate_phase = (selected_phase + period * 0.5).rem_euclid(period);
    let selected = optimized_time_domain_evidence(envelopes, period, selected_phase);
    let candidate = optimized_time_domain_evidence(envelopes, period, candidate_phase);
    let rms_switch = candidate.rms_top_half > f32::EPSILON
        && candidate.rms_top_half >= selected.rms_top_half * MIN_RMS_TOP_HALF_RATIO;
    let mid_switch = candidate.mid_squared > f32::EPSILON
        && candidate.mid_squared >= selected.mid_squared * MIN_MID_SQUARED_RATIO;
    let high_switch = candidate.peak_mean > f32::EPSILON
        && candidate.high_top_half > f32::EPSILON
        && candidate.peak_mean >= selected.peak_mean * MIN_PEAK_MEAN_RATIO
        && candidate.high_top_half >= selected.high_top_half * MIN_HIGH_TOP_HALF_RATIO;
    if rms_switch || mid_switch || high_switch {
        candidate_phase
    } else {
        selected_phase
    }
}

fn robust_peak_cadence_phase(
    envelopes: &TimeDomainEnvelopes,
    period: f32,
    selected_phase: f32,
) -> f32 {
    const SEGMENT_BEATS: usize = 16;

    let candidate_phase = (selected_phase + period * 0.5).rem_euclid(period);
    let selected = optimized_time_domain_evidence(envelopes, period, selected_phase);
    let candidate = optimized_time_domain_evidence(envelopes, period, candidate_phase);
    let selected_low =
        optimized_envelope_moments(&envelopes.low_rms_local, period, selected_phase).0;
    let candidate_low =
        optimized_envelope_moments(&envelopes.low_rms_local, period, candidate_phase).0;
    let (selected_votes, candidate_votes, tied_votes) = cadence_phase_votes(
        &envelopes.peak,
        period,
        selected_phase,
        candidate_phase,
        SEGMENT_BEATS,
    );
    let (selected_low_votes, candidate_low_votes, tied_low_votes) = cadence_phase_votes(
        &envelopes.low_rms_local,
        period,
        selected_phase,
        candidate_phase,
        SEGMENT_BEATS,
    );
    let total_votes = selected_votes + candidate_votes + tied_votes;
    let total_low_votes = selected_low_votes + candidate_low_votes + tied_low_votes;
    let supported = total_votes >= 8
        && total_low_votes >= 8
        && peak_cadence_supports_opposite_phase(
            candidate_votes as f32 / total_votes.max(1) as f32,
            candidate_low_votes as f32 / total_low_votes.max(1) as f32,
            candidate.peak_mean / selected.peak_mean.max(f32::EPSILON),
            candidate.peak_top_half / selected.peak_top_half.max(f32::EPSILON),
            candidate_low / selected_low.max(f32::EPSILON),
        );
    if supported {
        candidate_phase
    } else {
        selected_phase
    }
}

fn peak_cadence_supports_opposite_phase(
    vote_share: f32,
    low_vote_share: f32,
    peak_mean_ratio: f32,
    peak_top_half_ratio: f32,
    low_local_ratio: f32,
) -> bool {
    vote_share >= 0.6
        && low_vote_share >= 0.6
        && (1.03..=1.10).contains(&peak_mean_ratio)
        && peak_top_half_ratio <= 0.98
        && low_local_ratio >= 0.5
}

fn time_domain_envelopes(
    samples: &[f32],
    sample_rate: u32,
    frame_count: usize,
) -> TimeDomainEnvelopes {
    const LOW_CUTOFF_HZ: f32 = 250.0;
    const HIGH_CUTOFF_HZ: f32 = 4_000.0;

    let sample_rate = sample_rate as f32;
    let low_alpha = 1.0 - (-std::f32::consts::TAU * LOW_CUTOFF_HZ / sample_rate).exp();
    let high_alpha = 1.0 - (-std::f32::consts::TAU * HIGH_CUTOFF_HZ / sample_rate).exp();
    let block_count = samples.len().div_ceil(HOP_SIZE);
    let mut peak = Vec::with_capacity(block_count);
    let mut rms = Vec::with_capacity(block_count);
    let mut low_rms = Vec::with_capacity(block_count);
    let mut mid_rms = Vec::with_capacity(block_count);
    let mut high_rms = Vec::with_capacity(block_count);
    let mut low_state = 0.0f32;
    let mut high_cut_state = 0.0f32;
    for block in samples.chunks(HOP_SIZE) {
        let mut peak_value = 0.0f32;
        let mut energy = 0.0f32;
        let mut low_energy = 0.0f32;
        let mut mid_energy = 0.0f32;
        let mut high_energy = 0.0f32;
        for &sample in block {
            low_state += low_alpha * (sample - low_state);
            high_cut_state += high_alpha * (sample - high_cut_state);
            let mid = high_cut_state - low_state;
            let high = sample - high_cut_state;
            peak_value = peak_value.max(sample.abs());
            energy += sample * sample;
            low_energy += low_state * low_state;
            mid_energy += mid * mid;
            high_energy += high * high;
        }
        let denominator = block.len().max(1) as f32;
        peak.push(peak_value);
        rms.push((energy / denominator).sqrt());
        low_rms.push((low_energy / denominator).sqrt());
        mid_rms.push((mid_energy / denominator).sqrt());
        high_rms.push((high_energy / denominator).sqrt());
    }
    let align = |values: &[f32]| {
        values
            .iter()
            .skip(FFT_CENTER_OFFSET_FRAMES as usize)
            .take(frame_count)
            .copied()
            .collect::<Vec<_>>()
    };
    TimeDomainEnvelopes {
        peak: align_and_normalize_envelope(&peak, frame_count),
        rms: align_and_normalize_envelope(&rms, frame_count),
        low_rms_local: adaptive_normalize(&align(&low_rms), 8),
        mid_rms: align_and_normalize_envelope(&mid_rms, frame_count),
        high_rms: align_and_normalize_envelope(&high_rms, frame_count),
    }
}

fn align_and_normalize_envelope(values: &[f32], frame_count: usize) -> Vec<f32> {
    let mut output = values
        .iter()
        .skip(FFT_CENTER_OFFSET_FRAMES as usize)
        .take(frame_count)
        .copied()
        .collect::<Vec<_>>();
    if output.is_empty() {
        return output;
    }
    let mut sorted = output.clone();
    sorted.sort_by(f32::total_cmp);
    let scale = sorted[(sorted.len() * 95 / 100).min(sorted.len() - 1)].max(f32::EPSILON);
    for value in &mut output {
        *value = (*value / scale).clamp(0.0, 1.0);
    }
    output
}

#[derive(Clone, Copy, Default)]
struct TimeDomainEvidence {
    peak_mean: f32,
    peak_top_half: f32,
    rms_top_half: f32,
    mid_squared: f32,
    high_top_half: f32,
}

fn optimized_time_domain_evidence(
    envelopes: &TimeDomainEnvelopes,
    period: f32,
    phase: f32,
) -> TimeDomainEvidence {
    let mut best = TimeDomainEvidence {
        peak_mean: f32::NEG_INFINITY,
        peak_top_half: f32::NEG_INFINITY,
        rms_top_half: f32::NEG_INFINITY,
        mid_squared: f32::NEG_INFINITY,
        high_top_half: f32::NEG_INFINITY,
    };
    let radius_steps = (period * 0.2 / 0.25).ceil() as i32;
    for step in -radius_steps..=radius_steps {
        let evidence = time_domain_evidence(envelopes, period, phase + step as f32 * 0.25);
        best.peak_mean = best.peak_mean.max(evidence.peak_mean);
        best.peak_top_half = best.peak_top_half.max(evidence.peak_top_half);
        best.rms_top_half = best.rms_top_half.max(evidence.rms_top_half);
        best.mid_squared = best.mid_squared.max(evidence.mid_squared);
        best.high_top_half = best.high_top_half.max(evidence.high_top_half);
    }
    best
}

fn time_domain_evidence(
    envelopes: &TimeDomainEnvelopes,
    period: f32,
    phase: f32,
) -> TimeDomainEvidence {
    let margin = period * 4.0;
    let mut frame = phase;
    while frame < margin {
        frame += period;
    }
    let end = envelopes.rms.len() as f32 - margin;
    let mut mid_squared = 0.0;
    let mut peaks = Vec::new();
    let mut rms = Vec::new();
    let mut high = Vec::new();
    while frame < end {
        peaks.push(interpolate(&envelopes.peak, frame));
        let mid = interpolate(&envelopes.mid_rms, frame);
        mid_squared += mid * mid;
        rms.push(interpolate(&envelopes.rms, frame));
        high.push(interpolate(&envelopes.high_rms, frame));
        frame += period;
    }
    peaks.sort_by(|left, right| right.total_cmp(left));
    rms.sort_by(|left, right| right.total_cmp(left));
    high.sort_by(|left, right| right.total_cmp(left));
    let count = rms.len().max(1) as f32;
    let retained = (rms.len() / 2).max(1);
    TimeDomainEvidence {
        peak_mean: peaks.iter().sum::<f32>() / count,
        peak_top_half: peaks.iter().take(retained).sum::<f32>() / retained as f32,
        rms_top_half: rms.iter().take(retained).sum::<f32>() / retained as f32,
        mid_squared: mid_squared / count,
        high_top_half: high.iter().take(retained).sum::<f32>() / retained as f32,
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
    let best = strong_three_over_two_tempo_candidate(&baseline_candidates, &alternative_candidates)
        .or_else(|| candidates.first().copied());
    let Some((best_lag, best_score)) = best else {
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

fn strong_three_over_two_tempo_candidate(
    baseline: &[(usize, f32)],
    alternative: &[(usize, f32)],
) -> Option<(usize, f32)> {
    const MIN_RELATIVE_SCORE: f32 = 0.93;

    let &(baseline_lag, baseline_score) = baseline.first()?;
    let &(alternative_lag, _) = alternative.first()?;
    if baseline_lag != alternative_lag {
        return None;
    }
    let target = baseline_lag as f32 * 2.0 / 3.0;
    baseline
        .iter()
        .copied()
        .filter(|(lag, _)| (*lag as f32 - target).abs() <= 1.0)
        .max_by(|left, right| left.1.total_cmp(&right.1))
        .filter(|(_, score)| *score >= baseline_score * MIN_RELATIVE_SCORE)
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
    let (selected_votes, kick_votes, tied_votes) = phase_segment_votes(
        onset.full.len(),
        period,
        selected_phase,
        kick_phase,
        16,
        |frame| kick_alignment_value(onset, frame),
    );
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

fn robust_body_phase(onset: &OnsetEnvelopes, period: f32, selected_phase: f32) -> f32 {
    const MIN_SEGMENTS: usize = 8;

    let selected_kick_score = kick_alignment_score(onset, period, selected_phase);
    let (candidate_phase, candidate_kick_score) =
        best_opposite_phase(period, selected_phase, |phase| {
            kick_alignment_score(onset, period, phase)
        });
    let kick_gain =
        (candidate_kick_score - selected_kick_score) / candidate_kick_score.max(f32::EPSILON);
    let (selected_votes, candidate_votes, tied_votes) = phase_segment_votes(
        onset.full.len(),
        period,
        selected_phase,
        candidate_phase,
        16,
        |frame| kick_alignment_value(onset, frame),
    );
    let total_segments = selected_votes + candidate_votes + tied_votes;
    let selected_grid = grid_alignment_score(onset, period, selected_phase);
    let candidate_grid = grid_alignment_score(onset, period, candidate_phase);
    let selected_body = envelope_alignment_moments(&onset.body, period, selected_phase).0;
    let candidate_body = envelope_alignment_moments(&onset.body, period, candidate_phase).0;
    let selected_mid = optimized_envelope_moments(&onset.mid, period, selected_phase).0;
    let candidate_mid = optimized_envelope_moments(&onset.mid, period, candidate_phase).0;
    let selected_bass = optimized_envelope_moments(&onset.bass, period, selected_phase).0;
    let candidate_bass = optimized_envelope_moments(&onset.bass, period, candidate_phase).0;
    let supported = circular_distance(candidate_phase, selected_phase, period) >= period * 0.35
        && total_segments >= MIN_SEGMENTS
        && body_consensus_supports_opposite_phase(
            (candidate_grid - selected_grid) / selected_grid.max(f32::EPSILON),
            kick_gain,
            candidate_votes as f32 / total_segments.max(1) as f32,
            candidate_body / selected_body.max(f32::EPSILON),
            candidate_mid / selected_mid.max(f32::EPSILON),
            candidate_bass / selected_bass.max(f32::EPSILON),
        );
    if supported {
        candidate_phase
    } else {
        selected_phase
    }
}

fn body_consensus_supports_opposite_phase(
    grid_gain: f32,
    kick_gain: f32,
    kick_vote_share: f32,
    body_ratio: f32,
    mid_ratio: f32,
    bass_ratio: f32,
) -> bool {
    (0.0..=0.1).contains(&grid_gain)
        && kick_gain >= 0.15
        && kick_vote_share >= 0.6
        && (1.5..=5.0).contains(&body_ratio)
        && mid_ratio >= 0.9
        && bass_ratio >= 0.9
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

fn phase_segment_votes(
    frame_count: usize,
    period: f32,
    selected_phase: f32,
    candidate_phase: f32,
    segment_beats: usize,
    mut score: impl FnMut(f32) -> f32,
) -> (usize, usize, usize) {
    let margin = period * 4.0;
    let end = frame_count as f32 - margin;
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
        selected_score += score(selected_frame);
        candidate_score += score(candidate_frame);
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

fn cadence_phase_votes(
    envelope: &[f32],
    period: f32,
    selected_phase: f32,
    candidate_phase: f32,
    segment_beats: usize,
) -> (usize, usize, usize) {
    let margin = period * 4.0;
    let end = envelope.len() as f32 - margin;
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
        selected_score += interpolate(envelope, selected_frame);
        candidate_score += interpolate(envelope, candidate_frame);
        beat_count += 1;
        selected_frame += period;
        candidate_frame += period;
        if beat_count == segment_beats {
            let scale = selected_score.max(candidate_score).max(f32::EPSILON);
            if (selected_score - candidate_score).abs() <= scale * 0.01 {
                tied_votes += 1;
            } else if selected_score > candidate_score {
                selected_votes += 1;
            } else {
                candidate_votes += 1;
            }
            selected_score = 0.0;
            candidate_score = 0.0;
            beat_count = 0;
        }
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

struct VariableGridCandidate {
    beats: Vec<f64>,
    emission_gain: f64,
    offset_min: f64,
    offset_max: f64,
    transition_abs_max: f64,
    offset_trend_slope_per_bar: f64,
    offset_trend_correlation: f64,
}

fn should_select_variable_grid(candidate: &VariableGridCandidate) -> bool {
    const MIN_EMISSION_GAIN: f64 = 0.36;
    const MAX_BAR_TRANSITION_FRAMES: f64 = 0.75;
    const MIN_ACCUMULATED_DRIFT_FRAMES: f64 = 10.0;
    const MIN_FORWARD_OFFSET_FRAMES: f64 = 10.0;
    const MIN_BACKWARD_OFFSET_FRAMES: f64 = -2.0;

    let forward_drift = candidate.emission_gain >= MIN_EMISSION_GAIN
        && candidate.transition_abs_max <= MAX_BAR_TRANSITION_FRAMES
        && candidate.offset_max - candidate.offset_min >= MIN_ACCUMULATED_DRIFT_FRAMES
        && candidate.offset_max >= MIN_FORWARD_OFFSET_FRAMES
        && candidate.offset_min >= MIN_BACKWARD_OFFSET_FRAMES;
    forward_drift || coherent_backward_drift(candidate)
}

fn coherent_backward_drift(candidate: &VariableGridCandidate) -> bool {
    candidate.emission_gain >= 0.24
        && candidate.transition_abs_max <= 2.0
        && candidate.offset_max - candidate.offset_min >= 20.0
        && candidate.offset_min <= -10.0
        && candidate.offset_max <= 8.0
        && candidate.offset_trend_correlation.abs() >= 0.70
}

fn refine_coherent_drift_grid(
    onset: &OnsetEnvelopes,
    period: f32,
    regular_beats: &[f64],
    initial_candidate: &VariableGridCandidate,
) -> VariableGridCandidate {
    const NEGATIVE_DRIFT_RADIUS_PERIODS: f64 = 0.96;

    if should_recenter_coherent_drift(initial_candidate) {
        recentered_barwise_tempo_grid(onset, period, regular_beats, initial_candidate)
    } else {
        barwise_tempo_grid_with_radius(
            onset,
            period,
            regular_beats,
            NEGATIVE_DRIFT_RADIUS_PERIODS,
            true,
        )
    }
}

fn should_recenter_coherent_drift(candidate: &VariableGridCandidate) -> bool {
    candidate.offset_trend_slope_per_bar > 0.0
}

fn recentered_barwise_tempo_grid(
    onset: &OnsetEnvelopes,
    period: f32,
    regular_beats: &[f64],
    initial_candidate: &VariableGridCandidate,
) -> VariableGridCandidate {
    const BEATS_PER_BAR: f64 = 4.0;
    const REGULARIZATION_COMPENSATION: f64 = 2.0;
    const MAX_PERIOD_CORRECTION_FRAMES: f64 = 0.5;
    const POSITIVE_DRIFT_RADIUS_PERIODS: f64 = 0.84;

    // Split the phase difference between the global grid and the first
    // regularized path so period correction cannot invent a fresh downbeat.
    let anchor = 0.5 * (regular_beats[0] + initial_candidate.beats[0]);
    let period_correction = (REGULARIZATION_COMPENSATION
        * initial_candidate.offset_trend_slope_per_bar
        / BEATS_PER_BAR)
        .clamp(-MAX_PERIOD_CORRECTION_FRAMES, MAX_PERIOD_CORRECTION_FRAMES);
    let corrected_period = f64::from(period) + period_correction;
    let recentered = regular_grid_from_anchor(onset.full.len() as f64, corrected_period, anchor);
    barwise_tempo_grid_with_radius(
        onset,
        corrected_period as f32,
        &recentered,
        POSITIVE_DRIFT_RADIUS_PERIODS,
        true,
    )
}

fn regular_grid_from_anchor(onset_len: f64, period: f64, anchor: f64) -> Vec<f64> {
    let mut first = anchor;
    while first - period >= 1.0 {
        first -= period;
    }
    let mut beats = Vec::new();
    let mut predicted = first;
    while predicted < onset_len + f64::from(FFT_CENTER_OFFSET_FRAMES) {
        beats.push(predicted);
        predicted += period;
    }
    beats
}

fn barwise_tempo_grid(
    onset: &OnsetEnvelopes,
    period: f32,
    regular_beats: &[f64],
) -> VariableGridCandidate {
    barwise_tempo_grid_with_radius(onset, period, regular_beats, 0.48, false)
}

fn barwise_tempo_grid_with_radius(
    onset: &OnsetEnvelopes,
    period: f32,
    regular_beats: &[f64],
    state_radius_periods: f64,
    center_states_on_zero: bool,
) -> VariableGridCandidate {
    const BEATS_PER_BAR: usize = 4;
    const STATE_STEP: f64 = 0.25;
    const MAX_TRANSITION_FRAMES: f64 = 2.0;
    const TRANSITION_PENALTY: f64 = 0.15;

    let bar_count = regular_beats.len().div_ceil(BEATS_PER_BAR);
    let radius = f64::from(period) * state_radius_periods;
    let states = if center_states_on_zero {
        let radius_steps = (radius / STATE_STEP).floor() as i32;
        (-radius_steps..=radius_steps)
            .map(|step| f64::from(step) * STATE_STEP)
            .collect::<Vec<_>>()
    } else {
        let mut states = Vec::new();
        let mut state = -radius;
        while state <= radius + 1.0e-6 {
            states.push(state);
            state += STATE_STEP;
        }
        states
    };
    let emission = (0..bar_count)
        .map(|bar| {
            states
                .iter()
                .map(|offset| {
                    let start = bar * BEATS_PER_BAR;
                    let end = (start + BEATS_PER_BAR).min(regular_beats.len());
                    let score = regular_beats[start..end]
                        .iter()
                        .map(|beat| {
                            let frame =
                                (*beat - f64::from(FFT_CENTER_OFFSET_FRAMES) + *offset) as f32;
                            0.65 * interpolate(&onset.low, frame)
                                + 0.35 * interpolate(&onset.body, frame)
                        })
                        .sum::<f32>();
                    f64::from(score) / (end - start) as f64
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();

    let mut scores = vec![vec![f64::NEG_INFINITY; states.len()]; bar_count];
    let mut trace = vec![vec![usize::MAX; states.len()]; bar_count];
    scores[0].clone_from_slice(&emission[0]);
    let max_state_jump = (MAX_TRANSITION_FRAMES / STATE_STEP).ceil() as usize;
    for bar in 1..bar_count {
        for state_index in 0..states.len() {
            let start = state_index.saturating_sub(max_state_jump);
            let end = (state_index + max_state_jump).min(states.len() - 1);
            let mut best = (f64::NEG_INFINITY, usize::MAX);
            for previous in start..=end {
                let delta = states[state_index] - states[previous];
                let score = scores[bar - 1][previous] - TRANSITION_PENALTY * delta * delta;
                if score > best.0 {
                    best = (score, previous);
                }
            }
            scores[bar][state_index] = best.0 + emission[bar][state_index];
            trace[bar][state_index] = best.1;
        }
    }

    let mut state_index = scores[bar_count - 1]
        .iter()
        .enumerate()
        .max_by(|left, right| left.1.total_cmp(right.1))
        .map(|(index, _)| index)
        .unwrap_or_default();
    let mut state_path = vec![0; bar_count];
    for bar in (0..bar_count).rev() {
        state_path[bar] = state_index;
        if bar > 0 {
            state_index = trace[bar][state_index];
        }
    }
    let offsets = state_path
        .iter()
        .map(|index| states[*index])
        .collect::<Vec<_>>();
    let beats = regular_beats
        .iter()
        .enumerate()
        .map(|(index, beat)| {
            let bar = index / BEATS_PER_BAR;
            let fraction = (index % BEATS_PER_BAR) as f64 / BEATS_PER_BAR as f64;
            let left = offsets[bar];
            let right = offsets[(bar + 1).min(offsets.len() - 1)];
            *beat + left * (1.0 - fraction) + right * fraction
        })
        .collect();
    let zero_state = states
        .iter()
        .enumerate()
        .min_by(|left, right| left.1.abs().total_cmp(&right.1.abs()))
        .map(|(index, _)| index)
        .unwrap_or_default();
    let constant_emission = emission
        .iter()
        .map(|values| values[zero_state])
        .sum::<f64>()
        / bar_count as f64;
    let selected_emission = emission
        .iter()
        .zip(&state_path)
        .map(|(values, selected)| values[*selected])
        .sum::<f64>()
        / bar_count as f64;
    let (offset_min, offset_max) = offsets.iter().fold(
        (f64::INFINITY, f64::NEG_INFINITY),
        |(minimum, maximum), offset| (minimum.min(*offset), maximum.max(*offset)),
    );
    let transition_abs_max = offsets
        .windows(2)
        .map(|pair| (pair[1] - pair[0]).abs())
        .fold(0.0, f64::max);
    let (offset_trend_slope_per_bar, offset_trend_correlation) = index_trend(&offsets);
    VariableGridCandidate {
        beats,
        emission_gain: selected_emission - constant_emission,
        offset_min,
        offset_max,
        transition_abs_max,
        offset_trend_slope_per_bar,
        offset_trend_correlation,
    }
}

fn index_trend(values: &[f64]) -> (f64, f64) {
    if values.len() < 2 {
        return (0.0, 0.0);
    }
    let count = values.len() as f64;
    let index_mean = (count - 1.0) * 0.5;
    let value_mean = values.iter().sum::<f64>() / count;
    let (covariance, index_variance, value_variance) =
        values
            .iter()
            .enumerate()
            .fold((0.0, 0.0, 0.0), |accumulator, (index, value)| {
                let centered_index = index as f64 - index_mean;
                let centered_value = *value - value_mean;
                (
                    accumulator.0 + centered_index * centered_value,
                    accumulator.1 + centered_index * centered_index,
                    accumulator.2 + centered_value * centered_value,
                )
            });
    let denominator = (index_variance * value_variance).sqrt();
    if denominator <= f64::EPSILON {
        (0.0, 0.0)
    } else {
        (
            covariance / index_variance.max(f64::EPSILON),
            covariance / denominator,
        )
    }
}

fn preserve_bar_offset(
    initial_bar_offset: usize,
    initial_first_beat: f64,
    refined_first_beat: f64,
    period: f64,
) -> usize {
    let beat_delta = ((refined_first_beat - initial_first_beat) / period).round() as isize;
    (initial_bar_offset as isize + beat_delta).rem_euclid(4) as usize
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
            kick_energy: vec![0.0; PERIOD * BEATS],
            bass_energy: vec![0.0; PERIOD * BEATS],
        }
    }

    fn energy_phase_fixture(
        selected_kick: f32,
        candidate_kick: f32,
        selected_bass: f32,
        candidate_bass: f32,
    ) -> OnsetEnvelopes {
        const PERIOD: usize = 40;
        const BEATS: usize = 200;
        let mut onset = phase_fixture(0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        for beat in 0..BEATS {
            let selected = beat * PERIOD + 10;
            let candidate = beat * PERIOD + 30;
            onset.kick_energy[selected] = selected_kick;
            onset.kick_energy[candidate] = candidate_kick;
            onset.bass_energy[selected] = selected_bass;
            onset.bass_energy[candidate] = candidate_bass;
        }
        onset
    }

    fn time_domain_phase_fixture(
        peak_levels: (f32, f32),
        rms_levels: (f32, f32),
        mid_levels: (f32, f32),
        high_levels: (f32, f32),
    ) -> TimeDomainEnvelopes {
        const PERIOD: usize = 40;
        const BEATS: usize = 200;
        let mut peak = vec![0.0; PERIOD * BEATS];
        let mut rms = peak.clone();
        let mut low_rms_local = peak.clone();
        let mut mid_rms = peak.clone();
        let mut high_rms = peak.clone();
        for beat in 0..BEATS {
            let selected = beat * PERIOD + 10;
            let candidate = beat * PERIOD + 30;
            peak[selected] = peak_levels.0;
            peak[candidate] = peak_levels.1;
            rms[selected] = rms_levels.0;
            rms[candidate] = rms_levels.1;
            low_rms_local[selected] = rms_levels.0;
            low_rms_local[candidate] = rms_levels.1;
            mid_rms[selected] = mid_levels.0;
            mid_rms[candidate] = mid_levels.1;
            high_rms[selected] = high_levels.0;
            high_rms[candidate] = high_levels.1;
        }
        TimeDomainEnvelopes {
            peak,
            rms,
            low_rms_local,
            mid_rms,
            high_rms,
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
    fn refined_grid_preserves_absolute_meter_phase() {
        assert_eq!(preserve_bar_offset(3, 40.0, 40.0, 20.0), 3);
        assert_eq!(preserve_bar_offset(3, 40.0, 60.0, 20.0), 0);
        assert_eq!(preserve_bar_offset(0, 40.0, 20.0, 20.0), 3);
    }

    #[test]
    fn recentered_regular_grid_preserves_anchor_phase() {
        let grid = regular_grid_from_anchor(100.0, 20.0, 45.0);
        assert_eq!(grid, vec![5.0, 25.0, 45.0, 65.0, 85.0]);
    }

    #[test]
    fn variable_grid_gate_requires_smooth_directional_drift() {
        let candidate = |emission_gain,
                         offset_min,
                         offset_max,
                         transition_abs_max,
                         offset_trend_slope_per_bar,
                         offset_trend_correlation| VariableGridCandidate {
            beats: Vec::new(),
            emission_gain,
            offset_min,
            offset_max,
            transition_abs_max,
            offset_trend_slope_per_bar,
            offset_trend_correlation,
        };
        assert!(should_select_variable_grid(&candidate(
            0.37, -1.5, 12.0, 0.75, 0.0, 0.0,
        )));
        assert!(!should_select_variable_grid(&candidate(
            0.35, -1.5, 12.0, 0.75, 0.0, 0.0,
        )));
        assert!(!should_select_variable_grid(&candidate(
            0.37, -2.5, 12.0, 0.75, 0.0, 0.0,
        )));
        assert!(!should_select_variable_grid(&candidate(
            0.37, -1.5, 9.5, 1.0, 0.0, 0.0,
        )));
        let positive_drift = candidate(0.24, -14.0, 7.0, 2.0, 0.1, -0.70);
        assert!(should_select_variable_grid(&positive_drift));
        assert!(should_recenter_coherent_drift(&positive_drift));
        let negative_drift = candidate(0.24, -14.0, 7.0, 2.0, -0.1, -0.70);
        assert!(should_select_variable_grid(&negative_drift));
        assert!(!should_recenter_coherent_drift(&negative_drift));
        assert!(!should_select_variable_grid(&candidate(
            0.24, -14.0, 7.0, 2.0, 0.1, -0.69,
        )));
    }

    #[test]
    fn index_trend_requires_coherent_motion() {
        let (slope, correlation) = index_trend(&[4.0, 2.0, 0.0, -2.0]);
        assert!((slope + 2.0).abs() < 1.0e-12);
        assert!((correlation + 1.0).abs() < 1.0e-12);
        assert_eq!(index_trend(&[3.0, 3.0, 3.0]), (0.0, 0.0));
        assert_eq!(index_trend(&[3.0]), (0.0, 0.0));
    }

    #[test]
    fn straight_onsets_keep_the_regular_grid() {
        let onset = phase_fixture(1.0, 0.0, 1.0, 0.0, 1.0, 0.0);
        let regular = (0..200)
            .map(|index| 12.0 + index as f64 * 40.0)
            .collect::<Vec<_>>();
        let candidate = barwise_tempo_grid(&onset, 40.0, &regular);
        assert_eq!(candidate.beats.len(), regular.len());
        assert!(!should_select_variable_grid(&candidate));
    }

    #[test]
    fn barwise_tracker_accepts_smooth_drift() {
        const PERIOD: f64 = 40.0;
        const BAR_COUNT: usize = 28;
        let regular = (0..BAR_COUNT * 4)
            .map(|index| 42.0 + index as f64 * PERIOD)
            .collect::<Vec<_>>();
        let onset_len = regular.last().copied().unwrap_or_default().ceil() as usize + 64;
        let mut low = vec![0.0; onset_len];
        let mut body = low.clone();
        for (index, beat) in regular.iter().enumerate() {
            let position =
                *beat - f64::from(FFT_CENTER_OFFSET_FRAMES) + index.div_euclid(4) as f64 * 0.5;
            let left = position.floor() as usize;
            for envelope in [&mut low, &mut body] {
                envelope[left] = 1.0;
                envelope[left + 1] = 1.0;
            }
        }
        let onset = OnsetEnvelopes {
            full: body.clone(),
            low,
            body,
            kick: vec![0.0; onset_len],
            bass: vec![0.0; onset_len],
            mid: vec![0.0; onset_len],
            kick_energy: vec![0.0; onset_len],
            bass_energy: vec![0.0; onset_len],
        };

        let candidate = barwise_tempo_grid(&onset, PERIOD as f32, &regular);
        assert!(should_select_variable_grid(&candidate));
        assert!(candidate.beats.last().unwrap() - regular.last().unwrap() >= 10.0);
        assert!(candidate.transition_abs_max <= 0.75);
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
    fn strong_three_over_two_tempo_requires_prior_agreement_and_close_score() {
        let baseline = [(49, 0.666), (65, 0.654), (33, 0.624)];
        let agreeing = [(49, 0.652), (33, 0.576)];
        assert_eq!(
            strong_three_over_two_tempo_candidate(&baseline, &agreeing),
            Some((33, 0.624)),
        );

        let disagreeing = [(33, 0.633), (49, 0.575)];
        assert_eq!(
            strong_three_over_two_tempo_candidate(&baseline, &disagreeing),
            None,
        );

        let weak = [(49, 0.666), (33, 0.60)];
        assert_eq!(
            strong_three_over_two_tempo_candidate(&weak, &agreeing),
            None,
        );
    }

    #[test]
    fn kick_phase_requires_bass_and_segment_consensus() {
        let supported = phase_fixture(0.4, 1.0, 0.4, 1.0, 0.0, 0.0);
        assert!(circular_distance(robust_phase(&supported, 40.0, 10.0), 30.0, 40.0) < 0.1);

        let offbeat_bass = phase_fixture(0.4, 1.0, 1.0, 1.0, 0.0, 0.0);
        assert_eq!(robust_phase(&offbeat_bass, 40.0, 10.0), 10.0);
    }

    #[test]
    fn body_consensus_only_relaxes_near_tied_opposite_phase() {
        assert!(body_consensus_supports_opposite_phase(
            0.05, 0.20, 0.67, 1.96, 0.98, 0.95,
        ));
        assert!(!body_consensus_supports_opposite_phase(
            0.05, 0.20, 0.67, 20.0, 0.98, 0.95,
        ));
        assert!(!body_consensus_supports_opposite_phase(
            0.20, 0.20, 0.67, 1.96, 0.98, 0.95,
        ));
    }

    #[test]
    fn peak_cadence_requires_bounded_gain_and_low_band_support() {
        assert!(peak_cadence_supports_opposite_phase(
            0.61, 0.72, 1.05, 0.96, 0.55,
        ));
        assert!(!peak_cadence_supports_opposite_phase(
            0.59, 0.72, 1.05, 0.96, 0.55,
        ));
        assert!(!peak_cadence_supports_opposite_phase(
            0.61, 0.59, 1.05, 0.96, 0.55,
        ));
        assert!(!peak_cadence_supports_opposite_phase(
            0.61, 0.72, 1.11, 0.96, 0.55,
        ));
        assert!(!peak_cadence_supports_opposite_phase(
            0.61, 0.72, 1.05, 0.99, 0.55,
        ));
        assert!(!peak_cadence_supports_opposite_phase(
            0.61, 0.72, 1.05, 0.96, 0.49,
        ));
    }

    #[test]
    fn cadence_votes_compare_complete_relative_segments() {
        let mut envelope = vec![0.0; 40 * 200];
        for beat in 0..200 {
            envelope[beat * 40 + 10] = 0.5;
            envelope[beat * 40 + 30] = if (beat / 16).is_multiple_of(3) {
                0.4
            } else {
                0.6
            };
        }
        let (selected, candidate, tied) = cadence_phase_votes(&envelope, 40.0, 10.0, 30.0, 16);
        assert!(candidate > selected);
        assert_eq!(tied, 0);
        assert_eq!(selected + candidate, 12);
    }

    #[test]
    fn mid_band_phase_requires_noncontradictory_kick_evidence() {
        let supported = phase_fixture(0.6, 0.55, 1.0, 1.0, 0.4, 0.8);
        assert!(circular_distance(robust_phase(&supported, 40.0, 10.0), 30.0, 40.0) < 0.1);

        let contradicted = phase_fixture(1.0, 0.4, 1.0, 1.0, 0.4, 0.8);
        assert_eq!(robust_phase(&contradicted, 40.0, 10.0), 10.0);
    }

    #[test]
    fn non_flux_energy_phase_requires_concentrated_kick_and_bass_support() {
        let supported = energy_phase_fixture(0.5, 0.75, 0.5, 0.55);
        assert!(circular_distance(robust_energy_phase(&supported, 40.0, 10.0), 30.0, 40.0) < 0.1);

        let bass_contradicted = energy_phase_fixture(0.5, 0.75, 0.5, 0.4);
        assert_eq!(robust_energy_phase(&bass_contradicted, 40.0, 10.0), 10.0);

        let sub_bass_dominated = energy_phase_fixture(0.5, 0.75, 0.5, 1.0);
        assert_eq!(robust_energy_phase(&sub_bass_dominated, 40.0, 10.0), 10.0);
    }

    #[test]
    fn time_domain_phase_accepts_broadband_mid_or_high_frequency_consensus() {
        let broadband = time_domain_phase_fixture((0.5, 0.5), (0.5, 0.7), (0.5, 0.5), (0.5, 0.5));
        assert_eq!(select_time_domain_phase(&broadband, 40.0, 10.0), 30.0);

        let mid = time_domain_phase_fixture((0.5, 0.5), (0.5, 0.5), (0.5, 0.65), (0.5, 0.5));
        assert_eq!(select_time_domain_phase(&mid, 40.0, 10.0), 30.0);

        let high = time_domain_phase_fixture((0.8, 0.88), (0.5, 0.5), (0.5, 0.5), (0.3, 0.6));
        assert_eq!(select_time_domain_phase(&high, 40.0, 10.0), 30.0);

        let peak_contradicted =
            time_domain_phase_fixture((1.0, 0.9), (0.5, 0.5), (0.5, 0.5), (0.3, 0.6));
        assert_eq!(
            select_time_domain_phase(&peak_contradicted, 40.0, 10.0),
            10.0
        );
    }

    #[test]
    fn rejects_silence() {
        let error = analyze_beats(&vec![0.0; 44_100 * 8], 44_100).expect_err("silence");
        assert!(error.to_string().contains("rhythmic onset"));
    }
}
