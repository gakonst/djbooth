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
