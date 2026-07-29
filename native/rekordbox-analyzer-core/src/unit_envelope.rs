//! Variable-tempo bar phase and boundary adjustment.
//!
//! This is the clean-room tail of Rekordbox 6.8.2's
//! `UnitEnvelopeMaker::analyze`. The preceding DSP produces four phase scores
//! and a global frame offset. This module selects the native winner, numbers
//! the beat grid, applies the offset, and mirrors the native one-beat boundary
//! repair.

use anyhow::{Result, bail};

use crate::beat_decoder::ExpandedBeat;

const BAR_BEATS: u8 = 4;

/// Native numbering branch used after selecting the strongest phase bucket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnitEnvelopeNumbering {
    /// The ordinary path: the selected bucket is beat one.
    GridAligned,
    /// Alternate leading-partial-bar path observed when the native timing
    /// threshold crosses the first beat.
    LeadingPartialBar,
}

/// Selected four-way phase and the resulting first beat number.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

/// Select the native maximum phase bucket and convert it to a beat-number seed.
///
/// Ties retain the earliest bucket. The native implementation has a separate
/// positional fallback when every score is non-positive; `None` makes that
/// still-unported branch explicit instead of silently inventing a downbeat.
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
    let score_index = winner?;
    let seed = match numbering {
        UnitEnvelopeNumbering::GridAligned => BAR_BEATS.wrapping_sub(score_index),
        UnitEnvelopeNumbering::LeadingPartialBar => 1_u8.wrapping_sub(score_index) & 3,
    };
    Some(UnitEnvelopePhase {
        score_index,
        first_beat_number: (seed & 3) + 1,
    })
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
