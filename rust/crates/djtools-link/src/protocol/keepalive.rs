use std::net::Ipv4Addr;

use thiserror::Error;

use super::DJLINK_MAGIC;

const HEADER_LEN: usize = 35;
const MODEL_OFFSET: usize = 12;
const MODEL_LEN: usize = 20;
const STATUS_LEN: usize = 54;

const SUBTYPE_STATUS: u8 = 0x36;
const SUBTYPE_MAC: u8 = 0x2c;
const SUBTYPE_IP: u8 = 0x32;
const SUBTYPE_COMPAT_REPLY: u8 = 0x24;
const SUBTYPE_ID_USE_REPLY: u8 = 0x27;

/// UDP/50000 frame type. This field is little-endian and two bytes wide.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum KeepaliveKind {
    Discovery,
    IdUse,
    IdUseReply,
    Config,
    CompatibilityRequest,
    CompatibilityReply,
    IdSet,
    Unknown(u16),
}

impl KeepaliveKind {
    pub(crate) const fn from_raw(raw: u16) -> Self {
        match raw {
            0x0000 => Self::Discovery,
            0x0002 => Self::IdUse,
            0x0003 => Self::IdUseReply,
            0x0006 => Self::Config,
            0x000a => Self::CompatibilityRequest,
            0x000b => Self::CompatibilityReply,
            0x0102 => Self::IdSet,
            value => Self::Unknown(value),
        }
    }

    pub(crate) const fn raw(self) -> u16 {
        match self {
            Self::Discovery => 0x0000,
            Self::IdUse => 0x0002,
            Self::IdUseReply => 0x0003,
            Self::Config => 0x0006,
            Self::CompatibilityRequest => 0x000a,
            Self::CompatibilityReply => 0x000b,
            Self::IdSet => 0x0102,
            Self::Unknown(value) => value,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct KeepaliveHeader {
    pub(crate) kind: KeepaliveKind,
    pub(crate) model: String,
    pub(crate) protocol_marker: u8,
    pub(crate) device_kind: u8,
    pub(crate) reserved: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DeviceAnnouncement {
    pub(crate) player_number: u8,
    pub(crate) player_type: u8,
    pub(crate) mac: [u8; 6],
    pub(crate) advertised_ip: Ipv4Addr,
    pub(crate) peer_count: u8,
    pub(crate) trailing: [u8; 5],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AddressClaim {
    pub(crate) advertised_ip: Ipv4Addr,
    pub(crate) mac: [u8; 6],
    pub(crate) player_marker: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum KeepaliveBody {
    DeviceAnnouncement(DeviceAnnouncement),
    AddressClaim(AddressClaim),
    Other { subtype: Option<u8> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct KeepalivePacket {
    pub(crate) header: KeepaliveHeader,
    pub(crate) body: KeepaliveBody,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub(crate) enum KeepaliveDecodeError {
    #[error("keepalive packet is {actual} bytes; need at least {minimum}")]
    Truncated { actual: usize, minimum: usize },
    #[error("keepalive packet has invalid DJ Link magic")]
    InvalidMagic,
    #[error("device keepalive is {actual} bytes; need at least 54")]
    TruncatedDeviceAnnouncement { actual: usize },
    #[error("address-claim keepalive is {actual} bytes; need at least 50")]
    TruncatedAddressClaim { actual: usize },
}

pub(crate) fn decode(packet: &[u8]) -> Result<KeepalivePacket, KeepaliveDecodeError> {
    let header = decode_header(packet)?;
    let subtype = packet.get(HEADER_LEN).copied();
    let body = match (header.kind, subtype) {
        (KeepaliveKind::Config, Some(SUBTYPE_STATUS)) => {
            if packet.len() < STATUS_LEN {
                return Err(KeepaliveDecodeError::TruncatedDeviceAnnouncement {
                    actual: packet.len(),
                });
            }
            KeepaliveBody::DeviceAnnouncement(DeviceAnnouncement {
                player_number: packet[0x24],
                player_type: packet[0x25],
                mac: packet[0x26..0x2c].try_into().expect("validated range"),
                advertised_ip: Ipv4Addr::from(
                    <[u8; 4]>::try_from(&packet[0x2c..0x30]).expect("validated range"),
                ),
                peer_count: packet[0x30],
                trailing: packet[0x31..0x36].try_into().expect("validated range"),
            })
        }
        (KeepaliveKind::IdUse | KeepaliveKind::IdSet, Some(SUBTYPE_IP)) => {
            if packet.len() < 50 {
                return Err(KeepaliveDecodeError::TruncatedAddressClaim {
                    actual: packet.len(),
                });
            }
            KeepaliveBody::AddressClaim(AddressClaim {
                advertised_ip: Ipv4Addr::from(
                    <[u8; 4]>::try_from(&packet[0x24..0x28]).expect("validated range"),
                ),
                mac: packet[0x28..0x2e].try_into().expect("validated range"),
                player_marker: packet[0x2e],
            })
        }
        _ => KeepaliveBody::Other { subtype },
    };
    Ok(KeepalivePacket { header, body })
}

pub(crate) fn decode_header(packet: &[u8]) -> Result<KeepaliveHeader, KeepaliveDecodeError> {
    if packet.len() < HEADER_LEN {
        return Err(KeepaliveDecodeError::Truncated {
            actual: packet.len(),
            minimum: HEADER_LEN,
        });
    }
    if &packet[..DJLINK_MAGIC.len()] != DJLINK_MAGIC {
        return Err(KeepaliveDecodeError::InvalidMagic);
    }
    Ok(KeepaliveHeader {
        kind: KeepaliveKind::from_raw(u16::from_le_bytes([packet[0x0a], packet[0x0b]])),
        model: nul_ascii(&packet[MODEL_OFFSET..MODEL_OFFSET + MODEL_LEN]),
        protocol_marker: packet[0x20],
        device_kind: packet[0x21],
        reserved: packet[0x22],
    })
}

pub(crate) fn build_status_announcement(
    model: &str,
    player_number: u8,
    ip_addr: Ipv4Addr,
    mac_addr: [u8; 6],
    device_count: u8,
) -> Vec<u8> {
    let mut payload = Vec::with_capacity(19);
    payload.push(SUBTYPE_STATUS);
    payload.push(player_number);
    payload.push(1);
    payload.extend_from_slice(&mac_addr);
    payload.extend_from_slice(&ip_addr.octets());
    payload.push(device_count);
    payload.push(1);
    payload.push(0);
    payload.extend_from_slice(&0x0004u16.to_be_bytes());
    payload.push(0x08);
    build_frame(model, KeepaliveKind::Config, &payload, 3)
}

pub(crate) fn build_discovery(model: &str, ip_addr: Ipv4Addr, iteration: u8) -> Vec<u8> {
    let mut payload = Vec::with_capacity(9);
    payload.push(SUBTYPE_MAC);
    payload.push(iteration);
    payload.push(0x04);
    payload.extend_from_slice(&ip_addr.octets());
    payload.extend_from_slice(&50000u16.to_be_bytes());
    build_frame(model, KeepaliveKind::Discovery, &payload, 3)
}

pub(crate) fn build_ip_claim(
    model: &str,
    ip_addr: Ipv4Addr,
    mac_addr: [u8; 6],
    marker: u8,
    kind: KeepaliveKind,
) -> Vec<u8> {
    let mut payload = Vec::with_capacity(15);
    payload.push(SUBTYPE_IP);
    payload.extend_from_slice(&ip_addr.octets());
    payload.extend_from_slice(&mac_addr);
    payload.push(marker);
    payload.push(1);
    payload.push(0x04);
    payload.push(0x01);
    build_frame(model, kind, &payload, 3)
}

pub(crate) fn build_compatibility_reply(model: &str) -> Vec<u8> {
    build_frame(
        model,
        KeepaliveKind::CompatibilityReply,
        &[SUBTYPE_COMPAT_REPLY],
        3,
    )
}

pub(crate) fn build_id_use_reply(model: &str, request_kind: KeepaliveKind) -> Vec<u8> {
    let raw = request_kind.raw();
    build_frame(
        model,
        KeepaliveKind::IdUseReply,
        &[
            SUBTYPE_ID_USE_REPLY,
            (raw & 0xff) as u8,
            (raw >> 8) as u8,
            0x01,
        ],
        3,
    )
}

fn build_frame(model: &str, kind: KeepaliveKind, payload: &[u8], device_kind: u8) -> Vec<u8> {
    let mut packet = Vec::with_capacity(HEADER_LEN + payload.len());
    packet.extend_from_slice(DJLINK_MAGIC);
    packet.extend_from_slice(&kind.raw().to_le_bytes());
    packet.extend_from_slice(&padded_ascii(model, MODEL_LEN));
    packet.push(1);
    packet.push(device_kind);
    packet.push(0);
    packet.extend_from_slice(payload);
    packet
}

fn padded_ascii(value: &str, size: usize) -> Vec<u8> {
    let mut bytes = value
        .bytes()
        .map(|byte| if byte.is_ascii() { byte } else { b'?' })
        .take(size)
        .collect::<Vec<_>>();
    bytes.resize(size, 0);
    bytes
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

    const P1: &str = include_str!("../../tests/fixtures/keepalive-cdj3000-p1.hex");
    const P2: &str = include_str!("../../tests/fixtures/keepalive-cdj3000-p2.hex");
    const P3: &str = include_str!("../../tests/fixtures/keepalive-cdj3000-p3.hex");
    const REKORDBOX: &str = include_str!("../../tests/fixtures/rekordbox-keepalive.hex");

    #[test]
    fn decodes_all_live_cdj3000_announcements() {
        let expected = [
            (
                P1,
                1,
                [0x24, 0x97, 0xed, 0x24, 0x4a, 0x55],
                Ipv4Addr::new(169, 254, 6, 175),
            ),
            (
                P2,
                2,
                [0x24, 0x97, 0xed, 0x24, 0x4a, 0x62],
                Ipv4Addr::new(169, 254, 6, 240),
            ),
            (
                P3,
                3,
                [0x24, 0x97, 0xed, 0x24, 0x4a, 0x66],
                Ipv4Addr::new(169, 254, 7, 4),
            ),
        ];

        for (fixture, player_number, mac, ip) in expected {
            let packet = decode(&strict_hex(fixture)).expect("decode fixture");
            assert_eq!(packet.header.kind, KeepaliveKind::Config);
            assert_eq!(packet.header.model, "CDJ-3000");
            assert_eq!(packet.header.protocol_marker, 1);
            assert_eq!(packet.header.device_kind, 3);
            assert_eq!(packet.header.reserved, 0);
            let KeepaliveBody::DeviceAnnouncement(announcement) = packet.body else {
                panic!("expected device announcement");
            };
            assert_eq!(announcement.player_number, player_number);
            assert_eq!(announcement.player_type, 1);
            assert_eq!(announcement.mac, mac);
            assert_eq!(announcement.advertised_ip, ip);
            assert_eq!(announcement.peer_count, 3);
            assert_eq!(announcement.trailing, [0, 0, 0, 1, 0x64]);
        }
    }

    #[test]
    fn rejects_truncated_device_announcement() {
        let mut packet = strict_hex(P3);
        packet.truncate(53);
        assert_eq!(
            decode(&packet),
            Err(KeepaliveDecodeError::TruncatedDeviceAnnouncement { actual: 53 })
        );
    }

    #[test]
    fn rekordbox_status_builder_roundtrips() {
        let packet = build_status_announcement(
            "rekordbox",
            17,
            Ipv4Addr::new(169, 254, 253, 33),
            [0xc8, 0x3d, 0xfc, 0x15, 0x71, 0xed],
            4,
        );
        assert_eq!(packet.len(), STATUS_LEN);
        let decoded = decode(&packet).expect("decode encoded status");
        assert_eq!(decoded.header.model, "rekordbox");
        let KeepaliveBody::DeviceAnnouncement(announcement) = decoded.body else {
            panic!("expected device announcement");
        };
        assert_eq!(announcement.player_number, 17);
        assert_eq!(announcement.advertised_ip, Ipv4Addr::new(169, 254, 253, 33));
        assert_eq!(announcement.peer_count, 4);
    }

    #[test]
    fn real_rekordbox_status_builder_is_byte_exact() {
        let packet = build_status_announcement(
            "rekordbox",
            17,
            Ipv4Addr::new(169, 254, 246, 230),
            [0xc8, 0x3d, 0xfc, 0x15, 0x71, 0xe1],
            2,
        );
        assert_eq!(packet, strict_hex(REKORDBOX));
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
