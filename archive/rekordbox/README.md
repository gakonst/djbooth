# Archived Rekordbox research

This directory preserves the retired dlopen rehost, sanitized reference ANLZ seeds, and a minimal
Rekordbox 6.8.2 application bundle used during reverse engineering.

- `rehost/`: retired macOS reference analyzer source and historical helper binary
- `reference/anlz-templates/`: reference-only DAT/EXT seed shapes
- `artifacts/rekordbox/`: proprietary executable, dylibs, metadata, hashes, and provenance report

These files are not release dependencies. Production analysis uses
`rust/crates/djbooth-analyzer`; MLX source separation uses `python/stems-mlx`. Explicit
reference analysis now requires `REKORDBOX_REFERENCE_ANALYZER_BINARY` or a PATH-installed helper.
