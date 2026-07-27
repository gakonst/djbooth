use thiserror::Error;

use super::DJLINK_MAGIC;

const MODEL_OFFSET: usize = 0x0b;
const MODEL_LEN: usize = 20;
const COMMON_FIELDS_OFFSET: usize = 0x1f;
const PLAYER_OFFSET: usize = 0x21;

/// UDP/50002 packet type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum StatusKind {
    LinkQuery,
    LinkReply,
    SourceHello,
    SourceNameReply,
    LinkInit,
    MixerStatus,
    Extension46,
    Extension47,
    Unknown(u8),
}

impl StatusKind {
    pub(crate) const fn from_raw(raw: u8) -> Self {
        match raw {
            0x05 => Self::LinkQuery,
            0x06 => Self::LinkReply,
            0x10 => Self::SourceHello,
            0x11 => Self::SourceNameReply,
            0x16 => Self::LinkInit,
            0x29 => Self::MixerStatus,
            0x46 => Self::Extension46,
            0x47 => Self::Extension47,
            value => Self::Unknown(value),
        }
    }

    pub(crate) const fn raw(self) -> u8 {
        match self {
            Self::LinkQuery => 0x05,
            Self::LinkReply => 0x06,
            Self::SourceHello => 0x10,
            Self::SourceNameReply => 0x11,
            Self::LinkInit => 0x16,
            Self::MixerStatus => 0x29,
            Self::Extension46 => 0x46,
            Self::Extension47 => 0x47,
            Self::Unknown(value) => value,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StatusHeader {
    pub(crate) kind: StatusKind,
    pub(crate) model: String,
    pub(crate) player_number: Option<u8>,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub(crate) enum StatusDecodeError {
    #[error("status packet is {actual} bytes; need at least {minimum}")]
    Truncated { actual: usize, minimum: usize },
    #[error("status packet has invalid DJ Link magic")]
    InvalidMagic,
}

pub(crate) fn decode_header(packet: &[u8]) -> Result<StatusHeader, StatusDecodeError> {
    let minimum = MODEL_OFFSET + MODEL_LEN;
    if packet.len() < minimum {
        return Err(StatusDecodeError::Truncated {
            actual: packet.len(),
            minimum,
        });
    }
    if &packet[..DJLINK_MAGIC.len()] != DJLINK_MAGIC {
        return Err(StatusDecodeError::InvalidMagic);
    }
    Ok(StatusHeader {
        kind: StatusKind::from_raw(packet[0x0a]),
        model: nul_ascii(&packet[MODEL_OFFSET..MODEL_OFFSET + MODEL_LEN]),
        player_number: packet.get(PLAYER_OFFSET).copied(),
    })
}

pub(crate) fn build_link_init(model: &str, player_number: u8) -> Vec<u8> {
    build_source_frame(StatusKind::LinkInit, model, player_number, 48)
}

pub(crate) fn build_mixer_status(model: &str, player_number: u8) -> Vec<u8> {
    let mut packet = build_source_frame(StatusKind::MixerStatus, model, player_number, 56);
    packet[0x23] = 0x38;
    packet[0x24] = player_number;

    // Opaque fixed fields copied from Rekordbox 6.8.2 and confirmed by the
    // CDJ-3000 capture. Their semantics are not inferred.
    packet[0x27] = 0xc0;
    packet[0x29] = 0x10;
    packet[0x31] = 0x10;
    packet[0x35] = 0x09;
    packet[0x36] = 0xff;
    packet
}

pub(crate) fn build_link_reply(
    model: &str,
    player_number: u8,
    slot: u8,
    source_name: &str,
    track_count: usize,
    playlist_count: usize,
) -> Vec<u8> {
    let mut packet = build_source_frame(StatusKind::LinkReply, model, player_number, 192);
    packet[0x23] = 0x9c;
    packet[0x24..0x28].copy_from_slice(&(player_number as u32).to_be_bytes());
    packet[0x2b] = slot;
    packet[0x2c..0xa6].copy_from_slice(&padded_utf16be(source_name, 122));
    packet[0xa6..0xa8].copy_from_slice(&(track_count.min(u16::MAX as usize) as u16).to_be_bytes());
    packet[0xaa] = 0x01;
    packet[0xab] = 0x01;
    packet[0xae..0xb0]
        .copy_from_slice(&(playlist_count.min(u16::MAX as usize) as u16).to_be_bytes());
    packet
}

pub(crate) fn build_extension_47(model: &str, player_number: u8) -> Vec<u8> {
    let mut packet = build_source_frame(StatusKind::Extension47, model, player_number, 72);
    packet[0x23] = 0x24;
    packet[0x24] = player_number;
    packet[0x25] = 0x04;
    packet[0x28..0x2c].copy_from_slice(&0x1234_5678u32.to_be_bytes());
    packet[0x2c..0x30].copy_from_slice(&1u32.to_be_bytes());
    packet[0x30..0x36].copy_from_slice(&[0x01, 0x01, 0x03, 0x01, 0x02, 0x01]);
    packet
}

pub(crate) fn build_source_name_reply(
    model: &str,
    player_number: u8,
    source_name: &str,
) -> Vec<u8> {
    let mut packet = build_source_frame(StatusKind::SourceNameReply, model, player_number, 296);
    packet[0x22] = 0x01;
    packet[0x23] = 0x04;
    packet[0x24] = player_number;
    packet[0x25] = 0x01;
    packet[0x28..].copy_from_slice(&padded_utf16be(source_name, 256));
    packet
}

fn build_source_frame(kind: StatusKind, model: &str, player_number: u8, size: usize) -> Vec<u8> {
    debug_assert!(size > PLAYER_OFFSET);
    let mut packet = vec![0; size];
    packet[..DJLINK_MAGIC.len()].copy_from_slice(DJLINK_MAGIC);
    packet[0x0a] = kind.raw();
    packet[MODEL_OFFSET..MODEL_OFFSET + MODEL_LEN]
        .copy_from_slice(&padded_c_ascii(model, MODEL_LEN));
    packet[COMMON_FIELDS_OFFSET] = 0x01;
    packet[COMMON_FIELDS_OFFSET + 1] = 0x01;
    packet[PLAYER_OFFSET] = player_number;
    packet
}

fn padded_c_ascii(value: &str, size: usize) -> Vec<u8> {
    let mut out = vec![0; size];
    let limit = size.saturating_sub(1);
    for (index, byte) in value
        .bytes()
        .map(|byte| if byte.is_ascii() { byte } else { b'?' })
        .take(limit)
        .enumerate()
    {
        out[index] = byte;
    }
    out
}

fn padded_utf16be(value: &str, size: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(size);
    for unit in value.encode_utf16() {
        if out.len() + 2 > size {
            break;
        }
        out.extend_from_slice(&unit.to_be_bytes());
    }
    out.resize(size, 0);
    out
}

fn nul_ascii(raw: &[u8]) -> String {
    raw.iter()
        .copied()
        .take_while(|byte| *byte != 0)
        .filter(u8::is_ascii)
        .map(char::from)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINK_INIT: &str = include_str!("../../tests/fixtures/rekordbox-link-init.hex");
    const MIXER_STATUS: &str = include_str!("../../tests/fixtures/rekordbox-mixer-status.hex");
    const LINK_REPLY: &str = include_str!("../../tests/fixtures/rekordbox-link-reply.hex");
    const EXTENSION_46: &str = include_str!("../../tests/fixtures/cdj3000-extension-query-46.hex");
    const EXTENSION_47: &str = include_str!("../../tests/fixtures/rekordbox-mystery-47.hex");

    #[test]
    fn real_rekordbox_discovery_builders_are_byte_exact() {
        assert_eq!(build_link_init("rekordbox", 17), strict_hex(LINK_INIT));
        assert_eq!(
            build_mixer_status("rekordbox", 17),
            strict_hex(MIXER_STATUS)
        );
        assert_eq!(
            build_link_reply("rekordbox", 17, 4, "rekordbox", 15_227, 248),
            strict_hex(LINK_REPLY)
        );
        assert_eq!(
            build_extension_47("rekordbox", 17),
            strict_hex(EXTENSION_47)
        );
    }

    #[test]
    fn decodes_real_rekordbox_discovery_headers() {
        let expected = [
            (LINK_INIT, StatusKind::LinkInit, "rekordbox", 17),
            (MIXER_STATUS, StatusKind::MixerStatus, "rekordbox", 17),
            (LINK_REPLY, StatusKind::LinkReply, "rekordbox", 17),
            (EXTENSION_46, StatusKind::Extension46, "CDJ-3000", 1),
            (EXTENSION_47, StatusKind::Extension47, "rekordbox", 17),
        ];
        for (fixture, kind, model, player_number) in expected {
            let header = decode_header(&strict_hex(fixture)).expect("decode fixture");
            assert_eq!(header.kind, kind);
            assert_eq!(header.model, model);
            assert_eq!(header.player_number, Some(player_number));
        }
    }

    #[test]
    fn rejects_truncated_and_wrong_magic() {
        assert_eq!(
            decode_header(&[0; 30]),
            Err(StatusDecodeError::Truncated {
                actual: 30,
                minimum: 31,
            })
        );
        let mut packet = strict_hex(LINK_INIT);
        packet[0] = 0;
        assert_eq!(decode_header(&packet), Err(StatusDecodeError::InvalidMagic));
    }

    fn strict_hex(input: &str) -> Vec<u8> {
        let input = input.trim();
        assert_eq!(input.len() % 2, 0);
        input
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let text = std::str::from_utf8(pair).expect("ASCII hex");
                u8::from_str_radix(text, 16).expect("valid hex")
            })
            .collect()
    }
}
