# DJBooth librespot-core patch

Source: unmodified crates.io `librespot-core` 0.8.0 release, except
`src/connection/handshake.rs`. Crates.io archive checksum:
`168bbe1c416980ddd9a969ebd6b50fb6c924eb1a3ded194285fa8ec0e2b1c68b`.
The release Cargo manifest is normalized by Cargo;
`Cargo.toml.orig` preserves its original manifest. License: MIT (included).

## iOS OAuth AP compatibility

Upstream iOS AP identifiers reject OAuth-authenticated sessions with `TryAnotherAP`:
<https://github.com/librespot-org/librespot/issues/1477>. Android already maps to
Linux AP identifiers for the same protocol incompatibility. This patch extends
that mapping to iOS. It keeps librespot's explicit authentication identity,
Premium requirement, OAuth consent and all other platform behavior unchanged.

`platform_for` tests cover iOS device/simulator identifiers and unchanged desktop
mappings. Live iPhone authentication must also be verified; the pure mapping tests
do not establish provider acceptance. Remove this patch when upstream ships an
iOS AP fix. No provider credentials belong in this directory.
