import { describe, expect, it } from 'vitest'

import {
  parseSoundcloudHydration,
  parseSoundcloudTrack,
  SoundcloudExtractor,
} from '../src/extractors/soundcloud.js'

describe('SoundCloud extractor', () => {
  it('recognizes SoundCloud URLs', () => {
    const extractor = new SoundcloudExtractor()
    expect(extractor.suitable(new URL('https://soundcloud.com/artist/track'))).toBe(true)
    expect(extractor.suitable(new URL('https://example.com/artist/track'))).toBe(false)
  })

  it('extracts balanced hydration data', () => {
    const hydration = parseSoundcloudHydration(
      '<script>window.__sc_hydration = [{"hydratable":"sound","data":{"title":"] in title"}}];</script>',
    )
    expect(hydration).toEqual([{ hydratable: 'sound', data: { title: '] in title' } }])
  })

  it('maps track metadata and resolved audio formats', () => {
    const info = parseSoundcloudTrack(
      {
        id: 123,
        title: 'Test track',
        description: 'Description',
        duration: 62_500,
        created_at: '2025-01-02T03:04:05Z',
        permalink_url: 'https://soundcloud.com/artist/test',
        artwork_url: 'https://i1.sndcdn.com/artworks-test-large.jpg',
        playback_count: 100,
        likes_count: 20,
        genre: 'Electronic',
        user: { id: 456, username: 'artist' },
      },
      [
        {
          transcoding: {
            preset: 'mp3_0_0',
            quality: 'sq',
            format: { protocol: 'progressive', mime_type: 'audio/mpeg' },
          },
          url: 'https://cf-media.sndcdn.com/test.mp3',
        },
        {
          transcoding: {
            preset: 'aac_96k',
            quality: 'lq',
            format: { protocol: 'hls', mime_type: 'audio/mp4; codecs="mp4a.40.2"' },
          },
          url: 'https://cf-hls.sndcdn.com/test.m3u8',
        },
      ],
      'https://soundcloud.com/artist/test',
    )

    expect(info).toMatchObject({
      id: '123',
      title: 'Test track',
      uploader: 'artist',
      uploader_id: '456',
      duration: 62.5,
      timestamp: 1735787045,
      upload_date: '20250102',
      view_count: 100,
      like_count: 20,
      genre: 'Electronic',
      extractor_key: 'Soundcloud',
      formats: [
        { format_id: 'http_mp3_0_0', ext: 'mp3', abr: 128, vcodec: 'none', acodec: 'mp3' },
        { format_id: 'hls_aac_96k', ext: 'm4a', abr: 96, protocol: 'm3u8_native' },
      ],
    })
    expect(info.thumbnails).toEqual([
      { id: 'large', url: 'https://i1.sndcdn.com/artworks-test-large.jpg' },
      { id: 'original', url: 'https://i1.sndcdn.com/artworks-test-original.jpg', preference: 1 },
    ])
  })
})
