# Compatibility matrix

Legend: **native** is TypeScript, **reference** is delegated to yt-dlp, **planned** is unavailable
without delegation.

| Subsystem | Native | Reference | Notes |
| --- | --- | --- | --- |
| Incur CLI / MCP / HTTP metadata | yes | n/a | Typed structured commands |
| Generic direct HTTP media | planned | yes | First native extractor milestone |
| Generic HTML / OpenGraph | planned | yes | First native extractor milestone |
| YouTube | planned | yes | Player signature tests required |
| Remaining site extractors | planned | yes | Ported by traffic and fixture coverage |
| Format selection | planned | yes | yt-dlp expression grammar |
| HTTP file downloader | planned | yes | Resume, range, retries, rate limit |
| HLS / DASH | planned | yes | Manifest parsing and fragments |
| FFmpeg post-processing | planned | yes | Merge, remux, audio extraction |
| Cookies / browser cookies | planned | yes | Cookie jar and browser stores |
| Subtitles / thumbnails | planned | yes | Selection and conversion |
| Plugins | planned | yes | TypeScript plugin ABI to be specified |

Parity is measured with differential fixtures against the pinned yt-dlp revision, not by counting
files with matching names.
