use anyhow::{Result, bail};
use rustfft::{FftPlanner, num_complex::Complex32};
use serde::{Deserialize, Serialize};

use crate::anlz::BeatGridEntry;

const FFT_SIZE: usize = 2_048;
const HOP_SIZE: usize = 512;
const MIN_BPM: f32 = 70.0;
const MAX_BPM: f32 = 180.0;

/// Clean-room beat-grid estimate derived from decoded mono PCM.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BeatAnalysis {
    pub bpm: f64,
    pub confidence: f32,
    pub beats: Vec<BeatGridEntry>,
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
    if onset.len() < 8 {
        bail!("beat analysis produced too few onset frames");
    }
    let onset_rate = sample_rate as f32 / HOP_SIZE as f32;
    let (period, tempo_score, runner_up_score) = estimate_period(&onset, onset_rate)?;
    let phase = estimate_phase(&onset, period);
    let raw_beats = track_beats(&onset, period, phase);
    if raw_beats.len() < 4 {
        bail!("beat analysis produced too few beats");
    }

    let bar_offset = estimate_bar_offset(&onset, &raw_beats);
    let bpm = 60.0 * onset_rate as f64 / period as f64;
    let bpm_hundredths = (bpm * 100.0).round().clamp(1.0, u16::MAX as f64) as u16;
    let duration_ms = samples.len() as f64 * 1_000.0 / sample_rate as f64;
    let beats = raw_beats
        .iter()
        .enumerate()
        .filter_map(|(index, frame)| {
            let time_ms = *frame as f64 * HOP_SIZE as f64 * 1_000.0 / sample_rate as f64;
            (time_ms <= duration_ms + 1.0).then_some(BeatGridEntry {
                beat: ((index + bar_offset) % 4 + 1) as u16,
                bpm_hundredths,
                time_ms: time_ms.round().clamp(0.0, u32::MAX as f64) as u32,
            })
        })
        .collect::<Vec<_>>();

    let alignment = raw_beats
        .iter()
        .map(|frame| interpolate(&onset, *frame))
        .sum::<f32>()
        / raw_beats.len() as f32;
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
    })
}

fn spectral_flux(samples: &[f32]) -> Vec<f32> {
    let window = (0..FFT_SIZE)
        .map(|index| {
            0.5 - 0.5 * (std::f32::consts::TAU * index as f32 / (FFT_SIZE - 1) as f32).cos()
        })
        .collect::<Vec<_>>();
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let mut spectrum = vec![Complex32::default(); FFT_SIZE];
    let mut previous = vec![0.0f32; FFT_SIZE / 2 + 1];
    let mut flux = Vec::with_capacity(samples.len().saturating_sub(FFT_SIZE) / HOP_SIZE + 1);

    for frame in samples.windows(FFT_SIZE).step_by(HOP_SIZE) {
        for (index, value) in frame.iter().enumerate() {
            spectrum[index] = Complex32::new(*value * window[index], 0.0);
        }
        fft.process(&mut spectrum);

        let mut value = 0.0;
        for (index, bin) in spectrum[..=FFT_SIZE / 2].iter().enumerate().skip(1) {
            let magnitude = (1.0 + 10.0 * bin.norm()).ln();
            value += (magnitude - previous[index]).max(0.0);
            previous[index] = magnitude;
        }
        flux.push(value);
    }

    adaptive_normalize(&flux, 8)
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
            let harmonic = correlations.get(lag * 2).copied().unwrap_or_default() * 0.35
                + correlations.get(lag / 2).copied().unwrap_or_default() * 0.15;
            (
                lag,
                (correlations[lag] + harmonic) * (0.85 + 0.15 * center_prior),
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

fn estimate_phase(onset: &[f32], period: f32) -> f32 {
    let steps = (period * 4.0).ceil().max(1.0) as usize;
    (0..steps)
        .map(|step| step as f32 / 4.0)
        .map(|phase| {
            let mut score = 0.0;
            let mut count = 0usize;
            let mut frame = phase;
            while frame < onset.len() as f32 {
                score += interpolate(onset, frame);
                count += 1;
                frame += period;
            }
            (phase, score / count.max(1) as f32)
        })
        .max_by(|left, right| left.1.total_cmp(&right.1))
        .map(|(phase, _)| phase)
        .unwrap_or_default()
}

fn track_beats(onset: &[f32], period: f32, phase: f32) -> Vec<f32> {
    let mut phase = phase;
    while phase - period >= 0.0 {
        phase -= period;
    }
    while phase < 0.0 {
        phase += period;
    }

    let radius = (period * 0.12).round().max(1.0) as isize;
    let mut beats = Vec::new();
    let mut predicted = phase;
    while predicted < onset.len() as f32 {
        let center = predicted.round() as isize;
        let mut best = predicted;
        let mut best_score = interpolate(onset, predicted) + 0.05;
        for candidate in center - radius..=center + radius {
            if candidate < 0 || candidate as usize >= onset.len() {
                continue;
            }
            let distance = (candidate as f32 - predicted).abs() / radius as f32;
            let score = onset[candidate as usize] - 0.15 * distance;
            if score > best_score {
                best = candidate as f32;
                best_score = score;
            }
        }
        if beats
            .last()
            .is_none_or(|previous| best - previous > period * 0.55)
        {
            beats.push(best);
        }
        predicted += period;
    }
    beats
}

fn estimate_bar_offset(onset: &[f32], beats: &[f32]) -> usize {
    let strongest = (0..4)
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
        .max_by(|left, right| left.1.total_cmp(&right.1))
        .map(|(offset, _)| offset)
        .unwrap_or_default();
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
        }
    }

    #[test]
    fn rejects_silence() {
        let error = analyze_beats(&vec![0.0; 44_100 * 8], 44_100).expect_err("silence");
        assert!(error.to_string().contains("rhythmic onset"));
    }
}
