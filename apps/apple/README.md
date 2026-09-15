# Native DJ Booth

SwiftUI applications for macOS and iOS, sharing `DJBoothKit`. The interface follows the existing
workstation palette and dense library layout. Apple system glass is used for controls; track
content stays opaque. Waveforms display real Rekordbox analysis, including frequency colours.
Mobile shows plain playlist and track lists, with inline notes, color, and the player pinned at the bottom.
On iPhone, the welcome screen starts **Continue with Nanocodex** for SMS sign-in and connection approval. The app saves the login in Keychain and isolates libraries, downloaded media, playback, and pending imports by account. **Ask DJ Booth** in the library opens the connected agent. Its read-only phone tool queries live tracks, playlists, favorites, notes, playback, queue, downloads, sync conflicts, and imports, including unsynced edits. The phone must remain in the foreground; backgrounding, signing out, or switching accounts detaches its tools. Existing logins must reconnect once to approve the phone tool catalog. Spotify and SoundCloud remain optional connections in the same approval flow. Signing out returns to the welcome screen; existing offline libraries remain separate. Use `djbooth cloud login` and `djbooth cloud publish` to publish your Mac library deliberately.
On iOS, **Open USB library** at the top of the playlist browser opens a folder picker.
Connect a USB stick and choose its top-level folder containing `PIONEER` once. The app remembers
that folder grant and checks for reconnects/catalog changes while foregrounded and on activation.
iOS requires the initial folder permission; it cannot silently open an arbitrary newly connected stick.
`PIONEER/rekordbox/export.pdb` playlists open in the normal library with their nested folders,
original order, BPM, keys, notes, colors, and available ANLZ waveforms/beat grids. USB tracks use
the normal player, queue, seeking, favorites, and playlist editing. Playback starts directly from
USB while verified audio caching runs in the background; completed downloads remain playable
after disconnecting the stick. Scrolling serializes analysis reads and updates only changed tracks.
CDJ histories retain repeated tracks in their original play order. The existing
`pnpm djbooth usb <mount>` workflow imports unseen histories into `master.db` and exports
them as dated `DJ Set` playlists; the phone refreshes them automatically.
App notes/colors and playlist edits survive reconnects. These edits use the normal local library
and sync outbox; security bookmarks and USB file locations remain device-local. The phone does
not write edits back to the USB database or export libraries to the stick yet.
OneLibrary-only (`exportLibrary.db`) sticks are explicitly reported as unsupported; a classic
Device Library export is required. Databases larger than 256 MB are currently unsupported.
The footer keeps a horizontally scrollable queue above the title, a moving eight-bar waveform,
and a one-sided full-duration waveform behind the track details. The focused view follows real Rekordbox
beat and downbeat positions, including tempo changes; tracks without a usable grid show an overview.
Drag the focused waveform left to seek forward or right to rewind. It previews under the fixed
playhead and seeks on release, preserving the queue and whether playback was paused.
Waveform display gain and its image are prepared off the UI thread and reused by both views; animation pauses when
playback stops or the app backgrounds, with a static overview for Reduce Motion. There is no
separate expanded player screen.
Playlist titles scroll away with their tracks; mobile has no navigation toolbar, filter chips,
search/sort controls, playlist thumbnails, or trailing row menus. Long press opens row actions.
Mobile uses native lists with solid rectangular swipe actions and UIKit gesture recognition.
Folders and playlists are real navigation-controller
destinations: dragging from the left edge reveals the previous screen, and cancellation keeps the
current screen. Playlist browsing supports folders, pins, and editing.
Track-row swipes add to a playlist or remove/archive;
playlist-row swipes pin or request deletion. Long-press menus also expose these actions.
Removing a track from a playlist requires confirmation. A compact Undo bar stays above the player
until dismissed; successive removals can be undone in reverse order. Undo restores membership and
position using the latest playlist, preserving other edits and downloaded audio.
The player swipes between recordings. Motion follows Reduce Motion settings.
The device remembers the track, ordered queue, playback position, and library selection; reopening
restores them paused, using downloaded audio without a network request. On Mac, connection settings
and sync conflict resolution are available from the library toolbar.

Run from the repository root with `pnpm native:dev` or `pnpm native:ios`. Device installation,
simulator selection, and launch options are documented by `pnpm native:device --help`.
Use `pnpm native:device --optimized` for an optimized development install; this enables Swift `-O`
while retaining the existing Debug provisioning and offline-download behavior. The same flag is
available for native builds, runs, and UI tests.
The checked-in `DJBooth.xcodeproj` contains macOS and iOS schemes. Xcode 26 or later is required
to build; deployment targets are macOS 14 and iOS 17. Mac and physical-device builds require a local
Apple Development signing certificate; stable Mac signing keeps saved credentials accessible
across rebuilds. The simulator uses ad-hoc signing. The development team can be overridden with
`DJBOOTH_APPLE_TEAM`.

Each device has its own SwiftData/SQLite library and transactional sync outbox. Collections,
favorites, comments, and colors work offline. Audio is saved in Application Support, addressed and
verified by SHA-256, and excluded from device backups. Cloud credentials live in Keychain. Cloud URL changes select
isolated local stores; background workstation discovery is cached without automatically publishing
it.
Cached playback never waits for sync or a server request. Server failures leave local browsing,
playback, and edits available without a blocking alert; the transactional outbox retries later.
Database opening, waveform decoding and display preparation, and audio-session activation run away
from the main actor. SwiftData's writable context and native player/UI controls keep their actor ownership.
Waveform RGB values use compact byte storage with the same cloud JSON; unchanged snapshots and
small row waveform summaries are reused instead of rebuilding the library on playback updates.

The Mac uses the existing loopback API for library reads and guarded mutations. Acquisition and
account authorization run through the public djbooth CLI. Debug development builds locate the
repository; distribution builds require an installed `djbooth` engine. Local imports use provider accounts on
the Mac. Cloud imports use provider credentials configured as Worker secrets. The iPhone starts playlist imports in dedicated Cloudflare Containers and shows durable progress,
retry, and offline-download actions. It receives metadata, collections, and acquired audio through the
Cloudflare service in `apps/cloud`; it does not expose or connect to an unauthenticated LAN server.

`pnpm native:test` tests persistence, conflict handling, retries, transport and media chunks.
`pnpm native:check` compiles both platforms. `pnpm native:test:ui` runs native simulator tests.
`pnpm native:test:usb --simulator <uuid>` creates an isolated fake Rekordbox `master.db`,
exports simulated USB folders through `pnpm djbooth usb`, then renames/reorders a playlist
through `pnpm djbooth playlist` and syncs again. The iOS tests cover metadata, playlist order,
automatic refresh/reconnect, missing/corrupt libraries, and OneLibrary-only errors.
A second synthetic source contains playable MP3/FLAC tones and deterministic ANLZ; it tests
real playback, seeking, notes/colors, relaunch, and cached playback after disconnect.
Generating this fixture requires `ffmpeg` on PATH.
The round-trip test also appends a simulated CDJ history, syncs twice through the CLI, and
checks the dated playlist, repeated tracks, and exactly-once play counts in the fake database.
SHA-256 checks verify that browsing leaves every source and USB file unchanged. The simulator replaces
only folder selection; real folder reads and parsing are used. Hardware and Files-provider
permissions still require a connected-device check. `--prepare-only` retains the fixtures
without launching a simulator. All fixture paths are printed; no real library is opened.
On a simulator with downloaded library audio, run
`TEST_RUNNER_DJBOOTH_REAL_PLAYBACK_TEST=1 pnpm native:test:ui` to also verify cached playback,
seeking, and restoration after relaunch. The audio check is skipped in ordinary fixture runs.
`--demo` is an explicitly labelled Debug-only sample library, isolated in memory with no network
or acquisition activity. Release builds ignore it. Production data is never replaced by fixtures.

This is the native library/listening surface. The existing web workstation retains its advanced
two-deck mixing, cue editor, stems controls, USB management, and assistant while those interfaces
are migrated. The shared acquisition, analysis, and Rekordbox engine remains authoritative.


## Local Connect integration test

Start the local test Worker in one terminal:

```sh
pnpm --filter @gakonst/djbooth-cloud test:mobile-server
```

Then run on a dedicated empty simulator (pass its UUID):

```sh
pnpm --filter @gakonst/djbooth-apple test:ui --simulator <uuid> --only-testing DJBoothUITests-iOS/ConnectUITests
```

The test uses the real browser Connect SDK, system authentication sheet, one-time
code exchange, Keychain, native chat, and Worker/D1 account isolation. Only the
Nanocodex approval and agent boundary is simulated, with Alice/Bob fixture accounts.
It does not connect real Spotify/SoundCloud accounts, download music, or spend money.
The test skips when its fixture is absent; use an empty dedicated simulator to avoid
mixing previous sessions. Fixture servers listen only on loopback ports 8791/8792.
