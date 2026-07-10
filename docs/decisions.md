# Architecture decisions

This is the durable decision log for `spots`. Dates use Pacific time.

## 2026-07-10 — The official OpenAPI schema is authoritative

Spotify publishes an OpenAPI 3.0 schema. `spots` snapshots that schema and generates the TypeScript
path/operation types from it. This avoids a hand-maintained endpoint list drifting from Spotify's API.
Deprecated operations remain available because older extended-quota applications may still use them.

## 2026-07-10 — One API surface, two front ends

The library exposes a typed `SpotifyClient`; the CLI routes the same requests through `incur`.
This keeps authentication, refresh, error handling, retry behavior, and endpoint coverage consistent.

## 2026-07-10 — PKCE is the default interactive login

The CLI uses Authorization Code with PKCE and a loopback callback at `127.0.0.1`. It stores the
refreshable token in a mode-`0600` user config file. Client Credentials remains available for
server-to-server access to public data, but cannot access personal history or library endpoints.

## 2026-07-10 — Full endpoint coverage plus a raw escape hatch

Every operation in Spotify's schema is exposed as an `incur` command. A raw request command covers
media types that OpenAPI-to-CLI argument generation cannot model conveniently and future endpoints
that appear before the checked-in schema is refreshed.
