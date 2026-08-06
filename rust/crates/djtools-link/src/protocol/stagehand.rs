use std::net::Ipv4Addr;

use super::DJLINK_MAGIC;

const MODEL_LEN: usize = 20;
const STARTUP_HEADER_LEN: usize = 36;
const PROTOCOL_MARKER: u8 = 3;
const DEVICE_TYPE: u8 = 5;
const MODEL_CODE: u8 = 0x20;
const ALPHATHETA_OUI: [u8; 3] = [0xc8, 0x3d, 0xfc];

pub(crate) fn protocol_mac(link_mac: [u8; 6], launch_nonce: u64) -> [u8; 6] {
    let mut hash = 0x811c_9dc5_u32;
    for byte in b"djbooth-stagehand"
        .iter()
        .chain(link_mac.iter())
        .chain(launch_nonce.to_be_bytes().iter())
    {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    let suffix = hash.to_be_bytes();
    [
        ALPHATHETA_OUI[0],
        ALPHATHETA_OUI[1],
        ALPHATHETA_OUI[2],
        suffix[1],
        suffix[2],
        suffix[3],
    ]
}

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
    packet.push(DEVICE_TYPE);
    packet.push(1);
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
        && peer_marker(packet).is_some()
}

pub(crate) fn is_a9_mixer_state(packet: &[u8]) -> bool {
    packet.len() == 266
        && packet.starts_with(DJLINK_MAGIC)
        && packet.get(0x0a) == Some(&0x39)
        && peer_marker(packet).is_some()
}

pub(crate) fn is_peer_packet(packet: &[u8]) -> bool {
    packet.starts_with(DJLINK_MAGIC) && peer_marker(packet).is_some()
}

pub(crate) fn peer_marker(packet: &[u8]) -> Option<u8> {
    packet
        .get(0x1e)
        .copied()
        .filter(|marker| (0x3a..=0x3f).contains(marker))
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
        assert_eq!(&claim[0x2e..], &[0x3a, 2, 5, 1]);

        let keepalive = build_keepalive("Stagehand", 0xc7, IP, MAC, 4);
        assert_eq!(keepalive.len(), 54);
        assert_eq!(keepalive[0x24], 0xc7);
        assert_eq!(&keepalive[0x34..], &[5, 0x20]);
    }

    #[test]
    fn protocol_mac_uses_alphatheta_oui_and_changes_per_launch() {
        let first = protocol_mac(MAC, 42);
        let second = protocol_mac(MAC, 42);
        let another_launch = protocol_mac(MAC, 43);
        let another_adapter = protocol_mac([0xc8, 0x3d, 0xfc, 0x15, 0x71, 0xee], 42);

        assert_eq!(&first[..3], &ALPHATHETA_OUI);
        assert_ne!(first, MAC);
        assert_eq!(first, second);
        assert_ne!(first, another_launch);
        assert_ne!(first, another_adapter);
    }

    #[test]
    fn accepts_collision_shifted_peer_markers() {
        let mut packet = vec![0; 40];
        packet[..DJLINK_MAGIC.len()].copy_from_slice(DJLINK_MAGIC);
        packet[0x1e] = 0x3b;
        assert_eq!(peer_marker(&packet), Some(0x3b));
        assert!(is_peer_packet(&packet));
        packet[0x1e] = 0x39;
        assert_eq!(peer_marker(&packet), None);
    }
}
