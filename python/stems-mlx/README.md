# music-stems-mlx

Standalone Python 3.12 + uv project for MLX-native Mel-Band-RoFormer four-source separation on
Apple Silicon. This is the newer open-model separator, not the archived Rekordbox analyzer rehost.

```sh
uv sync --project python/stems-mlx --locked
uv run --project python/stems-mlx music-stems-mlx doctor
uv run --project python/stems-mlx music-stems-mlx setup
uv run --project python/stems-mlx music-stems-mlx separate track.flac ./track-stems \
  --layout four-stem
```

The first setup downloads and converts the pinned Apache-2.0 model. Model files and the uv-managed
Python environment stay under `~/Library/Caches/rekordbox-ts/stems` by default. The TypeScript
`rekordbox stems` commands call this project through uv, and the umbrella exposes those commands as
`music rekordbox stems ...`. The direct `music-stems-mlx` CLI remains useful for development.
Installed deployments can set `MUSIC_STEMS_MLX_PROJECT` or pass `--python-project-directory`.
