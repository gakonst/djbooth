import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { downloadMedia, parseRate } from '../src/downloader/native.js'
import type { MediaInfo } from '../src/core/types.js'

const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

describe('native downloader', () => {
  it('downloads a direct file and resumes a part file', async () => {
    const body = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz')
    const server = createServer((request, response) => {
      const range = /^bytes=(\d+)-$/u.exec(request.headers.range ?? '')
      const start = range ? Number(range[1]) : 0
      response.statusCode = start > 0 ? 206 : 200
      response.setHeader('content-length', body.length - start)
      if (start > 0) response.setHeader('content-range', `bytes ${start}-${body.length - 1}/${body.length}`)
      response.end(body.subarray(start))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const directory = await mkdtemp(join(tmpdir(), 'ytdlp-ts-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const output = join(directory, 'Example [id].mp4')
    await writeFile(`${output}.part`, body.subarray(0, 10))
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
  })

  it('parses decimal rate limits', () => {
    expect(parseRate('4.2M')).toBe(4_200_000)
    expect(parseRate('128kB')).toBe(128_000)
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
    expect(JSON.parse(await readFile(join(directory, 'Sidecar [sidecar].info.json'), 'utf8'))).toMatchObject({
      id: 'sidecar',
      title: 'Sidecar',
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
      if (start > 0) response.setHeader('content-range', `bytes ${start}-${body.length - 1}/${body.length}`)
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
