//! Variable-tempo low-frequency bar-phase analysis.
//!
//! This clean-room implementation recovers Rekordbox 6.8.2's low-frequency
//! envelope extraction, four-way phase scorer, winner selection, numbering,
//! and one-beat boundary repair.

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

use crate::beat_decoder::ExpandedBeat;

const BAR_BEATS: u8 = 4;

/// Native numbering branch used after selecting the strongest phase bucket.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UnitEnvelopeNumbering {
    /// The ordinary path: the selected bucket is beat one.
    GridAligned,
    /// Alternate leading-partial-bar path observed when the native timing
    /// threshold crosses the first beat.
    LeadingPartialBar,
}

/// Selected four-way phase and the resulting first beat number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitEnvelopePhase {
    /// Zero-based winning score bucket.
    pub score_index: u8,
    /// One-based beat number assigned to the first retained grid entry.
    pub first_beat_number: u8,
}

/// Inputs consumed by the recovered `UnitEnvelopeMaker` tail.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnitEnvelopeAdjustment {
    /// One-based beat number assigned to the first retained grid entry.
    pub first_beat_number: u8,
    /// Signed source-frame offset applied uniformly to every beat.
    pub frame_offset: i32,
}

/// Structural changes made while applying one adjustment.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct UnitEnvelopeAdjustmentReport {
    /// Number of original entries shifted and renumbered.
    pub adjusted_beats: usize,
    /// Whether one extrapolated beat was inserted before the grid.
    pub prepended: bool,
    /// Whether one extrapolated beat was inserted after the grid.
    pub appended: bool,
    /// Whether one negative leading beat was removed.
    pub removed_leading: bool,
    /// Whether one out-of-track trailing beat was removed.
    pub removed_trailing: bool,
}

/// Bounded output of the variable-tempo envelope scorer.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitEnvelopeScoring {
    /// Weighted low-frequency onset energy for each bar phase.
    pub phase_scores: [f64; BAR_BEATS as usize],
    /// Number of mean-thresholded envelope peaks considered.
    pub strong_peak_count: usize,
    /// Native first-grid timing branch.
    pub numbering: UnitEnvelopeNumbering,
    /// Selected native phase, including the first-peak positional fallback
    /// when all four weighted scores are non-positive.
    pub phase: Option<UnitEnvelopePhase>,
}

/// Beat-grid-independent low-frequency feature stream.
///
/// Extraction is deliberately separate from scoring so callers can compute it
/// concurrently with beat sensing, then score it against the completed grid.
#[derive(Debug, Clone, PartialEq)]
pub struct UnitEnvelopeFeature {
    source_sample_rate: u32,
    scoring_sample_rate: u32,
    envelope: Vec<i16>,
    strong_peaks: Vec<usize>,
}

impl UnitEnvelopeFeature {
    /// Original PCM sample rate used by the beat grid.
    #[must_use]
    pub const fn source_sample_rate(&self) -> u32 {
        self.source_sample_rate
    }

    /// Native-compatible sample rate used by the envelope filters.
    #[must_use]
    pub const fn scoring_sample_rate(&self) -> u32 {
        self.scoring_sample_rate
    }

    /// Number of 128-frame envelope samples.
    #[must_use]
    pub const fn envelope_len(&self) -> usize {
        self.envelope.len()
    }

    /// Number of mean-thresholded peaks retained for scoring.
    #[must_use]
    pub const fn strong_peak_count(&self) -> usize {
        self.strong_peaks.len()
    }

    /// Mean-thresholded peak indexes in the 128-frame envelope.
    #[must_use]
    pub fn strong_peaks(&self) -> &[usize] {
        &self.strong_peaks
    }

    /// Signed native envelope samples.
    #[must_use]
    pub fn envelope(&self) -> &[i16] {
        &self.envelope
    }
}

/// Extract the variable-tempo low-frequency feature stream.
///
/// `samples` are normalized source-rate mono PCM. The native analyzer receives
/// stereo int16-amplitude PCM; multiplying by 32768 and duplicating the mono
/// value reproduces its channel mean before the recovered filter cascade.
pub fn extract_unit_envelope_feature(
    samples: &[f32],
    sample_rate: u32,
) -> Result<UnitEnvelopeFeature> {
    if samples.is_empty() {
        bail!("unit-envelope extraction requires non-empty PCM");
    }
    if sample_rate == 0 {
        bail!("unit-envelope extraction requires a non-zero sample rate");
    }

    let scoring_rate = unit_envelope_sample_rate(sample_rate);
    let resampled;
    let scoring_samples = if scoring_rate == sample_rate {
        samples
    } else {
        resampled = resample_unit_envelope(samples, sample_rate, scoring_rate);
        &resampled
    };
    let envelope = extract_envelope_samples(scoring_samples, scoring_rate)?;
    let strong_peaks = strong_envelope_peaks(&envelope);
    Ok(UnitEnvelopeFeature {
        source_sample_rate: sample_rate,
        scoring_sample_rate: scoring_rate,
        envelope,
        strong_peaks,
    })
}

/// Score one extracted feature stream against a completed variable beat grid.
pub fn score_unit_envelope_feature(
    feature: &UnitEnvelopeFeature,
    beats: &[ExpandedBeat],
) -> Result<UnitEnvelopeScoring> {
    if beats.len() < 2 {
        bail!("unit-envelope scoring requires at least two beats");
    }
    validate_periods(beats)?;

    let numbering = unit_envelope_numbering(beats[0], feature.source_sample_rate)?;
    let phase_scores = score_strong_peaks(
        &feature.envelope,
        &feature.strong_peaks,
        feature.source_sample_rate,
        feature.scoring_sample_rate,
        beats,
    );
    let phase = select_unit_envelope_phase(phase_scores, numbering).or_else(|| {
        positional_unit_envelope_phase(
            feature.strong_peaks.first().copied(),
            feature.source_sample_rate,
            feature.scoring_sample_rate,
            beats,
            numbering,
        )
    });
    Ok(UnitEnvelopeScoring {
        phase_scores,
        strong_peak_count: feature.strong_peaks.len(),
        numbering,
        phase,
    })
}

/// Extract and score the variable-tempo low-frequency unit envelope.
pub fn score_unit_envelope(
    samples: &[f32],
    sample_rate: u32,
    beats: &[ExpandedBeat],
) -> Result<UnitEnvelopeScoring> {
    let feature = extract_unit_envelope_feature(samples, sample_rate)?;
    score_unit_envelope_feature(&feature, beats)
}

/// Select the native first-grid numbering branch.
///
/// The threshold is 90% of the first local period. This is the recovered
/// `0.0009 * sample_rate * period_ms` comparison, not a full-period test.
pub fn unit_envelope_numbering(
    first_beat: ExpandedBeat,
    sample_rate: u32,
) -> Result<UnitEnvelopeNumbering> {
    if sample_rate == 0 {
        bail!("unit-envelope numbering requires a non-zero sample rate");
    }
    if !first_beat.period_ms.is_finite() || first_beat.period_ms <= 0.0 {
        bail!("unit-envelope numbering requires a positive finite first period");
    }
    let leading_threshold = f64::from(first_beat.period_ms) * 0.0009 * f64::from(sample_rate);
    Ok(
        if f64::from(first_beat.position_frame) > leading_threshold {
            UnitEnvelopeNumbering::LeadingPartialBar
        } else {
            UnitEnvelopeNumbering::GridAligned
        },
    )
}

/// Select the native maximum phase bucket and convert it to a beat-number seed.
///
/// Ties retain the earliest bucket. This score-only helper returns `None` when
/// every score is non-positive; full feature scoring then applies the native
/// first-peak positional fallback.
#[must_use]
pub fn select_unit_envelope_phase(
    scores: [f64; BAR_BEATS as usize],
    numbering: UnitEnvelopeNumbering,
) -> Option<UnitEnvelopePhase> {
    let mut winner = None;
    let mut maximum = 0.0;
    for (index, score) in scores.into_iter().enumerate() {
        if score.is_finite() && score > maximum {
            maximum = score;
            winner = Some(index as u8);
        }
    }
    phase_from_score_index(winner?, numbering)
}

fn phase_from_score_index(
    score_index: u8,
    numbering: UnitEnvelopeNumbering,
) -> Option<UnitEnvelopePhase> {
    if score_index >= BAR_BEATS {
        return None;
    }
    let seed = match numbering {
        UnitEnvelopeNumbering::GridAligned => BAR_BEATS.wrapping_sub(score_index),
        UnitEnvelopeNumbering::LeadingPartialBar => 1_u8.wrapping_sub(score_index) & 3,
    };
    Some(UnitEnvelopePhase {
        score_index,
        first_beat_number: (seed & 3) + 1,
    })
}

fn positional_unit_envelope_phase(
    first_peak: Option<usize>,
    source_sample_rate: u32,
    scoring_sample_rate: u32,
    beats: &[ExpandedBeat],
    numbering: UnitEnvelopeNumbering,
) -> Option<UnitEnvelopePhase> {
    let first_peak = i32::try_from(first_peak?).ok()?;
    let (positions, _) = unit_envelope_grid(beats, source_sample_rate, scoring_sample_rate);
    let score_index = (nearest_beat_index(&positions, first_peak) & 3) as u8;
    phase_from_score_index(score_index, numbering)
}

/// Apply the recovered global offset, bar numbering, and boundary repair.
///
/// The source frame count is exclusive. Like the native tail, this performs at
/// most one removal or insertion at either boundary because its upstream
/// offset is bounded to a small fraction of one beat.
pub fn apply_unit_envelope_adjustment(
    beats: &mut Vec<ExpandedBeat>,
    sample_rate: u32,
    total_frames: u64,
    adjustment: UnitEnvelopeAdjustment,
) -> Result<UnitEnvelopeAdjustmentReport> {
    if beats.is_empty() {
        bail!("unit-envelope adjustment requires at least one beat");
    }
    if sample_rate == 0 {
        bail!("unit-envelope adjustment requires a non-zero sample rate");
    }
    if total_frames == 0 || total_frames > i32::MAX as u64 {
        bail!("unit-envelope adjustment requires an i32-sized track");
    }
    if !(1..=BAR_BEATS).contains(&adjustment.first_beat_number) {
        bail!(
            "unit-envelope first beat number must be between 1 and {BAR_BEATS}, received {}",
            adjustment.first_beat_number
        );
    }
    validate_periods(beats)?;

    let adjusted_beats = beats.len();
    for (index, beat) in beats.iter_mut().enumerate() {
        beat.position_frame = beat
            .position_frame
            .checked_add(adjustment.frame_offset)
            .ok_or_else(|| anyhow::anyhow!("unit-envelope frame offset overflowed"))?;
        beat.beat_number = beat_number_at(adjustment.first_beat_number, index);
    }

    let mut report = UnitEnvelopeAdjustmentReport {
        adjusted_beats,
        ..UnitEnvelopeAdjustmentReport::default()
    };
    let total_frames = total_frames as i32;

    let last = *beats
        .last()
        .expect("unit-envelope beat validation preserves a non-empty grid");
    if last.position_frame >= total_frames {
        beats.pop();
        report.removed_trailing = true;
    } else {
        let next_position = last
            .position_frame
            .checked_add(period_frames(last.period_ms, sample_rate)?)
            .ok_or_else(|| anyhow::anyhow!("unit-envelope trailing beat overflowed"))?;
        if next_position < total_frames {
            beats.push(ExpandedBeat {
                position_frame: next_position,
                beat_number: next_beat_number(last.beat_number),
                ..last
            });
            report.appended = true;
        }
    }

    if beats.is_empty() {
        return Ok(report);
    }
    if beats[0].position_frame < 0 {
        beats.remove(0);
        report.removed_leading = true;
    }

    let Some(first) = beats.first().copied() else {
        return Ok(report);
    };
    let first_period_frames = period_frames(first.period_ms, sample_rate)?;
    if first.position_frame >= first_period_frames {
        beats.insert(
            0,
            ExpandedBeat {
                position_frame: first.position_frame - first_period_frames,
                beat_number: previous_beat_number(first.beat_number),
                ..first
            },
        );
        report.prepended = true;
    }

    Ok(report)
}

fn validate_periods(beats: &[ExpandedBeat]) -> Result<()> {
    if beats
        .iter()
        .any(|beat| !beat.period_ms.is_finite() || beat.period_ms <= 0.0)
    {
        bail!("unit-envelope adjustment requires positive finite beat periods");
    }
    Ok(())
}

fn period_frames(period_ms: f32, sample_rate: u32) -> Result<i32> {
    let frames = f64::from(period_ms) * 0.001 * f64::from(sample_rate);
    if !frames.is_finite() || frames + 0.5 > f64::from(i32::MAX) {
        bail!("unit-envelope beat period exceeds the source-frame range");
    }
    Ok((frames + 0.5) as i32)
}

fn beat_number_at(first: u8, index: usize) -> u8 {
    ((usize::from(first - 1) + index) % usize::from(BAR_BEATS)) as u8 + 1
}

fn next_beat_number(beat: u8) -> u8 {
    (beat % BAR_BEATS) + 1
}

fn previous_beat_number(beat: u8) -> u8 {
    ((beat + BAR_BEATS - 2) % BAR_BEATS) + 1
}

fn extract_envelope_samples(samples: &[f32], sample_rate: u32) -> Result<Vec<i16>> {
    const BLOCK_FRAMES: usize = 128;
    let sample_rate = f64::from(sample_rate);
    let envelope_rate = sample_rate / BLOCK_FRAMES as f64;
    if envelope_rate <= 10.0 {
        bail!("unit-envelope sample rate is too low for the native filters");
    }

    let mut low_150_a = Biquad::low_pass(150.0, sample_rate);
    let mut low_150_b = Biquad::low_pass(150.0, sample_rate);
    let mut low_5 = Biquad::low_pass(5.0, envelope_rate);
    let mut high_05 = FirstOrderHighPass::new(0.5, envelope_rate);
    let mut envelope = Vec::with_capacity(samples.len().div_ceil(BLOCK_FRAMES));

    for block in samples.chunks(BLOCK_FRAMES) {
        let mut first_filtered = 0.0;
        for (index, sample) in block.iter().copied().enumerate() {
            let int16_amplitude = f64::from(quantize_normalized_i16(sample));
            let filtered = low_150_b.process(low_150_a.process(int16_amplitude));
            if index == 0 {
                first_filtered = filtered;
            }
        }
        let slow = low_5.process(first_filtered.abs());
        let centered = high_05.process(slow);
        envelope.push((centered.trunc() as i32) as i16);
    }
    Ok(envelope)
}

fn quantize_normalized_i16(sample: f32) -> i16 {
    if !sample.is_finite() {
        return 0;
    }
    (f64::from(sample) * 32_768.0)
        .trunc()
        .clamp(f64::from(i16::MIN), f64::from(i16::MAX)) as i16
}

fn strong_envelope_peaks(envelope: &[i16]) -> Vec<usize> {
    if envelope.len() < 2 {
        return Vec::new();
    }

    let mut sparse = vec![0_i16; envelope.len()];
    let mut peak = 0_i16;
    let mut peak_index = 0;
    let mut rising = false;
    let mut positive_sum = 0_u64;
    let mut positive_count = 0_u64;
    for index in 1..envelope.len() {
        let sample = envelope[index];
        if !rising && envelope[index - 1] > sample {
            peak = sample;
        }
        if peak < sample {
            rising = true;
            peak_index = index;
            peak = sample;
        }
        if !rising || (sample != 0 && f64::from(peak) / f64::from(sample) <= 1.5) {
            continue;
        }

        sparse[peak_index] = peak;
        rising = false;
        if peak > 0 {
            positive_sum += peak as u64;
            positive_count += 1;
        }
        peak = sample;
    }

    if positive_count == 0 {
        return Vec::new();
    }
    let mean = (positive_sum / positive_count) as i16;
    sparse
        .iter_mut()
        .enumerate()
        .filter_map(|(index, peak)| {
            if *peak < mean {
                *peak = 0;
                None
            } else {
                Some(index)
            }
        })
        .collect()
}

fn score_strong_peaks(
    envelope: &[i16],
    strong_peaks: &[usize],
    source_sample_rate: u32,
    scoring_sample_rate: u32,
    beats: &[ExpandedBeat],
) -> [f64; BAR_BEATS as usize] {
    let mut scores = [0.0; BAR_BEATS as usize];
    let Some(first_peak) = strong_peaks.first().copied() else {
        return scores;
    };
    let onset_lead = (f64::from(scoring_sample_rate) * 0.11 / 128.0 + 0.5).trunc() as i32;
    let (beat_positions, beat_periods) =
        unit_envelope_grid(beats, source_sample_rate, scoring_sample_rate);

    let first_period = beat_periods[nearest_beat_index(&beat_positions, first_peak as i32)];
    let first_gap = strong_peaks
        .get(1)
        .map_or(0, |next| next.saturating_sub(first_peak)) as f64;
    let third_gap = strong_peaks
        .get(2)
        .map_or(0, |next| next.saturating_sub(first_peak)) as f64;
    let first_is_structural = in_rounded_period_window(first_gap, first_period, 0.9, 1.1)
        || in_rounded_period_window(first_gap, first_period, 1.8, 2.2)
        || in_rounded_period_window(third_gap, first_period, 0.9, 1.1);
    if first_is_structural {
        let target = (first_peak as i32).saturating_sub(onset_lead.min(first_peak as i32));
        let phase = nearest_beat_index(&beat_positions, target) & 3;
        scores[phase] = f64::from(envelope[first_peak]) * 2.0;
    }

    let maximum = strong_peaks
        .iter()
        .map(|index| envelope[*index])
        .max()
        .map_or(0.0, f64::from);
    let amplitude_threshold = maximum * 0.6;
    let mut index = 1;
    while index + 1 < strong_peaks.len() {
        let previous_peak = strong_peaks[index - 1];
        let peak = strong_peaks[index];
        let period = beat_periods[nearest_beat_index(&beat_positions, peak as i32)];
        if (peak - previous_peak) as f64 <= period * 7.0 {
            index += 1;
            continue;
        }

        let next_gap = (strong_peaks[index + 1] - peak) as f64;
        index += 1;
        let amplitude = f64::from(envelope[peak]);
        if !in_rounded_period_window(next_gap, period, 1.8, 2.2) && amplitude <= amplitude_threshold
        {
            continue;
        }
        let target = (peak as i32).saturating_sub(onset_lead);
        let beat_index = nearest_beat_index(&beat_positions, target);
        scores[beat_index & 3] += amplitude;
    }
    apply_pattern_bonuses(
        &mut scores,
        strong_peaks,
        &beat_positions,
        &beat_periods,
        onset_lead,
    );
    scores
}

fn apply_pattern_bonuses(
    scores: &mut [f64; BAR_BEATS as usize],
    strong_peaks: &[usize],
    beat_positions: &[i32],
    beat_periods: &[f64],
    onset_lead: i32,
) {
    const PATTERN_BONUS: f64 = 983.04;

    let mut primary_patterns = Vec::new();
    let mut secondary_patterns = Vec::new();
    let mut primary_count = 0_i32;
    let mut secondary_count = 0_i32;
    for peaks in strong_peaks.windows(3) {
        let first = peaks[0];
        let first_gap = (peaks[1] - first) as f64;
        let second_gap = (peaks[2] - peaks[1]) as f64;
        let period = beat_periods[nearest_beat_index(beat_positions, first as i32)];

        if in_truncated_period_window(first_gap, period, 2.25, 2.75)
            && (in_truncated_period_window(second_gap, period, 1.35, 1.65)
                || in_truncated_period_window(second_gap, period, 1.8, 2.2))
        {
            primary_count += 1;
            primary_patterns.push(first);
        } else if in_truncated_period_window(first_gap, period, 1.35, 1.65) {
            secondary_count += 1;
            secondary_patterns.push(first);
        } else if in_truncated_period_window(first_gap, period, 0.9, 1.1)
            && in_truncated_period_window(second_gap, period, 0.9, 1.1)
        {
            secondary_count -= 1;
        }
    }

    let selected = if primary_count >= 11 {
        &primary_patterns
    } else if secondary_count >= 81 {
        &secondary_patterns
    } else {
        return;
    };
    for peak in selected {
        let target = (*peak as i32).saturating_sub(onset_lead);
        scores[nearest_beat_index(beat_positions, target) & 3] += PATTERN_BONUS;
    }
}

fn unit_envelope_grid(
    beats: &[ExpandedBeat],
    source_sample_rate: u32,
    scoring_sample_rate: u32,
) -> (Vec<i32>, Vec<f64>) {
    const BLOCK_FRAMES: f64 = 128.0;
    let period = |beat: &ExpandedBeat| {
        f64::from(beat.period_ms) * 0.001 * f64::from(scoring_sample_rate) / BLOCK_FRAMES
    };
    let position = |beat: &ExpandedBeat| {
        (f64::from(beat.position_frame) * f64::from(scoring_sample_rate)
            / f64::from(source_sample_rate)
            / BLOCK_FRAMES
            + 0.5)
            .trunc() as i32
    };

    let first_period = period(&beats[0]);
    let leading_threshold = f64::from(beats[0].period_ms) * 0.0009 * f64::from(source_sample_rate);
    if f64::from(beats[0].position_frame) > leading_threshold {
        let mut positions = Vec::with_capacity(beats.len());
        let mut periods = Vec::with_capacity(beats.len());
        positions.push(1);
        periods.push(first_period);
        positions.extend(beats[..beats.len() - 1].iter().map(position));
        periods.extend(beats[..beats.len() - 1].iter().map(period));
        (positions, periods)
    } else {
        (
            beats.iter().map(position).collect(),
            beats.iter().map(period).collect(),
        )
    }
}

fn unit_envelope_sample_rate(source_sample_rate: u32) -> u32 {
    if source_sample_rate <= 48_000 {
        source_sample_rate
    } else if source_sample_rate.is_multiple_of(48_000) {
        48_000
    } else if source_sample_rate.is_multiple_of(44_100) {
        44_100
    } else {
        48_000
    }
}

fn resample_unit_envelope(samples: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
    let output_len = ((samples.len() as u128 * u128::from(target_rate)
        + u128::from(source_rate) / 2)
        / u128::from(source_rate)) as usize;
    let source_rate = u128::from(source_rate);
    let target_rate_wide = u128::from(target_rate);
    let last_index = samples.len() - 1;
    let mut output = Vec::with_capacity(output_len);
    for output_index in 0..output_len {
        let phase = output_index as u128 * source_rate;
        let source_index = (phase / target_rate_wide) as usize;
        let next_index = source_index.saturating_add(1).min(last_index);
        let fraction = (phase % target_rate_wide) as f64 / f64::from(target_rate);
        let left = f64::from(samples[source_index.min(last_index)]);
        let right = f64::from(samples[next_index]);
        output.push((left + (right - left) * fraction) as f32);
    }
    output
}

fn in_rounded_period_window(gap: f64, period: f64, low: f64, high: f64) -> bool {
    let low = (period * low + 0.5).trunc();
    let high = (period * high + 0.5).trunc();
    gap >= low && gap <= high
}

fn in_truncated_period_window(gap: f64, period: f64, low: f64, high: f64) -> bool {
    gap > (period * low).trunc() && gap <= (period * high).trunc()
}

fn nearest_beat_index(positions: &[i32], target: i32) -> usize {
    if positions.len() < 2 || target <= positions[0] {
        return 0;
    }
    let mut low = 0;
    let mut high = positions.len() - 1;
    while low < high {
        let middle = low + (high - low) / 2;
        let boundary = i64::from(positions[middle]) + i64::from(positions[middle + 1]);
        if i64::from(target) * 2 < boundary {
            high = middle;
        } else {
            low = middle + 1;
        }
    }
    low
}

#[derive(Debug, Clone, Copy)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}

impl Biquad {
    fn low_pass(cutoff_hz: f64, sample_rate: f64) -> Self {
        let omega = std::f64::consts::TAU * cutoff_hz / sample_rate;
        let (sin, cos) = omega.sin_cos();
        let alpha = sin * std::f64::consts::FRAC_1_SQRT_2;
        let scale = 1.0 / (1.0 + alpha);
        Self {
            b0: (1.0 - cos) * 0.5 * scale,
            b1: (1.0 - cos) * scale,
            b2: (1.0 - cos) * 0.5 * scale,
            a1: -2.0 * cos * scale,
            a2: (1.0 - alpha) * scale,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    fn process(&mut self, sample: f64) -> f64 {
        let output = self.b0 * sample + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = sample;
        self.y2 = self.y1;
        self.y1 = output;
        output
    }
}

#[derive(Debug, Clone, Copy)]
struct FirstOrderHighPass {
    b0: f64,
    b1: f64,
    a1: f64,
    x1: f64,
    y1: f64,
}

impl FirstOrderHighPass {
    fn new(cutoff_hz: f64, sample_rate: f64) -> Self {
        let omega = std::f64::consts::TAU * cutoff_hz / sample_rate;
        let scale = 1.0 / (2.0 + omega);
        Self {
            b0: 2.0 * scale,
            b1: -2.0 * scale,
            a1: (omega - 2.0) * scale,
            x1: 0.0,
            y1: 0.0,
        }
    }

    fn process(&mut self, sample: f64) -> f64 {
        let output = self.b0 * sample + self.b1 * self.x1 - self.a1 * self.y1;
        self.x1 = sample;
        self.y1 = output;
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_confirmation_emits_the_pending_positive_peak() {
        assert_eq!(strong_envelope_peaks(&[0, 1, 2, 0]), [2]);
    }

    #[test]
    fn zero_scores_fall_back_to_the_first_strong_peak_position() {
        let beats = [0, 1_280, 2_560, 3_840].map(|position_frame| ExpandedBeat {
            position_frame,
            period_ms: 10.0,
            source_band: None,
            section_anchor: false,
            beat_number: 0,
        });
        let feature = UnitEnvelopeFeature {
            source_sample_rate: 128_000,
            scoring_sample_rate: 128_000,
            envelope: vec![0; 17],
            strong_peaks: vec![16],
        };

        let scoring = score_unit_envelope_feature(&feature, &beats).unwrap();

        assert_eq!(scoring.phase_scores, [0.0; 4]);
        assert_eq!(
            scoring.phase,
            Some(UnitEnvelopePhase {
                score_index: 2,
                first_beat_number: 3,
            })
        );
    }
}
