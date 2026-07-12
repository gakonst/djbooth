# soundcloud

`@gakonst/soundcloud` is a complete, strongly typed client for SoundCloud's documented HTTP API
and an agent-friendly CLI built with [Incur](https://github.com/wevm/incur). Its checked-in types and
commands are generated from SoundCloud's official OpenAPI schema.

## Highlights

- Every official OpenAPI path through typed `GET`, `POST`, `PUT`, and `DELETE` methods.
- OAuth 2.1 Authorization Code with required PKCE and client secret for account access.
- Secure mode-`0600` saved sessions and atomic, cross-process refresh-token rotation.
- Persistent Client Credentials tokens for public search and URL resolution.
- Automatic one-time 401 refresh plus bounded 429 and transient-read retries.
- Safe linked pagination through opaque `next_href` URLs.
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
```

`--urls` returns canonical `soundcloud.com` track permalinks suitable for inspection and selected
downloads with `@gakonst/ytdlp-ts`. The API client intentionally handles metadata and account state;
audio acquisition remains in ytdlp-ts.

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
```

### Full typed API

```ts
const result = await soundcloud.GET('/tracks/{track_urn}', {
  params: { path: { track_urn: 'soundcloud:tracks:308946187' } },
})

const page = await soundcloud.GET('/me/likes/tracks', {
  params: { query: { limit: 50, linked_partitioning: true } },
})
```

SoundCloud URNs are opaque strings and replace deprecated numeric IDs. `raw()` remains available
for forward compatibility, including comma-list and deep-object query encoding.

## Keep the API current

```sh
pnpm --filter @gakonst/soundcloud openapi:sync
pnpm --filter @gakonst/soundcloud check
```

The sync command downloads the official YAML, adds stable operation IDs for Incur, regenerates
TypeScript and CLI schemas, and records the source hash.

MIT licensed. SoundCloud is a trademark of SoundCloud. This package is not affiliated with or
endorsed by SoundCloud.
