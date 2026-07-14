import { describe, expect, it } from 'vitest'

import {
  buildDownloadArgs,
  buildInspectArgs,
  ReferenceClient,
  type ReferenceResult,
  type ReferenceRunOptions,
} from '../src/bridge/reference.js'

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

  it('threads cancellation from inspect and download into reference execution', async () => {
    class CapturingReferenceClient extends ReferenceClient {
      readonly calls: Array<{ args: string[]; options: ReferenceRunOptions }> = []

      override async run(
        args: string[],
        options: ReferenceRunOptions = {},
      ): Promise<ReferenceResult> {
        this.calls.push({ args, options })
        const inspecting = args.includes('--dump-single-json')
        return {
          command: 'captured',
          args,
          exitCode: 0,
          stdout: inspecting
            ? JSON.stringify({ id: 'track', title: 'Track' })
            : '__YTDLP_TS_FILE__:/tmp/track.m4a\n',
          stderr: '',
        }
      }
    }
    const controller = new AbortController()
    const client = new CapturingReferenceClient()

    await client.inspect('https://example.com/track', { signal: controller.signal })
    await client.download('https://example.com/track', { signal: controller.signal })

    expect(client.calls).toHaveLength(2)
    expect(client.calls.every((call) => call.options.signal === controller.signal)).toBe(true)
  })

  it('does not spawn an already-aborted reference execution', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      new ReferenceClient('definitely-not-a-real-binary').run([], { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('terminates and drains an in-flight reference execution on abort', async () => {
    const controller = new AbortController()
    const running = new ReferenceClient(process.execPath).run(
      ['-e', 'setInterval(() => {}, 1_000)'],
      { signal: controller.signal },
    )
    controller.abort()

    await expect(running).rejects.toMatchObject({ code: 'ABORTED' })
  })
})
