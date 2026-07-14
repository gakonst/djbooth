# Architecture decisions

## ADR-001: Behavioral parity over transliteration

**Decision:** Preserve yt-dlp's observable behavior, data model, option semantics, and extractor
ordering without mechanically transliterating Python syntax.

**Why:** A line-by-line conversion would retain Python-specific abstractions and make the result
neither idiomatic nor reliably testable in TypeScript.

## ADR-002: Transparent reference bridge during migration

**Decision:** Keep an explicit `reference` engine that invokes an installed yt-dlp executable for
unported behavior. `auto` may fall back only for typed, allowlisted capability failures before
media bytes are committed. Abort, network, lock, write, identity, and validation failures fail
closed. Every response reports the selected engine and delegated responses include fallback
provenance.

**Why:** The upstream has more than 2,000 extractor classes and changes daily. The bridge makes the
CLI useful from the first milestone while differential tests drive native replacement. It is a
migration mechanism, not the definition of completion.

## ADR-003: Incur-native structured commands plus raw compatibility

**Decision:** Expose common workflows as typed incur commands (`inspect`, `formats`, `download`,
and related commands), and expose the complete legacy option surface through `compat --arg`.

**Why:** Thousands of loosely related legacy switches do not form a good schema for agents. Typed
commands provide discoverability and MCP/HTTP support while the raw command keeps exact coverage.

## ADR-004: Keep upstream artifacts out of the repository

**Decision:** Do not vendor the 225k-line Python tree. Record upstream SHAs and derive narrow,
reviewable fixtures.

**Why:** Vendoring would obscure which modules are truly ported and would make the repository look
complete without reducing the runtime dependency.

## ADR-005: Optimize the primary workflow for music libraries

**Decision:** Make `music` the opinionated path: best source audio, metadata JSON, artwork, durable
archives, playlist-wide concurrency, provider-specific overrides, and automatic resume. Keep
`download` as the lower-level compatibility surface.

**Why:** Audio quality is harmed by unnecessary transcoding, while large batches need stronger
idempotency and network-bound throughput. Three concurrent tracks avoid provider bursts while each
native YouTube track can still issue two bounded-range requests. Explicit global/reference caps of
16 and 4, plus a native YouTube cap of 16, preserve opt-in throughput for controlled networks.
