# DJ Link Protocol Invariants

These are the behaviors that must remain true while refactoring `djlink.rs`.

## Discovery

- The server advertises one rekordbox source: player 17, slot 4, track type 1.
- CDJs discover the source through status keepalive/link-init packets on UDP 50002.
- Media details `0x06` and source extension `0x47` are emitted only in response to deck queries;
  unsolicited replies are not discovery heartbeats.
- Portmap advertises mountd on the configured UDP mount port and NFS on UDP 2049.
- Mount/NFS replies must work over UDP. TCP-only NFS is not sufficient for the CDJ path.

## RemoteDB

- RemoteDB listens on the configured database port and returns that real port to CDJs.
- `SETUP` and `INTRODUCE` are connection setup and must not mutate browse/load state.
- Each RemoteDB TCP connection owns exactly one prepared menu: the last successful menu setup
  request on that connection. A later setup replaces it; another connection cannot read or replace
  it.
- `RENDER` must use the prepared menu's exact `r:m:s:t` context. Its `MENU_HEADER` second argument
  echoes the requested offset; hard-coding zero leaves the CDJ cursor transaction stale.
- A hardware capture gate must exercise at least one nonzero RENDER and correlate every
  MENU_HEADER by transaction ID. The original native capture passes; the known Back-button
  failure has three exact nonzero-offset mismatches.
- Reconnects do not inherit or recover render state. A new connection must prepare its own menu
  before rendering.
- Legacy `SEARCH(0x1300)` and CDJ-3000 incremental `0x1500` requests receive the deck's context
  plus UTF-16 query and must render matching rows with loadable track IDs. Incremental keyboard
  edits must stay on one connection; a rejection/reconnect per keystroke is a protocol failure.
- `MOUNT_INFO` is a load-sensitive metadata request. Repeated `MOUNT_INFO` for the same
  target track is idempotent while a confirm session is active.

## Loading

- Latest different-track intent wins. A new track cancels the old pending confirm session.
- Same-track duplicate intent reuses the active generation and may only upgrade
  `require_playing`; it must not spawn another sender loop.
- Load-track ACKs are telemetry, not commands. They are logged only on state transition or
  rate-limited debug/trace events.
- Confirm sends are bounded. The server must never run unbounded load retry loops.
- When the deck ACKs and starts requesting metadata, ANLZ, waveform, or NFS audio for the
  target, the server considers protocol progress observed even if CDJ status has not yet
  emitted `playing`.
- Pressing Back must not be required to free protocol progress.

## NFS

- File handles are stable across process restarts for the same registered path.
- Reads are chunked and served from local files only.
- Local/preanalyzed ANLZ and artwork can be served; live artwork network fetching is not part
  of the DJ Link hot path.
- NFS read progress for a target track is stronger load evidence than browse/render progress.

## Telemetry

- Status and beat packets update the latest snapshot per player.
- Logging uses normal `tracing` events and spans with structured fields.
- Protocol state must not depend on a custom logger, stringly log dispatch, or log side effects.
