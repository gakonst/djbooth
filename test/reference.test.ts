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

  it('maps archive, throttling, and exponential retry policy', () => {
    const args = buildDownloadArgs('https://youtube.com/watch?v=abcdefghijk', {
      format: 'bestaudio/best',
      downloadArchive: '.archive',
      concurrentFragments: 1,
      retries: 10,
      fragmentRetries: 10,
      sleepRequests: 1,
      sleepInterval: 2,
      maxSleepInterval: 5,
      throttledRate: '100K',
      retrySleep: ['http:exp=1:20', 'fragment:exp=1:20'],
      writeInfoJson: true,
      embedMetadata: true,
      embedThumbnail: true,
    })

    for (const pair of [
      ['-f', 'bestaudio/best'],
      ['--download-archive', '.archive'],
      ['--concurrent-fragments', '1'],
      ['--retries', '10'],
      ['--fragment-retries', '10'],
      ['--sleep-requests', '1'],
      ['--sleep-interval', '2'],
      ['--max-sleep-interval', '5'],
      ['--throttled-rate', '100K'],
      ['--retry-sleep', 'http:exp=1:20'],
      ['--retry-sleep', 'fragment:exp=1:20'],
    ]) {
      expect(args.join('\0')).toContain(pair.join('\0'))
    }
    expect(args).toContain('--write-info-json')
    expect(args).toContain('--embed-metadata')
    expect(args).toContain('--embed-thumbnail')
  })
})
