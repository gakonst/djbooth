use std::ffi::{CStr, CString, c_char, c_void};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::Serialize;
use sha2::{Digest, Sha256};

const DEFAULT_SAMPLE_COUNT: usize = 44_100;

type SeparatorInitialize = unsafe extern "C" fn(*const c_char, u32, u32, u8);
type SeparatorFinalize = unsafe extern "C" fn();
type SeparatorIsInitialized = unsafe extern "C" fn() -> u8;
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

pub fn run_stems_probe(app_path: &Path, sample_count: Option<usize>) -> Result<StemsProbeResult> {
    run_stems_probe_impl(app_path, sample_count.unwrap_or(DEFAULT_SAMPLE_COUNT))
}

#[cfg(not(target_arch = "x86_64"))]
fn run_stems_probe_impl(_app_path: &Path, _sample_count: usize) -> Result<StemsProbeResult> {
    bail!("Rekordbox Stems probe must run inside an x86_64 worker process")
}

#[cfg(target_arch = "x86_64")]
fn run_stems_probe_impl(app_path: &Path, sample_count: usize) -> Result<StemsProbeResult> {
    if sample_count == 0 || sample_count > u32::MAX as usize {
        bail!("sample count must be between 1 and {}", u32::MAX);
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
    let operation: SeparatorOperationAtOnce =
        unsafe { spleeter.function("separatorOperationAtOnce")? };

    let model_c = CString::new(model_path.to_string_lossy().as_bytes())?;
    unsafe { initialize(model_c.as_ptr(), 0, 0, 0) };
    let initialized = unsafe { is_initialized() } != 0;
    if !initialized {
        unsafe { finalize() };
        bail!(
            "libSpleeter did not initialize from {}",
            model_path.display()
        );
    }

    let (mut input_left, mut input_right) = synthetic_stereo(sample_count);
    let mut outputs = std::array::from_fn::<_, 6, _>(|_| vec![0.0_f32; sample_count]);
    let succeeded = unsafe {
        operation(
            sample_count as u32,
            input_left.as_mut_ptr(),
            input_right.as_mut_ptr(),
            outputs[0].as_mut_ptr(),
            outputs[1].as_mut_ptr(),
            outputs[2].as_mut_ptr(),
            outputs[3].as_mut_ptr(),
            outputs[4].as_mut_ptr(),
            outputs[5].as_mut_ptr(),
        )
    } != 0;
    unsafe { finalize() };

    let sides = ["left", "right"];
    let stems = ["instrumental", "vocals", "drums"];
    let channels = outputs
        .iter()
        .enumerate()
        .map(|(index, samples)| {
            summarize_channel(index / 2, stems[index / 2], sides[index % 2], samples)
        })
        .collect::<Vec<_>>();
    let reconstruction = [(&input_left, "left", 0), (&input_right, "right", 1)]
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
                rms_error: (squared_error / sample_count as f64).sqrt(),
                peak_error,
            }
        })
        .collect();

    Ok(StemsProbeResult {
        backend: "rekordbox-6.8.2-libspleeter",
        sample_count,
        sample_rate: 44_100,
        model_path: model_path.display().to_string(),
        operation_succeeded: succeeded,
        channels,
        reconstruction,
    })
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
