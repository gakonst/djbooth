use anyhow::{Result, bail};
use rayon::prelude::*;
use rustfft::{FftPlanner, num_complex::Complex32};
use serde::{Deserialize, Serialize};

use crate::anlz::BeatGridEntry;

const FFT_SIZE: usize = 2_048;
const HOP_SIZE: usize = 512;
const LOW_ONSET_MAX_BIN: usize = 7;
const BODY_ONSET_MAX_BIN: usize = 93;
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
    let (period, phase, alignment) = refine_period_and_phase(&onset, initial_period);
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
    for (full_chunk, low_chunk, body_chunk) in chunks {
        full.extend(full_chunk);
        low.extend(low_chunk);
        body.extend(body_chunk);
    }

    OnsetEnvelopes {
        full: adaptive_normalize(&full, 8),
        low: adaptive_normalize(&low, 8),
        body: adaptive_normalize(&body, 8),
    }
}

fn spectral_flux_range(
    samples: &[f32],
    window: &[f32],
    range: std::ops::Range<usize>,
) -> (Vec<f32>, Vec<f32>, Vec<f32>) {
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let mut spectrum = vec![Complex32::default(); FFT_SIZE];
    let mut previous = vec![0.0f32; FFT_SIZE / 2 + 1];
    let mut full_flux = Vec::with_capacity(range.len());
    let mut low_flux = Vec::with_capacity(range.len());
    let mut body_flux = Vec::with_capacity(range.len());

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
            previous[index] = magnitude;
        }
        full_flux.push(full_value);
        low_flux.push(low_value);
        body_flux.push(body_value);
    }
    (full_flux, low_flux, body_flux)
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

    let mut candidates = (min_lag..=max_lag)
        .map(|lag| {
            let bpm = 60.0 * onset_rate / lag as f32;
            let center_prior = (-0.5 * (bpm / 120.0).log2().powi(2) / 0.55f32.powi(2)).exp();
            let harmonic = correlations.get(lag * 2).copied().unwrap_or_default() * 0.10
                + correlations.get(lag / 2).copied().unwrap_or_default() * 0.15;
            (
                lag,
                (correlations[lag] + harmonic) * (0.55 + 0.45 * center_prior),
            )
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| right.1.total_cmp(&left.1));
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
    fn rejects_silence() {
        let error = analyze_beats(&vec![0.0; 44_100 * 8], 44_100).expect_err("silence");
        assert!(error.to_string().contains("rhythmic onset"));
    }
}
