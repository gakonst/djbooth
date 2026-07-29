//! Clean-room beat-synchronous song-structure analysis.
//!
//! Rekordbox stores phrase starts as one-based beat-grid indices. The linked
//! analyzer derives them from several energy, rhythm, and spectral bands. This
//! implementation keeps that observable contract while using an independent,
//! deterministic novelty detector over beat-aligned sub-band features.

use std::f64::consts::PI;

use anyhow::{Result, bail};
use serde::Serialize;

use crate::anlz::AnlzTag;
use crate::phrase_frontend::{
    NativePhraseLowLevelEnvelope, extract_native_phrase_low_level_envelope,
    reduce_native_phrase_low_levels,
};
use crate::rhythm::BeatAnalysis;

const ENTRY_BYTES: usize = 24;
const HEADER_BYTES: usize = 32;
const BEATS_PER_BAR: usize = 4;
const FEATURE_COUNT: usize = 6;
const ANALYSIS_STRIDE: usize = 4;
const BOUNDARY_NOVELTY_WEIGHT: f64 = 0.75;
const NATIVE_BOUNDARY_NOVELTY_WEIGHT: f64 = 1.5;

/// One phrase start in a Rekordbox `PSSI` song-structure tag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PhraseEntry {
    /// One-based phrase index.
    pub index: u16,
    /// One-based index into the beat grid.
    pub beat: u16,
    /// Mood-specific phrase identifier.
    pub kind: u16,
    /// Native phrase-variant flag at record byte seven.
    pub k1: bool,
    /// Native Up-phrase variant flag at record byte nine.
    pub k2: bool,
    /// Native Up-phrase variant flag at record byte nineteen.
    pub k3: bool,
    /// Optional Up3 internal starts. Native records contain either zero, one,
    /// or all three values; three values set the record's `b` discriminator.
    pub transition_beats: [Option<u16>; 3],
    /// Optional first beat of an end-of-phrase fill.
    pub fill_beat: Option<u16>,
}

/// Beat-synchronous phrase map serialized as `PSSI`.
#[derive(Debug, Clone, PartialEq)]
pub struct SongStructure {
    /// Native reader rate used by the phrase frontend.
    pub sample_rate: u32,
    /// Native mood family: 1 high, 2 mid, 3 low.
    pub mood: u16,
    /// One-based final beat covered by the structure map.
    pub end_beat: u16,
    /// Ordered phrase starts.
    pub entries: Vec<PhraseEntry>,
    /// Bounded feature summary used to audit mood and segmentation behavior.
    pub diagnostics: SongStructureDiagnostics,
}

/// Aggregate audio evidence behind one song-structure result.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SongStructureDiagnostics {
    pub low_band_ratio: f64,
    pub high_band_ratio: f64,
    pub rhythmic_density: f64,
    pub energy_deviation: f64,
    pub adjacent_change_mean: f64,
    pub adjacent_change_p90: f64,
    pub long_change_mean: f64,
    pub zero_crossing_rate: f64,
    /// At most 38 phrase-level feature records from the bounded decoder.
    pub phrase_features: Vec<PhraseFeatureDiagnostics>,
}

/// Standardized feature evidence for one generated phrase.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
pub struct PhraseFeatureDiagnostics {
    pub index: u16,
    pub beat: u16,
    pub duration_bars: usize,
    pub energy_z: f64,
    pub low_band_z: f64,
    pub mid_band_z: f64,
    pub high_band_z: f64,
    pub onset_z: f64,
    pub zero_crossing_z: f64,
    pub energy_delta_z: f64,
    pub distance_from_previous: f64,
}

impl SongStructure {
    /// Pack the structure into the native 32-byte header and 24-byte records.
    pub fn to_tag(&self) -> Result<AnlzTag> {
        if !(1..=3).contains(&self.mood) {
            bail!("song-structure mood must be between 1 and 3");
        }
        let count = u16::try_from(self.entries.len())
            .map_err(|_| anyhow::anyhow!("song structure has too many phrase entries"))?;
        let total_len = HEADER_BYTES
            .checked_add(
                self.entries
                    .len()
                    .checked_mul(ENTRY_BYTES)
                    .ok_or_else(|| anyhow::anyhow!("song-structure length overflow"))?,
            )
            .ok_or_else(|| anyhow::anyhow!("song-structure length overflow"))?;
        let total_len_u32 = u32::try_from(total_len)
            .map_err(|_| anyhow::anyhow!("song-structure tag exceeds u32 length"))?;

        let mut raw = vec![0_u8; total_len];
        raw[..4].copy_from_slice(b"PSSI");
        raw[4..8].copy_from_slice(&(HEADER_BYTES as u32).to_be_bytes());
        raw[8..12].copy_from_slice(&total_len_u32.to_be_bytes());
        raw[12..16].copy_from_slice(&(ENTRY_BYTES as u32).to_be_bytes());
        raw[16..18].copy_from_slice(&count.to_be_bytes());
        raw[18..20].copy_from_slice(&self.mood.to_be_bytes());
        raw[26..28].copy_from_slice(&self.end_beat.to_be_bytes());

        for (entry_index, entry) in self.entries.iter().enumerate() {
            if entry.index != u16::try_from(entry_index + 1).unwrap_or(u16::MAX) {
                bail!("song-structure phrase indices must be contiguous and one-based");
            }
            let has_transition = entry.transition_beats.iter().any(Option::is_some);
            let has_auxiliary =
                entry.k1 || entry.k2 || entry.k3 || has_transition || entry.fill_beat.is_some();
            if self.mood != 1 && has_auxiliary {
                bail!("only high-mood song structures may contain auxiliary phrase fields");
            }
            if entry.k1 && !matches!(entry.kind, 1 | 5 | 6) {
                bail!("song-structure k1 is only valid on high-mood kinds 1, 5, and 6");
            }
            if (entry.k2 || entry.k3 || has_transition) && entry.kind != 2 {
                bail!("song-structure Up variants are only valid on high-mood kind 2");
            }
            if entry.k2 && entry.k3 {
                bail!("song-structure k2 and k3 variants are mutually exclusive");
            }
            if has_transition && !entry.k2 {
                bail!("song-structure transition beats require the k2 variant");
            }
            let offset = HEADER_BYTES + entry_index * ENTRY_BYTES;
            raw[offset..offset + 2].copy_from_slice(&entry.index.to_be_bytes());
            raw[offset + 2..offset + 4].copy_from_slice(&entry.beat.to_be_bytes());
            raw[offset + 4..offset + 6].copy_from_slice(&entry.kind.to_be_bytes());
            raw[offset + 7] = u8::from(entry.k1);
            raw[offset + 9] = u8::from(entry.k2);
            raw[offset + 19] = u8::from(entry.k3);
            match entry.transition_beats {
                [None, None, None] => {}
                [Some(beat_2), None, None] => {
                    if !(entry.beat..=self.end_beat).contains(&beat_2) {
                        bail!("song-structure transition beat is outside the covered beat range");
                    }
                    raw[offset + 12..offset + 14].copy_from_slice(&beat_2.to_be_bytes());
                }
                [Some(beat_2), Some(beat_3), Some(beat_4)] => {
                    if entry.beat > beat_2
                        || beat_2 > beat_3
                        || beat_3 > beat_4
                        || beat_4 > self.end_beat
                    {
                        bail!("song-structure transition beats must be ordered within the phrase");
                    }
                    raw[offset + 11] = 1;
                    raw[offset + 12..offset + 14].copy_from_slice(&beat_2.to_be_bytes());
                    raw[offset + 14..offset + 16].copy_from_slice(&beat_3.to_be_bytes());
                    raw[offset + 16..offset + 18].copy_from_slice(&beat_4.to_be_bytes());
                }
                _ => {
                    bail!("song-structure transition beats must contain zero, one, or three values")
                }
            }
            if let Some(fill_beat) = entry.fill_beat {
                if !matches!(entry.kind, 1 | 2 | 4 | 5) {
                    bail!("song-structure fills are invalid for this high-mood phrase kind");
                }
                let next_beat = self
                    .entries
                    .get(entry_index + 1)
                    .map(|next| next.beat)
                    .unwrap_or(self.end_beat);
                if fill_beat < entry.beat
                    || fill_beat >= next_beat
                    || !(1..=4).contains(&next_beat.saturating_sub(fill_beat))
                {
                    bail!("song-structure fill must begin one to four beats before the phrase end");
                }
                raw[offset + 21] = 1;
                raw[offset + 22..offset + 24].copy_from_slice(&fill_beat.to_be_bytes());
            }
        }
        AnlzTag::parse(&raw)
    }
}

#[derive(Debug, Clone, Copy)]
struct BarFeature {
    standardized: [f64; FEATURE_COUNT],
    raw: [f64; FEATURE_COUNT],
    energy: f64,
    onset: f64,
}

/// Analyze a complete mono recording against its final beat grid.
pub fn analyze_song_structure(
    samples: &[f32],
    sample_rate: u32,
    beat: &BeatAnalysis,
) -> Result<SongStructure> {
    let native_low_levels = extract_native_phrase_low_level_envelope(samples, sample_rate)?;
    analyze_song_structure_with_native_low_levels(samples, sample_rate, beat, &native_low_levels)
}

pub(crate) fn analyze_song_structure_with_native_low_levels(
    samples: &[f32],
    sample_rate: u32,
    beat: &BeatAnalysis,
    native_low_levels: &NativePhraseLowLevelEnvelope,
) -> Result<SongStructure> {
    if sample_rate == 0 {
        bail!("song-structure analysis requires a non-zero sample rate");
    }
    if samples.is_empty() {
        bail!("song-structure analysis requires non-empty PCM");
    }
    if beat.beats.len() < BEATS_PER_BAR * 2 {
        bail!("song-structure analysis requires at least eight beats");
    }

    let first_downbeat = beat
        .beats
        .iter()
        .take(BEATS_PER_BAR)
        .position(|entry| entry.beat == 1)
        .unwrap_or_default();
    let mut bar_starts = vec![0_usize];
    for start in (first_downbeat..beat.beats.len()).step_by(BEATS_PER_BAR) {
        if start != 0 {
            bar_starts.push(start);
        }
    }
    let filter_coefficients = bar_filter_coefficients(sample_rate);
    let mut raw_features = Vec::with_capacity(bar_starts.len());
    for (bar, start_beat) in bar_starts.iter().copied().enumerate() {
        let end_beat = bar_starts
            .get(bar + 1)
            .copied()
            .unwrap_or_else(|| (start_beat + BEATS_PER_BAR).min(beat.beats.len() - 1));
        let start = beat_sample(beat, start_beat, sample_rate).min(samples.len());
        let end = if end_beat > start_beat {
            beat_sample(beat, end_beat, sample_rate).min(samples.len())
        } else {
            samples.len()
        };
        raw_features.push(extract_bar_features(
            samples.get(start..end).unwrap_or_default(),
            filter_coefficients,
        ));
    }
    let features = standardize_features(&raw_features);
    let structured_bars = audible_bar_count(&features);
    let features = &features[..structured_bars];
    let mut diagnostics = summarize_features(features);
    let mood = classify_mood(&diagnostics, beat.bpm);
    let native_novelty =
        native_boundary_novelty(native_low_levels, beat, &bar_starts, structured_bars)?;
    let boundaries = select_phrase_boundaries(features, &native_novelty, mood);
    let (entries, phrase_features) = label_phrases(features, &bar_starts, &boundaries, mood);
    diagnostics.phrase_features = phrase_features;
    let end_index = bar_starts
        .get(structured_bars)
        .copied()
        .unwrap_or(beat.beats.len().saturating_sub(1));
    let end_beat = u16::try_from(end_index.saturating_add(1)).unwrap_or(u16::MAX);

    Ok(SongStructure {
        sample_rate,
        mood,
        end_beat,
        entries,
        diagnostics,
    })
}

fn beat_sample(beat: &BeatAnalysis, index: usize, sample_rate: u32) -> usize {
    let entry = beat.beats[index];
    let residual_us = beat
        .beat_time_residuals_us
        .get(index)
        .copied()
        .unwrap_or_default();
    let time_us = u64::from(entry.time_ms)
        .saturating_mul(1_000)
        .saturating_add(u64::from(residual_us));
    usize::try_from(
        time_us
            .saturating_mul(u64::from(sample_rate))
            .saturating_div(1_000_000),
    )
    .unwrap_or(usize::MAX)
}

fn bar_filter_coefficients(sample_rate: u32) -> [f64; 3] {
    let effective_rate = f64::from(sample_rate) / ANALYSIS_STRIDE as f64;
    [
        1.0 - (-2.0 * PI * 180.0 / effective_rate).exp(),
        1.0 - (-2.0 * PI * 2_000.0 / effective_rate).exp(),
        1.0 - (-2.0 * PI * 12.0 / effective_rate).exp(),
    ]
}

fn extract_bar_features(
    samples: &[f32],
    [low_alpha, mid_alpha, envelope_alpha]: [f64; 3],
) -> [f64; FEATURE_COUNT] {
    if samples.is_empty() {
        return [0.0; FEATURE_COUNT];
    }
    let mut low_pass = 0.0_f64;
    let mut mid_pass = 0.0_f64;
    let mut envelope = 0.0_f64;
    let mut previous = 0.0_f64;
    let mut energy = 0.0_f64;
    let mut low_energy = 0.0_f64;
    let mut mid_energy = 0.0_f64;
    let mut high_energy = 0.0_f64;
    let mut onset = 0.0_f64;
    let mut zero_crossings = 0_usize;
    let mut count = 0_usize;

    for sample in samples.iter().step_by(ANALYSIS_STRIDE) {
        let value = f64::from(if sample.is_finite() { *sample } else { 0.0 });
        low_pass += low_alpha * (value - low_pass);
        mid_pass += mid_alpha * (value - mid_pass);
        let low = low_pass;
        let mid = mid_pass - low_pass;
        let high = value - mid_pass;
        let absolute = value.abs();
        let positive_envelope_delta = (absolute - envelope).max(0.0);
        envelope += envelope_alpha * (absolute - envelope);

        energy += value * value;
        low_energy += low * low;
        mid_energy += mid * mid;
        high_energy += high * high;
        onset += positive_envelope_delta;
        zero_crossings += usize::from((value >= 0.0) != (previous >= 0.0));
        previous = value;
        count += 1;
    }
    let scale = 1.0 / count.max(1) as f64;
    [
        (energy * scale + 1.0e-12).ln(),
        (low_energy * scale + 1.0e-12).ln(),
        (mid_energy * scale + 1.0e-12).ln(),
        (high_energy * scale + 1.0e-12).ln(),
        (onset * scale + 1.0e-12).ln(),
        zero_crossings as f64 * scale,
    ]
}

fn standardize_features(raw: &[[f64; FEATURE_COUNT]]) -> Vec<BarFeature> {
    let mut means = [0.0_f64; FEATURE_COUNT];
    for row in raw {
        for (mean, value) in means.iter_mut().zip(row) {
            *mean += value;
        }
    }
    for mean in &mut means {
        *mean /= raw.len().max(1) as f64;
    }
    let mut scales = [0.0_f64; FEATURE_COUNT];
    for row in raw {
        for ((scale, value), mean) in scales.iter_mut().zip(row).zip(means) {
            *scale += (value - mean).powi(2);
        }
    }
    for scale in &mut scales {
        *scale = (*scale / raw.len().max(1) as f64).sqrt().max(1.0e-6);
    }
    raw.iter()
        .map(|row| {
            let mut standardized = [0.0_f64; FEATURE_COUNT];
            for index in 0..FEATURE_COUNT {
                standardized[index] = (row[index] - means[index]) / scales[index];
            }
            BarFeature {
                standardized,
                raw: *row,
                energy: row[0].exp(),
                onset: row[4].exp(),
            }
        })
        .collect()
}

fn audible_bar_count(features: &[BarFeature]) -> usize {
    let peak = features
        .iter()
        .map(|feature| feature.energy)
        .fold(0.0_f64, f64::max);
    let floor = peak * 0.001;
    let last_audible = features
        .iter()
        .rposition(|feature| feature.energy >= floor)
        .unwrap_or(features.len().saturating_sub(1));
    (last_audible + 1).clamp(2, features.len())
}

fn summarize_features(features: &[BarFeature]) -> SongStructureDiagnostics {
    let count = features.len().max(1) as f64;
    let mut low_band_ratio = 0.0_f64;
    let mut high_band_ratio = 0.0_f64;
    let mut rhythmic_density = 0.0_f64;
    let mut zero_crossing_rate = 0.0_f64;
    let mean_log_energy = features.iter().map(|feature| feature.raw[0]).sum::<f64>() / count;
    let energy_deviation = (features
        .iter()
        .map(|feature| (feature.raw[0] - mean_log_energy).powi(2))
        .sum::<f64>()
        / count)
        .sqrt();
    for feature in features {
        let low = feature.raw[1].exp();
        let mid = feature.raw[2].exp();
        let high = feature.raw[3].exp();
        let band_sum = (low + mid + high).max(1.0e-12);
        low_band_ratio += low / band_sum;
        high_band_ratio += high / band_sum;
        rhythmic_density += feature.onset / feature.energy.sqrt().max(1.0e-9);
        zero_crossing_rate += feature.raw[5];
    }
    let mut adjacent = features
        .windows(2)
        .map(|pair| feature_distance(pair[0].standardized, pair[1].standardized))
        .collect::<Vec<_>>();
    adjacent.sort_by(f64::total_cmp);
    let adjacent_change_mean = adjacent.iter().sum::<f64>() / adjacent.len().max(1) as f64;
    let adjacent_change_p90 = adjacent
        .get(adjacent.len().saturating_mul(9) / 10)
        .copied()
        .unwrap_or_default();
    let long_change_mean = (4..features.len())
        .map(|boundary| {
            let window = 4.min(boundary).min(features.len() - boundary);
            feature_distance(
                mean_range(features, boundary - window, boundary),
                mean_range(features, boundary, boundary + window),
            )
        })
        .sum::<f64>()
        / features.len().saturating_sub(4).max(1) as f64;

    SongStructureDiagnostics {
        low_band_ratio: low_band_ratio / count,
        high_band_ratio: high_band_ratio / count,
        rhythmic_density: rhythmic_density / count,
        energy_deviation,
        adjacent_change_mean,
        adjacent_change_p90,
        long_change_mean,
        zero_crossing_rate: zero_crossing_rate / count,
        phrase_features: Vec::new(),
    }
}

fn classify_mood(diagnostics: &SongStructureDiagnostics, bpm: f64) -> u16 {
    let slow_anomaly = bpm < 117.0
        && diagnostics.adjacent_change_p90 > 2.0
        && (diagnostics.energy_deviation > 1.3 || diagnostics.rhythmic_density > 0.222);
    let midtempo_high_change = (120.0..=135.0).contains(&bpm)
        && diagnostics.zero_crossing_rate > 0.2
        && diagnostics.long_change_mean > 1.3;
    let high_energy_anomaly =
        diagnostics.energy_deviation > 1.8 && diagnostics.rhythmic_density > 0.22;
    if high_energy_anomaly || slow_anomaly || midtempo_high_change {
        3
    } else if bpm < 116.4
        || diagnostics.rhythmic_density > 0.223_35
        || (bpm > 137.0 && diagnostics.rhythmic_density > 0.22)
    {
        2
    } else {
        1
    }
}

fn native_boundary_novelty(
    envelope: &NativePhraseLowLevelEnvelope,
    beat: &BeatAnalysis,
    bar_starts: &[usize],
    bar_count: usize,
) -> Result<Vec<f64>> {
    let first = beat
        .beats
        .first()
        .ok_or_else(|| anyhow::anyhow!("song-structure analysis requires a beat grid"))?;
    let first_beat_ms = f64::from(first.time_ms)
        + f64::from(
            beat.beat_time_residuals_us
                .first()
                .copied()
                .unwrap_or_default(),
        ) / 1_000.0;
    let trace = reduce_native_phrase_low_levels(envelope, beat.bpm, first_beat_ms)?;
    let mut raw = Vec::with_capacity(bar_count);
    for bar in 0..bar_count {
        let start = bar_starts.get(bar).copied().unwrap_or_default();
        let end = bar_starts
            .get(bar + 1)
            .copied()
            .unwrap_or_else(|| start.saturating_add(BEATS_PER_BAR));
        let row = (end.saturating_sub(start) == BEATS_PER_BAR
            && end <= trace.low_level.len()
            && end <= trace.divided_low_level.len())
        .then(|| {
            [
                trace.low_level[start..end]
                    .iter()
                    .sum::<f64>()
                    .max(0.0)
                    .ln_1p(),
                trace.divided_low_level[start..end]
                    .iter()
                    .sum::<f64>()
                    .max(0.0)
                    .ln_1p(),
            ]
        });
        raw.push(row);
    }

    let valid_count = raw.iter().flatten().count();
    if valid_count < 2 {
        return Ok(vec![0.0; bar_count]);
    }
    let mut means = [0.0_f64; 2];
    for row in raw.iter().flatten() {
        for (mean, value) in means.iter_mut().zip(row) {
            *mean += value;
        }
    }
    for mean in &mut means {
        *mean /= valid_count as f64;
    }
    let mut scales = [0.0_f64; 2];
    for row in raw.iter().flatten() {
        for ((scale, value), mean) in scales.iter_mut().zip(row).zip(means) {
            *scale += (value - mean).powi(2);
        }
    }
    for scale in &mut scales {
        *scale = (*scale / valid_count as f64).sqrt().max(1.0e-12);
    }
    let standardized = raw
        .into_iter()
        .map(|row| {
            row.map(|row| {
                [
                    (row[0] - means[0]) / scales[0],
                    (row[1] - means[1]) / scales[1],
                ]
            })
        })
        .collect::<Vec<_>>();
    let mut novelty = vec![0.0; bar_count];
    for boundary in 1..bar_count {
        let Some((before, after)) = standardized[boundary - 1].zip(standardized[boundary]) else {
            continue;
        };
        novelty[boundary] =
            (((after[0] - before[0]).powi(2) + (after[1] - before[1]).powi(2)) * 0.5).sqrt();
    }
    Ok(novelty)
}

fn select_phrase_boundaries(
    features: &[BarFeature],
    native_novelty: &[f64],
    mood: u16,
) -> Vec<usize> {
    if features.len() <= 4 {
        return vec![0, features.len().saturating_sub(1)];
    }
    let mut novelty = vec![0.0_f64; features.len()];
    for (boundary, slot) in novelty
        .iter_mut()
        .enumerate()
        .take(features.len().saturating_sub(2))
        .skip(2)
    {
        let window = 4.min(boundary).min(features.len() - boundary);
        let before = mean_range(features, boundary - window, boundary);
        let after = mean_range(features, boundary, boundary + window);
        let mut distance = 0.0_f64;
        for feature in 0..FEATURE_COUNT {
            let weight = match feature {
                0 => 1.6,
                1..=3 => 1.0,
                4 => 1.25,
                _ => 0.5,
            };
            distance += weight * (after[feature] - before[feature]).powi(2);
        }
        *slot = distance.sqrt();
    }

    let bars_per_phrase = match mood {
        1 => 9.4,
        2 => 7.5,
        _ => 7.1,
    };
    let target = ((features.len() as f64 / bars_per_phrase).round() as usize)
        .clamp(4, 38)
        .min(features.len());
    let mut scores = vec![vec![f64::NEG_INFINITY; features.len() + 1]; target + 1];
    let mut predecessors = vec![vec![usize::MAX; features.len() + 1]; target + 1];
    scores[0][0] = 0.0;
    for segment in 1..=target {
        let minimum_end = segment;
        let maximum_end = features.len() - (target - segment);
        for end in minimum_end..=maximum_end {
            let minimum_start = segment - 1;
            for (start, boundary_evidence) in novelty
                .iter()
                .copied()
                .enumerate()
                .take(end)
                .skip(minimum_start)
            {
                let previous = scores[segment - 1][start];
                if !previous.is_finite() {
                    continue;
                }
                let boundary_evidence = if start == 0 { 0.0 } else { boundary_evidence };
                let candidate = previous
                    + BOUNDARY_NOVELTY_WEIGHT * boundary_evidence
                    + NATIVE_BOUNDARY_NOVELTY_WEIGHT
                        * native_novelty.get(start).copied().unwrap_or_default()
                    + phrase_duration_score(mood, end - start);
                if candidate > scores[segment][end] {
                    scores[segment][end] = candidate;
                    predecessors[segment][end] = start;
                }
            }
        }
    }

    let mut selected = Vec::with_capacity(target);
    let mut end = features.len();
    for segment in (1..=target).rev() {
        let start = predecessors[segment][end];
        if start == usize::MAX {
            return vec![0];
        }
        selected.push(start);
        end = start;
    }
    selected.reverse();
    selected
}

fn phrase_duration_score(mood: u16, bars: usize) -> f64 {
    match mood {
        1 => match bars {
            8 => 2.2,
            16 => 1.9,
            4 => 1.35,
            12 => 0.65,
            24 => 0.5,
            _ if bars.is_multiple_of(4) => 0.1,
            5..=11 => -0.45,
            2..=20 => -0.9,
            _ => -1.4,
        },
        2 => match bars {
            8 => 1.1,
            4 => 0.9,
            16 => 0.65,
            2..=7 => 0.45,
            9..=12 => 0.25,
            13..=20 => 0.0,
            _ => -0.5,
        },
        _ => match bars {
            4 => 0.9,
            2..=8 => 0.55,
            9..=12 => 0.25,
            13..=17 => 0.0,
            _ => -0.5,
        },
    }
}

fn label_phrases(
    features: &[BarFeature],
    bar_starts: &[usize],
    boundaries: &[usize],
    mood: u16,
) -> (Vec<PhraseEntry>, Vec<PhraseFeatureDiagnostics>) {
    let phrase_features = boundaries
        .iter()
        .enumerate()
        .map(|(index, start)| {
            let end = boundaries.get(index + 1).copied().unwrap_or(features.len());
            mean_range(features, *start, end)
        })
        .collect::<Vec<_>>();
    let mut energies = phrase_features
        .iter()
        .map(|feature| feature[0])
        .collect::<Vec<_>>();
    energies.sort_by(f64::total_cmp);
    let median_energy = energies[energies.len() / 2];
    let high_energy = energies[energies.len() * 3 / 4];

    let phrase_diagnostics = boundaries
        .iter()
        .enumerate()
        .map(|(index, boundary)| {
            let previous = index.saturating_sub(1);
            let feature = phrase_features[index];
            let previous_feature = phrase_features[previous];
            let next_boundary = boundaries.get(index + 1).copied().unwrap_or(features.len());
            PhraseFeatureDiagnostics {
                index: u16::try_from(index + 1).unwrap_or(u16::MAX),
                beat: u16::try_from(
                    bar_starts
                        .get(*boundary)
                        .copied()
                        .unwrap_or_default()
                        .saturating_add(1),
                )
                .unwrap_or(u16::MAX),
                duration_bars: next_boundary.saturating_sub(*boundary),
                energy_z: feature[0],
                low_band_z: feature[1],
                mid_band_z: feature[2],
                high_band_z: feature[3],
                onset_z: feature[4],
                zero_crossing_z: feature[5],
                energy_delta_z: feature[0] - previous_feature[0],
                distance_from_previous: feature_distance(feature, previous_feature),
            }
        })
        .collect::<Vec<_>>();
    let entries = boundaries
        .iter()
        .enumerate()
        .map(|(index, boundary)| {
            let is_first = index == 0;
            let is_last = index + 1 == boundaries.len();
            let current_energy = phrase_features[index][0];
            let previous_energy = index
                .checked_sub(1)
                .map(|previous| phrase_features[previous][0])
                .unwrap_or(current_energy);
            let kind = match mood {
                1 if is_first => 1,
                1 if is_last => 6,
                1 if previous_energy - current_energy > 1.0 => 3,
                1 if current_energy >= median_energy => 5,
                1 => 2,
                _ if is_first => 1,
                _ if is_last => 10,
                _ if current_energy >= high_energy => 9,
                _ if feature_distance(
                    phrase_features[index],
                    phrase_features[index.saturating_sub(1)],
                ) > 1.4 =>
                {
                    8
                }
                _ if current_energy < median_energy - 0.5 => 2,
                _ => 4,
            };
            let next_boundary = boundaries.get(index + 1).copied().unwrap_or(features.len());
            let phrase_onset = features[*boundary..next_boundary]
                .iter()
                .map(|feature| feature.onset)
                .sum::<f64>()
                / next_boundary.saturating_sub(*boundary).max(1) as f64;
            let last_bar_onset = features
                .get(next_boundary.saturating_sub(1))
                .map(|feature| feature.onset)
                .unwrap_or_default();
            let fill_beat = (next_boundary > *boundary + 1
                && last_bar_onset > phrase_onset * 1.45
                && mood == 1
                && matches!(kind, 1 | 2 | 5))
            .then(|| {
                u16::try_from(
                    bar_starts
                        .get(next_boundary.saturating_sub(1))
                        .copied()
                        .unwrap_or_default()
                        .saturating_add(1),
                )
                .unwrap_or(u16::MAX)
            });
            PhraseEntry {
                index: u16::try_from(index + 1).unwrap_or(u16::MAX),
                beat: u16::try_from(
                    bar_starts
                        .get(*boundary)
                        .copied()
                        .unwrap_or_default()
                        .saturating_add(1),
                )
                .unwrap_or(u16::MAX),
                kind,
                k1: false,
                k2: false,
                k3: false,
                transition_beats: [None; 3],
                fill_beat,
            }
        })
        .collect();
    (entries, phrase_diagnostics)
}

fn mean_range(features: &[BarFeature], start: usize, end: usize) -> [f64; FEATURE_COUNT] {
    let mut mean = [0.0_f64; FEATURE_COUNT];
    let range = features.get(start..end).unwrap_or_default();
    for feature in range {
        for (sum, value) in mean.iter_mut().zip(feature.standardized) {
            *sum += value;
        }
    }
    for value in &mut mean {
        *value /= range.len().max(1) as f64;
    }
    mean
}

fn feature_distance(left: [f64; FEATURE_COUNT], right: [f64; FEATURE_COUNT]) -> f64 {
    left.into_iter()
        .zip(right)
        .map(|(left, right)| (left - right).powi(2))
        .sum::<f64>()
        .sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anlz::BeatGridEntry;

    fn synthetic_beat(count: usize) -> BeatAnalysis {
        BeatAnalysis {
            bpm: 120.0,
            confidence: 1.0,
            beats: (0..count)
                .map(|index| BeatGridEntry {
                    beat: u16::try_from(index % 4 + 1).unwrap(),
                    bpm_hundredths: 12_000,
                    time_ms: u32::try_from(index * 500).unwrap(),
                })
                .collect(),
            beat_time_residuals_us: vec![0; count],
        }
    }

    fn synthetic_samples(sample_rate: u32) -> Vec<f32> {
        (0..sample_rate as usize * 64)
            .map(|index| {
                let time = index as f32 / sample_rate as f32;
                let section_gain = if (index / (sample_rate as usize * 8)).is_multiple_of(2) {
                    0.15
                } else {
                    0.65
                };
                section_gain * (2.0 * std::f32::consts::PI * 110.0 * time).sin()
            })
            .collect()
    }

    #[test]
    fn pssi_writer_uses_native_header_and_entry_shape() {
        let structure = SongStructure {
            sample_rate: 44_100,
            mood: 1,
            end_beat: 65,
            entries: vec![
                PhraseEntry {
                    index: 1,
                    beat: 1,
                    kind: 1,
                    k1: true,
                    k2: false,
                    k3: false,
                    transition_beats: [None; 3],
                    fill_beat: Some(29),
                },
                PhraseEntry {
                    index: 2,
                    beat: 33,
                    kind: 2,
                    k1: false,
                    k2: true,
                    k3: false,
                    transition_beats: [Some(41), Some(45), Some(49)],
                    fill_beat: None,
                },
            ],
            diagnostics: SongStructureDiagnostics::default(),
        };
        let tag = structure.to_tag().expect("PSSI");
        let raw = tag.raw();
        assert_eq!(tag.kind(), *b"PSSI");
        assert_eq!(tag.header_len(), HEADER_BYTES);
        assert_eq!(raw.len(), HEADER_BYTES + 2 * ENTRY_BYTES);
        assert_eq!(u16::from_be_bytes([raw[16], raw[17]]), 2);
        assert_eq!(u16::from_be_bytes([raw[18], raw[19]]), 1);
        assert_eq!(u16::from_be_bytes([raw[26], raw[27]]), 65);
        assert_eq!(&raw[32..38], &[0, 1, 0, 1, 0, 1]);
        assert_eq!(raw[39], 1);
        assert_eq!(raw[53], 1);
        assert_eq!(&raw[54..56], &[0, 29]);
        assert_eq!(raw[32 + ENTRY_BYTES + 11], 1);
        assert_eq!(raw[32 + ENTRY_BYTES + 9], 1);
        assert_eq!(raw[32 + ENTRY_BYTES + 19], 0);
        assert_eq!(
            &raw[32 + ENTRY_BYTES + 12..32 + ENTRY_BYTES + 18],
            &[0, 41, 0, 45, 0, 49]
        );
    }

    #[test]
    fn pssi_writer_places_the_k3_up_variant_without_internal_beats() {
        let structure = SongStructure {
            sample_rate: 44_100,
            mood: 1,
            end_beat: 33,
            entries: vec![PhraseEntry {
                index: 1,
                beat: 1,
                kind: 2,
                k1: false,
                k2: false,
                k3: true,
                transition_beats: [None; 3],
                fill_beat: None,
            }],
            diagnostics: SongStructureDiagnostics::default(),
        };
        let tag = structure.to_tag().expect("PSSI");
        assert_eq!(tag.raw()[HEADER_BYTES + 19], 1);
    }

    #[test]
    fn pssi_writer_matches_native_phrase_word_order() {
        let structure = SongStructure {
            sample_rate: 44_100,
            mood: 1,
            end_beat: 65,
            entries: vec![
                PhraseEntry {
                    index: 1,
                    beat: 9,
                    kind: 2,
                    k1: false,
                    k2: true,
                    k3: false,
                    transition_beats: [Some(17), Some(21), Some(25)],
                    fill_beat: Some(29),
                },
                PhraseEntry {
                    index: 2,
                    beat: 33,
                    kind: 6,
                    k1: false,
                    k2: false,
                    k3: false,
                    transition_beats: [None; 3],
                    fill_beat: None,
                },
            ],
            diagnostics: SongStructureDiagnostics::default(),
        };
        let tag = structure.to_tag().expect("PSSI");
        assert_eq!(
            &tag.raw()[HEADER_BYTES..HEADER_BYTES + ENTRY_BYTES],
            &[
                0x00, 0x01, 0x00, 0x09, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x11,
                0x00, 0x15, 0x00, 0x19, 0x00, 0x00, 0x00, 0x01, 0x00, 0x1d,
            ]
        );
    }

    #[test]
    fn mood_classifier_separates_corrected_native_input_families() {
        assert_eq!(
            classify_mood(
                &SongStructureDiagnostics {
                    rhythmic_density: 0.19,
                    ..SongStructureDiagnostics::default()
                },
                124.0,
            ),
            1
        );
        assert_eq!(
            classify_mood(
                &SongStructureDiagnostics {
                    rhythmic_density: 0.224,
                    ..SongStructureDiagnostics::default()
                },
                150.0,
            ),
            2
        );
        assert_eq!(
            classify_mood(
                &SongStructureDiagnostics {
                    adjacent_change_p90: 2.1,
                    energy_deviation: 1.4,
                    rhythmic_density: 0.21,
                    ..SongStructureDiagnostics::default()
                },
                110.0,
            ),
            3
        );
        assert_eq!(
            classify_mood(
                &SongStructureDiagnostics {
                    energy_deviation: 2.0,
                    rhythmic_density: 0.19,
                    ..SongStructureDiagnostics::default()
                },
                124.0,
            ),
            1
        );
    }

    #[test]
    fn song_structure_is_deterministic_and_covers_the_grid() {
        let sample_rate = 44_100;
        let samples = synthetic_samples(sample_rate);
        let beat = synthetic_beat(128);
        let first = analyze_song_structure(&samples, sample_rate, &beat).expect("structure");
        let native_low_levels =
            extract_native_phrase_low_level_envelope(&samples, sample_rate).expect("low levels");
        let second = analyze_song_structure_with_native_low_levels(
            &samples,
            sample_rate,
            &beat,
            &native_low_levels,
        )
        .expect("precomputed structure");
        assert_eq!(first, second);
        assert_eq!(first.entries[0].beat, 1);
        assert!(first.entries.len() >= 4);
        assert!(first.end_beat <= 128);
        first.to_tag().expect("serializable PSSI");
    }

    #[test]
    fn phrase_boundaries_after_the_first_follow_downbeat_labels() {
        let sample_rate = 44_100;
        let samples = synthetic_samples(sample_rate);
        let mut beat = synthetic_beat(128);
        for (index, entry) in beat.beats.iter_mut().enumerate() {
            entry.beat = u16::try_from((index + 2) % BEATS_PER_BAR + 1).unwrap();
        }

        let structure = analyze_song_structure(&samples, sample_rate, &beat).expect("structure");
        assert_eq!(structure.entries[0].beat, 1);
        assert!(structure.entries.len() >= 4);
        for phrase in structure.entries.iter().skip(1) {
            assert_eq!(beat.beats[usize::from(phrase.beat - 1)].beat, 1);
        }
    }

    #[test]
    fn high_mood_labels_reserve_down_for_a_real_energy_drop() {
        let energies = [-0.5, 1.5, 0.3, 0.0, 1.0, -0.2];
        let features = energies
            .into_iter()
            .map(|energy| {
                let mut standardized = [0.0; FEATURE_COUNT];
                standardized[0] = energy;
                BarFeature {
                    standardized,
                    raw: [0.0; FEATURE_COUNT],
                    energy: energy.exp(),
                    onset: 0.0,
                }
            })
            .collect::<Vec<_>>();
        let boundaries = [0, 1, 2, 3, 4, 5];
        let bar_starts = [0, 4, 8, 12, 16, 20];

        let (entries, diagnostics) = label_phrases(&features, &bar_starts, &boundaries, 1);

        assert_eq!(
            entries.iter().map(|entry| entry.kind).collect::<Vec<_>>(),
            [1, 5, 3, 2, 5, 6]
        );
        assert_eq!(diagnostics.len(), entries.len());
        assert_eq!(diagnostics[2].energy_delta_z, -1.2);
        assert_eq!(diagnostics[3].duration_bars, 1);
    }
}
