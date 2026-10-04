# Native DJ Booth

SwiftUI applications for macOS and iOS, sharing `DJBoothKit`. The interface follows the existing
workstation palette and dense library layout. Apple system glass is used for controls; track
content stays opaque. Waveforms display real Rekordbox analysis, including frequency colours.
Mobile shows plain playlist and track lists, with inline notes, color, and the player pinned at the bottom.
On iPhone, the welcome screen starts **Continue with Nanocodex** for SMS sign-in and connection approval. The app saves the login in Keychain and isolates libraries, downloaded media, playback, and pending imports by account. **Ask DJ Booth** in the library opens the connected agent. Its read-only phone tool queries live tracks, playlists, favorites, notes, playback, queue, downloads, sync conflicts, and imports, including unsynced edits. The phone must remain in the foreground; backgrounding, signing out, or switching accounts detaches its tools. Existing logins must reconnect once to approve the phone tool catalog. Spotify and SoundCloud remain optional connections in the same approval flow. Signing out returns to the welcome screen; existing offline libraries remain separate. Use `djbooth cloud login` and `djbooth cloud publish` to publish your Mac library deliberately.
The native conversation consumes the vendored `NanocodexConnectEmbed` Swift product at
`vendor/nanocodex/apple/NanocodexConnectEmbed`. Message rows retain DJ Booth's existing SwiftUI
text rendering, typography, and spacing; the growing composer uses the shared UIKit editor on iOS.
The shared `EmbedConversation` assembly uses the SDK's virtualized transcript on iOS 18+ and
its portable SwiftUI scroll container on iOS 17 and macOS, with stable message identities,
history restoration, and follow/latest controls. macOS retains its native text field.
Deployment targets remain iOS 17 and macOS 14.
`BoothModel` continues to own the grant-bound transport, draft cache, submission receipts,
history, consent, retry, and cancellation. No account-hand screen service is enabled by this
integration. The Xcode generator links the same vendored public product into both app targets
using a portable relative package path and bundles the native dependency notices;
`DJBoothKit` remains independent of the UI SDK.
Refresh the native and web source together with `pnpm vendor:nanocodex /path/to/nanocodex` and keep
the vendor provenance manifest with the snapshot. Then regenerate Xcode using
`pnpm --filter @gakonst/djbooth-apple project`.

Crew folders share all their playlists with their members. **Members → Add people** presents a
QR code, Copy link, and the native share sheet (including AirDrop and Messages). HTTPS invites
show a preview without consuming the single-use invite; **Open in DJ Booth** opens the join
sheet through `djbooth://join/<token>`. Signing in preserves the invite and chosen display name.
Direct HTTPS universal links are available with `pnpm native:device --universal-links`; this
requires a provisioning profile with Associated Domains for `djbooth-library.gakonst.workers.dev`.
The default development build uses the web-page button when that entitlement is unavailable.
See [Apple’s associated domain requirements](https://developer.apple.com/documentation/xcode/supporting-associated-domains).

Shared tracks use the normal track rows, waveform, BPM/key, queue and player, with contributor
initials alongside. Adding an uploaded track shares its existing cloud audio and analyzed metadata;
it does not upload or analyze again. Foreground apps subscribe to crew WebSockets, reconcile on
reconnect, and also refresh periodically if a notification fails. Personal favorites, notes and
copies into personal playlists retain the track metadata; cloud audio access still requires a
shared reference or an owned upload.

At the library root, swipe inward from the left edge to open the native side drawer over the current view.
UIKit owns the sidebar gesture, presentation, and dismissal; the current library remains behind it.
Choose **Playlists**, **Artists**, **Albums**, or **All Tracks**. Artist and album groups open their
tracks with a scoped playback queue; the edge gesture inside groups, folders, and playlists goes back.
Choose **Download → Paste → Download** to start a playlist/set import in the cloud. The sheet shows
submission confirmation, current progress, retry for failed jobs, and an **Open playlist** action when ready.
An unconnected phone can open cloud settings from the same sheet. The app can close while the import runs.
On iOS, **Settings → USB library → Choose USB folder** opens the initial folder picker.
A USB folder appears in the playlist browser only while its authorized drive is connected.
Spotify and SoundCloud use the normal folder navigation bar and native Back gesture. A centered
system spinner appears only while an empty folder or playlist first loads; cached contents stay
in place during refresh. Pull to refresh. Connection errors and retry stay inside the affected folder.
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

For the embed integration, run `pnpm native:check` on macOS to compile both targets.
The existing native journey
`pnpm --filter @gakonst/djbooth-apple test:ui --only-testing DJBoothUITests-iOS/DJLinkUITests/testAgentTakesOverLibraryAndRestoresDraft`
checks entering the companion, editing a draft, returning to the library, reopening,
and restoring the draft after relaunch. `ConnectUITests/testLoginAgentAccountSwitchAndSignOut`
uses the local mobile Worker fixture for real submission, reply rendering, cancellation,
and account isolation. Start `pnpm --filter @gakonst/djbooth-cloud test:mobile-server`
before selecting that journey. Linux can regenerate the Xcode project but the native
check command explicitly skips compilation; that result is not an Apple build pass.

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

CDJ connection starts automatically when a wired interface appears. The sidebar's **CDJs** status screen uses the shared Rust RemoteDB/NFS engine. It projects
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
Discovery is limited to actual /16–/30 subnets, with a fallback budget of 512 addresses per second,
interleaves the phone's /24 with low host addresses across the subnet, and repeats
while foregrounded. A random phone link-local address does not force the deck to
wait behind the phone's entire /24.
The first sweep continues even after a deck or mixer responds. Subsequent fallback sweeps
slow to eight candidates per second when a deck is present; cached and lost peers are
retried every 250 ms independently. Darwin sockets reserve 128 KiB of send
buffer space for full-size NFS replies; the default 9 KiB limit rejects these datagrams.
A first /16 sweep has about 128 seconds of scheduled probe time; a /24 fits in four
125 ms batches. Socket backpressure can extend these times. These budgets start only
after iOS assigns the wired IPv4 address. A measured direct CDJ USB attachment spent
21.288 seconds waiting for that address, then started serving in 89 ms. Faster peer
probing does not remove this earlier wait. AlphaTheta documents about 20 seconds for
the same wired setup in [rekordbox for iOS](https://rekordbox.com/en/support/faq/ios/#faq-12293).
The existing **CDJs → Connect faster next time** guide walks through optional
manual Ethernet addressing in iPhone Settings. Copyable values appear only after
a real deck responds on the selected link-local interface; Wi-Fi, a Mac USB
connection, and routed networks never supply suggested manual addresses. The
guide keeps its values in memory across the Settings round-trip, explains how
to restore Automatic, and asks the user to replug to check the result. It does
not claim to change iOS settings or verify the manual configuration itself.
Only valid CDJ/XDJ replies appear as discovered decks. USB interface detection, automatic
startup, deck discovery, and browsing have been observed on an iPhone 17 Pro and the
connected deck. Reliable playback and RGB display still require a hardware retest after
the offline artifact transfer and large-datagram fixes.

`pnpm native:device --device <id>` installs the automatic unicast build.
Wired network appearance starts sharing without entering addresses or opening the sheet.
Foregrounding resumes wired sharing; no Connect button or status-screen visit is required.

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


### Persistent iPhone diagnostics

Diagnostics start at app launch in `Library/Application Support/DJBooth/Diagnostics`.
They are local, excluded from backup, and survive app restarts and ordinary reinstalls.
Uninstalling the app removes them. `pnpm native:diagnostics --device <id>` copies the
retained sessions into `apps/apple/.build/diagnostics/` without restarting the phone app.

Each session includes:

- `manifest.json`: session ID, UTC creation time, app/OS versions, Git revision,
  source fingerprint (including dirty Swift/Rust changes), SDK and build configuration.
- `timeline*.jsonl`: Swift lifecycle, interface/connection transitions, binding calls
  and durations, shared Rust request/reply diagnostics, panic backtraces, and main-thread
  stalls/recovery. Row timestamps and monotonic elapsed times correlate all lanes.
- `transport*.jsonl`: **application socket capture**, with direction, endpoints, TCP
  connection ID, original payload length and complete hexadecimal payload bytes.
  TCP chunks are actual successful socket reads/writes, not OS packet segments. UDP
  records include discovery/status, RPC/mount, and NFS traffic. There are no IP/TCP
  headers, retransmissions, other-app traffic, or CDJ button/screen events. Capture
  may include audio bytes and library metadata; no Spotify/cloud requests are tapped.
- `metrics*.jsonl`: original Apple MetricKit diagnostic/metric JSON. These reports
  retain their original timestamps/version/binary UUIDs, even when delivered during
  a later session. Apple controls delivery; absence is not proof that no crash occurred.

For USB hot-plug failures, correlate `cdj_monitor_started/stopped`,
`cdj_network_path`, `interface_scan_changed`, `cdj_interfaces`, and
`cdj_automatic_state`. The Rust scan records raw interface names, address families,
IPv4 addresses and flags before filtering, only when they change. This distinguishes
an adapter missing from the OS enumeration from one rejected by the Rust filter.
`interface_scan_failed` records OS enumeration errors. Reproduce by opening the app
with no cable, plugging in while it stays visible, then unplugging/replugging without
relaunching. A successful connection only after launch does not pass this check.
For an unattended Debug device run, add `--dj-link-hardware-test` to
`pnpm native:device --device <id>`. This keeps the foreground app awake while
waiting for the USB IPv4 address, including before the Rust server starts. The
flag is ignored in Release builds and does not enable background networking.
It also enables a paired-device file command channel. With the app open, use
`pnpm native:link --device <id> --operation status` to inspect the session, or
`--operation api` for the generated Rust method catalog and argument schema.
`--operation server.send_load_track --arguments '<json>'` and
`--operation server.start_player --arguments '<json>'` invoke the existing Rust
deck controls on the phone. `diagnostics.status` reports the active capture directory
and loss counters. Swift only forwards JSON to the C ABI. There is no network listener,
and the channel is absent from Release builds. Run one command at a time; commands
expire after 60 seconds and are never automatically replayed after a timeout or restart.
The returned result confirms the Rust operation; verify actual deck state with
`server.monitor_snapshot` and the traffic capture before declaring playback successful.

Four launch sessions are retained. Each has at most four 2 MiB timeline segments,
four 4 MiB transport segments, and four 2 MiB metric segments (128 MiB total plus
small manifests). `.1` is the preceding segment. Capture writes run on a bounded
background queue; dropped records and disk errors are reported as `diagnostics_loss`
and by the `diagnostics.status` C ABI operation. A capture with loss is incomplete.
The independent one-second foreground heartbeat records main-thread stalls over
three seconds. It suspends detection when inactive/backgrounded; it does not claim
that a force-quit, device reboot, or missing termination callback is a crash.

Native builds retain Rust line information and archive the matching iOS dSYM under
`apps/apple/.build/diagnostic-symbols/<binary-UUID>/`, alongside its build ID. Keep
that directory to symbolicate reports after another build. Apple crash/hang reports
use MetricKit; see [Apple's diagnostic delivery documentation](https://developer.apple.com/documentation/metrickit/mxmetricmanager).
For a dedicated simulator smoke test, `pnpm native:ios --demo --diagnostics-stall-probe`
produces a deliberate five-second main-thread stall (Debug simulator only). Verify
`main_thread_stall` and `main_thread_recovered`, then relaunch and confirm the old
session remains. No deliberate stall runs on physical devices or release builds.

DJ Link protocol logic remains in Rust. Swift forwards calls and iOS lifecycle/
MetricKit notifications. The generated 55-method/11-function inventory is checked at
runtime; binding tests compare native results, errors, subscriptions and transmitted
bytes, and shared-server tests cover browse/Back/track changes. Physical deck behavior
still requires a recorded hardware test; the binding inventory alone cannot prove it.

### Agent app controls over reverse MCP

The app owns the MCP catalog (`DJBoothKit/Resources/app-mcp.json`), JSON-RPC
endpoint (`PhoneMCPServer`), and action dispatch (`BoothMCPActions`). Playback,
playlist edits, Sonos, DJLink, connected music and recording tools call the same
model/controller methods as the UI. Deck and Sonos protocols remain in Rust.
The existing outbound authenticated phone socket carries MCP requests; the app
opens no listening port. Cloudflare relays requests and caches the signed native
catalog for discovery. Nanocodex's `createTools({ mcp: ... })` and hosted broker
provide deferred `tool_search`; no bespoke discovery tool is added.

Mutations require a stable UUID `requestID`. They return an account-local durable
receipt immediately; use `operation_status` until completed/failed/interrupted.
A matching retry returns the original receipt, and changed arguments with the
same ID fail. An app restart never automatically replays an unfinished action.
These receipts live in the existing account store and do not enter library sync.
Execution requires the app awake and connected. Audio permission and account
sign-in still use normal system UI; cloud download jobs run independently.

The signed `phone-tools.json` approval catalog must match the MCP adapter exactly
(provider, remote name, schema, parallel flag and timeout). Cloud contract tests
compare the real SDK attachment and consent digests. Catalog changes require new
Connect consent. The paired-device DEBUG diagnostic operation `phone.mcp` can
exercise the same JSON-RPC handler using the existing `link --arguments-file`
transport; it is not an agent authentication bypass in release builds.
