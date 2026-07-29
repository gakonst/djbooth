#![cfg_attr(not(target_arch = "x86_64"), allow(dead_code, unused_imports))]

use std::ffi::c_void;
use std::path::Path;
use std::sync::atomic::{AtomicI32, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};

use anyhow::{Context, Result, bail};
use serde::Serialize;

use crate::rehost::{BeatEntry, BeatGridSummary};

const BA_CREATE_VARIED_48_OFFSET: usize = 0x14bc670;
const BA_CREATE_CONST_48_OFFSET: usize = 0x14bc700;
const BA_CREATE_VARIED_44_OFFSET: usize = 0x14bc790;
const BA_CREATE_CONST_44_OFFSET: usize = 0x14bc820;
const BA_SET_SAMPLE_OFFSET: usize = 0x14bc8d0;
const BA_GET_BPM_OFFSET: usize = 0x14bc8f0;
const BA_GET_BEAT_NUM_OFFSET: usize = 0x14bc910;
const BA_GET_BEAT_LIST_OFFSET: usize = 0x14bc940;
const UNIT_BEAT_ADJUST_ANALYZE_OFFSET: usize = 0x10fe2b0;
const BEAT_INFO_ANALYZE_OFFSET: usize = 0x138a960;
const BEAT_INFO_SEG_ADJUST_OFFSET: usize = 0x1390180;
const BEAT_INFO_GAP_CORRECT_OFFSET: usize = 0x13914f0;
const BEAT_INFO_GAP_CORRECT_RANGE_OFFSET: usize = 0x13918d0;
const BEAT_INFO_FIND_NEAR_POS_OFFSET: usize = 0x138a760;
const BEAT_SENSOR_CREATE_OFFSET: usize = 0x1389ba0;
const PEAK_SENSOR_PUT_OFFSET: usize = 0x14e7ac0;
const PEAK_BUFFER_CALC_BEAT_OFFSET: usize = 0x13894f0;
const LOUD_VIEW_ANALYZE_PEAK_OFFSET: usize = 0x148a270;
const LOUD_VIEW_PEAK_DETECT_OFFSET: usize = 0x148c4c0;
const LOUD_VIEW_PEAK_DETECT_900_OFFSET: usize = 0x148c7d0;
const BEAT_LIST_CHANGE_STAT_OFFSET: usize = 0x14e6910;
const BEAT_LIST_CHANGE_STAT_VTABLE_SLOT_OFFSET: usize = 0x40d7738;
const LOUD_VIEW_ANALYZE_PEAK_VTABLE_SLOT_OFFSET: usize = 0x40d3bf8;
const FWRITE_OFFSET: usize = 0x21dcd98;
const MALLOC_OFFSET: usize = 0x21dc954;
const EXP10_OFFSET: usize = 0x21dc9d2;

const CALL_BA_CREATE_VARIED_44_OFFSET: usize = 0x1068a51;
const CALL_BA_CREATE_CONST_44_OFFSET: usize = 0x1068a9a;
const CALL_BA_CREATE_VARIED_48_OFFSET: usize = 0x1068ad4;
const CALL_BA_CREATE_CONST_48_OFFSET: usize = 0x1068b0e;
const CALL_BA_SET_SAMPLE_OFFSET: usize = 0x106aa96;
const CALL_BA_GET_BPM_OFFSET: usize = 0x106c708;
const CALL_BA_GET_BEAT_NUM_OFFSET: usize = 0x106c71d;
const CALL_BA_GET_BEAT_LIST_OFFSET: usize = 0x106c75a;
const CALL_UNIT_BEAT_ADJUST_ANALYZE_OFFSET: usize = 0x14e66f8;
const CALL_BEAT_INFO_ANALYZE_OFFSET: usize = 0x14e6695;
const CALL_BEAT_INFO_SEG_ADJUST_OFFSET: usize = 0x138d406;
const CALL_BEAT_INFO_GAP_CORRECT_OFFSET: usize = 0x138f837;
const CALL_BEAT_INFO_GAP_CORRECT_RANGE_OFFSET: usize = 0x138f8f4;
const CALL_SEG_FIND_NEAR_POS_0_OFFSET: usize = 0x139071b;
const CALL_SEG_FIND_NEAR_POS_1_OFFSET: usize = 0x139092e;
const CALL_SEG_FIND_NEAR_POS_2_OFFSET: usize = 0x1390b3d;
const CALL_SEG_FIND_NEAR_POS_3_OFFSET: usize = 0x1390e31;
const CALL_SEG_FIND_NEAR_POS_4_OFFSET: usize = 0x139103e;
const CALL_SEG_FIND_NEAR_POS_5_OFFSET: usize = 0x13912b1;
const CALL_GRID_FIND_NEAR_POS_0_OFFSET: usize = 0x138d767;
const CALL_GRID_FIND_NEAR_POS_1_OFFSET: usize = 0x138d90a;
const CALL_GRID_FIND_NEAR_POS_2_OFFSET: usize = 0x138dc6e;
const CALL_GRID_FIND_NEAR_POS_3_OFFSET: usize = 0x138dd13;
const CALL_GRID_FIND_NEAR_POS_4_OFFSET: usize = 0x138dd5e;
const CALL_GRID_FIND_NEAR_POS_5_OFFSET: usize = 0x138de03;
const CALL_GRID_FIND_NEAR_POS_6_OFFSET: usize = 0x138de4e;
const CALL_GRID_FIND_NEAR_POS_7_OFFSET: usize = 0x138def7;
const CALL_GRID_FIND_NEAR_POS_8_OFFSET: usize = 0x138df4c;
const CALL_BEAT_SENSOR_CREATE_OFFSET: usize = 0x14e60ab;
const CALL_PEAK_SENSOR_PUT_OFFSET: usize = 0x14e78ec;
const CALL_PEAK_BUFFER_CALC_BEAT_OFFSET: usize = 0x14e797f;
const CALL_LOUD_VIEW_ANALYZE_PEAK_0_OFFSET: usize = 0x14e64b4;
const CALL_LOUD_VIEW_ANALYZE_PEAK_1_OFFSET: usize = 0x14e6527;
const CALL_LOUD_VIEW_PEAK_DETECT_0_OFFSET: usize = 0x148a93f;
const CALL_LOUD_VIEW_PEAK_DETECT_900_0_OFFSET: usize = 0x148a97d;
const CALL_LOUD_VIEW_PEAK_DETECT_1_OFFSET: usize = 0x148abab;
const CALL_LOUD_VIEW_PEAK_DETECT_900_1_OFFSET: usize = 0x148abe6;
const CALL_LOUD_VIEW_PEAK_DETECT_2_OFFSET: usize = 0x148ac27;
const CALL_CHECKPOINT_CONTINUOUS_REGION_OFFSET: usize = 0x138b51b;
const CALL_CHECKPOINT_MINIMUM_RUN_OFFSET: usize = 0x138b7d8;
const CALL_CHECKPOINT_TEMPO_FAMILY_OFFSET: usize = 0x138c5ff;
const CALL_REFINEMENT_EXP10_OFFSET: usize = 0x138ca54;
const CALL_CHECKPOINT_NEAR_VALUE_OFFSET: usize = 0x138d14d;
const ENGINE_SELECTION_BRANCH_OFFSET: usize = 0x1068a0c;

const INTERNAL_BEAT_BYTES: usize = 24;
const MAX_TRACE_BEATS: usize = 100_000;
const BEAT_SENSOR_OBJECT_BYTES: usize = 0x80;
const BEAT_SENSOR_FILTER_BYTES: usize = 0x30;
const IIR_FILTER_BYTES: usize = 0x58;
const BEAT_SENSOR_PEAK_BYTES: usize = 0xa0;
const BEAT_SENSOR_BAND_STATE_BYTES: usize = 0x50;
const MAX_TRACE_PEAK_EVENTS: usize = 200_000;
const MAX_TRACE_LOUD_PEAK_CALLS: usize = 20_000;
const MAX_TRACE_GRID_SNAP_PROBES: usize = 65_536;
const ENV_TRACE_ENGINE: &str = "REKORDBOX_ANALYZER_TRACE_ENGINE";
const ENV_TRACE_ANALYZER_STAGES: &str = "REKORDBOX_ANALYZER_TRACE_STAGES";

type BaCreate = unsafe extern "C" fn(i32, i32, u8, u8, u8) -> *mut c_void;
type BaSetSample = unsafe extern "C" fn(*mut c_void, *mut f32, *mut f32, i32);
type BaGetBpm = unsafe extern "C" fn(*mut c_void) -> i32;
type BaGetBeatNum = unsafe extern "C" fn(*mut c_void) -> i32;
type BaGetBeatList = unsafe extern "C" fn(*mut c_void, *mut BaBeatInfo);
type UnitBeatAdjustAnalyze = unsafe extern "C" fn(*mut c_void, *mut f32, *mut StdVector);
type BeatInfoAnalyze = unsafe extern "C" fn(
    *mut c_void,
    *mut BeatInfoAnalyzeInfo,
    *mut StdVector,
    i32,
    i32,
    i32,
    i32,
    u32,
) -> f32;
type BeatInfoSegAdjust =
    unsafe extern "C" fn(*mut c_void, *mut BeatInfoAnalyzeInfo, *mut StdVector, i32);
type BeatInfoGapCorrect = unsafe extern "C" fn(*mut c_void, *mut StdVector, i32);
type BeatInfoGapCorrectRange = unsafe extern "C" fn(*mut c_void, *mut StdVector, i32, i32, i32);
type BeatInfoFindNearPos =
    unsafe extern "C" fn(*mut c_void, *mut StdVector, i32, i32, *mut i32) -> i32;
type BeatSensorCreate = unsafe extern "C" fn(*mut c_void, i32, i32, i32, i32, i32) -> u64;
type PeakSensorPut = unsafe extern "C" fn(*mut c_void, f32) -> u8;
type PeakBufferCalcBeat = unsafe extern "C" fn(*mut c_void, f32) -> u8;
type LoudViewAnalyzePeak =
    unsafe extern "C" fn(*mut c_void, *mut f32, *mut f32, *mut f32, *mut f32, i32) -> u64;
type LoudViewPeakDetect = unsafe extern "C" fn(
    *mut c_void,
    *const f32,
    *mut LoudViewPeakEvent,
    *mut i64,
    *mut i32,
    *mut i64,
    i32,
    i64,
    *mut i32,
    *mut i32,
    *mut i64,
) -> i64;
type LoudViewPeakDetect900 = unsafe extern "C" fn(
    *mut c_void,
    *const f32,
    *mut LoudViewPeakEvent,
    *mut i64,
    *mut i32,
    *mut i64,
    i32,
    i64,
    *mut i32,
) -> i64;
type BeatListChangeStat = unsafe extern "C" fn(*mut c_void, f32, i32, f32, *mut c_void);
type AllocateBytes = unsafe extern "C" fn(usize) -> *mut c_void;
type Exp10 = unsafe extern "C" fn(f64) -> f64;

static BA_CREATE_VARIED_48: AtomicUsize = AtomicUsize::new(0);
static BA_CREATE_CONST_48: AtomicUsize = AtomicUsize::new(0);
static BA_CREATE_VARIED_44: AtomicUsize = AtomicUsize::new(0);
static BA_CREATE_CONST_44: AtomicUsize = AtomicUsize::new(0);
static BA_SET_SAMPLE: AtomicUsize = AtomicUsize::new(0);
static BA_GET_BPM: AtomicUsize = AtomicUsize::new(0);
static BA_GET_BEAT_NUM: AtomicUsize = AtomicUsize::new(0);
static BA_GET_BEAT_LIST: AtomicUsize = AtomicUsize::new(0);
static UNIT_BEAT_ADJUST_ANALYZE: AtomicUsize = AtomicUsize::new(0);
static BEAT_INFO_ANALYZE: AtomicUsize = AtomicUsize::new(0);
static BEAT_INFO_SEG_ADJUST: AtomicUsize = AtomicUsize::new(0);
static BEAT_INFO_GAP_CORRECT: AtomicUsize = AtomicUsize::new(0);
static BEAT_INFO_GAP_CORRECT_RANGE: AtomicUsize = AtomicUsize::new(0);
static BEAT_INFO_FIND_NEAR_POS: AtomicUsize = AtomicUsize::new(0);
static BEAT_SENSOR_CREATE: AtomicUsize = AtomicUsize::new(0);
static PEAK_SENSOR_PUT: AtomicUsize = AtomicUsize::new(0);
static PEAK_BUFFER_CALC_BEAT: AtomicUsize = AtomicUsize::new(0);
static LOUD_VIEW_ANALYZE_PEAK: AtomicUsize = AtomicUsize::new(0);
static LOUD_VIEW_PEAK_DETECT: AtomicUsize = AtomicUsize::new(0);
static LOUD_VIEW_PEAK_DETECT_900: AtomicUsize = AtomicUsize::new(0);
static BEAT_LIST_CHANGE_STAT: AtomicUsize = AtomicUsize::new(0);
static PEAK_SENSOR_BASE: AtomicUsize = AtomicUsize::new(0);
static PEAK_BUFFER_BASE: AtomicUsize = AtomicUsize::new(0);
static PEAK_SENSOR_BAND_COUNT: AtomicI32 = AtomicI32::new(0);
static CURRENT_BEAT_INFO: AtomicUsize = AtomicUsize::new(0);
static MALLOC: AtomicUsize = AtomicUsize::new(0);
static EXP10: AtomicUsize = AtomicUsize::new(0);
static LAST_BEAT_COUNT: AtomicI32 = AtomicI32::new(0);
static TRACE: OnceLock<Mutex<ReferenceTrace>> = OnceLock::new();

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReferenceTrace {
    schema_version: u32,
    requested_engine: String,
    engine_creates: Vec<EngineCreateTrace>,
    beat_sensor_creates: Vec<BeatSensorCreateTrace>,
    peak_sensor_events: Vec<PeakSensorEventTrace>,
    peak_buffer_calculations: Vec<PeakBufferCalculationTrace>,
    loud_view_calls: Vec<LoudViewCallTrace>,
    loud_view_peak_calls: Vec<LoudViewPeakCallTrace>,
    loud_view_final: Option<LoudViewSnapshotTrace>,
    beat_list_changes: Vec<BeatListChangeTrace>,
    analyzer_checkpoints: Vec<AnalyzerCheckpointTrace>,
    section_checkpoints: Vec<SectionCheckpointTrace>,
    refinement_checkpoints: Vec<RefinementCheckpointTrace>,
    phase_probe_blocks: Vec<PhaseProbeBlockTrace>,
    #[serde(skip)]
    phase_probe_accumulator: Option<PhaseProbeAccumulator>,
    grid_snap_probes: Vec<GridSnapProbeTrace>,
    streamed_frames: u64,
    beat_info_analyzes: Vec<BeatInfoAnalyzeTrace>,
    segment_adjustments: Vec<BeatStageTrace>,
    gap_corrections: Vec<BeatStageTrace>,
    unit_adjustments: Vec<UnitAdjustmentTrace>,
    ba_bpm_raw: Option<i32>,
    ba_beat_count: Option<i32>,
    ba_beats: Vec<BaBeatTrace>,
    final_beat_grid: Option<BeatGridSummary>,
    final_beats: Vec<BeatEntry>,
    stage_parity: Option<StageParityTrace>,
    warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineCreateTrace {
    sample_rate: u32,
    variable_tempo: bool,
    arg1: i32,
    arg2: i32,
    arg3: u8,
    arg4: u8,
    arg5: u8,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BeatSensorCreateTrace {
    sample_rate: i32,
    arg2: i32,
    total_frames: i32,
    aggregate_frames: i32,
    band_count: i32,
    result: u64,
    object_words: Vec<u32>,
    filter_words: Vec<u32>,
    filter_stage_words: Vec<Vec<u32>>,
    peak_sensor_words: Vec<u32>,
    band_state_words: Vec<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PeakSensorEventTrace {
    band: i32,
    input: f32,
    state_before: Vec<u32>,
    state_after: Vec<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PeakBufferCalculationTrace {
    band: i32,
    interval_ms: f32,
    accepted: bool,
    state_after: Vec<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoudViewCallTrace {
    sample_count: i32,
    input_peak: f32,
    low_provided: bool,
    low_input_peak: f32,
    mid_provided: bool,
    mid_input_peak: f32,
    high_provided: bool,
    high_input_peak: f32,
    result: u64,
    processed_frames: i64,
    raw_batch_emitted: i64,
    raw_batch_value: f32,
    raw_batch_sum: f32,
    raw_batch_frames: i32,
    raw_batch_pending: i32,
    raw_output_index: i32,
    loud_ready: i32,
    loud_emitted: i32,
    dots_ready: i32,
    dots_emitted: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoudViewPeakCallTrace {
    stage: u8,
    detector_900: bool,
    band: i32,
    sample_count: i64,
    input_peak: f32,
    event_count_before: i32,
    event_count_after: i32,
    sample_position_before: i64,
    sample_position_after: i64,
    frame_index_before: i64,
    frame_index_after: i64,
    output_flag_before: i32,
    output_flag_after: i32,
    secondary_flag_before: Option<i32>,
    secondary_flag_after: Option<i32>,
    secondary_position_before: Option<i64>,
    secondary_position_after: Option<i64>,
    peak_before: Option<LoudViewPeakEventTrace>,
    peak_after: Option<LoudViewPeakEventTrace>,
    new_events: Vec<LoudViewPeakEventTrace>,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct LoudViewPeakEvent {
    peak: f32,
    peak_900: f32,
    start: i64,
    end: i64,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoudViewPeakEventTrace {
    peak: f32,
    peak_900: f32,
    start: i64,
    end: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoudViewSnapshotTrace {
    frame_samples: i32,
    total_samples: i64,
    processed_frames: i64,
    normalization: f32,
    loud_count: i32,
    dots_count: i32,
    raw_peaks: Vec<f32>,
    low_peaks: Vec<f32>,
    mid_peaks: Vec<f32>,
    high_peaks: Vec<f32>,
    loud_records: Vec<LoudViewRecordTrace>,
    loud_output: Vec<LoudViewOutputTrace>,
    dots_primary: Vec<i64>,
    dots_secondary: Vec<i64>,
    dots_output: Vec<LoudViewOutputTrace>,
    dots_levels: Vec<i32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoudViewRecordTrace {
    adjusted_height: i32,
    raw_height: i32,
    low_level: i32,
    mid_level: i32,
    high_level: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoudViewOutputTrace {
    value: f32,
    color: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BeatListChangeTrace {
    period_ms: f32,
    peak_position: i32,
    peak_amplitude: f32,
    band: i32,
    support: i32,
    generation_before: u32,
    generation_after: u32,
    hypothesis_count_before: usize,
    hypothesis_count_after: usize,
    peaks: Vec<PeakInfoTrace>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PeakInfoTrace {
    position: i32,
    amplitude: f32,
    interval_ms: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalyzerCheckpointTrace {
    stage: &'static str,
    beats: Vec<InternalBeatTrace>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SectionCheckpointTrace {
    stage: &'static str,
    sections: Vec<InternalBeatTrace>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RefinementCheckpointTrace {
    section_index: usize,
    section_length_frames: i32,
    source_start_index: usize,
    coarse_bpm: i32,
    coarse_votes: i32,
    fine_search_start: usize,
    fine_search_end: usize,
    fine_bpm_tenth: i32,
    fine_votes: i32,
    fine_histogram: Vec<HistogramBinTrace>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistogramBinTrace {
    bin: usize,
    votes: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PhaseProbeBlockTrace {
    callsite: u8,
    section_index: usize,
    lower_frame: f64,
    upper_frame: f64,
    period_frames: f64,
    tolerance_frames: i32,
    trial_count: usize,
    total_calls: usize,
    total_hits: usize,
    best_trial: Option<PhaseProbeTrialTrace>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PhaseProbeTrialTrace {
    start_target: i32,
    last_target: i32,
    score: i64,
    calls: usize,
    hits: usize,
    first_hit: Option<i32>,
}

#[derive(Debug)]
struct PhaseProbeAccumulator {
    block: PhaseProbeBlockTrace,
    current_trial: PhaseProbeTrialTrace,
}

#[derive(Debug, Clone, Copy)]
struct SegAdjustProbeContext {
    section_index: usize,
    lower_frame: f64,
    upper_frame: f64,
    period_frames: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GridSnapProbeTrace {
    callsite: u8,
    target_position: i32,
    tolerance_frames: i32,
    result_position: i32,
    result_index: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BeatInfoAnalyzeTrace {
    info_value_00: i32,
    info_unknown_04: u32,
    arg3: i32,
    arg4: i32,
    arg5: i32,
    arg6: i32,
    arg7: u32,
    bpm: f32,
    source_beats: Vec<InternalBeatTrace>,
    source_beats_after: Vec<InternalBeatTrace>,
    output_before: Vec<InternalBeatTrace>,
    output_after: Vec<InternalBeatTrace>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BeatStageTrace {
    stage: &'static str,
    args: Vec<i32>,
    beats_before: Vec<InternalBeatTrace>,
    beats_after: Vec<InternalBeatTrace>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UnitAdjustmentTrace {
    bpm_before: f32,
    bpm_after: f32,
    beats_before: Vec<InternalBeatTrace>,
    beats_after: Vec<InternalBeatTrace>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InternalBeatTrace {
    position: i32,
    unknown_04: u32,
    interval: f32,
    beat: i32,
    unknown_10: u32,
    flags_14: [u8; 4],
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct BaBeatInfo {
    position: i32,
    beat: i32,
    interval: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BaBeatTrace {
    position: i32,
    beat: i32,
    bpm_hundredths: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StageParityTrace {
    count_equal: bool,
    position_to_ms_exact: usize,
    beat_exact: usize,
    bpm_exact: usize,
    total: usize,
    first_mismatches: Vec<StageMismatchTrace>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StageMismatchTrace {
    index: usize,
    raw_position: i32,
    converted_time_ms: i64,
    final_time_ms: u32,
    raw_beat: i32,
    final_beat: u16,
    raw_bpm_hundredths: i32,
    final_bpm_hundredths: u16,
}

#[repr(C)]
struct StdVector {
    begin: *const u8,
    end: *const u8,
    capacity: *const u8,
}

#[repr(C)]
struct BeatInfoAnalyzeInfo {
    value_00: i32,
    unknown_04: u32,
    source_beats: *const StdVector,
}

pub(crate) fn begin_reference_trace() {
    let mut trace = trace()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *trace = ReferenceTrace {
        schema_version: 15,
        requested_engine: requested_engine().to_string(),
        ..ReferenceTrace::default()
    };
    PEAK_SENSOR_BASE.store(0, Ordering::Release);
    PEAK_BUFFER_BASE.store(0, Ordering::Release);
    PEAK_SENSOR_BAND_COUNT.store(0, Ordering::Release);
    CURRENT_BEAT_INFO.store(0, Ordering::Release);
    LAST_BEAT_COUNT.store(0, Ordering::Release);
}

pub(crate) fn finish_reference_trace(
    path: &Path,
    final_beat_grid: Option<BeatGridSummary>,
    final_beats: Vec<BeatEntry>,
) -> Result<()> {
    let mut trace = trace()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    trace.flush_phase_probe_block();
    trace.final_beat_grid = final_beat_grid;
    trace.stage_parity = stage_parity(&trace, &final_beats);
    trace.final_beats = final_beats;
    let encoded = serde_json::to_vec_pretty(&*trace)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    std::fs::write(path, encoded).with_context(|| format!("failed to write {}", path.display()))?;
    Ok(())
}

fn trace() -> &'static Mutex<ReferenceTrace> {
    TRACE.get_or_init(|| Mutex::new(ReferenceTrace::default()))
}

impl ReferenceTrace {
    fn record_phase_probe(
        &mut self,
        callsite: u8,
        context: SegAdjustProbeContext,
        target_position: i32,
        tolerance_frames: i32,
        result_position: i32,
    ) {
        let continues_block = self
            .phase_probe_accumulator
            .as_ref()
            .is_some_and(|accumulator| {
                accumulator.block.callsite == callsite
                    && accumulator.block.section_index == context.section_index
                    && accumulator.block.lower_frame.to_bits() == context.lower_frame.to_bits()
                    && accumulator.block.upper_frame.to_bits() == context.upper_frame.to_bits()
                    && accumulator.block.period_frames.to_bits() == context.period_frames.to_bits()
                    && accumulator.block.tolerance_frames == tolerance_frames
            });
        if !continues_block {
            self.flush_phase_probe_block();
            self.phase_probe_accumulator = Some(PhaseProbeAccumulator {
                block: PhaseProbeBlockTrace {
                    callsite,
                    section_index: context.section_index,
                    lower_frame: context.lower_frame,
                    upper_frame: context.upper_frame,
                    period_frames: context.period_frames,
                    tolerance_frames,
                    trial_count: 0,
                    total_calls: 0,
                    total_hits: 0,
                    best_trial: None,
                },
                current_trial: PhaseProbeTrialTrace {
                    start_target: target_position,
                    last_target: target_position,
                    score: 0,
                    calls: 0,
                    hits: 0,
                    first_hit: None,
                },
            });
        } else if self
            .phase_probe_accumulator
            .as_ref()
            .is_some_and(|accumulator| {
                target_position <= accumulator.current_trial.last_target
                    || ((i64::from(target_position)
                        - i64::from(accumulator.current_trial.last_target))
                        as f64)
                        < accumulator.block.period_frames * 0.5
            })
        {
            self.finish_phase_probe_trial();
            let accumulator = self
                .phase_probe_accumulator
                .as_mut()
                .expect("the phase-probe block remains active");
            accumulator.current_trial = PhaseProbeTrialTrace {
                start_target: target_position,
                last_target: target_position,
                score: 0,
                calls: 0,
                hits: 0,
                first_hit: None,
            };
        }

        let accumulator = self
            .phase_probe_accumulator
            .as_mut()
            .expect("a phase-probe block was initialized");
        accumulator.current_trial.last_target = target_position;
        accumulator.current_trial.calls += 1;
        if result_position >= 0 {
            accumulator.current_trial.hits += 1;
            accumulator
                .current_trial
                .first_hit
                .get_or_insert(result_position);
            accumulator.current_trial.score +=
                i64::from(tolerance_frames - result_position.abs_diff(target_position) as i32);
        }
    }

    fn finish_phase_probe_trial(&mut self) {
        let Some(accumulator) = self.phase_probe_accumulator.as_mut() else {
            return;
        };
        let trial = accumulator.current_trial.clone();
        accumulator.block.trial_count += 1;
        accumulator.block.total_calls += trial.calls;
        accumulator.block.total_hits += trial.hits;
        let replaces_best = accumulator
            .block
            .best_trial
            .as_ref()
            .is_none_or(|best| trial.score > best.score);
        if replaces_best {
            accumulator.block.best_trial = Some(trial);
        }
    }

    fn flush_phase_probe_block(&mut self) {
        let Some(mut accumulator) = self.phase_probe_accumulator.take() else {
            return;
        };
        let trial = accumulator.current_trial;
        accumulator.block.trial_count += 1;
        accumulator.block.total_calls += trial.calls;
        accumulator.block.total_hits += trial.hits;
        let replaces_best = accumulator
            .block
            .best_trial
            .as_ref()
            .is_none_or(|best| trial.score > best.score);
        if replaces_best {
            accumulator.block.best_trial = Some(trial);
        }
        self.phase_probe_blocks.push(accumulator.block);
    }
}

#[cfg(target_arch = "x86_64")]
pub(crate) unsafe fn install_reference_trace(base: usize) -> Result<()> {
    set_original(&BA_CREATE_VARIED_48, base + BA_CREATE_VARIED_48_OFFSET);
    set_original(&BA_CREATE_CONST_48, base + BA_CREATE_CONST_48_OFFSET);
    set_original(&BA_CREATE_VARIED_44, base + BA_CREATE_VARIED_44_OFFSET);
    set_original(&BA_CREATE_CONST_44, base + BA_CREATE_CONST_44_OFFSET);
    set_original(&BA_SET_SAMPLE, base + BA_SET_SAMPLE_OFFSET);
    set_original(&BA_GET_BPM, base + BA_GET_BPM_OFFSET);
    set_original(&BA_GET_BEAT_NUM, base + BA_GET_BEAT_NUM_OFFSET);
    set_original(&BA_GET_BEAT_LIST, base + BA_GET_BEAT_LIST_OFFSET);
    set_original(
        &UNIT_BEAT_ADJUST_ANALYZE,
        base + UNIT_BEAT_ADJUST_ANALYZE_OFFSET,
    );
    set_original(&BEAT_INFO_ANALYZE, base + BEAT_INFO_ANALYZE_OFFSET);
    set_original(&BEAT_INFO_SEG_ADJUST, base + BEAT_INFO_SEG_ADJUST_OFFSET);
    set_original(&BEAT_INFO_GAP_CORRECT, base + BEAT_INFO_GAP_CORRECT_OFFSET);
    set_original(
        &BEAT_INFO_GAP_CORRECT_RANGE,
        base + BEAT_INFO_GAP_CORRECT_RANGE_OFFSET,
    );
    set_original(
        &BEAT_INFO_FIND_NEAR_POS,
        base + BEAT_INFO_FIND_NEAR_POS_OFFSET,
    );
    set_original(&BEAT_SENSOR_CREATE, base + BEAT_SENSOR_CREATE_OFFSET);
    set_original(&PEAK_SENSOR_PUT, base + PEAK_SENSOR_PUT_OFFSET);
    set_original(&PEAK_BUFFER_CALC_BEAT, base + PEAK_BUFFER_CALC_BEAT_OFFSET);
    set_original(
        &LOUD_VIEW_ANALYZE_PEAK,
        base + LOUD_VIEW_ANALYZE_PEAK_OFFSET,
    );
    set_original(&LOUD_VIEW_PEAK_DETECT, base + LOUD_VIEW_PEAK_DETECT_OFFSET);
    set_original(
        &LOUD_VIEW_PEAK_DETECT_900,
        base + LOUD_VIEW_PEAK_DETECT_900_OFFSET,
    );
    set_original(&BEAT_LIST_CHANGE_STAT, base + BEAT_LIST_CHANGE_STAT_OFFSET);
    set_original(&MALLOC, base + MALLOC_OFFSET);
    set_original(&EXP10, base + EXP10_OFFSET);

    unsafe {
        match requested_engine() {
            "native" => {}
            "constant" => patch_bytes(
                base + ENGINE_SELECTION_BRANCH_OFFSET,
                &[0x74, 0x4d],
                &[0xeb, 0x4d],
            )?,
            "variable" => patch_bytes(
                base + ENGINE_SELECTION_BRANCH_OFFSET,
                &[0x74, 0x4d],
                &[0x90, 0x90],
            )?,
            value => bail!(
                "{ENV_TRACE_ENGINE} must be native, constant, or variable; received {value:?}"
            ),
        }
        patch_relative_call(
            base + CALL_BA_CREATE_VARIED_44_OFFSET,
            base + BA_CREATE_VARIED_44_OFFSET,
            trace_ba_create_varied_44 as usize,
        )?;
        patch_relative_call(
            base + CALL_BA_CREATE_CONST_44_OFFSET,
            base + BA_CREATE_CONST_44_OFFSET,
            trace_ba_create_const_44 as usize,
        )?;
        patch_relative_call(
            base + CALL_BA_CREATE_VARIED_48_OFFSET,
            base + BA_CREATE_VARIED_48_OFFSET,
            trace_ba_create_varied_48 as usize,
        )?;
        patch_relative_call(
            base + CALL_BA_CREATE_CONST_48_OFFSET,
            base + BA_CREATE_CONST_48_OFFSET,
            trace_ba_create_const_48 as usize,
        )?;
        patch_relative_call(
            base + CALL_BA_SET_SAMPLE_OFFSET,
            base + BA_SET_SAMPLE_OFFSET,
            trace_ba_set_sample as usize,
        )?;
        patch_relative_call(
            base + CALL_BA_GET_BPM_OFFSET,
            base + BA_GET_BPM_OFFSET,
            trace_ba_get_bpm as usize,
        )?;
        patch_relative_call(
            base + CALL_BA_GET_BEAT_NUM_OFFSET,
            base + BA_GET_BEAT_NUM_OFFSET,
            trace_ba_get_beat_num as usize,
        )?;
        patch_relative_call(
            base + CALL_BA_GET_BEAT_LIST_OFFSET,
            base + BA_GET_BEAT_LIST_OFFSET,
            trace_ba_get_beat_list as usize,
        )?;
        patch_relative_call(
            base + CALL_UNIT_BEAT_ADJUST_ANALYZE_OFFSET,
            base + UNIT_BEAT_ADJUST_ANALYZE_OFFSET,
            trace_unit_beat_adjust_analyze as usize,
        )?;
        patch_relative_call(
            base + CALL_BEAT_INFO_ANALYZE_OFFSET,
            base + BEAT_INFO_ANALYZE_OFFSET,
            trace_beat_info_analyze as usize,
        )?;
        patch_relative_call(
            base + CALL_BEAT_INFO_SEG_ADJUST_OFFSET,
            base + BEAT_INFO_SEG_ADJUST_OFFSET,
            trace_beat_info_seg_adjust as usize,
        )?;
        patch_relative_call(
            base + CALL_BEAT_INFO_GAP_CORRECT_OFFSET,
            base + BEAT_INFO_GAP_CORRECT_OFFSET,
            trace_beat_info_gap_correct as usize,
        )?;
        patch_relative_call(
            base + CALL_BEAT_INFO_GAP_CORRECT_RANGE_OFFSET,
            base + BEAT_INFO_GAP_CORRECT_RANGE_OFFSET,
            trace_beat_info_gap_correct_range as usize,
        )?;
        patch_relative_call(
            base + CALL_SEG_FIND_NEAR_POS_0_OFFSET,
            base + BEAT_INFO_FIND_NEAR_POS_OFFSET,
            trace_find_near_pos_0 as usize,
        )?;
        patch_relative_call(
            base + CALL_SEG_FIND_NEAR_POS_1_OFFSET,
            base + BEAT_INFO_FIND_NEAR_POS_OFFSET,
            trace_find_near_pos_1 as usize,
        )?;
        patch_relative_call(
            base + CALL_SEG_FIND_NEAR_POS_2_OFFSET,
            base + BEAT_INFO_FIND_NEAR_POS_OFFSET,
            trace_find_near_pos_2 as usize,
        )?;
        patch_relative_call(
            base + CALL_SEG_FIND_NEAR_POS_3_OFFSET,
            base + BEAT_INFO_FIND_NEAR_POS_OFFSET,
            trace_find_near_pos_3 as usize,
        )?;
        patch_relative_call(
            base + CALL_SEG_FIND_NEAR_POS_4_OFFSET,
            base + BEAT_INFO_FIND_NEAR_POS_OFFSET,
            trace_find_near_pos_4 as usize,
        )?;
        patch_relative_call(
            base + CALL_SEG_FIND_NEAR_POS_5_OFFSET,
            base + BEAT_INFO_FIND_NEAR_POS_OFFSET,
            trace_find_near_pos_5 as usize,
        )?;
        patch_relative_call(
            base + CALL_GRID_FIND_NEAR_POS_0_OFFSET,
            base + BEAT_INFO_FIND_NEAR_POS_OFFSET,
            trace_grid_find_near_pos_0 as usize,
        )?;
        patch_relative_call(
            base + CALL_GRID_FIND_NEAR_POS_1_OFFSET,
            base + BEAT_INFO_FIND_NEAR_POS_OFFSET,
            trace_grid_find_near_pos_1 as usize,
        )?;
        patch_relative_call(
            base + CALL_GRID_FIND_NEAR_POS_2_OFFSET,
            base + BEAT_INFO_FIND_NEAR_POS_OFFSET,
            trace_grid_find_near_pos_2 as usize,
        )?;
        patch_relative_call(
            base + CALL_GRID_FIND_NEAR_POS_3_OFFSET,
            base + BEAT_INFO_FIND_NEAR_POS_OFFSET,
            trace_grid_find_near_pos_3 as usize,
        )?;
        patch_relative_call(
            base + CALL_GRID_FIND_NEAR_POS_4_OFFSET,
            base + BEAT_INFO_FIND_NEAR_POS_OFFSET,
            trace_grid_find_near_pos_4 as usize,
        )?;
        patch_relative_call(
            base + CALL_GRID_FIND_NEAR_POS_5_OFFSET,
            base + BEAT_INFO_FIND_NEAR_POS_OFFSET,
            trace_grid_find_near_pos_5 as usize,
        )?;
        patch_relative_call(
            base + CALL_GRID_FIND_NEAR_POS_6_OFFSET,
            base + BEAT_INFO_FIND_NEAR_POS_OFFSET,
            trace_grid_find_near_pos_6 as usize,
        )?;
        patch_relative_call(
            base + CALL_GRID_FIND_NEAR_POS_7_OFFSET,
            base + BEAT_INFO_FIND_NEAR_POS_OFFSET,
            trace_grid_find_near_pos_7 as usize,
        )?;
        patch_relative_call(
            base + CALL_GRID_FIND_NEAR_POS_8_OFFSET,
            base + BEAT_INFO_FIND_NEAR_POS_OFFSET,
            trace_grid_find_near_pos_8 as usize,
        )?;
        patch_relative_call(
            base + CALL_BEAT_SENSOR_CREATE_OFFSET,
            base + BEAT_SENSOR_CREATE_OFFSET,
            trace_beat_sensor_create as usize,
        )?;
        patch_relative_call(
            base + CALL_PEAK_SENSOR_PUT_OFFSET,
            base + PEAK_SENSOR_PUT_OFFSET,
            trace_peak_sensor_put as usize,
        )?;
        patch_relative_call(
            base + CALL_PEAK_BUFFER_CALC_BEAT_OFFSET,
            base + PEAK_BUFFER_CALC_BEAT_OFFSET,
            trace_peak_buffer_calc_beat as usize,
        )?;
        patch_relative_call(
            base + CALL_LOUD_VIEW_ANALYZE_PEAK_0_OFFSET,
            base + LOUD_VIEW_ANALYZE_PEAK_OFFSET,
            trace_loud_view_analyze_peak as usize,
        )?;
        patch_relative_call(
            base + CALL_LOUD_VIEW_ANALYZE_PEAK_1_OFFSET,
            base + LOUD_VIEW_ANALYZE_PEAK_OFFSET,
            trace_loud_view_analyze_peak as usize,
        )?;
        patch_relative_call(
            base + CALL_LOUD_VIEW_PEAK_DETECT_0_OFFSET,
            base + LOUD_VIEW_PEAK_DETECT_OFFSET,
            trace_loud_view_peak_detect_0 as usize,
        )?;
        patch_relative_call(
            base + CALL_LOUD_VIEW_PEAK_DETECT_900_0_OFFSET,
            base + LOUD_VIEW_PEAK_DETECT_900_OFFSET,
            trace_loud_view_peak_detect_900_0 as usize,
        )?;
        patch_relative_call(
            base + CALL_LOUD_VIEW_PEAK_DETECT_1_OFFSET,
            base + LOUD_VIEW_PEAK_DETECT_OFFSET,
            trace_loud_view_peak_detect_1 as usize,
        )?;
        patch_relative_call(
            base + CALL_LOUD_VIEW_PEAK_DETECT_900_1_OFFSET,
            base + LOUD_VIEW_PEAK_DETECT_900_OFFSET,
            trace_loud_view_peak_detect_900_1 as usize,
        )?;
        patch_relative_call(
            base + CALL_LOUD_VIEW_PEAK_DETECT_2_OFFSET,
            base + LOUD_VIEW_PEAK_DETECT_OFFSET,
            trace_loud_view_peak_detect_2 as usize,
        )?;
        patch_relative_call(
            base + CALL_CHECKPOINT_CONTINUOUS_REGION_OFFSET,
            base + FWRITE_OFFSET,
            trace_checkpoint_continuous_region as usize,
        )?;
        patch_relative_call(
            base + CALL_CHECKPOINT_MINIMUM_RUN_OFFSET,
            base + FWRITE_OFFSET,
            trace_checkpoint_minimum_run as usize,
        )?;
        patch_relative_call(
            base + CALL_CHECKPOINT_TEMPO_FAMILY_OFFSET,
            base + MALLOC_OFFSET,
            trace_checkpoint_tempo_family as usize,
        )?;
        patch_relative_call(
            base + CALL_REFINEMENT_EXP10_OFFSET,
            base + EXP10_OFFSET,
            trace_refinement_exp10 as usize,
        )?;
        patch_relative_call(
            base + CALL_CHECKPOINT_NEAR_VALUE_OFFSET,
            base + FWRITE_OFFSET,
            trace_checkpoint_near_value as usize,
        )?;
        patch_pointer(
            base + BEAT_LIST_CHANGE_STAT_VTABLE_SLOT_OFFSET,
            base + BEAT_LIST_CHANGE_STAT_OFFSET,
            trace_beat_list_change_stat as usize,
        )?;
        patch_pointer(
            base + LOUD_VIEW_ANALYZE_PEAK_VTABLE_SLOT_OFFSET,
            base + LOUD_VIEW_ANALYZE_PEAK_OFFSET,
            trace_loud_view_analyze_peak as usize,
        )?;
    }
    Ok(())
}

fn requested_engine() -> &'static str {
    match std::env::var(ENV_TRACE_ENGINE) {
        Ok(value) if value.eq_ignore_ascii_case("constant") => "constant",
        Ok(value) if value.eq_ignore_ascii_case("variable") => "variable",
        Ok(value) if value.eq_ignore_ascii_case("native") || value.is_empty() => "native",
        Ok(_) => "invalid",
        Err(_) => "native",
    }
}

fn trace_analyzer_stages_enabled() -> bool {
    std::env::var(ENV_TRACE_ANALYZER_STAGES).is_ok_and(|value| {
        value == "1" || value.eq_ignore_ascii_case("true") || value.eq_ignore_ascii_case("yes")
    })
}

#[cfg(not(target_arch = "x86_64"))]
pub(crate) unsafe fn install_reference_trace(_base: usize) -> Result<()> {
    bail!("reference tracing requires the x86_64 Rekordbox worker")
}

fn set_original(slot: &AtomicUsize, address: usize) {
    slot.store(address, Ordering::Release);
}

unsafe fn original<T>(slot: &AtomicUsize) -> T {
    let address = slot.load(Ordering::Acquire);
    assert_ne!(address, 0, "reference trace function was not installed");
    unsafe { std::mem::transmute_copy(&address) }
}

#[cfg(target_arch = "x86_64")]
unsafe fn patch_relative_call(callsite: usize, expected_target: usize, hook: usize) -> Result<()> {
    let opcode = unsafe { (callsite as *const u8).read() };
    if opcode != 0xe8 {
        bail!("unexpected trace callsite opcode at {callsite:#x}: {opcode:#04x}");
    }
    let displacement = unsafe { ((callsite + 1) as *const i32).read_unaligned() };
    let actual_target = (callsite + 5).wrapping_add_signed(displacement as isize);
    if actual_target != expected_target {
        bail!(
            "unexpected trace call target at {callsite:#x}: expected {expected_target:#x}, found {actual_target:#x}"
        );
    }
    let hook_displacement = (hook as i128) - ((callsite + 5) as i128);
    let hook_displacement = i32::try_from(hook_displacement).with_context(|| {
        format!("trace hook {hook:#x} is outside rel32 range of callsite {callsite:#x}")
    })?;
    unsafe {
        patch_bytes(
            callsite + 1,
            &displacement.to_le_bytes(),
            &hook_displacement.to_le_bytes(),
        )
    }
}

#[cfg(target_arch = "x86_64")]
unsafe fn patch_bytes(address: usize, expected: &[u8], replacement: &[u8]) -> Result<()> {
    if expected.len() != replacement.len() {
        bail!("trace patch byte lengths differ");
    }
    let current = unsafe { std::slice::from_raw_parts(address as *const u8, expected.len()) };
    if current != expected {
        bail!(
            "unexpected trace patch bytes at {address:#x}: expected {}, found {}",
            hex_bytes(expected),
            hex_bytes(current)
        );
    }
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if page_size <= 0 {
        bail!("failed to resolve page size for reference trace");
    }
    let page_size = page_size as usize;
    let page = address & !(page_size - 1);
    if unsafe {
        libc::mprotect(
            page as *mut c_void,
            page_size,
            libc::PROT_READ | libc::PROT_WRITE | libc::PROT_EXEC,
        )
    } != 0
    {
        bail!("mprotect failed for reference trace patch {address:#x}");
    }
    unsafe {
        std::ptr::copy_nonoverlapping(replacement.as_ptr(), address as *mut u8, replacement.len());
    }
    if unsafe {
        libc::mprotect(
            page as *mut c_void,
            page_size,
            libc::PROT_READ | libc::PROT_EXEC,
        )
    } != 0
    {
        bail!("failed to restore trace patch protection at {address:#x}");
    }
    Ok(())
}

#[cfg(target_arch = "x86_64")]
unsafe fn patch_pointer(address: usize, expected: usize, replacement: usize) -> Result<()> {
    unsafe { patch_bytes(address, &expected.to_ne_bytes(), &replacement.to_ne_bytes()) }
}

fn hex_bytes(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

macro_rules! create_hook {
    ($name:ident, $slot:ident, $sample_rate:expr, $variable:expr) => {
        unsafe extern "C" fn $name(
            arg1: i32,
            arg2: i32,
            arg3: u8,
            arg4: u8,
            arg5: u8,
        ) -> *mut c_void {
            record_engine_create($sample_rate, $variable, arg1, arg2, arg3, arg4, arg5);
            let function: BaCreate = unsafe { original(&$slot) };
            unsafe { function(arg1, arg2, arg3, arg4, arg5) }
        }
    };
}

create_hook!(trace_ba_create_varied_48, BA_CREATE_VARIED_48, 48_000, true);
create_hook!(trace_ba_create_const_48, BA_CREATE_CONST_48, 48_000, false);
create_hook!(trace_ba_create_varied_44, BA_CREATE_VARIED_44, 44_100, true);
create_hook!(trace_ba_create_const_44, BA_CREATE_CONST_44, 44_100, false);

unsafe extern "C" fn trace_beat_sensor_create(
    sensor: *mut c_void,
    sample_rate: i32,
    arg2: i32,
    total_frames: i32,
    aggregate_frames: i32,
    band_count: i32,
) -> u64 {
    let function: BeatSensorCreate = unsafe { original(&BEAT_SENSOR_CREATE) };
    let result = unsafe {
        function(
            sensor,
            sample_rate,
            arg2,
            total_frames,
            aggregate_frames,
            band_count,
        )
    };
    if !sensor.is_null() && band_count > 0 {
        let sensor_bytes = sensor.cast::<u8>();
        PEAK_SENSOR_BASE.store(
            unsafe { read_pointer_at(sensor_bytes, 0x20) } as usize,
            Ordering::Release,
        );
        PEAK_BUFFER_BASE.store(
            unsafe { read_pointer_at(sensor_bytes, 0x28) } as usize,
            Ordering::Release,
        );
        PEAK_SENSOR_BAND_COUNT.store(band_count, Ordering::Release);
    }
    let snapshot = unsafe { snapshot_beat_sensor(sensor, band_count) };
    let mut trace = trace()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (object_words, filter_words, filter_stage_words, peak_sensor_words, band_state_words) =
        match snapshot {
            Ok(snapshot) => snapshot,
            Err(error) => {
                trace.warnings.push(format!(
                    "failed to snapshot BeatSensor after create: {error:#}"
                ));
                (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new())
            }
        };
    trace.beat_sensor_creates.push(BeatSensorCreateTrace {
        sample_rate,
        arg2,
        total_frames,
        aggregate_frames,
        band_count,
        result,
        object_words,
        filter_words,
        filter_stage_words,
        peak_sensor_words,
        band_state_words,
    });
    result
}

unsafe extern "C" fn trace_peak_sensor_put(sensor: *mut c_void, input: f32) -> u8 {
    let before = unsafe { snapshot_u32_words(sensor.cast(), BEAT_SENSOR_PEAK_BYTES) };
    let function: PeakSensorPut = unsafe { original(&PEAK_SENSOR_PUT) };
    let result = unsafe { function(sensor, input) };
    if result == 0 {
        return result;
    }
    let after = unsafe { snapshot_u32_words(sensor.cast(), BEAT_SENSOR_PEAK_BYTES) };
    let mut trace = trace()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if trace.peak_sensor_events.len() >= MAX_TRACE_PEAK_EVENTS {
        if trace.peak_sensor_events.len() == MAX_TRACE_PEAK_EVENTS {
            trace
                .warnings
                .push("peak-sensor event trace reached its bound".to_string());
        }
        return result;
    }
    let mut failures = Vec::new();
    let state_before = snapshot_words_or_empty(before, "peak sensor before", &mut failures);
    let state_after = snapshot_words_or_empty(after, "peak sensor after", &mut failures);
    trace.warnings.extend(failures);
    trace.peak_sensor_events.push(PeakSensorEventTrace {
        band: traced_band(sensor as usize, &PEAK_SENSOR_BASE, BEAT_SENSOR_PEAK_BYTES),
        input,
        state_before,
        state_after,
    });
    result
}

unsafe extern "C" fn trace_loud_view_analyze_peak(
    loud_view: *mut c_void,
    input: *mut f32,
    low: *mut f32,
    mid: *mut f32,
    high: *mut f32,
    sample_count: i32,
) -> u64 {
    let input_peak = unsafe { loud_view_input_peak(input, sample_count) };
    let low_input_peak = unsafe { loud_view_input_peak(low, sample_count) };
    let mid_input_peak = unsafe { loud_view_input_peak(mid, sample_count) };
    let high_input_peak = unsafe { loud_view_input_peak(high, sample_count) };
    let function: LoudViewAnalyzePeak = unsafe { original(&LOUD_VIEW_ANALYZE_PEAK) };
    let result = unsafe { function(loud_view, input, low, mid, high, sample_count) };
    unsafe {
        record_loud_view_snapshot(
            loud_view,
            sample_count,
            input_peak,
            (!low.is_null(), low_input_peak),
            (!mid.is_null(), mid_input_peak),
            (!high.is_null(), high_input_peak),
            result,
        )
    };
    result
}

unsafe fn loud_view_input_peak(input: *const f32, sample_count: i32) -> f32 {
    if input.is_null() || !(1..=100_000).contains(&sample_count) {
        return f32::NAN;
    }
    unsafe { std::slice::from_raw_parts(input, sample_count as usize) }
        .iter()
        .fold(0.0_f32, |peak, &sample| peak.max(sample.abs()))
}

#[derive(Clone, Copy)]
struct LoudViewPeakCallState {
    event_count: i32,
    sample_position: i64,
    frame_index: i64,
    output_flag: i32,
    secondary_flag: Option<i32>,
    secondary_position: Option<i64>,
    peak: Option<LoudViewPeakEventTrace>,
}

macro_rules! define_loud_view_peak_detect {
    ($name:ident, $stage:literal) => {
        unsafe extern "C" fn $name(
            loud_view: *mut c_void,
            input: *const f32,
            events: *mut LoudViewPeakEvent,
            sample_position: *mut i64,
            event_count: *mut i32,
            frame_index: *mut i64,
            band: i32,
            sample_count: i64,
            output_flag: *mut i32,
            secondary_flag: *mut i32,
            secondary_position: *mut i64,
        ) -> i64 {
            unsafe {
                trace_loud_view_peak_detect(
                    $stage,
                    loud_view,
                    input,
                    events,
                    sample_position,
                    event_count,
                    frame_index,
                    band,
                    sample_count,
                    output_flag,
                    secondary_flag,
                    secondary_position,
                )
            }
        }
    };
}

macro_rules! define_loud_view_peak_detect_900 {
    ($name:ident, $stage:literal) => {
        unsafe extern "C" fn $name(
            loud_view: *mut c_void,
            input: *const f32,
            events: *mut LoudViewPeakEvent,
            sample_position: *mut i64,
            event_count: *mut i32,
            frame_index: *mut i64,
            band: i32,
            sample_count: i64,
            output_flag: *mut i32,
        ) -> i64 {
            unsafe {
                trace_loud_view_peak_detect_900(
                    $stage,
                    loud_view,
                    input,
                    events,
                    sample_position,
                    event_count,
                    frame_index,
                    band,
                    sample_count,
                    output_flag,
                )
            }
        }
    };
}

define_loud_view_peak_detect!(trace_loud_view_peak_detect_0, 0);
define_loud_view_peak_detect_900!(trace_loud_view_peak_detect_900_0, 1);
define_loud_view_peak_detect!(trace_loud_view_peak_detect_1, 2);
define_loud_view_peak_detect_900!(trace_loud_view_peak_detect_900_1, 3);
define_loud_view_peak_detect!(trace_loud_view_peak_detect_2, 4);

#[allow(clippy::too_many_arguments)]
unsafe fn trace_loud_view_peak_detect(
    stage: u8,
    loud_view: *mut c_void,
    input: *const f32,
    events: *mut LoudViewPeakEvent,
    sample_position: *mut i64,
    event_count: *mut i32,
    frame_index: *mut i64,
    band: i32,
    sample_count: i64,
    output_flag: *mut i32,
    secondary_flag: *mut i32,
    secondary_position: *mut i64,
) -> i64 {
    let before = unsafe {
        loud_view_peak_call_state(
            events,
            sample_position,
            event_count,
            frame_index,
            output_flag,
            Some(secondary_flag),
            Some(secondary_position),
        )
    };
    let function: LoudViewPeakDetect = unsafe { original(&LOUD_VIEW_PEAK_DETECT) };
    let result = unsafe {
        function(
            loud_view,
            input,
            events,
            sample_position,
            event_count,
            frame_index,
            band,
            sample_count,
            output_flag,
            secondary_flag,
            secondary_position,
        )
    };
    let after = unsafe {
        loud_view_peak_call_state(
            events,
            sample_position,
            event_count,
            frame_index,
            output_flag,
            Some(secondary_flag),
            Some(secondary_position),
        )
    };
    unsafe {
        record_loud_view_peak_call(
            stage,
            false,
            band,
            input,
            sample_count,
            events,
            before,
            after,
        )
    };
    result
}

#[allow(clippy::too_many_arguments)]
unsafe fn trace_loud_view_peak_detect_900(
    stage: u8,
    loud_view: *mut c_void,
    input: *const f32,
    events: *mut LoudViewPeakEvent,
    sample_position: *mut i64,
    event_count: *mut i32,
    frame_index: *mut i64,
    band: i32,
    sample_count: i64,
    output_flag: *mut i32,
) -> i64 {
    let before = unsafe {
        loud_view_peak_call_state(
            events,
            sample_position,
            event_count,
            frame_index,
            output_flag,
            None,
            None,
        )
    };
    let function: LoudViewPeakDetect900 = unsafe { original(&LOUD_VIEW_PEAK_DETECT_900) };
    let result = unsafe {
        function(
            loud_view,
            input,
            events,
            sample_position,
            event_count,
            frame_index,
            band,
            sample_count,
            output_flag,
        )
    };
    let after = unsafe {
        loud_view_peak_call_state(
            events,
            sample_position,
            event_count,
            frame_index,
            output_flag,
            None,
            None,
        )
    };
    unsafe {
        record_loud_view_peak_call(
            stage,
            true,
            band,
            input,
            sample_count,
            events,
            before,
            after,
        )
    };
    result
}

unsafe fn loud_view_peak_call_state(
    events: *const LoudViewPeakEvent,
    sample_position: *const i64,
    event_count: *const i32,
    frame_index: *const i64,
    output_flag: *const i32,
    secondary_flag: Option<*const i32>,
    secondary_position: Option<*const i64>,
) -> LoudViewPeakCallState {
    let event_count = unsafe { read_pointer_or_default(event_count) };
    LoudViewPeakCallState {
        event_count,
        sample_position: unsafe { read_pointer_or_default(sample_position) },
        frame_index: unsafe { read_pointer_or_default(frame_index) },
        output_flag: unsafe { read_pointer_or_default(output_flag) },
        secondary_flag: secondary_flag.map(|pointer| unsafe { read_pointer_or_default(pointer) }),
        secondary_position: secondary_position
            .map(|pointer| unsafe { read_pointer_or_default(pointer) }),
        peak: unsafe { snapshot_loud_view_peak(events, event_count - 1) },
    }
}

#[allow(clippy::too_many_arguments)]
unsafe fn record_loud_view_peak_call(
    stage: u8,
    detector_900: bool,
    band: i32,
    input: *const f32,
    sample_count: i64,
    events: *const LoudViewPeakEvent,
    before: LoudViewPeakCallState,
    after: LoudViewPeakCallState,
) {
    let input_peak = if input.is_null() || !(1..=100_000).contains(&sample_count) {
        f32::NAN
    } else {
        unsafe { std::slice::from_raw_parts(input, sample_count as usize) }
            .iter()
            .fold(0.0_f32, |peak, &sample| peak.max(sample.abs()))
    };
    let first_new = before.event_count.max(0);
    let last_new = after.event_count.clamp(first_new, 4_096);
    let new_events = (first_new..last_new)
        .filter_map(|index| unsafe { snapshot_loud_view_peak(events, index) })
        .collect();

    let mut trace = trace()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if trace.loud_view_peak_calls.len() >= MAX_TRACE_LOUD_PEAK_CALLS {
        if trace.loud_view_peak_calls.len() == MAX_TRACE_LOUD_PEAK_CALLS {
            trace
                .warnings
                .push("LoudViewMaker peak-call trace reached its bound".to_string());
        }
        return;
    }
    trace.loud_view_peak_calls.push(LoudViewPeakCallTrace {
        stage,
        detector_900,
        band,
        sample_count,
        input_peak,
        event_count_before: before.event_count,
        event_count_after: after.event_count,
        sample_position_before: before.sample_position,
        sample_position_after: after.sample_position,
        frame_index_before: before.frame_index,
        frame_index_after: after.frame_index,
        output_flag_before: before.output_flag,
        output_flag_after: after.output_flag,
        secondary_flag_before: before.secondary_flag,
        secondary_flag_after: after.secondary_flag,
        secondary_position_before: before.secondary_position,
        secondary_position_after: after.secondary_position,
        peak_before: before.peak,
        peak_after: after.peak,
        new_events,
    });
}

unsafe fn snapshot_loud_view_peak(
    events: *const LoudViewPeakEvent,
    index: i32,
) -> Option<LoudViewPeakEventTrace> {
    if events.is_null() || !(0..4_096).contains(&index) {
        return None;
    }
    let event = unsafe { events.add(index as usize).read_unaligned() };
    Some(LoudViewPeakEventTrace {
        peak: event.peak,
        peak_900: event.peak_900,
        start: event.start,
        end: event.end,
    })
}

unsafe fn read_pointer_or_default<T: Copy + Default>(pointer: *const T) -> T {
    if pointer.is_null() {
        T::default()
    } else {
        unsafe { pointer.read_unaligned() }
    }
}

#[allow(clippy::too_many_arguments)]
unsafe fn record_loud_view_snapshot(
    loud_view: *mut c_void,
    sample_count: i32,
    input_peak: f32,
    low_input: (bool, f32),
    mid_input: (bool, f32),
    high_input: (bool, f32),
    result: u64,
) {
    if loud_view.is_null() {
        return;
    }
    let object = loud_view.cast::<u8>();
    let processed_frames = unsafe { read_i64_at(object, 0x18) };
    let frame_samples = unsafe { read_i32_at(object, 0x1288) };
    let total_samples = unsafe { read_i64_at(object, 0x12a0) };
    let mut trace = trace()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    trace.loud_view_calls.push(LoudViewCallTrace {
        sample_count,
        input_peak,
        low_provided: low_input.0,
        low_input_peak: low_input.1,
        mid_provided: mid_input.0,
        mid_input_peak: mid_input.1,
        high_provided: high_input.0,
        high_input_peak: high_input.1,
        result,
        processed_frames,
        raw_batch_emitted: unsafe { read_i64_at(object, 0x158) },
        raw_batch_value: unsafe {
            let pointer = read_pointer_at(object, 0x140);
            if pointer.is_null() {
                f32::NAN
            } else {
                read_f32_at(pointer, 0)
            }
        },
        raw_batch_sum: unsafe { read_f32_at(object, 0x164) },
        raw_batch_frames: unsafe { read_i32_at(object, 0x2d0) },
        raw_batch_pending: unsafe { read_i32_at(object, 0x2d4) },
        raw_output_index: unsafe { read_i32_at(object, 0x16c) },
        loud_ready: unsafe { read_i32_at(object, 0x234) },
        loud_emitted: unsafe { read_i32_at(object, 0x238) },
        dots_ready: unsafe { read_i32_at(object, 0x244) },
        dots_emitted: unsafe { read_i32_at(object, 0x248) },
    });
    let expected_frames = if frame_samples > 0 && total_samples > 0 {
        let frame_samples = i64::from(frame_samples);
        total_samples.saturating_add(frame_samples - 1) / frame_samples
    } else {
        0
    };
    if processed_frames < expected_frames {
        return;
    }
    match unsafe { snapshot_loud_view(object) } {
        Ok(snapshot) => trace.loud_view_final = Some(snapshot),
        Err(error) => trace
            .warnings
            .push(format!("failed to snapshot LoudViewMaker: {error:#}")),
    }
}

unsafe extern "C" fn trace_peak_buffer_calc_beat(buffer: *mut c_void, interval_ms: f32) -> u8 {
    let function: PeakBufferCalcBeat = unsafe { original(&PEAK_BUFFER_CALC_BEAT) };
    let result = unsafe { function(buffer, interval_ms) };
    let after = unsafe { snapshot_u32_words(buffer.cast(), BEAT_SENSOR_BAND_STATE_BYTES) };
    let mut trace = trace()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if trace.peak_buffer_calculations.len() >= MAX_TRACE_PEAK_EVENTS {
        if trace.peak_buffer_calculations.len() == MAX_TRACE_PEAK_EVENTS {
            trace
                .warnings
                .push("peak-buffer calculation trace reached its bound".to_string());
        }
        return result;
    }
    let mut failures = Vec::new();
    let state_after = snapshot_words_or_empty(after, "peak buffer after", &mut failures);
    trace.warnings.extend(failures);
    trace
        .peak_buffer_calculations
        .push(PeakBufferCalculationTrace {
            band: traced_band(
                buffer as usize,
                &PEAK_BUFFER_BASE,
                BEAT_SENSOR_BAND_STATE_BYTES,
            ),
            interval_ms,
            accepted: result != 0,
            state_after,
        });
    result
}

unsafe extern "C" fn trace_beat_list_change_stat(
    signal: *mut c_void,
    period_ms: f32,
    peak_position: i32,
    peak_amplitude: f32,
    buffer: *mut c_void,
) {
    let support = unsafe { read_i32_at(buffer.cast(), 0x40) };
    let generation_before = unsafe { read_u32_at(signal.cast(), 0x1c) };
    let count_before = unsafe { snapshot_signal_beat_count(signal) };
    let peaks = unsafe { snapshot_peak_history(buffer, support) };
    let function: BeatListChangeStat = unsafe { original(&BEAT_LIST_CHANGE_STAT) };
    unsafe { function(signal, period_ms, peak_position, peak_amplitude, buffer) };
    let generation_after = unsafe { read_u32_at(signal.cast(), 0x1c) };
    let count_after = unsafe { snapshot_signal_beat_count(signal) };

    let mut trace = trace()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if trace.beat_list_changes.len() >= MAX_TRACE_PEAK_EVENTS {
        if trace.beat_list_changes.len() == MAX_TRACE_PEAK_EVENTS {
            trace
                .warnings
                .push("beat-list change trace reached its bound".to_string());
        }
        return;
    }
    let mut failures = Vec::new();
    let hypothesis_count_before =
        snapshot_value_or_default(count_before, "beat-list count before", &mut failures);
    let hypothesis_count_after =
        snapshot_value_or_default(count_after, "beat-list count after", &mut failures);
    let peaks = snapshot_value_or_default(peaks, "beat-list peak history", &mut failures);
    trace.warnings.extend(failures);
    trace.beat_list_changes.push(BeatListChangeTrace {
        period_ms,
        peak_position,
        peak_amplitude,
        band: traced_band(
            buffer as usize,
            &PEAK_BUFFER_BASE,
            BEAT_SENSOR_BAND_STATE_BYTES,
        ),
        support,
        generation_before,
        generation_after,
        hypothesis_count_before,
        hypothesis_count_after,
        peaks,
    });
}

unsafe fn snapshot_signal_beat_count(signal: *const c_void) -> Result<usize> {
    if signal.is_null() {
        bail!("null BeatListSignal");
    }
    let vector = unsafe { read_pointer_at(signal.cast(), 0x10) } as *const StdVector;
    if vector.is_null() {
        bail!("null BeatListSignal vector");
    }
    let vector = unsafe { &*vector };
    let begin = vector.begin as usize;
    let end = vector.end as usize;
    if end < begin || !(end - begin).is_multiple_of(INTERNAL_BEAT_BYTES) {
        bail!("invalid BeatListSignal vector bounds");
    }
    Ok((end - begin) / INTERNAL_BEAT_BYTES)
}

unsafe fn snapshot_peak_history(buffer: *const c_void, support: i32) -> Result<Vec<PeakInfoTrace>> {
    if buffer.is_null() {
        bail!("null PeakBuffer");
    }
    if support < 0 {
        return Ok(Vec::new());
    }
    let bytes = buffer.cast::<u8>();
    let storage = unsafe { read_pointer_at(bytes, 0x08) };
    let next = unsafe { read_i32_at(bytes, 0x10) };
    let count = unsafe { read_i32_at(bytes, 0x14) };
    let capacity = unsafe { read_i32_at(bytes, 0x18) };
    if storage.is_null()
        || capacity <= 0
        || capacity > 32
        || count < 0
        || count > capacity
        || next < 0
        || next >= capacity
    {
        bail!(
            "invalid PeakBuffer ring storage={storage:p} next={next} count={count} capacity={capacity}"
        );
    }
    let record_count = support
        .checked_add(2)
        .context("PeakBuffer support overflow")?;
    if record_count > count {
        bail!("PeakBuffer history {record_count} exceeds stored count {count}");
    }
    let mut peaks = Vec::with_capacity(record_count as usize);
    for remaining in (0..record_count).rev() {
        let index = (next + capacity - 1 - remaining).rem_euclid(capacity);
        let record = unsafe { storage.add(index as usize * 12) };
        peaks.push(PeakInfoTrace {
            position: unsafe { read_i32_at(record, 0) },
            amplitude: unsafe { read_f32_at(record, 4) },
            interval_ms: unsafe { read_f32_at(record, 8) },
        });
    }
    Ok(peaks)
}

fn snapshot_value_or_default<T: Default>(
    result: Result<T>,
    label: &str,
    failures: &mut Vec<String>,
) -> T {
    match result {
        Ok(value) => value,
        Err(error) => {
            failures.push(format!("failed to snapshot {label}: {error:#}"));
            T::default()
        }
    }
}

fn traced_band(pointer: usize, base: &AtomicUsize, stride: usize) -> i32 {
    let base = base.load(Ordering::Acquire);
    let count = PEAK_SENSOR_BAND_COUNT.load(Ordering::Acquire);
    let Some(offset) = pointer.checked_sub(base) else {
        return -1;
    };
    if base == 0 || count <= 0 || offset % stride != 0 || offset / stride >= count as usize {
        return -1;
    }
    (offset / stride) as i32
}

fn record_engine_create(
    sample_rate: u32,
    variable_tempo: bool,
    arg1: i32,
    arg2: i32,
    arg3: u8,
    arg4: u8,
    arg5: u8,
) {
    let mut trace = trace()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    trace.engine_creates.push(EngineCreateTrace {
        sample_rate,
        variable_tempo,
        arg1,
        arg2,
        arg3,
        arg4,
        arg5,
    });
}

unsafe extern "C" fn trace_ba_set_sample(
    analyzer: *mut c_void,
    left: *mut f32,
    right: *mut f32,
    frames: i32,
) {
    if frames > 0 {
        let mut trace = trace()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        trace.streamed_frames = trace.streamed_frames.saturating_add(frames as u64);
    }
    let function: BaSetSample = unsafe { original(&BA_SET_SAMPLE) };
    unsafe { function(analyzer, left, right, frames) };
    if !analyzer.is_null() {
        let loud_view = unsafe { analyzer.cast::<u8>().add(0x688).cast::<c_void>() };
        unsafe {
            record_loud_view_snapshot(
                loud_view,
                frames,
                f32::NAN,
                (false, f32::NAN),
                (false, f32::NAN),
                (false, f32::NAN),
                0,
            )
        };
    }
}

unsafe extern "C" fn trace_ba_get_bpm(analyzer: *mut c_void) -> i32 {
    let function: BaGetBpm = unsafe { original(&BA_GET_BPM) };
    let bpm = unsafe { function(analyzer) };
    let mut trace = trace()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    trace.ba_bpm_raw = Some(bpm);
    bpm
}

unsafe extern "C" fn trace_ba_get_beat_num(analyzer: *mut c_void) -> i32 {
    let function: BaGetBeatNum = unsafe { original(&BA_GET_BEAT_NUM) };
    let count = unsafe { function(analyzer) };
    LAST_BEAT_COUNT.store(count, Ordering::Release);
    let mut trace = trace()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    trace.ba_beat_count = Some(count);
    count
}

unsafe extern "C" fn trace_ba_get_beat_list(analyzer: *mut c_void, beats: *mut BaBeatInfo) {
    let function: BaGetBeatList = unsafe { original(&BA_GET_BEAT_LIST) };
    unsafe { function(analyzer, beats) };
    let count = LAST_BEAT_COUNT.load(Ordering::Acquire);
    let mut trace = trace()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if count <= 0 || count as usize > MAX_TRACE_BEATS || beats.is_null() {
        trace.warnings.push(format!(
            "invalid BA beat list pointer/count: {beats:p}/{count}"
        ));
        return;
    }
    let beats = unsafe { std::slice::from_raw_parts(beats, count as usize) };
    trace.ba_beats = beats
        .iter()
        .map(|beat| BaBeatTrace {
            position: beat.position,
            beat: beat.beat,
            bpm_hundredths: beat.interval,
        })
        .collect();
}

fn stage_parity(trace: &ReferenceTrace, final_beats: &[BeatEntry]) -> Option<StageParityTrace> {
    let sample_rate = trace.engine_creates.last()?.sample_rate;
    let total = trace.ba_beats.len().min(final_beats.len());
    let mut position_to_ms_exact = 0;
    let mut beat_exact = 0;
    let mut bpm_exact = 0;
    let mut first_mismatches = Vec::new();
    for (index, (raw, final_beat)) in trace.ba_beats.iter().zip(final_beats.iter()).enumerate() {
        let converted_time_ms = i64::from(raw.position) * 1_000 / i64::from(sample_rate);
        let final_bpm_hundredths = (final_beat.bpm * 100.0).round() as u16;
        let position_match = converted_time_ms == i64::from(final_beat.time_ms);
        let beat_match = raw.beat == i32::from(final_beat.beat);
        let bpm_match = raw.bpm_hundredths == i32::from(final_bpm_hundredths);
        position_to_ms_exact += usize::from(position_match);
        beat_exact += usize::from(beat_match);
        bpm_exact += usize::from(bpm_match);
        if !(position_match && beat_match && bpm_match) && first_mismatches.len() < 16 {
            first_mismatches.push(StageMismatchTrace {
                index,
                raw_position: raw.position,
                converted_time_ms,
                final_time_ms: final_beat.time_ms,
                raw_beat: raw.beat,
                final_beat: final_beat.beat,
                raw_bpm_hundredths: raw.bpm_hundredths,
                final_bpm_hundredths,
            });
        }
    }
    Some(StageParityTrace {
        count_equal: trace.ba_beats.len() == final_beats.len(),
        position_to_ms_exact,
        beat_exact,
        bpm_exact,
        total,
        first_mismatches,
    })
}

unsafe extern "C" fn trace_beat_info_analyze(
    analyzer: *mut c_void,
    info: *mut BeatInfoAnalyzeInfo,
    output: *mut StdVector,
    arg3: i32,
    arg4: i32,
    arg5: i32,
    arg6: i32,
    arg7: u32,
) -> f32 {
    let info_before = unsafe { snapshot_beat_info_source(info) };
    let output_before = unsafe { snapshot_internal_beats(output) };
    let mut debug_stream = std::ptr::null_mut();
    let mut original_debug_stream = std::ptr::null_mut();
    let debug_slot = if trace_analyzer_stages_enabled() && !analyzer.is_null() {
        let slot = unsafe { analyzer.cast::<u8>().add(8).cast::<*mut libc::FILE>() };
        original_debug_stream = unsafe { slot.read_unaligned() };
        debug_stream = unsafe { libc::tmpfile() };
        if debug_stream.is_null() {
            let mut trace = trace()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            trace
                .warnings
                .push("failed to create BeatInfoAnalyzer checkpoint stream".to_string());
            None
        } else {
            unsafe { slot.write_unaligned(debug_stream) };
            Some(slot)
        }
    } else {
        None
    };
    CURRENT_BEAT_INFO.store(info as usize, Ordering::Release);
    let function: BeatInfoAnalyze = unsafe { original(&BEAT_INFO_ANALYZE) };
    let bpm = unsafe { function(analyzer, info, output, arg3, arg4, arg5, arg6, arg7) };
    CURRENT_BEAT_INFO.store(0, Ordering::Release);
    if let Some(debug_slot) = debug_slot {
        unsafe { debug_slot.write_unaligned(original_debug_stream) };
        unsafe { libc::fclose(debug_stream) };
    }
    let source_after = unsafe { snapshot_beat_info_source(info) };
    let output_after = unsafe { snapshot_internal_beats(output) };

    let mut failures = Vec::new();
    let (info_value_00, info_unknown_04, source_beats) = match info_before {
        Ok(info) => info,
        Err(error) => {
            failures.push(format!("failed to snapshot beat-info source: {error:#}"));
            (0, 0, Vec::new())
        }
    };
    let source_beats_after = match source_after {
        Ok((_, _, beats)) => beats,
        Err(error) => {
            failures.push(format!(
                "failed to snapshot beat-info source after analysis: {error:#}"
            ));
            Vec::new()
        }
    };
    let output_before = snapshot_or_empty(output_before, "beat-info output before", &mut failures);
    let output_after = snapshot_or_empty(output_after, "beat-info output after", &mut failures);
    let mut trace = trace()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    trace.warnings.extend(failures);
    trace.beat_info_analyzes.push(BeatInfoAnalyzeTrace {
        info_value_00,
        info_unknown_04,
        arg3,
        arg4,
        arg5,
        arg6,
        arg7,
        bpm,
        source_beats,
        source_beats_after,
        output_before,
        output_after,
    });
    bpm
}

unsafe extern "C" fn trace_checkpoint_continuous_region(
    pointer: *const c_void,
    size: usize,
    count: usize,
    stream: *mut libc::FILE,
) -> usize {
    unsafe { trace_checkpoint_fwrite("continuousRegion", pointer, size, count, stream) }
}

unsafe extern "C" fn trace_checkpoint_minimum_run(
    pointer: *const c_void,
    size: usize,
    count: usize,
    stream: *mut libc::FILE,
) -> usize {
    unsafe { trace_checkpoint_fwrite("minimumRun", pointer, size, count, stream) }
}

unsafe extern "C" fn trace_checkpoint_tempo_family(bytes: usize) -> *mut c_void {
    record_analyzer_checkpoint("tempoFamily");
    unsafe { record_caller_section_checkpoint("provisionalSections") };
    let function: AllocateBytes = unsafe { original(&MALLOC) };
    unsafe { function(bytes) }
}

#[cfg(target_arch = "x86_64")]
#[inline(never)]
unsafe extern "C" fn trace_refinement_exp10(value: f64) -> f64 {
    let frame_pointer: usize;
    let coarse_histogram: usize;
    let coarse_bpm: i32;
    unsafe {
        std::arch::asm!(
            "mov {frame_pointer}, rbp",
            "mov {coarse_histogram}, r14",
            "mov {coarse_bpm:e}, r15d",
            frame_pointer = out(reg) frame_pointer,
            coarse_histogram = out(reg) coarse_histogram,
            coarse_bpm = out(reg) coarse_bpm,
            options(nostack, preserves_flags)
        )
    };
    let analyzer_frame = unsafe { (frame_pointer as *const usize).read() };
    let section_index =
        unsafe { (analyzer_frame.wrapping_sub(0x60) as *const usize).read_unaligned() };
    let section_length_frames =
        unsafe { (analyzer_frame.wrapping_sub(0xb0) as *const i32).read_unaligned() };
    let source_start_triple =
        unsafe { (analyzer_frame.wrapping_sub(0x158) as *const usize).read_unaligned() };
    let fine_histogram =
        unsafe { (analyzer_frame.wrapping_sub(0x118) as *const *const i32).read_unaligned() };
    let fine_search_start = ((coarse_bpm - 1) * 10).max(0) as usize;
    let fine_search_end = ((coarse_bpm + 1) * 10).clamp(0, 4_000) as usize;
    let fine_bins = unsafe {
        std::slice::from_raw_parts(
            fine_histogram.add(fine_search_start),
            fine_search_end - fine_search_start,
        )
    };
    let mut fine_bpm_tenth = -1;
    let mut fine_votes = 0;
    let mut fine_trace = Vec::new();
    for (offset, &votes) in fine_bins.iter().enumerate() {
        if votes > fine_votes {
            fine_votes = votes;
            fine_bpm_tenth = (fine_search_start + offset) as i32;
        }
        if votes > 0 {
            fine_trace.push(HistogramBinTrace {
                bin: fine_search_start + offset,
                votes,
            });
        }
    }
    let coarse_votes = if (0..400).contains(&coarse_bpm) {
        unsafe {
            (coarse_histogram as *const i32)
                .add(coarse_bpm as usize)
                .read()
        }
    } else {
        0
    };
    let mut trace = trace()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    trace
        .refinement_checkpoints
        .push(RefinementCheckpointTrace {
            section_index,
            section_length_frames,
            source_start_index: source_start_triple / 3,
            coarse_bpm,
            coarse_votes,
            fine_search_start,
            fine_search_end,
            fine_bpm_tenth,
            fine_votes,
            fine_histogram: fine_trace,
        });
    drop(trace);
    let function: Exp10 = unsafe { original(&EXP10) };
    unsafe { function(value) }
}

unsafe extern "C" fn trace_checkpoint_near_value(
    pointer: *const c_void,
    size: usize,
    count: usize,
    stream: *mut libc::FILE,
) -> usize {
    unsafe { record_caller_section_checkpoint("refinedSections") };
    unsafe { trace_checkpoint_fwrite("nearValue", pointer, size, count, stream) }
}

unsafe fn trace_checkpoint_fwrite(
    stage: &'static str,
    pointer: *const c_void,
    size: usize,
    count: usize,
    stream: *mut libc::FILE,
) -> usize {
    record_analyzer_checkpoint(stage);
    unsafe { libc::fwrite(pointer, size, count, stream) }
}

fn record_analyzer_checkpoint(stage: &'static str) {
    if !trace_analyzer_stages_enabled() {
        return;
    }
    let info = CURRENT_BEAT_INFO.load(Ordering::Acquire) as *const BeatInfoAnalyzeInfo;
    if info.is_null() {
        return;
    }
    let snapshot = unsafe { snapshot_beat_info_source(info) };
    let mut trace = trace()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match snapshot {
        Ok((_, _, beats)) => trace
            .analyzer_checkpoints
            .push(AnalyzerCheckpointTrace { stage, beats }),
        Err(error) => trace.warnings.push(format!(
            "failed to snapshot BeatInfoAnalyzer checkpoint {stage}: {error:#}"
        )),
    }
}

#[cfg(target_arch = "x86_64")]
#[inline(never)]
unsafe fn record_caller_section_checkpoint(stage: &'static str) {
    if !trace_analyzer_stages_enabled() {
        return;
    }
    let frame_pointer: usize;
    unsafe {
        std::arch::asm!(
            "mov {frame_pointer}, rbp",
            frame_pointer = out(reg) frame_pointer,
            options(nostack, preserves_flags)
        )
    };
    let wrapper_frame = unsafe { (frame_pointer as *const usize).read() };
    let analyzer_frame = unsafe { (wrapper_frame as *const usize).read() };
    let vector = analyzer_frame.wrapping_sub(0x100) as *const StdVector;
    let snapshot = unsafe { snapshot_internal_beats(vector) };
    let mut trace = trace()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match snapshot {
        Ok(sections) => trace
            .section_checkpoints
            .push(SectionCheckpointTrace { stage, sections }),
        Err(error) => trace.warnings.push(format!(
            "failed to snapshot BeatInfoAnalyzer {stage}: {error:#}"
        )),
    }
}

#[cfg(not(target_arch = "x86_64"))]
unsafe fn record_caller_section_checkpoint(_stage: &'static str) {}

macro_rules! define_find_near_pos_probe {
    ($name:ident, $callsite:literal) => {
        #[inline(never)]
        unsafe extern "C" fn $name(
            analyzer: *mut c_void,
            beats: *mut StdVector,
            target_position: i32,
            tolerance_frames: i32,
            result_index: *mut i32,
        ) -> i32 {
            let context = unsafe { caller_seg_adjust_probe_context() };
            unsafe {
                trace_find_near_pos(
                    $callsite,
                    context,
                    analyzer,
                    beats,
                    target_position,
                    tolerance_frames,
                    result_index,
                )
            }
        }
    };
}

define_find_near_pos_probe!(trace_find_near_pos_0, 0);
define_find_near_pos_probe!(trace_find_near_pos_1, 1);
define_find_near_pos_probe!(trace_find_near_pos_2, 2);
define_find_near_pos_probe!(trace_find_near_pos_3, 3);
define_find_near_pos_probe!(trace_find_near_pos_4, 4);
define_find_near_pos_probe!(trace_find_near_pos_5, 5);

macro_rules! define_grid_find_near_pos_probe {
    ($name:ident, $callsite:literal) => {
        unsafe extern "C" fn $name(
            analyzer: *mut c_void,
            beats: *mut StdVector,
            target_position: i32,
            tolerance_frames: i32,
            result_index: *mut i32,
        ) -> i32 {
            unsafe {
                trace_grid_find_near_pos(
                    $callsite,
                    analyzer,
                    beats,
                    target_position,
                    tolerance_frames,
                    result_index,
                )
            }
        }
    };
}

define_grid_find_near_pos_probe!(trace_grid_find_near_pos_0, 0);
define_grid_find_near_pos_probe!(trace_grid_find_near_pos_1, 1);
define_grid_find_near_pos_probe!(trace_grid_find_near_pos_2, 2);
define_grid_find_near_pos_probe!(trace_grid_find_near_pos_3, 3);
define_grid_find_near_pos_probe!(trace_grid_find_near_pos_4, 4);
define_grid_find_near_pos_probe!(trace_grid_find_near_pos_5, 5);
define_grid_find_near_pos_probe!(trace_grid_find_near_pos_6, 6);
define_grid_find_near_pos_probe!(trace_grid_find_near_pos_7, 7);
define_grid_find_near_pos_probe!(trace_grid_find_near_pos_8, 8);

unsafe fn trace_grid_find_near_pos(
    callsite: u8,
    analyzer: *mut c_void,
    beats: *mut StdVector,
    target_position: i32,
    tolerance_frames: i32,
    result_index: *mut i32,
) -> i32 {
    let function: BeatInfoFindNearPos = unsafe { original(&BEAT_INFO_FIND_NEAR_POS) };
    let result_position = unsafe {
        function(
            analyzer,
            beats,
            target_position,
            tolerance_frames,
            result_index,
        )
    };
    if trace_analyzer_stages_enabled() {
        let result_index = if result_index.is_null() {
            -1
        } else {
            unsafe { result_index.read() }
        };
        let mut trace = trace()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if trace.grid_snap_probes.len() >= MAX_TRACE_GRID_SNAP_PROBES {
            const WARNING: &str = "grid-snap probe trace reached its bound";
            if !trace.warnings.iter().any(|warning| warning == WARNING) {
                trace.warnings.push(WARNING.to_string());
            }
            return result_position;
        }
        trace.grid_snap_probes.push(GridSnapProbeTrace {
            callsite,
            target_position,
            tolerance_frames,
            result_position,
            result_index,
        });
    }
    result_position
}

unsafe fn trace_find_near_pos(
    callsite: u8,
    context: SegAdjustProbeContext,
    analyzer: *mut c_void,
    beats: *mut StdVector,
    target_position: i32,
    tolerance_frames: i32,
    result_index: *mut i32,
) -> i32 {
    let function: BeatInfoFindNearPos = unsafe { original(&BEAT_INFO_FIND_NEAR_POS) };
    let result_position = unsafe {
        function(
            analyzer,
            beats,
            target_position,
            tolerance_frames,
            result_index,
        )
    };
    if trace_analyzer_stages_enabled() {
        let mut trace = trace()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        trace.record_phase_probe(
            callsite,
            context,
            target_position,
            tolerance_frames,
            result_position,
        );
    }
    result_position
}

#[cfg(target_arch = "x86_64")]
#[inline(never)]
unsafe fn caller_seg_adjust_probe_context() -> SegAdjustProbeContext {
    let frame_pointer: usize;
    unsafe {
        std::arch::asm!(
            "mov {frame_pointer}, rbp",
            frame_pointer = out(reg) frame_pointer,
            options(nostack, preserves_flags)
        )
    };
    let wrapper_frame = unsafe { (frame_pointer as *const usize).read() };
    let seg_adjust_frame = unsafe { (wrapper_frame as *const usize).read() };
    SegAdjustProbeContext {
        section_index: unsafe {
            (seg_adjust_frame.wrapping_sub(0xe8) as *const usize).read_unaligned()
        },
        lower_frame: unsafe {
            (seg_adjust_frame.wrapping_sub(0x70) as *const f64).read_unaligned()
        },
        upper_frame: unsafe {
            (seg_adjust_frame.wrapping_sub(0x48) as *const f64).read_unaligned()
        },
        period_frames: unsafe {
            (seg_adjust_frame.wrapping_sub(0x38) as *const f64).read_unaligned()
        },
    }
}

#[cfg(not(target_arch = "x86_64"))]
unsafe fn caller_seg_adjust_probe_context() -> SegAdjustProbeContext {
    SegAdjustProbeContext {
        section_index: 0,
        lower_frame: 0.0,
        upper_frame: 0.0,
        period_frames: 0.0,
    }
}

unsafe extern "C" fn trace_beat_info_seg_adjust(
    analyzer: *mut c_void,
    info: *mut BeatInfoAnalyzeInfo,
    beats: *mut StdVector,
    arg3: i32,
) {
    let before = unsafe { snapshot_internal_beats(beats) };
    let function: BeatInfoSegAdjust = unsafe { original(&BEAT_INFO_SEG_ADJUST) };
    unsafe { function(analyzer, info, beats, arg3) };
    let after = unsafe { snapshot_internal_beats(beats) };
    record_beat_stage("segmentAdjust", true, vec![arg3], before, after);
}

unsafe extern "C" fn trace_beat_info_gap_correct(
    analyzer: *mut c_void,
    beats: *mut StdVector,
    unused_arg2: i32,
) {
    let before = unsafe { snapshot_internal_beats(beats) };
    let function: BeatInfoGapCorrect = unsafe { original(&BEAT_INFO_GAP_CORRECT) };
    unsafe { function(analyzer, beats, unused_arg2) };
    let after = unsafe { snapshot_internal_beats(beats) };
    record_beat_stage("gapCorrect", false, Vec::new(), before, after);
}

unsafe extern "C" fn trace_beat_info_gap_correct_range(
    analyzer: *mut c_void,
    beats: *mut StdVector,
    arg2: i32,
    arg3: i32,
    arg4: i32,
) {
    let before = unsafe { snapshot_internal_beats(beats) };
    let function: BeatInfoGapCorrectRange = unsafe { original(&BEAT_INFO_GAP_CORRECT_RANGE) };
    unsafe { function(analyzer, beats, arg2, arg3, arg4) };
    let after = unsafe { snapshot_internal_beats(beats) };
    record_beat_stage(
        "gapCorrectRange",
        false,
        vec![arg2, arg3, arg4],
        before,
        after,
    );
}

fn record_beat_stage(
    stage: &'static str,
    segment_adjustment: bool,
    args: Vec<i32>,
    before: Result<Vec<InternalBeatTrace>>,
    after: Result<Vec<InternalBeatTrace>>,
) {
    let mut failures = Vec::new();
    let beats_before = snapshot_or_empty(before, &format!("{stage} before"), &mut failures);
    let beats_after = snapshot_or_empty(after, &format!("{stage} after"), &mut failures);
    let mut trace = trace()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    trace.warnings.extend(failures);
    let stage = BeatStageTrace {
        stage,
        args,
        beats_before,
        beats_after,
    };
    if segment_adjustment {
        trace.segment_adjustments.push(stage);
    } else {
        trace.gap_corrections.push(stage);
    }
}

fn snapshot_or_empty(
    result: Result<Vec<InternalBeatTrace>>,
    label: &str,
    failures: &mut Vec<String>,
) -> Vec<InternalBeatTrace> {
    match result {
        Ok(beats) => beats,
        Err(error) => {
            failures.push(format!("failed to snapshot {label}: {error:#}"));
            Vec::new()
        }
    }
}

fn snapshot_words_or_empty(
    result: Result<Vec<u32>>,
    label: &str,
    failures: &mut Vec<String>,
) -> Vec<u32> {
    match result {
        Ok(words) => words,
        Err(error) => {
            failures.push(format!("failed to snapshot {label}: {error:#}"));
            Vec::new()
        }
    }
}

unsafe fn snapshot_beat_info_source(
    info: *const BeatInfoAnalyzeInfo,
) -> Result<(i32, u32, Vec<InternalBeatTrace>)> {
    if info.is_null() {
        bail!("null beat-info analysis input");
    }
    let info = unsafe { &*info };
    let beats = unsafe { snapshot_internal_beats(info.source_beats) }?;
    Ok((info.value_00, info.unknown_04, beats))
}

type BeatSensorSnapshot = (Vec<u32>, Vec<u32>, Vec<Vec<u32>>, Vec<u32>, Vec<u32>);

unsafe fn snapshot_beat_sensor(
    sensor: *const c_void,
    band_count: i32,
) -> Result<BeatSensorSnapshot> {
    if sensor.is_null() {
        bail!("null BeatSensor");
    }
    let band_count = usize::try_from(band_count).context("negative BeatSensor band count")?;
    if band_count == 0 || band_count > 64 {
        bail!("invalid BeatSensor band count {band_count}");
    }
    let sensor = sensor.cast::<u8>();
    let filters = unsafe { read_pointer_at(sensor, 0x18) };
    let peak_sensors = unsafe { read_pointer_at(sensor, 0x20) };
    let band_states = unsafe { read_pointer_at(sensor, 0x28) };
    let mut filter_stage_words = Vec::with_capacity(band_count);
    for band in 0..band_count {
        let filter = unsafe { filters.add(band * BEAT_SENSOR_FILTER_BYTES) };
        let stage_count = unsafe { (filter.add(8) as *const u32).read_unaligned() } as usize;
        if stage_count == 0 || stage_count > 16 {
            bail!("invalid IIR stage count {stage_count} for BeatSensor band {band}");
        }
        let stages = unsafe { read_pointer_at(filter, 0x10) };
        filter_stage_words.push(unsafe {
            snapshot_u32_words(
                stages,
                stage_count
                    .checked_mul(IIR_FILTER_BYTES)
                    .context("IIR filter-stage snapshot overflow")?,
            )
        }?);
    }
    Ok((
        unsafe { snapshot_u32_words(sensor, BEAT_SENSOR_OBJECT_BYTES) }?,
        unsafe {
            snapshot_u32_words(
                filters,
                band_count
                    .checked_mul(BEAT_SENSOR_FILTER_BYTES)
                    .context("BeatSensor filter snapshot overflow")?,
            )
        }?,
        filter_stage_words,
        unsafe {
            snapshot_u32_words(
                peak_sensors,
                band_count
                    .checked_mul(BEAT_SENSOR_PEAK_BYTES)
                    .context("BeatSensor peak snapshot overflow")?,
            )
        }?,
        unsafe {
            snapshot_u32_words(
                band_states,
                band_count
                    .checked_mul(BEAT_SENSOR_BAND_STATE_BYTES)
                    .context("BeatSensor band-state snapshot overflow")?,
            )
        }?,
    ))
}

unsafe fn read_pointer_at(base: *const u8, offset: usize) -> *const u8 {
    unsafe { (base.add(offset) as *const *const u8).read_unaligned() }
}

unsafe fn read_i32_at(base: *const u8, offset: usize) -> i32 {
    unsafe { (base.add(offset) as *const i32).read_unaligned() }
}

unsafe fn read_u32_at(base: *const u8, offset: usize) -> u32 {
    unsafe { (base.add(offset) as *const u32).read_unaligned() }
}

unsafe fn read_f32_at(base: *const u8, offset: usize) -> f32 {
    unsafe { (base.add(offset) as *const f32).read_unaligned() }
}

unsafe fn read_i64_at(base: *const u8, offset: usize) -> i64 {
    unsafe { (base.add(offset) as *const i64).read_unaligned() }
}

unsafe fn snapshot_loud_view(object: *const u8) -> Result<LoudViewSnapshotTrace> {
    const LOUD_COLUMNS: usize = 400;
    const DOT_COLUMNS: usize = 100;

    let read_pointer_f32 = |offset: usize, count: usize| -> Result<Vec<f32>> {
        let pointer = unsafe { read_pointer_at(object, offset) };
        if pointer.is_null() {
            bail!("null LoudViewMaker float buffer at {offset:#x}");
        }
        Ok((0..count)
            .map(|index| unsafe { read_f32_at(pointer, index * size_of::<f32>()) })
            .collect())
    };
    let read_pointer_i64 = |offset: usize, count: usize| -> Result<Vec<i64>> {
        let pointer = unsafe { read_pointer_at(object, offset) };
        if pointer.is_null() {
            bail!("null LoudViewMaker integer buffer at {offset:#x}");
        }
        Ok((0..count)
            .map(|index| unsafe { read_i64_at(pointer, index * size_of::<i64>()) })
            .collect())
    };

    let loud_records = (0..LOUD_COLUMNS)
        .map(|index| {
            let base = 0x12b8 + index * 20;
            LoudViewRecordTrace {
                adjusted_height: unsafe { read_i32_at(object, base) },
                raw_height: unsafe { read_i32_at(object, base + 4) },
                low_level: unsafe { read_i32_at(object, base + 8) },
                mid_level: unsafe { read_i32_at(object, base + 12) },
                high_level: unsafe { read_i32_at(object, base + 16) },
            }
        })
        .collect();
    let loud_output = (0..LOUD_COLUMNS)
        .map(|index| LoudViewOutputTrace {
            value: unsafe { read_f32_at(object, 0x2dc + index * 8) },
            color: unsafe { read_i32_at(object, 0x2e0 + index * 8) },
        })
        .collect();
    let dots_output = (0..DOT_COLUMNS)
        .map(|index| LoudViewOutputTrace {
            value: unsafe { read_f32_at(object, 0xf5c + index * 8) },
            color: unsafe { read_i32_at(object, 0xf60 + index * 8) },
        })
        .collect();

    Ok(LoudViewSnapshotTrace {
        frame_samples: unsafe { read_i32_at(object, 0x1288) },
        total_samples: unsafe { read_i64_at(object, 0x12a0) },
        processed_frames: unsafe { read_i64_at(object, 0x18) },
        normalization: unsafe { read_f32_at(object, 0x270) },
        loud_count: unsafe { read_i32_at(object, 0x12a8) },
        dots_count: unsafe { read_i32_at(object, 0x12b0) },
        raw_peaks: read_pointer_f32(0x250, LOUD_COLUMNS)?,
        low_peaks: read_pointer_f32(0x190, LOUD_COLUMNS)?,
        mid_peaks: read_pointer_f32(0x1a8, LOUD_COLUMNS)?,
        high_peaks: read_pointer_f32(0x1c0, LOUD_COLUMNS)?,
        loud_records,
        loud_output,
        dots_primary: read_pointer_i64(0x1d8, DOT_COLUMNS)?,
        dots_secondary: read_pointer_i64(0x200, DOT_COLUMNS)?,
        dots_output,
        dots_levels: (0..DOT_COLUMNS)
            .map(|index| unsafe { read_i32_at(object, 0x31f8 + index * 4) })
            .collect(),
    })
}

unsafe fn snapshot_u32_words(pointer: *const u8, bytes: usize) -> Result<Vec<u32>> {
    if !bytes.is_multiple_of(std::mem::size_of::<u32>()) {
        bail!("snapshot byte length {bytes} is not word aligned");
    }
    if pointer.is_null() {
        bail!("null snapshot storage for {bytes} bytes");
    }
    let words = bytes / std::mem::size_of::<u32>();
    let mut snapshot = Vec::with_capacity(words);
    for index in 0..words {
        snapshot.push(unsafe {
            (pointer.add(index * std::mem::size_of::<u32>()) as *const u32).read_unaligned()
        });
    }
    Ok(snapshot)
}

unsafe extern "C" fn trace_unit_beat_adjust_analyze(
    adjuster: *mut c_void,
    bpm: *mut f32,
    beats: *mut StdVector,
) {
    let bpm_before = if bpm.is_null() {
        f32::NAN
    } else {
        unsafe { *bpm }
    };
    let beats_before = unsafe { snapshot_internal_beats(beats) };
    let function: UnitBeatAdjustAnalyze = unsafe { original(&UNIT_BEAT_ADJUST_ANALYZE) };
    unsafe { function(adjuster, bpm, beats) };
    let bpm_after = if bpm.is_null() {
        f32::NAN
    } else {
        unsafe { *bpm }
    };
    let beats_after = unsafe { snapshot_internal_beats(beats) };
    let mut trace = trace()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match (beats_before, beats_after) {
        (Ok(beats_before), Ok(beats_after)) => {
            trace.unit_adjustments.push(UnitAdjustmentTrace {
                bpm_before,
                bpm_after,
                beats_before,
                beats_after,
            });
        }
        (before, after) => {
            if let Err(error) = before {
                trace
                    .warnings
                    .push(format!("failed to snapshot pre-adjust beats: {error:#}"));
            }
            if let Err(error) = after {
                trace
                    .warnings
                    .push(format!("failed to snapshot post-adjust beats: {error:#}"));
            }
        }
    }
}

unsafe fn snapshot_internal_beats(vector: *const StdVector) -> Result<Vec<InternalBeatTrace>> {
    if vector.is_null() {
        bail!("null beat vector");
    }
    let vector = unsafe { &*vector };
    let begin = vector.begin as usize;
    let end = vector.end as usize;
    if end < begin {
        bail!("inverted beat vector");
    }
    let bytes = end - begin;
    if !bytes.is_multiple_of(INTERNAL_BEAT_BYTES) {
        bail!("beat vector byte length {bytes} is not divisible by {INTERNAL_BEAT_BYTES}");
    }
    let count = bytes / INTERNAL_BEAT_BYTES;
    if count > MAX_TRACE_BEATS {
        bail!("beat vector count {count} exceeds trace bound {MAX_TRACE_BEATS}");
    }
    if count == 0 {
        return Ok(Vec::new());
    }
    if begin == 0 {
        bail!("null beat vector storage");
    }
    let mut result = Vec::with_capacity(count);
    for index in 0..count {
        let record = (begin + index * INTERNAL_BEAT_BYTES) as *const u8;
        result.push(InternalBeatTrace {
            position: unsafe { (record as *const i32).read_unaligned() },
            unknown_04: unsafe { (record.add(4) as *const u32).read_unaligned() },
            interval: unsafe { (record.add(8) as *const f32).read_unaligned() },
            beat: unsafe { (record.add(12) as *const i32).read_unaligned() },
            unknown_10: unsafe { (record.add(16) as *const u32).read_unaligned() },
            flags_14: unsafe { (record.add(20) as *const [u8; 4]).read_unaligned() },
        });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trace_with_beats(beats: Vec<BaBeatTrace>) -> ReferenceTrace {
        ReferenceTrace {
            engine_creates: vec![EngineCreateTrace {
                sample_rate: 48_000,
                variable_tempo: true,
                arg1: 0,
                arg2: 0,
                arg3: 0,
                arg4: 0,
                arg5: 0,
            }],
            ba_beats: beats,
            ..ReferenceTrace::default()
        }
    }

    #[test]
    fn stage_parity_uses_native_floor_milliseconds() {
        let trace = trace_with_beats(vec![
            BaBeatTrace {
                position: 22_624,
                beat: 2,
                bpm_hundredths: 12_700,
            },
            BaBeatTrace {
                position: 45_301,
                beat: 3,
                bpm_hundredths: 12_699,
            },
        ]);
        let final_beats = vec![
            BeatEntry {
                beat: 2,
                bpm: 127.0,
                time_ms: 471,
            },
            BeatEntry {
                beat: 3,
                bpm: 126.99,
                time_ms: 943,
            },
        ];

        let parity = stage_parity(&trace, &final_beats).expect("engine sample rate");
        assert!(parity.count_equal);
        assert_eq!(parity.position_to_ms_exact, 2);
        assert_eq!(parity.beat_exact, 2);
        assert_eq!(parity.bpm_exact, 2);
        assert_eq!(parity.total, 2);
        assert!(parity.first_mismatches.is_empty());
    }

    #[test]
    fn stage_parity_localizes_each_semantic_mismatch() {
        let trace = trace_with_beats(vec![BaBeatTrace {
            position: 48_000,
            beat: 1,
            bpm_hundredths: 12_000,
        }]);
        let final_beats = [BeatEntry {
            beat: 2,
            bpm: 121.0,
            time_ms: 1_001,
        }];

        let parity = stage_parity(&trace, &final_beats).expect("engine sample rate");
        assert_eq!(parity.position_to_ms_exact, 0);
        assert_eq!(parity.beat_exact, 0);
        assert_eq!(parity.bpm_exact, 0);
        assert_eq!(parity.first_mismatches.len(), 1);
        let mismatch = &parity.first_mismatches[0];
        assert_eq!(mismatch.converted_time_ms, 1_000);
        assert_eq!(mismatch.final_time_ms, 1_001);
    }

    #[test]
    fn phase_probe_summary_groups_trials_without_serializing_each_call() {
        let context = SegAdjustProbeContext {
            section_index: 2,
            lower_frame: 0.0,
            upper_frame: 1_000.0,
            period_frames: 500.0,
        };
        let mut trace = ReferenceTrace::default();
        trace.record_phase_probe(3, context, 0, 62, -1);
        trace.record_phase_probe(3, context, 500, 62, 500);
        trace.record_phase_probe(3, context, 96, 62, 100);
        trace.record_phase_probe(3, context, 596, 62, 600);
        trace.flush_phase_probe_block();

        assert_eq!(trace.phase_probe_blocks.len(), 1);
        let block = &trace.phase_probe_blocks[0];
        assert_eq!(block.trial_count, 2);
        assert_eq!(block.total_calls, 4);
        assert_eq!(block.total_hits, 3);
        let best = block.best_trial.as_ref().expect("best phase trial");
        assert_eq!(best.start_target, 96);
        assert_eq!(best.score, 116);
        assert_eq!(best.first_hit, Some(100));
    }
}
