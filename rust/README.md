# Rust workspace

All active Rust code lives in this Cargo workspace.

| Path                             | Responsibility                                       |
| -------------------------------- | ---------------------------------------------------- |
| `bin/djbooth-rs`             | Unified analyzer, USB, and DJ Link CLI                |
| `crates/djbooth-analyzer`    | Clean-room audio analysis and DAT/EXT/2EX generation  |
| `crates/djtools-core`            | Shared DJ Link support library                       |
| `crates/djtools-link`            | Pro DJ Link, RemoteDB, and NFS implementation        |

The standalone Tauri application and its lockfile live with the frontend at
`apps/djbooth/src-tauri`.

TypeScript packages invoke these through package build scripts and copy release binaries into their
`native-bin/` or packaged application resources. The binaries keep direct development CLIs, while
the package-owned Incur commands wrap them under the top-level `djbooth` CLI for normal use and agent
tooling. Rust source is never nested inside `packages/`.

```sh
cargo test --manifest-path rust/Cargo.toml --workspace
cargo +nightly fmt --manifest-path rust/Cargo.toml --all
cargo check --manifest-path rust/Cargo.toml --workspace --all-targets
```
