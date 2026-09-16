use djtools_link::{DjLinkConfig, DjLinkServer, LibrarySnapshot, diagnostics};
use serde_json::{Value, json};
use std::{collections::BTreeMap, net::Ipv4Addr, path::Path, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpStream, UdpSocket},
};

fn rows(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[tokio::test]
async fn capture_observes_real_server_bytes_without_changing_responses() {
    let root = tempfile::tempdir().unwrap();
    let status =
        diagnostics::initialize(root.path(), "integration", json!({"revision":"fixture"})).unwrap();
    let directory = Path::new(status["directory"].as_str().unwrap());
    diagnostics::event("swift_fixture", json!({"phase":"active"}));
    diagnostics::metric(json!({"fixture":true,"crashDiagnostics":[]})).unwrap();
    let reservation = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = reservation.local_addr().unwrap().port();
    drop(reservation);
    let mut server = DjLinkServer::new(
        DjLinkConfig {
            bind_ip: Some(Ipv4Addr::LOCALHOST),
            broadcast_ip: Some(Ipv4Addr::new(127, 0, 0, 3)),
            unicast_discovery_netmask: Some(Ipv4Addr::new(255, 255, 255, 252)),
            db_server_port: port,
            mount_port: Some(0),
            ..Default::default()
        },
        LibrarySnapshot {
            master_db_id: 1,
            tracks_by_id: BTreeMap::new(),
            all_tracks: vec![],
            playlists: vec![],
        },
    )
    .await
    .unwrap();
    server.start().await.unwrap();
    let mut client = TcpStream::connect((Ipv4Addr::LOCALHOST, port))
        .await
        .unwrap();
    // RemoteDB's real field handshake, intentionally split across writes.
    let hello = [0x11, 0x87, 0x23, 0x49, 0xae];
    client.write_all(&hello[..2]).await.unwrap();
    client.write_all(&hello[2..]).await.unwrap();
    let mut reply = [0u8; 5];
    tokio::time::timeout(Duration::from_secs(2), client.read_exact(&mut reply))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reply, [0x11, 0, 0, 0, 1]);
    let receiver = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let bytes = [0, 1, 127, 128, 255];
    server
        .send_raw_udp_payload_datagram(
            Ipv4Addr::LOCALHOST,
            receiver.local_addr().unwrap().port(),
            &bytes,
            "capture-test",
        )
        .await
        .unwrap();
    let mut buf = [0; 32];
    let count = tokio::time::timeout(Duration::from_secs(2), receiver.recv(&mut buf))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&buf[..count], &bytes);
    let large = vec![0xab; 65_000];
    server
        .send_raw_udp_payload_datagram(
            Ipv4Addr::LOCALHOST,
            receiver.local_addr().unwrap().port(),
            &large,
            "full-nfs-size-fixture",
        )
        .await
        .unwrap();
    let mut received = vec![0; 65_536];
    let size = tokio::time::timeout(Duration::from_secs(2), receiver.recv(&mut received))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&received[..size], &large);
    // An unknown UDP packet still reaches the capture before protocol filtering.
    receiver
        .send_to(&bytes, (Ipv4Addr::LOCALHOST, 50000))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    drop(client);
    server.stop();
    diagnostics::flush().unwrap();
    let timeline = rows(&directory.join("timeline.jsonl"));
    assert!(
        timeline
            .iter()
            .any(|r| r["data"]["event"] == "swift_fixture")
    );
    assert!(timeline.iter().any(|r| {
        r["data"]["fields"]["message"]
            .as_str()
            .is_some_and(|s| s.contains("DJ Link up"))
    }));
    let transport = rows(&directory.join("transport.jsonl"));
    assert!(transport.iter().any(|r| r["protocol"] == "udp"
        && r["direction"] == "tx"
        && r["length"] == 65_000
        && r["hex"] == "ab".repeat(65_000)));
    let tcp = transport
        .iter()
        .filter(|r| r["protocol"] == "tcp")
        .collect::<Vec<_>>();
    let received = tcp
        .iter()
        .filter(|r| r["direction"] == "rx")
        .map(|r| r["hex"].as_str().unwrap())
        .collect::<String>();
    let sent = tcp
        .iter()
        .filter(|r| r["direction"] == "tx")
        .map(|r| r["hex"].as_str().unwrap())
        .collect::<String>();
    assert_eq!(received, "11872349ae");
    assert_eq!(sent, "1100000001");
    for direction in ["rx", "tx"] {
        assert!(transport.iter().any(|r| r["protocol"] == "udp"
            && r["direction"] == direction
            && r["hex"] == "00017f80ff"));
    }
    assert!(
        rows(&directory.join("metrics.jsonl"))[0]["data"]["fixture"]
            .as_bool()
            .unwrap()
    );
    assert_eq!(diagnostics::status()["queue_drops"], 0);
    assert_eq!(diagnostics::status()["write_failures"], 0);
}
