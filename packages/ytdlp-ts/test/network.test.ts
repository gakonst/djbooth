import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'

import { redactRequestUrl, request } from '../src/core/network.js'

const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

describe('network URL redaction', () => {
  it('removes the complete query from transient Googlevideo capabilities', () => {
    const value = redactRequestUrl(
      'https://rr1---sn.example.googlevideo.com/videoplayback?expire=1&sig=secret&pot=token',
    )

    expect(value).toContain('googlevideo.com/videoplayback?')
    expect(value).toContain('redacted-transient-query')
    expect(value).not.toContain('secret')
    expect(value).not.toContain('token')
  })

  it('does not persist signed query values in HTTP errors', async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 403
      response.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')

    let error: unknown
    try {
      await request(`http://127.0.0.1:${address.port}/media?sig=super-secret&safe=value`, {
        retries: 0,
      })
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({ code: 'HTTP_ERROR' })
    expect(JSON.stringify(error)).not.toContain('super-secret')
    expect(String(error)).not.toContain('super-secret')
  })
})
