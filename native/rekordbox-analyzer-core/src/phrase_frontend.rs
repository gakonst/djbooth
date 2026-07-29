//! Recovered multirate frontend used by linked song-structure analysis.
//!
//! The native pipeline produces synchronized high-frequency `Fs/2`,
//! mid-band `Fs/8`, and low-band `Fs/32` streams. Each path cascades four
//! second-order Butterworth sections and emits the last source sample in every
//! decimation group.

use std::f64::consts::PI;
use std::ops::Range;

use anyhow::{Result, bail};

const BUTTERWORTH_DAMPING: [f64; 4] = [
    1.961_570_560_806_460_9,
    1.662_939_224_605_090_5,
    1.111_140_466_039_204_6,
    0.390_180_644_032_256_6,
];
const FOURTH_ORDER_DAMPING: [f64; 2] = [1.847_759_065_022_573_5, 0.765_366_864_730_179_6];
const SECOND_ORDER_DAMPING: f64 = std::f64::consts::SQRT_2;

/// Synchronized native-rate streams consumed by phrase feature extraction.
#[derive(Debug, Clone, PartialEq)]
pub struct PhraseMultiratePcm {
    /// Eighth-order high-pass output at half the reader rate.
    pub high_pass_2: Vec<f64>,
    /// Eighth-order low-pass output at one eighth of the reader rate.
    pub low_pass_8: Vec<f64>,
    /// Eighth-order low-pass output at one thirty-second of the reader rate.
    pub low_pass_32: Vec<f64>,
}

/// Native one-based beat positions for each song-structure analysis stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhraseBeatBoundaries {
    /// Beat positions at the `Fs/2` rate.
    pub high_pass_2: Vec<i32>,
    /// Beat positions at the `Fs/8` rate.
    pub low_pass_8: Vec<i32>,
    /// Beat positions at the `Fs/32` rate.
    pub low_pass_32: Vec<i32>,
}

/// Beat-synchronous feature traces recovered from the linked analyzer.
///
/// This is the complete diagnostic surface. Production boundary selection
/// consumes only the recovered low and divided-low families; phrase mood and
/// labels remain on the independently tuned decoder.
#[derive(Debug, Clone, PartialEq)]
pub struct NativePhraseFeatureTrace {
    /// One-based constant-tempo beat positions used by the native consumers.
    pub boundaries: PhraseBeatBoundaries,
    /// Low-pass 150 Hz, rectified, low-pass 5 Hz beat sums, scaled by four.
    pub low_level: Vec<f64>,
    /// High-pass 500 Hz, rectified, low-pass 5 Hz beat sums.
    pub middle_level: Vec<f64>,
    /// Low-pass 500 Hz energy from the `Fs/32` stream.
    pub divided_low_level: Vec<f64>,
    /// High-pass 500 Hz energy from the `Fs/8` stream.
    pub divided_middle_level: Vec<f64>,
    /// Low-pass 100 Hz, rectified, low-pass 5 Hz beat maxima.
    pub low_peak: Vec<f64>,
    /// Four quarter-beat low-peak maxima per beat.
    pub low_peak_quarters: Vec<[f64; 4]>,
    /// Band-pass 400–1000 Hz, rectified, low-pass 10 Hz beat maxima.
    pub middle_peak: Vec<f64>,
    /// Unfiltered absolute maxima from the `Fs/8` stream.
    pub all_level: Vec<f64>,
    /// Four quarter-beat unfiltered power sums.
    pub all_power_quarter_energy: Vec<[f64; 4]>,
    /// Four quarter-beat unfiltered absolute maxima.
    pub all_power_quarter_peak: Vec<[f64; 4]>,
    /// Band-pass 5–7 kHz, rectified, low-pass 10 Hz eighth-beat maxima.
    pub high_peak_eighths: Vec<[f64; 8]>,
}

/// One normalized native phrase feature and its two adjacent-change views.
#[derive(Debug, Clone, PartialEq)]
pub struct NativePhraseChangeFeatures {
    /// Max-normalized values after native zero substitution at ratio sites.
    pub normalized: Vec<f64>,
    /// Adjacent ratio folded above one with `max(r, 1 / r)`.
    pub symmetric_ratio: Vec<f64>,
    /// Directed adjacent ratio `next / current`.
    pub directional_ratio: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct NativePhraseLowLevelTrace {
    pub low_level: Vec<f64>,
    pub divided_low_level: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct NativePhraseLowLevelEnvelope {
    sample_rate: f64,
    low_level_samples: Vec<f64>,
    divided_low_samples: Vec<f64>,
}

#[derive(Debug, Clone, Copy)]
enum Response {
    LowPass,
    HighPass,
}

#[derive(Debug, Clone, Copy)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    state_1: f64,
    state_2: f64,
}

impl Biquad {
    fn butterworth(sample_rate: f64, cutoff: f64, damping: f64, response: Response) -> Self {
        let warped = (PI * cutoff / sample_rate).tan();
        let normalization = 1.0 / (1.0 + damping * warped + warped * warped);
        let (b0, b1, b2) = match response {
            Response::LowPass => {
                let b0 = warped * warped * normalization;
                (b0, 2.0 * b0, b0)
            }
            Response::HighPass => (normalization, -2.0 * normalization, normalization),
        };
        Self {
            b0,
            b1,
            b2,
            a1: 2.0 * (warped * warped - 1.0) * normalization,
            a2: (1.0 - damping * warped + warped * warped) * normalization,
            state_1: 0.0,
            state_2: 0.0,
        }
    }

    fn process(&mut self, sample: f64) -> f64 {
        let output = self.b0 * sample + self.state_1;
        self.state_1 = self.b1 * sample + self.state_2 - self.a1 * output;
        self.state_2 = self.b2 * sample - self.a2 * output;
        output
    }
}

#[derive(Debug, Clone, Copy)]
struct FirstOrderLowPass {
    b0: f64,
    b1: f64,
    a1: f64,
    previous_input: f64,
    previous_output: f64,
}

impl FirstOrderLowPass {
    fn new(sample_rate: f64, cutoff: f64) -> Self {
        let warped = (PI * cutoff / sample_rate).tan();
        let normalization = 1.0 / (1.0 + warped);
        Self {
            b0: warped * normalization,
            b1: warped * normalization,
            a1: (warped - 1.0) * normalization,
            previous_input: 0.0,
            previous_output: 0.0,
        }
    }

    fn process(&mut self, sample: f64) -> f64 {
        let output =
            self.b0 * sample + self.b1 * self.previous_input - self.a1 * self.previous_output;
        self.previous_input = sample;
        self.previous_output = output;
        output
    }
}

/// Generate the three linked-analyzer phrase streams.
///
/// Rekordbox routes readers to 44.1 or 48 kHz before this boundary. Samples
/// are processed in `f64`, matching the linked `MatArrayFloat` implementation.
/// Incomplete final decimation groups are intentionally discarded.
pub fn generate_phrase_multirate(samples: &[f32], sample_rate: u32) -> Result<PhraseMultiratePcm> {
    if !matches!(sample_rate, 44_100 | 48_000) {
        bail!("phrase multirate frontend requires a 44.1 or 48 kHz reader rate");
    }
    if samples.iter().any(|sample| !sample.is_finite()) {
        bail!("phrase multirate frontend requires finite PCM");
    }
    let sample_rate = f64::from(sample_rate);
    Ok(PhraseMultiratePcm {
        high_pass_2: filter_and_decimate(
            samples,
            sample_rate,
            sample_rate * 0.275,
            2,
            Response::HighPass,
        ),
        low_pass_8: filter_and_decimate(
            samples,
            sample_rate,
            sample_rate * 0.05,
            8,
            Response::LowPass,
        ),
        low_pass_32: filter_and_decimate(
            samples,
            sample_rate,
            sample_rate * 0.0125,
            32,
            Response::LowPass,
        ),
    })
}

/// Extract the linked analyzer's recovered beat-synchronous feature families.
///
/// `first_beat_ms` is the corrected first-grid offset used by the native
/// constant-tempo window builder. The returned positions retain its one-based
/// indexing and round-toward-zero behavior.
pub fn extract_native_phrase_features(
    samples: &[f32],
    sample_rate: u32,
    bpm: f64,
    first_beat_ms: f64,
) -> Result<NativePhraseFeatureTrace> {
    if !bpm.is_finite() || bpm <= 0.0 {
        bail!("native phrase features require a positive finite BPM");
    }
    if !first_beat_ms.is_finite() {
        bail!("native phrase features require a finite first-beat offset");
    }

    let streams = generate_phrase_multirate(samples, sample_rate)?;
    let rates = [
        f64::from(sample_rate) / 2.0,
        f64::from(sample_rate) / 8.0,
        f64::from(sample_rate) / 32.0,
    ];
    let beat_count = [
        native_beat_count(streams.high_pass_2.len(), rates[0], bpm, first_beat_ms),
        native_beat_count(streams.low_pass_8.len(), rates[1], bpm, first_beat_ms),
        native_beat_count(streams.low_pass_32.len(), rates[2], bpm, first_beat_ms),
    ]
    .into_iter()
    .min()
    .unwrap_or_default();
    if beat_count == 0 {
        bail!("native phrase features require at least one complete beat");
    }
    let boundaries = PhraseBeatBoundaries {
        high_pass_2: native_beat_positions(rates[0], bpm, first_beat_ms, beat_count),
        low_pass_8: native_beat_positions(rates[1], bpm, first_beat_ms, beat_count),
        low_pass_32: native_beat_positions(rates[2], bpm, first_beat_ms, beat_count),
    };

    let low_rate = rates[2];
    let mut low_level_filter = [Biquad::butterworth(
        low_rate,
        150.0,
        SECOND_ORDER_DAMPING,
        Response::LowPass,
    )];
    let mut low_level_envelope = FirstOrderLowPass::new(low_rate, 5.0);
    let mut divided_low_filter = [Biquad::butterworth(
        low_rate,
        500.0,
        SECOND_ORDER_DAMPING,
        Response::LowPass,
    )];
    let mut divided_low_envelope = FirstOrderLowPass::new(low_rate, 5.0);
    let mut low_peak_filter = [Biquad::butterworth(
        low_rate,
        100.0,
        SECOND_ORDER_DAMPING,
        Response::LowPass,
    )];
    let mut low_peak_envelope = FirstOrderLowPass::new(low_rate, 5.0);
    let mut low_level_samples = Vec::with_capacity(streams.low_pass_32.len());
    let mut divided_low_samples = Vec::with_capacity(streams.low_pass_32.len());
    let mut low_peak_samples = Vec::with_capacity(streams.low_pass_32.len());
    for sample in streams.low_pass_32.iter().copied() {
        low_level_samples.push(
            low_level_envelope.process(process_sections(sample, &mut low_level_filter).abs()),
        );
        divided_low_samples.push(
            divided_low_envelope.process(process_sections(sample, &mut divided_low_filter).abs()),
        );
        low_peak_samples
            .push(low_peak_envelope.process(process_sections(sample, &mut low_peak_filter).abs()));
    }

    let middle_rate = rates[1];
    let mut middle_level_filter = [Biquad::butterworth(
        middle_rate,
        500.0,
        SECOND_ORDER_DAMPING,
        Response::HighPass,
    )];
    let mut middle_level_envelope = FirstOrderLowPass::new(middle_rate, 5.0);
    let mut divided_middle_filter = [Biquad::butterworth(
        middle_rate,
        500.0,
        SECOND_ORDER_DAMPING,
        Response::HighPass,
    )];
    let mut divided_middle_envelope = FirstOrderLowPass::new(middle_rate, 5.0);
    let mut middle_peak_filter = [
        Biquad::butterworth(
            middle_rate,
            400.0,
            FOURTH_ORDER_DAMPING[0],
            Response::HighPass,
        ),
        Biquad::butterworth(
            middle_rate,
            400.0,
            FOURTH_ORDER_DAMPING[1],
            Response::HighPass,
        ),
        Biquad::butterworth(
            middle_rate,
            1_000.0,
            FOURTH_ORDER_DAMPING[0],
            Response::LowPass,
        ),
        Biquad::butterworth(
            middle_rate,
            1_000.0,
            FOURTH_ORDER_DAMPING[1],
            Response::LowPass,
        ),
    ];
    let mut middle_peak_envelope = FirstOrderLowPass::new(middle_rate, 10.0);
    let mut middle_level_samples = Vec::with_capacity(streams.low_pass_8.len());
    let mut divided_middle_samples = Vec::with_capacity(streams.low_pass_8.len());
    let mut middle_peak_samples = Vec::with_capacity(streams.low_pass_8.len());
    for sample in streams.low_pass_8.iter().copied() {
        middle_level_samples.push(
            middle_level_envelope.process(process_sections(sample, &mut middle_level_filter).abs()),
        );
        divided_middle_samples.push(
            divided_middle_envelope
                .process(process_sections(sample, &mut divided_middle_filter).abs()),
        );
        middle_peak_samples.push(
            middle_peak_envelope.process(process_sections(sample, &mut middle_peak_filter).abs()),
        );
    }

    let high_rate = rates[0];
    let mut high_peak_filter = [
        Biquad::butterworth(
            high_rate,
            5_000.0,
            FOURTH_ORDER_DAMPING[0],
            Response::HighPass,
        ),
        Biquad::butterworth(
            high_rate,
            5_000.0,
            FOURTH_ORDER_DAMPING[1],
            Response::HighPass,
        ),
        Biquad::butterworth(
            high_rate,
            7_000.0,
            FOURTH_ORDER_DAMPING[0],
            Response::LowPass,
        ),
        Biquad::butterworth(
            high_rate,
            7_000.0,
            FOURTH_ORDER_DAMPING[1],
            Response::LowPass,
        ),
    ];
    let mut high_peak_envelope = FirstOrderLowPass::new(high_rate, 10.0);
    let high_peak_samples = streams
        .high_pass_2
        .iter()
        .copied()
        .map(|sample| {
            high_peak_envelope.process(process_sections(sample, &mut high_peak_filter).abs())
        })
        .collect::<Vec<_>>();

    let low_ranges = beat_ranges(&boundaries.low_pass_32, low_peak_samples.len());
    let middle_ranges = beat_ranges(&boundaries.low_pass_8, middle_peak_samples.len());
    let low_level = reduce_ranges(&low_level_samples, &low_ranges, sum_range)
        .into_iter()
        .map(|value| value * 4.0)
        .collect();
    let middle_level = reduce_ranges(&middle_level_samples, &middle_ranges, sum_range);
    let divided_low_level = reduce_ranges(&divided_low_samples, &low_ranges, sum_range);
    let divided_middle_level = reduce_ranges(&divided_middle_samples, &middle_ranges, sum_range);
    let low_peak = reduce_ranges(&low_peak_samples, &low_ranges, max_range);
    let low_peak_quarters = boundaries
        .low_pass_32
        .windows(2)
        .map(|window| quarter_maxima(&low_peak_samples, window[0], window[1]))
        .collect();
    let middle_peak = reduce_ranges(&middle_peak_samples, &middle_ranges, max_range);
    let all_level = reduce_ranges(&streams.low_pass_8, &middle_ranges, absolute_max_range);
    let (all_power_quarter_energy, all_power_quarter_peak) = boundaries
        .low_pass_8
        .windows(2)
        .map(|window| quarter_power(&streams.low_pass_8, window[0], window[1]))
        .unzip();
    let high_peak_eighths =
        high_peak_eighth_maxima(&high_peak_samples, &boundaries.high_pass_2, high_rate, bpm);

    Ok(NativePhraseFeatureTrace {
        boundaries,
        low_level,
        middle_level,
        divided_low_level,
        divided_middle_level,
        low_peak,
        low_peak_quarters,
        middle_peak,
        all_level,
        all_power_quarter_energy,
        all_power_quarter_peak,
        high_peak_eighths,
    })
}

/// Reproduce the native phrase judge's normalization and adjacent ratios.
pub fn derive_native_phrase_change_features(values: &[f64]) -> Result<NativePhraseChangeFeatures> {
    if values.iter().any(|value| !value.is_finite()) {
        bail!("native phrase change features require finite input");
    }
    Ok(derive_native_phrase_change_features_unchecked(
        values.to_vec(),
    ))
}

/// Average four-beat input into bars before deriving native change features.
pub fn derive_native_phrase_bar_change_features(
    values: &[f64],
    feature_origin: usize,
) -> Result<NativePhraseChangeFeatures> {
    if feature_origin == 0 || feature_origin > values.len() {
        bail!("native phrase bar features require a one-based origin within the input");
    }
    if values.iter().any(|value| !value.is_finite()) {
        bail!("native phrase bar features require finite input");
    }
    let bar_count = (values.len() - feature_origin + 1) / 4;
    if bar_count == 0 {
        bail!("native phrase bar features require one complete four-beat group");
    }
    let mut bars = vec![0.0; bar_count];
    let populated = bar_count.saturating_sub(1).max(1).min(bar_count);
    for (bar, slot) in bars.iter_mut().take(populated).enumerate() {
        let start = feature_origin - 1 + bar * 4;
        *slot = values[start..start + 4].iter().sum::<f64>() * 0.25;
    }
    Ok(derive_native_phrase_change_features_unchecked(bars))
}

fn derive_native_phrase_change_features_unchecked(
    mut normalized: Vec<f64>,
) -> NativePhraseChangeFeatures {
    let maximum = normalized.iter().copied().fold(0.0_f64, f64::max);
    let scale = if maximum == 0.0 {
        333.333_333_333_333_3
    } else {
        maximum.recip()
    };
    let normalized_count = normalized.len().saturating_sub(1);
    for value in normalized.iter_mut().take(normalized_count) {
        *value *= scale;
    }

    let mut symmetric_ratio = vec![0.0; normalized.len()];
    let mut directional_ratio = vec![0.0; normalized.len()];
    for index in 0..normalized.len().saturating_sub(2) {
        if normalized[index] == 0.0 {
            normalized[index] = 0.003;
        }
        if normalized[index + 1] == 0.0 {
            normalized[index + 1] = 0.003;
        }
        let ratio = normalized[index + 1] / normalized[index];
        directional_ratio[index + 1] = ratio;
        symmetric_ratio[index + 1] = if ratio < 1.0 { ratio.recip() } else { ratio };
    }
    NativePhraseChangeFeatures {
        normalized,
        symmetric_ratio,
        directional_ratio,
    }
}

#[cfg(test)]
pub(crate) fn extract_native_phrase_low_levels(
    samples: &[f32],
    sample_rate: u32,
    bpm: f64,
    first_beat_ms: f64,
) -> Result<NativePhraseLowLevelTrace> {
    let envelope = extract_native_phrase_low_level_envelope(samples, sample_rate)?;
    reduce_native_phrase_low_levels(&envelope, bpm, first_beat_ms)
}

pub(crate) fn extract_native_phrase_low_level_envelope(
    samples: &[f32],
    sample_rate: u32,
) -> Result<NativePhraseLowLevelEnvelope> {
    validate_feature_pcm(samples, sample_rate)?;
    let sample_rate = f64::from(sample_rate);
    let low_rate = sample_rate / 32.0;
    let low_pass_32 = filter_and_decimate(
        samples,
        sample_rate,
        sample_rate * 0.0125,
        32,
        Response::LowPass,
    );
    let (low_level_samples, divided_low_samples) =
        extract_low_level_samples(&low_pass_32, low_rate);
    Ok(NativePhraseLowLevelEnvelope {
        sample_rate: low_rate,
        low_level_samples,
        divided_low_samples,
    })
}

pub(crate) fn reduce_native_phrase_low_levels(
    envelope: &NativePhraseLowLevelEnvelope,
    bpm: f64,
    first_beat_ms: f64,
) -> Result<NativePhraseLowLevelTrace> {
    validate_feature_timing(bpm, first_beat_ms)?;
    let beat_count = native_beat_count(
        envelope.low_level_samples.len(),
        envelope.sample_rate,
        bpm,
        first_beat_ms,
    );
    if beat_count == 0 {
        bail!("native phrase features require at least one complete beat");
    }
    let boundaries = native_beat_positions(envelope.sample_rate, bpm, first_beat_ms, beat_count);
    let ranges = beat_ranges(&boundaries, envelope.low_level_samples.len());

    Ok(NativePhraseLowLevelTrace {
        low_level: reduce_ranges(&envelope.low_level_samples, &ranges, sum_range)
            .into_iter()
            .map(|value| value * 4.0)
            .collect(),
        divided_low_level: reduce_ranges(&envelope.divided_low_samples, &ranges, sum_range),
    })
}

fn validate_feature_pcm(samples: &[f32], sample_rate: u32) -> Result<()> {
    if !matches!(sample_rate, 44_100 | 48_000) {
        bail!("phrase multirate frontend requires a 44.1 or 48 kHz reader rate");
    }
    if samples.iter().any(|sample| !sample.is_finite()) {
        bail!("phrase multirate frontend requires finite PCM");
    }
    Ok(())
}

fn validate_feature_timing(bpm: f64, first_beat_ms: f64) -> Result<()> {
    if !bpm.is_finite() || bpm <= 0.0 {
        bail!("native phrase features require a positive finite BPM");
    }
    if !first_beat_ms.is_finite() {
        bail!("native phrase features require a finite first-beat offset");
    }
    Ok(())
}

fn extract_low_level_samples(samples: &[f64], sample_rate: f64) -> (Vec<f64>, Vec<f64>) {
    let mut low_level_filter = [Biquad::butterworth(
        sample_rate,
        150.0,
        SECOND_ORDER_DAMPING,
        Response::LowPass,
    )];
    let mut low_level_envelope = FirstOrderLowPass::new(sample_rate, 5.0);
    let mut divided_low_filter = [Biquad::butterworth(
        sample_rate,
        500.0,
        SECOND_ORDER_DAMPING,
        Response::LowPass,
    )];
    let mut divided_low_envelope = FirstOrderLowPass::new(sample_rate, 5.0);
    let mut low_level_samples = Vec::with_capacity(samples.len());
    let mut divided_low_samples = Vec::with_capacity(samples.len());
    for sample in samples.iter().copied() {
        low_level_samples.push(
            low_level_envelope.process(process_sections(sample, &mut low_level_filter).abs()),
        );
        divided_low_samples.push(
            divided_low_envelope.process(process_sections(sample, &mut divided_low_filter).abs()),
        );
    }
    (low_level_samples, divided_low_samples)
}

fn filter_and_decimate(
    samples: &[f32],
    sample_rate: f64,
    cutoff: f64,
    factor: usize,
    response: Response,
) -> Vec<f64> {
    let output_len = samples.len() / factor;
    let input_len = output_len * factor;
    let mut sections = BUTTERWORTH_DAMPING
        .map(|damping| Biquad::butterworth(sample_rate, cutoff, damping, response));
    let mut output = Vec::with_capacity(output_len);
    for (index, sample) in samples[..input_len].iter().copied().enumerate() {
        let mut filtered = f64::from(sample);
        for section in &mut sections {
            filtered = section.process(filtered);
        }
        if index % factor == factor - 1 {
            output.push(filtered);
        }
    }
    output
}

fn process_sections<const N: usize>(mut sample: f64, sections: &mut [Biquad; N]) -> f64 {
    for section in sections {
        sample = section.process(sample);
    }
    sample
}

fn native_beat_count(length: usize, sample_rate: f64, bpm: f64, first_beat_ms: f64) -> usize {
    let start = (sample_rate * first_beat_ms * 0.001 + 0.5).trunc();
    let count = ((length as f64 - start) / (sample_rate * 60.0 / bpm)).trunc();
    if count.is_finite() && count > 0.0 {
        count.min(usize::MAX as f64) as usize
    } else {
        0
    }
}

fn native_beat_positions(
    sample_rate: f64,
    bpm: f64,
    first_beat_ms: f64,
    beat_count: usize,
) -> Vec<i32> {
    let start = (sample_rate * first_beat_ms * 0.001 + 0.5).trunc();
    let period = sample_rate * 60.0 / bpm;
    (0..=beat_count)
        .map(|index| {
            (period.mul_add(index as f64, start + 1.5))
                .trunc()
                .clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32
        })
        .collect()
}

fn beat_ranges(boundaries: &[i32], sample_count: usize) -> Vec<Option<Range<usize>>> {
    boundaries
        .windows(2)
        .map(|window| one_based_range(window[0], window[1], sample_count))
        .collect()
}

fn one_based_range(start: i32, end: i32, sample_count: usize) -> Option<Range<usize>> {
    if start <= 0 || end <= start {
        return None;
    }
    let start = usize::try_from(start - 1).ok()?;
    let end = usize::try_from(end - 1).ok()?;
    (end <= sample_count).then_some(start..end)
}

fn reduce_ranges(
    samples: &[f64],
    ranges: &[Option<Range<usize>>],
    reduce: fn(&[f64]) -> f64,
) -> Vec<f64> {
    ranges
        .iter()
        .map(|range| {
            range
                .as_ref()
                .map_or(0.0, |range| reduce(&samples[range.clone()]))
        })
        .collect()
}

fn sum_range(samples: &[f64]) -> f64 {
    samples.iter().sum()
}

fn max_range(samples: &[f64]) -> f64 {
    samples.iter().copied().reduce(f64::max).unwrap_or(0.0)
}

fn absolute_max_range(samples: &[f64]) -> f64 {
    samples
        .iter()
        .map(|sample| sample.abs())
        .reduce(f64::max)
        .unwrap_or(0.0)
}

fn quarter_ranges(start: i32, end: i32, sample_count: usize) -> [Option<Range<usize>>; 4] {
    let quarter = (f64::from(end - start) * 0.25 + 0.5).trunc() as i32;
    [
        one_based_range(start, start + quarter, sample_count),
        one_based_range(start + quarter, start + quarter * 2, sample_count),
        one_based_range(start + quarter * 2, start + quarter * 3, sample_count),
        one_based_range(start + quarter * 3, end, sample_count),
    ]
}

fn quarter_maxima(samples: &[f64], start: i32, end: i32) -> [f64; 4] {
    quarter_ranges(start, end, samples.len())
        .map(|range| range.map_or(0.0, |range| max_range(&samples[range])))
}

fn quarter_power(samples: &[f64], start: i32, end: i32) -> ([f64; 4], [f64; 4]) {
    let ranges = quarter_ranges(start, end, samples.len());
    let energy = ranges.clone().map(|range| {
        range.map_or(0.0, |range| {
            samples[range].iter().map(|sample| sample * sample).sum()
        })
    });
    let peak = ranges.map(|range| range.map_or(0.0, |range| absolute_max_range(&samples[range])));
    (energy, peak)
}

fn high_peak_eighth_maxima(
    samples: &[f64],
    boundaries: &[i32],
    sample_rate: f64,
    bpm: f64,
) -> Vec<[f64; 8]> {
    let rounded_period = (sample_rate * 60.0 / bpm + 0.5).trunc();
    let eighth = (rounded_period * 0.125 + 0.5).trunc() as i32;
    boundaries
        .windows(2)
        .map(|window| {
            let start = window[0];
            let end = window[1];
            let mut output = [0.0; 8];
            for (index, value) in output.iter_mut().enumerate() {
                let segment_start = if index == 0 {
                    start
                } else {
                    start + eighth * index as i32 + 1
                };
                let segment_end = if index == 0 {
                    start + eighth + 1
                } else if index == 7 {
                    end
                } else {
                    segment_start + eighth
                };
                *value = one_based_range(segment_start, segment_end, samples.len())
                    .map_or(0.0, |range| max_range(&samples[range]));
            }
            output
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linked_coefficients_pin_low_and_high_pass_sections() {
        let low = Biquad::butterworth(
            44_100.0,
            44_100.0 * 0.05,
            BUTTERWORTH_DAMPING[0],
            Response::LowPass,
        );
        let high = Biquad::butterworth(
            44_100.0,
            44_100.0 * 0.275,
            BUTTERWORTH_DAMPING[0],
            Response::HighPass,
        );

        assert!((low.b0 - 0.018_779_932_646_185_86).abs() < 1.0e-15);
        assert!((low.b1 - 0.037_559_865_292_371_72).abs() < 1.0e-15);
        assert!((low.a1 - -1.459_706_254_376_867).abs() < 1.0e-15);
        assert!((high.b0 - 0.214_243_198_649_454_01).abs() < 1.0e-15);
        assert!((high.b1 - -0.428_486_397_298_908_03).abs() < 1.0e-15);
        assert!((high.a1 - 0.158_920_765_632_434_98).abs() < 1.0e-15);
    }

    #[test]
    fn multirate_lengths_and_tail_policy_match_native_decimation() {
        let input = vec![0.25; 44_117];
        let streams = generate_phrase_multirate(&input, 44_100).expect("multirate");

        assert_eq!(streams.high_pass_2.len(), input.len() / 2);
        assert_eq!(streams.low_pass_8.len(), input.len() / 8);
        assert_eq!(streams.low_pass_32.len(), input.len() / 32);
        assert!(streams.high_pass_2.last().unwrap().abs() < 1.0e-12);
        assert!((streams.low_pass_8.last().unwrap() - 0.25).abs() < 1.0e-12);
        assert!((streams.low_pass_32.last().unwrap() - 0.25).abs() < 1.0e-12);
    }

    #[test]
    fn multirate_rejects_unrouted_rates_and_nonfinite_pcm() {
        assert!(generate_phrase_multirate(&[0.0], 96_000).is_err());
        assert!(generate_phrase_multirate(&[f32::NAN], 44_100).is_err());
    }

    #[test]
    fn native_beat_positions_match_linked_rounding_and_one_based_indexing() {
        let positions = native_beat_positions(22_050.0, 120.0, 10.0, 2);
        assert_eq!(positions, [222, 11_247, 22_272]);
        let positions = native_beat_positions(5_512.5, 120.0, 10.0, 2);
        assert_eq!(positions, [56, 2_812, 5_569]);
        let positions = native_beat_positions(1_378.125, 120.0, 10.0, 2);
        assert_eq!(positions, [15, 704, 1_393]);
    }

    #[test]
    fn native_feature_families_share_the_minimum_complete_beat_count() {
        let input = (0..44_100 * 5)
            .map(|index| {
                let phase = index as f64 * 440.0 * std::f64::consts::TAU / 44_100.0;
                (phase.sin() * 0.25) as f32
            })
            .collect::<Vec<_>>();
        let features =
            extract_native_phrase_features(&input, 44_100, 120.0, 10.0).expect("features");
        let low_levels =
            extract_native_phrase_low_levels(&input, 44_100, 120.0, 10.0).expect("low levels");
        let beat_count = features.low_level.len();

        assert_eq!(beat_count, 9);
        assert_eq!(low_levels.low_level, features.low_level);
        assert_eq!(low_levels.divided_low_level, features.divided_low_level);
        assert_eq!(features.middle_level.len(), beat_count);
        assert_eq!(features.divided_low_level.len(), beat_count);
        assert_eq!(features.divided_middle_level.len(), beat_count);
        assert_eq!(features.low_peak.len(), beat_count);
        assert_eq!(features.low_peak_quarters.len(), beat_count);
        assert_eq!(features.middle_peak.len(), beat_count);
        assert_eq!(features.all_level.len(), beat_count);
        assert_eq!(features.all_power_quarter_energy.len(), beat_count);
        assert_eq!(features.all_power_quarter_peak.len(), beat_count);
        assert_eq!(features.high_peak_eighths.len(), beat_count);
        assert!(
            features
                .low_level
                .iter()
                .chain(&features.middle_level)
                .chain(&features.low_peak)
                .all(|value| value.is_finite())
        );
    }

    #[test]
    fn native_feature_validation_rejects_invalid_timing_inputs() {
        assert!(extract_native_phrase_features(&[0.0; 44_100], 44_100, 0.0, 0.0).is_err());
        assert!(extract_native_phrase_features(&[0.0; 44_100], 44_100, 120.0, f64::NAN).is_err());
    }

    #[test]
    fn native_change_features_preserve_tail_and_fold_adjacent_ratios() {
        let features =
            derive_native_phrase_change_features(&[2.0, 4.0, 0.0, 8.0]).expect("changes");

        assert_eq!(features.normalized, [0.25, 0.5, 0.003, 8.0]);
        assert_eq!(features.directional_ratio, [0.0, 2.0, 0.006, 0.0]);
        assert_eq!(
            features.symmetric_ratio,
            [0.0, 2.0, 166.666_666_666_666_66, 0.0]
        );
    }

    #[test]
    fn native_bar_change_features_average_four_beats_and_leave_guard_bar() {
        let values = (1..=12).map(f64::from).collect::<Vec<_>>();
        let features = derive_native_phrase_bar_change_features(&values, 1).expect("bar changes");

        assert_eq!(features.normalized, [2.5 / 6.5, 1.0, 0.0]);
        assert!((features.directional_ratio[1] - 2.6).abs() < f64::EPSILON * 4.0);
        assert!((features.symmetric_ratio[1] - 2.6).abs() < f64::EPSILON * 4.0);
        assert_eq!(features.directional_ratio[0], 0.0);
        assert_eq!(features.directional_ratio[2], 0.0);
        assert_eq!(features.symmetric_ratio[0], 0.0);
        assert_eq!(features.symmetric_ratio[2], 0.0);
    }

    #[test]
    fn native_change_features_reject_invalid_inputs() {
        assert!(derive_native_phrase_change_features(&[f64::NAN]).is_err());
        assert!(derive_native_phrase_bar_change_features(&[1.0; 8], 0).is_err());
        assert!(derive_native_phrase_bar_change_features(&[1.0; 3], 1).is_err());
    }
}
