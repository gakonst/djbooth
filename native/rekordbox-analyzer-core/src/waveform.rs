//! Deterministic waveform feature extraction and ANLZ-ready entry packing.
//!
//! The container layouts and entry bit packing are understood. Frequency
//! splits and quantizers are clean-room approximations derived from public
//! format documentation plus synthetic pure-tone differential probes.

#[cfg(target_arch = "aarch64")]
use core::arch::aarch64::{
    float64x2_t, vabsq_f64, vaddq_f64, vdupq_n_f64, vextq_f64, vld1q_f64, vmaxq_f64, vmulq_f64,
    vst1q_f64, vsubq_f64, vuzp1q_f64, vuzp2q_f64,
};

use anyhow::{Result, bail};
#[cfg(target_arch = "aarch64")]
use rayon::prelude::*;

use crate::anlz::{AnlzTag, CountedWaveform, build_waveform_tag};
use crate::audio::{ANALYSIS_SAMPLE_RATE, DETAIL_FRAME_SAMPLES, MonoPcm};

/// Fixed monochrome waveform preview width.
pub const MONOCHROME_PREVIEW_COLUMNS: usize = 400;

/// Fixed legacy tiny waveform preview width.
pub const TINY_PREVIEW_COLUMNS: usize = 100;

/// Fixed color and three-band waveform preview width.
pub const COLOR_PREVIEW_COLUMNS: usize = 1_200;

const LOW_PASS_ALPHA_250_HZ: f64 = 0.034_992_074_116_800_72;
const LOW_PASS_ALPHA_4_KHZ: f64 = 0.434_419_945_432_123_8;
const PWV3_FORMAT_WORD: u32 = 0x0096_0000;
const PWV4_FORMAT_WORD: u32 = 0;
const PWV5_FORMAT_WORD: u32 = 0x0096_0305;
const PWV7_FORMAT_WORD: u32 = 0x0096_0000;
const THREE_BAND_MAXIMUM: u8 = 127;
// PWV4 and PWV5 are distinct representations. PWV4 stores absolute linear
// band peaks; PWV5 stores amplitude-invariant spectral hue beside a separate
// height. These gains are bounded fits against pure-tone and matched-PCM
// Rekordbox 6.8.2 outputs.
const COLOR_DETAIL_RED_GAIN: f64 = 1.18;
const COLOR_DETAIL_GREEN_GAIN: f64 = 0.95;
const COLOR_DETAIL_BLUE_GAIN: f64 = 0.95;
const COLOR_DETAIL_BLUE_EXPONENT: f64 = 0.60;
const COLOR_PREVIEW_GREEN_GAIN: f64 = 0.87;
const COLOR_PREVIEW_BLUE_GAIN: f64 = 0.513;
// PWV6 is not a max-pooled PWV7. A 110-track split-sample fit, checked
// independently against 77 tone/level/transient probes, establishes mean
// reduction followed by separate low/mid preview quantizers. High remains the
// rounded mean. These transforms improve every real-track oracle in the corpus.
const THREE_BAND_PREVIEW_LOW_GAIN: f64 = 0.54;
const THREE_BAND_PREVIEW_LOW_POWER: f64 = 1.14;
const THREE_BAND_PREVIEW_MID_GAIN: f64 = 0.84;
const THREE_BAND_PREVIEW_MID_POWER: f64 = 1.36;
#[cfg(target_arch = "aarch64")]
const FILTER_PREROLL_FRAMES: usize = 150;
#[cfg(target_arch = "aarch64")]
const MIN_PARALLEL_CHUNK_FRAMES: usize = 3_000;

/// All waveform entry arrays needed by DAT, EXT, and 2EX analysis files.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WaveformData {
    monochrome_preview: Vec<u8>,
    tiny_preview: Vec<u8>,
    monochrome_detail: Vec<u8>,
    color_preview: Vec<u8>,
    color_detail: Vec<u8>,
    three_band_preview: Vec<u8>,
    three_band_detail: Vec<u8>,
}

impl WaveformData {
    /// Generate deterministic waveform entries from normalized 44.1 kHz mono PCM.
    ///
    /// Detailed arrays use one 294-sample column (150 columns/second).
    /// Preview arrays reduce those columns to their fixed protocol widths by
    /// taking maxima over exact integer-ratio ranges.
    pub fn generate(pcm: &MonoPcm) -> Result<Self> {
        if pcm.sample_rate() != ANALYSIS_SAMPLE_RATE {
            bail!(
                "waveform generation requires {ANALYSIS_SAMPLE_RATE} Hz PCM, received {} Hz",
                pcm.sample_rate()
            );
        }

        Ok(pack_waveforms(&extract_detail_features(pcm)))
    }

    /// Packed 400-byte `PWAV` entries.
    pub fn monochrome_preview(&self) -> &[u8] {
        &self.monochrome_preview
    }

    /// Packed 100-byte `PWV2` entries.
    pub fn tiny_preview(&self) -> &[u8] {
        &self.tiny_preview
    }

    /// Packed one-byte `PWV3` entries at 150 columns/second.
    pub fn monochrome_detail(&self) -> &[u8] {
        &self.monochrome_detail
    }

    /// Packed six-byte `PWV4` entries across 1,200 columns.
    pub fn color_preview(&self) -> &[u8] {
        &self.color_preview
    }

    /// Packed two-byte `PWV5` entries at 150 columns/second.
    pub fn color_detail(&self) -> &[u8] {
        &self.color_detail
    }

    /// Packed low/mid/high three-byte `PWV6` entries across 1,200 columns.
    pub fn three_band_preview(&self) -> &[u8] {
        &self.three_band_preview
    }

    /// Packed low/mid/high three-byte `PWV7` entries at 150 columns/second.
    pub fn three_band_detail(&self) -> &[u8] {
        &self.three_band_detail
    }

    /// Build the DAT `PWAV` tag.
    pub fn pwav_tag(&self) -> Result<AnlzTag> {
        build_waveform_tag(*b"PWAV", &self.monochrome_preview)
    }

    /// Build the DAT `PWV2` tag.
    pub fn pwv2_tag(&self) -> Result<AnlzTag> {
        build_waveform_tag(*b"PWV2", &self.tiny_preview)
    }

    /// Build an EXT `PWV3` waveform section.
    pub fn pwv3(&self) -> CountedWaveform {
        CountedWaveform {
            kind: *b"PWV3",
            entry_bytes: 1,
            header_unknown: Some(PWV3_FORMAT_WORD),
            entries: self.monochrome_detail.clone(),
        }
    }

    /// Build an EXT `PWV4` waveform section.
    pub fn pwv4(&self) -> CountedWaveform {
        CountedWaveform {
            kind: *b"PWV4",
            entry_bytes: 6,
            header_unknown: Some(PWV4_FORMAT_WORD),
            entries: self.color_preview.clone(),
        }
    }

    /// Build an EXT `PWV5` waveform section.
    pub fn pwv5(&self) -> CountedWaveform {
        CountedWaveform {
            kind: *b"PWV5",
            entry_bytes: 2,
            header_unknown: Some(PWV5_FORMAT_WORD),
            entries: self.color_detail.clone(),
        }
    }

    /// Build a 2EX `PWV6` waveform section.
    pub fn pwv6(&self) -> CountedWaveform {
        CountedWaveform {
            kind: *b"PWV6",
            entry_bytes: 3,
            header_unknown: None,
            entries: self.three_band_preview.clone(),
        }
    }

    /// Build a 2EX `PWV7` waveform section.
    pub fn pwv7(&self) -> CountedWaveform {
        CountedWaveform {
            kind: *b"PWV7",
            entry_bytes: 3,
            header_unknown: Some(PWV7_FORMAT_WORD),
            entries: self.three_band_detail.clone(),
        }
    }
}

fn pack_waveforms(detail_features: &[FrameFeatures]) -> WaveformData {
    let detail_peak = detail_features
        .iter()
        .map(|feature| feature.peak)
        .fold(0.0_f64, f64::max);
    let monochrome_preview_features = reduce_features(detail_features, MONOCHROME_PREVIEW_COLUMNS);
    let tiny_preview_features = reduce_features(detail_features, TINY_PREVIEW_COLUMNS);
    let color_preview_features = reduce_features(detail_features, COLOR_PREVIEW_COLUMNS);
    let three_band_detail = detail_features
        .iter()
        .flat_map(pack_three_band)
        .collect::<Vec<_>>();

    WaveformData {
        monochrome_preview: monochrome_preview_features
            .iter()
            .map(pack_monochrome)
            .collect(),
        tiny_preview: tiny_preview_features
            .iter()
            .map(|feature| waveform_height(feature.peak, 15))
            .collect(),
        monochrome_detail: detail_features.iter().map(pack_monochrome).collect(),
        color_preview: color_preview_features
            .iter()
            .flat_map(pack_color_preview)
            .collect(),
        color_detail: detail_features
            .iter()
            .flat_map(|feature| pack_color_detail(feature, detail_peak).to_be_bytes())
            .collect(),
        three_band_preview: reduce_three_band_preview(&three_band_detail, COLOR_PREVIEW_COLUMNS),
        three_band_detail,
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct FrameFeatures {
    peak: f64,
    rms: f64,
    color_preview_bottom: f64,
    color_preview_red: f64,
    color_preview_green: f64,
    color_preview_blue: f64,
    color_detail_red: f64,
    color_detail_green: f64,
    color_detail_blue: f64,
    low: f64,
    mid: f64,
    high: f64,
}

#[cfg(any(not(target_arch = "aarch64"), test))]
#[derive(Debug, Clone, Copy, Default)]
struct ScalarBandSplitter {
    low_state: f64,
    high_cut_state: f64,
}

#[cfg(any(not(target_arch = "aarch64"), test))]
impl ScalarBandSplitter {
    fn process(&mut self, sample: f64) -> (f64, f64, f64) {
        self.low_state += LOW_PASS_ALPHA_250_HZ * (sample - self.low_state);
        self.high_cut_state += LOW_PASS_ALPHA_4_KHZ * (sample - self.high_cut_state);
        (
            self.low_state,
            self.high_cut_state - self.low_state,
            sample - self.high_cut_state,
        )
    }
}

#[cfg(not(target_arch = "aarch64"))]
type BandSplitter = ScalarBandSplitter;

#[cfg(target_arch = "aarch64")]
struct BandSplitter {
    alpha: float64x2_t,
    state: float64x2_t,
}

#[cfg(target_arch = "aarch64")]
impl Default for BandSplitter {
    fn default() -> Self {
        Self {
            alpha: load_f64x2([LOW_PASS_ALPHA_250_HZ, LOW_PASS_ALPHA_4_KHZ]),
            state: load_f64x2([0.0; 2]),
        }
    }
}

#[cfg(target_arch = "aarch64")]
impl BandSplitter {
    #[inline(always)]
    fn process_vectors(&mut self, sample: f64) -> (float64x2_t, float64x2_t) {
        let input = unsafe { vdupq_n_f64(sample) };
        // Keep the scalar operation order: state + alpha * (sample - state).
        self.state = unsafe {
            vaddq_f64(
                self.state,
                vmulq_f64(self.alpha, vsubq_f64(input, self.state)),
            )
        };
        let reversed_state = unsafe { vextq_f64::<1>(self.state, self.state) };
        let reversed_difference = unsafe {
            let difference = vsubq_f64(self.state, reversed_state);
            vextq_f64::<1>(difference, difference)
        };
        let low_mid = unsafe { vuzp1q_f64(self.state, reversed_difference) };
        let sample_high = unsafe { vuzp2q_f64(input, vsubq_f64(input, self.state)) };
        (low_mid, sample_high)
    }

    #[cfg(test)]
    fn process(&mut self, sample: f64) -> (f64, f64, f64) {
        let (low_mid, sample_high) = self.process_vectors(sample);
        let [low, mid] = store_f64x2(low_mid);
        let [_, high] = store_f64x2(sample_high);
        (low, mid, high)
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    z1: f64,
    z2: f64,
}

impl Biquad {
    fn low_pass(cutoff_hz: f64, q: f64) -> Self {
        Self::new(cutoff_hz, q, false)
    }

    fn high_pass(cutoff_hz: f64, q: f64) -> Self {
        Self::new(cutoff_hz, q, true)
    }

    fn new(cutoff_hz: f64, q: f64, high_pass: bool) -> Self {
        let omega = 2.0 * std::f64::consts::PI * cutoff_hz / f64::from(ANALYSIS_SAMPLE_RATE);
        let cosine = omega.cos();
        let alpha = omega.sin() / (2.0 * q);
        let a0 = 1.0 + alpha;
        let (b0, b1, b2) = if high_pass {
            ((1.0 + cosine) / 2.0, -(1.0 + cosine), (1.0 + cosine) / 2.0)
        } else {
            ((1.0 - cosine) / 2.0, 1.0 - cosine, (1.0 - cosine) / 2.0)
        };
        Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: -2.0 * cosine / a0,
            a2: (1.0 - alpha) / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    #[cfg(any(not(target_arch = "aarch64"), test))]
    fn process(&mut self, sample: f64) -> f64 {
        let output = self.b0 * sample + self.z1;
        self.z1 = self.b1 * sample - self.a1 * output + self.z2;
        self.z2 = self.b2 * sample - self.a2 * output;
        output
    }
}

#[derive(Debug, Clone)]
struct Butterworth<const STAGES: usize> {
    stages: [Biquad; STAGES],
}

impl<const STAGES: usize> Butterworth<STAGES> {
    fn low_pass(cutoff_hz: f64) -> Self {
        Self::new(cutoff_hz, false)
    }

    fn high_pass(cutoff_hz: f64) -> Self {
        Self::new(cutoff_hz, true)
    }

    fn new(cutoff_hz: f64, high_pass: bool) -> Self {
        let order = 2 * STAGES;
        Self {
            stages: std::array::from_fn(|index| {
                let angle = std::f64::consts::PI * (2 * index + 1) as f64 / (2 * order) as f64;
                let q = 1.0 / (2.0 * angle.cos());
                if high_pass {
                    Biquad::high_pass(cutoff_hz, q)
                } else {
                    Biquad::low_pass(cutoff_hz, q)
                }
            }),
        }
    }

    #[cfg(any(not(target_arch = "aarch64"), test))]
    fn process(&mut self, mut sample: f64) -> f64 {
        for stage in &mut self.stages {
            sample = stage.process(sample);
        }
        sample
    }
}

#[cfg(any(not(target_arch = "aarch64"), test))]
#[derive(Debug, Clone)]
struct ScalarColorBandSplitter {
    preview_bottom: Butterworth<1>,
    preview_red: Butterworth<2>,
    preview_green_high: Butterworth<2>,
    preview_green_low: Butterworth<1>,
    preview_blue: Butterworth<3>,
    detail_red: Butterworth<2>,
    detail_green_high: Butterworth<2>,
    detail_green_low: Butterworth<1>,
    detail_blue: Butterworth<2>,
}

#[cfg(any(not(target_arch = "aarch64"), test))]
impl Default for ScalarColorBandSplitter {
    fn default() -> Self {
        Self {
            preview_bottom: Butterworth::low_pass(400.0),
            preview_red: Butterworth::low_pass(160.0),
            preview_green_high: Butterworth::high_pass(230.0),
            preview_green_low: Butterworth::low_pass(900.0),
            preview_blue: Butterworth::high_pass(2_500.0),
            detail_red: Butterworth::low_pass(156.0),
            detail_green_high: Butterworth::high_pass(210.0),
            detail_green_low: Butterworth::low_pass(2_100.0),
            detail_blue: Butterworth::high_pass(1_255.0),
        }
    }
}

#[cfg(any(not(target_arch = "aarch64"), test))]
#[derive(Debug, Clone, Copy)]
struct ColorBands {
    preview_bottom: f64,
    preview_red: f64,
    preview_green: f64,
    preview_blue: f64,
    detail_red: f64,
    detail_green: f64,
    detail_blue: f64,
}

#[cfg(any(not(target_arch = "aarch64"), test))]
impl ScalarColorBandSplitter {
    fn process(&mut self, sample: f64) -> ColorBands {
        let preview_green = self
            .preview_green_low
            .process(self.preview_green_high.process(sample));
        let detail_green = self
            .detail_green_low
            .process(self.detail_green_high.process(sample));
        ColorBands {
            preview_bottom: self.preview_bottom.process(sample),
            preview_red: self.preview_red.process(sample),
            preview_green: preview_green * COLOR_PREVIEW_GREEN_GAIN,
            preview_blue: self.preview_blue.process(sample) * COLOR_PREVIEW_BLUE_GAIN,
            detail_red: self.detail_red.process(sample),
            detail_green,
            detail_blue: self.detail_blue.process(sample),
        }
    }
}

#[cfg(not(target_arch = "aarch64"))]
type ColorBandSplitter = ScalarColorBandSplitter;

#[cfg(target_arch = "aarch64")]
struct BiquadPair {
    b0: float64x2_t,
    b1: float64x2_t,
    b2: float64x2_t,
    a1: float64x2_t,
    a2: float64x2_t,
    z1: float64x2_t,
    z2: float64x2_t,
}

#[cfg(target_arch = "aarch64")]
impl BiquadPair {
    fn new(left: Biquad, right: Biquad) -> Self {
        Self {
            b0: load_f64x2([left.b0, right.b0]),
            b1: load_f64x2([left.b1, right.b1]),
            b2: load_f64x2([left.b2, right.b2]),
            a1: load_f64x2([left.a1, right.a1]),
            a2: load_f64x2([left.a2, right.a2]),
            z1: load_f64x2([left.z1, right.z1]),
            z2: load_f64x2([left.z2, right.z2]),
        }
    }

    #[inline(always)]
    fn process(&mut self, input: float64x2_t) -> float64x2_t {
        // Separate multiply/add/subtract instructions preserve the scalar
        // transposed-direct-form-II operation order lane by lane.
        let output = unsafe { vaddq_f64(vmulq_f64(self.b0, input), self.z1) };
        self.z1 = unsafe {
            vaddq_f64(
                vsubq_f64(vmulq_f64(self.b1, input), vmulq_f64(self.a1, output)),
                self.z2,
            )
        };
        self.z2 = unsafe { vsubq_f64(vmulq_f64(self.b2, input), vmulq_f64(self.a2, output)) };
        output
    }
}

#[cfg(target_arch = "aarch64")]
struct ColorBandSplitter {
    stage_zero: [BiquadPair; 4],
    stage_one: [BiquadPair; 3],
    preview_blue_stage_two: BiquadPair,
    green_low_passes: BiquadPair,
}

#[cfg(target_arch = "aarch64")]
struct ColorBandVectors {
    preview_bottom_red: float64x2_t,
    preview_green_blue: float64x2_t,
    detail_red_green: float64x2_t,
    detail_blue: float64x2_t,
}

#[cfg(target_arch = "aarch64")]
impl Default for ColorBandSplitter {
    fn default() -> Self {
        let [preview_bottom] = Butterworth::<1>::low_pass(400.0).stages;
        let [preview_red_zero, preview_red_one] = Butterworth::<2>::low_pass(160.0).stages;
        let [preview_green_zero, preview_green_one] = Butterworth::<2>::high_pass(230.0).stages;
        let [preview_green_low] = Butterworth::<1>::low_pass(900.0).stages;
        let [preview_blue_zero, preview_blue_one, preview_blue_two] =
            Butterworth::<3>::high_pass(2_500.0).stages;
        let [detail_red_zero, detail_red_one] = Butterworth::<2>::low_pass(156.0).stages;
        let [detail_green_zero, detail_green_one] = Butterworth::<2>::high_pass(210.0).stages;
        let [detail_green_low] = Butterworth::<1>::low_pass(2_100.0).stages;
        let [detail_blue_zero, detail_blue_one] = Butterworth::<2>::high_pass(1_255.0).stages;
        let unused = Biquad::default();

        Self {
            stage_zero: [
                BiquadPair::new(preview_bottom, preview_red_zero),
                BiquadPair::new(preview_green_zero, preview_blue_zero),
                BiquadPair::new(detail_red_zero, detail_green_zero),
                BiquadPair::new(detail_blue_zero, unused),
            ],
            stage_one: [
                BiquadPair::new(preview_red_one, preview_green_one),
                BiquadPair::new(preview_blue_one, detail_red_one),
                BiquadPair::new(detail_green_one, detail_blue_one),
            ],
            preview_blue_stage_two: BiquadPair::new(preview_blue_two, unused),
            green_low_passes: BiquadPair::new(preview_green_low, detail_green_low),
        }
    }
}

#[cfg(target_arch = "aarch64")]
impl ColorBandSplitter {
    #[inline(always)]
    fn process_vectors(&mut self, sample: f64) -> ColorBandVectors {
        let input = unsafe { vdupq_n_f64(sample) };
        let zero = unsafe { vdupq_n_f64(0.0) };
        let sample_zero = unsafe { vuzp1q_f64(input, zero) };
        let preview_bottom_red_zero = self.stage_zero[0].process(input);
        let preview_green_blue_zero = self.stage_zero[1].process(input);
        let detail_red_green_zero = self.stage_zero[2].process(input);
        let detail_blue_zero = self.stage_zero[3].process(sample_zero);

        let preview_red_green_high = self.stage_one[0]
            .process(unsafe { vextq_f64::<1>(preview_bottom_red_zero, preview_green_blue_zero) });
        let preview_blue_one_detail_red = self.stage_one[1]
            .process(unsafe { vextq_f64::<1>(preview_green_blue_zero, detail_red_green_zero) });
        let detail_green_high_blue = self.stage_one[2]
            .process(unsafe { vextq_f64::<1>(detail_red_green_zero, detail_blue_zero) });
        let preview_blue = self
            .preview_blue_stage_two
            .process(unsafe { vuzp1q_f64(preview_blue_one_detail_red, zero) });
        let preview_green_detail_green = self
            .green_low_passes
            .process(unsafe { vextq_f64::<1>(preview_red_green_high, detail_green_high_blue) });

        ColorBandVectors {
            preview_bottom_red: unsafe {
                vuzp1q_f64(preview_bottom_red_zero, preview_red_green_high)
            },
            preview_green_blue: unsafe {
                vmulq_f64(
                    vuzp1q_f64(preview_green_detail_green, preview_blue),
                    load_f64x2([COLOR_PREVIEW_GREEN_GAIN, COLOR_PREVIEW_BLUE_GAIN]),
                )
            },
            detail_red_green: unsafe {
                vuzp2q_f64(preview_blue_one_detail_red, preview_green_detail_green)
            },
            detail_blue: unsafe { vuzp2q_f64(detail_green_high_blue, zero) },
        }
    }

    #[cfg(test)]
    fn process(&mut self, sample: f64) -> ColorBands {
        let vectors = self.process_vectors(sample);
        let [preview_bottom, preview_red] = store_f64x2(vectors.preview_bottom_red);
        let [preview_green, preview_blue] = store_f64x2(vectors.preview_green_blue);
        let [detail_red, detail_green] = store_f64x2(vectors.detail_red_green);
        let [detail_blue, _] = store_f64x2(vectors.detail_blue);
        ColorBands {
            preview_bottom,
            preview_red,
            preview_green,
            preview_blue,
            detail_red,
            detail_green,
            detail_blue,
        }
    }
}

#[cfg(target_arch = "aarch64")]
#[inline(always)]
fn load_f64x2(values: [f64; 2]) -> float64x2_t {
    // SAFETY: `values` always contains exactly two contiguous `f64` lanes.
    unsafe { vld1q_f64(values.as_ptr()) }
}

#[cfg(target_arch = "aarch64")]
#[inline(always)]
fn store_f64x2(value: float64x2_t) -> [f64; 2] {
    let mut values = [0.0; 2];
    // SAFETY: `values` always has writable storage for exactly two `f64` lanes.
    unsafe { vst1q_f64(values.as_mut_ptr(), value) };
    values
}

#[cfg(any(not(target_arch = "aarch64"), test))]
fn extract_detail_features_scalar(pcm: &MonoPcm) -> Vec<FrameFeatures> {
    let mut splitter = ScalarBandSplitter::default();
    let mut color_splitter = ScalarColorBandSplitter::default();
    pcm.detail_frames()
        .map(|frame| {
            extract_detail_frame_scalar(frame.valid_samples(), &mut splitter, &mut color_splitter)
        })
        .collect()
}

#[cfg(any(not(target_arch = "aarch64"), test))]
fn extract_detail_frame_scalar(
    samples: &[f32],
    splitter: &mut ScalarBandSplitter,
    color_splitter: &mut ScalarColorBandSplitter,
) -> FrameFeatures {
    let mut peak = 0.0_f64;
    let mut sum_square = 0.0_f64;
    let mut color_preview_bottom = 0.0_f64;
    let mut color_preview_red = 0.0_f64;
    let mut color_preview_green = 0.0_f64;
    let mut color_preview_blue = 0.0_f64;
    let mut color_detail_red_square = 0.0_f64;
    let mut color_detail_green_square = 0.0_f64;
    let mut color_detail_blue_square = 0.0_f64;
    let mut low_square = 0.0_f64;
    let mut mid_square = 0.0_f64;
    let mut high_square = 0.0_f64;
    for sample in samples {
        let sample = f64::from(*sample);
        peak = peak.max(sample.abs());
        sum_square += sample * sample;
        let color = color_splitter.process(sample);
        color_preview_bottom = color_preview_bottom.max(color.preview_bottom.abs());
        color_preview_red = color_preview_red.max(color.preview_red.abs());
        color_preview_green = color_preview_green.max(color.preview_green.abs());
        color_preview_blue = color_preview_blue.max(color.preview_blue.abs());
        color_detail_red_square += color.detail_red * color.detail_red;
        color_detail_green_square += color.detail_green * color.detail_green;
        color_detail_blue_square += color.detail_blue * color.detail_blue;
        let (low, mid, high) = splitter.process(sample);
        low_square += low * low;
        mid_square += mid * mid;
        high_square += high * high;
    }
    let denominator = DETAIL_FRAME_SAMPLES as f64;
    FrameFeatures {
        peak,
        rms: (sum_square / denominator).sqrt(),
        color_preview_bottom,
        color_preview_red,
        color_preview_green,
        color_preview_blue,
        color_detail_red: (color_detail_red_square / denominator).sqrt(),
        color_detail_green: (color_detail_green_square / denominator).sqrt(),
        color_detail_blue: (color_detail_blue_square / denominator).sqrt(),
        low: (low_square / denominator).sqrt(),
        mid: (mid_square / denominator).sqrt(),
        high: (high_square / denominator).sqrt(),
    }
}

#[cfg(not(target_arch = "aarch64"))]
fn extract_detail_features(pcm: &MonoPcm) -> Vec<FrameFeatures> {
    extract_detail_features_scalar(pcm)
}

#[cfg(not(target_arch = "aarch64"))]
fn extract_detail_frame(
    samples: &[f32],
    splitter: &mut BandSplitter,
    color_splitter: &mut ColorBandSplitter,
) -> FrameFeatures {
    extract_detail_frame_scalar(samples, splitter, color_splitter)
}

#[cfg(target_arch = "aarch64")]
fn extract_detail_features(pcm: &MonoPcm) -> Vec<FrameFeatures> {
    let frame_count = pcm.len().div_ceil(DETAIL_FRAME_SAMPLES);
    if frame_count == 0 {
        return Vec::new();
    }
    let worker_count = rayon::current_num_threads()
        .min(frame_count.div_ceil(MIN_PARALLEL_CHUNK_FRAMES))
        .max(1);
    let chunk_len = frame_count.div_ceil(worker_count);
    (0..frame_count)
        .step_by(chunk_len)
        .map(|start| start..(start + chunk_len).min(frame_count))
        .collect::<Vec<_>>()
        .into_par_iter()
        .map(|range| extract_detail_feature_range(pcm, range))
        .flatten()
        .collect()
}

#[cfg(target_arch = "aarch64")]
fn extract_detail_feature_range(
    pcm: &MonoPcm,
    range: std::ops::Range<usize>,
) -> Vec<FrameFeatures> {
    let mut splitter = BandSplitter::default();
    let mut color_splitter = ColorBandSplitter::default();
    let warm_start = range.start.saturating_sub(FILTER_PREROLL_FRAMES);
    let mut features = Vec::with_capacity(range.len());
    for frame_index in warm_start..range.end {
        let start = frame_index * DETAIL_FRAME_SAMPLES;
        let end = (start + DETAIL_FRAME_SAMPLES).min(pcm.len());
        let feature = extract_detail_frame(
            &pcm.samples()[start..end],
            &mut splitter,
            &mut color_splitter,
        );
        if frame_index >= range.start {
            features.push(feature);
        }
    }
    features
}

#[cfg(target_arch = "aarch64")]
#[inline]
fn extract_detail_frame(
    samples: &[f32],
    splitter: &mut BandSplitter,
    color_splitter: &mut ColorBandSplitter,
) -> FrameFeatures {
    let mut peak = 0.0_f64;
    let mut color_preview_bottom_red = unsafe { vdupq_n_f64(0.0) };
    let mut color_preview_green_blue = unsafe { vdupq_n_f64(0.0) };
    let mut color_detail_red_green_square = unsafe { vdupq_n_f64(0.0) };
    let mut color_detail_blue_square = unsafe { vdupq_n_f64(0.0) };
    let mut low_mid_square = unsafe { vdupq_n_f64(0.0) };
    let mut sample_high_square = unsafe { vdupq_n_f64(0.0) };
    for sample in samples {
        let sample = f64::from(*sample);
        peak = peak.max(sample.abs());
        let color = color_splitter.process_vectors(sample);
        color_preview_bottom_red = unsafe {
            vmaxq_f64(
                color_preview_bottom_red,
                vabsq_f64(color.preview_bottom_red),
            )
        };
        color_preview_green_blue = unsafe {
            vmaxq_f64(
                color_preview_green_blue,
                vabsq_f64(color.preview_green_blue),
            )
        };
        color_detail_red_green_square = unsafe {
            vaddq_f64(
                color_detail_red_green_square,
                vmulq_f64(color.detail_red_green, color.detail_red_green),
            )
        };
        color_detail_blue_square = unsafe {
            vaddq_f64(
                color_detail_blue_square,
                vmulq_f64(color.detail_blue, color.detail_blue),
            )
        };
        let (low_mid, sample_high) = splitter.process_vectors(sample);
        low_mid_square = unsafe { vaddq_f64(low_mid_square, vmulq_f64(low_mid, low_mid)) };
        sample_high_square =
            unsafe { vaddq_f64(sample_high_square, vmulq_f64(sample_high, sample_high)) };
    }
    let [color_preview_bottom, color_preview_red] = store_f64x2(color_preview_bottom_red);
    let [color_preview_green, color_preview_blue] = store_f64x2(color_preview_green_blue);
    let [color_detail_red_square, color_detail_green_square] =
        store_f64x2(color_detail_red_green_square);
    let [color_detail_blue_square, _] = store_f64x2(color_detail_blue_square);
    let [low_square, mid_square] = store_f64x2(low_mid_square);
    let [sum_square, high_square] = store_f64x2(sample_high_square);
    let denominator = DETAIL_FRAME_SAMPLES as f64;
    FrameFeatures {
        peak,
        rms: (sum_square / denominator).sqrt(),
        color_preview_bottom,
        color_preview_red,
        color_preview_green,
        color_preview_blue,
        color_detail_red: (color_detail_red_square / denominator).sqrt(),
        color_detail_green: (color_detail_green_square / denominator).sqrt(),
        color_detail_blue: (color_detail_blue_square / denominator).sqrt(),
        low: (low_square / denominator).sqrt(),
        mid: (mid_square / denominator).sqrt(),
        high: (high_square / denominator).sqrt(),
    }
}

pub(crate) struct StreamingWaveformAccumulator {
    splitter: BandSplitter,
    color_splitter: ColorBandSplitter,
    pending: Vec<f32>,
    features: Vec<FrameFeatures>,
}

impl StreamingWaveformAccumulator {
    pub(crate) fn new() -> Self {
        Self {
            splitter: BandSplitter::default(),
            color_splitter: ColorBandSplitter::default(),
            pending: Vec::with_capacity(DETAIL_FRAME_SAMPLES),
            features: Vec::new(),
        }
    }

    pub(crate) fn push(&mut self, mut samples: &[f32]) {
        if !self.pending.is_empty() {
            let consumed = (DETAIL_FRAME_SAMPLES - self.pending.len()).min(samples.len());
            self.pending.extend_from_slice(&samples[..consumed]);
            samples = &samples[consumed..];
            if self.pending.len() == DETAIL_FRAME_SAMPLES {
                self.features.push(extract_detail_frame(
                    &self.pending,
                    &mut self.splitter,
                    &mut self.color_splitter,
                ));
                self.pending.clear();
            }
        }

        let complete_len = samples.len() / DETAIL_FRAME_SAMPLES * DETAIL_FRAME_SAMPLES;
        for frame in samples[..complete_len].chunks_exact(DETAIL_FRAME_SAMPLES) {
            self.features.push(extract_detail_frame(
                frame,
                &mut self.splitter,
                &mut self.color_splitter,
            ));
        }
        self.pending.extend_from_slice(&samples[complete_len..]);
    }

    pub(crate) fn finish(mut self) -> WaveformData {
        if !self.pending.is_empty() {
            self.features.push(extract_detail_frame(
                &self.pending,
                &mut self.splitter,
                &mut self.color_splitter,
            ));
        }
        pack_waveforms(&self.features)
    }
}

fn reduce_features(features: &[FrameFeatures], width: usize) -> Vec<FrameFeatures> {
    if features.is_empty() {
        return vec![FrameFeatures::default(); width];
    }
    (0..width)
        .map(|column| {
            let start = (column * features.len() / width).min(features.len() - 1);
            let numerator = (column + 1)
                .checked_mul(features.len())
                .expect("waveform preview range fits usize");
            let end = numerator.div_ceil(width).max(start + 1).min(features.len());
            features[start..end].iter().copied().fold(
                FrameFeatures::default(),
                |result, feature| FrameFeatures {
                    peak: result.peak.max(feature.peak),
                    rms: result.rms.max(feature.rms),
                    color_preview_bottom: result
                        .color_preview_bottom
                        .max(feature.color_preview_bottom),
                    color_preview_red: result.color_preview_red.max(feature.color_preview_red),
                    color_preview_green: result
                        .color_preview_green
                        .max(feature.color_preview_green),
                    color_preview_blue: result.color_preview_blue.max(feature.color_preview_blue),
                    color_detail_red: result.color_detail_red.max(feature.color_detail_red),
                    color_detail_green: result.color_detail_green.max(feature.color_detail_green),
                    color_detail_blue: result.color_detail_blue.max(feature.color_detail_blue),
                    low: result.low.max(feature.low),
                    mid: result.mid.max(feature.mid),
                    high: result.high.max(feature.high),
                },
            )
        })
        .collect()
}

fn perceptual_level(amplitude: f64, maximum: u8) -> u8 {
    (amplitude.clamp(0.0, 1.0).sqrt() * f64::from(maximum))
        .round()
        .clamp(0.0, f64::from(maximum)) as u8
}

fn linear_level(amplitude: f64, maximum: u8) -> u8 {
    (amplitude.clamp(0.0, 1.0) * f64::from(maximum))
        .round()
        .clamp(0.0, f64::from(maximum)) as u8
}

fn waveform_height(amplitude: f64, maximum: u8) -> u8 {
    (amplitude.clamp(0.0, 1.0).powi(2) * f64::from(maximum))
        .round()
        .clamp(0.0, f64::from(maximum)) as u8
}

fn pack_monochrome(feature: &FrameFeatures) -> u8 {
    let height = waveform_height(feature.peak, 31);
    let density = if feature.peak > f64::EPSILON {
        (feature.rms / feature.peak).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let whiteness = (density * 7.0).round() as u8;
    (whiteness << 5) | height
}

fn pack_color_preview(feature: &FrameFeatures) -> [u8; 6] {
    let amplitude = linear_level(feature.peak, 127);
    if amplitude == 0 {
        return [0; 6];
    }
    let boost = u8::try_from(256_u16.saturating_sub(u16::from(amplitude)).min(255))
        .expect("PWV4 luminance boost fits one byte");
    [
        amplitude,
        boost,
        linear_level(feature.color_preview_bottom, 127),
        linear_level(feature.color_preview_red, 127),
        linear_level(feature.color_preview_green, 127),
        linear_level(feature.color_preview_blue, 127),
    ]
}

fn pack_color_detail(feature: &FrameFeatures, detail_peak: f64) -> u16 {
    let [red, green, blue] = if feature.rms > f64::EPSILON {
        [
            linear_level(
                COLOR_DETAIL_RED_GAIN * feature.color_detail_red / feature.rms,
                7,
            ),
            linear_level(
                COLOR_DETAIL_GREEN_GAIN * feature.color_detail_green / feature.rms,
                7,
            ),
            linear_level(
                (COLOR_DETAIL_BLUE_GAIN * feature.color_detail_blue / feature.rms)
                    .clamp(0.0, 1.0)
                    .powf(COLOR_DETAIL_BLUE_EXPONENT),
                7,
            ),
        ]
    } else {
        [0; 3]
    };
    let normalized_peak = if detail_peak > f64::EPSILON {
        feature.peak / detail_peak
    } else {
        0.0
    };
    let height = waveform_height(normalized_peak, 31);
    (u16::from(red) << 13)
        | (u16::from(green) << 10)
        | (u16::from(blue) << 7)
        | (u16::from(height) << 2)
}

fn pack_three_band(feature: &FrameFeatures) -> [u8; 3] {
    [
        perceptual_level(feature.low, THREE_BAND_MAXIMUM),
        perceptual_level(feature.mid, THREE_BAND_MAXIMUM),
        perceptual_level(feature.high, THREE_BAND_MAXIMUM),
    ]
}

fn reduce_three_band_preview(detail: &[u8], width: usize) -> Vec<u8> {
    debug_assert!(detail.len().is_multiple_of(3));
    let detail_count = detail.len() / 3;
    if detail_count == 0 {
        return vec![0; width * 3];
    }
    (0..width)
        .flat_map(|column| {
            let start = (column * detail_count / width).min(detail_count - 1);
            let numerator = (column + 1)
                .checked_mul(detail_count)
                .expect("three-band preview range fits usize");
            let end = numerator.div_ceil(width).max(start + 1).min(detail_count);
            let count = u64::try_from(end - start).expect("preview range fits u64");
            let mut sums = [0_u64; 3];
            for entry in detail[start * 3..end * 3].chunks_exact(3) {
                for band in 0..3 {
                    sums[band] += u64::from(entry[band]);
                }
            }
            let means = sums.map(|sum| {
                u8::try_from((sum + count / 2) / count).expect("mean of seven-bit levels fits u8")
            });
            [
                calibrated_preview_level(
                    means[0],
                    THREE_BAND_PREVIEW_LOW_GAIN,
                    THREE_BAND_PREVIEW_LOW_POWER,
                ),
                calibrated_preview_level(
                    means[1],
                    THREE_BAND_PREVIEW_MID_GAIN,
                    THREE_BAND_PREVIEW_MID_POWER,
                ),
                means[2],
            ]
        })
        .collect()
}

fn calibrated_preview_level(level: u8, gain: f64, power: f64) -> u8 {
    let normalized = f64::from(level) / f64::from(THREE_BAND_MAXIMUM);
    (gain * normalized.powf(power) * f64::from(THREE_BAND_MAXIMUM))
        .round()
        .clamp(0.0, f64::from(THREE_BAND_MAXIMUM)) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streamed_batches_preserve_packed_waveforms() {
        let samples = (0..ANALYSIS_SAMPLE_RATE as usize * 3)
            .map(|index| {
                let phase = std::f64::consts::TAU * index as f64 / 44_100.0;
                (0.55 * (phase * 83.0).sin()
                    + 0.27 * (phase * 719.0).sin()
                    + 0.12 * (phase * 4_117.0).sin()) as f32
            })
            .collect::<Vec<_>>();
        let pcm = MonoPcm::new(ANALYSIS_SAMPLE_RATE, samples.clone()).expect("PCM");
        let expected = WaveformData::generate(&pcm).expect("waveforms");
        let mut accumulator = StreamingWaveformAccumulator::new();
        for chunk in samples.chunks(997) {
            accumulator.push(chunk);
        }
        assert_eq!(accumulator.finish(), expected);
    }

    #[cfg(target_arch = "aarch64")]
    #[test]
    fn aarch64_simd_filter_bank_is_scalar_bit_exact() {
        let mut scalar_bands = ScalarBandSplitter::default();
        let mut simd_bands = BandSplitter::default();
        let mut scalar_colors = ScalarColorBandSplitter::default();
        let mut simd_colors = ColorBandSplitter::default();

        for index in 0..44_100 {
            let phase = std::f64::consts::TAU * index as f64 / 44_100.0;
            let sample = 0.55 * (phase * 83.0).sin()
                + 0.27 * (phase * 719.0).sin()
                + 0.12 * (phase * 4_117.0).sin();
            let scalar_band_values = scalar_bands.process(sample);
            let simd_band_values = simd_bands.process(sample);
            for (scalar, simd) in [
                (scalar_band_values.0, simd_band_values.0),
                (scalar_band_values.1, simd_band_values.1),
                (scalar_band_values.2, simd_band_values.2),
            ] {
                assert_eq!(scalar.to_bits(), simd.to_bits());
            }

            let scalar = scalar_colors.process(sample);
            let simd = simd_colors.process(sample);
            for (scalar, simd) in [
                (scalar.preview_bottom, simd.preview_bottom),
                (scalar.preview_red, simd.preview_red),
                (scalar.preview_green, simd.preview_green),
                (scalar.preview_blue, simd.preview_blue),
                (scalar.detail_red, simd.detail_red),
                (scalar.detail_green, simd.detail_green),
                (scalar.detail_blue, simd.detail_blue),
            ] {
                assert_eq!(scalar.to_bits(), simd.to_bits());
            }
        }
    }

    #[cfg(target_arch = "aarch64")]
    #[test]
    fn aarch64_simd_feature_accumulation_is_scalar_bit_exact() {
        let samples = (0..44_100)
            .map(|index| {
                let phase = std::f64::consts::TAU * index as f64 / 44_100.0;
                (0.55 * (phase * 83.0).sin()
                    + 0.27 * (phase * 719.0).sin()
                    + 0.12 * (phase * 4_117.0).sin()) as f32
            })
            .collect();
        let pcm = MonoPcm::new(ANALYSIS_SAMPLE_RATE, samples).expect("PCM");
        let scalar = extract_detail_features_scalar(&pcm);
        let simd = extract_detail_features(&pcm);
        assert_eq!(scalar.len(), simd.len());
        for (scalar, simd) in scalar.iter().zip(simd) {
            for (scalar, simd) in [
                (scalar.peak, simd.peak),
                (scalar.rms, simd.rms),
                (scalar.color_preview_bottom, simd.color_preview_bottom),
                (scalar.color_preview_red, simd.color_preview_red),
                (scalar.color_preview_green, simd.color_preview_green),
                (scalar.color_preview_blue, simd.color_preview_blue),
                (scalar.color_detail_red, simd.color_detail_red),
                (scalar.color_detail_green, simd.color_detail_green),
                (scalar.color_detail_blue, simd.color_detail_blue),
                (scalar.low, simd.low),
                (scalar.mid, simd.mid),
                (scalar.high, simd.high),
            ] {
                assert_eq!(scalar.to_bits(), simd.to_bits());
            }
        }
    }

    #[cfg(target_arch = "aarch64")]
    #[test]
    fn aarch64_parallel_feature_chunks_preserve_packed_waveforms() {
        let samples = (0..ANALYSIS_SAMPLE_RATE as usize * 42)
            .map(|index| {
                let phase = std::f64::consts::TAU * index as f64 / 44_100.0;
                (0.55 * (phase * 83.0).sin()
                    + 0.27 * (phase * 719.0).sin()
                    + 0.12 * (phase * 4_117.0).sin()) as f32
            })
            .collect();
        let pcm = MonoPcm::new(ANALYSIS_SAMPLE_RATE, samples).expect("PCM");
        let scalar = extract_detail_features_scalar(&pcm);
        let parallel = extract_detail_features(&pcm);
        assert_eq!(scalar.len(), parallel.len());
        assert_eq!(pack_waveforms(&scalar), pack_waveforms(&parallel));
    }

    #[test]
    fn height_uses_peak_power_without_changing_band_loudness_curve() {
        assert_eq!(waveform_height(0.5, 31), 8);
        assert_eq!(perceptual_level(0.5, 31), 22);
    }

    #[test]
    fn color_preview_uses_linear_amplitude_and_inverse_luminance() {
        assert_eq!(
            pack_color_preview(&FrameFeatures {
                peak: 0.5,
                color_preview_bottom: 0.5,
                color_preview_red: 0.25,
                color_preview_green: 0.125,
                ..FrameFeatures::default()
            }),
            [64, 192, 64, 32, 16, 0]
        );
        assert_eq!(
            pack_color_preview(&FrameFeatures {
                peak: 0.001,
                ..FrameFeatures::default()
            }),
            [0; 6]
        );
    }

    #[test]
    fn color_detail_matches_reference_tone_hues_and_normalizes_track_peak() {
        fn analyze_tone(frequency_hz: f64, amplitude: f32) -> [u8; 4] {
            let samples = (0..ANALYSIS_SAMPLE_RATE as usize * 2)
                .map(|index| {
                    (2.0 * std::f64::consts::PI * frequency_hz * index as f64
                        / f64::from(ANALYSIS_SAMPLE_RATE))
                    .sin() as f32
                        * amplitude
                })
                .collect();
            let pcm = MonoPcm::new(ANALYSIS_SAMPLE_RATE, samples).expect("tone PCM");
            let waveforms = WaveformData::generate(&pcm).expect("tone waveforms");
            let offset = 100 * 2;
            let packed = u16::from_be_bytes([
                waveforms.color_detail()[offset],
                waveforms.color_detail()[offset + 1],
            ]);
            [
                ((packed >> 13) & 7) as u8,
                ((packed >> 10) & 7) as u8,
                ((packed >> 7) & 7) as u8,
                ((packed >> 2) & 31) as u8,
            ]
        }

        for amplitude in [0.5, 0.000_5] {
            assert_eq!(analyze_tone(80.0, amplitude), [7, 0, 0, 31]);
            assert_eq!(analyze_tone(500.0, amplitude), [0, 7, 1, 31]);
            assert_eq!(analyze_tone(4_000.0, amplitude), [0, 2, 7, 31]);
        }
    }

    #[test]
    fn one_second_signal_has_protocol_exact_entry_counts() {
        let pcm = MonoPcm::new(ANALYSIS_SAMPLE_RATE, vec![0.25; 44_100]).expect("PCM");
        let waveforms = WaveformData::generate(&pcm).expect("waveforms");
        assert_eq!(waveforms.monochrome_preview().len(), 400);
        assert_eq!(waveforms.tiny_preview().len(), 100);
        assert_eq!(waveforms.monochrome_detail().len(), 150);
        assert_eq!(waveforms.color_preview().len(), 1_200 * 6);
        assert_eq!(waveforms.color_detail().len(), 150 * 2);
        assert_eq!(waveforms.three_band_preview().len(), 1_200 * 3);
        assert_eq!(waveforms.three_band_detail().len(), 150 * 3);

        assert_eq!(waveforms.pwv3().header_unknown, Some(0x0096_0000));
        assert_eq!(waveforms.pwv4().header_unknown, Some(0));
        assert_eq!(waveforms.pwv5().header_unknown, Some(0x0096_0305));
        assert_eq!(waveforms.pwv6().header_unknown, None);
        assert_eq!(waveforms.pwv7().header_unknown, Some(0x0096_0000));
    }

    #[test]
    fn silence_is_zero_and_impulse_peak_lands_in_first_detail_column() {
        let silence =
            MonoPcm::new(ANALYSIS_SAMPLE_RATE, vec![0.0; DETAIL_FRAME_SAMPLES]).expect("PCM");
        let silent_waveforms = WaveformData::generate(&silence).expect("silent waveforms");
        assert!(
            silent_waveforms
                .monochrome_preview()
                .iter()
                .all(|value| *value == 0)
        );
        assert!(
            silent_waveforms
                .color_preview()
                .iter()
                .all(|value| *value == 0)
        );
        assert!(
            silent_waveforms
                .three_band_detail()
                .iter()
                .all(|value| *value == 0)
        );

        let mut samples = vec![0.0; DETAIL_FRAME_SAMPLES * 2];
        samples[0] = 1.0;
        let impulse = MonoPcm::new(ANALYSIS_SAMPLE_RATE, samples).expect("PCM");
        let impulse_waveforms = WaveformData::generate(&impulse).expect("impulse waveforms");
        assert_eq!(impulse_waveforms.monochrome_detail()[0] & 0x1f, 31);
        assert_eq!(impulse_waveforms.monochrome_detail()[1], 0);
    }

    #[test]
    fn three_band_packing_is_low_mid_high_with_seven_bit_levels() {
        assert_eq!(
            pack_three_band(&FrameFeatures {
                low: 1.0,
                mid: 0.25,
                high: 0.0,
                ..FrameFeatures::default()
            }),
            [127, 64, 0]
        );
        assert_eq!(
            pack_three_band(&FrameFeatures {
                low: 1.0,
                mid: 1.0,
                high: 1.0,
                ..FrameFeatures::default()
            }),
            [127; 3]
        );

        let dc = MonoPcm::new(ANALYSIS_SAMPLE_RATE, vec![1.0; 44_100]).expect("PCM");
        let dc_waveforms = WaveformData::generate(&dc).expect("DC waveforms");
        let dc_last =
            &dc_waveforms.three_band_detail()[dc_waveforms.three_band_detail().len() - 3..];
        assert!(dc_last[0] > dc_last[1]);
        assert!(dc_last[0] > dc_last[2]);

        let alternating = MonoPcm::new(
            ANALYSIS_SAMPLE_RATE,
            (0..44_100)
                .map(|index| if index % 2 == 0 { 1.0 } else { -1.0 })
                .collect(),
        )
        .expect("PCM");
        let alternating_waveforms =
            WaveformData::generate(&alternating).expect("alternating waveforms");
        let high_last = &alternating_waveforms.three_band_detail()
            [alternating_waveforms.three_band_detail().len() - 3..];
        assert!(high_last[2] > high_last[0]);
        assert!(
            dc_waveforms
                .three_band_detail()
                .iter()
                .chain(alternating_waveforms.three_band_detail())
                .all(|value| *value <= THREE_BAND_MAXIMUM)
        );
    }

    #[test]
    fn three_band_preview_mean_reduces_detail_with_band_quantizers() {
        assert_eq!(
            reduce_three_band_preview(&[0, 0, 0, 127, 127, 127], 1),
            [31, 42, 64]
        );
        assert_eq!(
            reduce_three_band_preview(&[127, 127, 127], 1),
            [69, 107, 127]
        );
        assert_eq!(reduce_three_band_preview(&[], 2), [0; 6]);
    }

    #[test]
    fn generated_entries_build_valid_anlz_tags() {
        let pcm = MonoPcm::new(ANALYSIS_SAMPLE_RATE, vec![0.5; 588]).expect("PCM");
        let waveforms = WaveformData::generate(&pcm).expect("waveforms");
        assert_eq!(waveforms.pwav_tag().expect("PWAV").kind(), *b"PWAV");
        assert_eq!(waveforms.pwv2_tag().expect("PWV2").kind(), *b"PWV2");
        for waveform in [
            waveforms.pwv3(),
            waveforms.pwv4(),
            waveforms.pwv5(),
            waveforms.pwv6(),
            waveforms.pwv7(),
        ] {
            let expected = waveform.kind;
            let tag = waveform.to_tag().expect("counted waveform tag");
            assert_eq!(tag.kind(), expected);
        }
    }
}
