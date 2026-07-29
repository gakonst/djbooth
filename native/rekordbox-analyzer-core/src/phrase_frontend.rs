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

/// Build the three change-feature families consumed by the native mood-2/3 judge.
///
/// Low- and middle-peak inputs use complete four-beat averages with one guard
/// bar. Low-level energy uses four-beat sums, a ceiling-sized output, and two
/// guard bars. The differing tail rules are observable native behavior.
pub fn derive_native_mood_23_feature_families(
    features: &NativePhraseFeatureTrace,
    feature_origin: usize,
) -> Result<[NativePhraseChangeFeatures; 3]> {
    let low_peak = derive_native_phrase_bar_change_features(&features.low_peak, feature_origin)?;
    let middle_peak =
        derive_native_phrase_bar_change_features(&features.middle_peak, feature_origin)?;
    let low_level_bars = native_mood_23_low_level_bars(&features.low_level, feature_origin)?;
    let low_level = derive_native_phrase_change_features_unchecked(low_level_bars);
    Ok([low_peak, low_level, middle_peak])
}

/// Select boundary candidates from one native 22-value phrase-change window.
///
/// The returned indices are absolute one-based bars. `[0]` is the native
/// no-candidate sentinel. Candidate ranking is stable, and the final
/// three-zero cleanup limit is intentional: the linked judge discards the
/// whole window when four rejected slots remain before its last accepted
/// candidate.
pub fn judge_native_phrase_change_window(
    features: &NativePhraseChangeFeatures,
    start_bar: i32,
) -> Result<Vec<i32>> {
    let primary = &features.normalized;
    let secondary = &features.symmetric_ratio;
    let tertiary = &features.directional_ratio;
    validate_native_phrase_change_window(primary, secondary, tertiary, start_bar)?;
    judge_native_phrase_change_window_unchecked(primary, secondary, tertiary, start_bar)
}

/// Select mood-2/3 phrase boundaries from the three native feature families.
///
/// Input and output candidates are one-based beat positions. `feature_origin`
/// is the beat represented by feature bar one. Native mode `1` keeps only the
/// middle feature family; other observed modes merge all three.
pub fn judge_native_mood_23_phrase_boundaries(
    feature_families: &[NativePhraseChangeFeatures; 3],
    input_candidates: &[i32],
    anchor_beat: i32,
    feature_origin: i32,
    genre: i32,
) -> Result<Vec<i32>> {
    if input_candidates.is_empty() {
        bail!("native mood-2/3 phrase judge requires an input candidate");
    }
    let feature_count = feature_families
        .iter()
        .map(|features| features.normalized.len())
        .min()
        .unwrap_or_default();
    if feature_count < 10 {
        bail!("native mood-2/3 phrase judge requires at least ten feature bars");
    }
    let feature_count_i32 = i32::try_from(feature_count)
        .map_err(|_| anyhow::anyhow!("native phrase feature count exceeds i32"))?;
    for features in feature_families {
        if features.symmetric_ratio.len() < feature_count
            || features.directional_ratio.len() < feature_count
        {
            bail!("native mood-2/3 phrase judge requires aligned feature families");
        }
        if features
            .normalized
            .iter()
            .take(feature_count)
            .chain(features.symmetric_ratio.iter().take(feature_count))
            .chain(features.directional_ratio.iter().take(feature_count))
            .any(|value| !value.is_finite())
        {
            bail!("native mood-2/3 phrase judge requires finite features");
        }
    }

    let protected_bar = native_phrase_beat_to_bar(anchor_beat, feature_origin)?;
    let mut output = native_initial_phrase_bars(
        input_candidates,
        feature_origin,
        feature_count_i32,
        protected_bar,
    )?;
    let last_initial = output.last().copied().unwrap_or_default();
    let first_window_bar = if last_initial >= 4 {
        last_initial
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("native phrase window start overflow"))?
    } else {
        4
    };
    let mut window_end = first_window_bar.saturating_add(18).min(feature_count_i32);
    let mut start_bar = first_window_bar - 3;
    if start_bar > window_end {
        start_bar = feature_count_i32;
    }

    let mut family_candidates: [Vec<i32>; 3] = std::array::from_fn(|_| vec![0]);
    if feature_count_i32 - first_window_bar >= -15 {
        loop {
            let start = usize::try_from(start_bar - 1)
                .map_err(|_| anyhow::anyhow!("native phrase window starts before bar one"))?;
            let end = usize::try_from(window_end)
                .map_err(|_| anyhow::anyhow!("native phrase window end is negative"))?;
            if start >= end || end > feature_count {
                bail!("native phrase judge produced an invalid feature window");
            }
            for (family, candidates) in feature_families.iter().zip(&mut family_candidates) {
                candidates.extend(judge_native_phrase_change_window_unchecked(
                    &family.normalized[start..end],
                    &family.symmetric_ratio[start..end],
                    &family.directional_ratio[start..end],
                    start_bar,
                )?);
            }
            if feature_count_i32 - window_end < 10 {
                break;
            }
            window_end = window_end.saturating_add(16).min(feature_count_i32 - 1);
            start_bar = start_bar
                .checked_add(16)
                .ok_or_else(|| anyhow::anyhow!("native phrase window start overflow"))?;
        }
    }
    if genre == 1 {
        family_candidates[0] = vec![0];
        family_candidates[2] = vec![0];
    }

    let mut merged = family_candidates
        .into_iter()
        .flatten()
        .filter(|candidate| *candidate > 0)
        .collect::<Vec<_>>();
    merged.sort_unstable();
    merged.dedup();
    output.extend(merged);
    collapse_native_consecutive_runs(&mut output);
    if output.first() != Some(&1) {
        output.insert(0, 1);
    }

    let scores = output
        .iter()
        .map(|candidate| {
            native_mood_23_candidate_score(feature_families, *candidate)
                .ok_or_else(|| anyhow::anyhow!("native phrase candidate is outside its features"))
        })
        .collect::<Result<Vec<_>>>()?;
    suppress_native_adjacent_candidates(&mut output, &scores, protected_bar);
    output
        .into_iter()
        .map(|bar| {
            bar.checked_mul(4)
                .and_then(|beat| beat.checked_add(feature_origin))
                .and_then(|beat| beat.checked_sub(4))
                .ok_or_else(|| anyhow::anyhow!("native phrase beat position overflow"))
        })
        .collect()
}

/// Detect native mood-2/3 short-break bars from two beat-synchronous features.
///
/// The linked `ShortBreakDetection` pass normalizes the first feature, derives
/// adaptive falling-edge thresholds for both inputs, retains beat phases zero
/// and three, and requires a greater-than-2.5 recovery within four beats.
/// Returned values are one-based bars.
pub fn detect_native_mood_23_short_breaks(
    feature_a: &[f64],
    feature_b: &[f64],
) -> Result<Vec<i32>> {
    if feature_a.len() != feature_b.len() {
        bail!("native mood-2/3 short-break detection requires aligned features");
    }
    if feature_a
        .iter()
        .chain(feature_b)
        .any(|value| !value.is_finite())
    {
        bail!("native mood-2/3 short-break detection requires finite input");
    }
    let feature_count = feature_a.len();
    if feature_count < 21 {
        return Ok(Vec::new());
    }

    let mut normalized_a = feature_a.to_vec();
    let mut feature_b = feature_b.to_vec();
    let maximum = normalized_a.iter().copied().reduce(f64::max).unwrap_or(0.0);
    let scale = if maximum == 0.0 {
        333.333_333_333_333_3
    } else {
        1.0 / maximum
    };
    for value in &mut normalized_a {
        *value *= scale;
    }

    let mut ratios_a = vec![0.0; feature_count];
    let mut ratios_b = vec![0.0; feature_count];
    let mut falling_a = vec![0.0; feature_count];
    let mut falling_b = vec![0.0; feature_count];
    let mut non_falling_a = 0_usize;
    let mut non_falling_b = 0_usize;
    for index in 1..feature_count - 4 {
        if normalized_a[index] == 0.0 {
            normalized_a[index] = 0.003;
        }
        if normalized_a[index - 1] == 0.0 {
            normalized_a[index - 1] = 0.003;
        }
        let ratio_a = normalized_a[index] / normalized_a[index - 1];
        ratios_a[index] = ratio_a;
        if ratio_a < 1.0 {
            falling_a[index] = ratio_a;
        } else {
            non_falling_a += 1;
        }

        if feature_b[index] == 0.0 {
            feature_b[index] = 0.003;
        }
        if feature_b[index - 1] == 0.0 {
            feature_b[index - 1] = 0.003;
        }
        let ratio_b = feature_b[index] / feature_b[index - 1];
        ratios_b[index] = ratio_b;
        if ratio_b < 1.0 {
            falling_b[index] = ratio_b;
        } else {
            non_falling_b += 1;
        }
    }

    let mut threshold_a = if non_falling_a == 0 {
        0.003
    } else {
        falling_a.iter().sum::<f64>() / non_falling_a as f64
    } * 0.65;
    let threshold_b = if non_falling_b == 0 {
        0.00285
    } else {
        falling_b.iter().sum::<f64>() * 0.95 / non_falling_b as f64
    };

    let mut sorted_falling_a = falling_a
        .iter()
        .copied()
        .filter(|ratio| *ratio != 0.0)
        .collect::<Vec<_>>();
    sorted_falling_a.sort_by(|left, right| {
        left.partial_cmp(right)
            .expect("validated finite short-break feature")
    });
    let low_ratio_count = sorted_falling_a
        .iter()
        .take_while(|ratio| **ratio > 0.0 && **ratio <= threshold_a)
        .count();
    if low_ratio_count >= 14 {
        threshold_a = sorted_falling_a[12];
    }

    let mut beat_candidates = Vec::new();
    for index in 16..feature_count - 4 {
        if ratios_a[index] >= threshold_a || ratios_b[index] >= threshold_b {
            continue;
        }
        let preceding_a = normalized_a[index - 1];
        let preceding_b = feature_b[index - 1];
        let twice_preceding_b = feature_b[index - 2];
        let level_match = if preceding_a > 0.5 {
            preceding_b > 0.2 || twice_preceding_b > 0.2
        } else {
            preceding_a > 0.2 && (preceding_b > 0.5 || twice_preceding_b > 0.5)
        };
        if level_match {
            beat_candidates.push(index + 1);
        }
    }

    beat_candidates.retain(|candidate| candidate % 4 == 0 || candidate % 4 == 3);
    beat_candidates.retain(|candidate| {
        let baseline = normalized_a[*candidate - 1];
        let scale = if baseline == 0.0 {
            333.333_333_333_333_3
        } else {
            1.0 / baseline
        };
        normalized_a[*candidate..*candidate + 4]
            .iter()
            .any(|value| *value * scale > 2.5)
    });
    beat_candidates
        .into_iter()
        .map(|candidate| {
            i32::try_from(candidate.div_ceil(4) + 1)
                .map_err(|_| anyhow::anyhow!("native phrase bar exceeds i32"))
        })
        .collect()
}

/// Detect native mood-2/3 sound-level changes from beat-synchronous features.
///
/// The linked `SouonChangeDet` pass averages complete four-beat groups while
/// retaining one zero guard bar, folds adjacent ratios above one, and reports
/// one-based bars whose ratio spike is followed by two stable ratios.
pub fn detect_native_mood_23_sound_changes(values: &[f64]) -> Result<Vec<i32>> {
    if values.iter().any(|value| !value.is_finite()) {
        bail!("native mood-2/3 sound-change detection requires finite input");
    }
    if values.len() < 20 {
        return Ok(Vec::new());
    }

    let bar_count = values.len() / 4;
    let mut averages = vec![0.0; bar_count];
    for (bar, average) in averages
        .iter_mut()
        .take(bar_count.saturating_sub(1))
        .enumerate()
    {
        let start = bar * 4;
        *average =
            ((values[start] + values[start + 2]) + (values[start + 1] + values[start + 3])) * 0.25;
    }

    let mut symmetric_ratio = vec![0.0; bar_count];
    for bar in 1..bar_count.saturating_sub(1) {
        if averages[bar - 1] == 0.0 {
            averages[bar - 1] = 0.003;
        }
        if averages[bar] == 0.0 {
            averages[bar] = 0.003;
        }
        let ratio = averages[bar] / averages[bar - 1];
        symmetric_ratio[bar] = if ratio < 1.0 { 1.0 / ratio } else { ratio };
    }

    let mut candidates = Vec::new();
    for bar in 0..bar_count.saturating_sub(4) {
        let ratio = symmetric_ratio[bar + 1];
        let following_average = (symmetric_ratio[bar + 3] + symmetric_ratio[bar + 4]) * 0.5;
        if ratio != 0.0 && ratio >= 1.8 && following_average <= 1.11 {
            candidates.push(
                i32::try_from(bar + 2)
                    .map_err(|_| anyhow::anyhow!("native phrase bar exceeds i32"))?,
            );
        }
    }
    Ok(candidates)
}

/// Detect native mood-2/3 snare-fill bars from 32-value feature windows.
///
/// The linked `SnareFillinDet` pass finds rising-edge local maxima in each
/// window, normalizes their summed heights, derives adaptive upper and lower
/// ratio thresholds, and applies its asymmetric two-transition state machine.
/// The final four windows are native guard bars and are not peak-scanned.
pub fn detect_native_mood_23_snare_fills(values: &[f64]) -> Result<Vec<i32>> {
    if values.iter().any(|value| !value.is_finite()) {
        bail!("native mood-2/3 snare-fill detection requires finite input");
    }
    let bar_count = values.len() / 32;
    if bar_count < 6 {
        return Ok(Vec::new());
    }

    let mut peak_sums = vec![0.0; bar_count];
    for (bar, peak_sum) in peak_sums
        .iter_mut()
        .take(bar_count.saturating_sub(4))
        .enumerate()
    {
        let window = &values[bar * 32..bar * 32 + 32];
        let mut slope = 0_u8;
        let mut peaks = Vec::new();
        for index in 1..window.len() {
            let next_slope = if window[index - 1] < window[index] {
                1
            } else {
                if slope == 1 {
                    peaks.push(window[index - 1]);
                }
                u8::from(window[index - 1] > window[index]) * 2
            };
            slope = next_slope;
        }
        *peak_sum = peaks.iter().sum();
    }

    let maximum = peak_sums.iter().copied().reduce(f64::max).unwrap_or(0.0);
    let scale = if maximum == 0.0 {
        333.333_333_333_333_3
    } else {
        1.0 / maximum
    };
    for peak_sum in &mut peak_sums {
        *peak_sum *= scale;
        if *peak_sum == 0.0 {
            *peak_sum = 0.003;
        }
    }

    let mut ratios = vec![0.0; bar_count];
    for bar in 1..bar_count {
        if peak_sums[bar - 1] != 0.0 {
            ratios[bar] = peak_sums[bar] / peak_sums[bar - 1];
        }
    }
    let mut above = ratios
        .iter()
        .map(|ratio| if *ratio >= 1.0 { *ratio } else { 0.0 })
        .collect::<Vec<_>>();
    let below = ratios
        .iter()
        .map(|ratio| {
            if *ratio != 0.0 && *ratio < 1.0 {
                *ratio
            } else {
                0.0
            }
        })
        .collect::<Vec<_>>();
    let above_count = above.iter().filter(|ratio| **ratio != 0.0).count();
    let below_count = below.iter().filter(|ratio| **ratio != 0.0).count();
    let mut upper = if above_count == 0 {
        0.00345
    } else {
        above.iter().sum::<f64>() * 1.15 / above_count as f64
    };
    let lower = if below_count == 0 {
        0.00255
    } else {
        below.iter().sum::<f64>() * 0.85 / below_count as f64
    };

    let quantile_count = bar_count / 16;
    above.sort_by(|left, right| {
        right
            .partial_cmp(left)
            .expect("validated finite snare-fill feature")
    });
    if quantile_count > 0
        && let Some(quantile) = above.get(quantile_count - 1)
    {
        upper = upper.max(*quantile);
    }
    // Native copies the descending upper-ratio array over its lower-ratio
    // scratch before the second sort. Its nominal lower quantile is therefore
    // always above `lower`, leaving the mean-derived threshold unchanged.

    let mut candidates = Vec::new();
    let mut skip_next = false;
    for bar in 2..bar_count.saturating_sub(3) {
        if skip_next {
            skip_next = false;
            continue;
        }
        let previous_ratio = ratios[bar - 1];
        let current_ratio = ratios[bar];
        let next_ratio = ratios[bar + 1];
        if !(previous_ratio > upper || previous_ratio < lower)
            || !(next_ratio > 0.85 && next_ratio < 1.15)
        {
            continue;
        }

        let product = previous_ratio * current_ratio;
        let mut candidate = None;
        if previous_ratio < 1.0 && current_ratio > lower {
            let preceding_level = peak_sums[bar - 2];
            if (previous_ratio > 0.5 && preceding_level > 0.3)
                || (previous_ratio <= 0.5 && preceding_level > 0.5)
            {
                candidate = Some(if product < 0.8 { bar } else { bar + 1 });
            }
        }
        if candidate.is_none() && previous_ratio > 1.0 && current_ratio < upper {
            let preceding_level = peak_sums[bar - 1];
            let is_too_low = if previous_ratio >= 2.0 {
                preceding_level <= 0.5
            } else {
                preceding_level <= 0.4
            };
            if !is_too_low {
                candidate = Some(if product > 0.8 { bar } else { bar + 1 });
            }
        }
        if let Some(candidate) = candidate {
            candidates.push(
                i32::try_from(candidate)
                    .map_err(|_| anyhow::anyhow!("native phrase bar exceeds i32"))?,
            );
            skip_next = true;
        }
    }
    Ok(candidates)
}

/// Detect native mood-2/3 vocal-entry bars from beat-synchronous features.
///
/// The linked `VocalInDetection` pass combines long binary silence runs with
/// a low-density short-gap path gated by normalized level and adjacent
/// four-beat sum ratios. Returned values are one-based bars.
pub fn detect_native_mood_23_vocal_entries(values: &[f64]) -> Result<Vec<i32>> {
    if values.iter().any(|value| !value.is_finite()) {
        bail!("native mood-2/3 vocal-entry detection requires finite input");
    }
    if values.len() < 5 {
        return Ok(Vec::new());
    }

    let maximum = values.iter().copied().reduce(f64::max).unwrap_or(0.0);
    let scale = if maximum == 0.0 {
        333.333_333_333_333_3
    } else {
        1.0 / maximum
    };
    let normalized = values.iter().map(|value| value * scale).collect::<Vec<_>>();
    let active_count = values.len() - 4;
    let mut active = vec![0_i32; values.len()];
    for (flag, value) in active.iter_mut().zip(&normalized).take(active_count) {
        *flag = i32::from(*value > 0.0);
    }

    let bar_count = values.len() / 4;
    let mut bar_sums = vec![0.0; bar_count];
    for (bar, sum) in bar_sums
        .iter_mut()
        .take(bar_count.saturating_sub(1))
        .enumerate()
    {
        let start = bar * 4;
        *sum = (normalized[start] + normalized[start + 2])
            + (normalized[start + 1] + normalized[start + 3]);
    }
    let mut bar_ratios = vec![0.0; bar_count];
    for bar in 1..bar_count.saturating_sub(1) {
        if bar_sums[bar - 1] != 0.0 {
            bar_ratios[bar] = bar_sums[bar] / bar_sums[bar - 1];
        }
    }

    let mut raw_candidates = Vec::new();
    let mut long_gap_ready = false;
    let mut zero_run = 0_i32;
    for index in 0..active_count {
        let flag = active[index];
        let old_ready = long_gap_ready;
        if flag == 0 {
            long_gap_ready = true;
        }
        if zero_run <= 6 {
            long_gap_ready = old_ready;
        }
        if flag == 1 && long_gap_ready {
            if active[index..index + 3].iter().sum::<i32>() >= 2 {
                raw_candidates.push(index + 1);
            }
            long_gap_ready = false;
        }
        zero_run += i32::from(flag == 0);
        if flag == 1 && !long_gap_ready {
            zero_run = 0;
        }
    }

    let density = active.iter().take(active_count).sum::<i32>() as f64 / active_count as f64;
    if density < 0.6 && values.len() >= 9 {
        let mut short_gap_ready = false;
        let mut long_gap_seen = false;
        let mut zero_run = 0_i32;
        for index in 0..values.len() - 8 {
            let flag = active[index];
            let mut next_zero_run = zero_run;
            if flag == 0 {
                next_zero_run += 1;
                if zero_run <= 6 {
                    if zero_run > 1 {
                        short_gap_ready = true;
                    }
                } else {
                    long_gap_seen = true;
                    short_gap_ready = false;
                }
            }
            if long_gap_seen && flag == 1 {
                next_zero_run = 0;
                long_gap_seen = false;
            }
            if flag == 1 && short_gap_ready {
                if active[index..index + 3].iter().sum::<i32>() >= 3 && normalized[index] >= 0.7 {
                    let bar = index / 4;
                    if bar_ratios[bar] >= 1.8 || bar_ratios[bar + 1] >= 3.0 {
                        raw_candidates.push(index + 1);
                    }
                }
                short_gap_ready = false;
            }
            if flag == 1 && !(short_gap_ready || long_gap_seen) {
                next_zero_run = 0;
            }
            zero_run = next_zero_run;
        }
    }

    raw_candidates.sort_unstable();
    raw_candidates
        .into_iter()
        .map(|candidate| {
            i32::try_from(candidate / 4 + 1)
                .map_err(|_| anyhow::anyhow!("native phrase bar exceeds i32"))
        })
        .collect()
}

/// Add all native mood-2/3 genre-stage candidates to judged beat boundaries.
///
/// This reproduces `VerseHookAdd_genre23`: short-break, sound-change,
/// snare-fill, and vocal-entry candidates are merged as one sorted bar list
/// before the linked candidate-adjustment pass converts them back to beats.
#[allow(clippy::too_many_arguments)]
pub fn add_native_mood_23_genre_candidates(
    low_level: &[f64],
    middle_level: &[f64],
    high_level: &[f64],
    phrase_feature: &[f64],
    boundary_feature: &[f64],
    judged_beats: &[i32],
    feature_origin: i32,
) -> Result<Vec<i32>> {
    let bar_count = i32::try_from(low_level.len() / 4)
        .map_err(|_| anyhow::anyhow!("native phrase bar count exceeds i32"))?;
    if bar_count == 0 {
        bail!("native mood-2/3 genre stages require at least four low-level features");
    }

    let mut detector_bars = detect_native_mood_23_short_breaks(low_level, middle_level)?;
    detector_bars.extend(detect_native_mood_23_sound_changes(phrase_feature)?);
    detector_bars.extend(detect_native_mood_23_snare_fills(high_level)?);
    detector_bars.extend(detect_native_mood_23_vocal_entries(boundary_feature)?);
    detector_bars.sort_unstable();
    detector_bars.dedup();
    adjust_native_mood_23_phrase_candidates(judged_beats, &detector_bars, feature_origin, bar_count)
}

/// Merge mood-2/3 detector bars into judged beat candidates.
///
/// This is the native `CandidatesAdjustment` pass used after short-break,
/// sound-change, snare-fill, and vocal-in detection. Detector candidates are
/// one-based bars; judged candidates and the result are one-based beats.
pub fn adjust_native_mood_23_phrase_candidates(
    judged_beats: &[i32],
    detector_bars: &[i32],
    feature_origin: i32,
    bar_count: i32,
) -> Result<Vec<i32>> {
    if judged_beats.is_empty() {
        bail!("native mood-2/3 candidate adjustment requires judged beats");
    }
    if bar_count <= 0 {
        bail!("native mood-2/3 candidate adjustment requires a positive bar count");
    }

    let mut collapsed_detector_bars = detector_bars.to_vec();
    collapse_native_consecutive_runs(&mut collapsed_detector_bars);
    let judged_bars = judged_beats
        .iter()
        .map(|beat| {
            beat.checked_sub(feature_origin)
                .map(|relative| relative / 4 + 1)
                .ok_or_else(|| anyhow::anyhow!("native phrase beat offset overflow"))
        })
        .collect::<Result<Vec<_>>>()?;
    for judged_bar in judged_bars.iter().skip(1) {
        collapsed_detector_bars.retain(|detector_bar| detector_bar.abs_diff(*judged_bar) > 1);
    }

    let mut merged = judged_bars;
    merged.extend(collapsed_detector_bars);
    merged.retain(|bar| *bar != 0);
    merged.sort_unstable();
    let last_allowed = bar_count
        .checked_sub(4)
        .ok_or_else(|| anyhow::anyhow!("native phrase bar limit overflow"))?;
    merged.retain(|bar| *bar <= last_allowed);
    merged
        .into_iter()
        .map(|bar| {
            bar.checked_mul(4)
                .and_then(|beat| beat.checked_add(feature_origin))
                .and_then(|beat| beat.checked_sub(4))
                .ok_or_else(|| anyhow::anyhow!("native phrase beat position overflow"))
        })
        .collect()
}

fn validate_native_phrase_change_window(
    primary: &[f64],
    secondary: &[f64],
    tertiary: &[f64],
    start_bar: i32,
) -> Result<()> {
    let value_count = primary.len();
    if value_count < 10 {
        bail!("native phrase change judge requires at least ten values");
    }
    if secondary.len() != value_count || tertiary.len() != value_count {
        bail!("native phrase change judge requires equally sized feature arrays");
    }
    if primary
        .iter()
        .chain(secondary)
        .chain(tertiary)
        .any(|value| !value.is_finite())
    {
        bail!("native phrase change judge requires finite features");
    }
    if start_bar <= 0 {
        bail!("native phrase change judge requires a positive one-based start bar");
    }
    Ok(())
}

fn judge_native_phrase_change_window_unchecked(
    primary: &[f64],
    secondary: &[f64],
    tertiary: &[f64],
    start_bar: i32,
) -> Result<Vec<i32>> {
    let value_count = primary.len();
    let ranked_count = value_count - 6;
    let mut average = secondary[3..value_count - 3].iter().sum::<f64>() / ranked_count as f64;
    if average == 0.0 {
        average = 0.003;
    }

    let mut primary_max = 1;
    for candidate in 2..=ranked_count {
        if primary[candidate + 2] > primary[primary_max + 2] {
            primary_max = candidate;
        }
    }

    let mut ranked = (1..=ranked_count).collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        secondary[*right + 2]
            .partial_cmp(&secondary[*left + 2])
            .expect("validated finite phrase feature")
    });
    let mut adjacent = ranked[..4].to_vec();
    adjacent.sort_by(|left, right| right.cmp(left));
    let mut survivors = adjacent.clone();
    let mut removed = 0;
    for pair in 0..3 {
        let high = adjacent[pair];
        let low = adjacent[pair + 1];
        let has_replacement = if pair == 0 {
            ranked_count >= 5
        } else {
            removed + 4 < ranked_count
        };
        if high - low != 1 || !has_replacement {
            continue;
        }
        let ratio = if secondary[low + 2] == 0.0 {
            secondary[high + 2] * 333.333_333_333_333_3
        } else {
            secondary[high + 2] / secondary[low + 2]
        };
        if ratio < 1.7 && tertiary[high + 2] <= 1.8 {
            survivors[pair] = 0;
            removed += 1;
        }
        if tertiary[high + 2] > 1.8 {
            survivors[pair + 1] = 0;
            removed += 1;
        }
    }
    ranked[..4].copy_from_slice(&survivors);

    let threshold_105 = 1.05 * average;
    let threshold_109 = 1.09 * average;
    let threshold_10573 = 1.0573 * average;
    let inverse_threshold_109 = (1.0 / 1.09) / average;
    let mut slots = vec![0; removed + 4];
    let mut accepted = 0;
    for (slot, candidate) in ranked[..slots.len()].iter().copied().enumerate() {
        if candidate == 0 {
            continue;
        }

        let local_two = (secondary[candidate] + secondary[candidate + 1]) * 0.5;
        let local_three =
            (secondary[candidate - 1] + secondary[candidate] + secondary[candidate + 1]) / 3.0;
        let primary_three =
            (primary[candidate - 1] + primary[candidate] + primary[candidate + 1]) / 3.0;
        let future_two = (secondary[candidate + 3] + secondary[candidate + 4]) * 0.5;
        let later_two = (secondary[candidate + 4] + secondary[candidate + 5]) * 0.5;
        let skipped_middle = (secondary[candidate + 5] + secondary[candidate + 3]) * 0.5;
        let current_primary = primary[candidate + 2];
        let previous_primary = primary[candidate + 1];
        let current_secondary = secondary[candidate + 2];

        if current_secondary <= threshold_105 && candidate != primary_max {
            continue;
        }
        if candidate != primary_max {
            let primary_ratio = native_ratio(current_primary, primary_three);
            if primary_ratio <= threshold_109 && primary_ratio >= inverse_threshold_109 {
                continue;
            }
        }
        if (local_two >= threshold_10573 || local_three >= threshold_10573)
            && (candidate != primary_max || native_ratio(current_primary, previous_primary) <= 1.1)
        {
            continue;
        }

        let future_two = native_nonzero(future_two);
        let later_two = native_nonzero(later_two);
        let admitted = future_two < 1.2
            || current_secondary / later_two > average
            || later_two < 1.2
            || current_secondary / future_two > average
            || (current_secondary > 1.4 && skipped_middle < 1.2);
        if !admitted {
            continue;
        }
        let candidate = i32::try_from(candidate)
            .ok()
            .and_then(|candidate| candidate.checked_add(start_bar))
            .and_then(|candidate| candidate.checked_add(2))
            .ok_or_else(|| anyhow::anyhow!("native phrase candidate index overflow"))?;
        slots[slot] = candidate;
        accepted += 1;
    }

    while slots.last() == Some(&0) {
        slots.pop();
    }
    if accepted == 0 {
        return Ok(vec![0]);
    }
    slots.sort_unstable();
    let rejected_prefix = slots
        .iter()
        .take_while(|candidate| **candidate == 0)
        .count();
    if rejected_prefix > 3 {
        return Ok(vec![0]);
    }
    slots.drain(..rejected_prefix);
    Ok(slots)
}

fn native_phrase_beat_to_bar(beat: i32, feature_origin: i32) -> Result<i32> {
    let relative = beat
        .checked_sub(feature_origin)
        .ok_or_else(|| anyhow::anyhow!("native phrase beat offset overflow"))?;
    Ok((f64::from(relative) * 0.25 + 1.5).trunc() as i32)
}

fn native_initial_phrase_bars(
    input_candidates: &[i32],
    feature_origin: i32,
    feature_count: i32,
    protected_bar: i32,
) -> Result<Vec<i32>> {
    let mut sorted = input_candidates
        .iter()
        .map(|candidate| {
            native_phrase_beat_to_bar(*candidate, feature_origin)
                .map(|bar| if bar > feature_count { 0 } else { bar })
        })
        .collect::<Result<Vec<_>>>()?;
    sorted.sort_unstable();
    let mut candidates = sorted.clone();
    for index in 0..sorted.len().saturating_sub(1) {
        if sorted[index] == sorted[index + 1] {
            candidates[index] = 0;
        }
    }
    candidates.sort_unstable();

    let mut zero_budget = 4;
    while candidates.first().is_some_and(|candidate| *candidate <= 0) {
        candidates.remove(0);
        zero_budget -= 1;
        if zero_budget == 0 {
            candidates = vec![0];
            break;
        }
    }
    if candidates.is_empty() || candidates.iter().copied().sum::<i32>() == 0 {
        candidates = vec![0];
    }
    if zero_budget >= 2
        && candidates
            .first()
            .is_some_and(|candidate| protected_bar - candidate == 1)
    {
        candidates.remove(0);
    }
    if candidates.is_empty() {
        candidates.push(0);
    }
    Ok(candidates)
}

fn collapse_native_consecutive_runs(candidates: &mut Vec<i32>) {
    let original = candidates.clone();
    for index in 0..original.len().saturating_sub(1) {
        if original[index] != 0 && original[index].checked_add(1) == Some(original[index + 1]) {
            candidates[index] = 0;
        }
    }
    candidates.retain(|candidate| *candidate > 0);
    candidates.sort_unstable();
}

fn native_mood_23_candidate_score(
    feature_families: &[NativePhraseChangeFeatures; 3],
    candidate: i32,
) -> Option<f64> {
    let index = usize::try_from(candidate.checked_sub(1)?).ok()?;
    let middle = feature_families[1].symmetric_ratio.get(index)?;
    let first = feature_families[0].symmetric_ratio.get(index)?;
    let third = feature_families[2].symmetric_ratio.get(index)?;
    let mut score = (middle + first) * 1.05 + third * 0.9;
    if candidate > 2 {
        score += feature_families[1]
            .symmetric_ratio
            .get(index.checked_sub(1)?)?;
        score *= 0.25;
    } else {
        score /= 3.0;
        if candidate == 1 {
            score = 0.0;
        }
    }
    Some(score)
}

fn suppress_native_adjacent_candidates(
    candidates: &mut Vec<i32>,
    scores: &[f64],
    protected_bar: i32,
) {
    if candidates.len() < 3 {
        return;
    }
    let mut keep = candidates.clone();
    for index in 1..candidates.len() - 1 {
        let current_score = native_nonzero(scores[index]);
        let next_score = native_nonzero(scores[index + 1]);
        let ratio = (next_score / current_score).max(current_score / next_score);
        if ratio < 1.07 || candidates[index + 1] - candidates[index] > 3 {
            continue;
        }
        let loser = if next_score > current_score {
            index
        } else {
            index + 1
        };
        let loser_bar = keep[loser];
        if loser_bar != 5 && loser_bar != 9 && loser_bar != protected_bar && scores[loser] < 1.6 {
            keep[loser] = 0;
        }
    }
    *candidates = candidates
        .iter()
        .zip(keep)
        .filter_map(|(candidate, keep)| (keep != 0).then_some(*candidate))
        .collect();
}

fn native_nonzero(value: f64) -> f64 {
    if value == 0.0 { 0.003 } else { value }
}

fn native_ratio(numerator: f64, denominator: f64) -> f64 {
    numerator / native_nonzero(denominator)
}

fn native_mood_23_low_level_bars(values: &[f64], feature_origin: usize) -> Result<Vec<f64>> {
    if feature_origin == 0 || feature_origin > values.len() {
        bail!("native mood-2/3 low-level bars require a one-based origin within the input");
    }
    if values.iter().any(|value| !value.is_finite()) {
        bail!("native mood-2/3 low-level bars require finite input");
    }
    let available = values.len() - feature_origin + 1;
    let bar_count = available.div_ceil(4);
    if bar_count == 0 {
        bail!("native mood-2/3 low-level bars require input");
    }
    let mut bars = vec![0.0; bar_count];
    for (bar, slot) in bars
        .iter_mut()
        .take(bar_count.saturating_sub(2))
        .enumerate()
    {
        let start = feature_origin - 1 + bar * 4;
        *slot = values[start..start + 4].iter().sum();
    }
    Ok(bars)
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
    fn native_mood_23_feature_families_preserve_distinct_guard_rules() {
        let values = (1..=14).map(f64::from).collect::<Vec<_>>();
        let trace = NativePhraseFeatureTrace {
            boundaries: PhraseBeatBoundaries {
                high_pass_2: Vec::new(),
                low_pass_8: Vec::new(),
                low_pass_32: Vec::new(),
            },
            low_level: values.clone(),
            middle_level: Vec::new(),
            divided_low_level: Vec::new(),
            divided_middle_level: Vec::new(),
            low_peak: values.clone(),
            low_peak_quarters: Vec::new(),
            middle_peak: values,
            all_level: Vec::new(),
            all_power_quarter_energy: Vec::new(),
            all_power_quarter_peak: Vec::new(),
            high_peak_eighths: Vec::new(),
        };

        let [low_peak, low_level, middle_peak] =
            derive_native_mood_23_feature_families(&trace, 2).expect("mood-2/3 families");

        assert_eq!(low_peak.normalized.len(), 3);
        assert_eq!(middle_peak.normalized, low_peak.normalized);
        assert_eq!(low_level.normalized.len(), 4);
        assert_eq!(low_level.normalized, [14.0 / 30.0, 1.0, 0.003, 0.0]);
        assert_eq!(low_level.directional_ratio[2], 0.003);
        assert_eq!(low_level.directional_ratio[3], 0.0);
    }

    #[test]
    fn native_change_judge_matches_captured_rank_and_threshold_result() {
        let features = NativePhraseChangeFeatures {
            normalized: vec![
                0.9375107081998899,
                0.9524291547126951,
                0.9401769794944234,
                0.9462614782710926,
                0.9499977144107871,
                0.9439149165144872,
                0.951074052313648,
                0.949861726919943,
                0.9423347738321425,
                0.9507508038677926,
                0.9411321635726104,
                0.9558680116282967,
                0.9452631892784565,
                0.9481996172292793,
                0.9477617012963716,
                0.17100498101967251,
                0.15770056894487494,
                0.17377998430072264,
                0.15671323006775806,
                0.17176476246926956,
                0.15900154346787712,
                0.1759392734400592,
            ],
            symmetric_ratio: vec![
                1.007206870467956,
                1.0159128278560678,
                1.0130317753843114,
                1.0064716525817736,
                1.0039484183024345,
                1.006444222662315,
                1.0075845138941089,
                1.0012763177622033,
                1.0079875573912984,
                1.0089310405063638,
                1.0102202864459218,
                1.015657575658394,
                1.0112189096858146,
                1.0031064659918305,
                1.0004620527842691,
                5.542304648934996,
                1.0843650226743835,
                1.10196168259525,
                1.1089043613330247,
                1.09604506521245,
                1.080271038400146,
                1.10652556951816,
            ],
            directional_ratio: vec![
                0.9928446968748261,
                1.0159128278560678,
                0.9871358671060761,
                1.0064716525817736,
                1.0039484183024345,
                0.9935970394412238,
                1.0075845138941089,
                0.9987253091483719,
                0.9920757381053686,
                1.0089310405063638,
                0.9898831110570171,
                1.015657575658394,
                0.9889055578585844,
                1.0031064659918305,
                0.999538160609907,
                0.1804303558434232,
                0.9221986868717759,
                1.10196168259525,
                0.9017910244287345,
                1.09604506521245,
                0.9256936124854136,
                1.10652556951816,
            ],
        };

        assert_eq!(
            judge_native_phrase_change_window(&features, 49).expect("judge"),
            [60, 64]
        );
    }

    #[test]
    fn native_change_judge_preserves_captured_three_zero_quorum() {
        let features = NativePhraseChangeFeatures {
            normalized: vec![
                0.7847212036844456,
                0.8027666109686161,
                0.7843179617503733,
                0.7977155785209983,
                0.7858730192633699,
                0.8000250906214732,
                0.78444844227819,
                0.7989549534633168,
                0.7839512292942151,
                0.801876268139109,
                0.7825586431724094,
                0.7991914350356267,
                0.7863735761750984,
                0.8008917523928059,
                0.781112591632359,
                0.2139497668182596,
                0.19989885868164275,
                0.21924604546615772,
                0.2048188160180513,
                0.21518623080885144,
                0.20179076706889862,
                0.21912052284830508,
            ],
            symmetric_ratio: vec![
                1.0187049222585178,
                1.0229959470948957,
                1.0235219007060232,
                1.0170818691194135,
                1.0150693037772551,
                1.0180080891075363,
                1.0198568159534431,
                1.0184926253954907,
                1.0191385938416213,
                1.0228649923299842,
                1.0246852106679034,
                1.0212543711686446,
                1.0162999613019477,
                1.0184621872575164,
                1.0253217794365759,
                3.6509158352851947,
                1.0702900868433383,
                1.0967848786737053,
                1.0704389847016542,
                1.0506174920466604,
                1.066382936813849,
                1.085879825083818,
            ],
            directional_ratio: vec![
                0.9816385276542611,
                1.0229959470948957,
                0.9770186639975188,
                1.0170818691194135,
                0.9851544089441189,
                1.0180080891075363,
                0.9805298002201619,
                1.0184926253954907,
                0.981220813383704,
                1.0228649923299842,
                0.97590946916096,
                1.0212543711686446,
                0.9839614661786797,
                1.0184621872575164,
                0.9753035779163001,
                0.27390387648360676,
                0.9343261348419583,
                1.0967848786737053,
                0.93419617025506,
                1.0506174920466604,
                0.9377494382907244,
                1.085879825083818,
            ],
        };

        assert_eq!(
            judge_native_phrase_change_window(&features, 49).expect("judge"),
            [0]
        );
    }

    #[test]
    fn native_mood_23_initial_candidates_match_duplicate_cleanup() {
        assert_eq!(
            native_initial_phrase_bars(&[17, 17, 17, 13], 1, 157, 5).expect("initial candidates"),
            [5]
        );
    }

    #[test]
    fn native_mood_23_merge_keeps_last_bar_in_consecutive_runs() {
        let mut candidates = vec![1, 5, 6, 7, 10, 11];
        collapse_native_consecutive_runs(&mut candidates);
        assert_eq!(candidates, [1, 7, 11]);
    }

    #[test]
    fn native_mood_23_score_filter_honors_fixed_bar_protection() {
        let mut candidates = vec![1, 5, 7, 9];
        suppress_native_adjacent_candidates(&mut candidates, &[0.0, 1.0, 2.0, 0.5], 20);
        assert_eq!(candidates, [1, 5, 7, 9]);

        let mut candidates = vec![1, 4, 6, 8];
        suppress_native_adjacent_candidates(&mut candidates, &[0.0, 1.0, 2.0, 0.5], 20);
        assert_eq!(candidates, [1, 6]);
    }

    #[test]
    fn native_mood_23_judge_is_deterministic_for_flat_feature_families() {
        let features = std::array::from_fn(|_| NativePhraseChangeFeatures {
            normalized: vec![1.0; 32],
            symmetric_ratio: vec![1.0; 32],
            directional_ratio: vec![1.0; 32],
        });
        assert_eq!(
            judge_native_mood_23_phrase_boundaries(&features, &[4], 4, 4, 2)
                .expect("mood-2/3 judge"),
            [4, 16, 80]
        );
    }

    #[test]
    fn native_mood_23_candidate_adjustment_matches_captured_mood_2() {
        let judged = [
            4, 64, 128, 148, 164, 240, 256, 304, 328, 336, 384, 412, 432, 496, 512, 576, 604, 640,
            656, 744, 752, 808, 848, 872, 880,
        ];
        let detector_bars = [2, 77, 99, 105, 112, 123, 128, 136, 156, 221, 225, 226];
        assert_eq!(
            adjust_native_mood_23_phrase_candidates(&judged, &detector_bars, 4, 229)
                .expect("candidate adjustment"),
            [
                4, 8, 64, 128, 148, 164, 240, 256, 304, 328, 336, 384, 396, 412, 420, 432, 448,
                496, 512, 544, 576, 604, 624, 640, 656, 744, 752, 808, 848, 872, 880,
            ]
        );
    }

    #[test]
    fn native_mood_23_candidate_adjustment_matches_captured_mood_3() {
        let judged = [
            1, 17, 49, 65, 129, 161, 193, 217, 225, 257, 289, 321, 353, 413, 445, 481, 513, 573,
            593, 625,
        ];
        assert_eq!(
            adjust_native_mood_23_phrase_candidates(&judged, &[17, 70, 81, 89, 123, 129], 1, 162,)
                .expect("candidate adjustment"),
            [
                1, 17, 49, 65, 129, 161, 193, 217, 225, 257, 277, 289, 321, 353, 413, 445, 481,
                489, 513, 573, 593, 625,
            ]
        );
    }

    #[test]
    fn native_mood_23_sound_change_matches_captured_transition_shape() {
        let mut features = vec![0.3; 916];
        let bar_averages = [
            (0, 0.331_914_893_617_021_26),
            (1, 0.063_829_787_234_042_55),
            (2, 0.336_170_212_765_957_43),
            (3, 0.353_191_489_361_702_14),
            (4, 0.327_659_574_468_085_14),
            (5, 0.378_723_404_255_319_14),
            (6, 0.391_489_361_702_127_67),
            (223, 0.476_595_744_680_851_1),
            (224, 0.085_106_382_978_723_4),
            (225, 0.0),
            (226, 0.0),
            (227, 0.0),
        ];
        for (bar, average) in bar_averages {
            features[bar * 4..bar * 4 + 4].fill(average);
        }

        assert_eq!(
            detect_native_mood_23_sound_changes(&features).expect("sound changes"),
            [2, 225, 226]
        );
    }

    #[test]
    fn native_mood_23_short_break_matches_recovery_shape() {
        let mut feature_a = (0..28)
            .map(|index| if index % 2 == 0 { 1.0 } else { 0.2 })
            .collect::<Vec<_>>();
        feature_a[18] = 1.0;
        feature_a[19] = 0.05;
        feature_a[20] = 1.0;
        let feature_b = feature_a.clone();

        assert_eq!(
            detect_native_mood_23_short_breaks(&feature_a, &feature_b)
                .expect("short-break detection"),
            [6]
        );
    }

    #[test]
    fn native_mood_23_genre_stages_merge_short_breaks_into_beats() {
        let mut low_level = (0..48)
            .map(|index| if index % 2 == 0 { 1.0 } else { 0.2 })
            .collect::<Vec<_>>();
        low_level[18] = 1.0;
        low_level[19] = 0.05;
        low_level[20] = 1.0;
        let middle_level = low_level.clone();

        assert_eq!(
            add_native_mood_23_genre_candidates(
                &low_level,
                &middle_level,
                &[0.0; 48 * 8],
                &[1.0; 48],
                &[1.0; 48],
                &[1],
                1,
            )
            .expect("genre-stage candidates"),
            [1, 21]
        );
    }

    #[test]
    fn native_mood_23_snare_fill_preserves_overwritten_lower_quantile() {
        let peak_sums = [
            0.722_880_004_371,
            0.525_629_025_458,
            1.320_527_891_05,
            0.454_934_663_93,
            1.068_330_441_22,
            0.780_820_367_973,
            0.442_995_321_686,
            1.013_791_362_12,
            0.426_576_107_269,
            0.884_945_544_307,
            0.452_776_980_453,
            0.470_511_681_988,
            0.870_192_530_919,
            1.825_919_807_01,
            0.500_082_398_561,
            0.600_608_081_667,
            1.264_580_783_24,
            2.281_219_913_19,
            1.152_609_935_54,
            0.826_693_227_384,
            2.404_385_412_78,
            0.433_776_624_092,
            1.935_417_961_81,
            0.678_714_971_252,
            0.519_282_954_027,
            0.494_576_857_155,
            0.702_725_089_154,
            1.790_198_081_18,
        ];
        let mut features = vec![0.0; 32 * 32];
        for (bar, peak_sum) in peak_sums.into_iter().enumerate() {
            features[bar * 32 + 1] = peak_sum;
        }

        assert_eq!(
            detect_native_mood_23_snare_fills(&features).expect("snare fills"),
            [24]
        );
    }

    #[test]
    fn native_mood_23_vocal_entry_matches_long_and_short_gap_paths() {
        let mut long_gap = vec![0.0; 40];
        long_gap[8] = 1.0;
        long_gap[9] = 1.0;
        assert_eq!(
            detect_native_mood_23_vocal_entries(&long_gap).expect("long-gap vocal entry"),
            [3]
        );

        let mut short_gap = vec![0.0; 40];
        short_gap[3..7].fill(1.0);
        assert_eq!(
            detect_native_mood_23_vocal_entries(&short_gap).expect("short-gap vocal entry"),
            [2]
        );
    }

    #[test]
    fn native_change_features_reject_invalid_inputs() {
        assert!(derive_native_phrase_change_features(&[f64::NAN]).is_err());
        assert!(derive_native_phrase_bar_change_features(&[1.0; 8], 0).is_err());
        assert!(derive_native_phrase_bar_change_features(&[1.0; 3], 1).is_err());
        assert!(detect_native_mood_23_short_breaks(&[1.0], &[1.0, 2.0]).is_err());
        assert!(detect_native_mood_23_short_breaks(&[f64::NAN], &[1.0]).is_err());
        assert!(detect_native_mood_23_sound_changes(&[f64::NAN]).is_err());
        assert!(detect_native_mood_23_snare_fills(&[f64::NAN]).is_err());
        assert!(detect_native_mood_23_vocal_entries(&[f64::NAN]).is_err());
        assert!(
            judge_native_phrase_change_window(
                &NativePhraseChangeFeatures {
                    normalized: vec![0.0; 10],
                    symmetric_ratio: vec![0.0; 9],
                    directional_ratio: vec![0.0; 10],
                },
                1,
            )
            .is_err()
        );
    }
}
