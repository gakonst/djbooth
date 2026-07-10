import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'

import { GenericExtractor } from '../src/extractors/generic.js'

const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

describe('generic extractor', () => {
  it('discovers OpenGraph, media tags, and JSON-LD metadata', async () => {
    const html = `<!doctype html>
      <html><head>
        <title>Fallback title</title>
        <meta property="og:title" content="A &amp; B">
        <meta property="og:description" content="Example description">
        <meta property="og:video" content="/video-720.mp4">
        <meta property="og:image" content="/poster.jpg">
        <script type="application/ld+json">{
          "@type":"VideoObject",
          "name":"JSON-LD title",
          "duration":"PT1M2.5S",
          "uploadDate":"2025-01-02T03:04:05Z",
          "contentUrl":"/video-1080.webm"
        }</script>
      </head><body><video><source src="/video-360.mp4"></video></body></html>`
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end(html)
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test server address')
    const url = new URL(`http://127.0.0.1:${address.port}/watch/example`)

    const info = await new GenericExtractor().extract(url, {})

    expect(info).toMatchObject({
      id: 'example',
      title: 'JSON-LD title',
      description: 'Example description',
      duration: 62.5,
      upload_date: '20250102',
      thumbnail: `http://127.0.0.1:${address.port}/poster.jpg`,
      extractor_key: 'Generic',
    })
    expect(info.formats?.map((format) => format.url)).toEqual([
      `http://127.0.0.1:${address.port}/video-720.mp4`,
      `http://127.0.0.1:${address.port}/video-360.mp4`,
      `http://127.0.0.1:${address.port}/video-1080.webm`,
    ])
  })
})
