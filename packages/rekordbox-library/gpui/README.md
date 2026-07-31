# Rekordbox Library GPUI prototype

Native migration slice built on Zed's published `gpui` crate and Longbridge's published
`gpui-component` library. It keeps the proven Node/TypeScript loopback backend as the sole
Rekordbox/provider boundary and replaces the webview shell incrementally.

Implemented in this checkpoint:

- native GPUI window and GPU-rendered dark workbench shell;
- collapsible local and hosted playlist navigation from the existing API;
- two vertically stacked deck surfaces;
- selectable 100-row library page with component-backed Load A / Load B interactions;
- full-height assistant rail boundary;
- automatic read-only sidecar startup and shutdown for development.

The prototype is intentionally read-only. Audio transport, streamed ANLZ waveform painting,
mutations, provider acquisition controls, MLX stem mixing, and the Nanocodex runtime remain in the
production Tauri client until each has a native implementation with equivalent tests. This avoids
creating a second database/provider implementation.

GPUI normally invokes Xcode's Metal compiler at build time. This crate enables GPUI 0.2.2's
`runtime_shaders` feature so Command Line Tools-only macOS machines can build and compile the Metal
source at runtime.

```sh
pnpm --filter @gakonst/rekordbox-library gpui:run
```

To attach to an already-running backend instead of starting a read-only sidecar:

```sh
REKORDBOX_LIBRARY_URL=http://127.0.0.1:4179 \
  pnpm --filter @gakonst/rekordbox-library gpui:run
```
