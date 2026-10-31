use anyhow::{Result, bail};
use rayon::prelude::*;
use rustfft::{Fft, FftPlanner, num_complex::Complex32};
use serde::{Deserialize, Serialize};

pub(crate) const FFT_SIZE: usize = 8_192;
pub(crate) const HOP_SIZE: usize = 4_096;
const MIN_FREQUENCY: f32 = 55.0;
const MAX_FREQUENCY: f32 = 5_000.0;
const HIGH_RES_BINS: usize = 36;
const BINS_PER_PITCH_CLASS: usize = HIGH_RES_BINS / 12;
const SPECTRAL_BANDS: usize = 7;
const MAX_PEAKS_PER_FRAME: usize = 60;
const BOUNDARY_SECONDS: usize = 20;
const MIN_OUTRO_SECONDS: usize = 1;
const TONIC_RECURRENCE_BONUS: f32 = 0.18;
const MODE_RECURRENCE_BONUS: f32 = 0.16;

// Krumhansl-Schmuckler profiles.
const MAJOR_PROFILE: [f32; 12] = [
    6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR_PROFILE: [f32; 12] = [
    6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

// BGate profiles published for electronic dance music by Faraldo et al.
const EDM_MAJOR_PROFILE: [f32; 12] = [
    1.00, 0.00, 0.42, 0.00, 0.53, 0.37, 0.00, 0.77, 0.00, 0.38, 0.21, 0.30,
];
const EDM_MINOR_PROFILE: [f32; 12] = [
    1.00, 0.00, 0.36, 0.39, 0.00, 0.38, 0.00, 0.74, 0.27, 0.00, 0.42, 0.23,
];
const KEY_NAMES: [&str; 12] = [
    "C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B",
];

#[derive(Debug, Clone, Copy)]
struct FrequencyBin {
    index: usize,
    spectral_band: usize,
    pitch_lower: usize,
    pitch_fraction: f32,
    frequency_sqrt: f32,
}

#[derive(Debug)]
struct ChromaFeatures {
    energy_weighted: Vec<[f32; 12]>,
    robust: Vec<[f32; 12]>,
}

#[derive(Debug, Default)]
pub(crate) struct RawChromaFeatures {
    energy_weighted: Vec<[f32; 12]>,
    high_resolution: Vec<[f32; HIGH_RES_BINS]>,
}

impl RawChromaFeatures {
    pub(crate) fn append(&mut self, mut other: Self) {
        self.energy_weighted.append(&mut other.energy_weighted);
        self.high_resolution.append(&mut other.high_resolution);
    }
}

pub(crate) struct KeyFeaturePlan {
    sample_rate: u32,
    window: Vec<f32>,
    first_bin: usize,
    last_bin: usize,
    frequency_bins: Vec<FrequencyBin>,
    band_counts: [usize; SPECTRAL_BANDS],
    fft: std::sync::Arc<dyn Fft<f32>>,
}

impl KeyFeaturePlan {
    pub(crate) fn new(sample_rate: u32) -> Self {
        let window = (0..FFT_SIZE)
            .map(|index| {
                0.5 - 0.5 * (std::f32::consts::TAU * index as f32 / (FFT_SIZE - 1) as f32).cos()
            })
            .collect::<Vec<_>>();
        let first_bin = (MIN_FREQUENCY * FFT_SIZE as f32 / sample_rate as f32)
            .floor()
            .max(1.0) as usize;
        let last_bin = (MAX_FREQUENCY * FFT_SIZE as f32 / sample_rate as f32)
            .ceil()
            .min((FFT_SIZE / 2 - 1) as f32) as usize;
        let frequency_bins = (first_bin..=last_bin)
            .map(|index| {
                let frequency = index as f32 * sample_rate as f32 / FFT_SIZE as f32;
                let spectral_band = (frequency / MIN_FREQUENCY).log2().floor().max(0.0) as usize;
                let midi = 69.0 + 12.0 * (frequency / 440.0).log2();
                let pitch = midi.rem_euclid(12.0);
                let pitch_floor = pitch.floor();
                FrequencyBin {
                    index,
                    spectral_band: spectral_band.min(SPECTRAL_BANDS - 1),
                    pitch_lower: pitch_floor as usize % 12,
                    pitch_fraction: pitch - pitch_floor,
                    frequency_sqrt: frequency.sqrt(),
                }
            })
            .collect::<Vec<_>>();
        let mut band_counts = [0usize; SPECTRAL_BANDS];
        for bin in &frequency_bins {
            band_counts[bin.spectral_band] += 1;
        }
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(FFT_SIZE);
        Self {
            sample_rate,
            window,
            first_bin,
            last_bin,
            frequency_bins,
            band_counts,
            fft,
        }
    }

    pub(crate) fn extract(
        &self,
        samples: &[f32],
        range: std::ops::Range<usize>,
    ) -> RawChromaFeatures {
        raw_chroma_features(samples, self, range)
    }
}

#[derive(Debug, Clone, Copy)]
struct BoundaryRecurrence {
    tonic: usize,
    minor: Option<bool>,
}

#[derive(Debug, Clone, Copy)]
struct KeyCandidate {
    tonic: usize,
    minor: bool,
    score: f32,
}

/// Clean-room global musical-key estimate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KeyAnalysis {
    pub key: String,
    pub confidence: f32,
    pub chroma: [f32; 12],
}

/// Estimate the global major or minor key from decoded mono PCM.
///
/// Spectral peaks are whitened, folded into a tuning-aware 36-bin HPCP, and
/// reduced with CENS-style frame normalization. Key ranking blends established
/// Krumhansl-Schmuckler and electronic-music profiles. Matching intro/outro
/// tonics provide a bounded recurrence prior for relative-key ambiguity.
pub fn analyze_key(samples: &[f32], sample_rate: u32) -> Result<KeyAnalysis> {
    if sample_rate == 0 {
        bail!("key analysis requires a non-zero sample rate");
    }
    if samples.len() < FFT_SIZE {
        bail!("key analysis requires at least one FFT frame");
    }
    if samples.iter().any(|sample| !sample.is_finite()) {
        bail!("key analysis received non-finite PCM");
    }

    analyze_key_features(chroma_features(samples, sample_rate), sample_rate)
}

pub(crate) fn analyze_key_from_raw(
    raw: RawChromaFeatures,
    sample_rate: u32,
) -> Result<KeyAnalysis> {
    analyze_key_features(chroma_features_from_raw(raw), sample_rate)
}

fn analyze_key_features(features: ChromaFeatures, sample_rate: u32) -> Result<KeyAnalysis> {
    let Some(energy_weighted) = aggregate_chroma(&features.energy_weighted) else {
        bail!("audio has no measurable harmonic energy");
    };
    let robust = aggregate_chroma(&features.robust).unwrap_or(energy_weighted);
    let mut chroma = [0.0f32; 12];
    for ((value, energy_weighted), robust) in chroma.iter_mut().zip(energy_weighted).zip(robust) {
        *value = 0.95 * energy_weighted + 0.05 * robust;
    }
    normalize_l1(&mut chroma);
    let recurrence = boundary_recurrence(&features.energy_weighted, sample_rate);
    let candidates = rank_candidates(&chroma, recurrence);
    let winner = candidates.first().expect("24 key candidates");
    let runner_up = candidates
        .get(1)
        .map(|candidate| candidate.score)
        .unwrap_or(-1.0);
    let confidence = ((winner.score - runner_up) / 2.0).clamp(0.0, 1.0);
    let key = format_key(winner.tonic, winner.minor);

    Ok(KeyAnalysis {
        key,
        confidence,
        chroma,
    })
}

fn chroma_features(samples: &[f32], sample_rate: u32) -> ChromaFeatures {
    let plan = KeyFeaturePlan::new(sample_rate);
    let frame_count = 1 + samples.len().saturating_sub(FFT_SIZE) / HOP_SIZE;
    let worker_count = rayon::current_thread_index()
        .map(|_| rayon::current_num_threads())
        .unwrap_or(1)
        .min(frame_count);
    let chunk_len = frame_count.div_ceil(worker_count);
    let chunks = (0..frame_count)
        .step_by(chunk_len)
        .map(|start| start..(start + chunk_len).min(frame_count))
        .collect::<Vec<_>>()
        .into_par_iter()
        .map(|range| plan.extract(samples, range))
        .collect::<Vec<_>>();
    let mut raw = RawChromaFeatures::default();
    for chunk in chunks {
        raw.append(chunk);
    }
    chroma_features_from_raw(raw)
}

fn chroma_features_from_raw(raw: RawChromaFeatures) -> ChromaFeatures {
    let tuning_offset = tuning_offset(&raw.high_resolution);
    let robust = raw
        .high_resolution
        .into_iter()
        .map(|high_resolution| {
            let mut continuous = [0.0f32; 12];
            for (pitch_class, value) in continuous.iter_mut().enumerate() {
                let center = (pitch_class as i32 * BINS_PER_PITCH_CLASS as i32 + tuning_offset)
                    .rem_euclid(HIGH_RES_BINS as i32) as usize;
                *value = high_resolution[center];
            }
            normalize_l1(&mut continuous);
            let mut cens = continuous.map(|value| {
                if value < 0.05 {
                    0.0
                } else if value < 0.10 {
                    1.0
                } else if value < 0.20 {
                    2.0
                } else if value < 0.40 {
                    3.0
                } else {
                    4.0
                }
            });
            normalize_l1(&mut cens);
            let mut combined = [0.0f32; 12];
            for ((value, continuous), cens) in combined.iter_mut().zip(continuous).zip(cens) {
                *value = 0.65 * continuous + 0.35 * cens;
            }
            normalize_l1(&mut combined);
            combined
        })
        .collect();
    ChromaFeatures {
        energy_weighted: raw.energy_weighted,
        robust,
    }
}

fn raw_chroma_features(
    samples: &[f32],
    plan: &KeyFeaturePlan,
    range: std::ops::Range<usize>,
) -> RawChromaFeatures {
    let mut spectrum = vec![Complex32::default(); FFT_SIZE];
    let mut fft_scratch = vec![Complex32::default(); plan.fft.get_inplace_scratch_len()];
    let mut magnitudes = vec![0.0f32; plan.last_bin + 2];
    let mut energy_weighted_frames = Vec::with_capacity(range.len());
    let mut high_resolution_frames = Vec::with_capacity(range.len());
    let mut peaks = Vec::with_capacity(MAX_PEAKS_PER_FRAME);

    for frame_index in range {
        let frame_start = frame_index * HOP_SIZE;
        let frame = &samples[frame_start..frame_start + FFT_SIZE];
        let rms = (frame.iter().map(|value| value * value).sum::<f32>() / FFT_SIZE as f32).sqrt();
        if rms < 1.0e-5 {
            continue;
        }
        for (index, value) in frame.iter().enumerate() {
            spectrum[index] = Complex32::new(*value * plan.window[index], 0.0);
        }
        plan.fft
            .process_with_scratch(&mut spectrum, &mut fft_scratch);

        for (magnitude, bin) in magnitudes
            .iter_mut()
            .zip(&spectrum)
            .take(plan.last_bin + 2)
            .skip(plan.first_bin.saturating_sub(1))
        {
            *magnitude = bin.norm();
        }

        let mut energy_weighted = [0.0f32; 12];
        let mut band_sums = [0.0f32; SPECTRAL_BANDS];
        let mut band_maxima = [0.0f32; SPECTRAL_BANDS];
        for bin in &plan.frequency_bins {
            let magnitude = magnitudes[bin.index];
            band_sums[bin.spectral_band] += magnitude;
            band_maxima[bin.spectral_band] = band_maxima[bin.spectral_band].max(magnitude);
            if magnitude <= magnitudes[bin.index - 1] || magnitude < magnitudes[bin.index + 1] {
                continue;
            }
            let weight = magnitude.sqrt() / bin.frequency_sqrt;
            energy_weighted[bin.pitch_lower] += weight * (1.0 - bin.pitch_fraction);
            energy_weighted[(bin.pitch_lower + 1) % 12] += weight * bin.pitch_fraction;
        }
        let source = energy_weighted;
        for (index, value) in energy_weighted.iter_mut().enumerate() {
            *value =
                source[index] + 0.08 * source[(index + 5) % 12] + 0.05 * source[(index + 7) % 12];
        }
        if energy_weighted.iter().sum::<f32>() > f32::EPSILON {
            energy_weighted_frames.push(energy_weighted);
        }

        let global_maximum = band_maxima.iter().copied().fold(0.0f32, f32::max);
        peaks.clear();
        for bin in &plan.frequency_bins {
            let magnitude = magnitudes[bin.index];
            if magnitude <= magnitudes[bin.index - 1]
                || magnitude < magnitudes[bin.index + 1]
                || magnitude < 0.05 * band_maxima[bin.spectral_band]
                || magnitude < 0.001 * global_maximum
            {
                continue;
            }
            let left = magnitudes[bin.index - 1].max(f32::MIN_POSITIVE).ln();
            let center = magnitude.max(f32::MIN_POSITIVE).ln();
            let right = magnitudes[bin.index + 1].max(f32::MIN_POSITIVE).ln();
            let curvature = left - 2.0 * center + right;
            let offset = if curvature.abs() > f32::EPSILON {
                (0.5 * (left - right) / curvature).clamp(-0.5, 0.5)
            } else {
                0.0
            };
            let frequency = (bin.index as f32 + offset) * plan.sample_rate as f32 / FFT_SIZE as f32;
            let midi = 69.0 + 12.0 * (frequency / 440.0).log2();
            let pitch = midi.rem_euclid(12.0);
            let band_mean =
                band_sums[bin.spectral_band] / plan.band_counts[bin.spectral_band].max(1) as f32;
            let whitened = magnitude / band_mean.max(f32::MIN_POSITIVE);
            peaks.push((whitened.sqrt(), pitch));
        }
        peaks.sort_by(|left, right| right.0.total_cmp(&left.0));
        peaks.truncate(MAX_PEAKS_PER_FRAME);

        let mut high_resolution = [0.0f32; HIGH_RES_BINS];
        for &(weight, pitch) in &peaks {
            let position = pitch * BINS_PER_PITCH_CLASS as f32;
            let nearest = position.round() as i32;
            for offset in -(BINS_PER_PITCH_CLASS as i32)..=BINS_PER_PITCH_CLASS as i32 {
                let candidate = nearest + offset;
                let distance = (position - candidate as f32).abs();
                if distance > BINS_PER_PITCH_CLASS as f32 {
                    continue;
                }
                let kernel = (std::f32::consts::FRAC_PI_2 * distance / BINS_PER_PITCH_CLASS as f32)
                    .cos()
                    .powi(2);
                let index = candidate.rem_euclid(HIGH_RES_BINS as i32) as usize;
                high_resolution[index] += weight * kernel;
            }
        }
        if normalize_l1(&mut high_resolution) {
            high_resolution_frames.push(high_resolution);
        }
    }
    RawChromaFeatures {
        energy_weighted: energy_weighted_frames,
        high_resolution: high_resolution_frames,
    }
}

fn tuning_offset(frames: &[[f32; HIGH_RES_BINS]]) -> i32 {
    let mut phase_energy = [0.0f32; BINS_PER_PITCH_CLASS];
    for frame in frames {
        for (index, value) in frame.iter().enumerate() {
            phase_energy[index % BINS_PER_PITCH_CLASS] += value;
        }
    }
    phase_energy
        .iter()
        .enumerate()
        .max_by(|left, right| left.1.total_cmp(right.1))
        .map(|(phase, _)| {
            if phase > BINS_PER_PITCH_CLASS / 2 {
                phase as i32 - BINS_PER_PITCH_CLASS as i32
            } else {
                phase as i32
            }
        })
        .unwrap_or_default()
}

fn aggregate_chroma(frames: &[[f32; 12]]) -> Option<[f32; 12]> {
    let mut chroma = [0.0f32; 12];
    for frame in frames {
        for (total, value) in chroma.iter_mut().zip(frame) {
            *total += *value;
        }
    }
    normalize_l1(&mut chroma).then_some(chroma)
}

fn normalize_l1<const N: usize>(values: &mut [f32; N]) -> bool {
    let total = values.iter().sum::<f32>();
    if total <= f32::EPSILON {
        return false;
    }
    for value in values {
        *value /= total;
    }
    true
}

fn boundary_recurrence(frames: &[[f32; 12]], sample_rate: u32) -> Option<BoundaryRecurrence> {
    let (first_candidate, last_candidate, _) = boundary_candidates(frames, sample_rate)?;
    (first_candidate.tonic == last_candidate.tonic).then_some(BoundaryRecurrence {
        tonic: first_candidate.tonic,
        minor: (first_candidate.minor == last_candidate.minor).then_some(first_candidate.minor),
    })
}

fn boundary_candidates(
    frames: &[[f32; 12]],
    sample_rate: u32,
) -> Option<(KeyCandidate, KeyCandidate, usize)> {
    let boundary_frames = (sample_rate as usize * BOUNDARY_SECONDS / HOP_SIZE).max(1);
    if frames.len() < boundary_frames * 2 {
        return None;
    }
    let first = aggregate_chroma(&frames[..boundary_frames])?;
    let trailing_frames = frames.len() % boundary_frames;
    let minimum_outro_frames = (sample_rate as usize * MIN_OUTRO_SECONDS / HOP_SIZE).max(1);
    let outro_frames = if trailing_frames >= minimum_outro_frames {
        trailing_frames
    } else {
        boundary_frames
    };
    let last = aggregate_chroma(&frames[frames.len() - outro_frames..])?;
    let first_candidate = rank_candidates(&first, None).into_iter().next()?;
    let last_candidate = rank_candidates(&last, None).into_iter().next()?;
    Some((first_candidate, last_candidate, outro_frames))
}

fn rank_candidates(
    chroma: &[f32; 12],
    recurrence: Option<BoundaryRecurrence>,
) -> Vec<KeyCandidate> {
    let mut candidates = Vec::with_capacity(24);
    for (tonic, _) in KEY_NAMES.iter().enumerate() {
        for minor in [false, true] {
            let base_score = candidate_base_score(chroma, tonic, minor);
            let recurrence_bonus = recurrence
                .filter(|boundary| boundary.tonic == tonic)
                .map(|boundary| {
                    TONIC_RECURRENCE_BONUS
                        + boundary
                            .minor
                            .filter(|boundary_minor| {
                                *boundary_minor == minor
                                    && base_score >= candidate_base_score(chroma, tonic, !minor)
                            })
                            .map_or(0.0, |_| MODE_RECURRENCE_BONUS)
                })
                .unwrap_or_default();
            candidates.push(KeyCandidate {
                tonic,
                minor,
                score: base_score + recurrence_bonus,
            });
        }
    }
    candidates.sort_by(|left, right| right.score.total_cmp(&left.score));
    candidates
}

fn candidate_base_score(chroma: &[f32; 12], tonic: usize, minor: bool) -> f32 {
    let (general_profile, edm_profile) = if minor {
        (&MINOR_PROFILE, &EDM_MINOR_PROFILE)
    } else {
        (&MAJOR_PROFILE, &EDM_MAJOR_PROFILE)
    };
    0.72 * profile_correlation(chroma, general_profile, tonic)
        + 0.28 * profile_correlation(chroma, edm_profile, tonic)
}

fn format_key(tonic: usize, minor: bool) -> String {
    format!("{}{}", KEY_NAMES[tonic], if minor { "m" } else { "" })
}

fn profile_correlation(chroma: &[f32; 12], profile: &[f32; 12], tonic: usize) -> f32 {
    let chroma_mean = chroma.iter().sum::<f32>() / 12.0;
    let profile_mean = profile.iter().sum::<f32>() / 12.0;
    let mut numerator = 0.0;
    let mut chroma_energy = 0.0;
    let mut profile_energy = 0.0;
    for (index, value) in chroma.iter().enumerate() {
        let observed = *value - chroma_mean;
        let expected = profile[(index + 12 - tonic) % 12] - profile_mean;
        numerator += observed * expected;
        chroma_energy += observed * observed;
        profile_energy += expected * expected;
    }
    let denominator = (chroma_energy * profile_energy).sqrt();
    if denominator > f32::EPSILON {
        numerator / denominator
    } else {
        -1.0
    }
}
