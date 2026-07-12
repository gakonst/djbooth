# Compatibility matrix

Legend: **native** is TypeScript, **reference** is delegated to yt-dlp, **planned** is unavailable
without delegation.

| Subsystem | Native | Reference | Notes |
| --- | --- | --- | --- |
| Incur CLI / MCP / HTTP metadata | yes | n/a | Typed structured commands |
| Generic direct HTTP media | yes | yes | HTTP media and HLS manifests |
| Generic HTML / OpenGraph | partial | yes | Meta tags, media tags, JSON-LD, HLS |
| YouTube | partial | yes | Metadata, direct formats, captions; signature transform falls back |
| SoundCloud | partial | yes | Native public tracks and streams; sets/profiles fall back |
| Music batch orchestration | yes | yes | Quality-first scheduling, archive, metadata, resume policy |
| Remaining site extractors | planned | yes | Ported by traffic and fixture coverage |
| Format selection | partial | yes | Common selectors, fallback, merge, filters, nth-best |
| HTTP file downloader | partial | yes | Resume, range, retries, rate limit, atomic part files |
| HLS / DASH | partial | yes | Native HLS and BaseURL DASH parsing/download |
| FFmpeg post-processing | partial | yes | Native format merge and audio extraction |
| Cookies / browser cookies | planned | yes | Cookie jar and browser stores |
| Subtitles / thumbnails | partial | yes | Native sidecar selection/download; embedding planned |
| Plugins | planned | yes | TypeScript plugin ABI to be specified |

Parity is measured with differential fixtures against the pinned yt-dlp revision, not by counting
files with matching names.
