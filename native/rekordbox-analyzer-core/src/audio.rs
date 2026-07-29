//! Deterministic, redistributable audio decode and analysis framing.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

use anyhow::{Context, Result, bail};
use symphonia::core::codecs::audio::{AudioDecoderOptions, well_known::CODEC_ID_AAC};
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

use crate::sample_rate_converter::quantize_analysis_pcm;

/// Sample rate used by the Rekordbox 6 analysis primitives.
pub const ANALYSIS_SAMPLE_RATE: u32 = 44_100;

/// Number of detailed waveform columns generated per second.
pub const DETAIL_COLUMNS_PER_SECOND: usize = 150;

/// Samples in one detailed waveform column at [`ANALYSIS_SAMPLE_RATE`].
pub const DETAIL_FRAME_SAMPLES: usize = ANALYSIS_SAMPLE_RATE as usize / DETAIL_COLUMNS_PER_SECOND;

/// Source properties retained after decoding to presented mono PCM.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioSourceInfo {
    sample_rate: u32,
    channels: usize,
    decoded_frames: usize,
    reader_padding_frames: usize,
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

    /// Number of decoded source frames after container priming is discarded.
    pub fn decoded_frames(self) -> usize {
        self.decoded_frames
    }

    /// Zero source frames included in the native reader's advertised length.
    ///
    /// Rekordbox's FLAC reader includes one maximum STREAMINFO block. Other
    /// supported readers do not extend the decoded frame count.
    pub fn reader_padding_frames(self) -> usize {
        self.reader_padding_frames
    }
}

/// A decoded file and its equal-weight mono PCM signal.
#[derive(Debug, Clone, PartialEq)]
pub struct DecodedAudio {
    source: AudioSourceInfo,
    mono: MonoPcm,
    waveform_mono: MonoPcm,
    waveform_midpoint: MonoPcm,
    waveform_stereo: Option<[MonoPcm; 2]>,
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

    /// Native signed-16-bit-quantized mono signal used by waveform analysis.
    pub(crate) fn waveform_mono(&self) -> &MonoPcm {
        &self.waveform_mono
    }

    /// Native signed-16-bit stereo midpoint used by monochrome waveforms.
    pub(crate) fn waveform_midpoint(&self) -> &MonoPcm {
        &self.waveform_midpoint
    }

    /// Unmixed channels retained when the native waveform reader converts rates.
    pub(crate) fn waveform_stereo(&self) -> Option<&[MonoPcm; 2]> {
        self.waveform_stereo.as_ref()
    }

    /// Resample the decoded mono signal to 44.1 kHz.
    pub fn into_analysis_pcm(self) -> Result<MonoPcm> {
        if self.mono.sample_rate == ANALYSIS_SAMPLE_RATE {
            Ok(self.mono)
        } else {
            self.mono.resample_linear(ANALYSIS_SAMPLE_RATE)
        }
    }
}

/// Finite mono PCM samples.
///
/// Public construction clamps into `[-1.0, 1.0]`. The crate-private waveform
/// path may retain Rekordbox's signed-16-bit floor of `-32768 / 32767`.
#[derive(Debug, Clone, PartialEq)]
pub struct MonoPcm {
    sample_rate: u32,
    samples: Vec<f32>,
}

impl MonoPcm {
    /// Validate and construct normalized mono PCM.
    pub fn new(sample_rate: u32, mut samples: Vec<f32>) -> Result<Self> {
        if sample_rate == 0 {
            bail!("mono PCM sample rate must be nonzero");
        }
        for (index, sample) in samples.iter_mut().enumerate() {
            if !sample.is_finite() {
                bail!("mono PCM sample {index} is not finite");
            }
            *sample = sample.clamp(-1.0, 1.0);
        }
        Ok(Self {
            sample_rate,
            samples,
        })
    }

    /// Construct waveform PCM while preserving the signed-16-bit negative floor.
    pub(crate) fn new_native_waveform(sample_rate: u32, samples: Vec<f32>) -> Result<Self> {
        if sample_rate == 0 {
            bail!("mono PCM sample rate must be nonzero");
        }
        for (index, sample) in samples.iter().enumerate() {
            if !sample.is_finite() {
                bail!("mono PCM sample {index} is not finite");
            }
        }
        Ok(Self {
            sample_rate,
            samples,
        })
    }

    /// Signal sample rate in Hertz.
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// Mono samples; waveform-internal PCM may reach `-32768 / 32767`.
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
        let source_step = usize::try_from(self.sample_rate / target_rate)
            .expect("sample-rate quotient fits usize");
        let target_rate_phase = u64::from(target_rate);
        let remainder_step = u64::from(self.sample_rate % target_rate);
        let mut source_position = 0usize;
        let mut remainder = 0u64;

        for _ in 0..output_len {
            let source_index = source_position.min(last_index);
            let next_index = source_index.saturating_add(1).min(last_index);
            let fraction = remainder as f64 / f64::from(target_rate);
            let left = f64::from(self.samples[source_index]);
            let right = f64::from(self.samples[next_index]);
            output.push((left + (right - left) * fraction) as f32);

            source_position += source_step;
            remainder += remainder_step;
            if remainder >= target_rate_phase {
                remainder -= target_rate_phase;
                source_position += 1;
            }
        }

        Ok(Self {
            sample_rate: target_rate,
            samples: output,
        })
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

// Core Audio's AAC-LC decoder contributes 512 frames of transform delay on
// top of an ISO BMFF edit-list media start. Apple documents the resulting
// common AAC priming total as 2,112 frames:
// <https://developer.apple.com/documentation/audiotoolbox/audiofilepackettableinfo>.
const CORE_AUDIO_AAC_DECODER_DELAY_FRAMES: u64 = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct IsoBox {
    kind: [u8; 4],
    payload_start: u64,
    end: u64,
}

fn dash_aac_priming_frames(path: &Path, track_id: u32) -> Option<usize> {
    // Symphonia 0.6 does not project fragmented DASH edit lists into packet
    // trims. Keep this brand-specific: ordinary M4A edit-list media times use
    // different backend semantics and already align without this adjustment.
    let mut file = File::open(path).ok()?;
    let file_len = file.metadata().ok()?.len();
    let media_time = dash_edit_media_time(&mut file, file_len, track_id)
        .ok()
        .flatten()?;
    usize::try_from(media_time.checked_add(CORE_AUDIO_AAC_DECODER_DELAY_FRAMES)?).ok()
}

fn dash_edit_media_time(
    reader: &mut (impl Read + Seek),
    file_len: u64,
    track_id: u32,
) -> io::Result<Option<u64>> {
    let mut cursor = 0;
    let mut is_dash = false;
    let mut moov = None;
    while let Some(atom) = next_iso_box(reader, &mut cursor, file_len)? {
        match &atom.kind {
            b"ftyp" => {
                is_dash = read_fourcc(reader, atom.payload_start, atom.end)? == Some(*b"dash");
            }
            b"moov" => moov = Some(atom),
            _ => {}
        }
    }
    if !is_dash {
        return Ok(None);
    }

    let Some(moov) = moov else {
        return Ok(None);
    };
    let mut cursor = moov.payload_start;
    while let Some(atom) = next_iso_box(reader, &mut cursor, moov.end)? {
        if atom.kind != *b"trak" || track_id_from_trak(reader, atom)? != Some(track_id) {
            continue;
        }
        return edit_media_time_from_trak(reader, atom);
    }
    Ok(None)
}

fn track_id_from_trak(reader: &mut (impl Read + Seek), trak: IsoBox) -> io::Result<Option<u32>> {
    let mut cursor = trak.payload_start;
    while let Some(atom) = next_iso_box(reader, &mut cursor, trak.end)? {
        if atom.kind != *b"tkhd" {
            continue;
        }
        let Some(version) = read_u8(reader, atom.payload_start, atom.end)? else {
            return Ok(None);
        };
        let offset = match version {
            0 => 12,
            1 => 20,
            _ => return Ok(None),
        };
        let offset = atom
            .payload_start
            .checked_add(offset)
            .ok_or_else(|| invalid_bmff("tkhd track ID offset overflow"))?;
        return read_u32(reader, offset, atom.end);
    }
    Ok(None)
}

fn edit_media_time_from_trak(
    reader: &mut (impl Read + Seek),
    trak: IsoBox,
) -> io::Result<Option<u64>> {
    let mut cursor = trak.payload_start;
    while let Some(atom) = next_iso_box(reader, &mut cursor, trak.end)? {
        if atom.kind != *b"edts" {
            continue;
        }
        let mut edit_cursor = atom.payload_start;
        while let Some(edit) = next_iso_box(reader, &mut edit_cursor, atom.end)? {
            if edit.kind == *b"elst" {
                return positive_media_time_from_elst(reader, edit);
            }
        }
    }
    Ok(None)
}

fn positive_media_time_from_elst(
    reader: &mut (impl Read + Seek),
    elst: IsoBox,
) -> io::Result<Option<u64>> {
    let Some(version) = read_u8(reader, elst.payload_start, elst.end)? else {
        return Ok(None);
    };
    let entry_count_offset = elst
        .payload_start
        .checked_add(4)
        .ok_or_else(|| invalid_bmff("elst entry count offset overflow"))?;
    let Some(entry_count) = read_u32(reader, entry_count_offset, elst.end)? else {
        return Ok(None);
    };
    let (entry_size, media_time_offset) = match version {
        0 => (12_u64, 4_u64),
        1 => (20_u64, 8_u64),
        _ => return Ok(None),
    };
    let entries_start = elst
        .payload_start
        .checked_add(8)
        .ok_or_else(|| invalid_bmff("elst entry offset overflow"))?;
    let entries_size = u64::from(entry_count)
        .checked_mul(entry_size)
        .ok_or_else(|| invalid_bmff("elst entry count overflow"))?;
    if entries_start
        .checked_add(entries_size)
        .is_none_or(|end| end > elst.end)
    {
        return Err(invalid_bmff("elst entries exceed their box"));
    }

    for index in 0..u64::from(entry_count) {
        let entry_start = entries_start + index * entry_size;
        let offset = entry_start
            .checked_add(media_time_offset)
            .ok_or_else(|| invalid_bmff("elst media time offset overflow"))?;
        let media_time = match version {
            0 => i64::from(read_i32(reader, offset, elst.end)?.expect("validated elst entry")),
            1 => read_i64(reader, offset, elst.end)?.expect("validated elst entry"),
            _ => unreachable!(),
        };
        if media_time > 0 {
            return Ok(Some(media_time as u64));
        }
    }
    Ok(None)
}

fn next_iso_box(
    reader: &mut (impl Read + Seek),
    cursor: &mut u64,
    parent_end: u64,
) -> io::Result<Option<IsoBox>> {
    if *cursor == parent_end {
        return Ok(None);
    }
    if *cursor > parent_end || parent_end - *cursor < 8 {
        return Err(invalid_bmff("incomplete ISO BMFF box header"));
    }

    reader.seek(SeekFrom::Start(*cursor))?;
    let mut header = [0_u8; 8];
    reader.read_exact(&mut header)?;
    let size32 = u32::from_be_bytes(header[..4].try_into().expect("four bytes"));
    let kind = header[4..].try_into().expect("four bytes");
    let mut header_len = 8_u64;
    let size = match size32 {
        0 => parent_end - *cursor,
        1 => {
            if parent_end - *cursor < 16 {
                return Err(invalid_bmff("incomplete extended ISO BMFF box header"));
            }
            let mut extended = [0_u8; 8];
            reader.read_exact(&mut extended)?;
            header_len = 16;
            u64::from_be_bytes(extended)
        }
        size => u64::from(size),
    };
    if kind == *b"uuid" {
        header_len = header_len
            .checked_add(16)
            .ok_or_else(|| invalid_bmff("UUID box header overflow"))?;
    }
    if size < header_len {
        return Err(invalid_bmff("ISO BMFF box is shorter than its header"));
    }
    let end = cursor
        .checked_add(size)
        .ok_or_else(|| invalid_bmff("ISO BMFF box size overflow"))?;
    if end > parent_end {
        return Err(invalid_bmff("ISO BMFF box exceeds its parent"));
    }
    let payload_start = cursor
        .checked_add(header_len)
        .ok_or_else(|| invalid_bmff("ISO BMFF payload offset overflow"))?;
    *cursor = end;
    Ok(Some(IsoBox {
        kind,
        payload_start,
        end,
    }))
}

fn read_fourcc(
    reader: &mut (impl Read + Seek),
    offset: u64,
    end: u64,
) -> io::Result<Option<[u8; 4]>> {
    read_array::<4>(reader, offset, end)
}

fn read_u8(reader: &mut (impl Read + Seek), offset: u64, end: u64) -> io::Result<Option<u8>> {
    Ok(read_array::<1>(reader, offset, end)?.map(|bytes| bytes[0]))
}

fn read_u32(reader: &mut (impl Read + Seek), offset: u64, end: u64) -> io::Result<Option<u32>> {
    Ok(read_array::<4>(reader, offset, end)?.map(u32::from_be_bytes))
}

fn read_i32(reader: &mut (impl Read + Seek), offset: u64, end: u64) -> io::Result<Option<i32>> {
    Ok(read_array::<4>(reader, offset, end)?.map(i32::from_be_bytes))
}

fn read_i64(reader: &mut (impl Read + Seek), offset: u64, end: u64) -> io::Result<Option<i64>> {
    Ok(read_array::<8>(reader, offset, end)?.map(i64::from_be_bytes))
}

fn read_array<const N: usize>(
    reader: &mut (impl Read + Seek),
    offset: u64,
    end: u64,
) -> io::Result<Option<[u8; N]>> {
    if offset.checked_add(N as u64).is_none_or(|value| value > end) {
        return Ok(None);
    }
    reader.seek(SeekFrom::Start(offset))?;
    let mut bytes = [0_u8; N];
    reader.read_exact(&mut bytes)?;
    Ok(Some(bytes))
}

fn invalid_bmff(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn native_reader_padding_frames(reader: &mut (impl Read + Seek)) -> io::Result<usize> {
    reader.seek(SeekFrom::Start(0))?;
    let mut prefix = [0_u8; 12];
    let padding = match reader.read_exact(&mut prefix) {
        Ok(()) => flac_reader_padding_from_prefix(prefix).unwrap_or_default(),
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => 0,
        Err(error) => return Err(error),
    };
    reader.seek(SeekFrom::Start(0))?;
    Ok(padding)
}

fn flac_reader_padding_from_prefix(prefix: [u8; 12]) -> Option<usize> {
    if prefix[..4] != *b"fLaC" || prefix[4] & 0x7f != 0 {
        return None;
    }
    let metadata_len = u32::from_be_bytes([0, prefix[5], prefix[6], prefix[7]]);
    if metadata_len != 34 {
        return None;
    }
    let min_block_samples = u16::from_be_bytes([prefix[8], prefix[9]]);
    let max_block_samples = u16::from_be_bytes([prefix[10], prefix[11]]);
    if min_block_samples < 16 || max_block_samples < min_block_samples {
        return None;
    }
    Some(usize::from(max_block_samples))
}

fn trim_leading_interleaved_frames<'a>(
    interleaved: &'a [f32],
    channels: usize,
    remaining_trim_frames: &mut usize,
) -> &'a [f32] {
    let trim_frames = (*remaining_trim_frames).min(interleaved.len() / channels);
    *remaining_trim_frames -= trim_frames;
    &interleaved[trim_frames * channels..]
}

/// Mix two `/ 32768`-normalized, signed-16-bit-quantized waveform channels.
pub(crate) fn native_waveform_mono_pair(left: f32, right: f32) -> f32 {
    let scale = 32_768.0 / 32_767.0;
    let left = f64::from(left) * scale;
    let right = f64::from(right) * scale;
    let difference = (left.abs() - right.abs()).abs();
    let mixed = if difference < 0.001 {
        if right.abs() < left.abs() {
            left
        } else {
            right
        }
    } else {
        (left + right) * 0.5
    };
    // Rekordbox scales signed 16-bit PCM by 1 / 32767 without clipping, so
    // -32768 intentionally survives as roughly -1.00003.
    mixed as f32
}

/// Average two signed-16-bit-quantized waveform channels with native truncation.
pub(crate) fn native_waveform_midpoint_pair(left: f32, right: f32) -> f32 {
    let left = (left * 32_768.0).trunc() as i16;
    let right = (right * 32_768.0).trunc() as i16;
    let midpoint = ((f64::from(left) + f64::from(right)) * 0.5).trunc() as i16;
    f32::from(midpoint) / 32_768.0
}

fn native_waveform_mono_sample(frame: &[f32]) -> f32 {
    native_waveform_mono_pair(
        quantize_analysis_pcm(frame[0]),
        quantize_analysis_pcm(*frame.get(1).unwrap_or(&frame[0])),
    )
}

fn native_waveform_midpoint_sample(frame: &[f32]) -> f32 {
    native_waveform_midpoint_pair(
        quantize_analysis_pcm(frame[0]),
        quantize_analysis_pcm(*frame.get(1).unwrap_or(&frame[0])),
    )
}

/// Decode a local audio file to equal-weight mono PCM with Symphonia codecs.
///
/// Decoder errors fail the operation rather than silently dropping packets. All
/// selected Symphonia features are pure Rust and redistributable. Architecture-
/// appropriate SIMD kernels accelerate codec transforms.
pub fn decode_audio_file(path: impl AsRef<Path>) -> Result<DecodedAudio> {
    decode_audio_file_with_progress(path, usize::MAX, |_, _, _, _, _, _| Ok(()))
}

pub(crate) fn decode_audio_file_with_progress(
    path: impl AsRef<Path>,
    progress_interval_frames: usize,
    mut progress: impl FnMut(u32, &[f32], &[f32], &[f32], bool, usize) -> Result<()>,
) -> Result<DecodedAudio> {
    if progress_interval_frames == 0 {
        bail!("decode progress interval must be nonzero");
    }
    let path = path.as_ref();
    let mut file = File::open(path)
        .with_context(|| format!("failed to open audio file {}", path.display()))?;
    let reader_padding_frames = native_reader_padding_frames(&mut file)
        .with_context(|| format!("failed to inspect audio file {}", path.display()))?;
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
    let expected_frames = track
        .num_frames
        .and_then(|frames| usize::try_from(frames).ok())
        .unwrap_or_default();
    let mut remaining_leading_trim = if codec_params.codec == CODEC_ID_AAC {
        dash_aac_priming_frames(path, track_id).unwrap_or_default()
    } else {
        0
    };
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&codec_params, &AudioDecoderOptions::default())
        .context("failed to create audio decoder")?;

    let mut decoded_sample_rate = None;
    let mut decoded_channels = None;
    let mut interleaved = Vec::<f32>::new();
    let mut mono = Vec::<f32>::with_capacity(expected_frames);
    let mut waveform_mono = Vec::<f32>::with_capacity(expected_frames);
    let mut waveform_midpoint = Vec::<f32>::with_capacity(expected_frames);
    let mut waveform_stereo = None::<[Vec<f32>; 2]>;
    let mut next_progress = progress_interval_frames;

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
        if waveform_stereo.is_none() && !matches!(sample_rate, 44_100 | 48_000) {
            waveform_stereo = Some([
                Vec::with_capacity(expected_frames),
                Vec::with_capacity(expected_frames),
            ]);
        }

        interleaved.resize(decoded.samples_interleaved(), 0.0);
        decoded.copy_to_slice_interleaved(&mut interleaved);
        if !interleaved.len().is_multiple_of(channels) {
            bail!("decoder returned an incomplete interleaved audio frame");
        }
        let presented =
            trim_leading_interleaved_frames(&interleaved, channels, &mut remaining_leading_trim);
        mono.reserve(presented.len() / channels);
        for frame in presented.chunks_exact(channels) {
            let sum = frame.iter().try_fold(0.0_f64, |sum, sample| {
                if sample.is_finite() {
                    Ok(sum + f64::from(*sample))
                } else {
                    bail!("decoder returned a non-finite audio sample")
                }
            })?;
            mono.push((sum / channels as f64).clamp(-1.0, 1.0) as f32);
            waveform_mono.push(native_waveform_mono_sample(frame));
            waveform_midpoint.push(native_waveform_midpoint_sample(frame));
            if let Some([left, right]) = waveform_stereo.as_mut() {
                left.push(frame[0]);
                right.push(*frame.get(1).unwrap_or(&frame[0]));
            }
        }
        if mono.len() >= next_progress {
            progress(
                sample_rate,
                &mono,
                &waveform_mono,
                &waveform_midpoint,
                false,
                reader_padding_frames,
            )?;
            next_progress = mono.len().saturating_add(progress_interval_frames);
        }
    }

    let sample_rate = decoded_sample_rate.context("audio decoder produced no sample buffers")?;
    let channels = decoded_channels.context("audio decoder produced no channel layout")?;
    if remaining_leading_trim != 0 {
        bail!("AAC priming exceeds decoded audio by {remaining_leading_trim} source frames");
    }
    progress(
        sample_rate,
        &mono,
        &waveform_mono,
        &waveform_midpoint,
        true,
        reader_padding_frames,
    )?;
    let decoded_frames = mono.len();
    Ok(DecodedAudio {
        source: AudioSourceInfo {
            sample_rate,
            channels,
            decoded_frames,
            reader_padding_frames,
        },
        // Every decoded sample was checked and clamped while mixing above.
        mono: MonoPcm {
            sample_rate,
            samples: mono,
        },
        waveform_mono: MonoPcm {
            sample_rate,
            samples: waveform_mono,
        },
        waveform_midpoint: MonoPcm {
            sample_rate,
            samples: waveform_midpoint,
        },
        waveform_stereo: waveform_stereo.map(|[left, right]| {
            [
                MonoPcm {
                    sample_rate,
                    samples: left,
                },
                MonoPcm {
                    sample_rate,
                    samples: right,
                },
            ]
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flac_reader_padding_is_streaminfo_maximum_block_size() {
        let mut prefix = [0_u8; 12];
        prefix[..4].copy_from_slice(b"fLaC");
        prefix[4] = 0;
        prefix[7] = 34;
        prefix[8..10].copy_from_slice(&1_024_u16.to_be_bytes());
        prefix[10..12].copy_from_slice(&4_096_u16.to_be_bytes());

        assert_eq!(flac_reader_padding_from_prefix(prefix), Some(4_096));
    }

    #[test]
    fn non_flac_reader_has_no_advertised_padding() {
        assert_eq!(flac_reader_padding_from_prefix([0_u8; 12]), None);
    }

    #[test]
    fn invalid_flac_block_range_has_no_advertised_padding() {
        let mut prefix = [0_u8; 12];
        prefix[..4].copy_from_slice(b"fLaC");
        prefix[7] = 34;
        prefix[8..10].copy_from_slice(&4_096_u16.to_be_bytes());
        prefix[10..12].copy_from_slice(&1_024_u16.to_be_bytes());

        assert_eq!(flac_reader_padding_from_prefix(prefix), None);
    }

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
    fn linear_resampler_phase_accumulator_is_reference_bit_exact() {
        let samples = (0..1_003)
            .map(|index| {
                let phase = std::f32::consts::TAU * index as f32 / 1_003.0;
                0.61 * (phase * 17.0).sin() + 0.29 * (phase * 113.0).sin()
            })
            .collect::<Vec<_>>();
        for (source_rate, target_rate) in [
            (32_000, 44_100),
            (44_100, 48_000),
            (48_000, 44_100),
            (88_200, 44_100),
            (96_000, 44_100),
            (u32::MAX - 1, u32::MAX),
        ] {
            let actual = MonoPcm::new(source_rate, samples.clone())
                .expect("PCM")
                .resample_linear(target_rate)
                .expect("resample");
            let output_len = (samples.len() as u128 * u128::from(target_rate)
                + u128::from(source_rate) / 2)
                / u128::from(source_rate);
            let expected = (0..usize::try_from(output_len).unwrap())
                .map(|output_index| {
                    let phase = output_index as u128 * u128::from(source_rate);
                    let source_index = usize::try_from(phase / u128::from(target_rate))
                        .unwrap()
                        .min(samples.len() - 1);
                    let next_index = (source_index + 1).min(samples.len() - 1);
                    let fraction =
                        (phase % u128::from(target_rate)) as f64 / f64::from(target_rate);
                    let left = f64::from(samples[source_index]);
                    let right = f64::from(samples[next_index]);
                    (left + (right - left) * fraction) as f32
                })
                .collect::<Vec<_>>();
            assert_eq!(
                actual
                    .samples()
                    .iter()
                    .map(|value| value.to_bits())
                    .collect::<Vec<_>>(),
                expected
                    .iter()
                    .map(|value| value.to_bits())
                    .collect::<Vec<_>>()
            );
        }
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

    #[test]
    fn native_waveform_pcm_retains_signed_sixteen_bit_floor() {
        let floor = -32_768.0_f32 / 32_767.0;
        let pcm = MonoPcm::new_native_waveform(44_100, vec![floor]).expect("native waveform PCM");
        assert_eq!(pcm.samples()[0].to_bits(), floor.to_bits());
        assert!(pcm.samples()[0] < -1.0);
    }

    #[test]
    fn native_waveform_mixer_preserves_nearly_equal_dominant_channel() {
        let left = -32_767.0_f32 / 32_768.0;
        let right = -1.0_f32;
        let mixed = native_waveform_mono_sample(&[left, right]);
        assert_eq!(mixed.to_bits(), (-32_768.0_f32 / 32_767.0).to_bits());
        assert!(mixed < -1.0);
    }

    #[test]
    fn native_waveform_mixer_averages_materially_different_channels() {
        let mixed = native_waveform_mono_sample(&[0.75, -0.25]);
        let scale = 32_768.0_f64 / 32_767.0;
        let expected = ((0.75_f64 - 0.25) * 0.5 * scale) as f32;
        assert_eq!(mixed.to_bits(), expected.to_bits());
    }

    #[test]
    fn native_waveform_mixer_quantizes_each_channel_before_mixing() {
        let below_one_lsb = 0.5_f32 / 32_768.0;
        assert_eq!(
            native_waveform_mono_sample(&[below_one_lsb, 0.0]).to_bits(),
            0.0_f32.to_bits()
        );
    }

    #[test]
    fn native_waveform_midpoint_averages_signed_sixteen_bit_channels() {
        assert_eq!(
            native_waveform_midpoint_pair(0.75, -0.25).to_bits(),
            0.25_f32.to_bits()
        );
        assert_eq!(
            native_waveform_midpoint_pair(1.0, -1.0).to_bits(),
            0.0_f32.to_bits()
        );
    }

    #[test]
    fn dash_aac_edit_list_recovers_core_audio_priming() {
        let mut tkhd = vec![0; 16];
        tkhd[12..16].copy_from_slice(&7_u32.to_be_bytes());
        let mut elst = vec![0; 20];
        elst[4..8].copy_from_slice(&1_u32.to_be_bytes());
        elst[8..12].copy_from_slice(&16_726_836_u32.to_be_bytes());
        elst[12..16].copy_from_slice(&1_600_i32.to_be_bytes());
        elst[16..18].copy_from_slice(&1_i16.to_be_bytes());

        let trak = iso_box(
            *b"trak",
            [
                iso_box(*b"tkhd", tkhd),
                iso_box(*b"edts", iso_box(*b"elst", elst)),
            ]
            .concat(),
        );
        let bytes = [
            iso_box(
                *b"ftyp",
                [b"dash".as_slice(), &[0; 4], b"iso6mp41"].concat(),
            ),
            iso_box(*b"moov", trak),
        ]
        .concat();
        let mut cursor = std::io::Cursor::new(&bytes);

        let media_time = dash_edit_media_time(&mut cursor, bytes.len() as u64, 7).unwrap();

        assert_eq!(media_time, Some(1_600));
        assert_eq!(
            media_time
                .unwrap()
                .checked_add(CORE_AUDIO_AAC_DECODER_DELAY_FRAMES),
            Some(2_112)
        );
    }

    #[test]
    fn ordinary_m4a_edit_list_does_not_enable_dash_priming() {
        let mut tkhd = vec![0; 16];
        tkhd[12..16].copy_from_slice(&1_u32.to_be_bytes());
        let mut elst = vec![0; 20];
        elst[4..8].copy_from_slice(&1_u32.to_be_bytes());
        elst[8..12].copy_from_slice(&4_096_u32.to_be_bytes());
        elst[12..16].copy_from_slice(&1_600_i32.to_be_bytes());
        let trak = iso_box(
            *b"trak",
            [
                iso_box(*b"tkhd", tkhd),
                iso_box(*b"edts", iso_box(*b"elst", elst)),
            ]
            .concat(),
        );
        let bytes = [
            iso_box(*b"ftyp", [b"M4A ".as_slice(), &[0; 4], b"isom"].concat()),
            iso_box(*b"moov", trak),
        ]
        .concat();
        let mut cursor = std::io::Cursor::new(&bytes);

        assert_eq!(
            dash_edit_media_time(&mut cursor, bytes.len() as u64, 1).unwrap(),
            None
        );
    }

    #[test]
    fn leading_frame_trim_spans_decoder_packets_without_splitting_channels() {
        let mut remaining = 5;
        let first = trim_leading_interleaved_frames(&[1.0; 6], 2, &mut remaining);
        assert!(first.is_empty());
        assert_eq!(remaining, 2);

        let second =
            trim_leading_interleaved_frames(&[2.0, 3.0, 4.0, 5.0, 6.0, 7.0], 2, &mut remaining);
        assert_eq!(second, &[6.0, 7.0]);
        assert_eq!(remaining, 0);
    }

    #[test]
    fn malformed_iso_box_fails_closed() {
        let bytes = [0, 0, 0, 4, b'f', b't', b'y', b'p'];
        let mut cursor = std::io::Cursor::new(bytes);
        assert!(dash_edit_media_time(&mut cursor, bytes.len() as u64, 1).is_err());
    }

    fn iso_box(kind: [u8; 4], payload: impl AsRef<[u8]>) -> Vec<u8> {
        let payload = payload.as_ref();
        let size = u32::try_from(payload.len() + 8).unwrap();
        [size.to_be_bytes().as_slice(), &kind, payload].concat()
    }
}
