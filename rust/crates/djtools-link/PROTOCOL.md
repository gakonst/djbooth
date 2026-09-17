# Pro DJ Link Wire Contract

Scope: the CDJ-3000 path implemented by `djtools-link`. This is an observed,
unsanctioned protocol. Captures are authoritative; upstream projects are
cross-checks.

## Evidence order

1. Local CDJ-3000 pcaps and Rekordbox traces.
2. Deep Symmetry packet analysis and Beat Link source.
3. `alphatheta-connect` / `prolink-connect` source and their attributed fixtures.
4. Hypotheses, explicitly marked and excluded from safe defaults.

Pinned upstream revisions:

- Deep Symmetry Beat Link:
  `a6d3945d42f081313fb7a38c8757e1892fa52c13`
- Deep Symmetry Dysentery:
  `f62a24ba947f9db4c1553bb2dc3ba76de1fecbb4`
- alphatheta-connect:
  `cee99ae61572eef513e52a90961cfdc48944eb8a` (v0.26.1)
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

## Stagehand peer

The Stagehand path follows Deep Symmetry's 2026 capture rather than posing as a
second virtual CDJ:

- broadcast `0x0a` three times, then `0x02` three times, then `0x06` every two
  seconds;
- claim marker `0x3a`, protocol marker `3`, device type `5`, model code `0x20`,
  and a runtime number in the observed 141–211 range;
- use a distinct link-local IP, a locally administered link-layer MAC for
  Ethernet/ARP, and a separate AlphaTheta-OUI protocol MAC inside `0x02`/`0x06`;
- answer ARP for the isolated identity and receive its unicast traffic through
  promiscuous BPF on macOS.

Those values are one app-launch identity. `djbooth serve` creates independent
network and protocol randoms once in its long-lived supervisor and passes both
to every replacement native worker. The complete link-local alias is stable
even if macOS assigns the Ethernet interface another address after a hardware
restart. A worker crash therefore does not strand A9/CDJ unicast streams on a
dead identity. After mixer traffic goes silent, keepalives pause for ten seconds
before the full claim sequence is replayed, matching the fresh-launch behavior
the A9 accepts. This is lifecycle state in parent memory, not library or
workflow state.

Status-port heartbeats are separate from those presence packets. The pinned
alphatheta-connect revision adds captured Stagehand `0x3a` mixer and `0x68`
player payloads sent from UDP/50002 to UDP/50002 every 250 ms. Our shared Rust
session now sends these after claiming its identity, and pauses both presence
and heartbeats during the ten-second peer-expiry interval. Byte tests compare
against the upstream capture fixtures. This is upstream capture evidence;
the new phone path still needs a local A9 control-stream observation.

A live DJM-A9 capture verified 266-byte `0x39` control frames and the decoded
trim, EQ, Color FX, fader, assignment, and crossfader fields. Deep Symmetry
describes 584-byte `0x58` frames as the likely VU stream, but the local A9 did
not emit them during active CH1 playback. Their body remains experimental and
must not be treated as a confirmed Ethernet meter source.

### iPhone transport verification

The phone must call this same Rust Stagehand session and consume
`subscribe_mixer_telemetry`; Swift does not implement its handshake or decoder.
The desktop's isolated BPF identity is not available on iOS. The mobile binding
can select the existing kernel UDP transport using its assigned interface IP.

With a shared source IP, directed Stagehand presence is restricted to the A9;
CDJs receive only the Rekordbox identity plus status-port telemetry requests.
The 2026-09-17 capture `session-1789628315629-B12ED188-C4CC-49C9-9FBC-C1545577DDB4`
showed both Rekordbox/player 17 and Stagehand/player 177 announced to both CDJs
from `169.254.46.112`. Each deck opened six RemoteDB sessions in about 15 seconds,
alternating between decks. This is evidence of a conflicting identity and
session churn. The follow-up hardware capture
`session-1789628823962-DE655B2F-F3C1-4BA5-8BC2-5AE9B2FE9E13`
confirmed suppression on both CDJs, continuous discovery until cable removal,
and playing status from both decks. The periodic two-second INTRODUCE loop was
absent: each deck introduced once, followed by actual playlist, metadata, ANLZ,
and audio reads. There were still three RemoteDB connections per deck, including
client close/teardown requests; this is not evidence of zero reconnects. Three
MENU_OFFSET requests were handled, but the capture alone does not verify the
cursor visually returning to the correct item. Observation lasted 31 seconds.
The same plug still took 21.445 seconds to receive IPv4, followed by 73 ms to
serve and 0.97 seconds to list both decks. Address-assignment latency remains.
Desktop continues its full Stagehand join from its distinct IP. On the phone,
extended telemetry that requires a separate Stagehand registration (including
key shift) is not guaranteed by the heartbeat-only path; normal CDJ status and
library service remain active. Do not restore duplicate presence to obtain it.

#### Wired address assignment precedes DJ Link discovery

The 2026-09-17 UTC phone trace distinguishes three stages: `interface_scan_changed`
first records USB `en5` with only an AF_LINK entry at `1789626884695`; its IPv4
entry appears at `1789626905983` (21.288 seconds later); `cdj_serving` follows at
`1789626906073`. The first deck's RemoteDB connection opens at `1789626906712`.
Do not report discovery timer improvements as eliminating the address-assignment wait.

AlphaTheta's [iOS FAQ](https://rekordbox.com/en/support/faq/ios/#faq-12293)
documents approximately 20 seconds before wired communication starts. Apple's
[DHCP implementation](https://github.com/apple-oss-distributions/bootp/blob/main/IPConfiguration.bproj/dhcp.c)
allocates a link-local address after a retry threshold; the
[defaults](https://github.com/apple-oss-distributions/bootp/blob/main/IPConfiguration.bproj/ipconfigd.c)
use four retries and exponential backoff. This is consistent with the observed
pre-IPv4 delay, not evidence of a 20-second timer in our Rust server.

An on-device check in the signed development app returned `EPERM` for both
opening `/dev/bpf0` and creating an IPv4 raw UDP socket (effective UID 501).
`network_diagnostics().raw_transport_capabilities` records these read-only
checks once per process. The desktop raw transport cannot be enabled merely
by adding Swift bindings. A manual phone address or an available DHCP server
would change address acquisition, but neither has been verified as a remedy
on this CDJ USB connection. No automatic app-only bypass is currently verified.

The initial 2026-09-16 iPhone 17 Pro test, connected through a CDJ-3000's rear USB port,
received A9 announcements and on-air packets but no `0x39` control stream.
Directed Stagehand announcements, the original subnet broadcast handshake, and
a Stagehand-only limited-broadcast probe all returned zero mixer events. The
broadcast sends succeeded at the socket API; this does not prove transmission
on the mixer-facing Ethernet network. Do not call this path hardware-verified
or replace missing control values with defaults.

Those probes preceded the status-port heartbeat addition. The new phone-only
candidate uses directed Stagehand claims and heartbeats to discovered A9s,
with the assigned interface IP and a deterministic protocol identity at that
IP. CDJs continue to receive the Rekordbox library identity; no player heartbeat
is sent from the shared phone address. Unknown-peer probes use link-init before
choosing an identity. This route uses ordinary unicast UDP, needs no Mac relay
or mixer USB connection, and Swift only enables the existing Rust session.
After unlocking, the unicast build discovered both CDJs in 0.52 seconds and
the A9 in 1.31 seconds after sharing started. A 69-second app transport capture
records 122 outgoing `0x3a` heartbeats from `169.254.150.65:50002` to
`169.254.69.43:50002`, with a median 250 ms interval outside rejoin pauses.
The A9 sent 35 ordinary keepalives and 231 on-air packets, but no paired
keepalive, `0x39`, or `0x58`. A separate mixer subscription also returned zero
events. The heartbeat addition alone did not fix A9 monitoring through this
CDJ USB connection. Socket-level TX evidence does not establish delivery on
the mixer-facing Ethernet segment.

That development profile lacked the Multicast Networking entitlement. Apple
still listed the request as Submitted, and Xcode refused an entitled build.
A separately copied app, manually development-signed with the entitlement,
passed local `codesign --verify --deep --strict` but the physical phone rejected
installation with `ApplicationVerificationFailed` / `0xe8008015` (no valid
provisioning profile). Sideloading did not bypass profile authorization.
[Apple requires that entitlement for iOS UDP broadcast/multicast](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy).
Approval is a prerequisite for testing the supported broadcast path, not proof
that it will resolve every transport or shared-identity issue. Unicast CDJ
library sharing remains independent of Stagehand monitoring.

A second phone-only experiment tested the SDK compatibility exception in
[Apple XNU's multicast check](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/net/necp.c#L7727).
A separate development-signed copy reported SDK 13.7 in its Mach-O build
commands and enabled the broadcast path, without adding an entitlement. It
installed and ran on iOS 26.6.1. Over 138 seconds, the app capture records 263
A9 heartbeats and seven broadcast claim sequences, but still no paired
keepalive or mixer telemetry. This does not establish that the compatibility
exception took effect on that OS or that broadcasts reached the A9. The
normal SDK build was restored; no SDK rewriting is part of repository tooling.

Local evidence (2026-09-16):

- `session-1789593242795-509DE8A0-49B0-4B2F-ADB1-738EA0ECB4D9`,
  `transport.jsonl` SHA-256 `c86778ff253f9b01f61feeb75f4a84e1f0ab01eef5786d552d3f6497f9c5e7fd`.
- `session-1789593326302-36064FE1-0B08-464B-8C1A-2FBFA964C72C`,
  `transport.1.jsonl` SHA-256 `14d62f1ded12d4d5d717e446b72f857d15332b517c3db39693149c31725ea7ea`,
  `transport.jsonl` SHA-256 `ea1f6751f922ce09ef1475393c92a87177d06480bee99b0b05b1848d9f900c8a`.

### Stagehand isolation tests and next capture

Two additional 2026-09-16 phone tests disabled Rekordbox announcements and
link-init entirely. Directed Stagehand registration/heartbeats to both CDJs
and the A9 received 243 extended 1116-byte CDJ status frames over 30.9 seconds,
but the A9 supplied only 104 on-air frames and 16 ordinary keepalives. The
broadcast-only SDK compatibility variant received 321 extended CDJ statuses,
125 A9 on-air frames and 19 ordinary keepalives over 37.3 seconds. Neither
capture contained A9 paired keepalives, control frames or VU frames. These
results do not establish that the A9 received the outgoing registration.
The experiment changes are not production behavior. An A9 restart to test
retained peer identity was requested but had not been confirmed.

Diagnostics now persist a five-second network context (interface, addresses,
Stagehand identity, devices, bounded resolved-neighbour hints or their access
error), cumulative packet counts, first-seen packet patterns, and structured
Stagehand join/retry events. Counters do not split streams when hardware changes
its UDP source port. Pattern overflow, recorder queue drops and write failures
are explicit. A 100-byte A9 presence packet is labeled a *paired keepalive
candidate*, not proof that it names our current identity. Socket TX counts mean
kernel acceptance, not Ethernet delivery.

`diagnostics.snapshot` creates closed copies on the Rust writer thread, with a
manifest, traffic summary and the retained JSONL segments. Two exports are
retained separately from live-session rotation. The native diagnostics tool's
`--snapshot` option requests this export from the open hardware-test app before
copying it, avoiding races with live file appends/rotation. The generated
`server.network_diagnostics` and `server.resolved_neighbours` bindings expose
the same Rust network inspection on the phone; Swift adds no packet decoder.

Verified on the iPhone with normal track sharing restored: both CDJs and the
A9 appeared in network diagnostics, including resolved-neighbour hints for
all three. The closed export downloaded successfully with zero queue drops,
write failures or untracked patterns. Its 13 send errors were discovery probes
to stale `169.254.6.175`, not the A9. A9 presence/on-air traffic was captured;
control/VU traffic remained absent. Startup verified 57 generated server
methods and 11 functions against the Rust inventory.

## alphatheta-connect audit, 2026-09-16

Compared the pinned v0.26.1 sources, recent fixes and wire tests against our Rust
implementation. The relevant differences are below; upstream implementation
claims are not substitutes for a local deck capture.

| Area | Finding and disposition |
| --- | --- |
| Stagehand heartbeats | Missing here. Added shared Rust mixer/player builders and 250 ms status-port sends using the upstream capture bytes. Phone targets only the A9 to preserve its CDJ library identity. |
| Reconnect identity | Desktop already retains supervisor-owned nonces. Kernel UDP sessions now derive default nonces from their assigned IP instead of changing identity on every restart. Explicit caller nonces still win. |
| Mixer model isolation | Upstream warns that A9 layouts are not valid on XDJ-AZ. Our exact-length/opcode checks now also require the `DJM-A9` model before decoding controls or experimental VU. |
| Position packet isolation | Stagehand multiplex packets reuse `0x0b`. Our position decoder now excludes the Stagehand peer marker; regression coverage prevents a telemetry frame from moving the playhead. |
| Cue list bounds | Both Rust cue converters skipped invalid types but counted only emitted entries against the declared input count. They now count consumed entries separately and reject truncated declared arrays. Regression tests cover skipped entries followed by out-of-array data. |
| Hot cue button / phrase parsing | Our ANLZ-to-wire conversion already reads the hot cue ID separately from cue/loop type. PSSI already has a typed parser and obfuscation coverage. Do not copy the historical upstream field-name bugs. |
| Effective pitch | Our deck BPM uses pitch at `0x8c`; upstream recently corrected its swapped effective/local pitch values. Preserve our current mapping. BPM-sync and local slider pitch are useful additional public telemetry fields, but are not added by this patch. |
| Precise position values | Upstream divides pitch by 6400 and reads BPM at `0x30`; our decimal-100 scaling and `0x38` BPM follow the existing wire contract. Deep Symmetry explicitly gives 326 → 3.26%. Do not port upstream's arithmetic. |
| Six-channel on-air | Upstream offsets/length checks differ: it requires 54 bytes for the six-channel branch, while our 53-byte A9 packets are accepted. Keep the capture-backed Rust layout pending contrary evidence. |
| Cue comments, RGB, quantized loops | Upstream exposes these ANLZ fields. Our raw ANLZ serving retains them, but the synthesized extended RemoteDB cue response currently emits only the fixed entry fields. Variable-length conversion and time units need a native cue fixture before expanding it. |
| Other-device / streaming metadata | Upstream has a RemoteDB metadata client and streaming waveform fallback. Our phone booth primarily hydrates metadata from its own served library. Extending this needs source player + slot + type + track ID identity, since IDs can collide across libraries; copying a track-ID-only lookup is unsafe. |
| Remote controls / preferences | Upstream has typed pause, seek, skip and preference helpers. Rust has the captured transport builder and verified playback flow, but not equivalent typed end-to-end coverage for every operation. Add commands with target-status confirmation and shared bindings; do not enable arbitrary preference writes on discovery. |
| Three-band / RGB waveforms | Rust already serves PWV4/5/6/7 and uses detailed RGB with fallback for the local player. No replacement parser is needed for this task. |
| VU and all-in-one devices | Upstream advertises broader support, including passive pcap monitoring. Our A9 VU body remains experimental, and iOS cannot adopt the desktop BPF receiver unchanged. Neither claim establishes phone support. |

Audit sources:

- [Heartbeat implementation and capture provenance](https://github.com/chrisle/alphatheta-connect/blob/cee99ae61572eef513e52a90961cfdc48944eb8a/src/virtualcdj/heartbeat.ts)
- [Heartbeat byte fixtures](https://github.com/chrisle/alphatheta-connect/blob/cee99ae61572eef513e52a90961cfdc48944eb8a/src/virtualcdj/heartbeat.test.ts)
- [Stable identity rationale](https://github.com/chrisle/alphatheta-connect/blob/cee99ae61572eef513e52a90961cfdc48944eb8a/src/virtualcdj/stagehand.ts)
- [Recent upstream changes](https://github.com/chrisle/alphatheta-connect/blob/cee99ae61572eef513e52a90961cfdc48944eb8a/CHANGELOG.md)
- [Upstream status and mixer decoders](https://github.com/chrisle/alphatheta-connect/blob/cee99ae61572eef513e52a90961cfdc48944eb8a/src/status/utils.ts)
- [Upstream ANLZ conversion](https://github.com/chrisle/alphatheta-connect/blob/cee99ae61572eef513e52a90961cfdc48944eb8a/src/localdb/rekordbox/anlz-parsers.ts)
- [Deep Symmetry position units](https://djl-analysis.deepsymmetry.org/djl-analysis/beats.html)
- [Deep Symmetry extended RemoteDB cues](https://djl-analysis.deepsymmetry.org/djl-analysis/track_metadata.html#_requesting_nxs2_cue_points_and_loops)

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

RemoteDB menu rendering is connection-local and keyed by `r:m:s:t` context.
A menu request replaces that context's buffer; `RENDER(0x3000)` slices it.
Metadata and delivery requests must preserve the browse context used by Back. The
same-transaction `MENU_HEADER(0x4001)` has arguments `[1, requested_offset]`,
followed by menu items and a footer. Native Rekordbox transaction `0x1883` in
git object `123e84e:rb-tracks.pcap` proves offset 2 → header `[1,2]`.
Cross-connection menu recovery and a constant header offset are not protocol
features.

Back selection uses `MENU_OFFSET(0x3100, [r:m:s:t, entry_id, 0, 1])`.
Respond with `SUCCESS(0x4000, [0x3100, zero_based_offset])` by locating
`entry_id2` in that context's prepared, sorted rows. Do not return the row's
one-based position or a constant zero: the latter resets Back to the first item.
Native Rekordbox 6.8.2 `PSvDBMain::OnListBuffCmd` (`0x1016396f0`) calls
`GetListBufOffset` (`0x1011eaa00`), which compares list column 2 and returns
the first matching offset, `0xffffffff` for an absent ID, or zero without a
row set. The September 16 phone trace shows this exchange for tracks, artists,
and parent playlists before the deck rebuilds and renders the list.

After loading or previewing a track, CDJ-3000 can send `DJ_ID(0x3006)` with
context `0x01090401`. This is a DJ identity request, not a source-availability
query. Native `PSvDBMain::OnUserCmd` returns binary message `0x4d02`: a 160-byte
identity when present, or a zero-length result when absent. DJ Booth uses the
native absent-identity form. Returning `SUCCESS(0x4000, [0x3006, 1])` was the
last exchange in the September 15 iPhone session where Back stopped working;
that response is invalid even though the write completed. Exact request bytes
and native-code provenance are recorded in `tests/fixtures/README.md`.

The September 16 phone capture then advanced to `DELIVERY_INFO(0x2602)` in
context `0x01090401`. Native Rekordbox prepares 13 delivery-information rows and
returns `SUCCESS(0x4000, [0x2602, 13])`, followed by the usual render exchange.
An unknown track yields zero rows. DJ Booth leaves unavailable delivery-specific
fields unset. Rejecting this request was the final browse exchange in that capture.

CDJ-3000 keyboard edits emit incremental search request `0x1500` with arguments
`r:m:s:t, sort, UTF-16 byte size, uppercase UTF-16 string`. Unlike the documented
legacy `SEARCH(0x1300)`, no trailing zero argument is present. Each successful
request returns `SUCCESS(0x4000)` carrying the original request type and result
count, then prepares those rows for `RENDER(0x3000)` on the same connection.
Rejecting `0x1500` caused the observed deck to close and rediscover RemoteDB after
each keystroke. Both request types use the same prewarmed matcher and row builder.

NFS must remain UDP and must support observed 64,512-byte reads. On macOS,
oversized UDP and broken link-local unicast routing require the proven raw BPF
Ethernet/IPv4/UDP fallback with IPv4 fragmentation.

## Network binding

Unicast discovery first probes a bounded cache of previously verified peers and
resolved IPv4 neighbours on the selected interface. Hints must be usable hosts
in the attached subnet; they never count as discovered until a valid DJ Link
reply arrives. Priority probes start immediately, repeat every 500 ms for five
seconds, then every two seconds. The existing subnet sweep remains the fallback
(128 candidates/s before discovery, 8/s while connected). Priority recovery is
independent of the sweep cursor and its reduced rate. The optional cache contains
at most 32 IPs, survives server/app restart, and is disposable transport state.
Apple route-table access can be denied; failure leaves cached probes and the
fallback scan working. `unicast_discovery_priority` and
`unicast_discovery_first_response` report hints and measured startup latency.

Every DJ Link socket is associated with the interface containing `bind_ip`.
On macOS, set `IP_BOUND_IF` before bind/send. A 2026-07-26 live trace showed
directed broadcast `sendto()` returning success while macOS emitted the packet
only on `lo0`; therefore broadcast is raw-BPF-first when the interface is
known. Kernel routing remains the first unicast path; raw BPF is the fallback
for route/host-down errors and oversized NFS datagrams. Periodic sends must
surface failures instead of discarding them. A bounded ARP request/reply probe
is the safe physical-presence check when an active link yields no announcements.

## Safe command boundary

Normal workflow may discover, browse, serve, load, and start a verified local
recording. Playback uses the byte-tested fader-start command and must be confirmed
from the target CDJ status before it is reported as playing.

Explicit phrase-aware preparation may also:

- decode the track's `PSSI` phrase analysis and `PQTZ` beat grid;
- expose a session-only RemoteDB memory cue at a selected grid beat;
- send `0x34` with Auto Cue Level `0x88` (Memory), Auto Cue `0x81` (on),
  and Tempo Range `0x83` (Wide);
- advertise a requested BPM in master mixer-status (`0x29`) and beat (`0x28`)
  packets, then unicast Sync On (`0x2a`, command `0x10`) to the target deck.

The command confirms load and playback from CDJ status and separately reports
whether the deck's effective BPM converged. Playback uses the observed
fader-start command; Stagehand transport candidates are supplementary and are
never reported successful without matching CDJ status.

Unsafe or unproven packets (`0x17` empty hot-cue bank, zero-valued `0x1b` CDJ
renew, arbitrary raw UDP) stay behind explicit unsafe commands and are never
emitted by discovery or browsing.
