# `@gakonst/tracks`

Database-backed DJ-set resolution, acquisition, metadata enrichment, analysis, and Rekordbox
playlist orchestration for djbooth.ai.

## Workflow

```sh
tracks resolve "$SET_URL" --format json
tracks enrich --folder 'DJ Sets I Like' --format json
tracks download "$SET_URL" --format json
tracks analyze "$SET_URL" --format json
tracks import-set "$SET_URL" --folder-name 'DJ Sets I Like' --format json
```

`resolve`, `download`, and `analyze` stop after their named durable stage. `import-set` runs through
the final ordered playlist import. Every command is idempotent and resumes by source URL.

Rekordbox `master.db` is the only workflow state. Internal `djbooth_*` extension tables retain
provider identities, acquisition status, provenance, and artifact references. Audio and analysis
files are immutable artifacts referenced by database rows. There are no workflow manifests,
sidecar databases, or checkpoint files.

Resolution order:

```text
published description → 1001Tracklists identity enrichment → configured audio recognition
```

Acquisition reuses verified local files first, then configured Soulseek and web downloaders.
Analysis begins per verified track in the end-to-end route. Unavailable releases remain explicit
skipped rows; available tracks continue into the playlist.

Use `tracks --help`, `tracks <command> --schema`, or `tracks --llms-full` as the complete runtime
reference. The umbrella release surface exposes these stages directly as `djbooth resolve`,
`djbooth enrich`, `djbooth download`, and `djbooth analyze`.
