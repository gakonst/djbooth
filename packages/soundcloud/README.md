# soundcloud

`@gakonst/soundcloud` is a complete, strongly typed client for SoundCloud's documented HTTP API
and an agent-friendly CLI built with [Incur](https://github.com/wevm/incur). Its checked-in types and
commands are generated from SoundCloud's official OpenAPI schema.

## Highlights

- Every official OpenAPI path through typed `GET`, `POST`, `PUT`, and `DELETE` methods.
- OAuth 2.1 Authorization Code with required PKCE and client secret for account access.
- Secure mode-`0600` saved sessions and atomic, cross-process refresh-token rotation. Interactive
  login also retains the confidential app credential in that private session so packaged desktop
  consumers can refresh without inheriting a shell environment; existing sessions migrate after
  one login or `auth refresh` with `SOUNDCLOUD_CLIENT_SECRET` supplied.
- Persistent Client Credentials tokens for public search and URL resolution.
- Automatic one-time 401 refresh plus coordinated, bounded 429 and transient-read retries.
- Safe linked pagination through opaque `next_href` URLs.
- User-authorized playlist creation from ordered track IDs, URNs, and URLs.
- Incur structured output, OpenAPI commands, MCP, skills, shell completion, and LLM discovery.
- Convenience methods and commands for `/me`, likes, and recently played tracks.

## Configure the SoundCloud application

Register this exact redirect URI in the SoundCloud application settings:

```text
http://127.0.0.1:8788/callback
```

Copy the workspace `.env.example` to the root `.env` and set the client ID and secret. The CLI loads
that workspace-root file during monorepo development; it is ignored by Git and excluded from the
published package. Standalone installs also check `.env` in the current working directory.

SoundCloud currently treats every client as confidential: the client secret is required even
though Authorization Code also requires PKCE. Access tokens expire after about an hour and refresh
tokens are single-use, so the CLI saves and rotates each replacement token atomically.

## CLI

```sh
pnpm soundcloud auth login
pnpm soundcloud auth status
pnpm soundcloud me
pnpm soundcloud likes tracks
pnpm soundcloud likes tracks --all --urls --format json
pnpm soundcloud likes playlists --all --format json
pnpm soundcloud recent --format json
pnpm soundcloud search tracks "Burial" --limit 20
pnpm soundcloud resolve "https://soundcloud.com/artist/track"
pnpm soundcloud upload ./mix.flac --title "New mix" --sharing private
pnpm soundcloud playlist create "Late night" \
  --track soundcloud:tracks:308946187 \
  --track "https://soundcloud.com/artist/track"
pnpm soundcloud playlist get soundcloud:playlists:PLAYLIST_ID
pnpm soundcloud playlist update soundcloud:playlists:PLAYLIST_ID --title "Renamed"
pnpm soundcloud playlist delete soundcloud:playlists:PLAYLIST_ID
```

`--urls` returns canonical `soundcloud.com` track permalinks suitable for inspection and selected
downloads with `@gakonst/ytdlp-ts`. The API client intentionally handles metadata and account state;
audio acquisition remains in ytdlp-ts.

`playlist create` accepts numeric track IDs, `soundcloud:tracks:*` URNs, and public or secret
SoundCloud track URLs. Repeat `--track` to preserve order and duplicates, or append a text file with
`--input-file` (one reference per line; blank lines and `#` comments are ignored). Playlists default
to private and are limited to SoundCloud's 500-track platform maximum. This write requires a saved
user login from `soundcloud auth login` or an explicit user `SOUNDCLOUD_ACCESS_TOKEN`; Client
Credentials authentication is intentionally rejected.

`playlist get`, `playlist update`, and `playlist delete` complete the lifecycle. Update can replace
the full ordered track membership or clear it with `--clear-tracks`; unlike Spotify, SoundCloud's
delete operation permanently deletes an owned playlist.

All official operations are available under the generated Incur command group:

```sh
pnpm soundcloud api --help
pnpm soundcloud api get-me-likes-tracks --limit 50 --linked_partitioning true
pnpm soundcloud request GET /me/likes/tracks --query '{"limit":50,"linked_partitioning":true}'
```

The generated API accepts JSON request bodies, including comments and playlist mutations. The
dedicated `upload` command handles multipart audio safely from a local file. OAuth is always loaded
from the configured session; generated commands intentionally do not accept tokens on the command
line.

Agent and structured-output features come directly from Incur:

```sh
pnpm soundcloud --llms
pnpm soundcloud --llms-full
pnpm soundcloud --mcp
pnpm soundcloud mcp add
pnpm soundcloud skills add
pnpm soundcloud completions zsh
```

The CLI definition is import-safe and can be composed directly into another Incur root without
loading `.env` or starting a process:

```ts
import soundcloudCli from '@gakonst/soundcloud/cli'

root.command(soundcloudCli)
```

`runSoundCloudCli()` is also exported from that subpath for standalone launchers; only that runner
loads the workspace environment before serving.

## TypeScript

### Saved user session

```ts
import {
  FileSessionStore,
  SoundCloudClient,
  SoundCloudOAuth,
} from '@gakonst/soundcloud'

const store = new FileSessionStore()
const session = await store.load()
if (!session?.redirectUri) throw new Error('Run `soundcloud auth login` first')

const auth = new SoundCloudOAuth({
  clientId: session.clientId,
  clientSecret: process.env.SOUNDCLOUD_CLIENT_SECRET!,
  redirectUri: session.redirectUri,
  store,
})
const soundcloud = new SoundCloudClient({ auth })

for await (const track of soundcloud.iterateLikedTracks()) {
  console.log(track.title, track.permalink_url)
}

const playlist = await soundcloud.createPlaylist({
  title: 'Late night',
  sharing: 'private',
  tracks: [
    'soundcloud:tracks:308946187',
    'https://soundcloud.com/artist/track',
  ],
})
await soundcloud.getPlaylist(playlist.urn!)
await soundcloud.updatePlaylist(playlist.urn!, {
  title: 'Late night — updated',
})
await soundcloud.deletePlaylist(playlist.urn!)
```

All requests made through one `SoundCloudClient` share a provider cooldown gate. A `Retry-After`
header or SoundCloud's structured [rate-limit `reset_time`](https://developers.soundcloud.com/docs/api/rate-limits)
delays later calls as well as the current safe-method retry, so concurrent callers cannot bypass the
cooldown. Waiting callers are released in small staggered slots to avoid a retry herd, and an
`AbortSignal` cancels a queued wait before any credentials or request are sent. Unsafe methods are
not retried by default, but their rate-limit responses still update the shared gate for subsequent
calls.

### Full typed API

```ts
const result = await soundcloud.GET('/tracks/{track_urn}', {
  params: { path: { track_urn: 'soundcloud:tracks:308946187' } },
})

const page = await soundcloud.GET('/me/likes/tracks', {
  params: { query: { limit: 50, linked_partitioning: true } },
})
```

SoundCloud URNs are opaque strings and replace deprecated numeric IDs. Playlist creation normalizes
numeric IDs and resolved track URLs to URNs before sending the current official `POST /playlists`
payload. `raw()` remains available for forward compatibility, including comma-list and deep-object
query encoding.

## Keep the API current

```sh
pnpm --filter @gakonst/soundcloud openapi:sync
pnpm --filter @gakonst/soundcloud check
```

The sync command downloads the official YAML, adds stable operation IDs for Incur, regenerates
TypeScript and CLI schemas, and records the source hash.

MIT licensed. SoundCloud is a trademark of SoundCloud. This package is not affiliated with or
endorsed by SoundCloud.
