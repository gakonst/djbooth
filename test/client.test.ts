import { describe, expect, it, vi } from 'vitest'

import type { AccessTokenProvider } from '../src/auth/index.js'
import { SpotifyClient } from '../src/client.js'
import { SpotifyApiError } from '../src/errors.js'

describe('SpotifyClient', () => {
  it('injects the bearer token and returns raw JSON', async () => {
    const fetch = vi.fn((input: string | URL | Request) => {
      const request = input as Request
      expect(request.url).toBe('https://api.spotify.com/v1/me?market=US')
      expect(request.headers.get('authorization')).toBe('Bearer test-token')
      return Promise.resolve(Response.json({ id: 'user' }))
    })
    const client = new SpotifyClient({ auth: 'test-token', fetch })

    await expect(client.raw('GET', '/me', { query: { market: 'US' } })).resolves.toEqual({
      id: 'user',
    })
  })

  it('invalidates and retries once after an unauthorized response', async () => {
    const invalidateAccessToken = vi.fn()
    const provider: AccessTokenProvider = {
      getAccessToken: vi.fn().mockResolvedValueOnce('expired').mockResolvedValueOnce('fresh'),
      invalidateAccessToken,
    }
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: 'expired' }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ id: 'user' }))
    const client = new SpotifyClient({ auth: provider, fetch })

    await expect(client.raw('GET', '/me')).resolves.toEqual({ id: 'user' })
    expect(invalidateAccessToken).toHaveBeenCalledOnce()
    const retryRequest = fetch.mock.calls[1]?.[0] as Request
    expect(retryRequest.headers.get('authorization')).toBe('Bearer fresh')
  })

  it('honors Retry-After for rate limits', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ error: 'slow down' }, { status: 429, headers: { 'retry-after': '0' } }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true }))
    const client = new SpotifyClient({ auth: 'token', fetch })

    await expect(client.raw('GET', '/me')).resolves.toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('throws a structured SpotifyApiError', async () => {
    const client = new SpotifyClient({
      auth: 'token',
      retry: false,
      fetch: () =>
        Promise.resolve(Response.json({ error: { message: 'No active device' } }, { status: 404 })),
    })

    await expect(client.raw('GET', '/me/player')).rejects.toMatchObject({
      name: 'SpotifyApiError',
      status: 404,
      message: 'Spotify API error 404: No active device',
    } satisfies Partial<SpotifyApiError>)
  })

  it('follows Spotify paging URLs', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ items: [1, 2], next: 'https://api.spotify.com/v1/items?offset=2' }),
      )
      .mockResolvedValueOnce(Response.json({ items: [3], next: null }))
    const client = new SpotifyClient({ auth: 'token', fetch })

    const items: number[] = []
    for await (const item of client.paginate<number>('/items', { limit: 2 })) items.push(item)
    expect(items).toEqual([1, 2, 3])
  })
})
