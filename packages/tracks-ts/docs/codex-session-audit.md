# Historical Codex session audit

Snapshot: 2026-07-14 UTC. Scope: every archived local Codex JSONL session available before this
audit, including subagent forks. Secrets and capability-bearing URLs were excluded.

## Method

- Inspected 409 session files: 197 from 2025 through May 2026 and 212 from June through July 2026.
- Classified root sessions from `session_meta`; followed parent ancestry for subagents instead of
  counting each fork as an independent user complaint.
- The early slice contained 41 primary-session candidates. The recent slice contained 31 primary
  candidates and 181 forks; ten recent roots were music-related and expanded to 146 files.
- Separated product defects from orchestration mistakes such as wrong worktrees, duplicated agent
  runs, unnecessary UI shutdowns, and blind polling.

## Strongest signals

The recurring problem is orchestration and state, not insufficient raw parallelism.

1. Resume/cache drift. A 41-track cached rerun still took 356.79 seconds, hit only 25 cache entries,
   and created duplicate `(1)` files. The Brunello resume later changed durable media paths, retagged
   existing bytes, created duplicate clips, and invalidated downstream checkpoints.
2. Blanket concurrency. One change raised downloads, verification, Spotify, recognition, native
   analysis, and Rekordbox file I/O to 64. The analyzer benchmark improved from 28.83 seconds at 12
   workers to 23.85 seconds at 27 effective workers: more than twice the processes for roughly 17%
   less wall time. Nine simultaneous Googlevideo requests were flaky; six were stable.
3. Missing progress/cancellation. Two large roots alone used roughly 4,200 exec calls, 268 explicit
   polls, 27 aborted turns, and 25 compactions. One recorded 73 wait timeouts. Long-running child
   processes did not provide durable item progress or a single cancellation tree.
4. Silent fallback. Native downloader failures could silently fall through to the reference binary,
   obscuring both the actual engine and native defects.
5. Wrong-recording acceptance. Historical `ytsearch1` runs selected hour-long sets for individual
   tracks; loose Spotify matching confused similarly named releases. Identity checks happened too
   late.
6. Provider/session churn. Soulseek searches and transfers repeatedly authenticated, serialized
   8–11 second searches, and waited 60 seconds on dead peers. Provider-wide cooldowns were absent.
7. Legacy Rekordbox writer friction. UI mutations performed heavyweight backups and process gates;
   current writers use one shared lock and a short transaction.
8. Analyzer path incompatibility. Unicode-heavy paths repeatedly returned exact native error
   `Rekordbox startAnalyze failed with status -1`; byte-identical numeric ASCII staging succeeded.

## Defaults derived from measurements

| Resource                    |                  Default |      Explicit cap |
| --------------------------- | -----------------------: | ----------------: |
| Remote recording downloads  |                        3 |                 8 |
| Native YouTube transfers    |                        3 |                16 |
| Reference YouTube transfers |                        1 |                 4 |
| Local artifact verification |                        8 |                16 |
| Spotify search/refresh      |                        8 |                32 |
| Local recognition           |                        3 |                 8 |
| Native Rekordbox analysis   |                        4 |                64 |
| Rekordbox filesystem I/O    | min(8, host parallelism) | measured override |

These are independent resource pools. A setting of `N` must not accidentally start `N` clips plus
`N` downloads plus `N` provider searches.

## Product changes from this audit

- Stable manifest reconciliation: reuse a verified prior artifact by Spotify/ISRC identity or its
  persisted recording fingerprint before requiring a newly generated output path. Never bind an
  unkeyed recording by array position. Preserve legacy cue clips by cue range and verify retained
  bytes against the durable SHA/duration receipt.
- Native analyzer: default four workers; structured stderr progress; AbortSignal propagation;
  SIGTERM then SIGKILL escalation; exact ASCII staging retry for the known native Unicode-path
  incompatibility.
- Stage-specific Tracks defaults: three remote transfers, eight metadata/verification calls, three
  recognition calls, four analyzer workers, bounded host-aware Rekordbox file I/O.
- Native downloader: bounded network defaults and fail-closed `auto`; reference fallback only for a
  typed pre-transfer capability failure, with the selected engine reported.
- Spotify and SoundCloud clients: one shared provider cooldown gate per client, longest-reset wins,
  serialized/staggered wakeups, abort-aware waits, and request-local transient network/server
  backoff.
- Rekordbox workbench: optimistic client mutations, connection-local `busy_timeout`, one shared
  cross-process lock, and short serialized transactions without a full backup on every drag.

## Remaining roadmap

1. One versioned per-track state machine covering discovery, enrichment, candidate selection,
   acquisition, analysis, and import. Persist start/end timestamps, queue time, retries, bytes,
   cache reason, selected engine, hashes, and failure class after every item.
2. Stage commands: `resolve`, `candidates`, `acquire`, `analyze-existing`, `import`, plus `pipeline
status/resume`. Completed stages must resume offline without loading unrelated credentials.
3. Native downloader host budgets: shared 429/403 cooldown, `Retry-After`, adaptive concurrency,
   fail-fast cancellation that waits for in-flight cleanup, and a genuinely global rate limit.
4. One long-lived Soulseek batch session with bounded candidate search and shorter phase-specific
   transfer deadlines.
5. Pre-download identity rejection using artist/title/version/duration constraints; quarantine and
   post-probe before atomic promotion. Never silently canonicalize unresolved tracks.
6. `music doctor`: root environment discovery, OAuth redirects, provider credentials, Node ABI,
   stale global binaries/worktrees, Rekordbox process/DB state, and analyzer compatibility.
7. Machine-readable JSONL progress and atomic `run-report.json`, including time to first artifact
   and critical path. Human progress remains stderr; stdout remains valid Incur output.

## Agent-side corrections

- Use the composed `music`/Incur CLI instead of ad hoc scripts when a primitive exists.
- Return a typed handoff that asks the calling agent to resolve the ordinary 1001Tracklists page with browser/VM tools.
- Never use the reference/bundled downloader unless the user explicitly selects it or a typed native
  capability preflight permits `auto` fallback.
- Keep the library UI running during short coordinated CLI writes.
- Operate from one managed worktree, validate real end-to-end output, then merge promptly.
- Avoid fixed polling loops. Prefer CLI progress events, process completion, and durable status.
