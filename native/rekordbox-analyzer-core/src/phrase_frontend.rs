//! Recovered multirate frontend used by linked song-structure analysis.
//!
//! The native pipeline produces synchronized high-frequency `Fs/2`,
//! mid-band `Fs/8`, and low-band `Fs/32` streams. Each path cascades four
//! second-order Butterworth sections and emits the last source sample in every
//! decimation group.

use std::f64::consts::PI;

use anyhow::{Result, bail};

const BUTTERWORTH_DAMPING: [f64; 4] = [
    1.961_570_560_806_460_9,
    1.662_939_224_605_090_5,
    1.111_140_466_039_204_6,
    0.390_180_644_032_256_6,
];

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
}
