//! Deterministic waveform feature extraction and ANLZ-ready entry packing.
//!
//! The container layouts and entry bit packing are understood. Frequency
//! splits and quantizers are clean-room approximations derived from public
//! format documentation plus synthetic pure-tone differential probes.

use anyhow::{Result, bail};

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

        let detail_features = extract_detail_features(pcm);
        let detail_peak = detail_features
            .iter()
            .map(|feature| feature.peak)
            .fold(0.0_f64, f64::max);
        let monochrome_preview_features =
            reduce_features(&detail_features, MONOCHROME_PREVIEW_COLUMNS);
        let tiny_preview_features = reduce_features(&detail_features, TINY_PREVIEW_COLUMNS);
        let color_preview_features = reduce_features(&detail_features, COLOR_PREVIEW_COLUMNS);

        Ok(Self {
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
            three_band_preview: color_preview_features
                .iter()
                .flat_map(pack_three_band)
                .collect(),
            three_band_detail: detail_features.iter().flat_map(pack_three_band).collect(),
        })
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

#[derive(Debug, Clone, Copy, Default)]
struct BandSplitter {
    low_state: f64,
    high_cut_state: f64,
}

impl BandSplitter {
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

    fn process(&mut self, mut sample: f64) -> f64 {
        for stage in &mut self.stages {
            sample = stage.process(sample);
        }
        sample
    }
}

#[derive(Debug, Clone)]
struct ColorBandSplitter {
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

impl Default for ColorBandSplitter {
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

impl ColorBandSplitter {
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

fn extract_detail_features(pcm: &MonoPcm) -> Vec<FrameFeatures> {
    let mut splitter = BandSplitter::default();
    let mut color_splitter = ColorBandSplitter::default();
    pcm.detail_frames()
        .map(|frame| {
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
            for sample in frame.valid_samples() {
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
        })
        .collect()
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

#[cfg(test)]
mod tests {
    use super::*;

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
