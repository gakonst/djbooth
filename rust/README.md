# Rust workspace

All active Rust code lives in this Cargo workspace.

| Path | Responsibility |
| --- | --- |
| `crates/rekordbox-analyzer-core` | Clean-room audio analysis and DAT/EXT/2EX generation |
| `crates/music-cdj-usb` | Linux USB gadget runtime |
| `crates/djtools-core` | Shared DJ Link support library |
| `crates/djtools-link` | Pro DJ Link, RemoteDB, and NFS implementation |
| `apps/music-djlink` | Native DJ Link executable consumed by `packages/djlink` |
| `apps/rekordbox-library-desktop` | Tauri shell packaging `apps/rekordbox-library` |

TypeScript packages invoke these through package build scripts and copy release binaries into their
`native-bin/` or packaged application resources. The binaries keep direct development CLIs, while
the package-owned Incur commands wrap them under the top-level `music` CLI for normal use and agent
tooling. Rust source is never nested inside `packages/`.

```sh
cargo test --manifest-path rust/Cargo.toml --workspace
cargo +nightly fmt --manifest-path rust/Cargo.toml --all
cargo check --manifest-path rust/Cargo.toml --workspace --all-targets
```
