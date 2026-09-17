//! Exercise the phone's C ABI against real RemoteDB sockets, including teardown.
use djbooth_mobile::{djbooth_link_free, djbooth_link_request};
use djtools_link::{DjLinkConfig, LibrarySnapshot, TrackRecord, audit_remote_db_cursors};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    ffi::{CStr, CString},
    io::{Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    time::Duration,
};

fn call(operation: &str, input: Value) -> Value {
    let operation = CString::new(operation).unwrap();
    let input = CString::new(input.to_string()).unwrap();
    let response = unsafe {
        let pointer = djbooth_link_request(operation.as_ptr(), input.as_ptr());
        let response: Value = serde_json::from_slice(CStr::from_ptr(pointer).to_bytes()).unwrap();
        djbooth_link_free(pointer);
        response
    };
    assert_eq!(response["ok"], true, "{response}");
    response["value"].clone()
}

#[test]
fn mobile_ffi_live_midi_works_without_recording_or_network_session() {
    let source = json!({"source":"DJM-A9 ABI"});
    call("midi.connect", source.clone());
    call(
        "midi.packet",
        json!({"source":"DJM-A9 ABI","timestampUs":1000,"bytes":[176,2,127,176,11,0]}),
    );
    let mixers = call("midi.snapshot", json!({}));
    let mixer = &mixers[0]["mixer"];
    assert_eq!(mixer["controls"]["channel.1.eq.high"]["percent"], 100.0);
    assert_eq!(mixer["controls"]["crossfader.position"]["percent"], 0.0);
    call("midi.disconnect", source);
    assert_eq!(call("midi.snapshot", json!({})), json!([]));
}

fn hex(value: &str) -> Vec<u8> {
    value
        .trim()
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

// Fixture messages use only typed u32 arguments. Production framing stays in Rust Link.
fn message(tx: u32, kind: u16, args: &[u32]) -> Vec<u8> {
    let mut bytes = hex("11872349ae11");
    bytes.extend(tx.to_be_bytes());
    bytes.push(0x10);
    bytes.extend(kind.to_be_bytes());
    bytes.extend([0x0f, args.len() as u8, 0x14]);
    bytes.extend((args.len() as u32).to_be_bytes());
    bytes.extend(vec![6; args.len()]);
    for arg in args {
        bytes.push(0x11);
        bytes.extend(arg.to_be_bytes());
    }
    bytes
}

fn expect(client: &mut TcpStream, expected: &[u8]) {
    let mut actual = vec![0; expected.len()];
    client.read_exact(&mut actual).unwrap();
    assert_eq!(actual, expected);
}

fn render(
    client: &mut TcpStream,
    tx: u32,
    context: u32,
    offset: u32,
    count: u32,
    total: u32,
) -> Vec<u8> {
    let request = message(tx, 0x3000, &[context, offset, count, 0, total, 0]);
    client.write_all(&request).unwrap();
    let footer = message(tx, 0x4201, &[]);
    let mut response = Vec::new();
    while !response.ends_with(&footer) {
        let mut byte = [0];
        client.read_exact(&mut byte).unwrap();
        response.push(byte[0]);
        assert!(response.len() < 64 * 1024, "unterminated menu");
    }
    let audit = audit_remote_db_cursors(&request, &response);
    assert_eq!(audit.matching_headers(), 1);
    assert_eq!(audit.missing_headers(), 0);
    response
}

#[test]
fn mobile_ffi_browse_load_back_switch_and_reconnect() {
    struct Close;
    impl Drop for Close {
        fn drop(&mut self) {
            call("stop", json!({}));
        }
    }
    let _close = Close;
    let root = tempfile::tempdir().unwrap();
    let reservation = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = reservation.local_addr().unwrap().port();
    drop(reservation);
    let tracks = ["First", "Second"]
        .into_iter()
        .enumerate()
        .map(|(index, title)| {
            let path = root.path().join(format!("{title}.mp3"));
            std::fs::write(&path, b"socket test audio fixture").unwrap();
            TrackRecord {
                track_id: 777201902 + index as u32,
                title: title.into(),
                mount_path: path,
                ..Default::default()
            }
        })
        .collect::<Vec<_>>();
    let library = LibrarySnapshot {
        master_db_id: 1,
        tracks_by_id: tracks
            .iter()
            .cloned()
            .map(|track| (track.track_id, track))
            .collect::<BTreeMap<_, _>>(),
        all_tracks: tracks,
        playlists: vec![],
    };
    for take in 0..2 {
        call(
            "server.new",
            json!({"config": DjLinkConfig {
            bind_ip: Some(Ipv4Addr::LOCALHOST),
            broadcast_ip: Some(Ipv4Addr::new(127,0,0,3)),
            unicast_discovery_netmask: Some(Ipv4Addr::new(255,255,255,252)),
            db_server_port: port,
            mount_port: Some(0),
            ..Default::default()
        }, "library": library}),
        );
        call("server.start", json!({}));
        let recording = root.path().join(format!("take-{take}"));
        assert_eq!(
            call(
                "recording.start",
                json!({"directory":recording,"tracks":[]})
            )["recording"],
            true
        );
        call(
            "recording.midi",
            json!({"source":"DJM-A9", "timestampUs":1000,"bytes":[176,0,127]}),
        );
        let mut client = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        client.write_all(&hex("11872349ae")).unwrap();
        expect(&mut client, &hex("1100000001"));
        // A fresh session cannot render the previous connection's browse buffer.
        assert_eq!(render(&mut client, 1, 0x01010401, 1, 1, 2).len(), 52);
        client
            .write_all(&message(2, 0x1004, &[0x01010401, 0]))
            .unwrap();
        expect(&mut client, &message(2, 0x4000, &[0x1004, 2]));
        for (index, track) in [777201902, 777201903, 777201902].into_iter().enumerate() {
            let tx = 10 + index as u32 * 10;
            client
                .write_all(&message(tx, 0x2002, &[0x01020401, track]))
                .unwrap();
            expect(&mut client, &message(tx, 0x4000, &[0x2002, 16]));
            render(&mut client, tx + 1, 0x01020401, 0, 16, 16);
            client
                .write_all(&hex(include_str!(
                    "../../djtools-link/tests/fixtures/remotedb-cdj3000-dj-id-request.hex"
                )))
                .unwrap();
            expect(
                &mut client,
                &hex(include_str!(
                    "../../djtools-link/tests/fixtures/remotedb-dj-id-unavailable.hex"
                )),
            );
            client
                .write_all(&message(tx + 2, 0x2602, &[0x01090401, track]))
                .unwrap();
            expect(&mut client, &message(tx + 2, 0x4000, &[0x2602, 13]));
            render(&mut client, tx + 3, 0x01090401, 0, 13, 13);
            // Back asks the server to locate the selected ID before rendering again.
            // Returning a constant zero silently moves the deck to the first item.
            client
                .write_all(&message(tx + 4, 0x3100, &[0x01010401, track, 0, 1]))
                .unwrap();
            expect(
                &mut client,
                &message(tx + 4, 0x4000, &[0x3100, track - 777201902]),
            );
            let back = render(&mut client, tx + 5, 0x01010401, 1, 1, 2);
            assert!(
                back.windows(12)
                    .any(|bytes| bytes == hex("005300650063006f006e0064"))
            );
        }
        call("server.stop", json!({}));
        assert_eq!(call("recording.status", json!({}))["recording"], false);
        let timeline = std::fs::read_to_string(recording.join("events.jsonl")).unwrap();
        assert!(timeline.contains("recordingStopped"));
        assert!(timeline.contains("midiRaw"));
        let mut byte = [0];
        assert_eq!(
            client.read(&mut byte).unwrap(),
            0,
            "stop must close accepted deck connections"
        );
        call("stop", json!({}));
    }
}
