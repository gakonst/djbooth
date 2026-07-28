//! Deterministic waveform feature extraction and ANLZ-ready entry packing.
//!
//! The container layouts and entry bit packing are understood. The proprietary
//! Rekordbox filters and quantizers are not; this module deliberately exposes a
//! stable clean-room baseline that can be differentially refined.

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
                .flat_map(|feature| pack_color_detail(feature).to_be_bytes())
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

fn extract_detail_features(pcm: &MonoPcm) -> Vec<FrameFeatures> {
    let mut splitter = BandSplitter::default();
    pcm.detail_frames()
        .map(|frame| {
            let mut peak = 0.0_f64;
            let mut sum_square = 0.0_f64;
            let mut low_square = 0.0_f64;
            let mut mid_square = 0.0_f64;
            let mut high_square = 0.0_f64;
            for sample in frame.valid_samples() {
                let sample = f64::from(*sample);
                peak = peak.max(sample.abs());
                sum_square += sample * sample;
                let (low, mid, high) = splitter.process(sample);
                low_square += low * low;
                mid_square += mid * mid;
                high_square += high * high;
            }
            let denominator = DETAIL_FRAME_SAMPLES as f64;
            FrameFeatures {
                peak,
                rms: (sum_square / denominator).sqrt(),
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

fn color_components(feature: &FrameFeatures, maximum: u8) -> [u8; 3] {
    let low = feature.low.clamp(0.0, 1.0);
    let mid = feature.mid.clamp(0.0, 1.0);
    let high = feature.high.clamp(0.0, 1.0);
    [
        perceptual_level((mid + high).min(1.0), maximum),
        perceptual_level((mid * 0.65 + high).min(1.0), maximum),
        perceptual_level((low + high).min(1.0), maximum),
    ]
}

fn pack_color_preview(feature: &FrameFeatures) -> [u8; 6] {
    if feature.peak <= f64::EPSILON {
        return [0; 6];
    }
    let [red, green, blue] = color_components(feature, 127);
    let lower_half = perceptual_level((feature.low + feature.mid).min(1.0), 127);
    [
        waveform_height(feature.peak, 127),
        127,
        lower_half,
        red,
        green,
        blue,
    ]
}

fn pack_color_detail(feature: &FrameFeatures) -> u16 {
    let [red, green, blue] = color_components(feature, 7);
    let height = waveform_height(feature.peak, 31);
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
