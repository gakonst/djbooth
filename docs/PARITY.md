# Compatibility matrix

Legend: **native** is TypeScript, **reference** is delegated to yt-dlp, **planned** is unavailable
without delegation.

| Subsystem | Native | Reference | Notes |
| --- | --- | --- | --- |
| Incur CLI / MCP / HTTP metadata | yes | n/a | Typed structured commands |
| Generic direct HTTP media | yes | yes | HTTP media and HLS manifests |
| Generic HTML / OpenGraph | partial | yes | Meta tags, media tags, JSON-LD, HLS |
| YouTube | planned | yes | Player signature tests required |
| Remaining site extractors | planned | yes | Ported by traffic and fixture coverage |
| Format selection | planned | yes | yt-dlp expression grammar |
| HTTP file downloader | planned | yes | Resume, range, retries, rate limit |
| HLS / DASH | partial | yes | Native HLS master/media parsing; download and DASH planned |
| FFmpeg post-processing | planned | yes | Merge, remux, audio extraction |
| Cookies / browser cookies | planned | yes | Cookie jar and browser stores |
| Subtitles / thumbnails | planned | yes | Selection and conversion |
| Plugins | planned | yes | TypeScript plugin ABI to be specified |

Parity is measured with differential fixtures against the pinned yt-dlp revision, not by counting
files with matching names.
