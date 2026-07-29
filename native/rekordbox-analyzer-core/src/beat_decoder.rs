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
}
