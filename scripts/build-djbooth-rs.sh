#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
manifest="$repo_root/rust/Cargo.toml"
target_dir="$repo_root/rust/target"
output_dir="$repo_root/packages/rekordbox-ts/.djbooth-rs"
output="$output_dir/djbooth-rs"

cargo +nightly build --release --manifest-path "$manifest" --package djbooth-rs --target aarch64-apple-darwin
cargo +nightly build --release --manifest-path "$manifest" --package djbooth-rs --target x86_64-apple-darwin
mkdir -p "$output_dir"
lipo -create \
  "$target_dir/aarch64-apple-darwin/release/djbooth-rs" \
  "$target_dir/x86_64-apple-darwin/release/djbooth-rs" \
  -output "$output"
chmod +x "$output"
codesign --force --sign - "$output"
cp "$repo_root/packages/rekordbox-ts/LICENSE" "$output_dir/LICENSE"
cp "$repo_root/rust/crates/djbooth-analyzer/THIRD_PARTY_LICENSES.md" "$output_dir/"
