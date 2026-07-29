//! Complete linked-analyzer rhythm orchestration.

use std::borrow::Cow;

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

use crate::beat_decoder::{
    AdjustedTempoSection, ExpandedBeat, ProvisionalTempoSection, RefinedTempoSection,
    adjust_tempo_section_phases, build_provisional_tempo_sections, expand_tempo_sections,
    finalize_expanded_beats, prune_discontinuous_hypotheses, prune_short_hypothesis_runs,
    refine_tempo_sections, suppress_nearby_hypotheses,
};
use crate::beat_sensor::{BeatSensorAnalysis, BeatSensorHypothesis, analyze_beat_sensor_events};
use crate::sample_rate_converter::{
    AnalysisSampleRateConverter, analysis_sample_rate, quantize_analysis_pcm,
};
use crate::unit_envelope::{
    UnitEnvelopeAdjustment, UnitEnvelopeFeature, apply_unit_envelope_adjustment,
    extract_unit_envelope_feature, score_unit_envelope_feature,
};
use crate::{anlz::BeatGridEntry, rhythm::BeatAnalysis};

/// Complete trace of the linked analyzer's variable-tempo rhythm path.
///
/// Intermediate stages remain available for differential testing. `beats`
/// contains the repaired, bar-numbered, track-bounded final grid.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedRhythmAnalysis {
    /// Source PCM sample rate.
    pub sample_rate: u32,
    /// Number of mono source frames analyzed.
    pub total_frames: u64,
    /// Effective bar meter. The linked finalizer clamps values below four.
    pub meter: u8,
    /// Full causal front-end trace.
    pub beat_sensor: BeatSensorAnalysis,
    /// Hypotheses after callback-generation continuity pruning.
    pub continuous_hypotheses: Vec<BeatSensorHypothesis>,
    /// Hypotheses after short position-run pruning.
    pub short_run_hypotheses: Vec<BeatSensorHypothesis>,
    /// Integer-BPM tempo sections.
    pub provisional_sections: Vec<ProvisionalTempoSection>,
    /// Tempo sections refined at 0.1 BPM.
    pub refined_sections: Vec<RefinedTempoSection>,
    /// Hypotheses after one-eighth-beat proximity suppression.
    pub suppressed_hypotheses: Vec<BeatSensorHypothesis>,
    /// Sections after pulse, period, and phase selection.
    pub adjusted_sections: Vec<AdjustedTempoSection>,
    /// Rolling-fit beat grid before gap repair, numbering, and track trim.
    pub expanded_beats: Vec<ExpandedBeat>,
    /// Final repaired, numbered, track-bounded beat grid.
    pub beats: Vec<ExpandedBeat>,
}

/// Analyze normalized mono PCM through the complete linked rhythm path.
///
/// The PCM length is authoritative at native 44.1/48 kHz rates. Other source
/// rates follow the analysis reader's rate-family selection, polyphase
/// conversion, and signed-16-bit quantization.
pub fn analyze_linked_rhythm(
    samples: &[f32],
    sample_rate: u32,
    meter: u8,
) -> Result<LinkedRhythmAnalysis> {
    analyze_linked_rhythm_impl(samples, sample_rate, meter, None)
}

/// Analyze PCM using the frame length advertised by Rekordbox's file reader.
///
/// `reader_padding_frames` is source-rate zero padding derived from the
/// container. FLAC uses its STREAMINFO maximum block size; other formats use
/// zero. The reader's final advertised target frame is excluded.
pub fn analyze_linked_rhythm_with_reader_padding(
    samples: &[f32],
    sample_rate: u32,
    meter: u8,
    reader_padding_frames: usize,
) -> Result<LinkedRhythmAnalysis> {
    analyze_linked_rhythm_impl(samples, sample_rate, meter, Some(reader_padding_frames))
}

fn analyze_linked_rhythm_impl(
    samples: &[f32],
    sample_rate: u32,
    meter: u8,
    reader_padding_frames: Option<usize>,
) -> Result<LinkedRhythmAnalysis> {
    let (samples, target_rate) =
        prepare_linked_samples(samples, sample_rate, reader_padding_frames)?;
    let (beat_sensor, unit_envelope) = rayon::join(
        || analyze_beat_sensor_events(&samples, target_rate),
        || extract_unit_envelope_feature(&samples, target_rate),
    );
    let mut analysis = decode_linked_rhythm(beat_sensor?, meter)?;
    apply_unit_envelope_phase(&mut analysis, &unit_envelope?)?;
    Ok(analysis)
}

pub(crate) fn analyze_linked_rhythm_without_unit_envelope_with_reader_padding(
    samples: &[f32],
    sample_rate: u32,
    meter: u8,
    reader_padding_frames: usize,
) -> Result<LinkedRhythmAnalysis> {
    let (samples, target_rate) =
        prepare_linked_samples(samples, sample_rate, Some(reader_padding_frames))?;
    decode_linked_rhythm(analyze_beat_sensor_events(&samples, target_rate)?, meter)
}

pub(crate) fn apply_linked_unit_envelope_with_reader_padding(
    analysis: &mut LinkedRhythmAnalysis,
    samples: &[f32],
    sample_rate: u32,
    reader_padding_frames: usize,
) -> Result<()> {
    let (samples, target_rate) =
        prepare_linked_samples(samples, sample_rate, Some(reader_padding_frames))?;
    if target_rate != analysis.sample_rate {
        bail!("linked unit-envelope sample rate does not match the rhythm analysis");
    }
    let feature = extract_unit_envelope_feature(&samples, target_rate)?;
    apply_unit_envelope_phase(analysis, &feature)
}

fn prepare_linked_samples<'a>(
    samples: &'a [f32],
    sample_rate: u32,
    reader_padding_frames: Option<usize>,
) -> Result<(Cow<'a, [f32]>, u32)> {
    let target_rate = analysis_sample_rate(sample_rate)?;
    if target_rate == sample_rate && reader_padding_frames.is_none() {
        return Ok((Cow::Borrowed(samples), target_rate));
    }
    let converter = AnalysisSampleRateConverter::new(sample_rate, target_rate)?;
    let mut prepared = match reader_padding_frames {
        Some(padding) => converter.resample_mono_for_reader(samples, padding)?,
        None => converter.resample_mono(samples)?,
    };
    if target_rate != sample_rate {
        prepared
            .iter_mut()
            .for_each(|sample| *sample = quantize_analysis_pcm(*sample));
    }
    Ok((Cow::Owned(prepared), target_rate))
}

/// Analyze source-rate mono PCM into the production beat-analysis contract.
///
/// The returned global BPM is the longest refined section's BPM, quantized to
/// hundredths like the linked `getBpm` ABI. Each PQTZ BPM is independently
/// derived from its expanded beat period. PQTZ milliseconds and paired PQT2
/// residuals split a floor-microsecond source-frame timestamp.
pub fn analyze_linked_beats(samples: &[f32], sample_rate: u32) -> Result<BeatAnalysis> {
    let analysis = analyze_linked_rhythm(samples, sample_rate, 4)?;
    linked_beat_analysis(&analysis)
}

/// Analyze source-rate PCM using its container-derived reader padding.
pub fn analyze_linked_beats_with_reader_padding(
    samples: &[f32],
    sample_rate: u32,
    reader_padding_frames: usize,
) -> Result<BeatAnalysis> {
    let analysis =
        analyze_linked_rhythm_with_reader_padding(samples, sample_rate, 4, reader_padding_frames)?;
    linked_beat_analysis(&analysis)
}

/// Decode an existing beat-sensor trace through the linked tempo pipeline.
///
/// Stage order matches the recovered native path: discontinuity pruning,
/// short-run pruning, provisional construction, refinement, nearby
/// suppression, phase adjustment, expansion, then finalization. Sample rate
/// and total frames come from `beat_sensor`, preventing inconsistent metadata.
pub fn decode_linked_rhythm(
    beat_sensor: BeatSensorAnalysis,
    meter: u8,
) -> Result<LinkedRhythmAnalysis> {
    let sample_rate = beat_sensor.sample_rate;
    if sample_rate == 0 {
        bail!("linked rhythm decoding requires a non-zero sample rate");
    }
    let total_frames = u64::try_from(beat_sensor.source_frames)
        .map_err(|_| anyhow::anyhow!("linked rhythm source length exceeds the u64 frame range"))?;
    if total_frames > i32::MAX as u64 {
        bail!("linked rhythm decoding exceeds the linked frame range");
    }
    if beat_sensor
        .beat_hypotheses
        .iter()
        .any(|hypothesis| hypothesis.peak_frame > total_frames)
    {
        bail!("linked rhythm decoding has a hypothesis beyond the track");
    }

    let continuous_hypotheses = prune_discontinuous_hypotheses(&beat_sensor.beat_hypotheses)?;
    let short_run_hypotheses = prune_short_hypothesis_runs(&continuous_hypotheses)?;
    let provisional_sections =
        build_provisional_tempo_sections(&short_run_hypotheses, sample_rate)?;
    let refined_sections =
        refine_tempo_sections(&short_run_hypotheses, &provisional_sections, total_frames)?;
    let suppression_sections = refined_sections
        .iter()
        .copied()
        .map(RefinedTempoSection::tempo_section)
        .collect::<Vec<_>>();
    let suppressed_hypotheses = suppress_nearby_hypotheses(
        &short_run_hypotheses,
        &suppression_sections,
        sample_rate,
        total_frames,
    )?;
    let adjusted_sections = adjust_tempo_section_phases(
        &suppressed_hypotheses,
        &refined_sections,
        sample_rate,
        total_frames,
    )?;
    let expanded_beats = expand_tempo_sections(
        &suppressed_hypotheses,
        &adjusted_sections,
        sample_rate,
        total_frames,
    )?;
    let meter = meter.max(4);
    let beats = finalize_expanded_beats(expanded_beats.clone(), total_frames, meter)?;

    Ok(LinkedRhythmAnalysis {
        sample_rate,
        total_frames,
        meter,
        beat_sensor,
        continuous_hypotheses,
        short_run_hypotheses,
        provisional_sections,
        refined_sections,
        suppressed_hypotheses,
        adjusted_sections,
        expanded_beats,
        beats,
    })
}

fn apply_unit_envelope_phase(
    analysis: &mut LinkedRhythmAnalysis,
    feature: &UnitEnvelopeFeature,
) -> Result<()> {
    if analysis.beats.len() < 2 {
        return Ok(());
    }
    let scoring = score_unit_envelope_feature(feature, &analysis.beats)?;
    let Some(phase) = scoring.phase else {
        return Ok(());
    };
    apply_unit_envelope_adjustment(
        &mut analysis.beats,
        analysis.sample_rate,
        analysis.total_frames,
        UnitEnvelopeAdjustment {
            first_beat_number: phase.first_beat_number,
            frame_offset: 0,
        },
    )?;
    Ok(())
}

pub(crate) fn linked_beat_analysis(analysis: &LinkedRhythmAnalysis) -> Result<BeatAnalysis> {
    if analysis.beats.len() < 4 {
        bail!("linked rhythm analysis produced too few beats");
    }
    let bpm = dominant_refined_bpm(&analysis.refined_sections, analysis.total_frames)?;
    let timed_beats = analysis
        .beats
        .iter()
        .map(|beat| {
            let position = u64::try_from(beat.position_frame)
                .map_err(|_| anyhow::anyhow!("linked rhythm retained a negative beat position"))?;
            let time_us = position * 1_000_000 / u64::from(analysis.sample_rate);
            let time_ms = u32::try_from(time_us / 1_000)
                .map_err(|_| anyhow::anyhow!("linked rhythm beat time exceeds the PQTZ range"))?;
            Ok((
                BeatGridEntry {
                    beat: u16::from(beat.beat_number),
                    bpm_hundredths: linked_bpm_hundredths(beat.period_ms)?,
                    time_ms,
                },
                (time_us % 1_000) as u16,
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    let (beats, beat_time_residuals_us) = timed_beats.into_iter().unzip();
    Ok(BeatAnalysis {
        bpm,
        // The linked ABI exposes no calibrated confidence value.
        confidence: 0.0,
        beats,
        beat_time_residuals_us,
    })
}

fn dominant_refined_bpm(sections: &[RefinedTempoSection], total_frames: u64) -> Result<f64> {
    let Some(first) = sections.first() else {
        bail!("linked rhythm analysis produced no refined tempo sections");
    };
    let mut dominant = first;
    let mut longest_span = sections
        .get(1)
        .map_or(total_frames, |next| next.anchor_frame)
        .saturating_sub(first.anchor_frame);
    for (index, section) in sections.iter().enumerate().skip(1) {
        let span = sections
            .get(index + 1)
            .map_or(total_frames, |next| next.anchor_frame)
            .saturating_sub(section.anchor_frame);
        if span > longest_span {
            dominant = section;
            longest_span = span;
        }
    }
    Ok(f64::from(linked_bpm_hundredths(dominant.period_ms)?) / 100.0)
}

fn linked_bpm_hundredths(period_ms: f32) -> Result<u16> {
    if !period_ms.is_finite() || period_ms <= 0.0 {
        bail!("linked rhythm BPM conversion requires a positive finite period");
    }
    Ok((6_000_000.0_f64 / f64::from(period_ms))
        .round()
        .clamp(1.0, f64::from(u16::MAX)) as u16)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn steady_sensor(total_frames: usize) -> BeatSensorAnalysis {
        let beat_hypotheses = (100_u64..total_frames as u64)
            .step_by(500)
            .enumerate()
            .map(|(index, peak_frame)| BeatSensorHypothesis {
                peak_frame,
                period_ratio: 1.0,
                period_ms: 500.0,
                generation: ((index as u32) << 8) | 3,
                band: 0,
            })
            .collect();
        BeatSensorAnalysis {
            sample_rate: 1_000,
            source_frames: total_frames,
            events: Vec::new(),
            candidates: Vec::new(),
            selected_candidates: Vec::new(),
            beat_hypotheses,
        }
    }

    #[test]
    fn silence_runs_the_complete_front_end() {
        let result = analyze_linked_rhythm(&[0.0; 64], 44_100, 2).unwrap();

        assert_eq!(result.sample_rate, 44_100);
        assert_eq!(result.total_frames, 64);
        assert_eq!(result.meter, 4);
        assert!(result.beat_sensor.events.is_empty());
        assert!(result.continuous_hypotheses.is_empty());
        assert!(result.short_run_hypotheses.is_empty());
        assert!(result.provisional_sections.is_empty());
        assert!(result.refined_sections.is_empty());
        assert!(result.suppressed_hypotheses.is_empty());
        assert!(result.adjusted_sections.is_empty());
        assert!(result.expanded_beats.is_empty());
        assert!(result.beats.is_empty());
    }

    #[test]
    fn steady_hypotheses_flow_through_every_decoder_stage() {
        let result = decode_linked_rhythm(steady_sensor(40_100), 4).unwrap();

        assert_eq!(result.continuous_hypotheses.len(), 80);
        assert_eq!(result.short_run_hypotheses.len(), 80);
        assert_eq!(result.provisional_sections.len(), 1);
        assert_eq!(result.refined_sections.len(), 1);
        assert_eq!(result.suppressed_hypotheses.len(), 80);
        assert_eq!(result.adjusted_sections.len(), 1);
        assert!(!result.expanded_beats.is_empty());
        assert!(!result.beats.is_empty());
        assert!(
            result
                .expanded_beats
                .iter()
                .all(|beat| beat.beat_number == 0)
        );
        assert!(
            result
                .beats
                .iter()
                .all(|beat| (1..=4).contains(&beat.beat_number))
        );
        assert!(
            result.beats.iter().all(|beat| beat.position_frame >= 0
                && beat.position_frame as u64 <= result.total_frames)
        );
    }

    #[test]
    fn nearby_suppression_feeds_phase_and_expansion() {
        let mut sensor = steady_sensor(40_100);
        let duplicate = BeatSensorHypothesis {
            peak_frame: 4_110,
            period_ratio: 1.0,
            period_ms: 500.0,
            generation: (80 << 8) | 9,
            band: 5,
        };
        let insertion = sensor
            .beat_hypotheses
            .partition_point(|hypothesis| hypothesis.peak_frame <= 4_100);
        sensor.beat_hypotheses.insert(insertion, duplicate);

        let result = decode_linked_rhythm(sensor, 4).unwrap();

        assert!(
            result
                .short_run_hypotheses
                .iter()
                .any(|hypothesis| hypothesis.peak_frame == 4_100)
        );
        assert!(
            !result
                .suppressed_hypotheses
                .iter()
                .any(|hypothesis| hypothesis.peak_frame == 4_100)
        );
        assert!(result.suppressed_hypotheses.contains(&duplicate));
        assert!(
            result
                .expanded_beats
                .iter()
                .any(|beat| beat.source_band == Some(5))
        );
    }

    #[test]
    fn precomputed_trace_rejects_hypotheses_beyond_track() {
        let mut sensor = steady_sensor(40_100);
        sensor.beat_hypotheses.push(BeatSensorHypothesis {
            peak_frame: 40_101,
            period_ratio: 1.0,
            period_ms: 500.0,
            generation: (80 << 8) | 3,
            band: 0,
        });

        let error = decode_linked_rhythm(sensor, 4).unwrap_err();

        assert_eq!(
            error.to_string(),
            "linked rhythm decoding has a hypothesis beyond the track"
        );
    }

    #[test]
    fn pqtz_conversion_floors_microseconds_and_rounds_local_bpm() {
        let periods = [512.5798, 512.5798, 512.5798, 361.85687];
        let positions = [6_662, 29_271, 51_880, 21_542_994];
        let beats = positions
            .into_iter()
            .zip(periods)
            .enumerate()
            .map(|(index, (position_frame, period_ms))| ExpandedBeat {
                position_frame,
                period_ms,
                source_band: None,
                section_anchor: index == 0,
                beat_number: (index + 1) as u8,
            })
            .collect::<Vec<_>>();
        let analysis = LinkedRhythmAnalysis {
            sample_rate: 44_100,
            total_frames: 21_554_175,
            meter: 4,
            beat_sensor: BeatSensorAnalysis {
                sample_rate: 44_100,
                source_frames: 21_554_175,
                events: Vec::new(),
                candidates: Vec::new(),
                selected_candidates: Vec::new(),
                beat_hypotheses: Vec::new(),
            },
            continuous_hypotheses: Vec::new(),
            short_run_hypotheses: Vec::new(),
            provisional_sections: Vec::new(),
            refined_sections: vec![
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
            ],
            suppressed_hypotheses: Vec::new(),
            adjusted_sections: Vec::new(),
            expanded_beats: beats.clone(),
            beats,
        };

        let result = linked_beat_analysis(&analysis).unwrap();

        assert_eq!(result.bpm, 108.60);
        assert_eq!(result.confidence, 0.0);
        assert_eq!(result.beats[0].time_ms, 151);
        assert_eq!(result.beat_time_residuals_us[0], 65);
        assert_eq!(result.beats[0].bpm_hundredths, 11_705);
        assert_eq!(result.beats[3].time_ms, 488_503);
        assert_eq!(result.beat_time_residuals_us[3], 265);
        assert_eq!(result.beats[3].bpm_hundredths, 16_581);
    }

    #[test]
    fn dominant_bpm_uses_longest_refined_span_and_retains_earlier_ties() {
        let sections = [
            RefinedTempoSection {
                anchor_frame: 100,
                period_ms: 500.0,
                generation: 4,
                band: 0,
            },
            RefinedTempoSection {
                anchor_frame: 1_100,
                period_ms: 400.0,
                generation: 4,
                band: 0,
            },
            RefinedTempoSection {
                anchor_frame: 2_100,
                period_ms: 600.0,
                generation: 4,
                band: 0,
            },
        ];

        assert_eq!(dominant_refined_bpm(&sections, 3_100).unwrap(), 120.0);
    }
}
