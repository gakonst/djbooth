//! Deterministic, redistributable audio decode and analysis framing.

use std::fs::File;
use std::path::Path;

use anyhow::{Context, Result, bail};
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

/// Sample rate used by the Rekordbox 6 analysis primitives.
pub const ANALYSIS_SAMPLE_RATE: u32 = 44_100;

/// Number of detailed waveform columns generated per second.
pub const DETAIL_COLUMNS_PER_SECOND: usize = 150;

/// Samples in one detailed waveform column at [`ANALYSIS_SAMPLE_RATE`].
pub const DETAIL_FRAME_SAMPLES: usize = ANALYSIS_SAMPLE_RATE as usize / DETAIL_COLUMNS_PER_SECOND;

/// Source properties retained after decoding to mono.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioSourceInfo {
    sample_rate: u32,
    channels: usize,
    decoded_frames: usize,
}

impl AudioSourceInfo {
    /// Source sample rate reported by the decoded buffers.
    pub fn sample_rate(self) -> u32 {
        self.sample_rate
    }

    /// Number of decoded source channels before the deterministic mono mix.
    pub fn channels(self) -> usize {
        self.channels
    }

    /// Number of decoded source frames.
    pub fn decoded_frames(self) -> usize {
        self.decoded_frames
    }
}

/// A decoded file and its equal-weight mono PCM signal.
#[derive(Debug, Clone, PartialEq)]
pub struct DecodedAudio {
    source: AudioSourceInfo,
    mono: MonoPcm,
}

impl DecodedAudio {
    /// Source stream properties.
    pub fn source(&self) -> AudioSourceInfo {
        self.source
    }

    /// Equal-weight, normalized mono samples at the source sample rate.
    pub fn mono(&self) -> &MonoPcm {
        &self.mono
    }

    /// Resample the decoded mono signal to 44.1 kHz.
    pub fn into_analysis_pcm(self) -> Result<MonoPcm> {
        self.mono.resample_linear(ANALYSIS_SAMPLE_RATE)
    }
}

/// Finite mono PCM samples in the normalized `[-1.0, 1.0]` range.
#[derive(Debug, Clone, PartialEq)]
pub struct MonoPcm {
    sample_rate: u32,
    samples: Vec<f32>,
}

impl MonoPcm {
    /// Validate and construct normalized mono PCM.
    pub fn new(sample_rate: u32, samples: Vec<f32>) -> Result<Self> {
        if sample_rate == 0 {
            bail!("mono PCM sample rate must be nonzero");
        }
        if let Some((index, _)) = samples
            .iter()
            .enumerate()
            .find(|(_, sample)| !sample.is_finite())
        {
            bail!("mono PCM sample {index} is not finite");
        }
        Ok(Self {
            sample_rate,
            samples: samples
                .into_iter()
                .map(|sample| sample.clamp(-1.0, 1.0))
                .collect(),
        })
    }

    /// Signal sample rate in Hertz.
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// Normalized mono samples.
    pub fn samples(&self) -> &[f32] {
        &self.samples
    }

    /// Number of mono sample frames.
    pub fn len(&self) -> usize {
        self.samples.len()
    }

    /// Whether the signal contains no frames.
    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }

    /// Signal duration in seconds.
    pub fn duration_seconds(&self) -> f64 {
        self.samples.len() as f64 / f64::from(self.sample_rate)
    }

    /// Deterministically resample with start-aligned linear interpolation.
    ///
    /// The output length is the nearest integer to
    /// `input_frames * target_rate / source_rate`. Every source position is
    /// derived from an integer phase, so packet boundaries and accumulated
    /// floating-point phase cannot change the result.
    pub fn resample_linear(&self, target_rate: u32) -> Result<Self> {
        if target_rate == 0 {
            bail!("target sample rate must be nonzero");
        }
        if target_rate == self.sample_rate {
            return Ok(self.clone());
        }
        if self.samples.is_empty() {
            return Self::new(target_rate, Vec::new());
        }

        let source_rate = u128::from(self.sample_rate);
        let target_rate_wide = u128::from(target_rate);
        let scaled_len = (self.samples.len() as u128)
            .checked_mul(target_rate_wide)
            .context("resampled PCM length overflow")?;
        let output_len = scaled_len
            .checked_add(source_rate / 2)
            .context("resampled PCM rounding overflow")?
            / source_rate;
        let output_len =
            usize::try_from(output_len).context("resampled PCM does not fit in memory")?;
        let last_index = self.samples.len() - 1;
        let mut output = Vec::with_capacity(output_len);

        for output_index in 0..output_len {
            let phase = (output_index as u128)
                .checked_mul(source_rate)
                .context("resampler phase overflow")?;
            let source_index = usize::try_from(phase / target_rate_wide)
                .context("resampler source index overflow")?
                .min(last_index);
            let next_index = source_index.saturating_add(1).min(last_index);
            let fraction = (phase % target_rate_wide) as f64 / f64::from(target_rate);
            let left = f64::from(self.samples[source_index]);
            let right = f64::from(self.samples[next_index]);
            output.push((left + (right - left) * fraction) as f32);
        }

        Self::new(target_rate, output)
    }

    /// Borrow the signal as fixed-width, fixed-hop frames.
    pub fn frames(&self, spec: FrameSpec) -> PcmFrames<'_> {
        PcmFrames {
            samples: &self.samples,
            spec,
            next_start: (!self.samples.is_empty()).then_some(0),
            index: 0,
        }
    }

    /// Borrow contiguous 294-sample waveform frames, including a final partial frame.
    pub fn detail_frames(&self) -> PcmFrames<'_> {
        self.frames(FrameSpec::detail())
    }
}

/// Fixed framing parameters for deterministic signal traversal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameSpec {
    frame_len: usize,
    hop_len: usize,
    include_partial: bool,
}

impl FrameSpec {
    /// Construct a framing layout.
    pub fn new(frame_len: usize, hop_len: usize, include_partial: bool) -> Result<Self> {
        if frame_len == 0 {
            bail!("PCM frame length must be nonzero");
        }
        if hop_len == 0 {
            bail!("PCM frame hop length must be nonzero");
        }
        Ok(Self {
            frame_len,
            hop_len,
            include_partial,
        })
    }

    /// Canonical non-overlapping detailed-waveform framing.
    pub const fn detail() -> Self {
        Self {
            frame_len: DETAIL_FRAME_SAMPLES,
            hop_len: DETAIL_FRAME_SAMPLES,
            include_partial: true,
        }
    }

    /// Logical frame width in samples.
    pub fn frame_len(self) -> usize {
        self.frame_len
    }

    /// Distance between adjacent frame starts.
    pub fn hop_len(self) -> usize {
        self.hop_len
    }

    /// Whether a short final frame is yielded.
    pub fn includes_partial(self) -> bool {
        self.include_partial
    }

    fn frame_count(self, sample_count: usize) -> usize {
        if sample_count == 0 {
            return 0;
        }
        if self.include_partial {
            return 1 + (sample_count - 1) / self.hop_len;
        }
        if sample_count < self.frame_len {
            return 0;
        }
        1 + (sample_count - self.frame_len) / self.hop_len
    }
}

/// One borrowed PCM frame. Missing tail samples are logically zero.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PcmFrame<'a> {
    index: usize,
    start_sample: usize,
    frame_len: usize,
    samples: &'a [f32],
}

impl<'a> PcmFrame<'a> {
    /// Zero-based frame index.
    pub fn index(self) -> usize {
        self.index
    }

    /// Absolute start sample within the signal.
    pub fn start_sample(self) -> usize {
        self.start_sample
    }

    /// Logical frame width, including zero padding.
    pub fn frame_len(self) -> usize {
        self.frame_len
    }

    /// Number of source samples present before logical zero padding.
    pub fn valid_len(self) -> usize {
        self.samples.len()
    }

    /// Source-backed samples without materialized zero padding.
    pub fn valid_samples(self) -> &'a [f32] {
        self.samples
    }

    /// Read one logical sample, returning zero for the padded tail.
    pub fn sample(self, offset: usize) -> Option<f32> {
        if offset >= self.frame_len {
            None
        } else {
            Some(self.samples.get(offset).copied().unwrap_or(0.0))
        }
    }
}

/// Zero-allocation iterator over borrowed PCM frames.
#[derive(Debug, Clone)]
pub struct PcmFrames<'a> {
    samples: &'a [f32],
    spec: FrameSpec,
    next_start: Option<usize>,
    index: usize,
}

impl<'a> Iterator for PcmFrames<'a> {
    type Item = PcmFrame<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        let start = self.next_start?;
        if start >= self.samples.len() {
            self.next_start = None;
            return None;
        }
        let remaining = self.samples.len() - start;
        if !self.spec.include_partial && remaining < self.spec.frame_len {
            self.next_start = None;
            return None;
        }

        let end = start
            .saturating_add(self.spec.frame_len)
            .min(self.samples.len());
        let frame = PcmFrame {
            index: self.index,
            start_sample: start,
            frame_len: self.spec.frame_len,
            samples: &self.samples[start..end],
        };
        self.index += 1;
        self.next_start = start
            .checked_add(self.spec.hop_len)
            .filter(|next| *next < self.samples.len());
        Some(frame)
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        let Some(start) = self.next_start else {
            return (0, Some(0));
        };
        let remaining = self.samples.len().saturating_sub(start);
        let count = self.spec.frame_count(remaining);
        (count, Some(count))
    }
}

impl ExactSizeIterator for PcmFrames<'_> {}

/// Decode a local audio file to equal-weight mono PCM with scalar Symphonia codecs.
///
/// Decoder errors fail the operation rather than silently dropping packets. All
/// selected Symphonia features are pure Rust and redistributable; SIMD features
/// are disabled so output does not depend on host vector instruction selection.
pub fn decode_audio_file(path: impl AsRef<Path>) -> Result<DecodedAudio> {
    let path = path.as_ref();
    let file = File::open(path)
        .with_context(|| format!("failed to open audio file {}", path.display()))?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }
    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            stream,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .with_context(|| format!("failed to probe audio file {}", path.display()))?;
    let track = format
        .default_track(TrackType::Audio)
        .context("audio file has no decodable audio track")?;
    let track_id = track.id;
    let codec_params = track
        .codec_params
        .as_ref()
        .and_then(|parameters| parameters.audio())
        .context("audio track has no codec parameters")?
        .clone();
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&codec_params, &AudioDecoderOptions::default())
        .context("failed to create audio decoder")?;

    let mut decoded_sample_rate = None;
    let mut decoded_channels = None;
    let mut interleaved = Vec::<f32>::new();
    let mut mono = Vec::<f32>::new();

    while let Some(packet) = format
        .next_packet()
        .with_context(|| format!("failed to read audio packet from {}", path.display()))?
    {
        if packet.track_id != track_id {
            continue;
        }
        let decoded = decoder
            .decode(&packet)
            .with_context(|| format!("failed to decode audio packet from {}", path.display()))?;
        let sample_rate = decoded.spec().rate();
        let channels = decoded.spec().channels().count();
        if sample_rate == 0 || channels == 0 {
            bail!("decoder returned an invalid {sample_rate} Hz/{channels}-channel buffer");
        }
        match decoded_sample_rate {
            Some(expected) if expected != sample_rate => {
                bail!("audio sample rate changed from {expected} to {sample_rate} Hz")
            }
            None => decoded_sample_rate = Some(sample_rate),
            _ => {}
        }
        match decoded_channels {
            Some(expected) if expected != channels => {
                bail!("audio channel count changed from {expected} to {channels}")
            }
            None => decoded_channels = Some(channels),
            _ => {}
        }

        interleaved.resize(decoded.samples_interleaved(), 0.0);
        decoded.copy_to_slice_interleaved(&mut interleaved);
        if !interleaved.len().is_multiple_of(channels) {
            bail!("decoder returned an incomplete interleaved audio frame");
        }
        mono.reserve(interleaved.len() / channels);
        for frame in interleaved.chunks_exact(channels) {
            let sum = frame.iter().try_fold(0.0_f64, |sum, sample| {
                if sample.is_finite() {
                    Ok(sum + f64::from(*sample))
                } else {
                    bail!("decoder returned a non-finite audio sample")
                }
            })?;
            mono.push((sum / channels as f64).clamp(-1.0, 1.0) as f32);
        }
    }

    let sample_rate = decoded_sample_rate.context("audio decoder produced no sample buffers")?;
    let channels = decoded_channels.context("audio decoder produced no channel layout")?;
    let decoded_frames = mono.len();
    Ok(DecodedAudio {
        source: AudioSourceInfo {
            sample_rate,
            channels,
            decoded_frames,
        },
        mono: MonoPcm::new(sample_rate, mono)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linear_resampler_uses_integer_phase_and_rounded_length() {
        let pcm = MonoPcm::new(2, vec![0.0, 1.0, 0.0]).expect("PCM");
        let resampled = pcm.resample_linear(4).expect("resample");
        assert_eq!(resampled.sample_rate(), 4);
        assert_eq!(resampled.samples(), &[0.0, 0.5, 1.0, 0.5, 0.0, 0.0]);

        let restored = resampled.resample_linear(2).expect("downsample");
        assert_eq!(restored.samples(), pcm.samples());
    }

    #[test]
    fn framing_is_zero_allocation_and_tail_padding_is_explicit() {
        let pcm = MonoPcm::new(44_100, vec![0.1, 0.2, 0.3, 0.4, 0.5]).expect("PCM");
        let spec = FrameSpec::new(4, 3, true).expect("frame spec");
        let frames = pcm.frames(spec).collect::<Vec<_>>();
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].valid_samples(), &[0.1, 0.2, 0.3, 0.4]);
        assert_eq!(frames[1].start_sample(), 3);
        assert_eq!(frames[1].valid_samples(), &[0.4, 0.5]);
        assert_eq!(frames[1].sample(2), Some(0.0));
        assert_eq!(frames[1].sample(4), None);
    }

    #[test]
    fn pcm_rejects_invalid_configuration_and_sanitizes_headroom() {
        assert!(MonoPcm::new(0, vec![0.0]).is_err());
        assert!(MonoPcm::new(44_100, vec![f32::NAN]).is_err());
        assert_eq!(
            MonoPcm::new(44_100, vec![-2.0, 2.0])
                .expect("clamped PCM")
                .samples(),
            &[-1.0, 1.0]
        );
    }
}
