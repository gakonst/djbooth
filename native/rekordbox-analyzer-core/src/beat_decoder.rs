//! Tempo-section decoding primitives recovered from the linked analyzer.

use std::collections::HashMap;

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

use crate::beat_sensor::BeatSensorHypothesis;

/// One tempo section before phase and beat-number adjustment.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatTempoSection {
    /// Source-frame anchor. The next section's anchor is this section's end.
    pub anchor_frame: u64,
    /// Quarter-note period in milliseconds.
    pub period_ms: f32,
}

/// One provisional linked-analyzer tempo section.
///
/// Anchor metadata comes from the first hypothesis compatible with the local
/// tempo family. `period_ms` independently comes from the first hypothesis in
/// the exact winning integer-BPM bin.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionalTempoSection {
    /// Source-frame anchor.
    pub anchor_frame: u64,
    /// Quantized periods since the preceding peak at the anchor.
    pub period_ratio: f32,
    /// Representative quarter-note period in milliseconds.
    pub period_ms: f32,
    /// Anchor hypothesis generation.
    pub generation: u32,
    /// Anchor detector path.
    pub band: u8,
}

impl ProvisionalTempoSection {
    /// Return the anchor and period used by subsequent decoder stages.
    #[must_use]
    pub const fn tempo_section(self) -> BeatTempoSection {
        BeatTempoSection {
            anchor_frame: self.anchor_frame,
            period_ms: self.period_ms,
        }
    }
}

/// One tempo section after linked 0.1-BPM refinement.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefinedTempoSection {
    /// Source-frame anchor.
    pub anchor_frame: u64,
    /// Representative quarter-note period in milliseconds.
    pub period_ms: f32,
    /// Native section generation, reset to four during refinement.
    pub generation: u32,
    /// Anchor detector path.
    pub band: u8,
}

impl RefinedTempoSection {
    /// Return the anchor and period used by subsequent decoder stages.
    #[must_use]
    pub const fn tempo_section(self) -> BeatTempoSection {
        BeatTempoSection {
            anchor_frame: self.anchor_frame,
            period_ms: self.period_ms,
        }
    }
}

/// One tempo section after linked pulse and phase adjustment.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdjustedTempoSection {
    /// Selected section origin in source frames.
    pub origin_frame: u64,
    /// Quarter-note period in milliseconds after the native ±2 ms search.
    pub period_ms: f32,
    /// Native pulse marker: 16, 8, or 4 for four-, two-, or one-beat spacing.
    pub pulse_marker: u8,
    /// Whole quarter-note periods removed from the selected peak.
    pub period_offset: u32,
}

/// One beat emitted by the linked analyzer's rolling tempo-section decoder.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpandedBeat {
    /// Signed source-frame position before the final track-bound trim.
    pub position_frame: i32,
    /// Local quarter-note period in milliseconds.
    pub period_ms: f32,
    /// Source detector band when this beat snapped to a surviving hypothesis.
    pub source_band: Option<u8>,
    /// Whether this beat is the selected phase anchor for its tempo section.
    pub section_anchor: bool,
    /// One-based beat within the bar. Zero until final phase assignment.
    pub beat_number: u8,
}

/// Remove callback generations that do not form a continuous metrical region.
///
/// The linked analyzer first builds a sparse callback-generation timeline.
/// Periods propagate backward only when they match the next populated
/// generation directly, at half time, or at double time. Empty generations,
/// isolated one- or two-generation regions, and short regions interrupting a
/// previously retained family are removed as complete generations.
pub fn prune_discontinuous_hypotheses(
    hypotheses: &[BeatSensorHypothesis],
) -> Result<Vec<BeatSensorHypothesis>> {
    validate_pruning_hypotheses(hypotheses)?;
    if hypotheses.is_empty() {
        return Ok(Vec::new());
    }

    let mut periods = Vec::new();
    for hypothesis in hypotheses {
        let generation = linked_callback_generation(hypothesis.generation);
        if generation >= periods.len() {
            periods.resize(generation + 1, 0.0);
            periods[generation] = hypothesis.period_ms;
            continue;
        }
        if periods[generation] != 0.0 {
            continue;
        }

        let Some(next_period) = periods[generation + 1..]
            .iter()
            .copied()
            .find(|period| *period != 0.0)
        else {
            continue;
        };
        if linked_period_matches_reference(next_period, hypothesis.period_ms) {
            periods[generation] = hypothesis.period_ms;
        }
    }

    let mut removed = vec![false; periods.len()];
    let mut generation = 0;
    while generation < periods.len() {
        if periods[generation] == 0.0 {
            removed[generation] = true;
            generation += 1;
            continue;
        }
        if generation + 1 >= periods.len() {
            break;
        }

        let mut region_start = generation;
        let mut cursor = generation + 1;
        let mut reference_period = periods[generation];
        let mut region_steps = 0_u32;
        let mut previous_region_steps = 0_u32;
        let mut previous_region_period = 0.0_f32;
        while cursor < periods.len() {
            let candidate_period = periods[cursor];
            if candidate_period == 0.0 {
                removed[cursor] = true;
                cursor += 1;
                continue;
            }
            if linked_period_matches_reference(reference_period, candidate_period) {
                cursor += 1;
                region_steps += 1;
                reference_period = candidate_period;
                continue;
            }

            let removes_region = region_steps <= 1
                || (region_steps <= 7
                    && linked_period_matches_reference(previous_region_period, candidate_period));
            if removes_region {
                removed[region_start..cursor].fill(true);
                if previous_region_steps != 0 {
                    region_start = cursor;
                    reference_period = previous_region_period;
                    region_steps = previous_region_steps;
                } else {
                    region_start = cursor;
                    reference_period = periods[cursor];
                    previous_region_steps = 0;
                    region_steps = 0;
                }
                continue;
            }

            previous_region_period = reference_period;
            previous_region_steps = region_steps;
            region_steps = 0;
            region_start = cursor;
            cursor += 1;
            reference_period = candidate_period;
        }

        if previous_region_steps != 0 && region_steps == 0 && region_start < cursor {
            removed[region_start..cursor].fill(true);
        }
        break;
    }

    Ok(hypotheses
        .iter()
        .copied()
        .filter(|hypothesis| !removed[linked_callback_generation(hypothesis.generation)])
        .collect())
}

/// Remove short position-ordered tempo-family runs.
///
/// Runs of at most eight records are always removed. Runs of nine through 32
/// records are also removed when the following record reconnects to the
/// preceding retained family. The iterator rewind after erasure and the
/// asymmetric reference-period tolerance match the linked implementation.
pub fn prune_short_hypothesis_runs(
    hypotheses: &[BeatSensorHypothesis],
) -> Result<Vec<BeatSensorHypothesis>> {
    validate_pruning_hypotheses(hypotheses)?;
    let mut output = hypotheses.to_vec();
    if output.len() < 2 {
        return Ok(output);
    }

    let mut region_start = 0_usize;
    let mut cursor = 1_usize;
    let mut previous_region_period = 0.0_f32;
    let mut region_steps = 0_u32;
    let mut previous_region_steps = 0_u32;
    let mut reference_period = output[0].period_ms;
    while cursor < output.len() {
        let candidate_period = output[cursor].period_ms;
        if linked_period_matches_reference(reference_period, candidate_period) {
            cursor += 1;
            region_steps += 1;
            reference_period = candidate_period;
            continue;
        }

        let removes_region = region_steps <= 7
            || (region_steps <= 31
                && linked_period_matches_reference(previous_region_period, candidate_period));
        if removes_region && region_start != cursor {
            output.drain(region_start..cursor);
            cursor = region_start;
            if previous_region_steps != 0 {
                reference_period = previous_region_period;
                region_steps = previous_region_steps;
            } else {
                reference_period = output[region_start].period_ms;
                previous_region_steps = 0;
                region_steps = 0;
            }
            continue;
        }

        region_start = cursor;
        cursor += 1;
        previous_region_period = reference_period;
        previous_region_steps = region_steps;
        region_steps = 0;
        reference_period = candidate_period;
    }

    if region_start != cursor && previous_region_steps != 0 && region_steps <= 7 {
        output.truncate(region_start);
    }
    Ok(output)
}

/// Build the linked analyzer's provisional tempo sections.
///
/// Each source hypothesis starts an inclusive eight-second forward histogram.
/// Integer BPM receives one vote per hypothesis. A family change emits an
/// anchor, while direct, double, and half-time matches continue the section.
pub fn build_provisional_tempo_sections(
    hypotheses: &[BeatSensorHypothesis],
    sample_rate: u32,
) -> Result<Vec<ProvisionalTempoSection>> {
    if sample_rate == 0 {
        bail!("tempo-section construction requires a non-zero sample rate");
    }
    if hypotheses
        .windows(2)
        .any(|pair| pair[0].peak_frame > pair[1].peak_frame)
    {
        bail!("tempo-section construction requires frame-ordered hypotheses");
    }

    let mut bpm_bins = Vec::with_capacity(hypotheses.len());
    for hypothesis in hypotheses {
        if !hypothesis.period_ms.is_finite() || hypothesis.period_ms <= 0.0 {
            bail!("tempo-section construction requires positive finite periods");
        }
        let bpm = linked_integer_bpm(hypothesis.period_ms);
        if !(1..400).contains(&bpm) {
            bail!("tempo-section hypothesis has out-of-range integer BPM {bpm}");
        }
        bpm_bins.push(bpm);
    }
    if hypotheses.is_empty() {
        return Ok(Vec::new());
    }

    let window_frames = u64::from(sample_rate) * 8;
    let mut histogram = [0_u32; 400];
    let mut histogram_start = 0;
    let mut histogram_end = 0;
    let mut source_index = 0;
    let mut previous_window_period = 0.0_f32;
    let mut sections = Vec::new();

    while source_index < hypotheses.len() {
        while histogram_start < source_index {
            histogram[bpm_bins[histogram_start]] -= 1;
            histogram_start += 1;
        }
        while histogram_end < hypotheses.len()
            && hypotheses[histogram_end]
                .peak_frame
                .saturating_sub(hypotheses[source_index].peak_frame)
                <= window_frames
        {
            histogram[bpm_bins[histogram_end]] += 1;
            histogram_end += 1;
        }

        let mut selected_bpm = 0;
        let mut selected_count = 0;
        for (bpm, &count) in histogram.iter().enumerate() {
            if count > selected_count {
                selected_bpm = bpm;
                selected_count = count;
            }
        }
        let selected_period = 60_000.0_f32 / selected_bpm as f32;
        let continues_previous =
            linked_period_matches_reference(previous_window_period, selected_period);
        previous_window_period = selected_period;
        if continues_previous {
            source_index += 1;
            continue;
        }

        let anchor_index = (source_index..histogram_end)
            .find(|&index| {
                linked_period_matches_reference(selected_period, hypotheses[index].period_ms)
            })
            .expect("the selected histogram family has a compatible hypothesis");
        let representative_index = (source_index..histogram_end)
            .find(|&index| bpm_bins[index] == selected_bpm)
            .expect("the selected histogram bin has a representative hypothesis");
        let anchor = hypotheses[anchor_index];
        sections.push(ProvisionalTempoSection {
            anchor_frame: anchor.peak_frame,
            period_ratio: anchor.period_ratio,
            period_ms: hypotheses[representative_index].period_ms,
            generation: anchor.generation,
            band: anchor.band,
        });
        source_index = anchor_index + 1;
    }

    Ok(sections)
}

/// Refine provisional sections at 0.1 BPM and merge adjacent families.
///
/// Coarse integer-BPM voting constrains the fine search to ±1 BPM. When
/// adjacent refined sections are metrical-family compatible, the later section
/// is removed and the preceding section is recomputed over the enlarged span.
pub fn refine_tempo_sections(
    hypotheses: &[BeatSensorHypothesis],
    provisional: &[ProvisionalTempoSection],
    total_frames: u64,
) -> Result<Vec<RefinedTempoSection>> {
    if hypotheses
        .windows(2)
        .any(|pair| pair[0].peak_frame > pair[1].peak_frame)
    {
        bail!("tempo-section refinement requires frame-ordered hypotheses");
    }
    if hypotheses
        .iter()
        .any(|hypothesis| !hypothesis.period_ms.is_finite() || hypothesis.period_ms <= 0.0)
    {
        bail!("tempo-section refinement requires positive finite periods");
    }
    if provisional
        .windows(2)
        .any(|pair| pair[0].anchor_frame > pair[1].anchor_frame)
    {
        bail!("tempo-section refinement requires frame-ordered sections");
    }
    let histogram_bins = hypotheses
        .iter()
        .map(|hypothesis| {
            (
                linked_integer_bpm(hypothesis.period_ms),
                linked_tenth_bpm(hypothesis.period_ms),
            )
        })
        .collect::<Vec<_>>();

    let mut sections = provisional
        .iter()
        .map(|section| RefinedTempoSection {
            anchor_frame: section.anchor_frame,
            period_ms: section.period_ms,
            generation: section.generation,
            band: section.band,
        })
        .collect::<Vec<_>>();
    let mut section_index = 0;
    while section_index < sections.len() {
        let anchor_frame = sections[section_index].anchor_frame;
        let source_start = hypotheses.partition_point(|item| item.peak_frame < anchor_frame);
        if hypotheses
            .get(source_start)
            .is_none_or(|item| item.peak_frame != anchor_frame)
        {
            bail!("tempo-section anchor {anchor_frame} has no source hypothesis");
        }
        let section_length = sections
            .get(section_index + 1)
            .map_or(total_frames, |next| {
                next.anchor_frame.saturating_sub(anchor_frame)
            });
        let source_end = source_start
            + hypotheses[source_start..].partition_point(|item| {
                item.peak_frame.saturating_sub(anchor_frame) <= section_length
            });

        let mut coarse_histogram = [0_u32; 400];
        let mut fine_histogram = [0_u32; 4_000];
        for &(coarse_bpm, fine_bpm) in &histogram_bins[source_start..source_end] {
            if coarse_bpm < coarse_histogram.len() {
                coarse_histogram[coarse_bpm] += 1;
            }
            if fine_bpm < fine_histogram.len() {
                fine_histogram[fine_bpm] += 1;
            }
        }
        let Some(coarse_bpm) = strongest_histogram_bin(&coarse_histogram, 0, 400) else {
            section_index += 1;
            continue;
        };
        let fine_start = coarse_bpm.saturating_sub(1) * 10;
        let fine_end = ((coarse_bpm + 1) * 10).min(fine_histogram.len());
        let Some(fine_bpm) = strongest_histogram_bin(&fine_histogram, fine_start, fine_end) else {
            section_index += 1;
            continue;
        };
        sections[section_index].period_ms = (600_000.0_f64 / fine_bpm as f64) as f32;
        sections[section_index].generation = 4;

        let merges_previous = section_index > 0
            && linked_period_matches_reference(
                sections[section_index - 1].period_ms,
                sections[section_index].period_ms,
            );
        if merges_previous {
            sections.remove(section_index);
            section_index -= 1;
        } else {
            section_index += 1;
        }
    }

    Ok(sections)
}

/// Select each refined section's pulse spacing, period correction, and phase.
///
/// The linked analyzer tests period corrections in `0, +1, -1, +2, -2`
/// millisecond order. For each correction it sweeps four-, two-, and one-beat
/// pulse spacings in 96-frame phase increments, recursively snapping every
/// predicted pulse to the nearest surviving hypothesis. Scores are normalized
/// by pulse spacing before strict-greater comparison, so earlier candidates
/// retain ties.
pub fn adjust_tempo_section_phases(
    hypotheses: &[BeatSensorHypothesis],
    sections: &[RefinedTempoSection],
    sample_rate: u32,
    total_frames: u64,
) -> Result<Vec<AdjustedTempoSection>> {
    validate_phase_inputs(hypotheses, sections, sample_rate, total_frames)?;
    let mut adjusted = Vec::with_capacity(sections.len());
    for section_index in 0..sections.len() {
        let mut best = None;
        'periods: for correction_ms in [0.0_f64, 1.0, -1.0, 2.0, -2.0] {
            let period_ms = f64::from(sections[section_index].period_ms) + correction_ms;
            let period_frames = f64::from(sample_rate) * 0.001 * period_ms;
            let eighth_period = (period_frames * 0.125).trunc() as i64;
            let (lower_frame, upper_frame) = linked_section_search_bounds(
                hypotheses,
                sections,
                section_index,
                eighth_period,
                total_frames,
            );
            let tolerance_frames =
                ((sample_rate / 20) as i32).max(eighth_period.try_into().unwrap_or(i32::MAX));
            let confidence_threshold =
                tolerance_frames as f64 * ((upper_frame - lower_frame) * 0.5) / period_frames;

            for pulse_beats in [4_u8, 2, 1] {
                if let Some(trial) = strongest_phase_trial(
                    hypotheses,
                    lower_frame,
                    upper_frame,
                    period_frames,
                    tolerance_frames,
                    pulse_beats,
                ) {
                    let normalized_score = trial.score * i64::from(pulse_beats);
                    let replaces_best =
                        best.as_ref().is_none_or(|current: &PhaseSectionCandidate| {
                            normalized_score > current.normalized_score
                        });
                    if replaces_best {
                        best = Some(PhaseSectionCandidate {
                            first_hit: trial.first_hit,
                            period_ms,
                            period_frames,
                            lower_frame,
                            normalized_score,
                            pulse_beats,
                        });
                    }
                }
                if best.as_ref().is_some_and(|candidate| {
                    candidate.normalized_score as f64 > confidence_threshold
                }) {
                    break 'periods;
                }
            }
        }

        let candidate = best.ok_or_else(|| {
            anyhow::anyhow!(
                "tempo-section phase adjustment found no hypothesis for section {section_index}"
            )
        })?;
        let period_offset = ((f64::from(candidate.first_hit) - candidate.lower_frame)
            / candidate.period_frames)
            .trunc() as i32;
        let origin_frame = (f64::from(candidate.first_hit)
            - f64::from(period_offset) * candidate.period_frames)
            .trunc() as i64;
        if origin_frame < 0 || period_offset < 0 {
            bail!("tempo-section phase adjustment produced a negative descriptor");
        }
        adjusted.push(AdjustedTempoSection {
            origin_frame: origin_frame as u64,
            period_ms: candidate.period_ms as f32,
            pulse_marker: candidate.pulse_beats * 4,
            period_offset: period_offset as u32,
        });
    }
    Ok(adjusted)
}

/// Expand adjusted sections through the linked analyzer's rolling grid fit.
///
/// The native production configuration uses a 32-beat fit window: 16 beats
/// of history, a four-beat update stride, and 12 beats of lookahead. Source
/// pulse anchors are corrected by detector-specific offsets before each fit.
/// A newly fitted period takes effect 20 beats after its left endpoint.
pub fn expand_tempo_sections(
    hypotheses: &[BeatSensorHypothesis],
    sections: &[AdjustedTempoSection],
    sample_rate: u32,
    total_frames: u64,
) -> Result<Vec<ExpandedBeat>> {
    validate_expansion_inputs(hypotheses, sections, sample_rate, total_frames)?;
    const HISTORY_BEATS: i64 = 16;
    const STRIDE_BEATS: i64 = 4;
    const FUTURE_BEATS: i64 = 12;
    const WINDOW_BEATS: i64 = HISTORY_BEATS + STRIDE_BEATS + FUTURE_BEATS;
    const QUARTER_STEPS_PER_BEAT: usize = 4;
    const WINDOW_STEPS: usize = WINDOW_BEATS as usize * QUARTER_STEPS_PER_BEAT;
    const STRIDE_STEPS: usize = STRIDE_BEATS as usize * QUARTER_STEPS_PER_BEAT;

    let mut output: Vec<ExpandedBeat> = Vec::new();
    for (section_index, section) in sections.iter().enumerate() {
        let section_end = sections
            .get(section_index + 1)
            .map_or(total_frames, |next| next.origin_frame);
        let period_frames = f64::from(sample_rate) * 0.001 * f64::from(section.period_ms);
        let tolerance_frames =
            (sample_rate / 20).max((period_frames * 0.125).trunc() as u32) as i32;
        let phase_target = (section.origin_frame as f64
            + f64::from(section.period_offset) * period_frames)
            .trunc() as i32;
        let (anchor_index, anchor_position) =
            find_nearest_hypothesis(hypotheses, phase_target, tolerance_frames).ok_or_else(
                || {
                    anyhow::anyhow!(
                        "tempo-section expansion found no phase anchor for section {section_index}"
                    )
                },
            )?;
        let anchor_band = hypotheses[anchor_index].band;
        let correction_scale = f64::from(sample_rate) * 0.001;
        let corrected_anchor = f64::from(anchor_position)
            + linked_band_correction_ms(Some(anchor_band)) * correction_scale;
        let quarter_period = period_frames * 0.25;
        let pulse_steps = usize::from(section.pulse_marker);

        let mut predicted_positions = vec![f64::from(anchor_position)];
        let mut predicted_bands = vec![Some(anchor_band)];
        let mut prediction = f64::from(anchor_position);
        let mut step = 0_usize;
        while prediction < section_end as f64 {
            step += 1;
            prediction += quarter_period;
            let mut band = None;
            if step.is_multiple_of(pulse_steps)
                && let Some((source_index, source_position)) =
                    find_nearest_hypothesis(hypotheses, prediction.trunc() as i32, tolerance_frames)
            {
                prediction = f64::from(source_position);
                band = Some(hypotheses[source_index].band);
            }
            predicted_positions.push(prediction);
            predicted_bands.push(band);
        }

        if predicted_positions.len() <= WINDOW_STEPS
            || predicted_positions[WINDOW_STEPS] >= section_end as f64
        {
            bail!(
                "tempo-section expansion requires a full {WINDOW_BEATS}-beat fit window in section {section_index}"
            );
        }
        let corrected_right = corrected_prediction(
            predicted_positions[WINDOW_STEPS],
            predicted_bands[WINDOW_STEPS],
            correction_scale,
        );
        let first_fit = (corrected_right - corrected_anchor) / WINDOW_BEATS as f64;
        if !first_fit.is_finite() || first_fit <= 0.0 {
            bail!("tempo-section expansion produced an invalid initial fit");
        }
        let last_fit_index = (0_usize..)
            .take_while(|fit_index| {
                let right_step = WINDOW_STEPS + fit_index * STRIDE_STEPS;
                predicted_positions
                    .get(right_step)
                    .is_some_and(|right| *right < section_end as f64)
            })
            .last()
            .unwrap_or(0);
        let last_reset_beat = HISTORY_BEATS + (last_fit_index as i64 + 1) * STRIDE_BEATS;

        let previous_position = output.last().map_or(0, |beat| beat.position_frame);
        let mut first_relative_beat = -i64::from(section.period_offset) - 1;
        let mut first_position = corrected_anchor + first_relative_beat as f64 * first_fit;
        while first_position < f64::from(previous_position) {
            first_relative_beat += 1;
            first_position = corrected_anchor + first_relative_beat as f64 * first_fit;
        }

        let first_output = output.len();
        let mut relative_beat = first_relative_beat;
        let mut position = first_position;
        let mut fit_frames = first_fit;
        while position < section_end as f64 {
            if relative_beat == 0 {
                position = corrected_anchor;
            }
            if relative_beat >= HISTORY_BEATS
                && relative_beat <= last_reset_beat
                && (relative_beat - HISTORY_BEATS) % STRIDE_BEATS == 0
            {
                position = f64::from(position.trunc() as i32);
            }
            if relative_beat >= HISTORY_BEATS + STRIDE_BEATS
                && (relative_beat - HISTORY_BEATS - STRIDE_BEATS) % STRIDE_BEATS == 0
            {
                let fit_index = (relative_beat - HISTORY_BEATS) / STRIDE_BEATS;
                let right_step = WINDOW_STEPS + fit_index as usize * STRIDE_STEPS;
                if predicted_positions
                    .get(right_step)
                    .is_some_and(|right| *right < section_end as f64)
                {
                    let left_beat = fit_index * STRIDE_BEATS;
                    let left_index = (left_beat - first_relative_beat) as usize + first_output;
                    let left_position = f64::from(output[left_index].position_frame);
                    let corrected_right = corrected_prediction(
                        predicted_positions[right_step],
                        predicted_bands[right_step],
                        correction_scale,
                    );
                    fit_frames = (corrected_right - left_position) / WINDOW_BEATS as f64;
                }
            }
            if !fit_frames.is_finite() || fit_frames <= 0.0 {
                bail!("tempo-section expansion produced an invalid rolling fit");
            }

            let source_band = if relative_beat >= 0 {
                predicted_bands
                    .get(relative_beat as usize * QUARTER_STEPS_PER_BEAT)
                    .copied()
                    .flatten()
            } else {
                None
            };
            output.push(ExpandedBeat {
                position_frame: position.trunc() as i32,
                period_ms: (fit_frames * 1_000.0 / f64::from(sample_rate)) as f32,
                source_band,
                section_anchor: relative_beat == 0,
                beat_number: 0,
            });
            position += fit_frames;
            relative_beat += 1;
        }
    }
    Ok(output)
}

/// Repair isolated short or long grid gaps with the linked four-beat filter.
///
/// The filter compares the middle gap of each four-beat window with both
/// outside gaps. It can move beats, remove a duplicate, or insert copied
/// metadata while subdividing a missing-beat span.
pub fn correct_expanded_beat_gaps(beats: &mut Vec<ExpandedBeat>) {
    let mut index = 0_usize;
    while index + 3 < beats.len() {
        let a = beats[index].position_frame;
        let b = beats[index + 1].position_frame;
        let c = beats[index + 2].position_frame;
        let d = beats[index + 3].position_frame;
        let left = f64::from(b.wrapping_sub(a));
        let middle = f64::from(c.wrapping_sub(b));
        let right = f64::from(d.wrapping_sub(c));
        let outer_max = left.max(right);
        let outer_min = left.min(right);

        if middle / outer_max > 1.1 {
            let can_snap_to_max =
                outer_max == left && (middle - outer_max) / (outer_max - outer_min) < 4.0;
            if can_snap_to_max {
                beats[index + 2].position_frame = b.wrapping_add(outer_max.trunc() as i32);
            } else {
                let can_extend_min =
                    outer_min == left && outer_max * 3.0 + middle > outer_min * 5.0;
                if can_extend_min {
                    let minimum = outer_min.trunc() as i32;
                    let double_minimum = (outer_min * 2.0).trunc() as i32;
                    beats[index + 2].position_frame = b.wrapping_add(minimum);
                    if beats[index + 2].position_frame.wrapping_add(double_minimum) < d {
                        let mut inserted = beats[index + 2];
                        inserted.position_frame = b.wrapping_add(double_minimum);
                        beats.insert(index + 2, inserted);
                    }
                } else {
                    let span = f64::from(d.wrapping_sub(a));
                    if (left + middle + right) / outer_max >= 3.3 {
                        beats[index + 1].position_frame =
                            a.wrapping_add((span * 0.25).trunc() as i32);
                        beats[index + 2].position_frame =
                            a.wrapping_add((span * 0.5).trunc() as i32);
                        let mut inserted = beats[index + 2];
                        inserted.position_frame = a.wrapping_add((span * 0.75).trunc() as i32);
                        beats.insert(index + 2, inserted);
                    } else {
                        beats[index + 1].position_frame =
                            a.wrapping_add((span * (1.0 / 3.0)).trunc() as i32);
                        beats[index + 2].position_frame =
                            a.wrapping_add((span * (2.0 / 3.0)).trunc() as i32);
                    }
                }
            }
        } else if middle / outer_min >= 0.9 {
            // The middle gap already agrees with both outside gaps.
        } else {
            let can_snap_to_min =
                outer_min == left && (outer_min - middle) / (outer_max - outer_min) < 4.0;
            if can_snap_to_min {
                beats[index + 2].position_frame = b.wrapping_add(outer_min.trunc() as i32);
            } else {
                let can_snap_to_max =
                    outer_max == left && outer_min * 4.0 + middle < outer_max * 4.0;
                if can_snap_to_max {
                    let replacement = b.wrapping_add(outer_max.trunc() as i32);
                    if replacement >= d {
                        beats.remove(index + 2);
                    } else {
                        beats[index + 2].position_frame = replacement;
                    }
                } else if (left + middle + right) / outer_min > 2.7 {
                    let span = f64::from(d.wrapping_sub(a));
                    beats[index + 1].position_frame =
                        a.wrapping_add((span * (1.0 / 3.0)).trunc() as i32);
                    beats[index + 2].position_frame =
                        a.wrapping_add((span * (2.0 / 3.0)).trunc() as i32);
                } else {
                    beats[index + 1].position_frame = midpoint_toward_zero(a, d);
                    beats.remove(index + 2);
                }
            }
        }
        index += 1;
    }
}

/// Apply linked gap repair, bar numbering, and the final track-bound trim.
pub fn finalize_expanded_beats(
    mut beats: Vec<ExpandedBeat>,
    total_frames: u64,
    meter: u8,
) -> Result<Vec<ExpandedBeat>> {
    if total_frames > i32::MAX as u64 {
        bail!("expanded beat finalization exceeds the linked frame range");
    }
    let phase_anchor = beats
        .iter()
        .find(|beat| beat.section_anchor)
        .map(|beat| beat.position_frame)
        .unwrap_or(0);
    correct_expanded_beat_gaps(&mut beats);
    let meter = meter.max(4);
    if !beats.is_empty() {
        let anchor_index = beats.partition_point(|beat| beat.position_frame <= phase_anchor);
        let anchor_index = anchor_index.saturating_sub(1);
        let phase = anchor_index % usize::from(meter);
        for (index, beat) in beats.iter_mut().enumerate() {
            beat.beat_number =
                ((usize::from(meter) - phase + index) % usize::from(meter) + 1) as u8;
        }
    }
    beats.retain(|beat| {
        beat.position_frame >= 0 && i64::from(beat.position_frame) <= total_frames as i64
    });
    Ok(beats)
}

fn midpoint_toward_zero(left: i32, right: i32) -> i32 {
    let sum = left.wrapping_add(right);
    sum.wrapping_add((sum as u32 >> 31) as i32) >> 1
}

const LINKED_BAND_CORRECTIONS_MS: [f64; 6] = [-30.0, -20.0, -3.0, -3.0, -20.0, -3.0];

fn linked_band_correction_ms(band: Option<u8>) -> f64 {
    band.and_then(|band| LINKED_BAND_CORRECTIONS_MS.get(usize::from(band)).copied())
        .unwrap_or(-3.0)
}

fn corrected_prediction(position: f64, band: Option<u8>, correction_scale: f64) -> f64 {
    position + linked_band_correction_ms(band) * correction_scale
}

fn validate_expansion_inputs(
    hypotheses: &[BeatSensorHypothesis],
    sections: &[AdjustedTempoSection],
    sample_rate: u32,
    total_frames: u64,
) -> Result<()> {
    if sample_rate == 0 {
        bail!("tempo-section expansion requires a non-zero sample rate");
    }
    if total_frames > i32::MAX as u64 {
        bail!("tempo-section expansion exceeds the linked frame range");
    }
    if hypotheses
        .windows(2)
        .any(|pair| pair[0].peak_frame > pair[1].peak_frame)
    {
        bail!("tempo-section expansion requires frame-ordered hypotheses");
    }
    if hypotheses
        .iter()
        .any(|hypothesis| hypothesis.peak_frame > i32::MAX as u64)
    {
        bail!("tempo-section expansion exceeds the linked hypothesis range");
    }
    if sections
        .windows(2)
        .any(|pair| pair[0].origin_frame > pair[1].origin_frame)
    {
        bail!("tempo-section expansion requires frame-ordered sections");
    }
    for section in sections {
        if !section.period_ms.is_finite() || section.period_ms <= 0.0 {
            bail!("tempo-section expansion requires positive finite periods");
        }
        if !matches!(section.pulse_marker, 4 | 8 | 16) {
            bail!("tempo-section expansion requires a 4, 8, or 16 pulse marker");
        }
        if section.origin_frame > total_frames {
            bail!("tempo-section expansion has an origin beyond the track");
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy)]
struct PhaseTrial {
    first_hit: i32,
    score: i64,
}

#[derive(Debug, Clone, Copy)]
struct PhaseSectionCandidate {
    first_hit: i32,
    period_ms: f64,
    period_frames: f64,
    lower_frame: f64,
    normalized_score: i64,
    pulse_beats: u8,
}

fn validate_phase_inputs(
    hypotheses: &[BeatSensorHypothesis],
    sections: &[RefinedTempoSection],
    sample_rate: u32,
    total_frames: u64,
) -> Result<()> {
    if sample_rate == 0 {
        bail!("tempo-section phase adjustment requires a non-zero sample rate");
    }
    if total_frames > i32::MAX as u64 {
        bail!("tempo-section phase adjustment exceeds the linked frame range");
    }
    if hypotheses
        .windows(2)
        .any(|pair| pair[0].peak_frame > pair[1].peak_frame)
    {
        bail!("tempo-section phase adjustment requires frame-ordered hypotheses");
    }
    if hypotheses
        .iter()
        .any(|hypothesis| hypothesis.peak_frame > i32::MAX as u64)
    {
        bail!("tempo-section phase adjustment exceeds the linked hypothesis range");
    }
    if sections
        .windows(2)
        .any(|pair| pair[0].anchor_frame > pair[1].anchor_frame)
    {
        bail!("tempo-section phase adjustment requires frame-ordered sections");
    }
    for section in sections {
        if !section.period_ms.is_finite() || section.period_ms <= 2.0 {
            bail!("tempo-section phase adjustment requires periods above two milliseconds");
        }
        if section.anchor_frame > total_frames {
            bail!("tempo-section phase adjustment has an anchor beyond the track");
        }
        let source_index =
            hypotheses.partition_point(|hypothesis| hypothesis.peak_frame < section.anchor_frame);
        if hypotheses
            .get(source_index)
            .is_none_or(|hypothesis| hypothesis.peak_frame != section.anchor_frame)
        {
            bail!(
                "tempo-section phase anchor {} has no source hypothesis",
                section.anchor_frame
            );
        }
    }
    if !sections.is_empty() && hypotheses.is_empty() {
        bail!("tempo-section phase adjustment requires source hypotheses");
    }
    Ok(())
}

fn linked_section_search_bounds(
    hypotheses: &[BeatSensorHypothesis],
    sections: &[RefinedTempoSection],
    section_index: usize,
    eighth_period: i64,
    total_frames: u64,
) -> (f64, f64) {
    let lower_frame = if section_index == 0 {
        0
    } else {
        linked_section_boundary(
            hypotheses,
            sections[section_index].anchor_frame,
            sections[section_index - 1].anchor_frame,
            eighth_period,
        )
    };
    let upper_frame = sections
        .get(section_index + 1)
        .map_or(total_frames, |next| {
            linked_section_boundary(
                hypotheses,
                next.anchor_frame,
                sections[section_index].anchor_frame,
                eighth_period,
            )
        });
    (lower_frame as f64, upper_frame as f64)
}

fn linked_section_boundary(
    hypotheses: &[BeatSensorHypothesis],
    anchor_frame: u64,
    preceding_anchor: u64,
    eighth_period: i64,
) -> u64 {
    let anchor_index =
        hypotheses.partition_point(|hypothesis| hypothesis.peak_frame <= anchor_frame) - 1;
    let candidate = if anchor_index == 0 {
        hypotheses[0].peak_frame as i64 - eighth_period
    } else {
        hypotheses[anchor_index - 1].peak_frame as i64 + eighth_period
    };
    candidate
        .max(preceding_anchor as i64)
        .min(anchor_frame as i64)
        .max(0) as u64
}

fn strongest_phase_trial(
    hypotheses: &[BeatSensorHypothesis],
    lower_frame: f64,
    upper_frame: f64,
    period_frames: f64,
    tolerance_frames: i32,
    pulse_beats: u8,
) -> Option<PhaseTrial> {
    let spacing_frames = period_frames * f64::from(pulse_beats);
    let phase_end = (lower_frame + spacing_frames).min(upper_frame);
    let mut phase_frame = lower_frame;
    let mut best = None;
    while phase_frame < phase_end {
        let mut target_frame = phase_frame;
        let mut score = 0_i64;
        let mut first_hit = None;
        while target_frame < upper_frame {
            let target_position = target_frame.trunc() as i32;
            if let Some(result_position) =
                find_nearest_position(hypotheses, target_position, tolerance_frames)
            {
                let error = result_position.abs_diff(target_position) as i32;
                score += i64::from(tolerance_frames - error);
                first_hit.get_or_insert(result_position);
                target_frame = f64::from(result_position) + spacing_frames;
            } else {
                target_frame += spacing_frames;
            }
        }
        if let Some(first_hit) = first_hit {
            let replaces_best = best
                .as_ref()
                .is_none_or(|current: &PhaseTrial| score > current.score);
            if replaces_best {
                best = Some(PhaseTrial { first_hit, score });
            }
        }
        phase_frame += 96.0;
    }
    best
}

fn find_nearest_position(
    hypotheses: &[BeatSensorHypothesis],
    target_position: i32,
    tolerance_frames: i32,
) -> Option<i32> {
    find_nearest_hypothesis(hypotheses, target_position, tolerance_frames)
        .map(|(_, position)| position)
}

fn find_nearest_hypothesis(
    hypotheses: &[BeatSensorHypothesis],
    target_position: i32,
    tolerance_frames: i32,
) -> Option<(usize, i32)> {
    let insertion =
        hypotheses.partition_point(|hypothesis| hypothesis.peak_frame <= target_position as u64);
    let mut selected = insertion.checked_sub(1).and_then(|index| {
        let position = hypotheses[index].peak_frame as i32;
        (position.abs_diff(target_position) <= tolerance_frames as u32).then_some((index, position))
    });
    if let Some(successor) = hypotheses.get(insertion) {
        let position = successor.peak_frame as i32;
        let error = position.abs_diff(target_position);
        let selected_error =
            selected.map_or(u32::MAX, |(_, current)| current.abs_diff(target_position));
        if error <= tolerance_frames as u32 && error < selected_error {
            selected = Some((insertion, position));
        }
    }
    selected
}

/// Apply the linked analyzer's one-eighth-beat hypothesis suppression.
///
/// Hypotheses must be in source-frame order. Within each section, nearby
/// hypotheses compete by their originating callback's support count, stored
/// in the low byte of `generation`. A larger count replaces the current
/// hypothesis; ties retain the earlier hypothesis.
pub fn suppress_nearby_hypotheses(
    hypotheses: &[BeatSensorHypothesis],
    sections: &[BeatTempoSection],
    sample_rate: u32,
    total_frames: u64,
) -> Result<Vec<BeatSensorHypothesis>> {
    if sample_rate == 0 {
        bail!("nearby-hypothesis suppression requires a non-zero sample rate");
    }
    if hypotheses
        .windows(2)
        .any(|pair| pair[0].peak_frame > pair[1].peak_frame)
    {
        bail!("nearby-hypothesis suppression requires frame-ordered hypotheses");
    }
    if sections.is_empty() {
        return Ok(hypotheses.to_vec());
    }
    if sections
        .iter()
        .any(|section| !section.period_ms.is_finite() || section.period_ms <= 0.0)
    {
        bail!("nearby-hypothesis suppression requires positive finite section periods");
    }
    if sections
        .windows(2)
        .any(|pair| pair[0].anchor_frame > pair[1].anchor_frame)
    {
        bail!("nearby-hypothesis suppression requires frame-ordered sections");
    }

    let mut callback_support = HashMap::new();
    for hypothesis in hypotheses {
        let callback = hypothesis.generation >> 8;
        let support = hypothesis.generation as u8;
        let stored = callback_support.entry(callback).or_insert(0_u8);
        if *stored == 0 {
            *stored = support;
        }
    }

    let mut output = Vec::with_capacity(hypotheses.len());
    let mut cursor = 0;
    for (index, section) in sections.iter().enumerate() {
        if cursor == hypotheses.len() {
            break;
        }
        let section_end = sections
            .get(index + 1)
            .map_or(total_frames, |next| next.anchor_frame);
        let tolerance_frames = linked_suppression_window(section.period_ms, sample_rate);
        let mut selected = hypotheses[cursor];
        cursor += 1;
        while cursor < hypotheses.len() && hypotheses[cursor].peak_frame < section_end {
            let candidate = hypotheses[cursor];
            cursor += 1;
            if selected.peak_frame.abs_diff(candidate.peak_frame) >= tolerance_frames {
                output.push(selected);
                selected = candidate;
                continue;
            }
            let selected_support = callback_support[&(selected.generation >> 8)];
            let candidate_support = callback_support[&(candidate.generation >> 8)];
            if candidate_support > selected_support {
                selected = candidate;
            }
        }
        output.push(selected);
    }
    output.extend_from_slice(&hypotheses[cursor..]);
    Ok(output)
}

fn linked_suppression_window(period_ms: f32, sample_rate: u32) -> u64 {
    let frame_period = sample_rate as f32 * period_ms;
    (f64::from(frame_period) * 0.000_125).trunc() as u64
}

fn linked_integer_bpm(period_ms: f32) -> usize {
    ((600_000.0_f64 / f64::from(period_ms) + 5.0) / 10.0).trunc() as usize
}

fn linked_tenth_bpm(period_ms: f32) -> usize {
    ((6_000_000.0_f64 / f64::from(period_ms) + 5.0) / 10.0).trunc() as usize
}

fn strongest_histogram_bin(histogram: &[u32], start: usize, end: usize) -> Option<usize> {
    let mut selected = None;
    let mut selected_count = 0;
    for (bin, &count) in histogram[start..end].iter().enumerate() {
        if count > selected_count {
            selected = Some(start + bin);
            selected_count = count;
        }
    }
    selected
}

fn period_tolerance(period_ms: f32) -> f32 {
    (f64::from(period_ms) * 0.04).min(20.0) as f32
}

fn linked_callback_generation(generation: u32) -> usize {
    (generation >> 8) as usize
}

fn linked_period_matches_reference(reference: f32, candidate: f32) -> bool {
    let tolerance = period_tolerance(reference);
    let lower = reference - tolerance;
    let upper = reference + tolerance;
    (candidate > lower && candidate < upper)
        || (candidate + candidate > lower && candidate + candidate < upper)
        || (candidate * 0.5 > lower && candidate * 0.5 < upper)
}

fn validate_pruning_hypotheses(hypotheses: &[BeatSensorHypothesis]) -> Result<()> {
    if hypotheses
        .windows(2)
        .any(|pair| pair[0].peak_frame > pair[1].peak_frame)
    {
        bail!("hypothesis pruning requires frame-ordered hypotheses");
    }
    if hypotheses
        .iter()
        .any(|hypothesis| !hypothesis.period_ms.is_finite() || hypothesis.period_ms <= 0.0)
    {
        bail!("hypothesis pruning requires positive finite periods");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hypothesis(frame: u64, generation: u32, period_ms: f32) -> BeatSensorHypothesis {
        BeatSensorHypothesis {
            peak_frame: frame,
            period_ratio: 1.0,
            period_ms,
            generation,
            band: 0,
        }
    }

    fn expanded_beat(position_frame: i32) -> ExpandedBeat {
        ExpandedBeat {
            position_frame,
            period_ms: 500.0,
            source_band: None,
            section_anchor: false,
            beat_number: 0,
        }
    }

    fn hypotheses_for_periods(periods: &[f32]) -> Vec<BeatSensorHypothesis> {
        periods
            .iter()
            .enumerate()
            .map(|(index, &period_ms)| {
                hypothesis(index as u64 * 1_000, ((index as u32) << 8) | 3, period_ms)
            })
            .collect()
    }

    #[test]
    fn discontinuous_pruning_removes_short_bridged_generations() {
        let mut hypotheses = hypotheses_for_periods(
            &[
                [500.0; 10].as_slice(),
                [350.0; 3].as_slice(),
                [500.0; 10].as_slice(),
            ]
            .concat(),
        );
        hypotheses.insert(
            11,
            BeatSensorHypothesis {
                peak_frame: 10_500,
                period_ratio: 2.0,
                period_ms: 350.0,
                generation: (10 << 8) | 7,
                band: 4,
            },
        );

        let result = prune_discontinuous_hypotheses(&hypotheses).unwrap();

        assert_eq!(result.len(), 20);
        assert!(result.iter().all(|item| item.period_ms == 500.0));
        assert!(
            result
                .iter()
                .all(|item| !(10..=12).contains(&(item.generation >> 8)))
        );
    }

    #[test]
    fn discontinuous_pruning_backfills_only_compatible_generations() {
        let hypotheses = [
            hypothesis(100, (2 << 8) | 3, 500.0),
            hypothesis(200, (0 << 8) | 3, 500.0),
            hypothesis(300, (1 << 8) | 3, 700.0),
            hypothesis(400, (3 << 8) | 3, 500.0),
            hypothesis(500, (4 << 8) | 3, 500.0),
            hypothesis(600, (5 << 8) | 3, 500.0),
        ];

        let result = prune_discontinuous_hypotheses(&hypotheses).unwrap();

        assert!(result.iter().all(|item| item.generation >> 8 != 1));
    }

    #[test]
    fn short_run_pruning_removes_prefix_bridge_and_suffix() {
        let periods = [
            [700.0; 4].as_slice(),
            [500.0; 12].as_slice(),
            [700.0; 27].as_slice(),
            [500.0; 12].as_slice(),
            [700.0; 8].as_slice(),
        ]
        .concat();
        let hypotheses = hypotheses_for_periods(&periods);

        let result = prune_short_hypothesis_runs(&hypotheses).unwrap();

        assert_eq!(result.len(), 24);
        assert!(result.iter().all(|item| item.period_ms == 500.0));
    }

    #[test]
    fn short_run_pruning_keeps_a_33_record_bridge() {
        let periods = [
            [500.0; 12].as_slice(),
            [700.0; 33].as_slice(),
            [500.0; 12].as_slice(),
        ]
        .concat();
        let hypotheses = hypotheses_for_periods(&periods);

        let result = prune_short_hypothesis_runs(&hypotheses).unwrap();

        assert_eq!(result, hypotheses);
    }

    #[test]
    fn pruning_uses_strict_asymmetric_period_bounds() {
        let reference = 500.0_f32;
        let tolerance = period_tolerance(reference);

        assert!(!linked_period_matches_reference(
            reference,
            reference - tolerance
        ));
        assert!(!linked_period_matches_reference(
            reference,
            reference + tolerance
        ));
        assert!(linked_period_matches_reference(reference, 500.1));
        assert!(linked_period_matches_reference(reference, 1_039.0));
        assert!(!linked_period_matches_reference(reference, 1_040.0));
        assert!(!linked_period_matches_reference(reference, 235.0));
        assert!(linked_period_matches_reference(reference, 241.0));
        assert!(linked_period_matches_reference(reference, 250.0));
        assert!(linked_period_matches_reference(reference, 1_000.0));
    }

    #[test]
    fn linked_suppression_prefers_callback_support_and_keeps_earlier_ties() {
        let hypotheses = [
            hypothesis(1_000, 0x0104, 500.0),
            hypothesis(2_000, 0x0207, 501.0),
            hypothesis(3_000, 0x0307, 502.0),
            hypothesis(7_000, 0x0403, 503.0),
        ];
        let sections = [BeatTempoSection {
            anchor_frame: 0,
            period_ms: 500.0,
        }];

        let result = suppress_nearby_hypotheses(&hypotheses, &sections, 48_000, 10_000).unwrap();

        assert_eq!(result, vec![hypotheses[1], hypotheses[3]]);
    }

    #[test]
    fn linked_suppression_uses_the_next_section_anchor_and_period() {
        let hypotheses = [
            hypothesis(100, 0x0103, 400.0),
            hypothesis(2_000, 0x0204, 401.0),
            hypothesis(4_100, 0x0303, 600.0),
            hypothesis(6_900, 0x0405, 601.0),
        ];
        let sections = [
            BeatTempoSection {
                anchor_frame: 500,
                period_ms: 400.0,
            },
            BeatTempoSection {
                anchor_frame: 4_000,
                period_ms: 600.0,
            },
        ];

        let result = suppress_nearby_hypotheses(&hypotheses, &sections, 48_000, 10_000).unwrap();

        assert_eq!(result, vec![hypotheses[1], hypotheses[3]]);
    }

    #[test]
    fn linked_suppression_window_is_strictly_less_than_one_eighth_beat() {
        let hypotheses = [
            hypothesis(0, 0x0103, 500.0),
            hypothesis(3_000, 0x0209, 500.0),
        ];
        let sections = [BeatTempoSection {
            anchor_frame: 0,
            period_ms: 500.0,
        }];

        let result = suppress_nearby_hypotheses(&hypotheses, &sections, 48_000, 10_000).unwrap();

        assert_eq!(result, hypotheses);
    }

    #[test]
    fn provisional_sections_keep_anchor_metadata_and_exact_bin_period() {
        let hypotheses = [
            BeatSensorHypothesis {
                peak_frame: 100,
                period_ratio: 2.0,
                period_ms: 1_000.0,
                generation: 0x0103,
                band: 4,
            },
            hypothesis(200, 0x0204, 500.4),
            hypothesis(300, 0x0305, 499.8),
        ];

        let result = build_provisional_tempo_sections(&hypotheses, 48_000).unwrap();

        assert_eq!(
            result,
            vec![ProvisionalTempoSection {
                anchor_frame: 100,
                period_ratio: 2.0,
                period_ms: 500.4,
                generation: 0x0103,
                band: 4,
            }]
        );
    }

    #[test]
    fn provisional_sections_follow_eight_second_tempo_changes() {
        let hypotheses = [
            hypothesis(0, 0x0103, 500.0),
            hypothesis(100, 0x0203, 500.1),
            hypothesis(9_000, 0x0303, 400.0),
            hypothesis(9_100, 0x0403, 400.1),
        ];

        let result = build_provisional_tempo_sections(&hypotheses, 1_000).unwrap();

        assert_eq!(
            result
                .iter()
                .map(|section| section.tempo_section())
                .collect::<Vec<_>>(),
            vec![
                BeatTempoSection {
                    anchor_frame: 0,
                    period_ms: 500.0,
                },
                BeatTempoSection {
                    anchor_frame: 9_000,
                    period_ms: 400.0,
                },
            ]
        );
    }

    #[test]
    fn provisional_histogram_ties_retain_the_lower_bpm() {
        let hypotheses = [
            hypothesis(0, 0x0103, 500.0),
            BeatSensorHypothesis {
                peak_frame: 100,
                period_ratio: 1.5,
                period_ms: 504.2,
                generation: 0x0203,
                band: 2,
            },
        ];

        let result = build_provisional_tempo_sections(&hypotheses, 48_000).unwrap();

        assert_eq!(result[0].anchor_frame, 0);
        assert_eq!(result[0].period_ms, 504.2);
    }

    #[test]
    fn refinement_uses_tenth_bpm_and_resets_generation() {
        let hypotheses = [
            hypothesis(0, 0x0103, 412.4),
            hypothesis(100, 0x0203, 412.3),
            hypothesis(200, 0x0303, 413.0),
        ];
        let provisional = [ProvisionalTempoSection {
            anchor_frame: 0,
            period_ratio: 1.0,
            period_ms: 413.0,
            generation: 0x0103,
            band: 2,
        }];

        let result = refine_tempo_sections(&hypotheses, &provisional, 1_000).unwrap();

        assert_eq!(
            result,
            vec![RefinedTempoSection {
                anchor_frame: 0,
                period_ms: (600_000.0_f64 / 1_455.0) as f32,
                generation: 4,
                band: 2,
            }]
        );
    }

    #[test]
    fn refinement_recomputes_the_preceding_section_after_merge() {
        let period_121 = (600_000.0_f64 / 1_210.0) as f32;
        let hypotheses = [
            hypothesis(0, 0x0103, 500.0),
            hypothesis(500, 0x0203, 500.0),
            hypothesis(1_000, 0x0303, period_121),
            hypothesis(1_100, 0x0403, period_121),
            hypothesis(1_200, 0x0503, period_121),
            hypothesis(1_300, 0x0603, period_121),
        ];
        let provisional = [
            ProvisionalTempoSection {
                anchor_frame: 0,
                period_ratio: 1.0,
                period_ms: 500.0,
                generation: 0x0103,
                band: 0,
            },
            ProvisionalTempoSection {
                anchor_frame: 1_000,
                period_ratio: 1.0,
                period_ms: period_121,
                generation: 0x0303,
                band: 1,
            },
        ];

        let result = refine_tempo_sections(&hypotheses, &provisional, 2_000).unwrap();

        assert_eq!(
            result,
            vec![RefinedTempoSection {
                anchor_frame: 0,
                period_ms: period_121,
                generation: 4,
                band: 0,
            }]
        );
    }

    #[test]
    fn phase_bounds_use_the_peak_before_each_section_anchor() {
        let hypotheses = [
            hypothesis(1_000, 0x0103, 500.0),
            hypothesis(2_000, 0x0203, 500.0),
            hypothesis(3_000, 0x0303, 500.0),
            hypothesis(4_000, 0x0403, 600.0),
            hypothesis(5_000, 0x0503, 600.0),
            hypothesis(6_000, 0x0603, 600.0),
            hypothesis(7_000, 0x0703, 400.0),
        ];
        let sections = [
            RefinedTempoSection {
                anchor_frame: 1_000,
                period_ms: 500.0,
                generation: 4,
                band: 0,
            },
            RefinedTempoSection {
                anchor_frame: 4_000,
                period_ms: 600.0,
                generation: 4,
                band: 0,
            },
            RefinedTempoSection {
                anchor_frame: 7_000,
                period_ms: 400.0,
                generation: 4,
                band: 0,
            },
        ];

        assert_eq!(
            linked_section_search_bounds(&hypotheses, &sections, 0, 62, 8_000),
            (0.0, 3_062.0)
        );
        assert_eq!(
            linked_section_search_bounds(&hypotheses, &sections, 1, 75, 8_000),
            (3_075.0, 6_075.0)
        );
        assert_eq!(
            linked_section_search_bounds(&hypotheses, &sections, 2, 50, 8_000),
            (6_050.0, 8_000.0)
        );
    }

    #[test]
    fn phase_adjustment_snaps_a_steady_four_beat_pulse() {
        let hypotheses = [
            hypothesis(100, 0x0103, 500.0),
            hypothesis(600, 0x0203, 500.0),
            hypothesis(1_100, 0x0303, 500.0),
            hypothesis(1_600, 0x0403, 500.0),
            hypothesis(2_100, 0x0503, 500.0),
        ];
        let sections = [RefinedTempoSection {
            anchor_frame: 100,
            period_ms: 500.0,
            generation: 4,
            band: 0,
        }];

        let result = adjust_tempo_section_phases(&hypotheses, &sections, 1_000, 2_600).unwrap();

        assert_eq!(
            result,
            vec![AdjustedTempoSection {
                origin_frame: 100,
                period_ms: 500.0,
                pulse_marker: 16,
                period_offset: 0,
            }]
        );
    }

    #[test]
    fn linked_decoder_matches_rafael_end_to_end() {
        const FRAMES: &[u64] = &[
            2_900_088, 2_991_072, 3_544_904, 3_579_072, 3_623_224, 3_651_760, 3_680_072, 3_714_000,
            4_107_096, 4_131_280, 4_172_072, 4_190_904, 4_204_472, 4_215_560, 4_277_280, 4_314_416,
            13_059_576, 13_084_600, 13_122_016, 13_159_744, 14_431_728, 14_448_184, 14_463_976,
            14_495_432, 14_511_792, 14_528_080, 14_543_776, 14_551_184, 14_560_056, 14_575_464,
            14_592_504, 14_598_216, 14_624_296, 14_640_192, 14_656_168, 14_687_448, 14_720_304,
            14_736_096, 14_752_120, 14_754_304, 14_784_048, 14_815_664, 14_818_064, 14_832_128,
            14_848_552, 14_880_560, 14_943_736, 15_344_712, 15_376_608, 15_407_520, 16_421_696,
            16_485_288, 16_516_976, 16_549_072, 16_579_808, 18_929_064, 18_961_144, 18_993_184,
            19_025_392, 19_027_632, 19_043_856, 19_056_464, 19_059_312, 19_089_472, 19_121_432,
            19_153_456, 19_170_368, 19_185_464, 19_217_760, 19_234_056, 19_249_792, 19_251_888,
            19_281_640, 19_284_184, 19_314_120, 19_345_720, 19_348_544, 19_378_176, 19_380_192,
            19_394_368, 19_410_336, 19_412_472, 19_450_456, 19_474_256, 19_506_936, 19_522_808,
            19_539_120, 19_554_992, 19_577_640, 19_587_008, 19_605_632, 19_625_184, 19_640_992,
            19_651_552, 19_667_280, 19_672_792, 19_683_272, 19_688_904, 19_699_480, 19_715_944,
            19_739_328, 19_763_464, 19_779_048, 19_795_760, 19_811_456, 19_827_432, 19_843_856,
            19_859_584, 19_875_816, 19_892_112, 19_907_736, 19_923_664, 19_954_968, 19_987_752,
            20_019_912, 20_052_872, 20_068_464, 20_084_432, 20_099_656, 20_115_528, 20_148_248,
            20_182_120, 20_196_416, 20_212_016, 20_214_216, 20_244_048, 20_268_904, 20_276_160,
            20_278_448, 20_292_760, 20_308_280, 20_310_904, 20_324_344, 20_339_920, 20_342_520,
            20_372_400, 20_374_664, 20_388_696, 20_404_536, 20_406_688, 20_436_592, 20_501_328,
            20_533_296, 20_564_832, 20_581_184, 20_597_688, 20_629_208, 20_660_864, 20_668_032,
            20_701_288, 20_725_992, 20_757_864, 20_773_624, 20_789_760, 20_821_352, 20_853_816,
            20_885_216, 20_887_848, 20_901_336, 20_918_112, 20_950_232, 21_013_968, 21_029_712,
            21_046_368, 21_077_656, 21_081_216, 21_110_096, 21_126_376, 21_142_448, 21_158_616,
            21_174_152, 21_206_400, 21_239_008, 21_270_552, 21_272_616, 21_302_248, 21_304_688,
            21_334_736, 21_337_208, 21_366_272, 21_398_784, 21_431_280,
        ];
        const BANDS: &[u8] = &[
            1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 2, 2, 0, 2, 2, 2, 0, 0, 0, 0, 3, 3, 3, 3, 3, 3, 3, 0, 3,
            5, 3, 0, 3, 3, 3, 3, 3, 3, 3, 0, 3, 3, 0, 3, 3, 3, 0, 1, 1, 1, 0, 0, 0, 0, 1, 5, 5, 5,
            5, 2, 2, 5, 2, 5, 5, 5, 5, 3, 3, 5, 5, 0, 5, 0, 3, 5, 0, 3, 0, 3, 3, 0, 5, 3, 3, 3, 3,
            3, 0, 3, 0, 0, 0, 3, 3, 0, 3, 0, 3, 3, 3, 3, 5, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 5, 3, 3,
            3, 3, 3, 3, 3, 0, 5, 3, 0, 3, 3, 5, 0, 5, 5, 0, 3, 5, 0, 5, 0, 3, 5, 0, 5, 5, 5, 5, 5,
            5, 5, 5, 1, 5, 5, 5, 5, 5, 5, 1, 3, 0, 3, 1, 1, 3, 5, 3, 3, 1, 3, 3, 3, 3, 3, 3, 3, 3,
            0, 3, 0, 3, 0, 3, 3, 1,
        ];
        assert_eq!(FRAMES.len(), BANDS.len());
        let hypotheses = FRAMES
            .iter()
            .zip(BANDS)
            .enumerate()
            .map(|(index, (&frame, &band))| BeatSensorHypothesis {
                band,
                ..hypothesis(frame, index as u32, 500.0)
            })
            .collect::<Vec<_>>();
        let sections = [
            RefinedTempoSection {
                anchor_frame: 2_900_088,
                period_ms: 514.5798,
                generation: 4,
                band: 0,
            },
            RefinedTempoSection {
                anchor_frame: 4_107_096,
                period_ms: 552.4862,
                generation: 4,
                band: 0,
            },
            RefinedTempoSection {
                anchor_frame: 14_431_728,
                period_ms: 363.85687,
                generation: 4,
                band: 0,
            },
        ];

        let result =
            adjust_tempo_section_phases(&hypotheses, &sections, 44_100, 21_554_175).unwrap();

        assert_eq!(
            result,
            vec![
                AdjustedTempoSection {
                    origin_frame: 6_677,
                    period_ms: 512.5798,
                    pulse_marker: 16,
                    period_offset: 128,
                },
                AdjustedTempoSection {
                    origin_frame: 3_717_967,
                    period_ms: 551.4862,
                    pulse_marker: 16,
                    period_offset: 16,
                },
                AdjustedTempoSection {
                    origin_frame: 13_171_054,
                    period_ms: 361.85687,
                    pulse_marker: 8,
                    period_offset: 79,
                },
            ]
        );

        let expanded = expand_tempo_sections(&hypotheses, &result, 44_100, 21_554_175).unwrap();
        assert_eq!(expanded.len(), 1_079);
        assert_eq!(
            expanded
                .iter()
                .enumerate()
                .filter_map(|(index, beat)| beat.section_anchor.then_some(index))
                .collect::<Vec<_>>(),
            [128, 181, 633]
        );
        assert_eq!(expanded_grid_digest(&expanded), 0x66c9_4343_64c4_d2fc);

        let finalized = finalize_expanded_beats(expanded, 21_554_175, 4).unwrap();
        assert_eq!(finalized.len(), 1_077);
        assert_eq!(
            finalized
                .iter()
                .enumerate()
                .filter_map(|(index, beat)| beat.section_anchor.then_some(index))
                .collect::<Vec<_>>(),
            [128, 180, 631]
        );
        assert_eq!(expanded_grid_digest(&finalized), 0xf47f_cf7c_2a59_be3d);
        assert_eq!(finalized_grid_digest(&finalized), 0x0dd7_92b8_0c76_b534);
    }

    #[test]
    fn gap_correction_removes_the_linked_rafael_transition_duplicate() {
        let mut beats = [3_690_316, 3_712_926, 3_716_663, 3_741_010]
            .map(expanded_beat)
            .to_vec();

        correct_expanded_beat_gaps(&mut beats);

        assert_eq!(
            beats
                .iter()
                .map(|beat| beat.position_frame)
                .collect::<Vec<_>>(),
            [3_690_316, 3_715_663, 3_741_010]
        );
    }

    #[test]
    fn gap_correction_snaps_then_removes_a_short_transition() {
        let mut beats = [13_132_061, 13_156_511, 13_170_515, 13_186_478, 13_202_441]
            .map(expanded_beat)
            .to_vec();

        correct_expanded_beat_gaps(&mut beats);

        assert_eq!(
            beats
                .iter()
                .map(|beat| beat.position_frame)
                .collect::<Vec<_>>(),
            [13_132_061, 13_156_511, 13_180_961, 13_202_441]
        );
    }

    #[test]
    fn gap_correction_preserves_the_native_insert_iterator_order() {
        let mut beats = [0, 200, 900, 1_000].map(expanded_beat).to_vec();

        correct_expanded_beat_gaps(&mut beats);

        assert_eq!(
            beats
                .iter()
                .map(|beat| beat.position_frame)
                .collect::<Vec<_>>(),
            [0, 250, 750, 1_000]
        );
    }

    fn expanded_grid_digest(beats: &[ExpandedBeat]) -> u64 {
        let mut digest = 0xcbf2_9ce4_8422_2325_u64;
        for beat in beats {
            for byte in beat.position_frame.to_le_bytes() {
                digest = (digest ^ u64::from(byte)).wrapping_mul(0x100_0000_01b3);
            }
            for byte in beat.period_ms.to_bits().to_le_bytes() {
                digest = (digest ^ u64::from(byte)).wrapping_mul(0x100_0000_01b3);
            }
            digest = (digest ^ u64::from(beat.source_band.unwrap_or(u8::MAX)))
                .wrapping_mul(0x100_0000_01b3);
            digest = (digest ^ u64::from(beat.section_anchor)).wrapping_mul(0x100_0000_01b3);
        }
        digest
    }

    fn finalized_grid_digest(beats: &[ExpandedBeat]) -> u64 {
        let mut digest = 0xcbf2_9ce4_8422_2325_u64;
        for beat in beats {
            for byte in beat.position_frame.to_le_bytes() {
                digest = (digest ^ u64::from(byte)).wrapping_mul(0x100_0000_01b3);
            }
            for byte in beat.period_ms.to_bits().to_le_bytes() {
                digest = (digest ^ u64::from(byte)).wrapping_mul(0x100_0000_01b3);
            }
            digest = (digest ^ u64::from(beat.source_band.unwrap_or(u8::MAX)))
                .wrapping_mul(0x100_0000_01b3);
            digest = (digest ^ u64::from(beat.beat_number)).wrapping_mul(0x100_0000_01b3);
            digest = (digest ^ u64::from(beat.section_anchor)).wrapping_mul(0x100_0000_01b3);
        }
        digest
    }
}
