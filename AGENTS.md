# Runtime golden path

Repository prefix: `pnpm djbooth`; release prefix: `djbooth`. Discovery: `<path> --help`,
`--schema`, `--llms-full`. Machine output: `--format json|jsonl`.

| Stage    | Owns                                                                                               | Command                                            |
| -------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Import   | Hosted playlist/set → complete resumable library workflow                                          | `import <source>`                                  |
| Resolve  | Set URL/file → ordered database pipeline rows; description → 1001Tracklists → recognition fallback | `resolve <source>`                                 |
| Enrich   | Content rows → recording IDs, release metadata, provider provenance, acquisition candidates        | `enrich [--folder <folder>]`                       |
| Download | Ready source rows → adopted/downloaded canonical tagged audio; Soulseek/typed downloader fallback  | `download <source>`                                |
| Analyze  | Downloaded source rows → BPM, key, beatgrid, waveforms, seek tables, phrases, DAT/EXT/2EX          | `analyze <source>`                                 |
| Stems    | Library track → managed MLX vocals, drums, bass, other/Rekordbox layout                            | `stems <track> [--stem <stem>]`                    |
| Link     | Rekordbox database → RemoteDB/NFS source visible to CDJs; optional cue                             | `link [track]`                                     |
| USB      | Rekordbox folder → copied audio + rewritten ANLZ + Device Library + OneLibrary; import histories   | `usb <mount> --playlist-folder <folder> [--fresh]` |
| Serve    | Link + loopback workstation/API → one managed runtime                                              | `serve --open [--no-assistant]`                    |
| Inspect  | Library/import readiness + managed runtime state                                                   | `status`; `stop`                                   |

Agent golden path:

```text
import <source> → database rows
        → identify enough to select recording → download → analyze ┐
        → remaining metadata enrichment ───────────────────────────┤→ ready rows → stems? → link/usb
```

- Rekordbox `master.db` = only durable workflow state and source of truth.
- No user-facing manifests, sidecar workflow databases, checkpoint files, or final library-commit stage.
- Resolve inserts ordered pipeline state into `master.db`; standard content and playlist rows follow verified media.
- Enrich and download pipeline concurrently across tracks; download waits only for acquisition identity.
- Analyze starts per track as soon as audio lands; one serialized/batched writer updates `master.db`.
- Files are immutable artifacts referenced by database rows, never a competing state ledger.
- Internal status/provenance may use `djbooth_*` extension tables inside `master.db`.
- `link` and `usb` consume ready database rows directly.

- One intent → highest-level command → rerun same command to resume/reconcile.
- “Download/import a DJ set” means resolve its ordered constituent tracks, acquire individual
  recordings, and analyze them through the normal `import <source>` workflow. Use `--whole-set`
  only when the user explicitly requests the full continuous mix; never use it to bypass tracklist
  resolution or acquisition failures.
- When standalone acquisition fails, use the workflow's per-track source-set excerpt fallback.
  Keep excerpts labeled as set extracts, preserve unresolved IDs and uncertain identifications,
  and report these limitations instead of claiming standalone recordings were acquired.
- When the request includes upload/publish to the CF Worker, publish the resulting constituent-track
  playlist after analysis using `cloud publish`. Inspect per-track failures, rerun to resume failed
  uploads, and verify completion before reporting success; import/analysis alone does not publish.
- Every long-running umbrella command must expose observable progress. Use
  `--progress auto|always|never`, emit phase plus bounded current/total updates to stderr, produce
  an initial update promptly and periodic updates while work continues, and finish with a terminal
  success phase. Keep stdout reserved for the selected human or machine result format; progress
  callbacks are diagnostic and must never interrupt or become durable workflow state.
- No package CLI, direct `dist`, manual SQL/filesystem, Rust binary, or Python bypass.
- Lower-level command only for explicit low-level work or diagnosis; missing workflow → add umbrella route.
- `enrich` is normal idempotent maintenance.
- `usb` owns history, audio, ANLZ, Device Library, and OneLibrary; `--fresh` only for empty media.
- Incur help/schema/LLM/MCP = runtime truth; no `SKILL.md` or duplicated workflow docs.

# Workspace conventions

- Use pnpm from the repository root; keep one root lockfile.
- Publishable libraries and CLIs live under `packages/`; application surfaces live under `apps/`.
- Active Rust lives in the `rust/` workspace; standalone Python tools live under `python/`.
- Use `workspace:*` for dependencies between packages in this repository.
- Run a filtered package check while iterating and `pnpm validate` before merging.
- Use conventional commits.
