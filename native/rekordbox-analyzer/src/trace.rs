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
const ENGINE_SELECTION_BRANCH_OFFSET: usize = 0x1068a0c;

const INTERNAL_BEAT_BYTES: usize = 24;
const MAX_TRACE_BEATS: usize = 100_000;
const ENV_TRACE_ENGINE: &str = "REKORDBOX_ANALYZER_TRACE_ENGINE";

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
static LAST_BEAT_COUNT: AtomicI32 = AtomicI32::new(0);
static TRACE: OnceLock<Mutex<ReferenceTrace>> = OnceLock::new();

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReferenceTrace {
    schema_version: u32,
    requested_engine: String,
    engine_creates: Vec<EngineCreateTrace>,
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
        schema_version: 2,
        requested_engine: requested_engine().to_string(),
        ..ReferenceTrace::default()
    };
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
    let function: BeatInfoAnalyze = unsafe { original(&BEAT_INFO_ANALYZE) };
    let bpm = unsafe { function(analyzer, info, output, arg3, arg4, arg5, arg6, arg7) };
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
