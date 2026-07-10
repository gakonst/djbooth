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
})
