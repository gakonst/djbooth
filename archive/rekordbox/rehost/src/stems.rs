use std::ffi::{CStr, CString, c_char, c_void};
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};
use rekordbox_analyzer_core::{STEMS_CHUNK_SAMPLES, plan_stems_chunks};
use serde::Serialize;
use sha2::{Digest, Sha256};

const DEFAULT_SAMPLE_COUNT: usize = 44_100;

type SeparatorInitialize = unsafe extern "C" fn(*const c_char, u32, u32, u8);
type SeparatorFinalize = unsafe extern "C" fn();
type SeparatorIsInitialized = unsafe extern "C" fn() -> u8;
type SeparatorPreOperation =
    unsafe extern "C" fn(*mut *mut c_void, u32, u8, u8, u8, *mut f32, *mut f32) -> u8;
type SeparatorPostOperation = unsafe extern "C" fn(*mut c_void);
type SeparatorOperationAtIndex = unsafe extern "C" fn(
    *mut c_void,
    i32,
    *mut f32,
    *mut f32,
    *mut f32,
    *mut f32,
    *mut f32,
    *mut f32,
    *mut f32,
    *mut f32,
) -> u8;
type SeparatorOperationAtOnce = unsafe extern "C" fn(
    u32,
    *mut f32,
    *mut f32,
    *mut f32,
    *mut f32,
    *mut f32,
    *mut f32,
    *mut f32,
    *mut f32,
) -> u8;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StemsProbeResult {
    pub backend: &'static str,
    pub sample_count: usize,
    pub sample_rate: u32,
    pub model_path: String,
    pub operation_succeeded: bool,
    pub streaming_matches_at_once: bool,
    pub channels: Vec<StemsProbeChannel>,
    pub reconstruction: Vec<StemsProbeReconstruction>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StemsProbeChannel {
    pub output: usize,
    pub stem: &'static str,
    pub side: &'static str,
    pub finite_samples: usize,
    pub rms: f64,
    pub peak: f32,
    pub mean: f64,
    pub sha256_le_f32: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StemsProbeReconstruction {
    pub side: &'static str,
    pub rms_error: f64,
    pub peak_error: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StemsSeparationResult {
    pub backend: &'static str,
    pub audio_path: String,
    pub model_path: String,
    pub sample_count: usize,
    pub sample_rate: u32,
    pub duration_seconds: f64,
    pub outputs: Vec<StemsOutputFile>,
    pub reconstruction: Vec<StemsProbeReconstruction>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StemsOutputFile {
    pub stem: &'static str,
    pub path: String,
    pub frames: usize,
    pub sha256_le_f32: String,
}

pub fn run_stems_probe(app_path: &Path, sample_count: Option<usize>) -> Result<StemsProbeResult> {
    run_stems_probe_impl(app_path, sample_count.unwrap_or(DEFAULT_SAMPLE_COUNT))
}

pub fn run_stems_separation(
    app_path: &Path,
    audio_path: &Path,
    output_dir: &Path,
) -> Result<StemsSeparationResult> {
    run_stems_separation_impl(app_path, audio_path, output_dir)
}

#[cfg(not(target_arch = "x86_64"))]
fn run_stems_probe_impl(_app_path: &Path, _sample_count: usize) -> Result<StemsProbeResult> {
    bail!("Rekordbox Stems probe must run inside an x86_64 worker process")
}

#[cfg(not(target_arch = "x86_64"))]
fn run_stems_separation_impl(
    _app_path: &Path,
    _audio_path: &Path,
    _output_dir: &Path,
) -> Result<StemsSeparationResult> {
    bail!("Rekordbox Stems separation must run inside an x86_64 worker process")
}

#[cfg(target_arch = "x86_64")]
fn run_stems_probe_impl(app_path: &Path, sample_count: usize) -> Result<StemsProbeResult> {
    if sample_count == 0 || sample_count > u32::MAX as usize {
        bail!("sample count must be between 1 and {}", u32::MAX);
    }

    let (mut input_left, mut input_right) = synthetic_stereo(sample_count);
    let (model_path, outputs, streaming_matches_at_once) =
        separate_stereo(app_path, &mut input_left, &mut input_right, true)?;

    let sides = ["left", "right"];
    let stems = ["instrumental", "vocals", "drums"];
    let channels = outputs
        .iter()
        .enumerate()
        .map(|(index, samples)| {
            summarize_channel(index / 2, stems[index / 2], sides[index % 2], samples)
        })
        .collect::<Vec<_>>();
    let reconstruction = reconstruction_metrics(&input_left, &input_right, &outputs);

    Ok(StemsProbeResult {
        backend: "rekordbox-6.8.2-libspleeter",
        sample_count,
        sample_rate: 44_100,
        model_path: model_path.display().to_string(),
        operation_succeeded: true,
        streaming_matches_at_once: streaming_matches_at_once.unwrap_or(false),
        channels,
        reconstruction,
    })
}

#[cfg(target_arch = "x86_64")]
fn run_stems_separation_impl(
    app_path: &Path,
    audio_path: &Path,
    output_dir: &Path,
) -> Result<StemsSeparationResult> {
    require_file(audio_path)?;
    std::fs::create_dir_all(output_dir)
        .with_context(|| format!("failed to create {}", output_dir.display()))?;
    let stems = ["instrumental", "vocals", "drums"];
    let output_paths = stems.map(|stem| output_dir.join(format!("{stem}.wav")));
    for path in &output_paths {
        if path.exists() {
            bail!(
                "refusing to overwrite existing Stems output {}",
                path.display()
            );
        }
    }

    let (mut left, mut right) = decode_stereo_with_ffmpeg(audio_path)?;
    let sample_count = left.len();
    let (model_path, outputs, _) = separate_stereo(app_path, &mut left, &mut right, false)?;
    let reconstruction = reconstruction_metrics(&left, &right, &outputs);

    let mut output_files = Vec::with_capacity(stems.len());
    for (index, stem) in stems.into_iter().enumerate() {
        let path = &output_paths[index];
        write_float_wav(&path, &outputs[index * 2], &outputs[index * 2 + 1])?;
        let mut hasher = Sha256::new();
        for frame in outputs[index * 2].iter().zip(&outputs[index * 2 + 1]) {
            hasher.update(frame.0.to_le_bytes());
            hasher.update(frame.1.to_le_bytes());
        }
        output_files.push(StemsOutputFile {
            stem,
            path: path.display().to_string(),
            frames: sample_count,
            sha256_le_f32: format!("{:x}", hasher.finalize()),
        });
    }

    Ok(StemsSeparationResult {
        backend: "rekordbox-6.8.2-libspleeter",
        audio_path: audio_path.display().to_string(),
        model_path: model_path.display().to_string(),
        sample_count,
        sample_rate: 44_100,
        duration_seconds: sample_count as f64 / 44_100.0,
        outputs: output_files,
        reconstruction,
    })
}

fn reconstruction_metrics(
    input_left: &[f32],
    input_right: &[f32],
    outputs: &[Vec<f32>; 6],
) -> Vec<StemsProbeReconstruction> {
    [(input_left, "left", 0usize), (input_right, "right", 1usize)]
        .into_iter()
        .map(|(input, side, offset)| {
            let mut squared_error = 0.0_f64;
            let mut peak_error = 0.0_f32;
            for (index, expected) in input.iter().copied().enumerate() {
                let actual = outputs[offset][index]
                    + outputs[offset + 2][index]
                    + outputs[offset + 4][index];
                let error = actual - expected;
                squared_error += f64::from(error) * f64::from(error);
                peak_error = peak_error.max(error.abs());
            }
            StemsProbeReconstruction {
                side,
                rms_error: (squared_error / input.len() as f64).sqrt(),
                peak_error,
            }
        })
        .collect()
}

#[cfg(target_arch = "x86_64")]
fn separate_stereo(
    app_path: &Path,
    input_left: &mut [f32],
    input_right: &mut [f32],
    compare_at_once: bool,
) -> Result<(PathBuf, [Vec<f32>; 6], Option<bool>)> {
    if input_left.is_empty() || input_left.len() != input_right.len() {
        bail!(
            "Stems input channels must have one equal nonzero length; left={}, right={}",
            input_left.len(),
            input_right.len()
        );
    }
    if input_left.len() > u32::MAX as usize {
        bail!("Stems input exceeds the native 32-bit sample-count limit");
    }

    let contents = app_path.join("Contents");
    let frameworks = contents.join("Frameworks");
    let model_path = contents.join("Resources/models/spleeter_model");
    require_file(&model_path.join("saved_model.pb"))?;
    require_file(&model_path.join("variables/variables.index"))?;
    let libraries = [
        frameworks.join("libtensorflow_framework.2.8.0.dylib"),
        frameworks.join("libtensorflow_cc.2.8.0.dylib"),
        frameworks.join("libSpleeter.dylib"),
    ]
    .into_iter()
    .map(|path| DynamicLibrary::open(&path))
    .collect::<Result<Vec<_>>>()?;
    let spleeter = libraries.last().context("missing Spleeter library")?;
    let initialize: SeparatorInitialize = unsafe { spleeter.function("separatorInitialize")? };
    let finalize: SeparatorFinalize = unsafe { spleeter.function("separatorFinalize")? };
    let is_initialized: SeparatorIsInitialized =
        unsafe { spleeter.function("separatorIsInitialized")? };
    let pre_operation: SeparatorPreOperation =
        unsafe { spleeter.function("separatorPreOperation")? };
    let post_operation: SeparatorPostOperation =
        unsafe { spleeter.function("separatorPostOperation")? };
    let operation_at_index: SeparatorOperationAtIndex =
        unsafe { spleeter.function("separatorOperationAtIndex")? };
    let operation_at_once: SeparatorOperationAtOnce =
        unsafe { spleeter.function("separatorOperationAtOnce")? };

    let model_c = CString::new(model_path.to_string_lossy().as_bytes())?;
    unsafe { initialize(model_c.as_ptr(), 0, 0, 0) };
    if unsafe { is_initialized() } == 0 {
        unsafe { finalize() };
        bail!(
            "libSpleeter did not initialize from {}",
            model_path.display()
        );
    }
    let result = (|| {
        let outputs = separate_stereo_streaming(
            input_left,
            input_right,
            pre_operation,
            operation_at_index,
            post_operation,
        )?;
        let streaming_matches_at_once = if compare_at_once {
            let mut at_once = std::array::from_fn::<_, 6, _>(|_| vec![0.0_f32; input_left.len()]);
            let succeeded = unsafe {
                operation_at_once(
                    input_left.len() as u32,
                    input_left.as_mut_ptr(),
                    input_right.as_mut_ptr(),
                    at_once[0].as_mut_ptr(),
                    at_once[1].as_mut_ptr(),
                    at_once[2].as_mut_ptr(),
                    at_once[3].as_mut_ptr(),
                    at_once[4].as_mut_ptr(),
                    at_once[5].as_mut_ptr(),
                )
            } != 0;
            if !succeeded {
                bail!("libSpleeter's at-once differential operation failed");
            }
            Some(outputs == at_once)
        } else {
            None
        };
        Ok((outputs, streaming_matches_at_once))
    })();
    unsafe { finalize() };
    let (outputs, streaming_matches_at_once) = result?;
    for (channel, samples) in outputs.iter().enumerate() {
        if let Some((index, _)) = samples
            .iter()
            .enumerate()
            .find(|(_, sample)| !sample.is_finite())
        {
            bail!("libSpleeter output channel {channel} sample {index} is not finite");
        }
    }
    Ok((model_path, outputs, streaming_matches_at_once))
}

#[cfg(target_arch = "x86_64")]
fn separate_stereo_streaming(
    input_left: &mut [f32],
    input_right: &mut [f32],
    pre_operation: SeparatorPreOperation,
    operation_at_index: SeparatorOperationAtIndex,
    post_operation: SeparatorPostOperation,
) -> Result<[Vec<f32>; 6]> {
    let mut separator = std::ptr::null_mut();
    let prepared = unsafe {
        pre_operation(
            &mut separator,
            input_left.len() as u32,
            1,
            0,
            0,
            input_left.as_mut_ptr(),
            input_right.as_mut_ptr(),
        )
    } != 0;
    if !prepared || separator.is_null() {
        if !separator.is_null() {
            unsafe { post_operation(separator) };
        }
        bail!("libSpleeter failed to prepare its streamed operation");
    }

    let mut outputs = std::array::from_fn::<_, 6, _>(|_| vec![0.0_f32; input_left.len()]);
    let mut chunk_outputs = std::array::from_fn::<_, 6, _>(|_| vec![0.0_f32; STEMS_CHUNK_SAMPLES]);
    let mut failed_index = None;
    for chunk in plan_stems_chunks(input_left.len()) {
        let offset = chunk.sample_offset;
        let succeeded = unsafe {
            operation_at_index(
                separator,
                chunk.index as i32,
                input_left.as_mut_ptr().add(offset),
                input_right.as_mut_ptr().add(offset),
                chunk_outputs[0].as_mut_ptr(),
                chunk_outputs[1].as_mut_ptr(),
                chunk_outputs[2].as_mut_ptr(),
                chunk_outputs[3].as_mut_ptr(),
                chunk_outputs[4].as_mut_ptr(),
                chunk_outputs[5].as_mut_ptr(),
            )
        } != 0;
        if !succeeded {
            failed_index = Some(chunk.index);
            break;
        }
        for (output, chunk_output) in outputs.iter_mut().zip(&chunk_outputs) {
            output[offset..offset + chunk.valid_samples]
                .copy_from_slice(&chunk_output[..chunk.valid_samples]);
        }
    }
    unsafe { post_operation(separator) };
    if let Some(index) = failed_index {
        bail!("libSpleeter failed at streamed chunk {index}");
    }
    Ok(outputs)
}

#[cfg(target_arch = "x86_64")]
fn decode_stereo_with_ffmpeg(audio_path: &Path) -> Result<(Vec<f32>, Vec<f32>)> {
    let ffmpeg = std::env::var_os("FFMPEG_PATH").unwrap_or_else(|| "ffmpeg".into());
    let output = Command::new(&ffmpeg)
        .args(["-nostdin", "-v", "error", "-i"])
        .arg(audio_path)
        .args([
            "-map",
            "0:a:0",
            "-f",
            "f32le",
            "-acodec",
            "pcm_f32le",
            "-ar",
            "44100",
            "-ac",
            "2",
            "pipe:1",
        ])
        .output()
        .with_context(|| format!("failed to execute {}", PathBuf::from(&ffmpeg).display()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("ffmpeg audio decode failed: {}", stderr.trim());
    }
    if output.stdout.is_empty() || !output.stdout.len().is_multiple_of(8) {
        bail!(
            "ffmpeg returned {} bytes instead of complete stereo f32 frames",
            output.stdout.len()
        );
    }
    let mut left = Vec::with_capacity(output.stdout.len() / 8);
    let mut right = Vec::with_capacity(output.stdout.len() / 8);
    for frame in output.stdout.chunks_exact(8) {
        left.push(f32::from_le_bytes(frame[0..4].try_into().unwrap()));
        right.push(f32::from_le_bytes(frame[4..8].try_into().unwrap()));
    }
    Ok((left, right))
}

#[cfg(target_arch = "x86_64")]
fn write_float_wav(path: &Path, left: &[f32], right: &[f32]) -> Result<()> {
    let spec = hound::WavSpec {
        channels: 2,
        sample_rate: 44_100,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut writer = hound::WavWriter::create(path, spec)
        .with_context(|| format!("failed to create {}", path.display()))?;
    for (left, right) in left.iter().zip(right) {
        writer.write_sample(*left)?;
        writer.write_sample(*right)?;
    }
    writer
        .finalize()
        .with_context(|| format!("failed to finalize {}", path.display()))
}

fn synthetic_stereo(sample_count: usize) -> (Vec<f32>, Vec<f32>) {
    let mut left = Vec::with_capacity(sample_count);
    let mut right = Vec::with_capacity(sample_count);
    for index in 0..sample_count {
        let time = index as f32 / 44_100.0;
        let pulse = if index % 11_025 < 48 { 0.35 } else { 0.0 };
        let shifted_pulse = if (index + 256) % 14_700 < 64 {
            -0.3
        } else {
            0.0
        };
        left.push(
            0.18 * (std::f32::consts::TAU * 220.0 * time).sin()
                + 0.12 * (std::f32::consts::TAU * 997.0 * time).sin()
                + pulse,
        );
        right.push(
            0.15 * (std::f32::consts::TAU * 330.0 * time).sin()
                + 0.11 * (std::f32::consts::TAU * 1_499.0 * time).sin()
                + shifted_pulse,
        );
    }
    (left, right)
}

fn summarize_channel(
    output: usize,
    stem: &'static str,
    side: &'static str,
    samples: &[f32],
) -> StemsProbeChannel {
    let mut hasher = Sha256::new();
    let mut finite_samples = 0;
    let mut sum = 0.0_f64;
    let mut squared_sum = 0.0_f64;
    let mut peak = 0.0_f32;
    for sample in samples.iter().copied() {
        hasher.update(sample.to_le_bytes());
        if sample.is_finite() {
            finite_samples += 1;
            sum += f64::from(sample);
            squared_sum += f64::from(sample) * f64::from(sample);
            peak = peak.max(sample.abs());
        }
    }
    let denominator = finite_samples.max(1) as f64;
    StemsProbeChannel {
        output,
        stem,
        side,
        finite_samples,
        rms: (squared_sum / denominator).sqrt(),
        peak,
        mean: sum / denominator,
        sha256_le_f32: format!("{:x}", hasher.finalize()),
    }
}

fn require_file(path: &Path) -> Result<()> {
    if !path.is_file() {
        bail!(
            "required Rekordbox Stems artifact is missing: {}",
            path.display()
        );
    }
    Ok(())
}

#[cfg(target_arch = "x86_64")]
struct DynamicLibrary {
    handle: *mut c_void,
    path: PathBuf,
}

#[cfg(target_arch = "x86_64")]
impl DynamicLibrary {
    fn open(path: &Path) -> Result<Self> {
        require_file(path)?;
        let c_path = CString::new(path.to_string_lossy().as_bytes())?;
        let handle = unsafe { libc::dlopen(c_path.as_ptr(), libc::RTLD_NOW | libc::RTLD_GLOBAL) };
        if handle.is_null() {
            bail!("failed to dlopen {}: {}", path.display(), dlerror());
        }
        Ok(Self {
            handle,
            path: path.to_path_buf(),
        })
    }

    unsafe fn function<T: Copy>(&self, name: &str) -> Result<T> {
        let c_name = CString::new(name)?;
        unsafe { libc::dlerror() };
        let pointer = unsafe { libc::dlsym(self.handle, c_name.as_ptr()) };
        if pointer.is_null() {
            bail!(
                "failed to resolve {name} from {}: {}",
                self.path.display(),
                dlerror()
            );
        }
        if std::mem::size_of::<T>() != std::mem::size_of::<*mut c_void>() {
            bail!("unsupported dynamic function pointer size");
        }
        Ok(unsafe { std::mem::transmute_copy(&pointer) })
    }
}

#[cfg(target_arch = "x86_64")]
impl Drop for DynamicLibrary {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe { libc::dlclose(self.handle) };
        }
    }
}

#[cfg(target_arch = "x86_64")]
fn dlerror() -> String {
    let pointer = unsafe { libc::dlerror() };
    if pointer.is_null() {
        "unknown dynamic loader error".to_string()
    } else {
        unsafe { CStr::from_ptr(pointer) }
            .to_string_lossy()
            .into_owned()
    }
}
