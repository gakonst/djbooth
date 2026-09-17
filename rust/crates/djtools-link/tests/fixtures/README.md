# DJ Link Golden Packets

Hex payloads only; Ethernet/IP/UDP headers are intentionally excluded.

## CDJ-3000 post-load delivery information

`remotedb-cdj3000-delivery-info-request.hex` is the actual phone socket read at
September 16, 2026 00:08:08.454 PDT, transaction `0x0975`, context `0x01090401`,
track `777201902`. It followed the corrected DJ identity response; the previous
server rejected it with `INVALID_REQUEST`, and no more browse requests arrived.

Response behavior is derived from the same archived native executable identified
below, not from a captured response. `OnSongInfCmd` calls `GetDeliveryInf` at
`0x1016387d6`; `Ret4ByteToClient` (`0x101631680`) sends `0x4000` with request type
and row count. `GetDeliveryInfDB` (`0x101218dd0`) and AppSync's `getDeliveryInf`
(`0x101717dd0`) prepare 13 rows, types `[4f,04,07,02,06,23,0f,0b,12,0d,0e,36,37]`.
The first contains track ID, database ID, delivery opt-in, and ISRC; the last
two contain composer and lyricist. Unavailable delivery-specific data is unset.
`DsqlListBuf_Clear`/`Insert` take the full context as the buffer key. Preserve
other contexts when preparing this menu so Back can render its existing buffer.
Tests cover the captured request and post-load delivery/render/Back/track-switch
traffic on a real local TCP socket. Hardware validation remains a separate gate.

## CDJ-3000 DJ identity request after track load

- `remotedb-cdj3000-dj-id-request.hex`: actual phone socket capture on
  September 15, 2026 at 23:18:06 PDT, transaction `0x0789`, immediately before
  the user reported Back stuck. Request `0x3006`, context `0x01090401`.
- `remotedb-dj-id-unavailable.hex`: expected absent-identity response derived
  from native code, **not a captured response**. Type `0x4d02`, arguments
  `[0x3006, 0, 0, omitted binary]`. The prior Rust reply was incorrectly
  `SUCCESS(0x4000, [0x3006, 1])`.

Native evidence: archived Rekordbox 6.8.2.0018 executable at
`archive/rekordbox/artifacts/rekordbox/6.8.2.0018/rekordbox.app/Contents/MacOS/rekordbox`,
SHA-256 `19db9964df3751fccd25ec9064b5a3031d7c05aa7c444e5dce3e7d6fc73598bc`.
`PSvDBMain::OnUserCmd` at `0x10163a340` compares the request against `0x3006`,
calls `GetDJID`, then invokes `RetBinToClient` with response `0x4d02`, status
zero, and either 160 bytes or length zero/null. The no-identity branch is at
`0x10163a41c`; `RetBinToClient` is at `0x101631760`.
`DBCFmt_GetCmdPrmFmt` branches on `0x4d02` at `0x1016f5866` to
`0x1016f5a41`, specifying four arguments with types `[6, 6, 6, 3]`.
The handler regression test sends the captured request between metadata and
the next browse sequence over one TCP connection and compares exact bytes.
Hardware retesting is still required to establish whether this resolves all
navigation failures; a successful write or cursor audit alone is insufficient.

### September 15 capture-drop cross-check

`CDJ-Rekordbox-Captures-2026-09-15.zip` contains 56 captures, plus
`SHA256SUMS.txt` and `capture-provenance.md`. All 56 capture hashes were verified.
A scan of 565,780 packets found no `0x3006` requests or `0x4d02` responses;
this drop therefore does not supply a captured identity-response fixture.
The two native Rekordbox files reproduce the documented menu-header cursor
behavior (25 paired renders in `rb-tracks-native-123e84e.pcap`, 15 in
`rb-tracks.pcap`, no cursor mismatches). The other captures include experimental
implementations and must not be treated as native response authorities solely
because a packet was captured from a working hardware session.

## Live baseline

Source:
`/Users/gakonst/github/gakonst/djskills/captures/live-baseline-spotify-life-is-hard-20260727T013443Z.pcapng`

SHA-256:
`85cc1c5b8d7a9f5a4558c69f413867f7e2fe6003317521293d71b2fcf23809c9`

- `keepalive-cdj3000-p1.hex`: frame 1, `169.254.6.175`, player 1
- `keepalive-cdj3000-p2.hex`: frame 2, `169.254.6.240`, player 2
- `keepalive-cdj3000-p3.hex`: frame 4, `169.254.7.4`, player 3

## Proven load exchange

Source:
`/Users/gakonst/github/gakonst/djskills/captures/djlink-hardware-gate-20260514T184853Z.pcapng`

SHA-256:
`95180a87dbe3c008512c16da680c54d02b87e867d80b92cf2a4c1b1adf3b5048`

- `status-cdj3000-p3.hex`: frame 2 from player 3
- `load-command-p3.hex`: frame 77, virtual player 17 to player 3
- `load-ack-p3.hex`: frame 78, player 3 to virtual player 17

The fixtures pin observed CDJ-3000 wire bytes. Builders may be compared with
them only where the payload is expected to be byte-identical; decoders must
accept them without normalization.

## Real Rekordbox source discovery

Source:
`/Users/gakonst/github/gakonst/djtools/rb-tracks.pcap`

SHA-256:
`519c84fe225d5b310e7ab73c84bc2333c0ee7c048b32a5d3f11f9d519baf1845`

- `rekordbox-keepalive.hex`: UDP/50000 source announcement from Rekordbox.
- `rekordbox-link-init.hex`: UDP/50002 `0x16` discovery packet.
- `rekordbox-mixer-status.hex`: UDP/50002 `0x29` source heartbeat.
- `rekordbox-link-reply.hex`: UDP/50002 `0x06` media reply.
- `cdj3000-extension-query-46.hex`: frame 67, the CDJ-3000 request
  immediately preceding Rekordbox's unicast `0x47` response.
- `rekordbox-mystery-47.hex`: UDP/50002 `0x47` extension packet.

These payloads were extracted from the real Rekordbox capture, not from the
legacy Rust implementation.

## Native Rekordbox RemoteDB cursor

Source: git object `123e84e:rb-tracks.pcap` in `gakonst/djtools`.

SHA-256:
`a2238f100e58509de14eea3a0730da753667c4851faced18dea9f916c5f035ad`

- `remotedb-render-offset-2.hex`: TCP stream 0, transaction `0x1883`, CDJ
  RENDER request at offset 2.
- `remotedb-menu-header-offset-2.hex`: same stream and transaction, native
  Rekordbox MENU_HEADER `[1,2]`.

The later checked-out `djtools/rb-tracks.pcap` is a different capture. Use the
immutable git object and hash above for RemoteDB cursor comparisons.

## Pre-patch CDJ-3000 incremental Search

Source:
`/tmp/music-djlink-search-final-hardware-20260727T0637Z.pcapng`

SHA-256:
`44c8e136cb540ac7d9c2cad5040f053dc58509f316c15a0e39e2b230a75c84a7`

- `remotedb-cdj3000-incremental-search-rafa.hex`: frame 145387, player 3
  request `0x1500`, transaction `0x09aa`, query `RAFA`.

The four arguments are packed `r:m:s:t`, sort, UTF-16 byte length, and UTF-16
string. The CDJ emitted one request after each keyboard edit and reconnected
after every invalid response from the then-unpatched server.

## Patched CDJ-3000 Search and browse session

Source:
`/tmp/music-djlink-search-retry-20260727T144222Z.pcapng`

Bytes: `91,703,928`

SHA-256:
`7d15687d8741cc4137a1752816678c2d9c369c2bcc02e80f29cac814024fac12`

The physical player-3 trace contains 173 correlated RemoteDB renders across
multiple deck-owned TCP sessions: 173 matching menu headers, zero mismatches,
zero missing headers, six nonzero cursors, and no TCP sequence gaps. The paired
server trace records 16 accepted `INCREMENTAL_SEARCH(0x1500)` edits and no
`INVALID_REQUEST(0x4003)`.

One connection (`169.254.7.4:59154`) handled `DA`, a 25-row render, interleaved
artwork/metadata/PWV4 requests, then `DAF` and another 25-row render without a
Back request. Another session rendered the 92-result `RAFAEL` search while
continuing metadata, artwork, and browse requests on the same socket. The deck
can close or replace browse sockets as part of normal navigation; unlike the
pre-patch trace, closure is not coupled to a rejected keyboard edit.
