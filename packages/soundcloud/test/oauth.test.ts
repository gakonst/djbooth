import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import {
  MemorySessionStore,
  SoundCloudOAuth,
  type StoredSession,
} from '../src/auth/index.js'

const redirectUri = 'http://127.0.0.1:8788/callback'

describe('SoundCloudOAuth', () => {
  it('builds the exact OAuth 2.1 authorization request with PKCE', () => {
    const oauth = new SoundCloudOAuth({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri,
      store: new MemorySessionStore(),
    })

    const request = oauth.createAuthorizationRequest({ display: 'popup' })
    const url = new URL(request.url)

    expect(url.origin).toBe('https://secure.soundcloud.com')
    expect(url.pathname).toBe('/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'client-id',
      response_type: 'code',
      redirect_uri: redirectUri,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256')
        .update(request.verifier)
        .digest('base64url'),
      state: request.state,
      display: 'popup',
    })
    expect(request.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/)
    expect(url.searchParams.get('client_secret')).toBeNull()
    expect(url.searchParams.get('code_verifier')).toBeNull()
    expect(oauth.verifyState(request.state, request.state)).toBe(true)
    expect(oauth.verifyState(request.state, `${request.state}x`)).toBe(false)
    expect(oauth.verifyState(request.state, null)).toBe(false)
  })

  it('exchanges a code with the exact confidential PKCE form and persists it', async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        access_token: 'access-1',
        expires_in: 3600,
        refresh_token: 'refresh-1',
        scope: '',
      }),
    )
    const store = new MemorySessionStore()
    const oauth = new SoundCloudOAuth({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri,
      store,
      fetch,
    })

    const before = Date.now()
    const token = await oauth.exchangeCode(
      'authorization-code',
      'pkce-verifier',
    )
    const after = Date.now()

    expect(token).toMatchObject({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      scope: '',
    })
    expect(token.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000)
    expect(token.expiresAt).toBeLessThanOrEqual(after + 3_600_000)
    expect(fetch).toHaveBeenCalledOnce()

    const [input, init] = fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ]
    expect(input).toBe('https://secure.soundcloud.com/oauth/token')
    expect(init.method).toBe('POST')
    const headers = new Headers(init.headers)
    expect(headers.get('accept')).toBe('application/json; charset=utf-8')
    expect(headers.get('content-type')).toBe(
      'application/x-www-form-urlencoded',
    )
    expect(headers.get('authorization')).toBeNull()
    expect(init.body).toBeInstanceOf(URLSearchParams)
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
      grant_type: 'authorization_code',
      client_id: 'client-id',
      client_secret: 'client-secret',
      redirect_uri: redirectUri,
      code_verifier: 'pkce-verifier',
      code: 'authorization-code',
    })
    expect(await store.load()).toEqual({
      version: 1,
      grantType: 'authorization_code',
      clientId: 'client-id',
      redirectUri,
      token,
    })
  })

  it('optionally retains the confidential app credential for local desktop refreshes', async () => {
    const store = new MemorySessionStore()
    const oauth = new SoundCloudOAuth({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri,
      store,
      persistClientSecret: true,
      fetch: vi.fn().mockResolvedValue(
        Response.json({
          access_token: 'access-1',
          expires_in: 3600,
          refresh_token: 'refresh-1',
          scope: '',
        }),
      ),
    })

    await oauth.exchangeCode('authorization-code', 'pkce-verifier')

    expect(await store.load()).toMatchObject({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      token: { refreshToken: 'refresh-1' },
    })
  })

  it('singleflights refresh and persists every rotated refresh token', async () => {
    const expiredSession: StoredSession = {
      version: 1,
      grantType: 'authorization_code',
      clientId: 'client-id',
      redirectUri,
      token: {
        accessToken: 'expired-access',
        refreshToken: 'refresh-1',
        expiresAt: 0,
        scope: '',
      },
    }
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          access_token: 'access-2',
          expires_in: 3600,
          refresh_token: 'refresh-2',
          scope: '',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          access_token: 'access-3',
          expires_in: 3600,
          refresh_token: 'refresh-3',
          scope: '',
        }),
      )
    const store = new MemorySessionStore(expiredSession)
    const oauth = new SoundCloudOAuth({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri,
      store,
      fetch,
    })

    await expect(
      Promise.all([
        oauth.getAccessToken(),
        oauth.getAccessToken(),
        oauth.getAccessToken(),
      ]),
    ).resolves.toEqual(['access-2', 'access-2', 'access-2'])
    expect(fetch).toHaveBeenCalledOnce()

    const firstRefresh = fetch.mock.calls[0]?.[1] as RequestInit
    expect(Object.fromEntries(firstRefresh.body as URLSearchParams)).toEqual({
      grant_type: 'refresh_token',
      client_id: 'client-id',
      client_secret: 'client-secret',
      refresh_token: 'refresh-1',
    })
    expect((await store.load())?.token.refreshToken).toBe('refresh-2')

    await oauth.invalidateAccessToken()
    await expect(oauth.getAccessToken()).resolves.toBe('access-3')
    const secondRefresh = fetch.mock.calls[1]?.[1] as RequestInit
    expect((secondRefresh.body as URLSearchParams).get('refresh_token')).toBe(
      'refresh-2',
    )
    expect((await store.load())?.token.refreshToken).toBe('refresh-3')
  })

  it('does not expire a newer token when a stale request reports 401', async () => {
    const store = new MemorySessionStore({
      version: 1,
      grantType: 'authorization_code',
      clientId: 'client-id',
      redirectUri,
      token: {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresAt: Date.now() + 3_600_000,
        scope: '',
      },
    })
    const oauth = new SoundCloudOAuth({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri,
      store,
    })

    await oauth.invalidateAccessToken('old-access')

    const saved = await store.load()
    expect(saved?.token.accessToken).toBe('new-access')
    expect(saved?.token.expiresAt).toBeGreaterThan(Date.now())
    await expect(oauth.getAccessToken()).resolves.toBe('new-access')
  })
})
