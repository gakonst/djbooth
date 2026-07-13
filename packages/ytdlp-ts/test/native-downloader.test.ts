import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { downloadMedia, parseRate, sanitizeMediaInfoForOutput } from '../src/downloader/native.js'
import type { MediaInfo } from '../src/core/types.js'

const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

describe('native downloader', () => {
  it('holds an exclusive lock for each final output path', async () => {
    let releaseResponse!: () => void
    const released = new Promise<void>((resolve) => {
      releaseResponse = resolve
    })
    let markRequested!: () => void
    const requested = new Promise<void>((resolve) => {
      markRequested = resolve
    })
    const server = createServer((_request, response) => {
      markRequested()
      void released.then(() => response.end('locked-media'))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const directory = await mkdtemp(join(tmpdir(), 'ytdlp-ts-lock-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const firstInfo: MediaInfo = {
      id: 'first',
      title: 'Locked',
      formats: [
        {
          format_id: 'direct',
          url: `http://127.0.0.1:${address.port}/audio.m4a`,
          ext: 'm4a',
          vcodec: 'none',
          acodec: 'aac',
        },
      ],
    }
    const secondInfo: MediaInfo = { ...firstInfo, id: 'second' }

    const options = { paths: directory, format: 'bestaudio', output: 'forced.%(ext)s' }
    const first = downloadMedia(firstInfo, options)
    await requested
    await expect(downloadMedia(secondInfo, options)).rejects.toMatchObject({
      code: 'OUTPUT_LOCKED',
    })
    releaseResponse()
    await expect(first).resolves.toMatchObject({ selectedFormats: ['direct'] })
  })

  it('releases an output lock after transfer failure', async () => {
    let requests = 0
    const server = createServer((_request, response) => {
      requests += 1
      if (requests === 1) response.destroy()
      else response.end('recovered-media')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const directory = await mkdtemp(join(tmpdir(), 'ytdlp-ts-lock-error-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const info: MediaInfo = {
      id: 'release',
      title: 'Release',
      formats: [
        {
          format_id: 'direct',
          url: `http://127.0.0.1:${address.port}/audio.m4a`,
          ext: 'm4a',
          vcodec: 'none',
          acodec: 'aac',
        },
      ],
    }

    await expect(downloadMedia(info, { paths: directory, retries: 0 })).rejects.toBeDefined()
    await expect(downloadMedia(info, { paths: directory, retries: 0 })).resolves.toMatchObject({
      selectedFormats: ['direct'],
    })
  })

  it('discards an unbound part file instead of promoting stale media', async () => {
    const body = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz')
    const ranges: string[] = []
    const server = createServer((request, response) => {
      ranges.push(request.headers.range ?? '')
      const range = /^bytes=(\d+)-$/u.exec(request.headers.range ?? '')
      const start = range ? Number(range[1]) : 0
      response.statusCode = start > 0 ? 206 : 200
      response.setHeader('content-length', body.length - start)
      if (start > 0)
        response.setHeader('content-range', `bytes ${start}-${body.length - 1}/${body.length}`)
      response.end(body.subarray(start))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const directory = await mkdtemp(join(tmpdir(), 'ytdlp-ts-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const output = join(directory, 'Example [id].mp4')
    await writeFile(`${output}.part`, Buffer.alloc(body.length, 0))
    const info: MediaInfo = {
      id: 'id',
      title: 'Example',
      formats: [
        {
          format_id: 'direct',
          url: `http://127.0.0.1:${address.port}/video.mp4`,
          ext: 'mp4',
          vcodec: 'avc1',
          acodec: 'aac',
        },
      ],
    }

    const result = await downloadMedia(info, { paths: directory })

    expect(result.files).toEqual([output])
    expect(await readFile(output)).toEqual(body)
    expect(ranges).toEqual([''])
  })

  it('parses decimal rate limits', () => {
    expect(parseRate('4.2M')).toBe(4_200_000)
    expect(parseRate('128kB')).toBe(128_000)
  })

  it('recursively removes signed media and caption capabilities from structured output', () => {
    const safe = sanitizeMediaInfoForOutput({
      id: 'video',
      title: 'Video',
      webpage_url: 'https://www.youtube.com/watch?v=video',
      subtitles: {
        en: [
          {
            url: 'https://www.youtube.com/api/timedtext?expire=1&key=yt8&signature=secret',
          },
        ],
      },
      entries: [
        {
          id: 'entry',
          title: 'Entry',
          formats: [
            {
              format_id: '140',
              url: 'https://rr1.example.googlevideo.com/videoplayback?sig=secret',
              http_headers: { Authorization: 'transient' },
            },
          ],
        },
      ],
    })

    expect(safe.webpage_url).toBe('https://www.youtube.com/watch?v=video')
    expect(safe.subtitles?.en?.[0]?.url).toBe('[redacted-transient-media-url]')
    expect(safe.entries?.[0]?.formats?.[0]).toEqual({
      format_id: '140',
      url: '[redacted-transient-media-url]',
    })
    expect(JSON.stringify(safe)).not.toContain('secret')
    expect(JSON.stringify(safe)).not.toContain('Authorization')
  })

  it('downloads bounded chunks and resumes at the exact part-file offset', async () => {
    const body = Buffer.from('0123456789abc')
    const ranges: string[] = []
    let activeRequests = 0
    let maximumActiveRequests = 0
    const server = createServer((request, response) => {
      ranges.push(request.headers.range ?? '')
      const match = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.range ?? '')
      if (!match) {
        response.statusCode = 403
        response.end()
        return
      }
      const start = Number(match[1])
      const end = Number(match[2])
      const chunk = body.subarray(start, end + 1)
      activeRequests += 1
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests)
      setTimeout(() => {
        response.statusCode = 206
        response.setHeader('content-length', chunk.length)
        response.setHeader('content-range', `bytes ${start}-${end}/${body.length}`)
        response.end(chunk)
        activeRequests -= 1
      }, 20)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const directory = await mkdtemp(join(tmpdir(), 'ytdlp-ts-bounded-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const output = join(directory, 'Bounded [bounded].m4a')
    await writeFile(`${output}.part`, body.subarray(0, 3))
    await writeFile(
      `${output}.part.ytdlp-ts.json`,
      `${JSON.stringify({
        version: 1,
        mediaKey: 'unknown:bounded',
        formatId: '140',
        expectedBytes: body.length,
        contentIdentity: `140:lmt:${body.length}`,
      })}\n`,
    )
    const info: MediaInfo = {
      id: 'bounded',
      title: 'Bounded',
      formats: [
        {
          format_id: '140',
          url: `http://127.0.0.1:${address.port}/audio.m4a`,
          ext: 'm4a',
          vcodec: 'none',
          acodec: 'mp4a.40.2',
          filesize: body.length,
          content_identity: `140:lmt:${body.length}`,
          downloader_options: { http_chunk_size: 4, http_chunk_concurrency: 3 },
        },
      ],
    }

    const result = await downloadMedia(info, { paths: directory, format: 'bestaudio' })

    expect(await readFile(result.files[0]!)).toEqual(body)
    expect(ranges.sort()).toEqual(['bytes=11-12', 'bytes=3-6', 'bytes=7-10'])
    expect(maximumActiveRequests).toBe(3)
  })

  it('promotes a complete part only when its media receipt matches', async () => {
    const body = Buffer.from('complete-media')
    const directory = await mkdtemp(join(tmpdir(), 'ytdlp-ts-complete-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const output = join(directory, 'Complete [complete].m4a')
    await writeFile(`${output}.part`, body)
    await writeFile(
      `${output}.part.ytdlp-ts.json`,
      `${JSON.stringify({
        version: 1,
        mediaKey: 'unknown:complete',
        formatId: '140',
        expectedBytes: body.length,
        contentIdentity: '140:lmt:complete',
      })}\n`,
    )
    const info: MediaInfo = {
      id: 'complete',
      title: 'Complete',
      formats: [
        {
          format_id: '140',
          url: 'https://rr1.example.googlevideo.com/unused',
          ext: 'm4a',
          vcodec: 'none',
          acodec: 'mp4a.40.2',
          filesize: body.length,
          content_identity: '140:lmt:complete',
        },
      ],
    }

    const result = await downloadMedia(info, { paths: directory, format: 'bestaudio' })

    expect(await readFile(result.files[0]!)).toEqual(body)
  })

  it('discards a part when refreshed metadata changes its content identity', async () => {
    const body = Buffer.from('new-media-body')
    const ranges: string[] = []
    const server = createServer((request, response) => {
      const header = request.headers.range ?? ''
      ranges.push(header)
      const match = /^bytes=(\d+)-(\d+)$/u.exec(header)
      if (!match) throw new Error('missing bounded range')
      const start = Number(match[1])
      const end = Number(match[2])
      const chunk = body.subarray(start, end + 1)
      response.statusCode = 206
      response.setHeader('content-length', chunk.length)
      response.setHeader('content-range', `bytes ${start}-${end}/${body.length}`)
      response.end(chunk)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const directory = await mkdtemp(join(tmpdir(), 'ytdlp-ts-identity-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const output = join(directory, 'Identity [identity].m4a')
    await writeFile(`${output}.part`, Buffer.from('old'))
    await writeFile(
      `${output}.part.ytdlp-ts.json`,
      `${JSON.stringify({
        version: 1,
        mediaKey: 'unknown:identity',
        formatId: '140',
        expectedBytes: body.length,
        contentIdentity: 'old-content',
      })}\n`,
    )
    const info: MediaInfo = {
      id: 'identity',
      title: 'Identity',
      formats: [
        {
          format_id: '140',
          url: `http://127.0.0.1:${address.port}/audio.m4a`,
          ext: 'm4a',
          vcodec: 'none',
          acodec: 'mp4a.40.2',
          filesize: body.length,
          content_identity: 'new-content',
          downloader_options: { http_chunk_size: 4, http_chunk_concurrency: 1 },
        },
      ],
    }

    const result = await downloadMedia(info, { paths: directory, format: 'bestaudio' })

    expect(await readFile(result.files[0]!)).toEqual(body)
    expect(ranges[0]).toBe('bytes=0-3')
  })

  it('rejects a bounded response with the wrong Content-Range', async () => {
    const body = Buffer.from('range-body')
    const server = createServer((request, response) => {
      const match = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.range ?? '')
      if (!match) throw new Error('missing bounded range')
      const start = Number(match[1])
      const end = Number(match[2])
      const chunk = body.subarray(start, end + 1)
      response.statusCode = 206
      response.setHeader('content-length', chunk.length)
      response.setHeader('content-range', `bytes ${start + 1}-${end}/${body.length}`)
      response.end(chunk)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const directory = await mkdtemp(join(tmpdir(), 'ytdlp-ts-range-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const info: MediaInfo = {
      id: 'range',
      title: 'Range',
      formats: [
        {
          format_id: '140',
          url: `http://127.0.0.1:${address.port}/audio.m4a`,
          ext: 'm4a',
          vcodec: 'none',
          acodec: 'mp4a.40.2',
          filesize: body.length,
          downloader_options: { http_chunk_size: 4, http_chunk_concurrency: 1 },
        },
      ],
    }

    await expect(
      downloadMedia(info, { paths: directory, format: 'bestaudio', retries: 0 }),
    ).rejects.toMatchObject({ code: 'INVALID_CONTENT_RANGE' })
  })

  it('writes metadata, thumbnail, and selected subtitle sidecars', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/thumb.jpg') {
        response.end('jpeg-data')
      } else if (request.url === '/en.vtt') {
        response.end('WEBVTT\n\n00:00.000 --> 00:01.000\nHello')
      } else {
        response.end('media-data')
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const directory = await mkdtemp(join(tmpdir(), 'ytdlp-ts-sidecars-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const info: MediaInfo = {
      id: 'sidecar',
      title: 'Sidecar',
      formats: [
        {
          format_id: 'direct',
          url: `${baseUrl}/video.mp4`,
          ext: 'mp4',
          vcodec: 'avc1',
          acodec: 'aac',
        },
      ],
      requested_formats: [
        {
          format_id: '140',
          url: 'https://rr1.example.googlevideo.com/videoplayback?sig=secret',
          ext: 'm4a',
          vcodec: 'none',
          acodec: 'mp4a.40.2',
          http_headers: { Authorization: 'transient' },
        },
      ],
      thumbnails: [{ url: `${baseUrl}/thumb.jpg`, width: 1280, height: 720 }],
      subtitles: {
        en: [{ url: `${baseUrl}/en.vtt`, ext: 'vtt' }],
        de: [{ url: `${baseUrl}/de.vtt`, ext: 'vtt' }],
      },
    }

    const result = await downloadMedia(info, {
      paths: directory,
      writeInfoJson: true,
      writeThumbnail: true,
      writeSubtitles: true,
      subtitleLanguages: ['en'],
    })

    expect(result.files.map((file) => file.slice(directory.length + 1))).toEqual([
      'Sidecar [sidecar].mp4',
      'Sidecar [sidecar].info.json',
      'Sidecar [sidecar].jpg',
      'Sidecar [sidecar].en.vtt',
    ])
    expect(await readFile(join(directory, 'Sidecar [sidecar].jpg'), 'utf8')).toBe('jpeg-data')
    expect(await readFile(join(directory, 'Sidecar [sidecar].en.vtt'), 'utf8')).toContain('WEBVTT')
    expect(
      JSON.parse(await readFile(join(directory, 'Sidecar [sidecar].info.json'), 'utf8')),
    ).toMatchObject({
      id: 'sidecar',
      title: 'Sidecar',
      formats: [{ url: `${baseUrl}/video.mp4` }],
      requested_formats: [{ url: '[redacted-transient-media-url]' }],
    })
  })

  it('automatically resumes after a mid-stream disconnect', async () => {
    const body = Buffer.alloc(512 * 1024, 7)
    const ranges: string[] = []
    let requests = 0
    const server = createServer((request, response) => {
      requests += 1
      const rangeHeader = request.headers.range ?? ''
      ranges.push(rangeHeader)
      const range = /^bytes=(\d+)-$/u.exec(rangeHeader)
      const start = range ? Number(range[1]) : 0
      response.statusCode = start > 0 ? 206 : 200
      response.setHeader('content-length', body.length - start)
      if (start > 0)
        response.setHeader('content-range', `bytes ${start}-${body.length - 1}/${body.length}`)
      if (requests === 1) {
        response.write(body.subarray(0, 128 * 1024))
        setTimeout(() => response.destroy(), 10)
      } else {
        response.end(body.subarray(start))
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const directory = await mkdtemp(join(tmpdir(), 'ytdlp-ts-retry-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const info: MediaInfo = {
      id: 'retry',
      title: 'Retry',
      formats: [
        {
          format_id: 'audio',
          url: `http://127.0.0.1:${address.port}/audio.mp3`,
          ext: 'mp3',
          vcodec: 'none',
          acodec: 'mp3',
          abr: 320,
        },
      ],
    }

    const result = await downloadMedia(info, { paths: directory, format: 'bestaudio', retries: 2 })

    expect(await readFile(result.files[0]!)).toEqual(body)
    expect(requests).toBe(2)
    expect(ranges[0]).toBe('')
    expect(ranges[1]).toMatch(/^bytes=[1-9]\d*-$/u)
  }, 15_000)
})
