# Rekordbox analyzer seed shapes

These sanitized DAT/EXT files provide the ANLZ container shapes required by the pinned native
Rekordbox analyzer when a machine has no existing local analysis library. They contain a generic
`?/rekordbox-template-source.wav` PPTH path; beat, waveform, and phrase payloads are zeroed before
each analysis while the required cue scaffolding is retained.

Regenerate from a compatible local Rekordbox library:

```sh
cargo run --manifest-path archive/rekordbox/rehost/Cargo.toml -- \
  bundle-templates archive/rekordbox/reference/anlz-templates
```

- `ANLZ0000.DAT`: 7,492 bytes; SHA-256
  `18e54d7c5be9bcd9c41fcddc733243f3f595c414b02449e71ade6da31553390f`
- `ANLZ0000.EXT`: 147,246 bytes; SHA-256
  `6d54c875d421923e56431dcb614f7fdc6f57d8c62a15828befdda4783feb17fc`
