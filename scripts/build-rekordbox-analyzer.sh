#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
manifest="$root/native/rekordbox-analyzer/Cargo.toml"
target_dir="$root/native/rekordbox-analyzer/target"
output="$root/packages/rekordbox-ts/vendor/rekordbox-analyzer"
template_dir="$root/packages/rekordbox-ts/vendor/rekordbox-analyzer-templates"

verify_template() {
  template=$1
  expected=$2
  if [ ! -f "$template" ]; then
    echo "missing packaged Rekordbox analyzer template: $template" >&2
    exit 1
  fi
  actual=$(shasum -a 256 "$template" | awk '{print $1}')
  if [ "$actual" != "$expected" ]; then
    echo "packaged Rekordbox analyzer template hash mismatch: $template" >&2
    exit 1
  fi
}

verify_template "$template_dir/ANLZ0000.DAT" 18e54d7c5be9bcd9c41fcddc733243f3f595c414b02449e71ade6da31553390f
verify_template "$template_dir/ANLZ0000.EXT" 6d54c875d421923e56431dcb614f7fdc6f57d8c62a15828befdda4783feb17fc

cargo build --release --manifest-path "$manifest" --target aarch64-apple-darwin
cargo build --release --manifest-path "$manifest" --target x86_64-apple-darwin
lipo -create \
  "$target_dir/aarch64-apple-darwin/release/rekordbox-analyzer" \
  "$target_dir/x86_64-apple-darwin/release/rekordbox-analyzer" \
  -output "$output"
chmod +x "$output"
codesign --force --sign - "$output"
