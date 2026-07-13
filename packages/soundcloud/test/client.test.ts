import { describe, expect, it, vi } from 'vitest'

import type { AccessTokenProvider } from '../src/auth/index.js'
import { SoundCloudClient } from '../src/client.js'
import { SoundCloudApiError } from '../src/errors.js'

describe('SoundCloudClient', () => {
  it('injects the OAuth token and serializes arrays plus deep query objects', async () => {
    const fetch = vi.fn((input: string | URL | Request) => {
      const request = input as Request
      const url = new URL(request.url)
      expect(url.origin).toBe('https://api.soundcloud.com')
      expect(url.pathname).toBe('/tracks')
      expect(url.searchParams.get('q')).toBe('deep house')
      expect(url.searchParams.get('access')).toBe('playable,blocked')
      expect(url.searchParams.get('bpm[from]')).toBe('118')
      expect(url.searchParams.get('bpm[to]')).toBe('124')
      expect(url.searchParams.get('duration[from]')).toBe('180000')
      expect(request.headers.get('authorization')).toBe('OAuth test-token')
      return Promise.resolve(Response.json({ collection: [], next_href: null }))
    })
    const client = new SoundCloudClient({ auth: 'test-token', fetch })

    await expect(
      client.raw('GET', '/tracks', {
        query: {
          q: 'deep house',
          access: ['playable', 'blocked'],
          bpm: { from: 118, to: 124 },
          duration: { from: 180_000 },
        },
      }),
    ).resolves.toEqual({ collection: [], next_href: null })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('invalidates and retries exactly once after unauthorized', async () => {
    const getAccessToken = vi
      .fn()
      .mockResolvedValueOnce('expired-token')
      .mockResolvedValue('fresh-token')
    const invalidateAccessToken = vi.fn()
    const provider: AccessTokenProvider = {
      getAccessToken,
      invalidateAccessToken,
    }
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ message: 'expired' }, { status: 401 }),
      )
      .mockResolvedValueOnce(
        Response.json({ message: 'still unauthorized' }, { status: 401 }),
      )
    const client = new SoundCloudClient({ auth: provider, fetch })

    await expect(client.raw('GET', '/me')).rejects.toMatchObject({
      name: 'SoundCloudApiError',
      status: 401,
      message: 'SoundCloud API error 401: still unauthorized',
    })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(invalidateAccessToken).toHaveBeenCalledOnce()
    expect(getAccessToken).toHaveBeenCalledTimes(2)
    expect(
      (fetch.mock.calls[0]?.[0] as Request).headers.get('authorization'),
    ).toBe('OAuth expired-token')
    expect(
      (fetch.mock.calls[1]?.[0] as Request).headers.get('authorization'),
    ).toBe('OAuth fresh-token')
    expect(invalidateAccessToken).toHaveBeenCalledWith('expired-token')
  })

  it('does not invalidate its provider for a caller-supplied authorization header', async () => {
    const invalidateAccessToken = vi.fn()
    const getAccessToken = vi.fn().mockResolvedValue('saved-token')
    const provider: AccessTokenProvider = {
      getAccessToken,
      invalidateAccessToken,
    }
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ message: 'bad caller token' }, { status: 401 }),
      )
    const client = new SoundCloudClient({ auth: provider, fetch })

    await expect(
      client.raw('GET', '/me', {
        headers: { authorization: 'OAuth caller-token' },
      }),
    ).rejects.toMatchObject({ status: 401 })
    expect(fetch).toHaveBeenCalledOnce()
    expect(invalidateAccessToken).not.toHaveBeenCalled()
    expect(getAccessToken).not.toHaveBeenCalled()
  })

  it('follows opaque linked pagination without replaying first-page query', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          collection: [{ urn: 'soundcloud:tracks:1' }],
          next_href:
            'https://api.soundcloud.com/me/likes/tracks?page_size=2&cursor=opaque',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          collection: [{ urn: 'soundcloud:tracks:2' }],
          next_href: null,
        }),
      )
    const client = new SoundCloudClient({ auth: 'token', fetch })

    await expect(
      collect(client.paginate('/me/likes/tracks', { limit: 2 })),
    ).resolves.toEqual([
      { urn: 'soundcloud:tracks:1' },
      { urn: 'soundcloud:tracks:2' },
    ])
    expect(fetch).toHaveBeenCalledTimes(2)
    const firstUrl = new URL((fetch.mock.calls[0]?.[0] as Request).url)
    expect(firstUrl.searchParams.get('limit')).toBe('2')
    expect(firstUrl.searchParams.get('linked_partitioning')).toBe('true')
    const nextUrl = new URL((fetch.mock.calls[1]?.[0] as Request).url)
    expect(nextUrl.searchParams.get('cursor')).toBe('opaque')
    expect(nextUrl.searchParams.get('page_size')).toBe('2')
    expect(nextUrl.searchParams.has('limit')).toBe(false)
    expect(nextUrl.searchParams.has('linked_partitioning')).toBe(false)
  })

  it('rejects a hostile next URL before sending it credentials', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(
      Response.json({
        collection: [{ urn: 'soundcloud:tracks:1' }],
        next_href: 'https://attacker.invalid/steal',
      }),
    )
    const client = new SoundCloudClient({ auth: 'token', fetch })

    await expect(collect(client.paginate('/me/likes/tracks'))).rejects.toThrow(
      'Refusing to send SoundCloud credentials to https://attacker.invalid',
    )
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('does not fetch another page after reaching maxItems at a page boundary', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(
      Response.json({
        collection: [{ urn: 'soundcloud:tracks:1' }],
        next_href: 'https://api.soundcloud.com/me/likes/tracks?cursor=next',
      }),
    )
    const client = new SoundCloudClient({ auth: 'token', fetch })

    await expect(
      collect(client.paginate('/me/likes/tracks', {}, { maxItems: 1 })),
    ).resolves.toEqual([{ urn: 'soundcloud:tracks:1' }])
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('retries GET failures but not POST failures by default', async () => {
    const getFetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ message: 'temporary' }, { status: 503 }),
      )
      .mockResolvedValueOnce(Response.json({ ok: true }))
    const getClient = new SoundCloudClient({
      auth: 'token',
      fetch: getFetch,
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    })

    await expect(getClient.raw('GET', '/me')).resolves.toEqual({ ok: true })
    expect(getFetch).toHaveBeenCalledTimes(2)

    const postFetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ message: 'temporary' }, { status: 503 }),
      )
    const postClient = new SoundCloudClient({
      auth: 'token',
      fetch: postFetch,
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    })
    await expect(
      postClient.raw('POST', '/likes/tracks/soundcloud:tracks:1'),
    ).rejects.toMatchObject({
      name: 'SoundCloudApiError',
      status: 503,
    })
    expect(postFetch).toHaveBeenCalledOnce()
  })

  it('creates a private playlist from ordered IDs, URNs, and resolved URLs', async () => {
    const requestedUrls: string[] = []
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const request = input as Request
      const url = new URL(request.url)
      if (url.pathname === '/resolve') {
        const permalink = url.searchParams.get('url')
        requestedUrls.push(permalink ?? '')
        const slug = new URL(permalink ?? '').pathname.split('/').at(-1)
        return Response.json({
          kind: 'track',
          urn: `soundcloud:tracks:${slug === 'first' ? '30' : '40'}`,
        })
      }
      expect(request.method).toBe('POST')
      expect(url.pathname).toBe('/playlists')
      await expect(request.json()).resolves.toEqual({
        playlist: {
          title: 'Ordered playlist',
          description: 'In this exact order',
          sharing: 'private',
          tracks: [
            { urn: 'soundcloud:tracks:10' },
            { urn: 'soundcloud:tracks:20' },
            { urn: 'soundcloud:tracks:30' },
            { urn: 'soundcloud:tracks:40' },
            { urn: 'soundcloud:tracks:30' },
          ],
        },
      })
      return Response.json(
        {
          kind: 'playlist',
          urn: 'soundcloud:playlists:99',
          title: 'Ordered playlist',
        },
        { status: 201 },
      )
    })
    const client = new SoundCloudClient({ auth: 'user-token', fetch })

    await expect(
      client.createPlaylist({
        title: ' Ordered playlist ',
        description: 'In this exact order',
        tracks: [
          10,
          'soundcloud:tracks:20',
          'https://soundcloud.com/example/first',
          'https://soundcloud.com/example/second',
          'https://soundcloud.com/example/first',
        ],
      }),
    ).resolves.toMatchObject({ urn: 'soundcloud:playlists:99' })
    expect(requestedUrls).toEqual([
      'https://soundcloud.com/example/first',
      'https://soundcloud.com/example/second',
      'https://soundcloud.com/example/first',
    ])
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('rejects non-track SoundCloud URLs before playlist creation', async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        kind: 'playlist',
        urn: 'soundcloud:playlists:12',
      }),
    )
    const client = new SoundCloudClient({ auth: 'user-token', fetch })

    await expect(
      client.createPlaylist({
        title: 'No sets',
        tracks: ['https://soundcloud.com/example/sets/not-a-track'],
      }),
    ).rejects.toThrow(
      'SoundCloud URL does not resolve to a track: https://soundcloud.com/example/sets/not-a-track',
    )
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('validates playlist inputs before sending credentials', async () => {
    const fetch = vi.fn()
    const client = new SoundCloudClient({ auth: 'user-token', fetch })

    await expect(
      client.createPlaylist({
        title: 'Too large',
        tracks: Array.from({ length: 501 }, (_, index) => index + 1),
      }),
    ).rejects.toThrow('SoundCloud playlists support at most 500 tracks')
    await expect(
      client.createPlaylist({
        title: 'Bad URL',
        tracks: ['https://attacker.invalid/not-soundcloud'],
      }),
    ).rejects.toThrow(
      'Unsupported SoundCloud track URL: https://attacker.invalid/not-soundcloud',
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reads, updates, replaces tracks, and permanently deletes playlists', async () => {
    const requests: Request[] = []
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const request = input as Request
      requests.push(request)
      if (request.method === 'GET') {
        return Response.json({
          urn: 'soundcloud:playlists:77',
          kind: 'playlist',
          title: 'Before',
        })
      }
      if (request.method === 'PUT') {
        await expect(request.clone().json()).resolves.toEqual({
          playlist: {
            title: 'After',
            description: 'Updated',
            sharing: 'private',
            tracks: [
              { urn: 'soundcloud:tracks:1' },
              { urn: 'soundcloud:tracks:2' },
            ],
          },
        })
        return Response.json({
          urn: 'soundcloud:playlists:77',
          kind: 'playlist',
          title: 'After',
        })
      }
      return new Response(null, { status: 204 })
    })
    const client = new SoundCloudClient({ auth: 'user-token', fetch })

    await expect(
      client.getPlaylist('soundcloud:playlists:77'),
    ).resolves.toMatchObject({
      urn: 'soundcloud:playlists:77',
      title: 'Before',
    })
    await expect(
      client.updatePlaylist('77', {
        title: 'After',
        description: 'Updated',
        sharing: 'private',
        tracks: [1, 'soundcloud:tracks:2'],
      }),
    ).resolves.toMatchObject({ urn: 'soundcloud:playlists:77', title: 'After' })
    await expect(client.deletePlaylist(77)).resolves.toEqual({
      playlistUrn: 'soundcloud:playlists:77',
      deleted: true,
    })

    expect(
      requests.map(
        (request) => `${request.method} ${new URL(request.url).pathname}`,
      ),
    ).toEqual([
      'GET /playlists/soundcloud:playlists:77',
      'PUT /playlists/soundcloud:playlists:77',
      'DELETE /playlists/soundcloud:playlists:77',
    ])
  })

  it('validates playlist updates before making requests', async () => {
    const fetch = vi.fn()
    const client = new SoundCloudClient({ auth: 'user-token', fetch })

    await expect(
      client.updatePlaylist('soundcloud:playlists:1', {}),
    ).rejects.toThrow('At least one SoundCloud playlist update is required')
    await expect(
      client.updatePlaylist('soundcloud:playlists:1', {
        tracks: Array.from({ length: 501 }, (_, index) => index + 1),
      }),
    ).rejects.toThrow('SoundCloud playlists support at most 500 tracks')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('throws a structured rate-limit error', async () => {
    const body = {
      code: 429,
      message: '429 - Too Many Requests',
      link: 'https://developers.soundcloud.com/docs/api/rate-limits',
      errors: [
        {
          meta: {
            rate_limit: {
              group: 'plays',
              max_nr_of_requests: 15_000,
              time_window: 'PT24H',
            },
            remaining_requests: 0,
            reset_time: '2026/07/13 09:49:40 +0000',
          },
        },
      ],
    }
    const client = new SoundCloudClient({
      auth: 'token',
      retry: false,
      fetch: () => Promise.resolve(Response.json(body, { status: 429 })),
    })

    await expect(client.raw('GET', '/tracks/1/streams')).rejects.toMatchObject({
      name: 'SoundCloudApiError',
      status: 429,
      code: 429,
      link: body.link,
      message: 'SoundCloud API error 429: 429 - Too Many Requests',
      rateLimit: {
        group: 'plays',
        maxRequests: 15_000,
        remainingRequests: 0,
        resetTime: '2026/07/13 09:49:40 +0000',
        timeWindow: 'PT24H',
      },
    } satisfies Partial<SoundCloudApiError>)
  })
})

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of source) items.push(item)
  return items
}
