import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { EngineKind, MediaInfo } from '../src/core/types.js'
import {
  downloadMusicBatch,
  MUSIC_FORMAT_SPEC,
  MUSIC_OUTPUT_TEMPLATE,
  type MusicDependencies,
} from '../src/music.js'

const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

describe('music batch downloads', () => {
  it('limits YouTube concurrency, keeps source quality, writes metadata, and archives successes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ytdlp-ts-music-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const archive = join(directory, 'archive.txt')
    let activeYoutube = 0
    let maxActiveYoutube = 0
    const referenceOptions: unknown[] = []

    const dependencies: MusicDependencies = {
      async inspect(url: string, _engine: EngineKind) {
        const youtube = url.includes('youtube')
        const id = url.split('/').at(-1)!
        const info: MediaInfo = {
          id,
          title: id,
          extractor_key: youtube ? 'Youtube' : 'Soundcloud',
          formats: [
            {
              format_id: youtube ? '251' : 'http_mp3_0_0',
              url: `${url}/media`,
              ext: youtube ? 'webm' : 'mp3',
              vcodec: 'none',
              acodec: youtube ? 'opus' : 'mp3',
              abr: youtube ? 160 : 128,
            },
          ],
        }
        return { engine: youtube ? 'reference' : 'native', data: info }
      },
      async downloadNative(_info, options) {
        expect(options.format).toBe(MUSIC_FORMAT_SPEC)
        expect(options.output).toBe(MUSIC_OUTPUT_TEMPLATE)
        expect(options.writeInfoJson).toBe(true)
        expect(options.writeThumbnail).toBe(true)
        await delay(15)
        return { files: ['track.mp3', 'track.info.json'], selectedFormats: ['http_mp3_0_0'] }
      },
      async downloadReference(_url, options) {
        activeYoutube += 1
        maxActiveYoutube = Math.max(maxActiveYoutube, activeYoutube)
        referenceOptions.push(options)
        await delay(20)
        activeYoutube -= 1
        return { files: ['track.webm', 'track.info.json'], stdout: '', stderr: '' }
      },
    }

    const urls = [
      'https://youtube.test/y1',
      'https://youtube.test/y2',
      'https://soundcloud.test/s1',
      'https://soundcloud.test/s2',
    ]
    const result = await downloadMusicBatch(
      urls,
      { archive, concurrency: 4, youtubeConcurrency: 1 },
      dependencies,
    )

    expect(result).toMatchObject({ requested: 4, tracks: 4, downloaded: 4, skipped: 0, failed: 0 })
    expect(maxActiveYoutube).toBe(1)
    expect(referenceOptions).toEqual([
      expect.objectContaining({
        format: 'bestaudio/best',
        concurrentFragments: 1,
        retries: 10,
        fragmentRetries: 10,
        embedMetadata: true,
        embedThumbnail: true,
        writeInfoJson: true,
        extractAudio: true,
        audioFormat: 'best',
        sleepRequests: 1,
        sleepInterval: 2,
        maxSleepInterval: 5,
        throttledRate: '100K',
        retrySleep: ['http:exp=1:20', 'fragment:exp=1:20', 'extractor:exp=1:20'],
      }),
      expect.anything(),
    ])
    expect(
      (await readFile(archive, 'utf8'))
        .trim()
        .split('\n')
        .filter((line) => !line.startsWith('url '))
        .sort(),
    ).toEqual([
      'soundcloud s1',
      'soundcloud s2',
      'youtube y1',
      'youtube y2',
    ])

    const skipped = await downloadMusicBatch(urls, { archive, concurrency: 4 }, {
      ...dependencies,
      async downloadNative() {
        throw new Error('archive should skip native download')
      },
      async downloadReference() {
        throw new Error('archive should skip reference download')
      },
    })
    expect(skipped).toMatchObject({ downloaded: 0, skipped: 4, failed: 0 })
  })

  it('routes best-audio HLS through the fragment-resumable reference downloader', async () => {
    let referenceOptions: unknown
    const dependencies: MusicDependencies = {
      async inspect() {
        return {
          engine: 'native',
          data: {
            id: 'hls-track',
            title: 'HLS track',
            extractor_key: 'Soundcloud',
            formats: [
              {
                format_id: 'hls_aac_160k',
                url: 'https://cdn.test/audio.m3u8',
                ext: 'm4a',
                protocol: 'm3u8_native',
                vcodec: 'none',
                acodec: 'aac',
                abr: 160,
              },
            ],
          },
        }
      },
      async downloadNative() {
        throw new Error('HLS must not use the native FFmpeg downloader')
      },
      async downloadReference(_url, options) {
        referenceOptions = options
        return { files: ['hls.m4a'], stdout: '', stderr: '' }
      },
    }

    const result = await downloadMusicBatch(['https://soundcloud.test/hls'], {}, dependencies)

    expect(result).toMatchObject({ downloaded: 1, failed: 0 })
    expect(result.items[0]).toMatchObject({ engine: 'reference', status: 'downloaded' })
    expect(referenceOptions).toMatchObject({
      format: 'bestaudio/best',
      retries: 10,
      fragmentRetries: 10,
      extractAudio: true,
      audioFormat: 'best',
      embedMetadata: true,
      embedThumbnail: true,
    })
  })
})

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
