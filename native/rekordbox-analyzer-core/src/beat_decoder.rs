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
        let continues_previous = metrical_period_compatible(
            selected_period,
            previous_window_period,
            period_tolerance(previous_window_period),
        );
        previous_window_period = selected_period;
        if continues_previous {
            source_index += 1;
            continue;
        }

        let selected_tolerance = period_tolerance(selected_period);
        let anchor_index = (source_index..histogram_end)
            .find(|&index| {
                metrical_period_compatible(
                    hypotheses[index].period_ms,
                    selected_period,
                    selected_tolerance,
                )
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
            && metrical_period_compatible(
                sections[section_index].period_ms,
                sections[section_index - 1].period_ms,
                period_tolerance(sections[section_index - 1].period_ms),
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

fn metrical_period_compatible(left: f32, right: f32, tolerance: f32) -> bool {
    (left - right).abs() <= tolerance
        || (left - right * 2.0).abs() <= tolerance
        || (left - right * 0.5).abs() <= tolerance
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
}
