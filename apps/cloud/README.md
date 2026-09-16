# Personal library sync

Cloudflare Worker, D1 and R2 for the native apps. This deployment is one private personal library,
authenticated by a bearer token stored as the `SYNC_TOKEN` Worker secret. It does not provide
multi-user accounts or shareable public audio links. Missing credentials deny access.

D1 stores an append-only sequence of versioned track, collection, and favorite changes. Every
write carries an immutable operation ID and expected entity version. Matching retries return the
original receipt; stale versions return a conflict. Tombstones prevent deleted items reappearing.
Clients persist an outbox and pull cursor transactionally in their local store.

R2 stores immutable, checksum-verified media. Files can be uploaded as reusable 16 MiB chunks and
composed by their complete SHA-256. Downloads and HTTP ranges transparently span chunks, so a
long mix can be uploaded incrementally and played or saved normally. Metadata omits workstation
paths and carries a bounded real analysis waveform for offline display.

The API contract is implemented in `src/index.ts` and the native `DJBoothKit/Clients.swift`.
Use the top-level `pnpm djbooth cloud --help` for publishing the authoritative Rekordbox library.
`pnpm --filter @gakonst/djbooth-cloud check` runs formatting, type checking and local D1/R2
integration tests, including concurrent edits, retry idempotency, byte ranges and large-file
composition. Wrangler configuration contains resource identifiers, never credentials.

The original `0xcontrol` D1/R2 pattern informed this service. Its existing deployment and data
are separate and are not migrated or modified by these applications.

## Playlist containers

The native import screen submits a provider link to the authenticated `/v1/imports` API.
A unique source maps to one Durable Object and one Linux container. Different playlists run
independently; five may process concurrently and the rest wait. The Durable Object polls the
container without keeping an iPhone request open, and stops it after publication and backup.
A minute cron repairs interrupted delivery; startup failures and six-hour jobs become retryable
failures rather than running indefinitely.

`Dockerfile.playlist` packages the public `djbooth cloud container` entrypoint, Node, the Rust
CPU analyzer and FFmpeg. Each playlist owns an isolated `master.db` in `/data`. SQLite
runs on local disk. Every minute, the engine copies immutable artifacts to R2 and then uploads
a consistent encrypted database backup. Restarts restore that database and rerun normal
`import`, which verifies and reuses completed work. At most the work since the last successful
backup needs repeating. No Mac is involved. MLX stems are outside this CPU import workflow.

When a set description has no tracklist, the container sends the importer's research handoff
to a private Worker endpoint. Browser Run finds public tracklist pages and Workers AI transcribes
timestamped rows. Each accepted identity and timestamp must occur together in a source row;
unknown tracks stay IDs, and community tracklists retain uncertainty warnings. The result returns
through `import --agent-result-json`, which saves it in the same `master.db` before acquisition.
The `BROWSER` and `AI` bindings require no additional API keys.

If a media provider returns HTTP 403, the cloud importer checks the matched tracklist evidence
for another upload of that exact performance. It resumes the saved playlist with
`import --source-set-download-url`; the downloaded audio must match the resolved duration within
two seconds before any cue excerpts are created. The alternate upload is preserved in excerpt
provenance. Unverified alternatives fail with a retryable status.

Published track and collection IDs include the playlist request ID; media remains shared by
SHA-256. A completion receipt requires successful analysis, publication, and a final R2 backup.
Extract fallbacks stay labeled and are counted in the completion message.
Playlist publishers reconcile only their own namespace through the sync API, avoiding downloads
of unrelated library history and waveform payloads. Normal phone sync still uses the global cursor.

Cloud access uses the existing Wrangler D1/R2 bindings. The container calls the private
`http://djbooth.internal` outbound handler; R2 backups are scoped to its durable container ID,
and publication calls the Worker API with authentication injected outside the container.
No R2 API keys, AWS credentials, configured cloud origin, or Wrangler login inside the image
are needed. Snapshot transfers use verified 16 MiB chunks, and commit the database last.
Artifact transfers run four at a time. Successfully uploaded or restored immutable files are
reused in later checkpoints when their inode, size, and nanosecond modification/change times
are unchanged; temporary downloader staging files are excluded. The database is still backed
up on every checkpoint, after all referenced artifact transfers have settled.

The existing `SYNC_TOKEN` protects the phone-facing API. `IMPORT_PROVIDER_ENV` is an optional
Worker secret containing a JSON object of provider credentials. Supported names are allowlisted
in `playlist-container.ts`; Spotify uses `SPOTIFY_CLIENT_ID` and `SPOTIFY_REFRESH_TOKEN`
(and `SPOTIFY_CLIENT_SECRET` when required). SoundCloud, Soulseek, AudD, and ACR use the existing
engine names. Provider credentials never enter the image, mobile responses, or progress receipts.

Apply D1 migrations before deploying the Worker. `pnpm --filter @gakonst/djbooth-cloud build:container` builds the Linux image;
`pnpm --filter @gakonst/djbooth-cloud test:container` runs an offline import and real analysis
smoke test inside that image. `check` tests the Worker/API and container lifecycle without running
paid containers. `pnpm --filter @gakonst/djbooth-cloud run deploy` builds and rolls out both
the Worker and its container image. Container updates target 100% in one rollout step; a successful
deploy starts replacement, so verify the active application image before testing. The iPhone uses its existing cloud
connection and token; it needs no provider accounts or workstation connection.
