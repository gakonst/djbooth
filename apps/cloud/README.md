# Account-scoped library and music agent

Login signs the exact app tool catalog shared with DJBoothKit: `djbooth_query`
for the live phone library and `djbooth_exec` for the private cloud CLI. Existing
read-only grants must reconnect to approve this catalog. `AgentTools`, a Durable
Object keyed by account + Connect grant + agent, attaches through the public SDK's
`createTools` transport using a fresh one-use Connect ticket on every connection.
Every execution revalidates the live grant and checks the download's owner, grant,
and agent; callers cannot select a different user's container.

The authenticated `POST /v1/agent/tool-host/ticket` returns a short-lived, single-use
ticket for a same-origin phone bridge. The foreground app executes only
`djbooth_query` against its current account's local model. The backend hosts both
tools, so cloud downloads continue when the phone closes. Phone queries remain
bounded and paginated; credentials, filesystem paths, audio bytes, and other
account stores are never query sources.
The integration fixture exercises native WebSocket calls and answers using phone-owned
data: start `pnpm --filter @gakonst/djbooth-cloud test:mobile-server`, then run
`DJBOOTH_PHONE_TOOL_FIXTURE=1 pnpm native:test`.

The Cloudflare Worker hosts the Nanocodex Connect login, music-agent page, and
account-scoped D1/R2 API. Native chat uses the narrow `/v1/agent/turns` adapter to
the same Connect grant-bound managed API. The verified issuer response selects the
agent; callers cannot supply a different agent/account, and only permitted final
messages are returned. Open the Worker origin, or choose **Continue with Nanocodex**
in the native app. The same flow as Nanocodex's `js/connect-playground` requests
ChatGPT and the user's selected Spotify/SoundCloud connections, then opens a durable
Connect agent. DJ Booth uses the SDK popup dialog because the Nanocodex account host
restricts iframe embedding to its registered playground origins. Provider credentials stay with Nanocodex. The published SDK dependency
is pinned, with `patches/nanocodex@0.6.1.patch` carrying the three music-connector
allowlist/type additions from the supplied Nanocodex checkout. A sibling checkout is
not required to build or deploy. Remove that patch after upgrading to an SDK release
that includes both providers. The Nanocodex Connect API, dialog and managed runtime
must also have that checkout's Spotify/SoundCloud support deployed. The companion
`nanocodex-djbooth-connect` worktree registers `djbooth` at
`https://djbooth-library.gakonst.workers.dev`; update the registration for a different
production origin. Production dialogs reject HTTP loopback callers; test login from HTTPS.

Every private request verifies its grant with Nanocodex using app ID `djbooth` and the
Worker's exact origin. The verified broker account ID determines storage ownership;
account IDs in request bodies or headers cannot select another library. Revocation,
expiry, and issuer failures deny access. Native credentials live in Keychain; browser
SDK sessions are tab-scoped, with an HttpOnly same-origin cookie for session access.
Native and CLI handoffs exchange a short-lived one-time code with a SHA-256 proof.
No grant token appears in a callback URL.

Sync IDs, idempotency, conflicts, import deduplication, media/chunks/compositions,
container callbacks and snapshots are account-scoped. Native library databases,
playback preferences, pending imports and downloaded audio also use endpoint + account
namespaces. Signing out keeps each account's offline artifacts isolated on disk.
The local loopback workstation API still belongs to the Mac's library.

For CLI publishing, run `pnpm djbooth cloud login --endpoint <worker-origin>`, then
`pnpm djbooth cloud publish --endpoint <worker-origin>`. Login opens the same Connect
page and stores its credential in a private file under `~/.config/djbooth/cloud`.
`cloud logout --endpoint <worker-origin>` removes that local login. Existing explicit
`--token-file` / `DJBOOTH_CLOUD_TOKEN` overrides accept account credentials, not the old
shared sync secret. Logout forgets the local session; revoke the grant in Nanocodex
to revoke every copy of that grant.

## Upgrading the single-library deployment

For the initial account-isolation rollout, back up D1, deploy the account-aware Worker first (private requests fail closed until the schema is ready), then immediately apply all migrations. Do not roll back to an unscoped Worker after migration. Migration `0004_accounts.sql` preserves old
rows in `legacy_sync_changes` and `legacy_import_requests`. Old unprefixed R2 objects
remain intact and inaccessible through the account API. It does **not** assign this
unowned library to the first login. Sign in and republish the authoritative Rekordbox
library to populate that account. Retained legacy rows/media can be migrated separately
once their owner has been established. Pre-upgrade containers are retired, and the old
`SYNC_TOKEN` grants no access. Do not delete legacy storage until its owner has verified
the new library.

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

Download submits a provider link to the authenticated `/v1/imports` API, which
creates an idempotent managed-agent prompt: use the DJBooth CLI to import the source,
analyze the recordings, and publish them. The signed `djbooth_exec` tool reads the
image's actual root `AGENTS.md`, exposes workspace paths, starts public CLI commands
with argument arrays, and polls/cancels their processes. It does not implement an
alternative downloader or analyzer. Commands checkpoint the normal `master.db`.
Retry creates a new agent turn and restores the same playlist workspace.

Completion requires the real `cloud publish` result for the expected playlist,
namespace and private endpoint, with all audio and CDJ analysis uploaded; dry runs
cannot complete a download. An agent that stops before publication leaves a retryable
failure. Grant expiry/revocation disables tools and stops active jobs.
A unique source within an account maps to one Durable Object and one Linux container. Different playlists run
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

Previously submitted imports and analysis-repair jobs retain the deterministic runner.
For those jobs, when a set description has no tracklist, the container sends the importer's research handoff
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

Published track and collection IDs include the playlist request ID; media is deduplicated by
SHA-256 within each account. A completion receipt requires successful analysis, publication, and a final R2 backup.
Extract fallbacks stay labeled and are counted in the completion message.
Playlist publishers reconcile only their own namespace through the sync API, avoiding downloads
of unrelated library history and waveform payloads. Normal phone sync scans only its own account, using the database sequence as its cursor.

Cloud access uses the existing Wrangler D1/R2 bindings. The container calls the private
`http://djbooth.internal` outbound handler; R2 backups are scoped to its account and durable container ID. The handler looks up
the container owner in D1 before publishing through the internal account-scoped router;
caller-supplied credentials cannot change that owner.
No R2 API keys, AWS credentials, configured cloud origin, or Wrangler login inside the image
are needed. Snapshot transfers use verified 16 MiB chunks, and commit the database last.
Artifact transfers run four at a time. Successfully uploaded or restored immutable files are
reused in later checkpoints when their inode, size, and nanosecond modification/change times
are unchanged; temporary downloader staging files are excluded. The database is still backed
up on every checkpoint, after all referenced artifact transfers have settled.

`IMPORT_PROVIDER_ENV` remains an optional JSON Worker secret for shared acquisition
infrastructure (Soulseek, recognition services, and provider application credentials).
User Spotify refresh tokens and SoundCloud access tokens are deliberately rejected in
this shared environment. The agent accesses private music through its approved
Nanocodex connectors. Connected playlist metadata is captured as an immutable input
artifact; private connector credentials are never exported into containers. Agent
workspaces also omit shared `IMPORT_PROVIDER_ENV` secrets.

For new deployments, apply D1 migrations before serving traffic. Use the rollout order above when upgrading the legacy shared service. `pnpm --filter @gakonst/djbooth-cloud build:container` builds the Linux image;
`pnpm --filter @gakonst/djbooth-cloud test:container` runs an offline import and real analysis
smoke test inside that image. `check` tests the Worker/API and container lifecycle without running
paid containers. `pnpm --filter @gakonst/djbooth-cloud run deploy` builds and rolls out both
the Worker and its container image. Container updates target 100% in one rollout step; a successful
deploy starts replacement, so verify the active application image before testing. The iPhone uses its Nanocodex account login; playlist processing needs no workstation connection.
