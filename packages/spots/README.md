# spots

`spots` is a complete, strongly typed client for Spotify's documented Web API and an
agent-friendly CLI built with [`incur`](https://github.com/wevm/incur).

The checked-in Spotify OpenAPI schema currently contains **96 operations across 70 paths**. Every
operation is available from TypeScript and as a structured CLI command. User login uses OAuth 2.0
Authorization Code with PKCE, including automatic refresh, so personal endpoints such as recently
played tracks work without manually copying access tokens.

## Highlights

- Complete request and response types generated from Spotify's official OpenAPI schema.
- Typed `GET`, `POST`, `PUT`, and `DELETE` methods, plus raw requests and pagination.
- Interactive Spotify user login with PKCE and a loopback callback.
- Secure local refresh-token storage with mode `0600` on Unix.
- Client Credentials and static access-token providers for non-interactive use.
- Automatic access-token refresh, one-time 401 recovery, `Retry-After` handling, and transient
  5xx retries.
- All 96 Spotify operations exposed through `incur`, with JSON Schema, structured output, MCP,
  agent skill generation, shell completion, and LLM-readable discovery.

## Requirements

- Node.js 22 or newer.
- A Spotify account.
- A Spotify developer application from the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).

In the Spotify app settings, register this exact redirect URI:

```text
http://127.0.0.1:8787/callback
```

Spotify permits HTTP only for explicit loopback IP addresses; `localhost` is not accepted.

## Install

```sh
pnpm add @gakonst/spots
```

For development in the monorepo:

```sh
gh repo clone gakonst/music-ts
cd music-ts
pnpm install
pnpm --filter @gakonst/spots build
pnpm --filter @gakonst/spots cli -- --help
```

## Log in as your Spotify user

Copy the Client ID from the Spotify Developer Dashboard. PKCE does not require a client secret.

```sh
export SPOTIFY_CLIENT_ID=your_client_id
spots auth login
```

The command starts a callback server on `127.0.0.1`, opens Spotify's authorization page, and saves
the resulting refreshable session to `~/.config/spots/credentials.json`. Set
`SPOTS_CREDENTIALS_PATH` to use a different file.

The default login requests read access for playlists, library items, follows, top items, playback
state, and recently played items. Ask for mutation and playback-control permissions explicitly:

```sh
spots auth login --all-scopes
spots auth login --scopes 'user-read-recently-played,user-library-read'
spots auth scopes
```

For a headless machine, use `--no-browser`, then open the printed URL yourself. The callback still
needs to reach the machine running `spots`.

Inspect or remove the saved session:

```sh
spots auth status
spots auth refresh
spots auth logout
```

## CLI examples

The most common personal queries have short commands:

```sh
spots me
spots recent --limit 50
spots recent --all --format json
```

The `api` group contains every operation from Spotify's schema:

```sh
spots api --help
spots api get-recently-played --limit 20
spots api get-users-saved-tracks --limit 50
spots api search --q 'kind of blue' --type album,track --limit 10
spots api start-a-users-playback --device_id DEVICE_ID --uris '["spotify:track:ID"]'
```

Use `--help` or `--schema` on any command to inspect its arguments:

```sh
spots api search --help
spots api search --schema
```

The raw command is an escape hatch for unusual media types and endpoints added after the last
schema sync:

```sh
spots request GET /me
spots request GET /search --query '{"q":"Miles Davis","type":"artist"}'
spots request PUT /me/player/play --query '{"device_id":"..."}' --body @playback.json
```

### Authentication precedence

API commands choose credentials in this order:

1. `SPOTIFY_ACCESS_TOKEN`.
2. The saved user session created by `spots auth login`.
3. `SPOTIFY_CLIENT_ID` plus `SPOTIFY_CLIENT_SECRET` using Client Credentials.

Client Credentials can only call public, non-user endpoints.

### Agent and structured-output features

These come from `incur` and require no additional adapter code:

```sh
spots --llms                 # compact command manifest
spots --llms-full            # full command manifest
spots --mcp                  # serve all commands over MCP stdio
spots mcp add                # register the MCP server
spots skills add             # install an agent skill for this CLI
spots completions zsh        # generate shell completions
spots recent --format json
spots recent --filter-output 'items[0].track.name'
```

## TypeScript client

### Saved user session

```ts
import { FileSessionStore, SpotifyClient, SpotifyOAuth } from '@gakonst/spots'

const store = new FileSessionStore()
const session = await store.load()
if (!session) throw new Error('Run `spots auth login` first')

const auth = new SpotifyOAuth({
  clientId: session.clientId,
  redirectUri: session.redirectUri,
  store,
})
const spotify = new SpotifyClient({ auth })

const { data, error, response } = await spotify.GET('/me/player/recently-played', {
  params: { query: { limit: 20 } },
})

if (error) throw new Error(`Spotify returned ${response.status}`)
for (const item of data.items) console.log(item.track.name)
```

The path, parameters, success response, and error response are inferred directly from the Spotify
schema. Invalid paths or parameter names fail TypeScript compilation.

### Client Credentials

```ts
import { ClientCredentialsProvider, SpotifyClient } from '@gakonst/spots'

const spotify = new SpotifyClient({
  auth: new ClientCredentialsProvider({
    clientId: process.env.SPOTIFY_CLIENT_ID!,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET!,
  }),
})

const album = await spotify.GET('/albums/{id}', {
  params: { path: { id: '4aawyAB9vmqN3uQ7FjRGTy' } },
})
```

### Raw requests and paging

```ts
const profile = await spotify.raw<{ id: string }>('GET', '/me')

for await (const item of spotify.paginate('/me/tracks', { limit: 50 })) {
  console.log(item)
}
```

`spotify.raw()` throws `SpotifyApiError` for non-success responses. The generated `GET`/`POST`/
`PUT`/`DELETE` methods follow `openapi-fetch` conventions and return `{ data, error, response }`.

## Keeping the API current

```sh
pnpm openapi:sync
pnpm check
```

The sync command downloads Spotify's official schema, removes documentation-only policy extensions,
regenerates TypeScript types and CLI metadata, and records the source hash in
`src/generated/metadata.json`. Review the schema and generated diff before committing it.

Spotify marks some operations deprecated or restricts them for newer Development Mode apps. `spots`
keeps those documented operations because existing Extended Quota Mode apps may still have access;
the CLI labels deprecated operations where Spotify's schema does.

## Development

```sh
pnpm check       # formatting, lint, typecheck, and tests
pnpm build       # ESM library, declarations, and CLI
pnpm cli -- --help
```

See the [progress log](docs/progress.md) and [architecture decisions](docs/decisions.md) for the
implementation trail.

## License

MIT. Spotify is a trademark of Spotify AB. This project is not affiliated with or endorsed by
Spotify.
