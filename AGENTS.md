# Runtime golden path

Repository prefix: `pnpm djbooth`; release prefix: `djbooth`. Discovery: `<path> --help`,
`--schema`, `--llms-full`. Machine output: `--format json|jsonl`.

| Stage | Owns | Command |
| --- | --- | --- |
| Resolve | Set URL/file → ordered playlist + provisional Rekordbox content rows; description → 1001Tracklists → recognition fallback | `tracks resolve <source>` |
| Enrich | Content rows → recording IDs, release metadata, provider provenance, acquisition candidates | `tracks enrich [--folder <folder>]` |
| Download | Ready content rows → adopted/downloaded canonical tagged audio; Soulseek/typed downloader fallback | `tracks download [--folder <folder>]` |
| Analyze | Downloaded rows → BPM, key, beatgrid, waveforms, seek tables, phrases, DAT/EXT/2EX; update rows as each track completes | `tracks analyze [--folder <folder>]` or `rekordbox analyze track(s)` |
| Stems | Audio/playlist → MLX Mel-Band-RoFormer vocals, drums, bass, other/Rekordbox layout | `rekordbox stems setup|doctor|separate|playlist` |
| Link | Rekordbox database → RemoteDB/NFS source visible to CDJs | `djlink rekordbox [track]` |
| USB | Rekordbox folder → copied audio + rewritten ANLZ + Device Library + OneLibrary; import histories | `usb sync <mount> --playlist-folder <folder> [--fresh]` |
| UI | Local library/workflows → browser workstation | `library serve --open [--no-assistant]` |
| Agent | Full typed surface → MCP/Code Mode | `--mcp` or `pnpm djbooth:mcp:code` |

Pipeline:

```text
resolve → database rows
        → identify enough to select recording → download → analyze ┐
        → remaining metadata enrichment ───────────────────────────┤→ ready rows → stems? → link/usb
```

- Rekordbox `master.db` = only durable workflow state and source of truth.
- No manifests, sidecar workflow databases, checkpoint files, or final library-commit stage.
- Resolve inserts playlist membership and provisional content rows immediately.
- Enrich and download pipeline concurrently across tracks; download waits only for acquisition identity.
- Analyze starts per track as soon as audio lands; one serialized/batched writer updates `master.db`.
- Files are immutable artifacts referenced by database rows, never a competing state ledger.
- Internal status/provenance may use `djbooth_*` extension tables inside `master.db`.
- `link` and `usb` consume ready database rows directly.

- One intent → highest-level command → rerun same command to resume/reconcile.
- No package CLI, direct `dist`, manual SQL/filesystem, Rust binary, or Python bypass.
- Lower-level command only for explicit low-level work or diagnosis; missing workflow → add umbrella route.
- `tracks enrich` is normal idempotent maintenance.
- `usb sync` owns history, audio, ANLZ, Device Library, and OneLibrary; `--fresh` only for empty media.
- Incur help/schema/LLM/MCP = runtime truth; no `SKILL.md` or duplicated workflow docs.

# Workspace conventions

- Use pnpm from the repository root; keep one root lockfile.
- Publishable libraries and CLIs live under `packages/`; application surfaces live under `apps/`.
- Active Rust lives in the `rust/` workspace; standalone Python tools live under `python/`.
- Use `workspace:*` for dependencies between packages in this repository.
- Run a filtered package check while iterating and `pnpm validate` before merging.
- Use conventional commits.
