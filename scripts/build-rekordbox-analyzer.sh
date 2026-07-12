#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
manifest="$root/native/rekordbox-analyzer/Cargo.toml"
target_dir="$root/native/rekordbox-analyzer/target"
output="$root/packages/rekordbox-ts/vendor/rekordbox-analyzer"

cargo build --release --manifest-path "$manifest" --target aarch64-apple-darwin
cargo build --release --manifest-path "$manifest" --target x86_64-apple-darwin
lipo -create \
  "$target_dir/aarch64-apple-darwin/release/rekordbox-analyzer" \
  "$target_dir/x86_64-apple-darwin/release/rekordbox-analyzer" \
  -output "$output"
chmod +x "$output"
codesign --force --sign - "$output"
