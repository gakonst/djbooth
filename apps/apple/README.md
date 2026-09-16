# Native DJ Booth

SwiftUI applications for macOS and iOS, sharing `DJBoothKit`. The interface follows the existing
workstation palette and dense library layout. Apple system glass is used for controls; track
content stays opaque. Waveforms display real Rekordbox analysis, including frequency colours.
Mobile shows plain playlist and track lists, with inline notes, color, and the player pinned at the bottom.
On iPhone, the welcome screen starts **Continue with Nanocodex** for SMS sign-in and connection approval. The app saves the login in Keychain and isolates libraries, downloaded media, playback, and pending imports by account. **Ask DJ Booth** in the library opens the connected agent. Its read-only phone tool queries live tracks, playlists, favorites, notes, playback, queue, downloads, sync conflicts, and imports, including unsynced edits. The phone must remain in the foreground; backgrounding, signing out, or switching accounts detaches its tools. Existing logins must reconnect once to approve the phone tool catalog. Spotify and SoundCloud remain optional connections in the same approval flow. Signing out returns to the welcome screen; existing offline libraries remain separate. Use `djbooth cloud login` and `djbooth cloud publish` to publish your Mac library deliberately.
At the library root, swipe inward from the left edge to open the native side drawer over the current view.
UIKit owns the sidebar gesture, presentation, and dismissal; the current library remains behind it.
Choose **Playlists**, **Artists**, **Albums**, or **All Tracks**. Artist and album groups open their
tracks with a scoped playback queue; the edge gesture inside groups, folders, and playlists goes back.
Choose **Download → Paste → Download** to start a playlist/set import in the cloud. The sheet shows
submission confirmation, current progress, retry for failed jobs, and an **Open playlist** action when ready.
An unconnected phone can open cloud settings from the same sheet. The app can close while the import runs.
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
Assigned track colors appear beside the key badge; uncolored rows have no marker. Edit colors from the bottom player.
The bottom color square toggles a flat palette in the comment row immediately, with no popover or transition.
Choosing a color (or None) saves it and returns to the comment; tapping the square again closes the palette.
The mobile layout follows Apple's [typography](https://developer.apple.com/design/human-interface-guidelines/typography),
[accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility), and
[materials](https://developer.apple.com/design/human-interface-guidelines/materials) guidance while retaining the compact DJ palette.
System text scales with Dynamic Type, large-text rows stack their metadata, and primary touch targets are at least 44 points.
The player uses a native seek slider and a prominent system play button with opaque fallbacks for accessibility settings.
The slider and focused waveform share a live scrub position. During a drag, audio pauses and the player
prepares the latest position with one asynchronous seek at a time, following Apple's
[AVPlayer scrubbing guidance](https://developer.apple.com/library/archive/qa/qa1820/_index.html).
Release resumes the prior playback intent without repeating a completed seek; paused tracks remain paused.
Cancellation restores the original position, and switching tracks invalidates the old gesture.
Current-track symbols, selection marks, accessibility values, and optional lettered color swatches supplement color cues.
Long current-track titles scroll only when they overflow, using native Core Animation with pauses to read each end.
The animation pauses with playback or the app, resets for a new track, and becomes static with Reduce Motion;
VoiceOver always receives one full title. Short titles stay still.
The footer keeps a horizontally scrollable queue above the title, a moving eight-bar waveform,
and a one-sided full-duration waveform behind the track details. The focused view follows real Rekordbox
beat and downbeat positions, including tempo changes; tracks without a usable grid show an overview.
Drag the focused waveform left to seek forward or right to rewind. It follows the finger under the fixed
playhead, and dragging the timeline moves the same waveform immediately. Both preserve the queue.
Waveform display gain and its image are prepared off the UI thread and reused by both views; animation pauses when
playback stops or the app backgrounds, with a static overview for Reduce Motion. There is no
separate expanded player screen.
The native sidebar opens from the top-left button or a left-edge swipe at the library root.
It covers two thirds of the screen, including the player, and offers Playlists, Artists, Albums,
All Tracks, Download, Ask DJ Booth, Connect to CDJ, and Sync & settings. Artist/album selection
survives relaunch. Inside a folder, playlist, or group, the edge swipe goes back instead.
Playlist titles scroll away with their tracks. Long press opens row actions.
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
Cold launch starts opening the saved library while the first window is being created. It prepares
the restored page's first screenful of track waveforms and the last-played track's waveform before
showing the library, including the player's raster and compact row drawing data. Playlist, artist,
and album indexes need only the player's waveform. Offscreen waveforms load afterward and reuse
the already-decoded tracks without replacing the playing item or resetting its position.

To measure five process launches against a simulator's existing library and saved player, run:

```sh
TEST_RUNNER_DJBOOTH_STARTUP_RUN=$(uuidgen) pnpm native:test:ui --optimized --simulator <uuid> \
  --only-testing DJBoothUITests-iOS/DJBoothUITests/testCachedStartupPerformance
```

The test disables cloud/workstation sync, preserves the cached library, and verifies restoration of
the last track paused with its waveform available. Debug-only phase timings are written to the app container's
`tmp/DJBoothPerformance/<run UUID>.jsonl`; compare `app_begin` to `library_rendered` per process.
This interval starts in `App.init`, excluding OS work before the app enters Swift.
`first_render_waveforms_ready` must precede `library_rendered`; background completion is recorded
separately as `library_analysis_ready`.

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


## iPhone DJ Link development

The sidebar's **Connect to CDJ** embeds the shared Rust RemoteDB/NFS engine. It projects
locally downloaded audio and ordered playlists into an in-memory session. Content-addressed
hard links preserve audio extensions and stable exported paths across reconnects. The C ABI
uses the shared Rust ANLZ reader/writer only to relocate audio paths. Cloud publishing
uploads the existing desktop DAT/EXT/2EX files as immutable content-addressed objects;
normal phone sync downloads them for offline tracks independently of a deck connection.
The recording hash ties analysis to the exact audio. Sharing omits tracks whose audio or
analysis is missing. Connecting never decodes audio or runs analysis, and Swift implements
no ANLZ or DSP encoding. Original waveforms, seek tables, grids, phrases, and cues are retained.
Keep the app foregrounded: it disables idle sleep while sharing and disconnects on background
or interface loss. Its source player number is 17, matching the desktop server.

The native Xcode build compiles `djbooth-mobile` for the selected iOS architectures; install
those Rust targets with rustup first. Normal device builds retain their existing signing and
automatically discover decks using unicast DJ Link probes on the attached IPv4 subnet.
They use kernel UDP sockets for discovery and NFS, without the desktop BPF fallback.
Discovery is limited to actual /16–/30 subnets, probes at most 128 addresses per second,
checks the phone's /24 and low host addresses first, and repeats while foregrounded.
After a deck responds, scanning slows to fewer than eight candidates per second to keep
the USB adapter available for browsing and NFS. Darwin sockets reserve 128 KiB of send
buffer space for full-size NFS replies; the default 9 KiB limit rejects these datagrams.
A full /16 search can take about nine minutes; a /24 takes about two seconds per sweep.
Only valid CDJ/XDJ replies appear as discovered decks. USB interface detection, automatic
startup, deck discovery, and browsing have been observed on an iPhone 17 Pro and the
connected deck. Reliable playback and RGB display still require a hardware retest after
the offline artifact transfer and large-datagram fixes.

`pnpm native:device --device <id>` installs the automatic unicast build.
Wired network appearance starts sharing without entering addresses or opening the sheet.
Disconnect pauses automatic sharing until that connection disappears; foregrounding resumes
wired sharing. For Wi-Fi, select the connection in **Connect to CDJ**.

Optional broadcast discovery needs Apple's Multicast Networking entitlement assigned to
team and bundle ID `xyz.gakonst.djbooth`, a matching provisioning profile, and an Xcode account.
With that capability, use `pnpm native:device --device <id> --dj-link`.
`pnpm --filter @gakonst/djbooth-apple build:ios --physical --dj-link` checks signing without installing.
Simulator builds exercise the bridge without claiming physical-device connectivity.

For a CDJ-3000, connect the iPhone to the rear USB-B port, wait for the network to appear,
and select **DJ Booth iPhone** on the deck. A USB Ethernet adapter
or the same local network is also a test path. The USB transport, iOS kernel UDP behavior,
and real deck browsing/loading still require a device test; a successful build is not proof of playback.
See [AlphaTheta's connection guide](https://rekordbox.com/en/support/faq/connecting-to-dj-units/#faq-q100037)
and [Apple's multicast entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.networking.multicast).
