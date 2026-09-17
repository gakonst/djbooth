use serde::Serialize;
use serde_json::{Value, json};
use std::{collections::BTreeMap, net::SocketAddr};

const MAX_PATTERNS: usize = 256;

#[derive(Default)]
pub(super) struct TrafficSummary {
    patterns: BTreeMap<String, PacketCount>,
    untracked_packets: u64,
    send_errors: u64,
    last_send_error: Option<Value>,
}

#[derive(Serialize)]
struct PacketCount {
    direction: &'static str,
    peer_ip: String,
    local_port: u16,
    last_peer_port: u16,
    kind: u8,
    length: usize,
    model: String,
    classification: &'static str,
    packets: u64,
    first_ms: u128,
    last_ms: u128,
}

impl TrafficSummary {
    pub(super) fn observe(
        &mut self,
        at: u128,
        direction: &'static str,
        local: SocketAddr,
        peer: SocketAddr,
        bytes: &[u8],
    ) -> Option<Value> {
        use crate::protocol::{DJLINK_MAGIC, stagehand};
        if bytes.len() < 32 || !bytes.starts_with(DJLINK_MAGIC) {
            return None;
        }
        let kind = bytes[10];
        let presence = local.port() == 50000 || peer.port() == 50000;
        let name = if presence {
            &bytes[12..32]
        } else {
            &bytes[11..30]
        };
        let end = name.iter().position(|b| *b == 0).unwrap_or(name.len());
        let model = String::from_utf8_lossy(&name[..end]).into_owned();
        let classification = if stagehand::is_a9_mixer_state(bytes) {
            "a9_controls"
        } else if stagehand::is_a9_vu(bytes) {
            "a9_vu_experimental"
        } else if presence && kind == 6 && bytes.len() == 100 && model == "DJM-A9" {
            // Keep the complete bytes in transport.jsonl. This is a candidate,
            // not proof that the echoed peer identity matches our current one.
            "a9_paired_keepalive_candidate"
        } else if model == "DJM-A9" && kind == 3 && bytes.len() == 53 {
            "a9_on_air"
        } else {
            "pro_dj_link"
        };
        // Devices change their UDP source port for almost every status packet.
        // Do not let those ports grow the map or split one stream into rows.
        let key = format!(
            "{direction}:{}:{}:{kind}:{}:{model}",
            peer.ip(),
            local.port(),
            bytes.len()
        );
        let first = !self.patterns.contains_key(&key);
        if first && self.patterns.len() >= MAX_PATTERNS {
            self.untracked_packets += 1;
            return None;
        }
        let count = self.patterns.entry(key).or_insert(PacketCount {
            direction,
            peer_ip: peer.ip().to_string(),
            local_port: local.port(),
            last_peer_port: peer.port(),
            kind,
            length: bytes.len(),
            model,
            classification,
            packets: 0,
            first_ms: at,
            last_ms: at,
        });
        count.packets += 1;
        count.last_ms = at;
        count.last_peer_port = peer.port();
        first.then(|| json!(count))
    }

    pub(super) fn event(&mut self, value: &Value) {
        if value["event"] == "udp_send_error" {
            self.send_errors += 1;
            self.last_send_error = Some(value.clone());
        }
    }

    pub(super) fn value(&self) -> Value {
        json!({
            "scope":"application socket observations; successful sends do not prove wire delivery",
            "patterns":self.patterns.values().collect::<Vec<_>>(),
            "untracked_packets":self.untracked_packets,
            "send_errors":self.send_errors,"last_send_error":self.last_send_error,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn changing_source_ports_do_not_hide_mixer_traffic() {
        let mut summary = TrafficSummary::default();
        let local = "0.0.0.0:50001".parse().unwrap();
        let mut packet = vec![0; 53];
        packet[..10].copy_from_slice(crate::protocol::DJLINK_MAGIC);
        packet[10] = 3;
        packet[11..17].copy_from_slice(b"DJM-A9");
        for port in 1000..2000 {
            summary.observe(
                port as u128,
                "rx",
                local,
                format!("169.254.69.43:{port}").parse().unwrap(),
                &packet,
            );
        }
        let value = summary.value();
        assert_eq!(value["patterns"].as_array().unwrap().len(), 1);
        assert_eq!(value["patterns"][0]["packets"], 1000);
        assert_eq!(value["patterns"][0]["classification"], "a9_on_air");
        assert_eq!(value["patterns"][0]["last_peer_port"], 1999);
        assert_eq!(value["patterns"][0]["first_ms"], 1000);
    }

    #[test]
    fn controls_require_the_shared_decoder_and_patterns_are_bounded() {
        let mut summary = TrafficSummary::default();
        let local = "0.0.0.0:50002".parse().unwrap();
        let peer = "169.254.69.43:50002".parse().unwrap();
        let mut packet = vec![0; 266];
        packet[..10].copy_from_slice(crate::protocol::DJLINK_MAGIC);
        packet[10] = 0x39;
        packet[11..17].copy_from_slice(b"DJM-A9");
        packet[30] = 0x3a;
        summary.observe(1, "rx", local, peer, &packet);
        assert_eq!(
            summary.value()["patterns"][0]["classification"],
            "a9_controls"
        );
        for size in 267..800 {
            packet.resize(size, 0);
            summary.observe(2, "rx", local, peer, &packet);
        }
        assert_eq!(summary.patterns.len(), MAX_PATTERNS);
        assert!(summary.untracked_packets > 0);
        assert_eq!(
            summary
                .patterns
                .values()
                .filter(|p| p.classification == "a9_controls")
                .count(),
            1
        );
    }
}
