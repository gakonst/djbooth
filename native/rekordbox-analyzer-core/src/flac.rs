//! Native FLAC frame indexing for Rekordbox's `PVB2` seek table.
//!
//! The parser follows RFC 9639's metadata and frame-header shapes. It does not
//! decode audio or trust byte-aligned sync words alone: every frame header and
//! payload must pass CRC-8/CRC-16, and coded frame/sample numbers must form one
//! continuous stream.

use anyhow::{Context, Result, bail};

use crate::anlz::{AnlzTag, PVB2_ENTRY_COUNT, Pvb2Entry, Pvb2Table};

const FLAC_SIGNATURE: &[u8; 4] = b"fLaC";
const STREAMINFO_LEN: usize = 34;
const FLAC_CRC16_TABLES: [[u16; 256]; 8] = flac_crc16_tables();

/// One validated FLAC audio-frame location.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FlacFrame {
    /// First interchannel sample represented by this frame.
    pub sample_index: u64,
    /// Frame-header byte offset relative to the first audio frame.
    pub byte_offset: u64,
    /// Interchannel samples represented by this frame.
    pub block_samples: u32,
}

/// A validated, continuous index of every frame in one native FLAC stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlacFrameIndex {
    /// Total interchannel samples from STREAMINFO.
    pub total_samples: u64,
    /// Absolute byte offset of the first audio frame.
    pub first_audio_offset: u64,
    /// Frame locations in strictly increasing sample and byte order.
    pub frames: Vec<FlacFrame>,
}

#[derive(Debug, Clone, Copy)]
struct StreamInfo {
    min_block_samples: u32,
    max_block_samples: u32,
    sample_rate: u32,
    channels: u8,
    bits_per_sample: u8,
    total_samples: u64,
    first_audio_offset: usize,
}

#[derive(Debug, Clone, Copy)]
struct FrameHeader {
    variable_block_size: bool,
    coded_number: u64,
    block_samples: u32,
    header_len: usize,
}

/// Parse and validate a native FLAC stream's complete frame-header chain.
pub fn parse_flac_frame_index(data: &[u8]) -> Result<FlacFrameIndex> {
    let stream = parse_stream_info(data)?;
    let first = parse_frame_header(data, stream.first_audio_offset, stream)
        .context("FLAC first audio frame has an invalid header")?;
    if first.coded_number != 0 {
        bail!(
            "FLAC first audio frame starts at coded number {} instead of zero",
            first.coded_number
        );
    }

    let mut frames = Vec::new();
    let mut absolute_offset = stream.first_audio_offset;
    let mut next_sample = 0_u64;
    let mut header = first;
    let fixed_block_samples = (!first.variable_block_size).then_some(first.block_samples);

    loop {
        validate_frame_block(stream, next_sample, header.block_samples)?;
        frames.push(FlacFrame {
            sample_index: next_sample,
            byte_offset: u64::try_from(
                absolute_offset
                    .checked_sub(stream.first_audio_offset)
                    .context("FLAC frame precedes its audio-data origin")?,
            )
            .context("FLAC relative frame offset exceeds 64 bits")?,
            block_samples: header.block_samples,
        });
        next_sample = next_sample
            .checked_add(u64::from(header.block_samples))
            .context("FLAC cumulative sample count overflow")?;
        if next_sample == stream.total_samples {
            if !frame_crc16_is_valid(data, absolute_offset, data.len()) {
                bail!("FLAC final audio frame has an invalid CRC-16");
            }
            break;
        }

        let expected_number = if first.variable_block_size {
            next_sample
        } else {
            u64::try_from(frames.len()).context("FLAC frame count exceeds 64 bits")?
        };
        let search_start = absolute_offset
            .checked_add(header.header_len)
            .and_then(|offset| offset.checked_add(2))
            .context("FLAC frame-header offset overflow")?;
        let mut found = None;
        for candidate_offset in search_start..data.len().saturating_sub(5) {
            if data[candidate_offset] != 0xff {
                continue;
            }
            let Some(candidate) = parse_frame_header(data, candidate_offset, stream) else {
                continue;
            };
            if candidate.variable_block_size != first.variable_block_size
                || candidate.coded_number != expected_number
            {
                continue;
            }
            if fixed_block_samples.is_some_and(|block| {
                candidate.block_samples != block
                    && next_sample + u64::from(candidate.block_samples) != stream.total_samples
            }) {
                continue;
            }
            if validate_frame_block(stream, next_sample, candidate.block_samples).is_err() {
                continue;
            }
            if !frame_crc16_is_valid(data, absolute_offset, candidate_offset) {
                continue;
            }
            found = Some((candidate_offset, candidate));
            break;
        }
        let (next_offset, next_header) = found.with_context(|| {
            format!(
                "FLAC frame chain ended at sample {next_sample} of {}",
                stream.total_samples
            )
        })?;
        absolute_offset = next_offset;
        header = next_header;
    }

    Ok(FlacFrameIndex {
        total_samples: stream.total_samples,
        first_audio_offset: u64::try_from(stream.first_audio_offset)
            .context("FLAC audio-data offset exceeds 64 bits")?,
        frames,
    })
}

/// Build the canonical 400-entry Rekordbox `PVB2` tag from native FLAC bytes.
pub fn build_flac_pvb2(data: &[u8]) -> Result<AnlzTag> {
    let index = parse_flac_frame_index(data)?;
    let total_samples = u32::try_from(index.total_samples)
        .context("FLAC sample count exceeds the PVB2 u32 field")?;
    let step = index.total_samples / PVB2_ENTRY_COUNT as u64;
    let mut frame_index = 0_usize;
    let mut entries = Vec::with_capacity(PVB2_ENTRY_COUNT);
    for entry_index in 0..PVB2_ENTRY_COUNT {
        let target = u64::try_from(entry_index)
            .expect("400-entry index fits u64")
            .checked_mul(step)
            .context("PVB2 target-sample overflow")?;
        while frame_index + 1 < index.frames.len()
            && index.frames[frame_index + 1].sample_index <= target
        {
            frame_index += 1;
        }
        let frame = index.frames[frame_index];
        entries.push(Pvb2Entry {
            sample_index: frame.sample_index,
            byte_offset: frame.byte_offset,
            frame_block_samples: frame.block_samples,
        });
    }
    Pvb2Table {
        total_samples,
        entries,
    }
    .to_tag()
}

fn parse_stream_info(data: &[u8]) -> Result<StreamInfo> {
    if data.get(..4) != Some(FLAC_SIGNATURE) {
        bail!("input is not a native FLAC stream");
    }
    let mut offset = FLAC_SIGNATURE.len();
    let mut block_index = 0_usize;
    let mut stream_fields = None;
    loop {
        let header = data
            .get(offset..offset + 4)
            .with_context(|| format!("truncated FLAC metadata header at byte {offset}"))?;
        let is_last = header[0] & 0x80 != 0;
        let block_type = header[0] & 0x7f;
        if block_type == 127 {
            bail!("FLAC metadata block {block_index} uses the invalid type 127");
        }
        let block_len =
            usize::from(header[1]) << 16 | usize::from(header[2]) << 8 | usize::from(header[3]);
        let payload_start = offset
            .checked_add(4)
            .context("FLAC metadata offset overflow")?;
        let payload_end = payload_start
            .checked_add(block_len)
            .context("FLAC metadata length overflow")?;
        let payload = data
            .get(payload_start..payload_end)
            .with_context(|| format!("FLAC metadata block {block_index} is truncated"))?;

        if block_index == 0 {
            if block_type != 0 || block_len != STREAMINFO_LEN {
                bail!("FLAC first metadata block is not 34-byte STREAMINFO");
            }
            let min_block_samples = u32::from(u16::from_be_bytes([payload[0], payload[1]]));
            let max_block_samples = u32::from(u16::from_be_bytes([payload[2], payload[3]]));
            if min_block_samples < 16
                || max_block_samples < min_block_samples
                || max_block_samples == 0
            {
                bail!(
                    "FLAC STREAMINFO has invalid block range \
                     {min_block_samples}..={max_block_samples}"
                );
            }
            let packed = u64::from_be_bytes(
                payload[10..18]
                    .try_into()
                    .expect("STREAMINFO packed field is eight bytes"),
            );
            let sample_rate = ((packed >> 44) & 0x000f_ffff) as u32;
            let channels = (((packed >> 41) & 0x7) + 1) as u8;
            let bits_per_sample = (((packed >> 36) & 0x1f) + 1) as u8;
            let total_samples = packed & 0x0000_000f_ffff_ffff;
            if sample_rate == 0 || !(4..=32).contains(&bits_per_sample) || total_samples == 0 {
                bail!("FLAC STREAMINFO has unsupported audio properties");
            }
            stream_fields = Some((
                min_block_samples,
                max_block_samples,
                sample_rate,
                channels,
                bits_per_sample,
                total_samples,
            ));
        } else if block_type == 0 {
            bail!("FLAC contains a second STREAMINFO block");
        }

        offset = payload_end;
        block_index += 1;
        if is_last {
            break;
        }
    }
    if offset >= data.len() {
        bail!("FLAC contains no audio frames");
    }
    let (
        min_block_samples,
        max_block_samples,
        sample_rate,
        channels,
        bits_per_sample,
        total_samples,
    ) = stream_fields.context("FLAC is missing STREAMINFO")?;
    Ok(StreamInfo {
        min_block_samples,
        max_block_samples,
        sample_rate,
        channels,
        bits_per_sample,
        total_samples,
        first_audio_offset: offset,
    })
}

fn validate_frame_block(stream: StreamInfo, sample_index: u64, block_samples: u32) -> Result<()> {
    let end_sample = sample_index
        .checked_add(u64::from(block_samples))
        .context("FLAC frame sample range overflow")?;
    if block_samples == 0
        || block_samples > stream.max_block_samples
        || end_sample > stream.total_samples
        || (block_samples < stream.min_block_samples && end_sample != stream.total_samples)
    {
        bail!("FLAC frame at sample {sample_index} has invalid {block_samples}-sample block");
    }
    Ok(())
}

fn parse_frame_header(data: &[u8], offset: usize, stream: StreamInfo) -> Option<FrameHeader> {
    let fixed = data.get(offset..offset.checked_add(4)?)?;
    if fixed[0] != 0xff || fixed[1] & 0xfe != 0xf8 || fixed[3] & 1 != 0 {
        return None;
    }
    let variable_block_size = fixed[1] & 1 != 0;
    let block_code = fixed[2] >> 4;
    let sample_rate_code = fixed[2] & 0x0f;
    let channel_code = fixed[3] >> 4;
    let bits_code = (fixed[3] >> 1) & 0x07;
    if block_code == 0 || sample_rate_code == 15 || channel_code > 10 {
        return None;
    }

    let channels = if channel_code <= 7 {
        channel_code + 1
    } else {
        2
    };
    let bits_per_sample = match bits_code {
        0 => stream.bits_per_sample,
        1 => 8,
        2 => 12,
        4 => 16,
        5 => 20,
        6 => 24,
        7 => 32,
        _ => return None,
    };
    if channels != stream.channels || bits_per_sample != stream.bits_per_sample {
        return None;
    }

    let mut cursor = offset.checked_add(4)?;
    let (coded_number, coded_len) = decode_coded_number(data.get(cursor..)?)?;
    cursor = cursor.checked_add(coded_len)?;
    if (!variable_block_size && coded_number > 0x7fff_ffff)
        || (variable_block_size && coded_number > 0x000f_ffff_ffff)
    {
        return None;
    }

    let block_samples = match block_code {
        1 => 192,
        2..=5 => 144_u32.checked_shl(u32::from(block_code))?,
        6 => {
            let value = u32::from(*data.get(cursor)?);
            cursor = cursor.checked_add(1)?;
            value + 1
        }
        7 => {
            let value = u16::from_be_bytes([*data.get(cursor)?, *data.get(cursor + 1)?]);
            if value == u16::MAX {
                return None;
            }
            cursor = cursor.checked_add(2)?;
            u32::from(value) + 1
        }
        8..=15 => 1_u32.checked_shl(u32::from(block_code))?,
        _ => return None,
    };

    let sample_rate = match sample_rate_code {
        0 => stream.sample_rate,
        1 => 88_200,
        2 => 176_400,
        3 => 192_000,
        4 => 8_000,
        5 => 16_000,
        6 => 22_050,
        7 => 24_000,
        8 => 32_000,
        9 => 44_100,
        10 => 48_000,
        11 => 96_000,
        12 => {
            let value = u32::from(*data.get(cursor)?);
            cursor = cursor.checked_add(1)?;
            value.checked_mul(1_000)?
        }
        13 | 14 => {
            let value = u32::from(u16::from_be_bytes([
                *data.get(cursor)?,
                *data.get(cursor + 1)?,
            ]));
            cursor = cursor.checked_add(2)?;
            if sample_rate_code == 14 {
                value.checked_mul(10)?
            } else {
                value
            }
        }
        _ => return None,
    };
    if sample_rate == 0 || sample_rate != stream.sample_rate {
        return None;
    }

    let expected_crc = *data.get(cursor)?;
    if flac_crc8(data.get(offset..cursor)?) != expected_crc {
        return None;
    }
    Some(FrameHeader {
        variable_block_size,
        coded_number,
        block_samples,
        header_len: cursor.checked_add(1)?.checked_sub(offset)?,
    })
}

fn decode_coded_number(data: &[u8]) -> Option<(u64, usize)> {
    let first = *data.first()?;
    let (length, mut value, minimum) = match first {
        0x00..=0x7f => (1, u64::from(first), 0),
        0xc0..=0xdf => (2, u64::from(first & 0x1f), 0x80),
        0xe0..=0xef => (3, u64::from(first & 0x0f), 0x800),
        0xf0..=0xf7 => (4, u64::from(first & 0x07), 0x1_0000),
        0xf8..=0xfb => (5, u64::from(first & 0x03), 0x20_0000),
        0xfc..=0xfd => (6, u64::from(first & 0x01), 0x400_0000),
        0xfe => (7, 0, 0x8000_0000),
        _ => return None,
    };
    for byte in data.get(1..length)? {
        if byte & 0xc0 != 0x80 {
            return None;
        }
        value = value.checked_shl(6)? | u64::from(byte & 0x3f);
    }
    (value >= minimum).then_some((value, length))
}

fn flac_crc8(data: &[u8]) -> u8 {
    data.iter().fold(0_u8, |mut crc, byte| {
        crc ^= byte;
        for _ in 0..8 {
            crc = if crc & 0x80 != 0 {
                (crc << 1) ^ 0x07
            } else {
                crc << 1
            };
        }
        crc
    })
}

fn frame_crc16_is_valid(data: &[u8], start: usize, end: usize) -> bool {
    let Some(crc_offset) = end.checked_sub(2) else {
        return false;
    };
    let Some(frame) = data.get(start..crc_offset) else {
        return false;
    };
    let Some(expected) = data.get(crc_offset..end) else {
        return false;
    };
    flac_crc16(frame) == u16::from_be_bytes([expected[0], expected[1]])
}

fn flac_crc16(data: &[u8]) -> u16 {
    let mut crc = 0_u16;
    let mut chunks = data.chunks_exact(8);
    for chunk in &mut chunks {
        let high = usize::from((crc >> 8) as u8 ^ chunk[0]);
        let low = usize::from(crc as u8 ^ chunk[1]);
        crc = FLAC_CRC16_TABLES[7][high]
            ^ FLAC_CRC16_TABLES[6][low]
            ^ FLAC_CRC16_TABLES[5][usize::from(chunk[2])]
            ^ FLAC_CRC16_TABLES[4][usize::from(chunk[3])]
            ^ FLAC_CRC16_TABLES[3][usize::from(chunk[4])]
            ^ FLAC_CRC16_TABLES[2][usize::from(chunk[5])]
            ^ FLAC_CRC16_TABLES[1][usize::from(chunk[6])]
            ^ FLAC_CRC16_TABLES[0][usize::from(chunk[7])];
    }
    chunks.remainder().iter().fold(crc, |crc, byte| {
        (crc << 8) ^ FLAC_CRC16_TABLES[0][usize::from((crc >> 8) as u8 ^ byte)]
    })
}

const fn flac_crc16_tables() -> [[u16; 256]; 8] {
    let mut tables = [[0_u16; 256]; 8];
    let mut index = 0_usize;
    while index < tables[0].len() {
        let mut crc = (index as u16) << 8;
        let mut bit = 0;
        while bit < 8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x8005
            } else {
                crc << 1
            };
            bit += 1;
        }
        tables[0][index] = crc;
        index += 1;
    }
    let mut slice = 1;
    while slice < tables.len() {
        let mut index = 0;
        while index < tables[slice].len() {
            let crc = tables[slice - 1][index];
            tables[slice][index] = (crc << 8) ^ tables[0][((crc >> 8) & u8::MAX as u16) as usize];
            index += 1;
        }
        slice += 1;
    }
    tables
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slicing_crc16_matches_flac_polynomial_vectors() {
        assert_eq!(flac_crc16(b"123456789"), 0xfee8);
        let data = (0..=u8::MAX).cycle().take(8_193).collect::<Vec<_>>();
        for length in 0..=data.len() {
            assert_eq!(flac_crc16(&data[..length]), scalar_crc16(&data[..length]));
        }
    }

    #[test]
    fn fixed_block_stream_builds_floor_sample_targets() {
        let (flac, expected_offsets) = synthetic_fixed_flac();
        let index = parse_flac_frame_index(&flac).expect("fixed FLAC frame index");
        assert_eq!(index.total_samples, 12_411);
        assert_eq!(
            index.frames,
            vec![
                FlacFrame {
                    sample_index: 0,
                    byte_offset: expected_offsets[0],
                    block_samples: 4_096,
                },
                FlacFrame {
                    sample_index: 4_096,
                    byte_offset: expected_offsets[1],
                    block_samples: 4_096,
                },
                FlacFrame {
                    sample_index: 8_192,
                    byte_offset: expected_offsets[2],
                    block_samples: 4_096,
                },
                FlacFrame {
                    sample_index: 12_288,
                    byte_offset: expected_offsets[3],
                    block_samples: 123,
                },
            ]
        );

        let tag = build_flac_pvb2(&flac).expect("fixed FLAC PVB2");
        let table = Pvb2Table::parse(&tag).expect("parse generated PVB2");
        assert_eq!(table.total_samples, 12_411);
        assert_eq!(table.entries[0].sample_index, 0);
        assert_eq!(table.entries[133].sample_index, 4_096);
        assert_eq!(table.entries[265].sample_index, 8_192);
        assert_eq!(table.entries[397].sample_index, 12_288);
        assert_eq!(table.entries[397].byte_offset, expected_offsets[3]);
        assert_eq!(table.entries[399].frame_block_samples, 123);
    }

    #[test]
    fn variable_block_stream_uses_coded_sample_numbers() {
        let blocks = [576_u32, 777, 50];
        let total_samples = blocks.iter().map(|value| u64::from(*value)).sum();
        let mut flac = streaminfo(total_samples, 16, 777);
        let first_audio_offset = flac.len();
        let mut sample_index = 0_u64;
        for (frame_number, block_samples) in blocks.into_iter().enumerate() {
            append_frame(
                &mut flac,
                true,
                sample_index,
                block_samples,
                frame_number as u8,
            );
            sample_index += u64::from(block_samples);
        }
        let index = parse_flac_frame_index(&flac).expect("variable FLAC frame index");
        assert_eq!(index.first_audio_offset, first_audio_offset as u64);
        assert_eq!(
            index
                .frames
                .iter()
                .map(|frame| (frame.sample_index, frame.block_samples))
                .collect::<Vec<_>>(),
            vec![(0, 576), (576, 777), (1_353, 50)]
        );
    }

    #[test]
    fn malformed_or_non_flac_inputs_fail_closed() {
        assert!(parse_flac_frame_index(b"not flac").is_err());
        let (mut flac, _) = synthetic_fixed_flac();
        let first_audio_offset = streaminfo_end(&flac);
        flac[first_audio_offset + 5] ^= 0x01;
        assert!(parse_flac_frame_index(&flac).is_err());

        let (mut corrupt_frame, _) = synthetic_fixed_flac();
        corrupt_frame[first_audio_offset + 6] ^= 0x01;
        assert!(parse_flac_frame_index(&corrupt_frame).is_err());

        let (mut truncated, _) = synthetic_fixed_flac();
        truncated.truncate(truncated.len() / 2);
        assert!(parse_flac_frame_index(&truncated).is_err());
    }

    fn synthetic_fixed_flac() -> (Vec<u8>, Vec<u64>) {
        let mut flac = streaminfo(12_411, 16, 4_096);
        let first_audio_offset = flac.len();
        let mut offsets = Vec::new();
        for (frame_number, block_samples) in [4_096_u32, 4_096, 4_096, 123].into_iter().enumerate()
        {
            offsets.push((flac.len() - first_audio_offset) as u64);
            append_frame(
                &mut flac,
                false,
                frame_number as u64,
                block_samples,
                frame_number as u8,
            );
        }
        (flac, offsets)
    }

    fn streaminfo(total_samples: u64, min_block: u16, max_block: u16) -> Vec<u8> {
        let mut data = vec![0_u8; 4 + 4 + STREAMINFO_LEN];
        data[..4].copy_from_slice(FLAC_SIGNATURE);
        data[4] = 0x80;
        data[5..8].copy_from_slice(&[0, 0, STREAMINFO_LEN as u8]);
        data[8..10].copy_from_slice(&min_block.to_be_bytes());
        data[10..12].copy_from_slice(&max_block.to_be_bytes());
        let packed = (44_100_u64 << 44) | (1_u64 << 41) | (15_u64 << 36) | total_samples;
        data[18..26].copy_from_slice(&packed.to_be_bytes());
        data
    }

    fn streaminfo_end(data: &[u8]) -> usize {
        8 + (usize::from(data[5]) << 16 | usize::from(data[6]) << 8 | usize::from(data[7]))
    }

    fn append_frame(
        data: &mut Vec<u8>,
        variable: bool,
        coded_number: u64,
        block_samples: u32,
        payload_byte: u8,
    ) {
        let frame_start = data.len();
        let block_code = match block_samples {
            4_096 => 12,
            1..=256 => 6,
            257..=65_535 => 7,
            _ => panic!("test block size exceeds FLAC STREAMINFO"),
        };
        let mut header = vec![0xff, 0xf8 | u8::from(variable), (block_code << 4) | 9, 0x18];
        header.extend_from_slice(&encode_coded_number(coded_number));
        match block_code {
            6 => {
                header
                    .push(u8::try_from(block_samples - 1).expect("test block size fits one byte"));
            }
            7 => {
                header.extend_from_slice(
                    &u16::try_from(block_samples - 1)
                        .expect("test block size fits two bytes")
                        .to_be_bytes(),
                );
            }
            _ => {}
        }
        header.push(flac_crc8(&header));
        data.extend_from_slice(&header);

        // A plausible sync word with a bad CRC must not split the frame.
        data.extend_from_slice(&[payload_byte, 0xff, 0xf8, 0x69, 0x18, 0, 0, 0]);
        let footer = flac_crc16(&data[frame_start..]).to_be_bytes();
        data.extend_from_slice(&footer);
    }

    fn encode_coded_number(value: u64) -> Vec<u8> {
        let length = match value {
            0..=0x7f => 1,
            0x80..=0x7ff => 2,
            0x800..=0xffff => 3,
            0x1_0000..=0x1f_ffff => 4,
            0x20_0000..=0x3ff_ffff => 5,
            0x400_0000..=0x7fff_ffff => 6,
            _ => 7,
        };
        if length == 1 {
            return vec![value as u8];
        }
        let mut encoded = vec![0_u8; length];
        let mut remainder = value;
        for byte in encoded[1..].iter_mut().rev() {
            *byte = 0x80 | (remainder & 0x3f) as u8;
            remainder >>= 6;
        }
        encoded[0] = match length {
            2 => 0xc0 | remainder as u8,
            3 => 0xe0 | remainder as u8,
            4 => 0xf0 | remainder as u8,
            5 => 0xf8 | remainder as u8,
            6 => 0xfc | remainder as u8,
            7 => 0xfe,
            _ => unreachable!(),
        };
        encoded
    }

    fn scalar_crc16(data: &[u8]) -> u16 {
        data.iter().fold(0_u16, |crc, byte| {
            (crc << 8) ^ FLAC_CRC16_TABLES[0][usize::from((crc >> 8) as u8 ^ byte)]
        })
    }
}
