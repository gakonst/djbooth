import { describe, expect, it, vi } from 'vitest'

import type { AccessTokenProvider } from '../src/auth/index.js'
import { SpotifyClient, SpotifyPlaylistCreationError } from '../src/client.js'
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

  it('shares rate-limit cooldowns and serializes recovery requests', async () => {
    vi.useFakeTimers()
    try {
      const retryResponses: Array<(response: Response) => void> = []
      let activeRetries = 0
      let maxActiveRetries = 0
      const fetch = vi.fn(() => {
        const call = fetch.mock.calls.length
        if (call <= 2) {
          return Promise.resolve(
            Response.json(
              { error: 'slow down' },
              { status: 429, headers: { 'retry-after': call === 1 ? '0.1' : '0.2' } },
            ),
          )
        }
        activeRetries++
        maxActiveRetries = Math.max(maxActiveRetries, activeRetries)
        return new Promise<Response>((resolve) => {
          retryResponses.push((response) => {
            activeRetries--
            resolve(response)
          })
        })
      })
      const client = new SpotifyClient({ auth: 'token', fetch })

      const first = client.raw('GET', '/me')
      const second = client.raw('GET', '/me/player')
      await flushMicrotasks()
      expect(fetch).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(199)
      expect(fetch).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(fetch).toHaveBeenCalledTimes(3)
      expect(maxActiveRetries).toBe(1)

      retryResponses.shift()?.(Response.json({ request: 'first' }))
      await flushMicrotasks()
      expect(fetch).toHaveBeenCalledTimes(4)
      expect(maxActiveRetries).toBe(1)

      retryResponses.shift()?.(Response.json({ request: 'second' }))
      await expect(Promise.all([first, second])).resolves.toEqual([
        { request: 'first' },
        { request: 'second' },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts promptly while waiting for Retry-After', async () => {
    vi.useFakeTimers()
    try {
      const fetch = vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: 'slow down' }, { status: 429, headers: { 'retry-after': '60' } }),
        )
      const client = new SpotifyClient({ auth: 'token', fetch })
      const controller = new AbortController()

      const request = client.raw('GET', '/me', { signal: controller.signal })
      await flushMicrotasks()
      expect(fetch).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(1)

      controller.abort()
      await expect(request).rejects.toMatchObject({ name: 'AbortError' })
      expect(fetch).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry unsafe POST requests', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: { message: 'temporarily unavailable' } }, { status: 503 }),
      )
    const client = new SpotifyClient({ auth: 'token', fetch })

    await expect(client.raw('POST', '/me/playlists', { body: { name: 'Test' } })).rejects.toThrow(
      'Spotify API error 503: temporarily unavailable',
    )
    expect(fetch).toHaveBeenCalledOnce()
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

  it('creates a playlist and adds normalized tracks in ordered batches of 100', async () => {
    const firstId = '4iV5W9uYEdYUVa79Axb7Rh'
    const secondId = '1301WleyT98MSxVHPZCA6M'
    const tracks = [
      firstId,
      `spotify:track:${secondId}`,
      `https://open.spotify.com/track/${firstId}?si=test`,
      ...Array.from({ length: 98 }, () => firstId),
    ]
    const requests: Request[] = []
    const fetch = vi.fn((input: string | URL | Request) => {
      const request = input as Request
      requests.push(request)
      if (request.url.endsWith('/me/playlists')) {
        return Promise.resolve(
          Response.json({ id: 'created-playlist', name: 'Ordered' }, { status: 201 }),
        )
      }
      return Promise.resolve(
        Response.json({ snapshot_id: `snapshot-${requests.length - 1}` }, { status: 201 }),
      )
    })
    const client = new SpotifyClient({ auth: 'token', fetch })

    const result = await client.createPlaylistWithTracks({
      name: 'Ordered',
      tracks,
      public: false,
      collaborative: true,
      description: 'Preserve these duplicates',
    })

    expect(requests).toHaveLength(3)
    expect(requests.map((request) => request.method)).toEqual(['POST', 'POST', 'POST'])
    expect(requests.map((request) => request.url)).toEqual([
      'https://api.spotify.com/v1/me/playlists',
      'https://api.spotify.com/v1/playlists/created-playlist/items',
      'https://api.spotify.com/v1/playlists/created-playlist/items',
    ])
    await expect(requests[0]?.clone().json()).resolves.toEqual({
      name: 'Ordered',
      public: false,
      collaborative: true,
      description: 'Preserve these duplicates',
    })
    const firstBatch = (await requests[1]?.clone().json()) as { uris: string[] }
    const secondBatch = (await requests[2]?.clone().json()) as { uris: string[] }
    expect(firstBatch.uris).toHaveLength(100)
    expect(secondBatch.uris).toEqual([`spotify:track:${firstId}`])
    expect([...firstBatch.uris, ...secondBatch.uris]).toEqual(result.trackUris)
    expect(result.trackUris.slice(0, 3)).toEqual([
      `spotify:track:${firstId}`,
      `spotify:track:${secondId}`,
      `spotify:track:${firstId}`,
    ])
    expect(result.snapshotIds).toEqual(['snapshot-1', 'snapshot-2'])
  })

  it('validates playlist creation before making requests', async () => {
    const fetch = vi.fn()
    const client = new SpotifyClient({ auth: 'token', fetch })

    await expect(
      client.createPlaylistWithTracks({ name: ' ', tracks: ['4iV5W9uYEdYUVa79Axb7Rh'] }),
    ).rejects.toThrow('Playlist name must not be empty')
    await expect(client.createPlaylistWithTracks({ name: 'Empty', tracks: [] })).rejects.toThrow(
      'At least one Spotify track URI, URL, or ID is required',
    )
    await expect(
      client.createPlaylistWithTracks({
        name: 'Invalid',
        tracks: ['https://open.spotify.com/artist/4iV5W9uYEdYUVa79Axb7Rh'],
      }),
    ).rejects.toThrow('Track 1 is not an open.spotify.com track URL')
    await expect(
      client.createPlaylistWithTracks({
        name: 'Public collaboration',
        tracks: ['4iV5W9uYEdYUVa79Axb7Rh'],
        collaborative: true,
      }),
    ).rejects.toThrow('A collaborative Spotify playlist must be private')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects a malformed playlist creation response before adding tracks', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({}, { status: 201 }))
    const client = new SpotifyClient({ auth: 'token', fetch })

    await expect(
      client.createPlaylistWithTracks({
        name: 'Malformed response',
        tracks: ['4iV5W9uYEdYUVa79Axb7Rh'],
      }),
    ).rejects.toThrow('Spotify created a playlist without returning its ID')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('reports recovery context when a later item batch fails', async () => {
    const trackId = '4iV5W9uYEdYUVa79Axb7Rh'
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            id: 'partial-playlist',
            external_urls: { spotify: 'https://open.spotify.com/playlist/partial-playlist' },
          },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ snapshot_id: 'first-batch' }, { status: 201 }))
      .mockResolvedValueOnce(
        Response.json({ error: { message: 'temporarily unavailable' } }, { status: 503 }),
      )
    const client = new SpotifyClient({ auth: 'token', fetch })

    const creation = client.createPlaylistWithTracks({
      name: 'Partial',
      tracks: Array.from({ length: 101 }, () => trackId),
    })
    const error = await creation.catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(SpotifyPlaylistCreationError)
    if (!(error instanceof SpotifyPlaylistCreationError)) throw error
    expect(error.playlist).toMatchObject({ id: 'partial-playlist' })
    expect(error.snapshotIds).toEqual(['first-batch'])
    expect(error.tracksAdded).toBe(100)
    expect(error.trackUris).toContain(`spotify:track:${trackId}`)
    expect(error.cause).toMatchObject({ status: 503 })
    expect(error).toHaveProperty(
      'message',
      'Spotify playlist https://open.spotify.com/playlist/partial-playlist was created, but adding tracks failed after 100 of 101 tracks',
    )
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('reads, updates, replaces tracks, and removes playlists from the library', async () => {
    const firstId = '4iV5W9uYEdYUVa79Axb7Rh'
    const requests: Request[] = []
    const fetch = vi.fn((input: string | URL | Request) => {
      const request = input as Request
      requests.push(request)
      if (request.method === 'GET') {
        return Promise.resolve(Response.json({ id: 'crud-list', name: 'Before', public: false }))
      }
      if (request.method === 'PUT' && request.url.endsWith('/items')) {
        return Promise.resolve(Response.json({ snapshot_id: 'replace-1' }))
      }
      if (request.method === 'POST') {
        return Promise.resolve(Response.json({ snapshot_id: 'append-2' }, { status: 201 }))
      }
      return Promise.resolve(new Response(null, { status: 200 }))
    })
    const client = new SpotifyClient({ auth: 'token', fetch })

    await expect(
      client.getPlaylist('https://open.spotify.com/playlist/crudlist'),
    ).resolves.toMatchObject({ id: 'crud-list', name: 'Before' })
    const tracks = Array.from({ length: 101 }, () => firstId)
    const updated = await client.updatePlaylist('spotify:playlist:crudlist', {
      name: 'After',
      description: 'Updated',
      public: false,
      tracks,
    })
    expect(updated.playlistId).toBe('crudlist')
    expect(updated.trackUris).toContain(`spotify:track:${firstId}`)
    expect(updated.snapshotIds).toEqual(['replace-1', 'append-2'])
    await expect(client.deletePlaylist('crudlist')).resolves.toEqual({
      playlistId: 'crudlist',
      removedFromLibrary: true,
      permanentlyDeleted: false,
    })

    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [
        'GET /v1/playlists/crudlist',
        'PUT /v1/playlists/crudlist',
        'PUT /v1/playlists/crudlist/items',
        'POST /v1/playlists/crudlist/items',
        'DELETE /v1/me/library',
      ],
    )
    expect(new URL(requests[4]?.url ?? '').searchParams.get('uris')).toBe(
      'spotify:playlist:crudlist',
    )
  })

  it('validates playlist updates before making requests', async () => {
    const fetch = vi.fn()
    const client = new SpotifyClient({ auth: 'token', fetch })

    await expect(client.updatePlaylist('list', {})).rejects.toThrow(
      'At least one Spotify playlist update is required',
    )
    await expect(client.updatePlaylist('list', { collaborative: true })).rejects.toThrow(
      'Making a Spotify playlist collaborative requires public: false',
    )
    expect(fetch).not.toHaveBeenCalled()
  })
})

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index++) await Promise.resolve()
}
