//! Clean-room implementation of Rekordbox's analysis sample-rate converter.
//!
//! The converter is a 29-tap polyphase sinc filter with a Kaiser window. Its
//! phase layout, filter-quality table, initial history, and accumulation order
//! follow the behavior observed at the analysis-engine boundary.

use anyhow::{Context, Result, bail};
use rayon::prelude::*;

const RATE_QUANTUM: u32 = 50;
const FILTER_TAPS: usize = 29;
const INITIAL_HISTORY: usize = FILTER_TAPS - 1;
const MIN_SAMPLE_RATE: u32 = 8_000;
const MAX_SAMPLE_RATE: u32 = 200_000;
const KAISER_TERMS: u32 = 22;
const PARALLEL_OUTPUT_THRESHOLD: usize = 262_144;

/// Select the sample rate used by Rekordbox's rhythm-analysis engine.
///
/// Native 44.1 and 48 kHz inputs are retained. Other 8 kHz-family rates are
/// converted to 48 kHz; all remaining rates are converted to 44.1 kHz.
pub fn analysis_sample_rate(source_rate: u32) -> Result<u32> {
    validate_sample_rate(source_rate)?;
    Ok(match source_rate {
        44_100 | 48_000 => source_rate,
        rate if rate.is_multiple_of(8_000) => 48_000,
        _ => 44_100,
    })
}

/// A deterministic, batch-oriented version of Rekordbox's analysis resampler.
#[derive(Debug, Clone)]
pub struct AnalysisSampleRateConverter {
    source_rate: u32,
    target_rate: u32,
    phase_count: usize,
    input_step: usize,
    phase_offsets: Vec<usize>,
    coefficients: Vec<[f32; FILTER_TAPS]>,
}

impl AnalysisSampleRateConverter {
    /// Construct the native filter for one supported source/target rate pair.
    pub fn new(source_rate: u32, target_rate: u32) -> Result<Self> {
        validate_sample_rate(source_rate)?;
        validate_sample_rate(target_rate)?;
        if !source_rate.is_multiple_of(RATE_QUANTUM) || !target_rate.is_multiple_of(RATE_QUANTUM) {
            bail!(
                "analysis resampler rates must be multiples of {RATE_QUANTUM}: \
                 {source_rate} -> {target_rate}"
            );
        }

        let phase_count = usize::try_from(target_rate / RATE_QUANTUM)
            .expect("sample-rate phase count fits usize");
        let input_step =
            usize::try_from(source_rate / RATE_QUANTUM).expect("sample-rate step fits usize");
        let (cutoff, beta) = filter_quality(source_rate, target_rate);
        let (phase_offsets, coefficients) =
            make_kaiser_filter(phase_count, input_step, cutoff, beta)?;

        Ok(Self {
            source_rate,
            target_rate,
            phase_count,
            input_step,
            phase_offsets,
            coefficients,
        })
    }

    /// Input sample rate in Hertz.
    pub fn source_rate(&self) -> u32 {
        self.source_rate
    }

    /// Output sample rate in Hertz.
    pub fn target_rate(&self) -> u32 {
        self.target_rate
    }

    /// Number of output frames produced for an input frame count.
    ///
    /// This describes the converter itself. File readers may deliberately pad
    /// their final source block before passing it to the converter.
    pub fn output_len(&self, input_len: usize) -> Result<usize> {
        if self.source_rate == self.target_rate || input_len == 0 {
            return Ok(input_len);
        }
        let numerator = (input_len as u128)
            .checked_mul(u128::from(self.target_rate))
            .and_then(|value| value.checked_add(u128::from(self.source_rate - 1)))
            .context("analysis resampler output length overflow")?;
        usize::try_from(numerator / u128::from(self.source_rate))
            .context("analysis resampler output does not fit in memory")
    }

    /// Resample normalized mono PCM without adding an end-of-stream tail.
    pub fn resample_mono(&self, input: &[f32]) -> Result<Vec<f32>> {
        let output_len = self.output_len(input.len())?;
        self.resample_mono_to_len(input, output_len)
    }

    /// Resample the frame range advertised by Rekordbox's file-reader wrapper.
    ///
    /// `reader_padding_frames` is measured at the source rate. Native FLAC
    /// readers advertise one maximum STREAMINFO block beyond the decoded
    /// samples; Core Audio can advertise one absent LAME/Info MP3 packet. The
    /// analysis reader exposes one fewer target frame than that length.
    pub fn resample_mono_for_reader(
        &self,
        input: &[f32],
        reader_padding_frames: usize,
    ) -> Result<Vec<f32>> {
        let advertised_input_len = input
            .len()
            .checked_add(reader_padding_frames)
            .context("analysis reader source length overflow")?;
        let output_len = self
            .output_len(advertised_input_len)?
            .checked_sub(1)
            .unwrap_or_default();
        self.resample_mono_to_len(input, output_len)
    }

    fn resample_mono_to_len(&self, input: &[f32], output_len: usize) -> Result<Vec<f32>> {
        if self.source_rate == self.target_rate {
            let mut output = input.to_vec();
            output.resize(output_len, 0.0);
            return Ok(output);
        }
        let mut output = vec![0.0; output_len];
        let render = |output_index: usize| -> Result<f32> {
            let phase = output_index % self.phase_count;
            let cycle = output_index / self.phase_count;
            let window_start = cycle
                .checked_mul(self.input_step)
                .and_then(|start| start.checked_add(self.phase_offsets[phase]))
                .context("analysis resampler input position overflow")?;
            Ok(convolve_fine(
                input,
                window_start,
                &self.coefficients[phase],
            ))
        };
        if output_len >= PARALLEL_OUTPUT_THRESHOLD && rayon::current_num_threads() > 1 {
            output
                .par_iter_mut()
                .enumerate()
                .try_for_each(|(output_index, sample)| {
                    *sample = render(output_index)?;
                    Ok::<_, anyhow::Error>(())
                })?;
        } else {
            for (output_index, sample) in output.iter_mut().enumerate() {
                *sample = render(output_index)?;
            }
        }

        Ok(output)
    }

    #[cfg(test)]
    fn phase_coefficients(&self, phase: usize) -> &[f32; FILTER_TAPS] {
        &self.coefficients[phase]
    }
}

/// Apply the native normalized-float → signed-16-bit → normalized-float path.
pub fn quantize_analysis_pcm(sample: f32) -> f32 {
    let quantized = (sample * 32_768.0)
        .clamp(f32::from(i16::MIN), f32::from(i16::MAX))
        .trunc() as i16;
    f32::from(quantized) / 32_768.0
}

fn validate_sample_rate(sample_rate: u32) -> Result<()> {
    if !(MIN_SAMPLE_RATE..=MAX_SAMPLE_RATE).contains(&sample_rate) {
        bail!("analysis sample rate must be between {MIN_SAMPLE_RATE} and {MAX_SAMPLE_RATE} Hz");
    }
    Ok(())
}

fn filter_quality(source_rate: u32, target_rate: u32) -> (f64, f64) {
    match (source_rate, target_rate) {
        (44_100, 48_000) => (0.54, 8.0),
        (44_100, 88_200 | 96_000) => (0.58, 10.0),
        (44_100, 176_400 | 192_000) => (0.48, 9.0),
        (48_000, 44_100) => (0.52, 8.0),
        (48_000, 96_000) => (0.45, 10.0),
        (88_200, 44_100) => (0.55, 6.0),
        (96_000, 44_100) => (0.55, 6.0),
        (96_000, 48_000) => (0.47, 10.0),
        _ => (0.45, 12.0),
    }
}

fn make_kaiser_filter(
    phase_count: usize,
    input_step: usize,
    cutoff: f64,
    beta: f64,
) -> Result<(Vec<usize>, Vec<[f32; FILTER_TAPS]>)> {
    let max_step = phase_count.max(input_step);
    let normalized_cutoff = cutoff / max_step as f64;
    let prototype_len = FILTER_TAPS
        .checked_mul(phase_count)
        .context("analysis resampler prototype length overflow")?;
    let center = -(prototype_len as i64 / 2);
    let denominator = native_i0(beta * 0.5);
    let mut prototype = Vec::with_capacity(prototype_len);

    for index in 0..prototype_len {
        let distance = center + index as i64;
        let sinc = if distance == 0 {
            normalized_cutoff * 2.0
        } else {
            let distance = distance as f64;
            (std::f64::consts::TAU * normalized_cutoff * distance).sin()
                / (std::f64::consts::PI * distance)
        };
        let window_position = index as f64 * (2.0 / (prototype_len - 1) as f64) - 1.0;
        let window_argument = beta * 0.5 * (1.0 - window_position * window_position).sqrt();
        prototype.push(sinc * native_i0(window_argument) / denominator);
    }

    let mut phase_offsets = Vec::with_capacity(phase_count);
    let mut coefficients = Vec::with_capacity(phase_count);
    for phase in 0..phase_count {
        let input_position = input_step
            .checked_mul(phase)
            .context("analysis resampler phase position overflow")?;
        let phase_offset = input_position / phase_count;
        let remainder = input_position % phase_count;
        let mut taps = [0.0_f32; FILTER_TAPS];
        for (tap, coefficient) in taps.iter_mut().enumerate() {
            let prototype_index = tap
                .checked_mul(phase_count)
                .and_then(|index| index.checked_add(phase_count - 1 - remainder))
                .context("analysis resampler coefficient index overflow")?;
            *coefficient = (prototype[prototype_index] * phase_count as f64) as f32;
        }
        phase_offsets.push(phase_offset);
        coefficients.push(taps);
    }

    Ok((phase_offsets, coefficients))
}

fn native_i0(argument_over_two: f64) -> f64 {
    let squared = argument_over_two * argument_over_two;
    let mut term = 1.0_f64;
    let mut sum = term;
    for index in 1..KAISER_TERMS {
        let index = f64::from(index);
        term *= squared / (index * index);
        sum += term;
    }
    sum
}

fn convolve_fine(input: &[f32], window_start: usize, coefficients: &[f32; FILTER_TAPS]) -> f32 {
    let sample = |tap: usize| {
        window_start
            .checked_add(tap)
            .and_then(|position| position.checked_sub(INITIAL_HISTORY))
            .and_then(|position| input.get(position))
            .copied()
            .unwrap_or(0.0)
    };
    let mut sum = 0.0_f32;
    for left in 0..FILTER_TAPS / 2 {
        let right = FILTER_TAPS - 1 - left;
        let left_product = sample(left) * coefficients[left];
        sum += left_product;
        let right_product = sample(right) * coefficients[right];
        sum += right_product;
    }
    let middle = FILTER_TAPS / 2;
    let middle_product = sample(middle) * coefficients[middle];
    sum + middle_product
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_analysis_rate_policy_preserves_two_families() {
        assert_eq!(analysis_sample_rate(44_100).unwrap(), 44_100);
        assert_eq!(analysis_sample_rate(48_000).unwrap(), 48_000);
        assert_eq!(analysis_sample_rate(96_000).unwrap(), 48_000);
        assert_eq!(analysis_sample_rate(192_000).unwrap(), 48_000);
        assert_eq!(analysis_sample_rate(88_200).unwrap(), 44_100);
        assert_eq!(analysis_sample_rate(22_050).unwrap(), 44_100);
        assert!(analysis_sample_rate(0).is_err());
    }

    #[test]
    fn native_filter_quality_table_covers_observed_rate_pairs() {
        assert_eq!(filter_quality(44_100, 48_000), (0.54, 8.0));
        assert_eq!(filter_quality(48_000, 44_100), (0.52, 8.0));
        assert_eq!(filter_quality(96_000, 48_000), (0.47, 10.0));
        assert_eq!(filter_quality(96_000, 44_100), (0.55, 6.0));
        assert_eq!(filter_quality(44_100, 192_000), (0.48, 9.0));
        assert_eq!(filter_quality(32_000, 48_000), (0.45, 12.0));
    }

    #[test]
    fn output_length_uses_native_ceiling_behavior() {
        let converter = AnalysisSampleRateConverter::new(96_000, 48_000).unwrap();
        assert_eq!(converter.output_len(0).unwrap(), 0);
        assert_eq!(converter.output_len(1).unwrap(), 1);
        assert_eq!(converter.output_len(2).unwrap(), 1);
        assert_eq!(converter.output_len(3).unwrap(), 2);

        let converter = AnalysisSampleRateConverter::new(44_100, 48_000).unwrap();
        assert_eq!(converter.output_len(44_100).unwrap(), 48_000);
        assert_eq!(converter.output_len(44_101).unwrap(), 48_002);
    }

    #[test]
    fn two_to_one_filter_reuses_one_rational_phase() {
        let converter = AnalysisSampleRateConverter::new(96_000, 48_000).unwrap();
        let reference = converter.phase_coefficients(0);
        for phase in 1..converter.phase_count {
            assert_eq!(
                converter.phase_coefficients(phase).map(f32::to_bits),
                reference.map(f32::to_bits)
            );
        }
    }

    #[test]
    fn initial_history_is_zero_and_output_is_start_aligned() {
        let converter = AnalysisSampleRateConverter::new(96_000, 48_000).unwrap();
        let mut impulse = vec![0.0; 96];
        impulse[0] = 1.0;
        let output = converter.resample_mono(&impulse).unwrap();
        assert_eq!(output.len(), 48);
        assert!(output[..14].iter().any(|sample| *sample != 0.0));
        assert!(output[15..].iter().all(|sample| *sample == 0.0));
    }

    #[test]
    fn native_reader_length_uses_source_padding_before_rate_conversion() {
        let converter = AnalysisSampleRateConverter::new(96_000, 48_000).unwrap();
        let input = vec![1.0; 96];
        let output = converter.resample_mono_for_reader(&input, 4_096).unwrap();
        assert_eq!(output.len(), 2_095);
        assert!(output[48..62].iter().any(|sample| *sample != 0.0));
        assert!(output[62..].iter().all(|sample| *sample == 0.0));
    }

    #[test]
    fn native_reader_without_padding_drops_its_final_converted_frame() {
        let converter = AnalysisSampleRateConverter::new(32_000, 48_000).unwrap();
        let output = converter
            .resample_mono_for_reader(&vec![0.0; 259_936], 0)
            .unwrap();
        assert_eq!(output.len(), 389_903);
    }

    #[test]
    fn native_supported_rate_range_is_eight_to_two_hundred_kilohertz() {
        assert_eq!(analysis_sample_rate(8_000).unwrap(), 48_000);
        assert_eq!(analysis_sample_rate(200_000).unwrap(), 48_000);
        assert!(analysis_sample_rate(7_999).is_err());
        assert!(analysis_sample_rate(200_001).is_err());
    }

    #[test]
    fn native_pcm_quantization_clamps_and_truncates_toward_zero() {
        assert_eq!(quantize_analysis_pcm(0.0).to_bits(), 0.0_f32.to_bits());
        assert_eq!(quantize_analysis_pcm(1.0), 32_767.0 / 32_768.0);
        assert_eq!(quantize_analysis_pcm(-1.0), -1.0);
        assert_eq!(quantize_analysis_pcm(1.5), 32_767.0 / 32_768.0);
        assert_eq!(quantize_analysis_pcm(-1.5), -1.0);
        assert_eq!(quantize_analysis_pcm(1.9 / 32_768.0), 1.0 / 32_768.0);
        assert_eq!(quantize_analysis_pcm(-1.9 / 32_768.0), -1.0 / 32_768.0);
    }

    #[test]
    fn passband_preserves_a_settled_constant() {
        let converter = AnalysisSampleRateConverter::new(96_000, 48_000).unwrap();
        let output = converter.resample_mono(&vec![0.25; 512]).unwrap();
        for sample in &output[32..224] {
            assert!((*sample - 0.25).abs() < 5.0e-6, "{sample}");
        }
    }
}
