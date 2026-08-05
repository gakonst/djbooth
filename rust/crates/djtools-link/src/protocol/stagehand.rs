use std::net::Ipv4Addr;

use super::DJLINK_MAGIC;

const MODEL_LEN: usize = 20;
const STARTUP_HEADER_LEN: usize = 36;
const PROTOCOL_MARKER: u8 = 3;
const DEVICE_TYPE: u8 = 5;
const MODEL_CODE: u8 = 0x20;

pub(crate) fn build_announcement(model: &str) -> Vec<u8> {
    let mut packet = build_header(model, 0x0a, 37);
    packet.push(DEVICE_TYPE);
    packet
}

pub(crate) fn build_claim(
    model: &str,
    ip_addr: Ipv4Addr,
    mac_addr: [u8; 6],
    iteration: u8,
) -> Vec<u8> {
    let mut packet = build_header(model, 0x02, 50);
    packet.extend_from_slice(&ip_addr.octets());
    packet.extend_from_slice(&mac_addr);
    packet.push(0x3a);
    packet.push(iteration);
    packet.push(1);
    packet.push(DEVICE_TYPE);
    packet
}

pub(crate) fn build_keepalive(
    model: &str,
    runtime_number: u8,
    ip_addr: Ipv4Addr,
    mac_addr: [u8; 6],
    peer_count: u8,
) -> Vec<u8> {
    let mut packet = build_header(model, 0x06, 54);
    packet.push(runtime_number);
    packet.push(1);
    packet.extend_from_slice(&mac_addr);
    packet.extend_from_slice(&ip_addr.octets());
    packet.push(peer_count);
    packet.extend_from_slice(&[0, 0, 0, DEVICE_TYPE, MODEL_CODE]);
    packet
}

pub(crate) fn is_a9_vu(packet: &[u8]) -> bool {
    packet.len() == 584
        && packet.starts_with(DJLINK_MAGIC)
        && packet.get(0x0a) == Some(&0x58)
        && packet.get(0x1e) == Some(&0x3a)
}

pub(crate) fn is_a9_mixer_state(packet: &[u8]) -> bool {
    packet.len() == 266
        && packet.starts_with(DJLINK_MAGIC)
        && packet.get(0x0a) == Some(&0x39)
        && packet.get(0x1e) == Some(&0x3a)
}

pub(crate) fn is_peer_packet(packet: &[u8]) -> bool {
    packet.starts_with(DJLINK_MAGIC) && packet.get(0x1e) == Some(&0x3a)
}

fn build_header(model: &str, kind: u8, packet_len: usize) -> Vec<u8> {
    let mut packet = Vec::with_capacity(packet_len);
    packet.extend_from_slice(DJLINK_MAGIC);
    packet.push(kind);
    packet.push(0);
    packet.extend_from_slice(&padded_ascii(model, MODEL_LEN));
    packet.push(1);
    packet.push(PROTOCOL_MARKER);
    packet.extend_from_slice(&(packet_len as u16).to_be_bytes());
    debug_assert_eq!(packet.len(), STARTUP_HEADER_LEN);
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

#[cfg(test)]
mod tests {
    use super::*;

    const IP: Ipv4Addr = Ipv4Addr::new(169, 254, 85, 94);
    const MAC: [u8; 6] = [0xc8, 0x3d, 0xfc, 0x15, 0x71, 0xed];

    #[test]
    fn builds_stagehand_startup_frames() {
        let announce = build_announcement("Stagehand");
        assert_eq!(announce.len(), 37);
        assert_eq!(&announce[0x22..0x24], &[0, 37]);
        assert_eq!(announce[0x24], 5);

        let claim = build_claim("Stagehand", IP, MAC, 2);
        assert_eq!(claim.len(), 50);
        assert_eq!(&claim[0x24..0x28], &IP.octets());
        assert_eq!(&claim[0x28..0x2e], &MAC);
        assert_eq!(&claim[0x2e..], &[0x3a, 2, 1, 5]);

        let keepalive = build_keepalive("Stagehand", 0xc7, IP, MAC, 4);
        assert_eq!(keepalive.len(), 54);
        assert_eq!(keepalive[0x24], 0xc7);
        assert_eq!(&keepalive[0x34..], &[5, 0x20]);
    }
}
