# rekordbox-ts

A TypeScript port of [pyrekordbox](https://github.com/dylanljones/pyrekordbox), with a typed library API and an agent-friendly CLI built on [incur](https://github.com/wevm/incur).

> [!CAUTION]
> Back up your Rekordbox collection before using any write operation. This project is not affiliated with AlphaTheta Corporation, Pioneer Corporation, or their related companies.

## Status

The port is under active development. See [PORTING.md](./PORTING.md) for the pinned upstream revision, compatibility matrix, decisions, and chronological progress log.

## Development

Requires Node.js 22 or newer and pnpm.

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm cli --help
```

The package will expose both a TypeScript API and the `rekordbox` executable. The CLI's `--llms`, `--schema`, `--format`, MCP, and skill-discovery features are supplied by incur.

## License

MIT. This is an independent TypeScript port. The original pyrekordbox copyright and license notice are retained in [LICENSE](./LICENSE).
