import { describe, expect, it } from 'vitest'

import {
  extractPlayerResponse,
  extractYoutubeId,
  parseYoutubePlayerResponse,
} from '../src/extractors/youtube.js'

describe('YouTube extractor', () => {
  it('recognizes common URL shapes', () => {
    expect(extractYoutubeId(new URL('https://youtu.be/BaW_jenozKc?t=1'))).toBe('BaW_jenozKc')
    expect(extractYoutubeId(new URL('https://www.youtube.com/shorts/BaW_jenozKc'))).toBe('BaW_jenozKc')
    expect(extractYoutubeId(new URL('https://youtube.com/watch?v=BaW_jenozKc'))).toBe('BaW_jenozKc')
  })

  it('extracts a balanced player response containing braces in strings', () => {
    expect(
      extractPlayerResponse('<script>var ytInitialPlayerResponse = {"videoDetails":{"title":"a } b"}};</script>'),
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
          thumbnail: { thumbnails: [{ url: 'https://i.ytimg.com/vi/x/default.jpg', width: 120, height: 90 }] },
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
              { baseUrl: 'https://example.com/caption?lang=en', languageCode: 'en', name: { simpleText: 'English' } },
              { baseUrl: 'https://example.com/asr?lang=en', languageCode: 'en', kind: 'asr', name: { simpleText: 'English auto' } },
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
})
