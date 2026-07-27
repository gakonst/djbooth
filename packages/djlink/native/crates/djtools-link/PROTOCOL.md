# Pro DJ Link Wire Contract

Scope: the CDJ-3000 path implemented by `djtools-link`. This is an observed,
unsanctioned protocol. Captures are authoritative; upstream projects are
cross-checks.

## Evidence order

1. Local CDJ-3000 pcaps and Rekordbox traces.
2. Deep Symmetry packet analysis and Beat Link source.
3. `prolink-connect` source.
4. Hypotheses, explicitly marked and excluded from safe defaults.

Pinned upstream revisions:

- Deep Symmetry Beat Link:
  `a6d3945d42f081313fb7a38c8757e1892fa52c13`
- Deep Symmetry Dysentery:
  `45ad4c09667abf3d502c258113465e5fcacaa3fd`
- prolink-connect:
  `4eda63b94454635a88469de297d7a514520b965a`

Golden payloads and exact pcap hashes live in `tests/fixtures/`.

## Common magic

All covered DJ Link application payloads begin with the ten ASCII bytes
`Qspt1WmJOL`.

The remainder is not one universal header:

- UDP/50000 keepalive packets use a little-endian 16-bit type at `0x0a`.
- UDP/50001 and UDP/50002 packets use an 8-bit type at `0x0a`; the model starts
  at `0x0b`.

Code must parse those families separately.

## UDP/50000 device keepalive

Observed CDJ-3000 keepalive: exactly 54 bytes.

| Offset | Size | Meaning |
| --- | ---: | --- |
| `0x00` | 10 | magic |
| `0x0a` | 2 | type, little-endian; `0x0006` config/keepalive |
| `0x0c` | 20 | NUL-padded ASCII model |
| `0x20` | 1 | protocol marker, observed `1` |
| `0x21` | 1 | device kind, observed `3` |
| `0x22` | 1 | reserved, observed `0` |
| `0x23` | 1 | subtype, `0x36` status |
| `0x24` | 1 | player number |
| `0x25` | 1 | player type |
| `0x26` | 6 | MAC address |
| `0x2c` | 4 | advertised IPv4 address |
| `0x30` | 1 | peer count |
| `0x31` | 3 | observed `00 00 00` |
| `0x34` | 1 | device type |
| `0x35` | 1 | observed `0x64` on CDJ-3000 |

Transport source IPv4 is the routing identity. The advertised IPv4 must be
retained and mismatches must be logged; it must not silently redirect replies.

Devices expire after ten seconds without a keepalive. A virtual source must not
reuse player numbers already observed.

## UDP/50002 update/status

- `0x05`: media/link query
- `0x06`: media/link reply
- `0x0a`: CDJ status
- `0x19`: load-track command
- `0x1a`: load acknowledgment
- `0x34`: load settings; never implicit in normal browse/load
- `0x46`: CDJ source-extension query
- `0x47`: source-extension reply; unicast only after `0x46`

CDJ status is at least `0xa7` bytes for the common fields. CDJ-3000 extended
fields are optional and decoded only when their full byte range is present.
Short packets are errors, not partially initialized status objects.

Load ACK is acceptance telemetry. Completion requires target status movement
and/or target NFS audio progress; ACK alone is insufficient.

The real Rekordbox capture sends `0x06` after a deck `0x05` link query and
`0x47` only after a deck `0x46` query. `0x47` remains strictly response-gated.
The server mirrors that request/response behavior and does not broadcast
unsolicited media replies. A 2026-07-27 three-deck cold start completed
`0x46`/`0x47`, RemoteDB port discovery, and TCP/1051 connection without periodic
`0x06`. Periodic source packets are keepalive `0x06`, link init `0x16`, and
mixer status `0x29`.

## RemoteDB and audio

- TCP/12523: RemoteDB port query.
- TCP/1051 by default: RemoteDB request/response stream.
- UDP/50111: portmap.
- UDP mount port: Mount v1.
- UDP/2049: NFS v2/v3.

RemoteDB menu rendering is connection-local. A menu request prepares the last
menu on that TCP connection; `RENDER(0x3000)` slices that menu. The
same-transaction `MENU_HEADER(0x4001)` has arguments `[1, requested_offset]`,
followed by menu items and a footer. Native Rekordbox transaction `0x1883` in
git object `123e84e:rb-tracks.pcap` proves offset 2 → header `[1,2]`.
Cross-connection menu recovery and a constant header offset are not protocol
features.

NFS must remain UDP and must support observed 64,512-byte reads. On macOS,
oversized UDP and broken link-local unicast routing require the proven raw BPF
Ethernet/IPv4/UDP fallback with IPv4 fragmentation.

## Network binding

Every DJ Link socket is associated with the interface containing `bind_ip`.
On macOS, set `IP_BOUND_IF` before bind/send. A 2026-07-26 live trace showed
directed broadcast `sendto()` returning success while macOS emitted the packet
only on `lo0`; therefore broadcast is raw-BPF-first when the interface is
known. Kernel routing remains the first unicast path; raw BPF is the fallback
for route/host-down errors and oversized NFS datagrams. Periodic sends must
surface failures instead of discarding them. A bounded ARP request/reply probe
is the safe physical-presence check when an active link yields no announcements.

## Safe command boundary

Normal workflow may discover, browse, serve, and load/cue a verified local
recording. Physical PLAY remains the default.

Unsafe or unproven packets (`0x17` empty hot-cue bank, zero-valued `0x1b` CDJ
renew, Stagehand candidates, arbitrary raw UDP) stay behind explicit unsafe
commands and are never emitted by discovery, browsing, or loading.
