# slsk-ts

A high-performance, fully typed Soulseek client for Node.js 22+, with an [Incur](https://github.com/wevm/incur)-based CLI.

The package implements the complete known Soulseek wire surface: server, peer-init, peer, distributed, and raw file-transfer connections. Active protocol messages have typed codecs and every known legacy identifier remains accessible through the raw API. Unknown future messages are preserved as zero-copy `Buffer` payloads instead of being discarded.

> This is an independent, reverse-engineered client and is not affiliated with Soulseek.

## Features

- Login and automatic first-login account registration
- Network, room, and user-scoped search
- Direct connections with automatic indirect/firewall fallback
- Resumable, size-bounded downloads with progress events
- Upload queues, slots, resume offsets, browse responses, and share search
- User profiles, private messages, room chat, tickers, interests, and recommendations
- Public/private rooms and their membership/operator protocol
- Distributed parent/child search topology and embedded server searches
- Incremental bounded frame decoding, backpressure-aware writes, and compressed-message limits
- All known server, peer, peer-init, and distributed message codes
- Incur CLI with TOON/JSON/YAML/Markdown/JSONL output, schemas, completions, MCP, and agent skills
- Client library at 100% statement, branch, function, and line coverage

## Install

```sh
pnpm add slsk-ts
# or: npm install slsk-ts
```

## Library quick start

```ts
import { SoulseekClient } from 'slsk-ts'

const client = new SoulseekClient()

try {
  // Soulseek registers an unused username on its first successful login.
  await client.connect(process.env.SLSK_USERNAME!, process.env.SLSK_PASSWORD!)

  const results = await client.search('autechre flac', {
    timeout: 8_000,
    maxResults: 50,
  })

  const first = results[0]?.files[0]
  if (first) {
    await client.download(results[0]!.username, first.filename, './track.flac', {
      onProgress: ({ percent }) => console.log(`${percent}%`),
    })
  }
} finally {
  await client.disconnect()
}
```

The constructor performs no I/O. `connect()` starts the inbound listener before logging in, advertises its actual port, and only resolves once the server has accepted the login and the client is online.

### Search scopes

```ts
await client.search('ambient')
await client.search('ambient', { user: 'some-user' })
await client.search('ambient', { room: 'Electronic' })
```

### Browse, profile, and chat

```ts
const shares = await client.browse('some-user')
const profile = await client.userInfo('some-user')

await client.sendPrivateMessage('some-user', 'hello')
await client.joinRoom('Electronic')
await client.sendRoomMessage('Electronic', 'hello room')
```

### Share files

Index files before connecting so the initial server announcement contains correct counts:

```ts
const client = new SoulseekClient({ uploadSlots: 2 })
await client.shares.addDirectory('/srv/music', { alias: 'Music' })
await client.connect(username, password)
```

The share index never derives upload paths from untrusted virtual paths. Only files explicitly indexed by real path can be opened.

### Events

The client is an `EventEmitter`. Useful events include:

- `state` — lifecycle state changes
- `message`, `serverMessage`, `peerMessage` — decoded protocol traffic
- `privateMessage`, `roomMessage` — chat traffic
- `peerConnected` — direct, indirect, or distributed session established
- `searchResult` — an individual peer result set
- `downloadProgress`, `downloadComplete`, `uploadComplete`
- `clientError` — recoverable background connection or serving errors

### Low-level protocol API

```ts
import {
  BinaryReader,
  BinaryWriter,
  FrameDecoder,
  ServerCode,
  decodeFrame,
  encodeFrame,
  server,
} from 'slsk-ts/protocol'

await client.send(server.checkPrivileges())

// Raw escape hatch for legacy or newly discovered messages.
await client.send(server.raw(9999, new BinaryWriter().string('payload')))
```

See [docs/protocol.md](./docs/protocol.md) for wire and compatibility details.

## CLI

The CLI reads credentials from the environment:

```sh
export SLSK_USERNAME='my-user'
export SLSK_PASSWORD='my-password'

slsk login
slsk search 'autechre flac' --format json
slsk browse some-user
slsk download some-user 'Music\Album\Track.flac' ./Track.flac
slsk message send some-user 'hello'
slsk room join Electronic
slsk serve /srv/music --alias Music
```

Optional environment variables:

- `SLSK_SERVER` — server in `host:port` form; defaults to `server.slsknet.org:2242`
- `SLSK_LISTEN_PORT` — inbound peer port; defaults to `0` (an OS-assigned port)

Incur supplies structured output and agent integrations:

```sh
slsk --llms
slsk search --schema
slsk completions zsh
slsk skills add
slsk mcp add
```

The CLI definition is importable without reading `.env` or serving a process, so another Incur CLI
can mount the complete `slsk` command group directly:

```ts
import { Cli } from 'incur'
import slskCli from 'slsk-ts/cli'

Cli.create('music').command(slskCli)
```

## Development

```sh
gh repo clone gakonst/djbooth
cd djbooth
pnpm install
pnpm --filter slsk-ts check             # types + lint + 100% coverage
pnpm --filter slsk-ts build
pnpm --filter slsk-ts bench
```

The live test is opt-in and never stores credentials:

```sh
SLSK_E2E_USERNAME=... SLSK_E2E_PASSWORD=... pnpm --filter slsk-ts test:e2e
```

## Performance and safety

- `BinaryWriter` grows geometrically and writes primitives directly into its backing buffer.
- `BinaryReader` returns zero-copy slices and bounds-checks every access.
- `FrameDecoder` handles arbitrary TCP chunk boundaries and limits declared frame sizes before allocation.
- Compressed browse/search messages have an independent inflated-size ceiling.
- Socket writes honor Node backpressure.
- Downloads cannot write beyond the peer-declared size and resume offsets are validated.
- Connection, handshake, request, search, and transfer waits are bounded and abort-aware.

Run `BENCH_ITERATIONS=1000000 pnpm --filter slsk-ts bench` for local protocol throughput numbers.

## License

MIT
