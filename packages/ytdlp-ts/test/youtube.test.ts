import { describe, expect, it } from 'vitest'

import { inspect } from '../src/core/engine.js'
import {
  YoutubeExtractor,
  extractPlayerResponse,
  extractYoutubeId,
  parseYoutubePlayerResponse,
} from '../src/extractors/youtube.js'

describe('YouTube extractor', () => {
  it('fails closed instead of silently collapsing a requested playlist to one video', async () => {
    await expect(
      inspect('https://www.youtube.com/watch?v=BaW_jenozKc&list=PL-native-test', 'native', {
        playlist: true,
      }),
    ).rejects.toMatchObject({ code: 'NATIVE_PLAYLIST_UNSUPPORTED' })
  })

  it('recognizes common URL shapes', () => {
    expect(extractYoutubeId(new URL('https://youtu.be/BaW_jenozKc?t=1'))).toBe('BaW_jenozKc')
    expect(extractYoutubeId(new URL('https://www.youtube.com/shorts/BaW_jenozKc'))).toBe(
      'BaW_jenozKc',
    )
    expect(extractYoutubeId(new URL('https://youtube.com/watch?v=BaW_jenozKc'))).toBe('BaW_jenozKc')
  })

  it('extracts a balanced player response containing braces in strings', () => {
    expect(
      extractPlayerResponse(
        '<script>var ytInitialPlayerResponse = {"videoDetails":{"title":"a } b"}};</script>',
      ),
    ).toEqual({ videoDetails: { title: 'a } b' } })
  })

  it('maps direct formats, metadata, thumbnails, and captions', async () => {
    const info = await parseYoutubePlayerResponse(
      {
        playabilityStatus: { status: 'OK' },
        videoDetails: {
          videoId: 'BaW_jenozKc',
          title: 'youtube-dl test video',
          author: 'Philipp Hagemeister',
          channelId: 'UC-id',
          lengthSeconds: '10',
          viewCount: '123',
          shortDescription: 'test',
          thumbnail: {
            thumbnails: [{ url: 'https://i.ytimg.com/vi/x/default.jpg', width: 120, height: 90 }],
          },
        },
        microformat: { playerMicroformatRenderer: { uploadDate: '2012-10-02' } },
        streamingData: {
          formats: [
            {
              itag: 18,
              url: 'https://example.com/video.mp4',
              mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
              width: 640,
              height: 360,
              bitrate: 500000,
              contentLength: '1000',
            },
          ],
        },
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              {
                baseUrl: 'https://example.com/caption?lang=en',
                languageCode: 'en',
                name: { simpleText: 'English' },
              },
              {
                baseUrl: 'https://example.com/asr?lang=en',
                languageCode: 'en',
                kind: 'asr',
                name: { simpleText: 'English auto' },
              },
            ],
          },
        },
      },
      'https://www.youtube.com/watch?v=BaW_jenozKc',
    )

    expect(info).toMatchObject({
      id: 'BaW_jenozKc',
      title: 'youtube-dl test video',
      uploader: 'Philipp Hagemeister',
      duration: 10,
      view_count: 123,
      upload_date: '20121002',
      extractor_key: 'Youtube',
      formats: [{ format_id: '18', height: 360, tbr: 500, filesize: 1000 }],
      subtitles: { en: [{ ext: 'vtt', name: 'English' }] },
      automatic_captions: { en: [{ ext: 'vtt', name: 'English auto' }] },
    })
  })

  it('uses Android VR direct formats without player-code evaluation', async () => {
    const requestedClients: string[] = []
    const extractor = new YoutubeExtractor({
      createClient: async () => ({
        async getBasicInfo(_videoId, options) {
          requestedClients.push(options.client)
          return {
            basic_info: {
              id: 'BaW_jenozKc',
              title: 'Direct audio',
              duration: 10,
              author: 'Uploader',
              channel_id: 'UC-id',
              thumbnail: [{ url: 'https://i.ytimg.com/vi/x/default.jpg', width: 120, height: 90 }],
            },
            streaming_data: {
              formats: [],
              adaptive_formats: [
                {
                  itag: 140,
                  url: 'https://example.googlevideo.com/videoplayback?expire=1',
                  mime_type: 'audio/mp4; codecs="mp4a.40.2"',
                  has_audio: true,
                  has_video: false,
                  bitrate: 131_000,
                  average_bitrate: 128_000,
                  content_length: 1_000,
                },
              ],
            },
            page: [{}],
          }
        },
      }),
    })

    const info = await extractor.extract(new URL('https://youtube.com/watch?v=BaW_jenozKc'), {})

    expect(requestedClients).toEqual(['ANDROID_VR'])
    expect(info).toMatchObject({
      id: 'BaW_jenozKc',
      title: 'Direct audio',
      uploader: 'Uploader',
      duration: 10,
      formats: [
        {
          format_id: '140',
          ext: 'm4a',
          protocol: 'https',
          acodec: 'mp4a.40.2',
          vcodec: 'none',
          abr: 128,
          filesize: 1_000,
        },
      ],
    })
  })

  it('fails closed when direct Android VR audio lacks a stable content length', async () => {
    const extractor = new YoutubeExtractor({
      createClient: async () => ({
        async getBasicInfo() {
          return {
            basic_info: { id: 'BaW_jenozKc', title: 'No direct audio' },
            streaming_data: {
              formats: [],
              adaptive_formats: [
                {
                  itag: 140,
                  url: 'https://rr1.example.googlevideo.com/videoplayback?sig=secret',
                  mime_type: 'audio/mp4; codecs="mp4a.40.2"',
                  has_audio: true,
                  has_video: false,
                  bitrate: 128_000,
                },
              ],
            },
            page: [{}],
          }
        },
      }),
    })

    await expect(
      extractor.extract(new URL('https://youtube.com/watch?v=BaW_jenozKc'), {}),
    ).rejects.toMatchObject({ code: 'YOUTUBE_DIRECT_FORMATS_UNAVAILABLE' })
  })

  it('rejects a mismatched video identity', async () => {
    const extractor = new YoutubeExtractor({
      createClient: async () => ({
        async getBasicInfo() {
          return { basic_info: { id: 'wrong-id', title: 'Wrong' }, page: [{}] }
        },
      }),
    })

    await expect(
      extractor.extract(new URL('https://youtube.com/watch?v=BaW_jenozKc'), {}),
    ).rejects.toMatchObject({ code: 'YOUTUBE_IDENTITY_MISMATCH' })
  })
})
