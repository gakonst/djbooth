use rekordbox_analyzer_core::{
    ExpandedBeat, UnitEnvelopeAdjustment, UnitEnvelopeNumbering, apply_unit_envelope_adjustment,
    extract_unit_envelope_feature, select_unit_envelope_phase,
};

#[derive(Clone, Copy)]
struct TraceCase {
    name: &'static str,
    sample_rate: u32,
    total_frames: u64,
    count: usize,
    first_positions: [i32; 4],
    first_period_ms: f32,
    raw_first_beat: u8,
    output_first_beat: u8,
    last_position: i32,
    last_period_ms: f32,
}

const TRACE_CASES: [TraceCase; 5] = [
    TraceCase {
        name: "science",
        sample_rate: 48_000,
        total_frames: 19_048_876,
        count: 839,
        first_positions: [22_624, 45_301, 67_979, 90_657],
        first_period_ms: 472.453_12,
        raw_first_beat: 1,
        output_first_beat: 2,
        last_position: 19_026_267,
        last_period_ms: 472.448_8,
    },
    TraceCase {
        name: "luv",
        sample_rate: 44_100,
        total_frames: 17_782_763,
        count: 840,
        first_positions: [1_587, 22_737, 43_886, 65_035],
        first_period_ms: 479.576_45,
        raw_first_beat: 1,
        output_first_beat: 2,
        last_position: 17_761_652,
        last_period_ms: 480.429_2,
    },
    TraceCase {
        name: "power",
        sample_rate: 48_000,
        total_frames: 15_598_860,
        count: 608,
        first_positions: [759, 20_551, 40_342, 60_134],
        first_period_ms: 412.322_9,
        raw_first_beat: 2,
        output_first_beat: 4,
        last_position: 15_593_717,
        last_period_ms: 553.036_74,
    },
    TraceCase {
        name: "rafael",
        sample_rate: 44_100,
        total_frames: 21_554_175,
        count: 1_077,
        first_positions: [6_662, 29_260, 51_858, 74_456],
        first_period_ms: 512.426_33,
        raw_first_beat: 1,
        output_first_beat: 1,
        last_position: 21_542_994,
        last_period_ms: 363.661_44,
    },
    TraceCase {
        name: "get-up",
        sample_rate: 44_100,
        total_frames: 6_268_059,
        count: 354,
        first_positions: [8_765, 26_345, 43_925, 61_505],
        first_period_ms: 398.633_8,
        raw_first_beat: 2,
        output_first_beat: 2,
        last_position: 6_251_976,
        last_period_ms: 400.284_94,
    },
];

#[test]
fn five_variable_traces_pin_label_rotation_and_zero_offset() {
    for case in TRACE_CASES {
        let mut beats = trace_beats(case);
        let positions = beats
            .iter()
            .map(|beat| beat.position_frame)
            .collect::<Vec<_>>();
        assert_eq!(beats[0].beat_number, case.raw_first_beat, "{}", case.name);

        let report = apply_unit_envelope_adjustment(
            &mut beats,
            case.sample_rate,
            case.total_frames,
            UnitEnvelopeAdjustment {
                first_beat_number: case.output_first_beat,
                frame_offset: 0,
            },
        )
        .unwrap();

        assert_eq!(beats.len(), case.count, "{}", case.name);
        assert_eq!(
            beats
                .iter()
                .map(|beat| beat.position_frame)
                .collect::<Vec<_>>(),
            positions,
            "{}",
            case.name
        );
        assert_eq!(
            beats[0].beat_number, case.output_first_beat,
            "{}",
            case.name
        );
        assert!(
            beats.iter().enumerate().all(|(index, beat)| {
                beat.beat_number
                    == ((usize::from(case.output_first_beat - 1) + index) % 4) as u8 + 1
            }),
            "{}",
            case.name
        );
        assert_eq!(report.adjusted_beats, case.count, "{}", case.name);
        assert!(!report.prepended, "{}", case.name);
        assert!(!report.appended, "{}", case.name);
        assert!(!report.removed_leading, "{}", case.name);
        assert!(!report.removed_trailing, "{}", case.name);
    }
}

#[test]
fn runtime_phase_scores_pin_four_native_winners() {
    let cases = [
        (
            "science",
            [94_422.0, 0.0, 0.0, 0.0],
            UnitEnvelopeNumbering::LeadingPartialBar,
            0,
            2,
        ),
        (
            "power",
            [10_813.44, 20_152.68, 3_476.0, 6_893.04],
            UnitEnvelopeNumbering::GridAligned,
            1,
            4,
        ),
        (
            "rafael",
            [22_854.0, 0.0, 0.0, 0.0],
            UnitEnvelopeNumbering::GridAligned,
            0,
            1,
        ),
        (
            "get-up",
            [0.0, 0.0, 0.0, 4_656.0],
            UnitEnvelopeNumbering::GridAligned,
            3,
            2,
        ),
    ];
    for (name, scores, numbering, score_index, first_beat_number) in cases {
        let phase = select_unit_envelope_phase(scores, numbering).unwrap();
        assert_eq!(phase.score_index, score_index, "{name}");
        assert_eq!(phase.first_beat_number, first_beat_number, "{name}");
    }
}

#[test]
fn phase_selection_keeps_the_earliest_tie_and_exposes_fallback() {
    let phase =
        select_unit_envelope_phase([4.0, 9.0, 9.0, 1.0], UnitEnvelopeNumbering::GridAligned)
            .unwrap();
    assert_eq!(phase.score_index, 1);
    assert!(select_unit_envelope_phase([0.0; 4], UnitEnvelopeNumbering::GridAligned).is_none());
}

#[test]
fn extraction_is_grid_independent_and_caps_high_sample_rates() {
    let feature = extract_unit_envelope_feature(&[0.0; 256], 96_000).unwrap();

    assert_eq!(feature.source_sample_rate(), 96_000);
    assert_eq!(feature.scoring_sample_rate(), 48_000);
    assert_eq!(feature.envelope_len(), 1);
    assert_eq!(feature.strong_peak_count(), 0);
}

#[test]
fn boundary_repair_mirrors_one_native_insert_or_remove() {
    let mut beats = vec![
        beat(600, 500.0, 1),
        beat(1_100, 500.0, 2),
        beat(1_600, 500.0, 3),
    ];
    let report = apply_unit_envelope_adjustment(
        &mut beats,
        1_000,
        2_300,
        UnitEnvelopeAdjustment {
            first_beat_number: 2,
            frame_offset: 100,
        },
    )
    .unwrap();
    assert!(report.prepended);
    assert!(report.appended);
    assert_eq!(
        beats
            .iter()
            .map(|entry| (entry.position_frame, entry.beat_number))
            .collect::<Vec<_>>(),
        [(200, 1), (700, 2), (1_200, 3), (1_700, 4), (2_200, 1)]
    );

    let mut beats = vec![beat(-20, 500.0, 1), beat(480, 500.0, 2)];
    let report = apply_unit_envelope_adjustment(
        &mut beats,
        1_000,
        450,
        UnitEnvelopeAdjustment {
            first_beat_number: 1,
            frame_offset: 0,
        },
    )
    .unwrap();
    assert!(report.removed_leading);
    assert!(report.removed_trailing);
    assert!(beats.is_empty());
}

fn trace_beats(case: TraceCase) -> Vec<ExpandedBeat> {
    let mut beats = Vec::with_capacity(case.count);
    for index in 0..case.count {
        let (position_frame, period_ms) = if index < case.first_positions.len() {
            (case.first_positions[index], case.first_period_ms)
        } else if index + 1 == case.count {
            (case.last_position, case.last_period_ms)
        } else {
            let start = i64::from(case.first_positions[3]);
            let end = i64::from(case.last_position);
            let offset = i64::try_from(index - 3).unwrap();
            let span = i64::try_from(case.count - 4).unwrap();
            (
                (start + (end - start) * offset / span) as i32,
                case.last_period_ms,
            )
        };
        beats.push(beat(
            position_frame,
            period_ms,
            ((usize::from(case.raw_first_beat - 1) + index) % 4) as u8 + 1,
        ));
    }
    beats
}

fn beat(position_frame: i32, period_ms: f32, beat_number: u8) -> ExpandedBeat {
    ExpandedBeat {
        position_frame,
        period_ms,
        source_band: None,
        section_anchor: false,
        beat_number,
    }
}
