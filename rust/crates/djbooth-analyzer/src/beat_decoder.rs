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
/// retain ties. Section bounds enforce the upstream one-eighth-beat survivor
/// guard before applying the matching one-eighth-beat boundary offset.
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
            // The native loop is unrolled four quarter-steps at a time and
            // tests the section boundary only after the whole beat. Preserve
            // that first block endpoint beyond the boundary: short-section
            // fitting uses its rounded step count and corrected position.
            for _ in 0..QUARTER_STEPS_PER_BEAT {
                step += 1;
                prediction += quarter_period;
                let mut band = None;
                if step.is_multiple_of(pulse_steps)
                    && let Some((source_index, source_position)) = find_nearest_hypothesis(
                        hypotheses,
                        prediction.trunc() as i32,
                        tolerance_frames,
                    )
                {
                    prediction = f64::from(source_position);
                    band = Some(hypotheses[source_index].band);
                }
                predicted_positions.push(prediction);
                predicted_bands.push(band);
            }
        }

        let available_steps = predicted_positions.len() - 1;
        if available_steps < QUARTER_STEPS_PER_BEAT {
            continue;
        }
        let fit_step = available_steps.min(WINDOW_STEPS);
        let corrected_right = corrected_prediction(
            predicted_positions[fit_step],
            predicted_bands[fit_step],
            correction_scale,
        );
        let first_fit = if fit_step == WINDOW_STEPS {
            (corrected_right - corrected_anchor) / WINDOW_BEATS as f64
        } else {
            (corrected_right - corrected_anchor) * QUARTER_STEPS_PER_BEAT as f64 / fit_step as f64
        };
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
    let eighth_period = u64::try_from(eighth_period).unwrap_or(0);
    let predecessor_limit = anchor_frame.saturating_sub(eighth_period);
    let predecessor_end =
        hypotheses.partition_point(|hypothesis| hypothesis.peak_frame <= predecessor_limit);
    let candidate = if predecessor_end == 0 {
        hypotheses[0].peak_frame.saturating_sub(eighth_period)
    } else {
        hypotheses[predecessor_end - 1]
            .peak_frame
            .saturating_add(eighth_period)
    };
    candidate.max(preceding_anchor).min(anchor_frame)
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
