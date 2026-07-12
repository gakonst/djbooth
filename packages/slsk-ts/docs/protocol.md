# Soulseek protocol notes

Soulseek is an undocumented binary protocol. This implementation was independently built from observed interoperability behavior and cross-checked against the current Nicotine+ and Soulseek.NET implementations.

## Framing

All integers are little-endian. Strings are a `uint32` byte length followed by UTF-8 bytes; invalid legacy UTF-8 falls back to Latin-1.

| Domain | Length prefix | Code | Payload |
| --- | ---: | ---: | --- |
| Server | `uint32` | `uint32` | `length - 4` bytes |
| Peer | `uint32` | `uint32` | `length - 4` bytes |
| Peer initialization | `uint32` | `uint8` | `length - 1` bytes |
| Distributed | `uint32` | `uint8` | `length - 1` bytes |

The prefix excludes its own four bytes and includes the message code. File-transfer connections switch to an unframed stream after peer initialization: the uploader sends a `uint32` transfer token, the downloader returns a `uint64` resume offset, and file bytes follow.

## Connections

- `P` — regular peer messages (browse, search results, profile, and transfer negotiation)
- `F` — raw file transfer
- `D` — distributed search tree

For a direct connection, the initiator sends peer-init code `1` with its username, connection type, and a zero legacy token. If direct TCP fails, it asks the server to coordinate an indirect connection. The responding peer connects back and sends peer-init code `0` with the server-issued token.

## Compression

Browse responses, search responses, and folder responses use zlib streams. The client bounds decompressed output (256 MiB by default) to prevent compression bombs. This can be tuned with `ConnectionOptions.maxInflatedSize`.

## Identification

The default login version is major `177`, minor `1`. Contemporary protocol guidance reserves major 177 for experimental clients so they do not impersonate official or established third-party clients. Both values can be overridden in `connect()`.

## Message coverage

The enums in [src/protocol/codes.ts](../src/protocol/codes.ts) list all known identifiers:

- 102 server identifiers, including current, deprecated, and legacy messages
- 2 peer-initialization identifiers
- 25 peer identifiers
- 7 distributed identifiers

Active messages have typed encoders and decoders. Legacy or direction-specific messages that do not have a high-level helper remain usable through `server.raw`, `peer.raw`, `encodeFrame`, and `decodeFrame`. Unknown identifiers decode to `Unknown(<code>)` with their payload intact.

## Compatibility details

- File sizes use `uint64`; the decoder works around the legacy Soulseek NS >2 GiB sign-extension bug.
- Paths received from peers are normalized to Soulseek's backslash convention.
- File attributes retain unknown key/value pairs for forward compatibility.
- Search and browse responses preserve public and private result lists.
- Older distributed embedded-message variants using either a one-byte or padded four-byte code are accepted.
- Obfuscation metadata is decoded when present, while peer transport remains unobfuscated for maximum interoperability.

Protocol behavior evolves. Raw payload preservation and the low-level API are intentional compatibility valves for messages discovered after this release.
