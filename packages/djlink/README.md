# @gakonst/djlink

Typed `music-ts` bridge to the native Pro DJ Link implementation imported from `djskills`.
It projects a completed Tracks manifest into a DJ Link library, serves each verified local
recording plus its Rekordbox ANLZ files through RemoteDB/NFS, discovers CDJs, and sends bounded
track-load requests.

```text
Tracks manifest
  -> TypeScript snapshot projector
  -> managed native daemon
  -> DJ Link discovery + RemoteDB/NFS
  -> connected CDJ load/cue
```

The detached daemon has one protected Unix control socket and serves one manifest at a time. It
does not enable beat clock, automatic database loading, load-confirm experiments, auto-unlock, or
private packet replay.

## CLI

Use the complete direct Rekordbox library by default:

```sh
music djlink rekordbox --format json
music djlink rekordbox "Artist - Track" --player 3 --format json
```

Without a selector, `rekordbox` validates direct read-only master.db ingestion, starts or resumes,
requires at least one discovered deck, and exposes the complete folders/playlists/artists/albums/
tracks hierarchy. With a selector it also resolves and cues the track. Use `run` for a completed
ad-hoc manifest before its recordings are imported. Both leave PLAY physical. Stage commands remain
for partial workflows and diagnosis:

```sh
music djlink run ./set/manifest.json 4 --player 3 --format json
music djlink doctor ./set/manifest.json --format json
music djlink start ./set/manifest.json --format json
music djlink status --format json
music djlink devices --wait-ms 5000 --format json
music djlink probe 169.254.7.4 --format json
music djlink load 4 --player 3 --format json
music djlink search "Science Fiction" --mode track --format json
music djlink monitor --player 3 --format json
music djlink stop --format json
```

`doctor` validates the native helper, local audio, and DAT/EXT/2EX paths without joining the DJ
Link network. `start` auto-selects a link-local interface when available. `devices` waits briefly
for announcements. If discovery is empty, `probe` sends one bounded ARP request to a known deck IP
on the selected interface; it does not send a DJ Link control command. `load` accepts manifest
order, native ID, Spotify ID, title, or artist-title; it cues the local recording and returns
`playing: false`. `search` exercises the same prewarmed matcher and RemoteDB row builder used by
the CDJ, without changing deck or library state, so index failures can be separated from deck UI
activation failures. Press PLAY on the physical deck.

`MUSIC_DJLINK_STATE_DIR` changes the daemon state directory. `MUSIC_DJLINK_BINARY` selects an
explicit native helper. `--bind-ip` and `--broadcast-ip` are diagnostic overrides.

## Spotify boundary

This package never reads or streams Spotify audio. Spotify IDs are metadata used to identify an
independently acquired local recording. For licensed Spotify playback, use Spotify Premium through
rekordbox Performance mode with internet access. Rekordbox does not permit its Spotify streaming
tracks in LINK EXPORT, USB export, or offline storage.

See AlphaTheta's
[Spotify announcement](https://rekordbox.com/en/2025/09/rekordbox-for-mac-win-spotify-support/),
[streaming FAQ](https://rekordbox.com/en/support/faq/streaming-7/), and
[Pro DJ Link guide](https://support.alphatheta.com/en-US/articles/4404617679129?product=4416175863961),
plus Spotify's [developer policy](https://developer.spotify.com/policy).

## Development

macOS, Node.js 22, pnpm, Rust nightly formatting, and a stable Rust toolchain are required.

```sh
pnpm --filter @gakonst/djlink native:build
pnpm --filter @gakonst/djlink native:run --help
pnpm --filter @gakonst/djlink check
pnpm --filter @gakonst/djlink build
```

The provenance-tracked Rust source under `native/` is the protocol lab and authoritative
implementation. Packaged installs contain its compiled platform helper instead of the source tree.

### Source/pcap iteration

Use two captures:

- `--wire-pcap`: source-owned libpcap of every Ethernet frame successfully injected through raw
  BPF. This is required because macOS does not expose those writes to a separate `tcpdump`.
- `tcpdump`/Wireshark on the wired interface: external truth for deck replies and kernel-routed
  traffic.

Start the vendored source directly:

```sh
cargo run --manifest-path packages/djlink/native/Cargo.toml -p music-djlink -- \
  serve \
  --snapshot /Users/gakonst/.local/state/music-ts/djlink/library.json \
  --socket /tmp/music-djlink-lab.sock \
  --bind-ip 169.254.253.33 \
  --broadcast-ip 169.254.255.255 \
  --name music \
  --model rekordbox \
  --log-path /tmp/music-djlink-source.log \
  --wire-pcap /tmp/music-djlink-source.pcap \
  --require-analysis
```

Capture deck ingress separately, replacing `en11` with the selected wired interface:

```sh
sudo tcpdump -ni en11 -U \
  -w /tmp/music-djlink-live.pcap \
  'udp port 50000 or udp port 50001 or udp port 50002'
```

Recover the original native Rekordbox capture by immutable git object; the similarly named current
`djtools/rb-tracks.pcap` is a later, different recording:

```sh
git -C /Users/gakonst/github/gakonst/djtools \
  show 123e84e:rb-tracks.pcap > /tmp/rekordbox-rb-tracks-native.pcap

cargo run --manifest-path packages/djlink/native/Cargo.toml -p music-djlink -- \
  audit-pcap \
  --pcap /tmp/music-djlink-source.pcap \
  --reference /tmp/rekordbox-rb-tracks-native.pcap \
  --require-core

cargo run --manifest-path packages/djlink/native/Cargo.toml -p music-djlink -- \
  audit-pcap \
  --pcap /tmp/music-djlink-live.pcap \
  --require-remote-db-cursors
```

`--require-core` requires the periodic source keepalive, link-init, and mixer-status shapes.
UDP/50002 `0x06` and `0x47` are reported as response-gated: they appear only after deck `0x05` and
`0x46` requests. The audit reports exact static-payload matches for `0x16`, `0x29`, and `0x47`.
`--require-remote-db-cursors` requires a captured nonzero RENDER and verifies that every
same-transaction MENU_HEADER echoes its requested offset; it rejects the proven `[1,0]`
TRACK SEARCH/Back-button failure. The patched physical CDJ-3000 capture passes with 173 matching
renders, six nonzero cursors, zero missing/mismatched headers, and no TCP sequence gaps; its paired
trace contains accepted `0x1500` edits interleaved with artwork, metadata, and ANLZ requests.
Golden payloads, capture hashes, and the wire contract live in
`native/crates/djtools-link/tests/fixtures/` and `native/crates/djtools-link/PROTOCOL.md`.
