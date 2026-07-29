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
const BEAT_SENSOR_CREATE_OFFSET: usize = 0x1389ba0;
const PEAK_SENSOR_PUT_OFFSET: usize = 0x14e7ac0;
const PEAK_BUFFER_CALC_BEAT_OFFSET: usize = 0x13894f0;
const BEAT_LIST_CHANGE_STAT_OFFSET: usize = 0x14e6910;
const BEAT_LIST_CHANGE_STAT_VTABLE_SLOT_OFFSET: usize = 0x40d7738;
const FWRITE_OFFSET: usize = 0x21dcd98;
const MALLOC_OFFSET: usize = 0x21dc954;

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
const CALL_BEAT_SENSOR_CREATE_OFFSET: usize = 0x14e60ab;
const CALL_PEAK_SENSOR_PUT_OFFSET: usize = 0x14e78ec;
const CALL_PEAK_BUFFER_CALC_BEAT_OFFSET: usize = 0x14e797f;
const CALL_CHECKPOINT_CONTINUOUS_REGION_OFFSET: usize = 0x138b51b;
const CALL_CHECKPOINT_MINIMUM_RUN_OFFSET: usize = 0x138b7d8;
const CALL_CHECKPOINT_TEMPO_FAMILY_OFFSET: usize = 0x138c5ff;
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
type BeatSensorCreate = unsafe extern "C" fn(*mut c_void, i32, i32, i32, i32, i32) -> u64;
type PeakSensorPut = unsafe extern "C" fn(*mut c_void, f32) -> u8;
type PeakBufferCalcBeat = unsafe extern "C" fn(*mut c_void, f32) -> u8;
type BeatListChangeStat = unsafe extern "C" fn(*mut c_void, f32, i32, f32, *mut c_void);
type AllocateBytes = unsafe extern "C" fn(usize) -> *mut c_void;

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
static BEAT_SENSOR_CREATE: AtomicUsize = AtomicUsize::new(0);
static PEAK_SENSOR_PUT: AtomicUsize = AtomicUsize::new(0);
static PEAK_BUFFER_CALC_BEAT: AtomicUsize = AtomicUsize::new(0);
static BEAT_LIST_CHANGE_STAT: AtomicUsize = AtomicUsize::new(0);
static PEAK_SENSOR_BASE: AtomicUsize = AtomicUsize::new(0);
static PEAK_BUFFER_BASE: AtomicUsize = AtomicUsize::new(0);
static PEAK_SENSOR_BAND_COUNT: AtomicI32 = AtomicI32::new(0);
static CURRENT_BEAT_INFO: AtomicUsize = AtomicUsize::new(0);
static MALLOC: AtomicUsize = AtomicUsize::new(0);
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
    beat_list_changes: Vec<BeatListChangeTrace>,
    analyzer_checkpoints: Vec<AnalyzerCheckpointTrace>,
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
        schema_version: 6,
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
    set_original(&BEAT_SENSOR_CREATE, base + BEAT_SENSOR_CREATE_OFFSET);
    set_original(&PEAK_SENSOR_PUT, base + PEAK_SENSOR_PUT_OFFSET);
    set_original(&PEAK_BUFFER_CALC_BEAT, base + PEAK_BUFFER_CALC_BEAT_OFFSET);
    set_original(&BEAT_LIST_CHANGE_STAT, base + BEAT_LIST_CHANGE_STAT_OFFSET);
    set_original(&MALLOC, base + MALLOC_OFFSET);

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
            base + CALL_CHECKPOINT_NEAR_VALUE_OFFSET,
            base + FWRITE_OFFSET,
            trace_checkpoint_near_value as usize,
        )?;
        patch_pointer(
            base + BEAT_LIST_CHANGE_STAT_VTABLE_SLOT_OFFSET,
            base + BEAT_LIST_CHANGE_STAT_OFFSET,
            trace_beat_list_change_stat as usize,
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
    if end < begin || (end - begin) % INTERNAL_BEAT_BYTES != 0 {
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
    let function: AllocateBytes = unsafe { original(&MALLOC) };
    unsafe { function(bytes) }
}

unsafe extern "C" fn trace_checkpoint_near_value(
    pointer: *const c_void,
    size: usize,
    count: usize,
    stream: *mut libc::FILE,
) -> usize {
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

unsafe fn snapshot_u32_words(pointer: *const u8, bytes: usize) -> Result<Vec<u32>> {
    if bytes % std::mem::size_of::<u32>() != 0 {
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
    if bytes % INTERNAL_BEAT_BYTES != 0 {
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
}
