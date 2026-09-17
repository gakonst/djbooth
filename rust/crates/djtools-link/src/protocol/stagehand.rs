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

// Captured Stagehand status-port heartbeats, documented in alphatheta-connect
// cee99ae/src/virtualcdj/heartbeat.ts. These are distinct from UDP/50000 presence.
pub(crate) fn build_mixer_heartbeat() -> Vec<u8> {
    build_heartbeat(
        0x3a,
        &[0x21, 0x02, 0x00, 0xfe, 0x00, 0x04, 0x00, 0x1c, 0x00, 0x00],
    )
}

pub(crate) fn build_player_heartbeat() -> Vec<u8> {
    build_heartbeat(0x68, &[0x03, 0x01, 0x00, 0x3a, 0x00, 0x00])
}

fn build_heartbeat(kind: u8, body: &[u8]) -> Vec<u8> {
    let mut packet = DJLINK_MAGIC.to_vec();
    packet.push(kind);
    packet.extend_from_slice(&padded_ascii("Stagehand", 19));
    packet.extend_from_slice(body);
    packet
}

pub(crate) fn is_a9_vu(packet: &[u8]) -> bool {
    packet.len() == 584
        && packet.starts_with(DJLINK_MAGIC)
        && packet.get(0x0a) == Some(&0x58)
        && is_a9_model(packet)
        && peer_marker(packet).is_some()
}

pub(crate) fn is_a9_mixer_state(packet: &[u8]) -> bool {
    packet.len() == 266
        && packet.starts_with(DJLINK_MAGIC)
        && packet.get(0x0a) == Some(&0x39)
        && is_a9_model(packet)
        && peer_marker(packet).is_some()
}

fn is_a9_model(packet: &[u8]) -> bool {
    packet.get(0x0b..0x1e).is_some_and(|name| {
        let end = name
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(name.len());
        &name[..end] == b"DJM-A9"
    })
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
    fn status_heartbeats_match_captured_stagehand_frames() {
        // Independent wire fixtures from the real iOS Stagehand captures in
        // alphatheta-connect cee99ae/src/virtualcdj/heartbeat.test.ts.
        let mixer =
            "5173707431576d4a4f4c3a537461676568616e6400000000000000000000210200fe0004001c0000";
        let player = "5173707431576d4a4f4c68537461676568616e64000000000000000000000301003a0000";
        let hex = |bytes: Vec<u8>| {
            bytes
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        };
        assert_eq!(hex(build_mixer_heartbeat()), mixer);
        assert_eq!(hex(build_player_heartbeat()), player);
    }

    #[test]
    fn a9_layout_is_not_applied_to_other_mixers() {
        for (length, kind) in [(266, 0x39), (584, 0x58)] {
            let mut packet = vec![0; length];
            packet[..10].copy_from_slice(DJLINK_MAGIC);
            packet[10] = kind;
            packet[0x1e] = 0x3a;
            packet[0x0b..0x11].copy_from_slice(b"XDJ-AZ");
            assert!(!is_a9_mixer_state(&packet));
            assert!(!is_a9_vu(&packet));
            packet[0x0b..0x11].copy_from_slice(b"DJM-A9");
            assert_eq!(is_a9_mixer_state(&packet), kind == 0x39);
            assert_eq!(is_a9_vu(&packet), kind == 0x58);
        }
    }

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
