use std::ffi::{CStr, CString};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::fd::AsRawFd;
use std::os::raw::{c_char, c_int, c_void};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::DEFAULT_ANLZ_STEM;
use crate::backend::{RekordboxOffsets, prepare_rekordbox_backend};

const TEMPLATE_SUFFIX: &str = "Library/Pioneer/rekordbox/share/PIONEER/USBANLZ";
const WAIT_SECONDS: u64 = 90;
const SETTLE_DELAY_SECONDS: u64 = 2;

pub const REHOST_WORKER_SUBCOMMAND: &str = "__rekordbox-rehost";

type GetAnalyzer = unsafe extern "C" fn() -> *mut c_void;
type JuceStringDefault = unsafe extern "C" fn(*mut c_void) -> *mut c_void;
type JuceStringCstr = unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_void;
type JuceStringDtor = unsafe extern "C" fn(*mut c_void);
type JuceStringToRawUtf8 = unsafe extern "C" fn(*mut c_void) -> *const c_char;
type StartAnalyze = unsafe extern "C" fn(
    *mut c_void,
    i64,
    *mut c_void,
    *mut c_void,
    *mut c_void,
    c_int,
    c_int,
    c_int,
    c_int,
    c_int,
    c_int,
    c_int,
    c_int,
    *mut c_void,
    c_int,
    c_int,
    *mut c_void,
) -> c_int;

#[derive(Debug, Clone)]
pub struct RehostOptions {
    pub audio_path: PathBuf,
    pub output_dir: PathBuf,
    pub native_log_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RehostResult {
    pub backend: String,
    pub binary: String,
    #[serde(rename = "audioPath")]
    pub audio_path: String,
    #[serde(rename = "analyzePath")]
    pub analyze_path: String,
    #[serde(rename = "contentId")]
    pub content_id: i64,
    #[serde(rename = "startResult")]
    pub start_result: i32,
    #[serde(rename = "callbackStatus")]
    pub callback_status: Option<i32>,
    #[serde(rename = "callbackError")]
    pub callback_error: Option<String>,
    #[serde(rename = "nativeLog")]
    pub native_log: String,
    pub outputs: Vec<(String, u64)>,
    pub summary: OutputSummary,
}

impl RehostResult {
    pub fn success(&self) -> bool {
        self.start_result == 0
            && self
                .outputs
                .iter()
                .any(|(path, size)| path.to_ascii_uppercase().ends_with(".EXT") && *size > 4096)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputSummary {
    pub files: Vec<AnlzFileSummary>,
    pub tempo_bpm: Option<f64>,
    pub beat_grid: Option<BeatGridSummary>,
    pub key: Option<String>,
    pub key_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnlzFileSummary {
    pub path: String,
    pub size: u64,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BeatGridSummary {
    pub beat_count: usize,
    pub avg_bpm: f64,
    pub min_bpm: f64,
    pub max_bpm: f64,
    pub first_downbeat_ms: u32,
    pub last_beat_ms: u32,
    pub first_beats: Vec<BeatEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BeatEntry {
    pub beat: u16,
    pub bpm: f64,
    pub time_ms: u32,
}

#[derive(Debug)]
struct AnlzTag {
    tag: String,
    offset: usize,
    total_len: usize,
}

pub fn run_rehost(options: RehostOptions) -> Result<RehostResult> {
    ensure_x86_64_worker()?;

    let audio_path = options
        .audio_path
        .canonicalize()
        .with_context(|| format!("audio file not found: {}", options.audio_path.display()))?;
    if !audio_path.is_file() {
        bail!("audio file not found: {}", audio_path.display());
    }

    let output_dir = expand_home(&options.output_dir);
    let native_log = options
        .native_log_path
        .as_ref()
        .map(|path| expand_home(path))
        .unwrap_or_else(|| output_dir.join("rehost-native.log"));
    let content_id = content_id();
    let backend = prepare_rekordbox_backend()?;
    let binary = backend.cache.cached_binary.clone();
    let (dat_path, initial_mtimes) = prepare_output(
        &default_template_dir()?,
        &output_dir,
        DEFAULT_ANLZ_STEM,
        &audio_path,
    )?;

    let mut rehost_output = NativeOutputRedirect::start(&native_log)?;
    let mut rehost = unsafe { Rehost::load(&binary, backend.offsets)? };
    let start_result = unsafe { rehost.analyze(&audio_path, &dat_path, content_id)? };
    let outputs = wait_for_completion(
        &dat_path,
        &initial_mtimes,
        Duration::from_secs(WAIT_SECONDS),
        rehost.callback_state(),
    );
    std::thread::sleep(Duration::from_secs(SETTLE_DELAY_SECONDS));
    let callback_status = rehost.callback_state().status;
    let callback_error = rehost.callback_state().error.clone();
    let key = rehost.callback_state().key.clone();
    rehost_output.restore()?;

    Ok(RehostResult {
        backend: "rekordbox-dlopen-rehost".to_string(),
        binary: binary.display().to_string(),
        audio_path: audio_path.display().to_string(),
        analyze_path: dat_path.display().to_string(),
        content_id,
        start_result,
        callback_status,
        callback_error,
        native_log: native_log.display().to_string(),
        outputs,
        summary: summarize_outputs(&dat_path, key)?,
    })
}

#[cfg(target_arch = "x86_64")]
fn ensure_x86_64_worker() -> Result<()> {
    Ok(())
}

#[cfg(not(target_arch = "x86_64"))]
fn ensure_x86_64_worker() -> Result<()> {
    bail!("Rekordbox rehost must run inside the x86_64 worker process")
}

struct NativeOutputRedirect {
    stdout_copy: c_int,
    stderr_copy: c_int,
    restored: bool,
}

impl NativeOutputRedirect {
    fn start(log_path: &Path) -> Result<Self> {
        if let Some(parent) = log_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)
            .with_context(|| format!("failed to open {}", log_path.display()))?;
        let stdout_copy = unsafe { libc::dup(libc::STDOUT_FILENO) };
        let stderr_copy = unsafe { libc::dup(libc::STDERR_FILENO) };
        if stdout_copy < 0 || stderr_copy < 0 {
            bail!("failed to duplicate stdout/stderr");
        }
        if unsafe { libc::dup2(log.as_raw_fd(), libc::STDOUT_FILENO) } < 0 {
            bail!("failed to redirect stdout");
        }
        if unsafe { libc::dup2(log.as_raw_fd(), libc::STDERR_FILENO) } < 0 {
            bail!("failed to redirect stderr");
        }
        Ok(Self {
            stdout_copy,
            stderr_copy,
            restored: false,
        })
    }

    fn restore(&mut self) -> Result<()> {
        if self.restored {
            return Ok(());
        }
        unsafe {
            libc::fflush(std::ptr::null_mut());
            if libc::dup2(self.stdout_copy, libc::STDOUT_FILENO) < 0 {
                bail!("failed to restore stdout");
            }
            if libc::dup2(self.stderr_copy, libc::STDERR_FILENO) < 0 {
                bail!("failed to restore stderr");
            }
            libc::close(self.stdout_copy);
            libc::close(self.stderr_copy);
        }
        self.restored = true;
        Ok(())
    }
}

impl Drop for NativeOutputRedirect {
    fn drop(&mut self) {
        let _ = self.restore();
    }
}

struct Rehost {
    _handle: *mut c_void,
    get_analyzer: GetAnalyzer,
    string_default: JuceStringDefault,
    string_cstr: JuceStringCstr,
    string_dtor: JuceStringDtor,
    start_analyze: StartAnalyze,
    callback: AnalyzerCallback,
}

impl Rehost {
    unsafe fn load(binary: &Path, offsets: RekordboxOffsets) -> Result<Self> {
        let c_path = CString::new(binary.to_string_lossy().as_bytes())?;
        let handle = unsafe { libc::dlopen(c_path.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
        if handle.is_null() {
            let error = unsafe {
                let raw = libc::dlerror();
                if raw.is_null() {
                    "unknown dlopen error".to_string()
                } else {
                    CStr::from_ptr(raw).to_string_lossy().to_string()
                }
            };
            bail!("failed to dlopen {}: {error}", binary.display());
        }
        let base = unsafe { find_image_base(binary)? };
        let string_to_raw_utf8: JuceStringToRawUtf8 =
            unsafe { function_at(base + offsets.juce_string_to_raw_utf8) };
        let rehost = Self {
            _handle: handle,
            get_analyzer: unsafe { function_at(base + offsets.get_analyzer) },
            string_default: unsafe { function_at(base + offsets.juce_string_default) },
            string_cstr: unsafe { function_at(base + offsets.juce_string_cstr) },
            string_dtor: unsafe { function_at(base + offsets.juce_string_dtor) },
            start_analyze: unsafe { function_at(base + offsets.start_analyze) },
            callback: AnalyzerCallback::new(string_to_raw_utf8),
        };
        unsafe { force_key_analysis(base, offsets.force_key_analysis_patch)? };
        Ok(rehost)
    }

    unsafe fn analyze(
        &mut self,
        audio_path: &Path,
        dat_path: &Path,
        content_id: i64,
    ) -> Result<i32> {
        let analyzer = unsafe { (self.get_analyzer)() };
        if analyzer.is_null() {
            bail!("CAnalyzerIF::getInstance returned null");
        }

        let mut audio = unsafe {
            JuceString::new(
                self.string_default,
                self.string_cstr,
                self.string_dtor,
                Some(&audio_path.display().to_string()),
            )?
        };
        let mut anlz = unsafe {
            JuceString::new(
                self.string_default,
                self.string_cstr,
                self.string_dtor,
                Some(&dat_path.display().to_string()),
            )?
        };
        let mut aux = unsafe {
            JuceString::new(
                self.string_default,
                self.string_cstr,
                self.string_dtor,
                None,
            )?
        };
        let mut cloud = [0u8; 16];
        let result = unsafe {
            (self.start_analyze)(
                analyzer,
                content_id,
                audio.as_mut_ptr(),
                anlz.as_mut_ptr(),
                aux.as_mut_ptr(),
                1,
                1,
                1,
                0,
                1,
                1,
                0,
                0,
                cloud.as_mut_ptr().cast(),
                0,
                0,
                self.callback.as_mut_ptr(),
            )
        };
        Ok(result)
    }

    fn callback_state(&self) -> &CallbackState {
        self.callback.state()
    }
}

impl Drop for Rehost {
    fn drop(&mut self) {
        unsafe {
            libc::dlclose(self._handle);
        }
    }
}

unsafe fn function_at<T>(address: usize) -> T {
    unsafe { std::mem::transmute_copy::<usize, T>(&address) }
}

unsafe extern "C" {
    fn _dyld_image_count() -> u32;
    fn _dyld_get_image_name(image_index: u32) -> *const c_char;
    fn _dyld_get_image_header(image_index: u32) -> *const c_void;
}

unsafe fn find_image_base(binary: &Path) -> Result<usize> {
    let target = binary
        .canonicalize()
        .unwrap_or_else(|_| binary.to_path_buf())
        .display()
        .to_string();
    let private_target = target
        .strip_prefix("/tmp/")
        .map(|rest| format!("/private/tmp/{rest}"));
    for index in 0..unsafe { _dyld_image_count() } {
        let raw_name = unsafe { _dyld_get_image_name(index) };
        if raw_name.is_null() {
            continue;
        }
        let name = unsafe { CStr::from_ptr(raw_name) }.to_string_lossy();
        if name == target || private_target.as_deref() == Some(name.as_ref()) {
            let header = unsafe { _dyld_get_image_header(index) };
            if header.is_null() {
                bail!("dyld image header is null for {}", binary.display());
            }
            return Ok(header as usize);
        }
    }
    bail!("dyld image not found for {}", binary.display())
}

unsafe fn force_key_analysis(base: usize, patch_offset: usize) -> Result<()> {
    let address = base + patch_offset;
    let current = unsafe { std::slice::from_raw_parts(address as *const u8, 3) };
    if current == [0xb0, 0x01, 0x90] {
        return Ok(());
    }
    if current != [0x8a, 0x45, 0xd7] {
        bail!(
            "unexpected start_analyze key patch bytes at {address:#x}: {:02x}{:02x}{:02x}",
            current[0],
            current[1],
            current[2]
        );
    }

    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if page_size <= 0 {
        bail!("failed to resolve system page size");
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
        bail!("mprotect failed for key-analysis patch");
    }
    unsafe {
        std::ptr::copy_nonoverlapping([0xb0, 0x01, 0x90].as_ptr(), address as *mut u8, 3);
    }
    Ok(())
}

struct JuceString {
    buffer: [u8; 8],
    dtor: JuceStringDtor,
}

impl JuceString {
    unsafe fn new(
        default: JuceStringDefault,
        cstr: JuceStringCstr,
        dtor: JuceStringDtor,
        text: Option<&str>,
    ) -> Result<Self> {
        let mut string = Self {
            buffer: [0; 8],
            dtor,
        };
        match text {
            Some(text) => {
                let c_text = CString::new(text)?;
                unsafe { cstr(string.as_mut_ptr(), c_text.as_ptr()) };
            }
            None => {
                unsafe { default(string.as_mut_ptr()) };
            }
        }
        Ok(string)
    }

    fn as_mut_ptr(&mut self) -> *mut c_void {
        self.buffer.as_mut_ptr().cast()
    }
}

impl Drop for JuceString {
    fn drop(&mut self) {
        unsafe {
            (self.dtor)(self.as_mut_ptr());
        }
    }
}

#[repr(C)]
struct CallbackObject {
    vtable: *mut *const c_void,
    state: *mut CallbackState,
}

struct CallbackState {
    string_to_raw_utf8: JuceStringToRawUtf8,
    status: Option<i32>,
    key: Option<String>,
    error: Option<String>,
}

struct AnalyzerCallback {
    object: Box<CallbackObject>,
    _vtable: Box<[*const c_void; 24]>,
    state: Box<CallbackState>,
}

impl AnalyzerCallback {
    fn new(string_to_raw_utf8: JuceStringToRawUtf8) -> Self {
        let mut state = Box::new(CallbackState {
            string_to_raw_utf8,
            status: None,
            key: None,
            error: None,
        });
        let mut vtable = Box::new([generic_callback as *const c_void; 24]);
        vtable[2] = progress_callback as *const c_void;
        vtable[5] = complete_callback as *const c_void;
        let object = Box::new(CallbackObject {
            vtable: vtable.as_mut_ptr(),
            state: state.as_mut() as *mut CallbackState,
        });
        Self {
            object,
            _vtable: vtable,
            state,
        }
    }

    fn as_mut_ptr(&mut self) -> *mut c_void {
        self.object.as_mut() as *mut CallbackObject as *mut c_void
    }

    fn state(&self) -> &CallbackState {
        &self.state
    }
}

extern "C" fn generic_callback(
    _a: *mut c_void,
    _b: *mut c_void,
    _c: *mut c_void,
    _d: *mut c_void,
    _e: *mut c_void,
    _f: *mut c_void,
    _g: *mut c_void,
    _h: *mut c_void,
    _i: *mut c_void,
    _j: *mut c_void,
) {
}

extern "C" fn progress_callback(_this: *mut c_void, _content_id: *mut c_void) {}

extern "C" fn complete_callback(
    this: *mut c_void,
    _content_id: i64,
    _cloud_name: *mut c_void,
    status: c_int,
    _beat_info: *mut c_void,
    key_string: *mut c_void,
) {
    if this.is_null() {
        return;
    }
    let object = unsafe { &mut *(this as *mut CallbackObject) };
    if object.state.is_null() {
        return;
    }
    let state = unsafe { &mut *object.state };
    state.status = Some(status);
    if key_string.is_null() {
        return;
    }
    let raw = unsafe { (state.string_to_raw_utf8)(key_string) };
    if raw.is_null() {
        return;
    }
    match unsafe { CStr::from_ptr(raw) }.to_str() {
        Ok(value) if !value.is_empty() => state.key = Some(value.to_string()),
        Ok(_) => {}
        Err(error) => state.error = Some(error.to_string()),
    }
}

fn be16(data: &[u8], offset: usize) -> Option<u16> {
    data.get(offset..offset + 2)
        .map(|bytes| u16::from_be_bytes([bytes[0], bytes[1]]))
}

fn be32(data: &[u8], offset: usize) -> Option<u32> {
    data.get(offset..offset + 4)
        .map(|bytes| u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn iter_anlz_tags(path: &Path) -> Result<Vec<AnlzTag>> {
    let data = std::fs::read(path).with_context(|| format!("failed to read {}", path.display()))?;
    iter_anlz_tags_from_bytes(&data)
        .with_context(|| format!("not a valid ANLZ file: {}", path.display()))
}

fn iter_anlz_tags_from_bytes(data: &[u8]) -> Result<Vec<AnlzTag>> {
    if data.get(..4) != Some(b"PMAI") {
        bail!("missing PMAI header");
    }
    let mut offset = be32(data, 4).context("missing PMAI tag start")? as usize;
    let mut tags = Vec::new();
    while offset + 12 <= data.len() {
        let tag = String::from_utf8_lossy(&data[offset..offset + 4]).to_string();
        let header_len = be32(data, offset + 4).context("missing tag header length")? as usize;
        let total_len = be32(data, offset + 8).context("missing tag total length")? as usize;
        if header_len < 12 || total_len < header_len || offset + total_len > data.len() {
            break;
        }
        tags.push(AnlzTag {
            tag,
            offset,
            total_len,
        });
        offset += total_len;
    }
    Ok(tags)
}

fn parse_pqtz(path: &Path) -> Result<Option<BeatGridSummary>> {
    let data = std::fs::read(path).with_context(|| format!("failed to read {}", path.display()))?;
    for tag in iter_anlz_tags_from_bytes(&data)? {
        if tag.tag != "PQTZ" {
            continue;
        }
        let count = be32(&data, tag.offset + 20).unwrap_or(0) as usize;
        let entry_offset = tag.offset + 24;
        let max_count = tag.total_len.saturating_sub(24) / 8;
        let mut entries = Vec::new();
        for index in 0..count.min(max_count) {
            let offset = entry_offset + (index * 8);
            let Some(beat) = be16(&data, offset) else {
                break;
            };
            let Some(bpm) = be16(&data, offset + 2) else {
                break;
            };
            let Some(time_ms) = be32(&data, offset + 4) else {
                break;
            };
            entries.push(BeatEntry {
                beat,
                bpm: f64::from(bpm) / 100.0,
                time_ms,
            });
        }
        if entries.is_empty() {
            return Ok(None);
        }
        let sum = entries.iter().map(|entry| entry.bpm).sum::<f64>();
        let avg = (sum / entries.len() as f64 * 1_000_000.0).round() / 1_000_000.0;
        let min = entries
            .iter()
            .map(|entry| entry.bpm)
            .fold(f64::INFINITY, f64::min);
        let max = entries
            .iter()
            .map(|entry| entry.bpm)
            .fold(f64::NEG_INFINITY, f64::max);
        let first_downbeat_ms = entries
            .iter()
            .find(|entry| entry.beat == 1)
            .unwrap_or(&entries[0])
            .time_ms;
        let last_beat_ms = entries
            .last()
            .map(|entry| entry.time_ms)
            .unwrap_or_default();
        return Ok(Some(BeatGridSummary {
            beat_count: entries.len(),
            avg_bpm: avg,
            min_bpm: min,
            max_bpm: max,
            first_downbeat_ms,
            last_beat_ms,
            first_beats: entries.into_iter().take(8).collect(),
        }));
    }
    Ok(None)
}

fn summarize_outputs(dat_path: &Path, key: Option<String>) -> Result<OutputSummary> {
    let mut files = Vec::new();
    for suffix in ["DAT", "EXT", "2EX"] {
        let path = dat_path.with_extension(suffix);
        if !path.exists() {
            continue;
        }
        files.push(AnlzFileSummary {
            path: path.display().to_string(),
            size: path.metadata()?.len(),
            tags: iter_anlz_tags(&path)?
                .into_iter()
                .map(|tag| tag.tag)
                .collect(),
        });
    }
    let beat_grid = if dat_path.exists() {
        parse_pqtz(dat_path)?
    } else {
        None
    };
    Ok(OutputSummary {
        tempo_bpm: beat_grid.as_ref().map(|grid| grid.avg_bpm),
        files,
        beat_grid,
        key_source: key
            .as_ref()
            .map(|_| "rekordbox-notify-complete".to_string()),
        key,
    })
}

fn find_template_files(template_dir: &Path) -> Result<Vec<(&'static str, PathBuf)>> {
    let mut out = Vec::new();
    for suffix in ["DAT", "EXT"] {
        let mut matches = walkdir::WalkDir::new(template_dir)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file())
            .map(|entry| entry.into_path())
            .filter(|path| {
                path.extension()
                    .and_then(|value| value.to_str())
                    .map(|value| value.eq_ignore_ascii_case(suffix))
                    .unwrap_or(false)
            })
            .collect::<Vec<_>>();
        matches.sort();
        let Some(path) = matches.into_iter().next() else {
            bail!(
                "missing ANLZ template file in {}: {suffix}",
                template_dir.display()
            );
        };
        out.push((suffix, path));
    }
    Ok(out)
}

fn ppth_tag(audio_path: &Path) -> Vec<u8> {
    let name = audio_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let mut text = Vec::new();
    for unit in format!("?/{name}\0").encode_utf16() {
        text.extend(unit.to_be_bytes());
    }
    let total_len = 16 + text.len();
    let mut out = Vec::with_capacity(total_len);
    out.extend(b"PPTH");
    out.extend(16u32.to_be_bytes());
    out.extend((total_len as u32).to_be_bytes());
    out.extend((text.len() as u32).to_be_bytes());
    out.extend(text);
    out
}

fn clean_seed_from_template(template: &Path, output: &Path, audio_path: &Path) -> Result<()> {
    let data = std::fs::read(template)
        .with_context(|| format!("failed to read {}", template.display()))?;
    if data.get(..4) != Some(b"PMAI") {
        bail!("not an ANLZ template: {}", template.display());
    }

    let header_len = be32(&data, 4).context("missing PMAI tag start")? as usize;
    let mut seed_header = data
        .get(..header_len)
        .context("invalid PMAI header length")?
        .to_vec();
    let mut offset = header_len;
    let mut tags = Vec::<Vec<u8>>::new();
    while offset + 12 <= data.len() {
        let tag = String::from_utf8_lossy(&data[offset..offset + 4]).to_string();
        let header_len = be32(&data, offset + 4).context("missing tag header length")? as usize;
        let total_len = be32(&data, offset + 8).context("missing tag total length")? as usize;
        if header_len < 12 || total_len < header_len || offset + total_len > data.len() {
            break;
        }

        if tag == "PPTH" {
            tags.push(ppth_tag(audio_path));
        } else if tag == "PCOB" || tag == "PCO2" {
            tags.push(data[offset..offset + total_len].to_vec());
        } else {
            let mut cleaned = data[offset..offset + header_len].to_vec();
            cleaned.extend(std::iter::repeat_n(0, total_len - header_len));
            tags.push(cleaned);
        }
        offset += total_len;
    }

    let file_len = seed_header.len() + tags.iter().map(Vec::len).sum::<usize>();
    seed_header[8..12].copy_from_slice(&(file_len as u32).to_be_bytes());
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    let mut file =
        File::create(output).with_context(|| format!("failed to write {}", output.display()))?;
    file.write_all(&seed_header)?;
    for tag in tags {
        file.write_all(&tag)?;
    }
    Ok(())
}

fn prepare_output(
    template_dir: &Path,
    output_dir: &Path,
    stem: &str,
    audio_path: &Path,
) -> Result<(PathBuf, Vec<(&'static str, SystemTime)>)> {
    let templates = find_template_files(template_dir)?;
    std::fs::create_dir_all(output_dir)
        .with_context(|| format!("failed to create {}", output_dir.display()))?;
    let stale_twoex = output_dir.join(format!("{stem}.2EX"));
    if stale_twoex.exists() {
        std::fs::remove_file(&stale_twoex)
            .with_context(|| format!("failed to remove {}", stale_twoex.display()))?;
    }

    let seed_mtime = UNIX_EPOCH + Duration::from_secs(631_180_800);
    let mut initial_mtimes = Vec::new();
    for (suffix, template) in templates {
        let output = output_dir.join(format!("{stem}.{suffix}"));
        clean_seed_from_template(&template, &output, audio_path)?;
        set_mtime(&output, seed_mtime)?;
        initial_mtimes.push((suffix, output.metadata()?.modified()?));
    }
    Ok((output_dir.join(format!("{stem}.DAT")), initial_mtimes))
}

fn wait_for_completion(
    dat_path: &Path,
    initial_mtimes: &[(&str, SystemTime)],
    timeout: Duration,
    callback: &CallbackState,
) -> Vec<(String, u64)> {
    let deadline = SystemTime::now() + timeout;
    let paths = ["DAT", "EXT", "2EX"]
        .into_iter()
        .map(|suffix| (suffix, dat_path.with_extension(suffix)))
        .collect::<Vec<_>>();
    let mut last = Vec::new();
    let mut saw_primary_outputs = false;
    let mut previous_primary_sizes = None;
    let mut stable_primary_ticks = 0usize;

    while SystemTime::now() < deadline {
        last = paths
            .iter()
            .filter(|(_, path)| path.exists())
            .filter_map(|(_, path)| {
                path.metadata()
                    .ok()
                    .map(|metadata| (path.display().to_string(), metadata.len()))
            })
            .collect();
        let changed = |suffix: &str| -> bool {
            let Some((_, initial_mtime)) = initial_mtimes
                .iter()
                .find(|(initial_suffix, _)| *initial_suffix == suffix)
            else {
                return false;
            };
            let path = dat_path.with_extension(suffix);
            path.exists()
                && path
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .map(|mtime| mtime != *initial_mtime)
                    .unwrap_or(false)
        };
        saw_primary_outputs = saw_primary_outputs || (changed("DAT") && changed("EXT"));
        if saw_primary_outputs && callback.status.is_some() {
            return last;
        }
        if saw_primary_outputs {
            let primary_sizes = paths
                .iter()
                .filter(|(suffix, _)| matches!(*suffix, "DAT" | "EXT" | "2EX"))
                .filter_map(|(suffix, path)| {
                    path.metadata()
                        .ok()
                        .map(|metadata| ((*suffix).to_string(), metadata.len()))
                })
                .collect::<Vec<_>>();
            if previous_primary_sizes.as_ref() == Some(&primary_sizes) {
                stable_primary_ticks = stable_primary_ticks.saturating_add(1);
            } else {
                previous_primary_sizes = Some(primary_sizes);
                stable_primary_ticks = 0;
            }
            if stable_primary_ticks >= 3 {
                return last;
            }
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    last
}

fn default_template_dir() -> Result<PathBuf> {
    dirs::home_dir()
        .map(|home| home.join(TEMPLATE_SUFFIX))
        .context("failed to resolve home directory")
}

fn content_id() -> i64 {
    (SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        & 0x7fff_ffff) as i64
}

fn expand_home(path: &Path) -> PathBuf {
    if path == Path::new("~") {
        return dirs::home_dir().unwrap_or_else(|| path.to_path_buf());
    }
    let raw = path.to_string_lossy();
    if let Some(rest) = raw.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    path.to_path_buf()
}

#[cfg(target_os = "macos")]
fn set_mtime(path: &Path, mtime: SystemTime) -> Result<()> {
    use std::os::unix::ffi::OsStrExt;

    let c_path = CString::new(path.as_os_str().as_bytes())?;
    let seconds = mtime.duration_since(UNIX_EPOCH)?.as_secs() as libc::time_t;
    let times = [
        libc::timespec {
            tv_sec: seconds,
            tv_nsec: 0,
        },
        libc::timespec {
            tv_sec: seconds,
            tv_nsec: 0,
        },
    ];
    if unsafe { libc::utimensat(libc::AT_FDCWD, c_path.as_ptr(), times.as_ptr(), 0) } != 0 {
        bail!("failed to set mtime for {}", path.display());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ppth_tag_uses_utf16_be_audio_basename() {
        let tag = ppth_tag(Path::new("/tmp/Artist - Track.mp3"));
        assert_eq!(&tag[..4], b"PPTH");
        assert_eq!(be32(&tag, 4), Some(16));
        assert_eq!(be32(&tag, 8), Some(tag.len() as u32));
        assert_eq!(be32(&tag, 12), Some((tag.len() - 16) as u32));
        assert!(tag.windows(2).any(|window| window == b"m\0"));
    }

    #[test]
    fn iter_anlz_tags_reads_valid_tags() {
        let data = fixture_anlz_with_pqtz();
        let tags = iter_anlz_tags_from_bytes(&data).expect("tags");
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].tag, "PQTZ");
        assert_eq!(tags[0].total_len, 40);
    }

    #[test]
    fn parse_pqtz_summarizes_beat_grid() {
        let temp = tempfile::NamedTempFile::new().expect("temp");
        std::fs::write(temp.path(), fixture_anlz_with_pqtz()).expect("write");
        let summary = parse_pqtz(temp.path()).expect("parse").expect("beat grid");
        assert_eq!(summary.beat_count, 2);
        assert_eq!(summary.avg_bpm, 120.0);
        assert_eq!(summary.first_downbeat_ms, 100);
        assert_eq!(summary.last_beat_ms, 600);
    }

    fn fixture_anlz_with_pqtz() -> Vec<u8> {
        let mut data = Vec::new();
        data.extend(b"PMAI");
        data.extend(12u32.to_be_bytes());
        data.extend(52u32.to_be_bytes());
        data.extend(b"PQTZ");
        data.extend(24u32.to_be_bytes());
        data.extend(40u32.to_be_bytes());
        data.extend([0u8; 8]);
        data.extend(2u32.to_be_bytes());
        data.extend(1u16.to_be_bytes());
        data.extend(12000u16.to_be_bytes());
        data.extend(100u32.to_be_bytes());
        data.extend(2u16.to_be_bytes());
        data.extend(12000u16.to_be_bytes());
        data.extend(600u32.to_be_bytes());
        data
    }
}
