//! Deterministic waveform feature extraction and ANLZ-ready entry packing.
//!
//! The container layouts and entry bit packing are understood. Frequency
//! splits and quantizers are clean-room implementations derived from public
//! format documentation, synthetic probes, and static differential analysis.

#[cfg(target_arch = "aarch64")]
use core::arch::aarch64::{
    float64x2_t, vaddq_f64, vdupq_n_f64, vextq_f64, vgetq_lane_f64, vld1q_f64, vmaxq_f64,
    vmulq_f64, vst1q_f64, vsubq_f64, vuzp2q_f64,
};

use anyhow::{Result, bail};
#[cfg(target_arch = "aarch64")]
use rayon::prelude::*;
use std::collections::VecDeque;

use crate::anlz::{AnlzTag, CountedWaveform, build_waveform_tag};
use crate::audio::{ANALYSIS_SAMPLE_RATE, MonoPcm};

/// Fixed monochrome waveform preview width.
pub const MONOCHROME_PREVIEW_COLUMNS: usize = 400;

/// Fixed legacy tiny waveform preview width.
pub const TINY_PREVIEW_COLUMNS: usize = 100;

/// Fixed color and three-band waveform preview width.
pub const COLOR_PREVIEW_COLUMNS: usize = 1_200;

const PWV3_FORMAT_WORD: u32 = 0x0096_0000;
const PWV4_FORMAT_WORD: u32 = 0;
const PWV5_FORMAT_WORD: u32 = 0x0096_0305;
const PWV7_FORMAT_WORD: u32 = 0x0096_0000;
const THREE_BAND_MAXIMUM: u8 = 127;
const THREE_BAND_RAW_RATE: usize = 1_000;
const THREE_BAND_LOW_HISTORY: usize = 300;
const THREE_BAND_MID_HISTORY: usize = 200;
const THREE_BAND_HIGH_HISTORY: usize = 100;
const THREE_BAND_LOW_DECAY: f64 = 0.99;
const THREE_BAND_MID_DECAY: f64 = 0.98;
const THREE_BAND_HIGH_DECAY: f64 = 0.97;
const THREE_BAND_LINEAR_DIVISOR: f64 = 256.0;
const THREE_BAND_COSINE_SCALE: f64 = 64.0;
const LEGACY_RAW_RATE: usize = 1_000;
const LEGACY_RED_RADIUS: usize = 12;
const LEGACY_GREEN_RADIUS: usize = 1;
const COLOR_HEIGHT_SCALE: f64 = 2.932_745_123_302_746_6e-8;
const MONOCHROME_DETAIL_RATE: usize = 150;
const NATIVE_LOUD_DECAY: f32 = f32::from_bits(0x3f7e_6baa);
const NATIVE_LOUD_900_FLOOR: f32 = f32::from_bits(0x43a3_d70a);

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
    three_band_normalize: [u16; 3],
}

impl WaveformData {
    /// Generate deterministic waveform entries from 44.1 or 48 kHz mono PCM.
    ///
    /// Detailed arrays use 150 equal-rate columns per second.
    /// Preview arrays reduce those columns to their fixed protocol widths by
    /// taking maxima over exact integer-ratio ranges.
    pub fn generate(pcm: &MonoPcm) -> Result<Self> {
        Self::generate_native(pcm, pcm)
    }

    pub(crate) fn generate_native(color_pcm: &MonoPcm, monochrome_pcm: &MonoPcm) -> Result<Self> {
        if !matches!(color_pcm.sample_rate(), 44_100 | 48_000) {
            bail!(
                "waveform generation requires 44100 or 48000 Hz PCM, received {} Hz",
                color_pcm.sample_rate()
            );
        }
        if monochrome_pcm.sample_rate() != color_pcm.sample_rate()
            || monochrome_pcm.len() != color_pcm.len()
        {
            bail!("color and monochrome waveform PCM must have matching rates and lengths");
        }

        let monochrome_detail = MonochromeDetailAccumulator::from_pcm(monochrome_pcm).finish();
        let detail_count = monochrome_detail.len();
        let loud_preview = NativeLoudPreviewAccumulator::from_pcm(color_pcm).finish();
        let legacy = LegacyWaveformAccumulator::from_pcm(color_pcm).finish(detail_count);
        let three_band = ThreeBandAccumulator::from_pcm(color_pcm)
            .into_source()
            .finish(detail_count);
        Ok(pack_waveforms(
            loud_preview,
            monochrome_detail,
            legacy,
            three_band,
        ))
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

    /// Native per-band normalization coefficients stored in `PWVC`.
    pub fn three_band_normalize(&self) -> [u16; 3] {
        self.three_band_normalize
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

fn pack_waveforms(
    loud_preview: NativeLoudPreviewWaveforms,
    monochrome_detail: Vec<u8>,
    legacy: LegacyWaveforms,
    three_band: ThreeBandWaveforms,
) -> WaveformData {
    WaveformData {
        monochrome_preview: loud_preview.monochrome,
        tiny_preview: loud_preview.tiny,
        monochrome_detail,
        color_preview: legacy.preview,
        color_detail: legacy.detail,
        three_band_preview: three_band.preview,
        three_band_detail: three_band.detail,
        three_band_normalize: three_band.normalize,
    }
}

#[derive(Debug, Clone, Copy)]
struct NativeZoomLowPass {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}

impl NativeZoomLowPass {
    fn new(sample_rate: u32) -> Self {
        let k = (std::f64::consts::PI * 150.0 / f64::from(sample_rate)).tan();
        let k_squared = k * k;
        let normalization = 1.0 / (1.0 + std::f64::consts::SQRT_2 * k + k_squared);
        Self {
            b0: k_squared * normalization,
            b1: 2.0 * k_squared * normalization,
            b2: k_squared * normalization,
            a1: 2.0 * (k_squared - 1.0) * normalization,
            a2: (1.0 - std::f64::consts::SQRT_2 * k + k_squared) * normalization,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    #[inline(always)]
    fn process(&mut self, sample: f64) -> f64 {
        let output = self.b0 * sample + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = sample;
        self.y2 = self.y1;
        self.y1 = output;
        output
    }
}

#[derive(Debug, Clone, Copy)]
struct NativeZoomFrame {
    peak: i16,
    whiteness: u8,
}

struct MonochromeDetailAccumulator {
    filter: NativeZoomLowPass,
    frames: Vec<NativeZoomFrame>,
    frame_samples: usize,
    frame_count: usize,
    frame_peak: i16,
    frame_filtered_peak: i16,
    global_peak: i16,
}

impl MonochromeDetailAccumulator {
    fn new(sample_rate: u32) -> Self {
        Self {
            filter: NativeZoomLowPass::new(sample_rate),
            frames: Vec::new(),
            frame_samples: usize::try_from(sample_rate)
                .expect("sample rate fits waveform arithmetic")
                / MONOCHROME_DETAIL_RATE,
            frame_count: 0,
            frame_peak: 0,
            frame_filtered_peak: 0,
            global_peak: 0,
        }
    }

    fn from_pcm(pcm: &MonoPcm) -> Self {
        let mut accumulator = Self::new(pcm.sample_rate());
        accumulator.push(pcm.samples());
        accumulator
    }

    fn push(&mut self, samples: &[f32]) {
        for &sample in samples {
            let sample = normalized_to_i16(sample);
            let peak = saturating_i16_magnitude(sample);
            self.frame_peak = self.frame_peak.max(peak);
            self.global_peak = self.global_peak.max(peak);

            let filtered = self.filter.process(f64::from(sample)).trunc() as i32;
            let filtered_peak = filtered.unsigned_abs().min(i16::MAX as u32) as i16;
            self.frame_filtered_peak = self.frame_filtered_peak.max(filtered_peak);
            self.frame_count += 1;
            if self.frame_count == self.frame_samples {
                self.finish_frame();
            }
        }
    }

    fn finish(mut self) -> Vec<u8> {
        if self.frame_count != 0 {
            self.finish_frame();
        }
        let global_peak = i32::from(self.global_peak);
        self.frames
            .into_iter()
            .map(|frame| {
                let height = if global_peak == 0 {
                    0
                } else {
                    let normalized =
                        (f64::from(frame.peak) * 32_767.0 / f64::from(global_peak)) as i32;
                    ((f64::from(normalized * normalized) * COLOR_HEIGHT_SCALE) as u8) & 0x1f
                };
                (frame.whiteness << 5) | height
            })
            .collect()
    }

    fn finish_frame(&mut self) {
        self.frames.push(NativeZoomFrame {
            peak: self.frame_peak,
            whiteness: native_zoom_whiteness(self.frame_filtered_peak, self.frame_peak),
        });
        self.frame_count = 0;
        self.frame_peak = 0;
        self.frame_filtered_peak = 0;
    }
}

fn normalized_to_i16(sample: f32) -> i16 {
    (sample * 32_768.0)
        .clamp(f32::from(i16::MIN), f32::from(i16::MAX))
        .trunc() as i16
}

fn saturating_i16_magnitude(sample: i16) -> i16 {
    i32::from(sample).unsigned_abs().min(i16::MAX as u32) as i16
}

fn native_zoom_whiteness(filtered_peak: i16, peak: i16) -> u8 {
    if peak == 0 {
        return 7;
    }
    let ratio = f64::from(filtered_peak) / f64::from(peak);
    if ratio >= 0.875 {
        0
    } else if ratio >= 0.75 {
        1
    } else if ratio >= 0.625 {
        2
    } else if ratio >= 0.5 {
        3
    } else if ratio >= 0.375 {
        4
    } else if ratio >= 0.25 {
        5
    } else if ratio >= 0.125 {
        6
    } else {
        7
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
    fn new_at(cutoff_hz: f64, q: f64, high_pass: bool, sample_rate: u32) -> Self {
        let omega = 2.0 * std::f64::consts::PI * cutoff_hz / f64::from(sample_rate);
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

    fn band_pass_at(cutoff_hz: f64, q: f64, sample_rate: u32) -> Self {
        let omega = 2.0 * std::f64::consts::PI * cutoff_hz / f64::from(sample_rate);
        let cosine = omega.cos();
        let alpha = omega.sin() / (2.0 * q);
        let a0 = 1.0 + alpha;
        Self {
            b0: alpha / a0,
            b1: 0.0,
            b2: -alpha / a0,
            a1: -2.0 * cosine / a0,
            a2: (1.0 - alpha) / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    #[cfg_attr(target_arch = "aarch64", allow(dead_code))]
    #[inline(always)]
    fn process(&mut self, sample: f64) -> f64 {
        let output = self.b0 * sample + self.z1;
        self.z1 = self.b1 * sample - self.a1 * output + self.z2;
        self.z2 = self.b2 * sample - self.a2 * output;
        output
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NativeLoudPreviewWaveforms {
    monochrome: Vec<u8>,
    tiny: Vec<u8>,
}

#[derive(Debug, Clone, Copy)]
struct NativeLoudEvent {
    frame: usize,
    amplitude: f32,
}

#[derive(Debug, Clone, Copy)]
struct NativeLoudRawBatch {
    frame: usize,
    value: f32,
    delayed: bool,
}

#[derive(Debug, Clone, Copy)]
struct NativeLoudPeakDetector {
    current: f32,
    position: i64,
    started: bool,
}

impl Default for NativeLoudPeakDetector {
    fn default() -> Self {
        Self {
            current: 0.01,
            position: 0,
            started: false,
        }
    }
}

impl NativeLoudPeakDetector {
    fn process_frame(
        &mut self,
        samples: &[f32],
        sample_rate: u32,
        band: usize,
        frame: usize,
        final_frame: bool,
        events: &mut Vec<NativeLoudEvent>,
    ) -> bool {
        let multiplier = if band == 2 { 0.66_f32 } else { 0.75_f32 };
        let start_samples = f64::from(sample_rate) * 0.32;
        let decay_samples = f64::from(sample_rate) * 1.714;
        let decay_step = (f64::from(sample_rate) * 0.011_609_977_324_263_039).trunc() as i64;
        let mut low_trigger = false;
        let mut decay_position = 0_i64;

        for (index, &sample) in samples.iter().enumerate() {
            self.position += 1;
            if !self.started {
                if f64::from(sample) > 0.01 {
                    self.started = true;
                    self.current = sample;
                    self.position = 0;
                    if band == 0 {
                        low_trigger = true;
                    }
                }
            } else {
                let current = self.current;
                let qualifies = if f64::from(current) > 0.01 {
                    sample >= current * multiplier
                } else {
                    f64::from(sample) >= 0.01
                };
                if qualifies {
                    if (self.position as f64) >= start_samples {
                        events.push(NativeLoudEvent {
                            frame,
                            amplitude: current,
                        });
                        self.current = sample;
                        self.position = 0;
                        decay_position = 0;
                        if band == 0 {
                            low_trigger = true;
                        }
                    } else if sample > current {
                        self.current = sample;
                    }
                } else if (self.position as f64) > decay_samples {
                    decay_position += 1;
                    if decay_position >= decay_step {
                        self.current *= NATIVE_LOUD_DECAY;
                        if f64::from(self.current) <= 0.01 {
                            self.current = 0.01;
                        }
                        decay_position = 0;
                    }
                }
            }

            if final_frame && index + 1 == samples.len() {
                events.push(NativeLoudEvent {
                    frame,
                    amplitude: self.current,
                });
            }
        }
        low_trigger
    }

    fn process_frame_900(
        &mut self,
        samples: &[f32],
        sample_rate: u32,
        band: usize,
        frame: usize,
        final_frame: bool,
        events: &mut Vec<NativeLoudEvent>,
    ) {
        let multiplier = if band == 2 { 0.66_f32 } else { 0.75_f32 };
        let start_samples = f64::from(sample_rate) * 0.32;
        let decay_samples = f64::from(sample_rate) * 1.714;
        let decay_step = (f64::from(sample_rate) * 0.011_609_977_324_263_039).trunc() as i64;
        let mut pooled = 0.0_f32;
        let mut decay_position = 0_i64;

        for (index, &sample) in samples.iter().enumerate() {
            self.position += 1;
            pooled = pooled.max(sample);
            let final_sample = final_frame && index + 1 == samples.len();
            if self.position & 3 != 0 && !final_sample {
                continue;
            }

            if !self.started {
                if pooled > NATIVE_LOUD_900_FLOOR {
                    self.started = true;
                    self.current = pooled;
                    self.position = 0;
                    events.push(NativeLoudEvent {
                        frame,
                        amplitude: pooled,
                    });
                }
            } else {
                let current = self.current;
                let qualifies = if current > NATIVE_LOUD_900_FLOOR {
                    pooled >= current * multiplier
                } else {
                    pooled >= NATIVE_LOUD_900_FLOOR
                };
                if qualifies {
                    if (self.position as f64) >= start_samples {
                        events.push(NativeLoudEvent {
                            frame,
                            amplitude: current,
                        });
                        self.current = pooled;
                        self.position = 0;
                        decay_position = 0;
                    } else if pooled > current {
                        self.current = pooled;
                    }
                } else if (self.position as f64) > decay_samples {
                    decay_position += 4;
                    if decay_position >= decay_step {
                        self.current =
                            (self.current * NATIVE_LOUD_DECAY).max(NATIVE_LOUD_900_FLOOR);
                        decay_position = 0;
                    }
                }
            }

            if final_sample {
                events.push(NativeLoudEvent {
                    frame,
                    amplitude: self.current,
                });
            }
            pooled = 0.0;
        }
    }
}

#[cfg(not(target_arch = "aarch64"))]
#[derive(Debug, Clone, Copy)]
struct ScalarNativeLoudFilterBank {
    low: [Biquad; 2],
    mid_high_pass: [Biquad; 2],
    crossover: LinkwitzRiley4,
}

#[cfg(not(target_arch = "aarch64"))]
impl ScalarNativeLoudFilterBank {
    fn new(sample_rate: u32) -> Self {
        let low = Biquad::band_pass_at(150.0, 0.899_999_976, sample_rate);
        let mid_high_pass = Biquad::new_at(283.0, 0.707_106_769, true, sample_rate);
        Self {
            low: [low; 2],
            mid_high_pass: [mid_high_pass; 2],
            crossover: LinkwitzRiley4::new(7_900.0, sample_rate),
        }
    }

    #[inline(always)]
    fn process(&mut self, sample: f32) -> [f32; 3] {
        let (mid_source, high) = self.crossover.process_pair(sample);
        [
            process_loud_filter(&mut self.low, f64::from(sample)),
            process_loud_filter(&mut self.mid_high_pass, f64::from(mid_source)),
            f64::from(high),
        ]
        .map(|value| (value as f32).abs() * 32_768.0)
    }
}

#[cfg(not(target_arch = "aarch64"))]
type NativeLoudFilterBank = ScalarNativeLoudFilterBank;

#[cfg(target_arch = "aarch64")]
struct NativeLoudFilterBank {
    low_mid: [BiquadPair; 2],
    crossover: LinkwitzRiley4,
}

#[cfg(target_arch = "aarch64")]
impl NativeLoudFilterBank {
    fn new(sample_rate: u32) -> Self {
        let low = Biquad::band_pass_at(150.0, 0.899_999_976, sample_rate);
        let mid_high_pass = Biquad::new_at(283.0, 0.707_106_769, true, sample_rate);
        Self {
            low_mid: [
                BiquadPair::new(low, mid_high_pass),
                BiquadPair::new(low, mid_high_pass),
            ],
            crossover: LinkwitzRiley4::new(7_900.0, sample_rate),
        }
    }

    #[inline(always)]
    fn process(&mut self, sample: f32) -> [f32; 3] {
        let (mid_source, high) = self.crossover.process_pair(sample);
        let input = load_f64x2([f64::from(sample), f64::from(mid_source)]);
        let first = self.low_mid[0].process(input);
        let [low, mid] = store_f64x2(self.low_mid[1].process(first));
        [low as f32, mid as f32, high].map(|value| value.abs() * 32_768.0)
    }
}

#[derive(Debug, Clone, Copy)]
struct LinkwitzRiley4 {
    g: f32,
    root_two: f32,
    h: f32,
    state: [f32; 4],
}

impl LinkwitzRiley4 {
    fn new(cutoff_hz: f32, sample_rate: u32) -> Self {
        let g = (std::f64::consts::PI * f64::from(cutoff_hz) / f64::from(sample_rate)).tan() as f32;
        let root_two = 2.0_f64.sqrt() as f32;
        let h = (1.0 / (1.0 + f64::from(root_two * g + g * g))) as f32;
        Self {
            g,
            root_two,
            h,
            state: [0.0; 4],
        }
    }

    #[inline(always)]
    fn process_pair(&mut self, input: f32) -> (f32, f32) {
        let high = (input - (self.root_two + self.g) * self.state[0] - self.state[1]) * self.h;
        let band = self.g * high + self.state[0];
        self.state[0] = self.g * high + band;
        let low = self.g * band + self.state[1];
        self.state[1] = self.g * band + low;

        let high_second = (low - (self.root_two + self.g) * self.state[2] - self.state[3]) * self.h;
        let band_second = self.g * high_second + self.state[2];
        self.state[2] = self.g * high_second + band_second;
        let low_second = self.g * band_second + self.state[3];
        self.state[3] = self.g * band_second + low_second;

        (low_second, low - self.root_two * band + high - low_second)
    }
}

#[cfg(not(target_arch = "aarch64"))]
#[inline(always)]
fn process_loud_filter<const N: usize>(stages: &mut [Biquad; N], mut sample: f64) -> f64 {
    for stage in stages {
        sample = stage.process(sample);
    }
    sample
}

struct NativeLoudPreviewAccumulator {
    sample_rate: u32,
    frame_samples: usize,
    filters: NativeLoudFilterBank,
    normal_detectors: [NativeLoudPeakDetector; 3],
    dot_detectors: [NativeLoudPeakDetector; 2],
    pending_frame: Vec<f32>,
    raw_scratch: Vec<f32>,
    band_scratch: [Vec<f32>; 3],
    held_sample: Option<f32>,
    processed_samples: usize,
    processed_frames: usize,
    raw_sum: f32,
    raw_batch_frames: usize,
    raw_batch_pending: bool,
    raw_batches: Vec<NativeLoudRawBatch>,
    normal_events: [Vec<NativeLoudEvent>; 3],
    dot_events: [Vec<NativeLoudEvent>; 2],
}

impl NativeLoudPreviewAccumulator {
    fn new(sample_rate: u32) -> Self {
        let frame_samples =
            usize::try_from(sample_rate).expect("sample rate fits waveform arithmetic") / 75;
        Self {
            sample_rate,
            frame_samples,
            filters: NativeLoudFilterBank::new(sample_rate),
            normal_detectors: [NativeLoudPeakDetector::default(); 3],
            dot_detectors: [NativeLoudPeakDetector::default(); 2],
            pending_frame: Vec::with_capacity(frame_samples),
            raw_scratch: Vec::with_capacity(frame_samples),
            band_scratch: std::array::from_fn(|_| Vec::with_capacity(frame_samples)),
            held_sample: None,
            processed_samples: 0,
            processed_frames: 0,
            raw_sum: 0.0,
            raw_batch_frames: 0,
            raw_batch_pending: false,
            raw_batches: Vec::new(),
            normal_events: std::array::from_fn(|_| Vec::new()),
            dot_events: std::array::from_fn(|_| Vec::new()),
        }
    }

    fn from_pcm(pcm: &MonoPcm) -> Self {
        let mut accumulator = Self::new(pcm.sample_rate());
        accumulator.push(pcm.samples());
        accumulator
    }

    fn push(&mut self, mut samples: &[f32]) {
        if samples.is_empty() {
            return;
        }
        if let Some(previous) = self.held_sample.take() {
            self.push_effective_samples(std::slice::from_ref(&previous));
        }
        let (&last, preceding) = samples.split_last().expect("non-empty loud sample chunk");
        samples = preceding;
        self.push_effective_samples(samples);
        self.held_sample = Some(last);
    }

    fn push_effective_samples(&mut self, mut samples: &[f32]) {
        while !samples.is_empty() {
            if self.pending_frame.len() == self.frame_samples {
                self.process_pending_frame(false);
            }
            let available = self.frame_samples - self.pending_frame.len();
            let take = available.min(samples.len());
            self.pending_frame.extend_from_slice(&samples[..take]);
            self.processed_samples += take;
            samples = &samples[take..];
        }
    }

    fn process_pending_frame(&mut self, final_frame: bool) {
        if self.pending_frame.is_empty() {
            return;
        }
        let mut frame = std::mem::take(&mut self.pending_frame);
        self.process_frame(&frame, final_frame);
        frame.clear();
        self.pending_frame = frame;
    }

    fn process_frame(&mut self, samples: &[f32], final_frame: bool) {
        self.processed_frames += 1;
        let frame = self.processed_frames;
        self.raw_scratch.clear();
        for band in &mut self.band_scratch {
            band.clear();
        }
        for &sample in samples {
            self.raw_scratch.push(sample * 32_768.0);
            let filtered = self.filters.process(sample);
            for (output, value) in self.band_scratch.iter_mut().zip(filtered) {
                output.push(value);
            }
        }

        let mut low_trigger = false;
        for (band, samples) in self.band_scratch.iter().enumerate() {
            let triggered = self.normal_detectors[band].process_frame(
                samples,
                self.sample_rate,
                band,
                frame,
                final_frame,
                &mut self.normal_events[band],
            );
            low_trigger |= band == 0 && triggered;
        }
        for (band, samples) in self.band_scratch.iter().enumerate().take(2) {
            self.dot_detectors[band].process_frame_900(
                samples,
                self.sample_rate,
                band,
                frame,
                final_frame,
                &mut self.dot_events[band],
            );
        }

        self.raw_sum += native_loud_frame_sum(&self.raw_scratch);
        if self.raw_batch_frames > 7 || low_trigger || final_frame {
            let divisor = ((self.raw_batch_frames + 1) * self.frame_samples) as f32;
            self.raw_batches.push(NativeLoudRawBatch {
                frame,
                value: self.raw_sum / divisor,
                delayed: self.raw_batch_pending,
            });
            self.raw_sum = 0.0;
            self.raw_batch_frames = 0;
            self.raw_batch_pending = low_trigger;
        } else {
            self.raw_batch_frames += 1;
        }
    }

    fn finish(mut self) -> NativeLoudPreviewWaveforms {
        self.held_sample = None;
        self.process_pending_frame(true);
        if self.processed_frames == 0 {
            return NativeLoudPreviewWaveforms {
                monochrome: vec![0xa2; MONOCHROME_PREVIEW_COLUMNS],
                tiny: vec![1; TINY_PREVIEW_COLUMNS],
            };
        }

        let raw = map_native_loud_raw(self.processed_frames, &self.raw_batches);
        let bands = self
            .normal_events
            .each_ref()
            .map(|events| map_native_loud_events(self.processed_frames, events));
        let dots = self
            .dot_events
            .each_ref()
            .map(|events| map_native_loud_dots(self.processed_samples, self.frame_samples, events));
        NativeLoudPreviewWaveforms {
            monochrome: pack_native_loud_preview(&raw, &bands),
            tiny: dots[0]
                .iter()
                .copied()
                .zip(dots[1])
                .map(|(primary, secondary)| {
                    native_loud_tiny_height(primary).max(if secondary > 0 { 2 } else { 1 })
                })
                .collect(),
        }
    }
}

fn native_loud_frame_sum(samples: &[f32]) -> f32 {
    samples
        .iter()
        .copied()
        .map(f32::abs)
        .fold(0.0_f32, |sum, sample| sum + sample)
}

fn map_native_loud_raw(
    frame_count: usize,
    batches: &[NativeLoudRawBatch],
) -> [f32; MONOCHROME_PREVIEW_COLUMNS] {
    let mut output = [0.0_f32; MONOCHROME_PREVIEW_COLUMNS];
    let inverse_frames = 1.0_f32 / frame_count as f32;
    let mut output_index = 0usize;
    let mut output_value = 0.0_f32;
    let mut delayed_index = 0usize;
    let mut batch_index = 0usize;

    for frame in 1..=frame_count {
        output[output_index] = output_value;
        let target = if frame == frame_count {
            MONOCHROME_PREVIEW_COLUMNS
        } else {
            ((frame as f32) * MONOCHROME_PREVIEW_COLUMNS as f32 * inverse_frames)
                .trunc()
                .clamp(0.0, (MONOCHROME_PREVIEW_COLUMNS - 1) as f32) as usize
        };
        if target > output_index {
            output[output_index] = output_value * 15_000.0 * inverse_frames;
            output[(output_index + 1)..target.min(MONOCHROME_PREVIEW_COLUMNS)].fill(0.0);
            output_index = target;
        }

        while batches
            .get(batch_index)
            .is_some_and(|batch| batch.frame == frame)
        {
            let batch = batches[batch_index];
            if output_index < MONOCHROME_PREVIEW_COLUMNS {
                if batch.delayed {
                    let value = if output_index == delayed_index {
                        batch.value
                    } else {
                        batch.value * 15_000.0 * inverse_frames
                    };
                    output[delayed_index] += value;
                } else {
                    output[output_index] += batch.value;
                    delayed_index = output_index;
                }
            }
            batch_index += 1;
        }
        if output_index < MONOCHROME_PREVIEW_COLUMNS {
            output_value = output[output_index];
        }
    }
    output
}

fn map_native_loud_events(
    frame_count: usize,
    events: &[NativeLoudEvent],
) -> [f32; MONOCHROME_PREVIEW_COLUMNS] {
    let mut accumulators = [0_i64; MONOCHROME_PREVIEW_COLUMNS / 2];
    let inverse_frames = 1.0_f32 / frame_count as f32;
    for event in events {
        let pair = ((event.frame as f32) * 200.0 * inverse_frames).trunc() as usize;
        if let Some(accumulator) = accumulators.get_mut(pair) {
            *accumulator += event.amplitude.trunc() as i64;
        }
    }
    let mut output = [0.0_f32; MONOCHROME_PREVIEW_COLUMNS];
    for (pair, accumulator) in accumulators.into_iter().enumerate() {
        let value = accumulator as f32 * 7_500.0 * inverse_frames;
        output[pair * 2] = value;
        output[pair * 2 + 1] = value;
    }
    output
}

fn map_native_loud_dots(
    sample_count: usize,
    frame_samples: usize,
    events: &[NativeLoudEvent],
) -> [i64; TINY_PREVIEW_COLUMNS] {
    let whole_frames = sample_count / frame_samples;
    let step = if whole_frames >= TINY_PREVIEW_COLUMNS {
        whole_frames / TINY_PREVIEW_COLUMNS
    } else {
        1
    };
    let mut accumulators = [0_i64; TINY_PREVIEW_COLUMNS];
    for event in events {
        if event.frame < 51 || event.frame > whole_frames {
            continue;
        }
        let index = (event.frame / step).min(TINY_PREVIEW_COLUMNS - 1);
        accumulators[index] += event.amplitude.trunc() as i64;
    }
    accumulators.map(|value| value.saturating_mul(75) / (step as i64 * 2))
}

fn pack_native_loud_preview(
    raw: &[f32; MONOCHROME_PREVIEW_COLUMNS],
    bands: &[[f32; MONOCHROME_PREVIEW_COLUMNS]; 3],
) -> Vec<u8> {
    (0..MONOCHROME_PREVIEW_COLUMNS)
        .map(|index| {
            let low = bands[0][index];
            let mid = bands[1][index];
            let high = bands[2][index];
            let factor = (low * 0.75 * (1.0 / 32_768.0) + 0.25).min(1.0);
            let height = native_loud_height(raw[index] * factor);
            let low_level = native_loud_level(low * 0.5);
            let mid_level = native_loud_level(mid * 0.25);
            let high_level = native_loud_level(high);
            let difference = mid_level - high_level;
            let color = if low_level < 14 {
                if difference < 4 { 5 } else { 4 }
            } else if difference < 0 {
                if low_level <= high_level { 3 } else { 2 }
            } else if low_level <= mid_level {
                1
            } else {
                0
            };
            (color << 5) | height
        })
        .collect()
}

fn native_loud_level(value: f32) -> i32 {
    if value <= 0.0 {
        return 0;
    }
    (20.0 * (f64::from(value) * 3.051_757_812_5e-5).log10() + 30.5).clamp(0.0, 30.0) as i32
}

fn native_loud_height(value: f32) -> u8 {
    const THRESHOLDS: [f32; 23] = [
        f32::from_bits(0x4746_6666),
        39_321.6,
        30_801.92,
        25_886.72,
        23_265.28,
        21_299.2,
        19_333.12,
        17_367.04,
        15_892.48,
        14_909.44,
        13_926.4,
        12_943.36,
        11_960.32,
        10_977.28,
        9_994.24,
        9_011.2,
        8_028.16,
        7_045.12,
        6_062.08,
        5_079.04,
        4_096.0,
        3_112.96,
        2_195.456,
    ];

    let value = value.max(0.0);
    if value == 0.0 {
        return 2;
    }
    for (index, threshold) in THRESHOLDS.into_iter().enumerate() {
        if value >= threshold {
            return 25 - index as u8;
        }
    }
    2
}

fn native_loud_tiny_height(value: i64) -> u8 {
    match value {
        value if value > 0x50c2 => 15,
        value if value > 0x4025 => 14,
        value if value > 0x32f4 => 13,
        value if value > 0x2879 => 12,
        value if value > 0x2025 => 11,
        value if value > 0x1989 => 10,
        value if value > 0x1448 => 9,
        value if value > 0x101c => 8,
        value if value > 0x0ccb => 7,
        value if value > 0x0a29 => 6,
        value if value > 0x0812 => 5,
        value if value > 0x0669 => 4,
        value if value > 0x0517 => 3,
        value if value > 0 => 2,
        _ => 1,
    }
}

#[derive(Debug, Clone, Copy)]
struct LegacyRawWaveform {
    source_positive: i16,
    source_negative: i16,
    bottom: u16,
    whole_red: u16,
    whole_green: u16,
    whole_blue: u16,
    color_red: u16,
    color_green: u16,
    color_blue: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LegacyWaveforms {
    preview: Vec<u8>,
    detail: Vec<u8>,
}

#[derive(Debug, Clone, Copy)]
struct LegacyBucket {
    source_positive: f64,
    source_negative: f64,
    bottom: f64,
    whole_bands: [f64; 3],
    whole_dominance: [usize; 3],
    color_bands: [f64; 3],
    sample_count: usize,
}

impl Default for LegacyBucket {
    fn default() -> Self {
        Self {
            source_positive: f64::NEG_INFINITY,
            source_negative: f64::INFINITY,
            bottom: 0.0,
            whole_bands: [0.0; 3],
            whole_dominance: [0; 3],
            color_bands: [0.0; 3],
            sample_count: 0,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct LegacyFilterOutput {
    bottom: f64,
    whole: [f64; 3],
    color: [f64; 3],
}

#[cfg(not(target_arch = "aarch64"))]
struct ScalarLegacyFilterBank {
    whole_bottom: Biquad,
    whole_red_one: Biquad,
    whole_red_two: Biquad,
    whole_green_high_one: Biquad,
    whole_green_high_two: Biquad,
    whole_green_low_one: Biquad,
    whole_green_low_two: Biquad,
    whole_blue_one: Biquad,
    whole_blue_two: Biquad,
    color_red: Biquad,
    color_green_high: Biquad,
    color_green_low: Biquad,
    color_blue: Biquad,
}

#[cfg(not(target_arch = "aarch64"))]
impl ScalarLegacyFilterBank {
    fn new(sample_rate: u32) -> Self {
        let q = std::f64::consts::FRAC_1_SQRT_2;
        let low = |cutoff| Biquad::new_at(cutoff, q, false, sample_rate);
        let high = |cutoff| Biquad::new_at(cutoff, q, true, sample_rate);
        Self {
            whole_bottom: low(400.0),
            whole_red_one: low(200.0),
            whole_red_two: low(200.0),
            whole_green_high_one: high(200.0),
            whole_green_high_two: high(200.0),
            whole_green_low_one: low(2_000.0),
            whole_green_low_two: low(2_000.0),
            whole_blue_one: high(2_000.0),
            whole_blue_two: high(2_000.0),
            color_red: low(100.0),
            color_green_high: high(300.0),
            color_green_low: low(3_000.0),
            color_blue: high(1_500.0),
        }
    }

    fn process(&mut self, sample: f64) -> LegacyFilterOutput {
        let bottom = self.whole_bottom.process(sample);
        let whole_red = self
            .whole_red_two
            .process(self.whole_red_one.process(sample));
        let whole_green = self.whole_green_low_two.process(
            self.whole_green_low_one.process(
                self.whole_green_high_two
                    .process(self.whole_green_high_one.process(sample)),
            ),
        );
        let whole_blue = self
            .whole_blue_two
            .process(self.whole_blue_one.process(sample));
        let color_red = self.color_red.process(sample);
        let color_green = self
            .color_green_low
            .process(self.color_green_high.process(sample));
        let color_blue = self.color_blue.process(sample);
        LegacyFilterOutput {
            bottom,
            whole: [whole_red, whole_green, whole_blue],
            color: [color_red, color_green, color_blue],
        }
    }
}

#[cfg(not(target_arch = "aarch64"))]
type LegacyFilterBank = ScalarLegacyFilterBank;

struct LegacyWaveformAccumulator {
    filters: LegacyFilterBank,
    raw: Vec<LegacyRawWaveform>,
    bucket: LegacyBucket,
    sample_rate: usize,
    sample_count: usize,
    next_boundary: usize,
}

impl LegacyWaveformAccumulator {
    fn new(sample_rate: u32) -> Self {
        let sample_rate_usize =
            usize::try_from(sample_rate).expect("sample rate fits waveform arithmetic");
        Self {
            filters: LegacyFilterBank::new(sample_rate),
            raw: Vec::new(),
            bucket: LegacyBucket::default(),
            sample_rate: sample_rate_usize,
            sample_count: 0,
            next_boundary: sample_rate_usize.div_ceil(LEGACY_RAW_RATE),
        }
    }

    fn from_pcm(pcm: &MonoPcm) -> Self {
        let mut accumulator = Self::new(pcm.sample_rate());
        accumulator.push(pcm.samples());
        accumulator
    }

    fn push(&mut self, samples: &[f32]) {
        for &sample in samples {
            let sample = f64::from(sample);
            let filtered = self.filters.process(sample);

            self.bucket.source_positive = self.bucket.source_positive.max(sample);
            self.bucket.source_negative = self.bucket.source_negative.min(sample);
            self.bucket.bottom = self.bucket.bottom.max(filtered.bottom.abs());
            for (peak, value) in self.bucket.whole_bands.iter_mut().zip(filtered.whole) {
                *peak = peak.max(value.abs());
            }
            let dominant = if filtered.whole[0] >= filtered.whole[1]
                && filtered.whole[0] >= filtered.whole[2]
            {
                0
            } else if filtered.whole[2] >= filtered.whole[1] {
                2
            } else {
                1
            };
            self.bucket.whole_dominance[dominant] += 1;
            for (peak, value) in self.bucket.color_bands.iter_mut().zip(filtered.color) {
                *peak = peak.max(value.abs());
            }
            self.bucket.sample_count += 1;
            self.sample_count += 1;
            if self.sample_count == self.next_boundary {
                self.finish_bucket();
            }
        }
    }

    fn finish(mut self, detail_count: usize) -> LegacyWaveforms {
        if self.bucket.sample_count != 0 {
            self.finish_bucket();
        }
        build_legacy_waveforms(&self.raw, detail_count)
    }

    fn finish_bucket(&mut self) {
        let whole: [u16; 3] = std::array::from_fn(|band| {
            quantize_dominant_band(
                self.bucket.whole_bands[band],
                self.bucket.whole_dominance[band],
                self.bucket.sample_count,
            )
        });
        self.raw.push(LegacyRawWaveform {
            source_positive: quantize_signed_sample(self.bucket.source_positive),
            source_negative: quantize_signed_sample(self.bucket.source_negative),
            bottom: quantize_raw_band(self.bucket.bottom),
            whole_red: whole[0],
            whole_green: whole[1],
            whole_blue: whole[2],
            color_red: quantize_raw_band(self.bucket.color_bands[0]),
            color_green: quantize_raw_band(self.bucket.color_bands[1]),
            color_blue: quantize_raw_band(self.bucket.color_bands[2]),
        });
        self.bucket = LegacyBucket::default();
        self.next_boundary = (self.raw.len() + 1)
            .checked_mul(self.sample_rate)
            .expect("legacy waveform boundary overflow")
            .div_ceil(LEGACY_RAW_RATE);
    }
}

fn quantize_dominant_band(amplitude: f64, dominant_samples: usize, sample_count: usize) -> u16 {
    if amplitude >= 1.0 {
        i16::MAX as u16
    } else {
        (amplitude * 32_768.0 * dominant_samples as f64 / sample_count as f64).max(0.0) as u16
    }
}

fn quantize_signed_sample(sample: f64) -> i16 {
    if sample >= 1.0 {
        i16::MAX
    } else if sample < -1.0 {
        i16::MIN
    } else {
        (sample * 32_768.0) as i16
    }
}

fn centered_max(values: &[u16], radius: usize) -> Vec<u16> {
    let mut result = Vec::with_capacity(values.len());
    let mut candidates = VecDeque::with_capacity(radius * 2 + 1);
    let mut added = 0usize;
    for index in 0..values.len() {
        let end = (index + radius + 1).min(values.len());
        while added < end {
            while candidates
                .back()
                .is_some_and(|&candidate| values[candidate] <= values[added])
            {
                candidates.pop_back();
            }
            candidates.push_back(added);
            added += 1;
        }
        let start = index.saturating_sub(radius);
        while candidates
            .front()
            .is_some_and(|&candidate| candidate < start)
        {
            candidates.pop_front();
        }
        result.push(
            candidates
                .front()
                .map(|&candidate| values[candidate])
                .unwrap_or(0),
        );
    }
    result
}

#[derive(Debug, Clone, Copy)]
struct LegacyPreviewReduction {
    source_positive: i16,
    source_negative: i16,
    bottom: u16,
    red: u16,
    green: u16,
    blue: u16,
}

impl Default for LegacyPreviewReduction {
    fn default() -> Self {
        Self {
            source_positive: i16::MIN,
            source_negative: i16::MAX,
            bottom: 0,
            red: 0,
            green: 0,
            blue: 0,
        }
    }
}

impl LegacyPreviewReduction {
    fn add(&mut self, raw: LegacyRawWaveform, red: u16, green: u16) {
        self.source_positive = self.source_positive.max(raw.source_positive);
        self.source_negative = self.source_negative.min(raw.source_negative);
        self.bottom = self.bottom.max(raw.bottom);
        self.red = self.red.max(red);
        self.green = self.green.max(green);
        self.blue = self.blue.max(raw.whole_blue);
    }

    fn packed(self) -> [u8; 6] {
        [
            legacy_preview_byte(i32::from(self.source_positive)),
            legacy_preview_byte(i32::from(self.source_negative)),
            legacy_preview_byte(i32::from(self.bottom)),
            legacy_preview_byte(i32::from(self.red)),
            legacy_preview_byte(i32::from(self.green)),
            legacy_preview_byte(i32::from(self.blue)),
        ]
    }
}

fn legacy_preview_byte(value: i32) -> u8 {
    ((value as f32 * (1.0 / 256.0)) as i32) as u8
}

#[derive(Debug, Clone, Copy)]
struct LegacyColorReduction {
    source_positive: i16,
    source_negative: i16,
    red: u16,
    green: u16,
    blue: u16,
}

impl Default for LegacyColorReduction {
    fn default() -> Self {
        Self {
            source_positive: i16::MIN,
            source_negative: i16::MAX,
            red: 0,
            green: 0,
            blue: 0,
        }
    }
}

impl LegacyColorReduction {
    fn add(&mut self, raw: LegacyRawWaveform, red: u16, green: u16) {
        self.source_positive = self.source_positive.max(raw.source_positive);
        self.source_negative = self.source_negative.min(raw.source_negative);
        self.red = self.red.max(red);
        self.green = self.green.max(green);
        self.blue = self.blue.max(raw.color_blue);
    }

    fn peak(self) -> i32 {
        i32::from(self.source_positive)
            .abs()
            .max(i32::from(self.source_negative).abs())
    }
}

fn build_legacy_waveforms(raw: &[LegacyRawWaveform], detail_count: usize) -> LegacyWaveforms {
    if raw.is_empty() {
        return LegacyWaveforms {
            preview: vec![0; COLOR_PREVIEW_COLUMNS * 6],
            detail: vec![0; detail_count * 2],
        };
    }

    let whole_red = centered_max(
        &raw.iter().map(|entry| entry.whole_red).collect::<Vec<_>>(),
        LEGACY_RED_RADIUS,
    );
    let whole_green = centered_max(
        &raw.iter()
            .map(|entry| entry.whole_green)
            .collect::<Vec<_>>(),
        LEGACY_GREEN_RADIUS,
    );
    let color_red = centered_max(
        &raw.iter().map(|entry| entry.color_red).collect::<Vec<_>>(),
        LEGACY_RED_RADIUS,
    );
    let color_green = centered_max(
        &raw.iter()
            .map(|entry| entry.color_green)
            .collect::<Vec<_>>(),
        LEGACY_GREEN_RADIUS,
    );

    let mut preview = Vec::with_capacity(COLOR_PREVIEW_COLUMNS * 6);
    let mut preview_phase = 0usize;
    let mut preview_reduction = LegacyPreviewReduction::default();
    for (index, &entry) in raw.iter().enumerate() {
        preview_reduction.add(entry, whole_red[index], whole_green[index]);
        preview_phase += COLOR_PREVIEW_COLUMNS;
        if preview_phase >= raw.len() {
            let packed = preview_reduction.packed();
            while preview_phase >= raw.len() && preview.len() / 6 < COLOR_PREVIEW_COLUMNS {
                preview.extend_from_slice(&packed);
                preview_phase -= raw.len();
            }
            preview_reduction = LegacyPreviewReduction::default();
        }
    }

    let mut reduced = Vec::with_capacity(detail_count);
    let mut detail_phase = 0usize;
    let mut detail_reduction = LegacyColorReduction::default();
    for (index, &entry) in raw.iter().enumerate() {
        detail_reduction.add(entry, color_red[index], color_green[index]);
        detail_phase += detail_count;
        if detail_phase >= raw.len() {
            while detail_phase >= raw.len() && reduced.len() < detail_count {
                reduced.push(detail_reduction);
                detail_phase -= raw.len();
            }
            detail_reduction = LegacyColorReduction::default();
        }
    }

    let global_peak = raw
        .iter()
        .map(|entry| {
            i32::from(entry.source_positive)
                .abs()
                .max(i32::from(entry.source_negative).abs())
        })
        .max()
        .unwrap_or(0);
    let mut detail = Vec::with_capacity(detail_count * 2);
    for entry in reduced {
        let [red, green, blue] = native_color(entry.red, entry.green, entry.blue);
        let height = if global_peak > 0 {
            let normalized = (f64::from(entry.peak()) * 32_767.0 / f64::from(global_peak)) as i32;
            ((f64::from(normalized * normalized) * COLOR_HEIGHT_SCALE) as u8) & 0x1f
        } else {
            0
        };
        let packed = (u16::from(red) << 13)
            | (u16::from(green) << 10)
            | (u16::from(blue) << 7)
            | (u16::from(height) << 2);
        detail.extend_from_slice(&packed.to_be_bytes());
    }

    LegacyWaveforms { preview, detail }
}

fn native_color(red: u16, green: u16, blue: u16) -> [u8; 3] {
    let red = red as f32;
    let green = green as f32;
    let blue = blue as f32;
    let maximum = red.max(green).max(blue);
    let (mut red, mut green, mut blue) = if maximum == 0.0 {
        (255.0, 255.0, 255.0)
    } else {
        let scale = 255.0 / maximum;
        let mut red = red * scale;
        let mut green = green * scale;
        let mut blue = (blue * scale).clamp(0.0, 255.0);
        if blue < 64.0 {
            let correction = red * green * (1.0 / 765.0) * (1.0 - blue / 64.0);
            red -= correction;
            green -= correction;
        }
        green *= 1.0 - 0.002_343_75 * blue.max(red).min(128.0);
        blue *= 1.3;
        (red, green, blue)
    };
    red = red.clamp(0.0, 255.0);
    green = green.clamp(0.0, 255.0);
    blue = blue.clamp(0.0, 255.0);
    let bytes = [red as u8, green as u8, blue as u8];
    let mut levels = bytes.map(|value| value >> 5);
    if levels == [0; 3] {
        let maximum = bytes.into_iter().max().unwrap_or(0);
        levels = bytes.map(|value| u8::from(value == maximum));
    }
    levels
}

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
struct LegacyFilterBank {
    bottom_red_one: BiquadPair,
    green_one_blue_one: BiquadPair,
    color_red_green_one: BiquadPair,
    red_two_green_two: BiquadPair,
    blue_two_color_green: BiquadPair,
    green_three_color_blue: BiquadPair,
    green_four: BiquadPair,
}

#[cfg(target_arch = "aarch64")]
impl LegacyFilterBank {
    fn new(sample_rate: u32) -> Self {
        let q = std::f64::consts::FRAC_1_SQRT_2;
        let low = |cutoff| Biquad::new_at(cutoff, q, false, sample_rate);
        let high = |cutoff| Biquad::new_at(cutoff, q, true, sample_rate);
        Self {
            bottom_red_one: BiquadPair::new(low(400.0), low(200.0)),
            green_one_blue_one: BiquadPair::new(high(200.0), high(2_000.0)),
            color_red_green_one: BiquadPair::new(low(100.0), high(300.0)),
            red_two_green_two: BiquadPair::new(low(200.0), high(200.0)),
            blue_two_color_green: BiquadPair::new(high(2_000.0), low(3_000.0)),
            green_three_color_blue: BiquadPair::new(low(2_000.0), high(1_500.0)),
            green_four: BiquadPair::new(low(2_000.0), Biquad::default()),
        }
    }

    #[inline(always)]
    fn process(&mut self, sample: f64) -> LegacyFilterOutput {
        let input = unsafe { vdupq_n_f64(sample) };
        let bottom_red_one = self.bottom_red_one.process(input);
        let green_one_blue_one = self.green_one_blue_one.process(input);
        let color_red_green_one = self.color_red_green_one.process(input);
        let red_two_green_two = self
            .red_two_green_two
            .process(unsafe { vextq_f64::<1>(bottom_red_one, green_one_blue_one) });
        let blue_two_color_green = self
            .blue_two_color_green
            .process(unsafe { vuzp2q_f64(green_one_blue_one, color_red_green_one) });
        let green_three_color_blue = self
            .green_three_color_blue
            .process(unsafe { vextq_f64::<1>(red_two_green_two, input) });
        let green_four = self.green_four.process(green_three_color_blue);

        LegacyFilterOutput {
            bottom: unsafe { vgetq_lane_f64::<0>(bottom_red_one) },
            whole: [
                unsafe { vgetq_lane_f64::<0>(red_two_green_two) },
                unsafe { vgetq_lane_f64::<0>(green_four) },
                unsafe { vgetq_lane_f64::<0>(blue_two_color_green) },
            ],
            color: [
                unsafe { vgetq_lane_f64::<0>(color_red_green_one) },
                unsafe { vgetq_lane_f64::<1>(blue_two_color_green) },
                unsafe { vgetq_lane_f64::<1>(green_three_color_blue) },
            ],
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

pub(crate) struct StreamingWaveformAccumulator {
    loud: NativeLoudPreviewAccumulator,
    legacy: LegacyWaveformAccumulator,
    three_band: ThreeBandAccumulator,
    monochrome: MonochromeDetailAccumulator,
}

impl StreamingWaveformAccumulator {
    pub(crate) fn new() -> Self {
        Self {
            loud: NativeLoudPreviewAccumulator::new(ANALYSIS_SAMPLE_RATE),
            legacy: LegacyWaveformAccumulator::new(ANALYSIS_SAMPLE_RATE),
            three_band: ThreeBandAccumulator::new(ANALYSIS_SAMPLE_RATE),
            monochrome: MonochromeDetailAccumulator::new(ANALYSIS_SAMPLE_RATE),
        }
    }

    pub(crate) fn push_native(&mut self, color_samples: &[f32], monochrome_samples: &[f32]) {
        debug_assert_eq!(color_samples.len(), monochrome_samples.len());
        self.loud.push(color_samples);
        self.legacy.push(color_samples);
        self.three_band.push(color_samples);
        self.monochrome.push(monochrome_samples);
    }

    pub(crate) fn push(&mut self, samples: &[f32]) {
        self.push_native(samples, samples);
    }

    pub(crate) fn push_zeros(&mut self, mut count: usize) {
        const ZEROS: [f32; 1_024] = [0.0; 1_024];
        while count != 0 {
            let chunk = count.min(ZEROS.len());
            self.push(&ZEROS[..chunk]);
            count -= chunk;
        }
    }

    pub(crate) fn finish(self) -> WaveformData {
        let monochrome_detail = self.monochrome.finish();
        let detail_count = monochrome_detail.len();
        let legacy = self.legacy.finish(detail_count);
        let three_band = self.three_band.finish(detail_count);
        pack_waveforms(self.loud.finish(), monochrome_detail, legacy, three_band)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ThreeBandWaveforms {
    preview: Vec<u8>,
    detail: Vec<u8>,
    normalize: [u16; 3],
}

#[cfg(not(target_arch = "aarch64"))]
struct ScalarThreeBandFilterBank {
    low_pass: Biquad,
    mid_high_pass: Biquad,
    mid_low_pass: Biquad,
    high_high_pass: Biquad,
    high_low_pass: Biquad,
}

#[cfg(not(target_arch = "aarch64"))]
impl ScalarThreeBandFilterBank {
    fn new(sample_rate: u32) -> Self {
        let q = std::f64::consts::FRAC_1_SQRT_2;
        Self {
            low_pass: Biquad::new_at(300.0, q, false, sample_rate),
            mid_high_pass: Biquad::new_at(250.0, q, true, sample_rate),
            mid_low_pass: Biquad::new_at(1_200.0, q, false, sample_rate),
            high_high_pass: Biquad::new_at(3_000.0, q, true, sample_rate),
            high_low_pass: Biquad::new_at(9_000.0, q, false, sample_rate),
        }
    }

    fn process(&mut self, sample: f64) -> [f64; 3] {
        [
            self.low_pass.process(sample),
            self.mid_low_pass
                .process(self.mid_high_pass.process(sample)),
            self.high_low_pass
                .process(self.high_high_pass.process(sample)),
        ]
    }
}

#[cfg(target_arch = "aarch64")]
struct ThreeBandFilterBank {
    low_mid_one: BiquadPair,
    high_one: BiquadPair,
    mid_high_two: BiquadPair,
}

#[cfg(target_arch = "aarch64")]
impl ThreeBandFilterBank {
    fn new(sample_rate: u32) -> Self {
        let q = std::f64::consts::FRAC_1_SQRT_2;
        Self {
            low_mid_one: BiquadPair::new(
                Biquad::new_at(300.0, q, false, sample_rate),
                Biquad::new_at(250.0, q, true, sample_rate),
            ),
            high_one: BiquadPair::new(
                Biquad::new_at(3_000.0, q, true, sample_rate),
                Biquad::default(),
            ),
            mid_high_two: BiquadPair::new(
                Biquad::new_at(1_200.0, q, false, sample_rate),
                Biquad::new_at(9_000.0, q, false, sample_rate),
            ),
        }
    }

    #[inline(always)]
    fn process(&mut self, sample: f64) -> [f64; 3] {
        let input = unsafe { vdupq_n_f64(sample) };
        let low_mid_one = self.low_mid_one.process(input);
        let high_one = self.high_one.process(input);
        let mid_high_two = self
            .mid_high_two
            .process(unsafe { vextq_f64::<1>(low_mid_one, high_one) });
        [
            unsafe { vgetq_lane_f64::<0>(low_mid_one) },
            unsafe { vgetq_lane_f64::<0>(mid_high_two) },
            unsafe { vgetq_lane_f64::<1>(mid_high_two) },
        ]
    }
}

#[cfg(not(target_arch = "aarch64"))]
type ThreeBandFilterBank = ScalarThreeBandFilterBank;

struct ThreeBandAccumulator {
    sample_rate: u32,
    filters: ThreeBandFilterBank,
    raw: Vec<[u16; 3]>,
    bucket_peak: [f64; 3],
    bucket_has_samples: bool,
    sample_count: usize,
    next_boundary: usize,
}

impl ThreeBandAccumulator {
    fn new(sample_rate: u32) -> Self {
        debug_assert!(sample_rate >= THREE_BAND_RAW_RATE as u32);
        Self {
            sample_rate,
            filters: ThreeBandFilterBank::new(sample_rate),
            raw: Vec::new(),
            bucket_peak: [0.0; 3],
            bucket_has_samples: false,
            sample_count: 0,
            next_boundary: usize::try_from(sample_rate)
                .expect("sample rate fits usize")
                .div_ceil(THREE_BAND_RAW_RATE),
        }
    }

    fn from_pcm(pcm: &MonoPcm) -> Self {
        let mut accumulator = Self::new(pcm.sample_rate());
        accumulator.push(pcm.samples());
        accumulator
    }

    fn push(&mut self, samples: &[f32]) {
        for &sample in samples {
            let sample = f64::from(sample);
            for (peak, value) in self
                .bucket_peak
                .iter_mut()
                .zip(self.filters.process(sample))
            {
                *peak = peak.max(value.abs());
            }
            self.bucket_has_samples = true;
            self.sample_count += 1;
            if self.sample_count == self.next_boundary {
                self.finish_bucket();
            }
        }
    }

    fn finish(self, detail_count: usize) -> ThreeBandWaveforms {
        self.into_source().finish(detail_count)
    }

    fn into_source(mut self) -> ThreeBandSource {
        if self.bucket_has_samples {
            self.finish_bucket();
        }
        ThreeBandSource { raw: self.raw }
    }

    fn finish_bucket(&mut self) {
        self.raw.push(self.bucket_peak.map(quantize_raw_band));
        self.bucket_peak = [0.0; 3];
        self.bucket_has_samples = false;
        let next_bucket = self.raw.len() + 1;
        self.next_boundary = next_bucket
            .checked_mul(
                usize::try_from(self.sample_rate).expect("sample rate fits waveform arithmetic"),
            )
            .expect("three-band waveform boundary overflow")
            .div_ceil(THREE_BAND_RAW_RATE);
    }
}

struct ThreeBandSource {
    raw: Vec<[u16; 3]>,
}

impl ThreeBandSource {
    fn finish(self, detail_count: usize) -> ThreeBandWaveforms {
        build_three_band_waveforms(&self.raw, detail_count)
    }
}

fn quantize_raw_band(amplitude: f64) -> u16 {
    if amplitude >= 1.0 {
        i16::MAX as u16
    } else {
        (amplitude * 32_768.0).max(0.0) as u16
    }
}

fn build_three_band_waveforms(raw: &[[u16; 3]], detail_count: usize) -> ThreeBandWaveforms {
    if raw.is_empty() {
        return ThreeBandWaveforms {
            preview: vec![0; COLOR_PREVIEW_COLUMNS * 3],
            detail: vec![0; detail_count * 3],
            normalize: [80; 3],
        };
    }

    let preview_averages = three_band_preview_averages(raw);
    let band_sums = std::array::from_fn::<_, 3, _>(|band| {
        preview_averages
            .iter()
            .map(|entry| entry[band])
            .sum::<f64>()
    });
    let largest_sum = band_sums.into_iter().fold(0.0_f64, f64::max);
    let balance = band_sums.map(|sum| if sum > 0.0 { largest_sum / sum } else { 1.0 });
    let combined_max = preview_averages
        .iter()
        .map(|entry| entry[0] * balance[0] + entry[1] * balance[1] + entry[2] * balance[2])
        .fold(0.0_f64, f64::max);
    let scale = if combined_max > 0.0 {
        32_768.0 / combined_max
    } else {
        1.0
    };
    let raw_scale = balance.map(|value| value * scale);
    let maxima = std::array::from_fn::<_, 3, _>(|band| {
        raw.iter().map(|entry| entry[band]).max().unwrap_or(0)
    });
    let normalize = [
        native_normalize_coefficient(raw_scale[0], f64::from(maxima[0]), 3.0),
        native_normalize_coefficient(raw_scale[1], f64::from(maxima[1]), 3.0),
        native_normalize_coefficient(
            raw_scale[2],
            16_384.0 * (1.0 - (f64::from(maxima[2]) * std::f64::consts::PI / 32_768.0).cos()),
            5.0,
        ),
    ];
    let preview_gain = [
        raw_scale[0].clamp(0.8, 3.0),
        raw_scale[1].clamp(0.8, 3.0),
        raw_scale[2].clamp(0.8, 5.0),
    ];
    let preview = preview_averages
        .iter()
        .flat_map(|entry| {
            std::array::from_fn::<_, 3, _>(|band| {
                quantize_three_band(entry[band] / THREE_BAND_LINEAR_DIVISOR * preview_gain[band])
            })
        })
        .collect();
    let detail = three_band_detail(raw, detail_count, normalize);

    ThreeBandWaveforms {
        preview,
        detail,
        normalize,
    }
}

fn three_band_preview_averages(raw: &[[u16; 3]]) -> Vec<[f64; 3]> {
    let raw_count = raw.len();
    let low_history = raw_count / 1_000;
    let histories = [low_history, low_history * 2 / 3, raw_count / 3_000];
    let mut prefix = [
        Vec::with_capacity(raw_count + 1),
        Vec::with_capacity(raw_count + 1),
        Vec::with_capacity(raw_count + 1),
    ];
    for values in &mut prefix {
        values.push(0_u64);
    }
    for entry in raw {
        for band in 0..3 {
            prefix[band].push(prefix[band].last().copied().unwrap() + u64::from(entry[band]));
        }
    }

    let mut result = Vec::with_capacity(COLOR_PREVIEW_COLUMNS);
    let mut phase = 0usize;
    let mut segment_start = 0usize;
    for raw_index in 0..raw_count {
        phase += COLOR_PREVIEW_COLUMNS;
        if phase < raw_count {
            continue;
        }
        let averages = std::array::from_fn(|band| {
            let history_start = segment_start.saturating_sub(histories[band]);
            let sum = prefix[band][raw_index + 1] - prefix[band][history_start];
            let denominator = histories[band] + raw_index - segment_start + 1;
            sum as f64 / denominator as f64
        });
        while phase >= raw_count && result.len() < COLOR_PREVIEW_COLUMNS {
            result.push(averages);
            phase -= raw_count;
        }
        segment_start = raw_index + 1;
    }
    result.resize(COLOR_PREVIEW_COLUMNS, [0.0; 3]);
    result
}

fn native_normalize_coefficient(scale: f64, peak: f64, maximum: f64) -> u16 {
    let limited = if peak > 0.0 {
        scale.min(32_768.0 / peak)
    } else {
        scale
    };
    if limited < 0.8 {
        80
    } else {
        (limited.min(maximum) * 100.0) as u16
    }
}

fn three_band_detail(raw: &[[u16; 3]], count: usize, normalize: [u16; 3]) -> Vec<u8> {
    if count == 0 {
        return Vec::new();
    }
    let gains = normalize.map(|value| f64::from(f32::from(value) * 0.01_f32));
    let histories = [
        THREE_BAND_LOW_HISTORY,
        THREE_BAND_MID_HISTORY,
        THREE_BAND_HIGH_HISTORY,
    ];
    let decays = [
        THREE_BAND_LOW_DECAY,
        THREE_BAND_MID_DECAY,
        THREE_BAND_HIGH_DECAY,
    ];
    let mut raw_indices = Vec::with_capacity(count);
    let mut phase = 0usize;
    for raw_index in 0..raw.len() {
        phase += count;
        if phase < raw.len() {
            continue;
        }
        while phase >= raw.len() && raw_indices.len() < count {
            raw_indices.push(raw_index);
            phase -= raw.len();
        }
    }
    #[cfg(target_arch = "aarch64")]
    let entries = three_band_detail_entries(raw, &raw_indices, gains, histories, decays);
    #[cfg(not(target_arch = "aarch64"))]
    let entries = raw_indices
        .into_iter()
        .map(|raw_index| three_band_detail_entry(raw, raw_index, gains, histories, decays))
        .collect::<Vec<_>>();
    let mut result = entries.into_iter().flatten().collect::<Vec<_>>();
    result.resize(count * 3, 0);
    result
}

#[cfg(target_arch = "aarch64")]
fn three_band_detail_entries(
    raw: &[[u16; 3]],
    raw_indices: &[usize],
    gains: [f64; 3],
    histories: [usize; 3],
    decays: [f64; 3],
) -> Vec<[u8; 3]> {
    let mut entries = vec![[0; 3]; raw_indices.len()];
    if rayon::current_num_threads() >= 4 {
        entries
            .par_chunks_mut(2)
            .zip(raw_indices.par_chunks(2))
            .for_each(|(output, ends)| {
                three_band_detail_chunk(output, raw, ends, gains, histories, decays);
            });
    } else {
        for (output, ends) in entries.chunks_mut(2).zip(raw_indices.chunks(2)) {
            three_band_detail_chunk(output, raw, ends, gains, histories, decays);
        }
    }
    entries
}

#[cfg(target_arch = "aarch64")]
fn three_band_detail_chunk(
    output: &mut [[u8; 3]],
    raw: &[[u16; 3]],
    ends: &[usize],
    gains: [f64; 3],
    histories: [usize; 3],
    decays: [f64; 3],
) {
    if ends.len() == 1 {
        output[0] = three_band_detail_entry(raw, ends[0], gains, histories, decays);
        return;
    }
    let envelopes = std::array::from_fn::<_, 3, _>(|band| {
        finite_peak_followers_pair(raw, [ends[0], ends[1]], band, histories[band], decays[band])
    });
    for (lane, entry) in output.iter_mut().enumerate().take(2) {
        *entry = pack_three_band_detail(
            [envelopes[0][lane], envelopes[1][lane], envelopes[2][lane]],
            gains,
        );
    }
}

fn three_band_detail_entry(
    raw: &[[u16; 3]],
    raw_index: usize,
    gains: [f64; 3],
    histories: [usize; 3],
    decays: [f64; 3],
) -> [u8; 3] {
    let envelope = std::array::from_fn::<_, 3, _>(|band| {
        finite_peak_follower(raw, raw_index, band, histories[band], decays[band])
    });
    pack_three_band_detail(envelope, gains)
}

fn pack_three_band_detail(envelope: [f64; 3], gains: [f64; 3]) -> [u8; 3] {
    [
        quantize_three_band(envelope[0] / THREE_BAND_LINEAR_DIVISOR * gains[0]),
        quantize_three_band(envelope[1] / THREE_BAND_LINEAR_DIVISOR * gains[1]),
        quantize_three_band(
            THREE_BAND_COSINE_SCALE
                * (1.0 - (envelope[2] * std::f64::consts::PI / 32_768.0).cos())
                * gains[2],
        ),
    ]
}

#[cfg(target_arch = "aarch64")]
fn finite_peak_followers_pair(
    raw: &[[u16; 3]],
    ends: [usize; 2],
    band: usize,
    history: usize,
    decay: f64,
) -> [f64; 2] {
    if ends.iter().any(|end| *end < history) {
        return ends.map(|end| finite_peak_follower(raw, end, band, history, decay));
    }
    let starts = ends.map(|end| end - history);
    let mut state = load_f64x2(starts.map(|start| f64::from(raw[start][band])));
    let decay = unsafe { vdupq_n_f64(decay) };
    for offset in 0..=history {
        let sample = load_f64x2(starts.map(|start| f64::from(raw[start + offset][band])));
        let decayed = unsafe { vaddq_f64(sample, vmulq_f64(vsubq_f64(state, sample), decay)) };
        state = unsafe { vmaxq_f64(sample, decayed) };
    }
    store_f64x2(state).map(|value| f64::from(value as f32))
}

fn finite_peak_follower(
    raw: &[[u16; 3]],
    end: usize,
    band: usize,
    history: usize,
    decay: f64,
) -> f64 {
    let start = end.saturating_sub(history);
    let mut state = if end >= history {
        f64::from(raw[start][band])
    } else {
        0.0
    };
    for entry in &raw[start..=end] {
        let sample = f64::from(entry[band]);
        state = if state > sample {
            sample + (state - sample) * decay
        } else {
            sample
        };
    }
    f64::from(state as f32)
}

fn quantize_three_band(value: f64) -> u8 {
    value.clamp(0.0, f64::from(THREE_BAND_MAXIMUM)) as u8
}
