import { describe, expect, it, vi } from 'vitest'

import { MemorySessionStore, SpotifyOAuth } from '../src/auth/index.js'

describe('SpotifyOAuth', () => {
  it('builds a PKCE authorization URL without exposing a client secret', () => {
    const oauth = new SpotifyOAuth({
      clientId: 'client-id',
      redirectUri: 'http://127.0.0.1:8787/callback',
      store: new MemorySessionStore(),
    })

    const request = oauth.createAuthorizationRequest([
      'user-read-private',
      'user-read-recently-played',
    ])
    const url = new URL(request.url)

    expect(url.origin).toBe('https://accounts.spotify.com')
    expect(url.searchParams.get('client_id')).toBe('client-id')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/)
    expect(url.searchParams.get('client_secret')).toBeNull()
    expect(request.verifier.length).toBeGreaterThanOrEqual(43)
    expect(oauth.verifyState(request.state, request.state)).toBe(true)
    expect(oauth.verifyState(request.state, `${request.state}x`)).toBe(false)
  })

  it('exchanges, persists, and refreshes a user token', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          access_token: 'access-1',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'refresh-1',
          scope: 'user-read-private',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          access_token: 'access-2',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'user-read-private',
        }),
      )
    const store = new MemorySessionStore()
    const oauth = new SpotifyOAuth({
      clientId: 'client-id',
      redirectUri: 'http://127.0.0.1:8787/callback',
      store,
      fetch,
    })

    await oauth.exchangeCode('authorization-code', 'verifier')
    expect(await oauth.getAccessToken()).toBe('access-1')

    await oauth.invalidateAccessToken()
    expect(await oauth.getAccessToken()).toBe('access-2')
    expect((await store.load())?.token.refreshToken).toBe('refresh-1')
    expect(fetch).toHaveBeenCalledTimes(2)

    const refreshRequest = fetch.mock.calls[1]?.[1] as RequestInit
    expect(refreshRequest.body).toBeInstanceOf(URLSearchParams)
    const refreshBody = refreshRequest.body as URLSearchParams
    expect(refreshBody.get('grant_type')).toBe('refresh_token')
    expect(refreshBody.get('client_id')).toBe('client-id')
  })
})
