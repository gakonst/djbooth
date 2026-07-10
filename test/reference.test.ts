import { describe, expect, it } from 'vitest'

import { buildDownloadArgs, buildInspectArgs } from '../src/bridge/reference.js'

describe('reference argument construction', () => {
  it('makes inspection deterministic and protects URL position', () => {
    expect(
      buildInspectArgs('https://example.com/-video', {
        playlist: false,
        cookies: 'cookies.txt',
        extractorArgs: ['youtube:player_client=web'],
      }),
    ).toEqual([
      '--ignore-config',
      '--dump-single-json',
      '--skip-download',
      '--no-warnings',
      '--no-playlist',
      '--cookies',
      'cookies.txt',
      '--extractor-args',
      'youtube:player_client=web',
      '--',
      'https://example.com/-video',
    ])
  })

  it('maps structured download options to yt-dlp switches', () => {
    expect(
      buildDownloadArgs('https://example.com/video', {
        format: 'bv*+ba/b',
        output: '%(title)s.%(ext)s',
        extractAudio: true,
        audioFormat: 'mp3',
        subtitleLanguages: ['en.*', 'de'],
        sponsorblockRemove: ['sponsor', 'selfpromo'],
      }),
    ).toEqual([
      '--ignore-config',
      '--newline',
      '--print',
      'after_move:__YTDLP_TS_FILE__:%(filepath)s',
      '-f',
      'bv*+ba/b',
      '-o',
      '%(title)s.%(ext)s',
      '--extract-audio',
      '--audio-format',
      'mp3',
      '--sub-langs',
      'en.*',
      '--sub-langs',
      'de',
      '--sponsorblock-remove',
      'sponsor',
      '--sponsorblock-remove',
      'selfpromo',
      '--',
      'https://example.com/video',
    ])
  })
})
