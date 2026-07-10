import { describe, expect, it } from 'vitest'

import { parseM3u8Formats } from '../src/core/manifest.js'

describe('HLS manifest parsing', () => {
  it('extracts variants and resolves relative URLs', () => {
    const formats = parseM3u8Formats(
      `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,AVERAGE-BANDWIDTH=650000,RESOLUTION=640x360,FRAME-RATE=29.97,CODECS="avc1.4d401e,mp4a.40.2"
360/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
https://cdn.example/720.m3u8`,
      'https://cdn.example/master.m3u8',
    )

    expect(formats).toEqual([
      expect.objectContaining({
        format_id: 'hls-360',
        url: 'https://cdn.example/360/index.m3u8',
        width: 640,
        height: 360,
        fps: 29.97,
        tbr: 650,
        vcodec: 'avc1.4d401e',
        acodec: 'mp4a.40.2',
      }),
      expect.objectContaining({
        format_id: 'hls-720',
        url: 'https://cdn.example/720.m3u8',
        height: 720,
        tbr: 2400,
      }),
    ])
  })

  it('returns a media-playlist format', () => {
    expect(
      parseM3u8Formats('#EXTM3U\n#EXTINF:4.0,\nsegment.ts', 'https://cdn.example/media.m3u8'),
    ).toEqual([
      {
        format_id: 'hls',
        url: 'https://cdn.example/media.m3u8',
        ext: 'mp4',
        protocol: 'm3u8_native',
      },
    ])
  })
})
