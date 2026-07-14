import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { EngineKind, MediaInfo } from '../src/core/types.js'
import { YtdlpError } from '../src/core/errors.js'
import { selectFormats } from '../src/core/format-selector.js'
import {
  DEFAULT_MUSIC_CONCURRENCY,
  DEFAULT_NATIVE_YOUTUBE_CONCURRENCY,
  DEFAULT_YOUTUBE_CONCURRENCY,
  downloadMusicBatch,
  MAX_MUSIC_CONCURRENCY,
  MAX_NATIVE_YOUTUBE_CONCURRENCY,
  MAX_YOUTUBE_CONCURRENCY,
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
    let activeInspections = 0
    let maxActiveInspections = 0
    const referenceOptions: unknown[] = []

    const dependencies: MusicDependencies = {
      async inspect(url: string, _engine: EngineKind) {
        activeInspections += 1
        maxActiveInspections = Math.max(maxActiveInspections, activeInspections)
        await delay(5)
        activeInspections -= 1
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
        return youtube
          ? {
              engine: 'reference',
              fallback: { from: 'native', code: 'YOUTUBE_DIRECT_FORMATS_UNAVAILABLE' },
              data: info,
            }
          : { engine: 'native', data: info }
      },
      async downloadNative(_info, options) {
        expect(options.format).toBe(MUSIC_FORMAT_SPEC)
        expect(options.output).toBe(MUSIC_OUTPUT_TEMPLATE)
        expect(options.writeInfoJson).toBe(true)
        expect(options.writeThumbnail).toBe(true)
        await delay(15)
        return {
          files: ['track.mp3', 'track.info.json'],
          selectedFormats: ['http_mp3_0_0'],
        }
      },
      async downloadReference(_url, options) {
        activeYoutube += 1
        maxActiveYoutube = Math.max(maxActiveYoutube, activeYoutube)
        referenceOptions.push(options)
        await delay(20)
        activeYoutube -= 1
        return {
          files: ['track.webm', 'track.info.json'],
          stdout: '',
          stderr: '',
        }
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

    expect(result).toMatchObject({
      requested: 4,
      tracks: 4,
      downloaded: 4,
      skipped: 0,
      failed: 0,
    })
    expect(maxActiveInspections).toBe(4)
    expect(maxActiveYoutube).toBe(1)
    expect(referenceOptions).toEqual([
      expect.objectContaining({
        format: MUSIC_FORMAT_SPEC,
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
    ).toEqual(['soundcloud s1', 'soundcloud s2', 'youtube y1', 'youtube y2'])

    const skipped = await downloadMusicBatch(
      urls,
      { archive, concurrency: 4 },
      {
        ...dependencies,
        async downloadNative() {
          throw new Error('archive should skip native download')
        },
        async downloadReference() {
          throw new Error('archive should skip reference download')
        },
      },
    )
    expect(skipped).toMatchObject({ downloaded: 0, skipped: 4, failed: 0 })
  })

  it('prepares with three workers and serializes reference YouTube by default', async () => {
    expect(DEFAULT_MUSIC_CONCURRENCY).toBe(3)
    expect(MAX_MUSIC_CONCURRENCY).toBe(16)
    expect(DEFAULT_YOUTUBE_CONCURRENCY).toBe(1)
    expect(MAX_YOUTUBE_CONCURRENCY).toBe(4)
    expect(DEFAULT_NATIVE_YOUTUBE_CONCURRENCY).toBe(3)
    expect(MAX_NATIVE_YOUTUBE_CONCURRENCY).toBe(16)
    let activeInspections = 0
    let maxActiveInspections = 0
    let activeDownloads = 0
    let maxActiveDownloads = 0
    const urls = Array.from({ length: 70 }, (_, index) => `https://youtube.test/track-${index}`)
    const dependencies: MusicDependencies = {
      async inspect(url) {
        activeInspections += 1
        maxActiveInspections = Math.max(maxActiveInspections, activeInspections)
        const index = Number(url.split('-').at(-1))
        await delay(index % 3)
        activeInspections -= 1
        return {
          engine: 'reference',
          fallback: { from: 'native', code: 'YOUTUBE_DIRECT_FORMATS_UNAVAILABLE' },
          data: {
            id: `track-${index}`,
            title: `Track ${index}`,
            extractor_key: 'Youtube',
            webpage_url: url,
          },
        }
      },
      async downloadNative() {
        throw new Error('YouTube should use the reference downloader')
      },
      async downloadReference(url) {
        activeDownloads += 1
        maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads)
        const index = Number(url.split('-').at(-1))
        await delay((70 - index) % 4)
        activeDownloads -= 1
        return { files: [`track-${index}.m4a`], stdout: '', stderr: '' }
      },
    }

    const result = await downloadMusicBatch(urls, {}, dependencies)

    expect(maxActiveInspections).toBe(3)
    expect(maxActiveDownloads).toBe(1)
    expect(result).toMatchObject({
      requested: 70,
      tracks: 70,
      downloaded: 70,
      failed: 0,
    })
    expect(result.items.map((item) => item.id)).toEqual(
      Array.from({ length: 70 }, (_, index) => `track-${index}`),
    )
  })

  it('keeps preparation errors in source order and honors an explicit lower limit', async () => {
    let activeInspections = 0
    let maxActiveInspections = 0
    let activeDownloads = 0
    let maxActiveDownloads = 0
    const urls = Array.from({ length: 6 }, (_, index) => `https://soundcloud.test/track-${index}`)
    const dependencies: MusicDependencies = {
      async inspect(url) {
        activeInspections += 1
        maxActiveInspections = Math.max(maxActiveInspections, activeInspections)
        const index = Number(url.split('-').at(-1))
        await delay((6 - index) % 3)
        activeInspections -= 1
        if (index === 2) throw new Error('inspection failed')
        return {
          engine: 'native',
          data: {
            id: `track-${index}`,
            title: `Track ${index}`,
            extractor_key: 'Soundcloud',
            formats: [
              {
                format_id: 'http_mp3_0_0',
                url: `${url}/media.mp3`,
                ext: 'mp3',
                protocol: 'https',
                vcodec: 'none',
                acodec: 'mp3',
              },
            ],
          },
        }
      },
      async downloadNative(info) {
        activeDownloads += 1
        maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads)
        await delay(3)
        activeDownloads -= 1
        return { files: [`${info.id}.mp3`], selectedFormats: ['http_mp3_0_0'] }
      },
      async downloadReference() {
        throw new Error('progressive SoundCloud should use the native downloader')
      },
    }

    const result = await downloadMusicBatch(urls, { concurrency: 2 }, dependencies)

    expect(maxActiveInspections).toBe(2)
    expect(maxActiveDownloads).toBe(2)
    expect(result.items.map((item) => item.id ?? item.url)).toEqual([
      'track-0',
      'track-1',
      urls[2],
      'track-3',
      'track-4',
      'track-5',
    ])
    expect(result.items[2]).toMatchObject({
      url: urls[2],
      status: 'failed',
      error: 'inspection failed',
    })
  })

  it('stops planning, aborts blocked siblings, and drains them before fail-fast rejection', async () => {
    const primaryFailure = new Error('primary inspection failed')
    let releaseBlockedStart!: () => void
    const blockedStarted = new Promise<void>((resolve) => {
      releaseBlockedStart = resolve
    })
    let blockedCleanedUp = false
    let queuedInspections = 0
    let blockedSignal: AbortSignal | undefined
    const dependencies: MusicDependencies = {
      async inspect(url, _engine, options) {
        const id = url.split('/').at(-1)!
        if (id === 'fail') {
          await blockedStarted
          throw primaryFailure
        }
        if (id === 'blocked') {
          blockedSignal = options.signal
          releaseBlockedStart()
          await waitForAbort(options.signal)
          await delay(10)
          blockedCleanedUp = true
          throw new YtdlpError('ABORTED', 'blocked inspection cleaned up')
        }
        queuedInspections += 1
        return { engine: 'native', data: nativeSoundCloudInfo(id, url) }
      },
      async downloadNative() {
        throw new Error('downloads must not start after planning fails')
      },
      async downloadReference() {
        throw new Error('reference download must not start')
      },
    }

    await expect(
      downloadMusicBatch(
        [
          'https://soundcloud.test/fail',
          'https://soundcloud.test/blocked',
          'https://soundcloud.test/queued',
        ],
        { concurrency: 2, continueOnError: false, engine: 'native' },
        dependencies,
      ),
    ).rejects.toBe(primaryFailure)

    expect(blockedSignal?.aborted).toBe(true)
    expect(blockedCleanedUp).toBe(true)
    expect(queuedInspections).toBe(0)
  })

  it('drains blocked downloads and prevents archive writes before fail-fast rejection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ytdlp-ts-fail-fast-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const archive = join(directory, 'archive.txt')
    const primaryFailure = new Error('primary download failed')
    let releaseBlockedStart!: () => void
    const blockedStarted = new Promise<void>((resolve) => {
      releaseBlockedStart = resolve
    })
    let blockedCleanedUp = false
    let queuedDownloads = 0
    let blockedSignal: AbortSignal | undefined
    const events: string[] = []
    const dependencies: MusicDependencies = {
      async inspect(url) {
        const id = url.split('/').at(-1)!
        return { engine: 'native', data: nativeSoundCloudInfo(id, url) }
      },
      async downloadNative(info, options) {
        if (info.id === 'fail') {
          await blockedStarted
          events.push('primary-failure')
          throw primaryFailure
        }
        if (info.id === 'blocked') {
          blockedSignal = options.signal
          releaseBlockedStart()
          await waitForAbort(options.signal)
          events.push('blocked-abort')
          await delay(10)
          blockedCleanedUp = true
          events.push('blocked-cleanup')
          return { files: ['blocked.mp3'], selectedFormats: ['http_mp3_0_0'] }
        }
        queuedDownloads += 1
        return { files: ['queued.mp3'], selectedFormats: ['http_mp3_0_0'] }
      },
      async downloadReference() {
        throw new Error('reference download must not start')
      },
    }

    const running = downloadMusicBatch(
      [
        'https://soundcloud.test/fail',
        'https://soundcloud.test/blocked',
        'https://soundcloud.test/queued',
      ],
      { archive, concurrency: 2, continueOnError: false, engine: 'native' },
      dependencies,
    )
    await expect(running).rejects.toBe(primaryFailure)
    events.push('batch-rejected')

    expect(blockedSignal?.aborted).toBe(true)
    expect(blockedCleanedUp).toBe(true)
    expect(queuedDownloads).toBe(0)
    expect(events).toEqual([
      'primary-failure',
      'blocked-abort',
      'blocked-cleanup',
      'batch-rejected',
    ])
    const archiveAtRejection = await optionalFile(archive)
    await delay(20)
    expect(await optionalFile(archive)).toBe(archiveAtRejection)
    expect(archiveAtRejection).toBe('')
  })

  it('links caller cancellation into in-flight inspection', async () => {
    const caller = new AbortController()
    let releaseInspectionStart!: () => void
    const inspectionStarted = new Promise<void>((resolve) => {
      releaseInspectionStart = resolve
    })
    let cleanedUp = false
    const dependencies: MusicDependencies = {
      async inspect(_url, _engine, options) {
        releaseInspectionStart()
        await waitForAbort(options.signal)
        cleanedUp = true
        throw new YtdlpError('ABORTED', 'inspection aborted')
      },
      async downloadNative() {
        throw new Error('download must not start')
      },
      async downloadReference() {
        throw new Error('download must not start')
      },
    }

    const running = downloadMusicBatch(
      ['https://soundcloud.test/track'],
      { signal: caller.signal, engine: 'native' },
      dependencies,
    )
    await inspectionStarted
    caller.abort()

    await expect(running).rejects.toMatchObject({ code: 'ABORTED' })
    expect(cleanedUp).toBe(true)
  })

  it('routes native YouTube audio through three network-bound track workers', async () => {
    let active = 0
    let maximumActive = 0
    const dependencies: MusicDependencies = {
      async inspect(url) {
        const id = url.split('/').at(-1)!
        return {
          engine: 'native',
          data: {
            id,
            title: id,
            extractor_key: 'Youtube',
            formats: [
              {
                format_id: '140',
                url: `https://rr1.example.googlevideo.com/${id}`,
                ext: 'm4a',
                protocol: 'https',
                vcodec: 'none',
                acodec: 'mp4a.40.2',
                filesize: 1_000,
              },
            ],
          },
        }
      },
      async downloadNative() {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await delay(20)
        active -= 1
        return { files: ['track.m4a'], selectedFormats: ['140'] }
      },
      async downloadReference() {
        throw new Error('native YouTube must not use the reference engine')
      },
    }

    const result = await downloadMusicBatch(
      ['https://youtube.test/y1', 'https://youtube.test/y2', 'https://youtube.test/y3'],
      { engine: 'native', concurrency: 3 },
      dependencies,
    )

    expect(result).toMatchObject({ downloaded: 3, failed: 0 })
    expect(result.items.every((item) => item.engine === 'native')).toBe(true)
    expect(maximumActive).toBe(3)
  })

  it('prefers source M4A over higher-bitrate WebM for Rekordbox workflows', async () => {
    let selectedFormat: string | undefined
    const dependencies: MusicDependencies = {
      async inspect() {
        return {
          engine: 'native',
          data: {
            id: 'video',
            title: 'Video',
            extractor_key: 'Youtube',
            formats: [
              {
                format_id: '140',
                url: 'https://rr1.example.googlevideo.com/m4a',
                ext: 'm4a',
                vcodec: 'none',
                acodec: 'mp4a.40.2',
                abr: 129,
                filesize: 1_000,
              },
              {
                format_id: '251',
                url: 'https://rr1.example.googlevideo.com/webm',
                ext: 'webm',
                vcodec: 'none',
                acodec: 'opus',
                abr: 160,
                filesize: 1_200,
              },
            ],
          },
        }
      },
      async downloadNative(info, options) {
        selectedFormat = selectFormats(info.formats ?? [], options.format)[0]?.format_id
        return { files: ['video.m4a'], selectedFormats: [selectedFormat!] }
      },
      async downloadReference() {
        throw new Error('compatible native source must not fall back')
      },
    }

    const result = await downloadMusicBatch(['https://youtube.test/video'], {}, dependencies)

    expect(result.items[0]).toMatchObject({ status: 'downloaded', engine: 'native' })
    expect(selectedFormat).toBe('140')
  })

  it('refreshes native YouTube capabilities before transfer and once after HTTP 403', async () => {
    let inspections = 0
    let downloads = 0
    const dependencies: MusicDependencies = {
      async inspect() {
        inspections += 1
        return {
          engine: 'native',
          data: {
            id: 'video',
            title: 'Video',
            extractor_key: 'Youtube',
            formats: [
              {
                format_id: '140',
                url: `https://rr1.example.googlevideo.com/${inspections}`,
                ext: 'm4a',
                protocol: 'https',
                vcodec: 'none',
                acodec: 'mp4a.40.2',
                filesize: 1_000,
              },
            ],
          },
        }
      },
      async downloadNative() {
        downloads += 1
        if (downloads === 1) {
          throw new YtdlpError('HTTP_ERROR', 'expired', { status: 403 })
        }
        return { files: ['video.m4a'], selectedFormats: ['140'] }
      },
      async downloadReference() {
        throw new Error('native refresh should recover without reference fallback')
      },
    }

    const result = await downloadMusicBatch(
      ['https://youtube.test/video'],
      { engine: 'native' },
      dependencies,
    )

    expect(result).toMatchObject({ downloaded: 1, failed: 0 })
    expect(inspections).toBe(3)
    expect(downloads).toBe(2)
  })

  it('reports the reference engine when range capability negotiation falls back before transfer', async () => {
    let referenceDownloads = 0
    const dependencies: MusicDependencies = {
      async inspect() {
        return {
          engine: 'native',
          data: {
            id: 'video',
            title: 'Video',
            extractor_key: 'Youtube',
            formats: [
              {
                format_id: '140',
                url: 'https://rr1.example.googlevideo.com/video',
                ext: 'm4a',
                protocol: 'https',
                vcodec: 'none',
                acodec: 'mp4a.40.2',
                filesize: 1_000,
              },
            ],
          },
        }
      },
      async downloadNative() {
        throw new YtdlpError('RANGE_NOT_SUPPORTED', 'native transfer unavailable')
      },
      async downloadReference() {
        referenceDownloads += 1
        return { files: ['video.m4a'], stdout: '', stderr: '' }
      },
    }

    const result = await downloadMusicBatch(
      ['https://youtube.test/video'],
      { engine: 'auto' },
      dependencies,
    )

    expect(result.items[0]).toMatchObject({
      status: 'downloaded',
      engine: 'reference',
      fallback: { from: 'native', code: 'RANGE_NOT_SUPPORTED' },
    })
    expect(referenceDownloads).toBe(1)
  })

  it('preserves typed inspection fallback provenance on each reference download', async () => {
    const dependencies: MusicDependencies = {
      async inspect() {
        return {
          engine: 'reference',
          fallback: { from: 'native', code: 'YOUTUBE_DIRECT_FORMATS_UNAVAILABLE' },
          data: {
            id: 'video',
            title: 'Video',
            extractor_key: 'Youtube',
          },
        }
      },
      async downloadNative() {
        throw new Error('inspection already selected the typed reference fallback')
      },
      async downloadReference() {
        return { files: ['video.m4a'], stdout: '', stderr: '' }
      },
    }

    const result = await downloadMusicBatch(['https://youtube.test/video'], {}, dependencies)

    expect(result.items[0]).toMatchObject({
      status: 'downloaded',
      engine: 'reference',
      fallback: { from: 'native', code: 'YOUTUBE_DIRECT_FORMATS_UNAVAILABLE' },
    })
  })

  it('refuses an auto reference download without typed inspection provenance', async () => {
    let referenceDownloads = 0
    const dependencies: MusicDependencies = {
      async inspect() {
        return {
          engine: 'reference',
          data: { id: 'video', title: 'Video', extractor_key: 'Youtube' },
        }
      },
      async downloadNative() {
        throw new Error('native download must not run')
      },
      async downloadReference() {
        referenceDownloads += 1
        return { files: ['video.m4a'], stdout: '', stderr: '' }
      },
    }

    const result = await downloadMusicBatch(['https://youtube.test/video'], {}, dependencies)

    expect(result.items[0]).toMatchObject({
      status: 'failed',
      error: 'Auto inspection returned a reference result without typed native fallback provenance',
    })
    expect(referenceDownloads).toBe(0)
  })

  it('retains native fallback provenance when the delegated reference transfer fails', async () => {
    const dependencies: MusicDependencies = {
      async inspect() {
        return {
          engine: 'native',
          data: {
            id: 'track',
            title: 'Track',
            extractor_key: 'Soundcloud',
            formats: [],
          },
        }
      },
      async downloadNative() {
        throw new Error('format selection must happen before native download')
      },
      async downloadReference() {
        throw new Error('reference transfer failed')
      },
    }

    const result = await downloadMusicBatch(['https://soundcloud.test/track'], {}, dependencies)

    expect(result.items[0]).toMatchObject({
      status: 'failed',
      engine: 'reference',
      fallback: { from: 'native', code: 'NO_FORMATS' },
      error: 'reference transfer failed',
    })
  })

  it('reports a typed non-best option gap in auto and fails closed in native mode', async () => {
    let nativeDownloads = 0
    let referenceDownloads = 0
    const dependencies: MusicDependencies = {
      async inspect() {
        return {
          engine: 'native',
          data: {
            id: 'track',
            title: 'Track',
            extractor_key: 'Soundcloud',
            formats: [
              {
                format_id: 'http_mp3_0_0',
                url: 'https://cdn.test/track.mp3',
                ext: 'mp3',
                protocol: 'https',
                vcodec: 'none',
                acodec: 'mp3',
              },
            ],
          },
        }
      },
      async downloadNative() {
        nativeDownloads += 1
        return { files: ['track.mp3'], selectedFormats: ['http_mp3_0_0'] }
      },
      async downloadReference() {
        referenceDownloads += 1
        return { files: ['track.flac'], stdout: '', stderr: '' }
      },
    }

    const automatic = await downloadMusicBatch(
      ['https://soundcloud.test/track'],
      { audioFormat: 'flac' },
      dependencies,
    )
    const native = await downloadMusicBatch(
      ['https://soundcloud.test/track'],
      { audioFormat: 'flac', engine: 'native' },
      dependencies,
    )

    expect(automatic.items[0]).toMatchObject({
      status: 'downloaded',
      engine: 'reference',
      fallback: { from: 'native', code: 'NATIVE_OPTION_UNAVAILABLE' },
    })
    expect(native.items[0]).toMatchObject({
      status: 'failed',
      error: 'Native music downloads do not yet support --audio-format flac',
    })
    expect(nativeDownloads).toBe(0)
    expect(referenceDownloads).toBe(1)
  })

  it('routes reference-only inspection options through typed fallback and never ignores them natively', async () => {
    const inspectedEngines: EngineKind[] = []
    const inspectedOptions: unknown[] = []
    let nativeDownloads = 0
    let referenceDownloads = 0
    const dependencies: MusicDependencies = {
      async inspect(url, engine, options) {
        inspectedEngines.push(engine)
        inspectedOptions.push(options)
        return {
          engine: 'reference',
          data: {
            id: url.split('/').at(-1)!,
            title: 'Track',
            extractor_key: 'Soundcloud',
          },
        }
      },
      async downloadNative() {
        nativeDownloads += 1
        return { files: ['track.mp3'], selectedFormats: ['http_mp3_0_0'] }
      },
      async downloadReference() {
        referenceDownloads += 1
        return { files: ['track.m4a'], stdout: '', stderr: '' }
      },
    }

    const automatic = await downloadMusicBatch(
      ['https://soundcloud.test/proxied'],
      { proxy: 'http://127.0.0.1:8080' },
      dependencies,
    )
    const native = await downloadMusicBatch(
      ['https://soundcloud.test/authenticated'],
      { cookies: 'cookies.txt', engine: 'native' },
      dependencies,
    )

    expect(automatic.items[0]).toMatchObject({
      status: 'downloaded',
      engine: 'reference',
      fallback: { from: 'native', code: 'NATIVE_OPTION_UNAVAILABLE' },
    })
    expect(native.items[0]).toMatchObject({
      status: 'failed',
      error: 'Native music inspection does not yet support --cookies',
    })
    expect(inspectedEngines).toEqual(['reference'])
    expect(inspectedOptions[0]).toMatchObject({
      proxy: 'http://127.0.0.1:8080',
      signal: expect.any(AbortSignal),
    })
    expect(nativeDownloads).toBe(0)
    expect(referenceDownloads).toBe(1)
  })

  it('keeps explicit reference selection free of native fallback provenance', async () => {
    const dependencies: MusicDependencies = {
      async inspect() {
        return {
          engine: 'reference',
          data: { id: 'track', title: 'Track', extractor_key: 'Soundcloud' },
        }
      },
      async downloadNative() {
        throw new Error('explicit reference mode must not run native download')
      },
      async downloadReference() {
        return { files: ['track.m4a'], stdout: '', stderr: '' }
      },
    }

    const result = await downloadMusicBatch(
      ['https://soundcloud.test/track'],
      { engine: 'reference' },
      dependencies,
    )

    expect(result.items[0]).toMatchObject({ status: 'downloaded', engine: 'reference' })
    expect(result.items[0]).not.toHaveProperty('fallback')
  })

  it.each([
    'ABORTED',
    'CONTENT_TOO_LONG',
    'CONTENT_TOO_SHORT',
    'EMPTY_RESPONSE',
    'HTTP_ERROR',
    'INVALID_CONTENT_LENGTH',
    'INVALID_CONTENT_RANGE',
    'NETWORK_ERROR',
    'OUTPUT_LOCKED',
    'WRITE_FAILED',
    'YOUTUBE_IDENTITY_MISMATCH',
  ])('does not invoke the external reference engine after native %s', async (code) => {
    let referenceDownloads = 0
    const dependencies: MusicDependencies = {
      async inspect() {
        return {
          engine: 'native',
          data: {
            id: 'video',
            title: 'Video',
            extractor_key: 'Youtube',
            formats: [
              {
                format_id: '140',
                url: 'https://rr1.example.googlevideo.com/video',
                ext: 'm4a',
                vcodec: 'none',
                acodec: 'mp4a.40.2',
                filesize: 1_000,
              },
            ],
          },
        }
      },
      async downloadNative() {
        throw new YtdlpError(code, code)
      },
      async downloadReference() {
        referenceDownloads += 1
        return { files: ['video.m4a'], stdout: '', stderr: '' }
      },
    }

    const result = await downloadMusicBatch(['https://youtube.test/video'], {}, dependencies)

    expect(result.items[0]).toMatchObject({ status: 'failed', error: code })
    expect(referenceDownloads).toBe(0)
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
    expect(result.items[0]).toMatchObject({
      engine: 'reference',
      fallback: { from: 'native', code: 'RANGE_NOT_SUPPORTED' },
      status: 'downloaded',
    })
    expect(referenceOptions).toMatchObject({
      format: MUSIC_FORMAT_SPEC,
      retries: 10,
      fragmentRetries: 10,
      extractAudio: true,
      audioFormat: 'best',
      embedMetadata: true,
      embedThumbnail: true,
    })
  })

  it('does not reference-fallback from HLS when native mode is explicit', async () => {
    let referenceDownloads = 0
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
              },
            ],
          },
        }
      },
      async downloadNative() {
        throw new Error('HLS capability check must happen before native transfer')
      },
      async downloadReference() {
        referenceDownloads += 1
        return { files: ['hls.m4a'], stdout: '', stderr: '' }
      },
    }

    const result = await downloadMusicBatch(
      ['https://soundcloud.test/hls'],
      { engine: 'native' },
      dependencies,
    )

    expect(result.items[0]).toMatchObject({
      status: 'failed',
      error:
        'The selected audio requires fragment-aware transfer unavailable in the native music downloader',
    })
    expect(referenceDownloads).toBe(0)
  })
})

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) throw new Error('expected an abort signal')
  if (signal.aborted) return
  await new Promise<void>((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  )
}

function nativeSoundCloudInfo(id: string, url: string): MediaInfo {
  return {
    id,
    title: id,
    extractor_key: 'Soundcloud',
    webpage_url: url,
    formats: [
      {
        format_id: 'http_mp3_0_0',
        url: `${url}/media.mp3`,
        ext: 'mp3',
        protocol: 'https',
        vcodec: 'none',
        acodec: 'mp3',
      },
    ],
  }
}

async function optionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}
