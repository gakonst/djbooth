# DJ Link Golden Packets

Hex payloads only; Ethernet/IP/UDP headers are intentionally excluded.

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

## Live CDJ-3000 incremental Search

Source:
`/tmp/music-djlink-search-final-hardware-20260727T0637Z.pcapng`

SHA-256:
`44c8e136cb540ac7d9c2cad5040f053dc58509f316c15a0e39e2b230a75c84a7`

- `remotedb-cdj3000-incremental-search-rafa.hex`: frame 145387, player 3
  request `0x1500`, transaction `0x09aa`, query `RAFA`.

The four arguments are packed `r:m:s:t`, sort, UTF-16 byte length, and UTF-16
string. The CDJ emitted one request after each keyboard edit and reconnected
after every invalid response from the then-unpatched server.
