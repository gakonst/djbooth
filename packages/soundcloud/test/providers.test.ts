import { Buffer } from 'node:buffer'

import { describe, expect, it, vi } from 'vitest'

import {
  ClientCredentialsProvider,
  MemorySessionStore,
} from '../src/auth/index.js'

describe('ClientCredentialsProvider', () => {
  it('uses Basic only for the initial grant, then persists and rotates by refresh', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          access_token: 'app-access-1',
          expires_in: 3600,
          refresh_token: 'app-refresh-1',
          scope: '',
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          access_token: 'app-access-2',
          expires_in: 3600,
          refresh_token: 'app-refresh-2',
          scope: '',
        }),
      )
    const store = new MemorySessionStore()
    const provider = new ClientCredentialsProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      store,
      fetch,
    })

    await expect(
      Promise.all([
        provider.getAccessToken(),
        provider.getAccessToken(),
        provider.getAccessToken(),
      ]),
    ).resolves.toEqual(['app-access-1', 'app-access-1', 'app-access-1'])
    expect(fetch).toHaveBeenCalledOnce()

    const [initialInput, initialInit] = fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ]
    expect(initialInput).toBe('https://secure.soundcloud.com/oauth/token')
    const initialHeaders = new Headers(initialInit.headers)
    expect(initialHeaders.get('authorization')).toBe(
      `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`,
    )
    expect(Object.fromEntries(initialInit.body as URLSearchParams)).toEqual({
      grant_type: 'client_credentials',
    })
    expect(await store.load()).toMatchObject({
      version: 1,
      grantType: 'client_credentials',
      clientId: 'client-id',
      token: {
        accessToken: 'app-access-1',
        refreshToken: 'app-refresh-1',
      },
    })

    await provider.invalidateAccessToken()
    await expect(provider.getAccessToken()).resolves.toBe('app-access-2')
    expect(fetch).toHaveBeenCalledTimes(2)
    const refreshInit = fetch.mock.calls[1]?.[1] as RequestInit
    const refreshHeaders = new Headers(refreshInit.headers)
    expect(refreshHeaders.get('authorization')).toBeNull()
    expect(Object.fromEntries(refreshInit.body as URLSearchParams)).toEqual({
      grant_type: 'refresh_token',
      client_id: 'client-id',
      client_secret: 'client-secret',
      refresh_token: 'app-refresh-1',
    })
    expect((await store.load())?.token.refreshToken).toBe('app-refresh-2')

    const unexpectedFetch = vi.fn(() => {
      throw new Error('a persisted fresh token must not request a new grant')
    })
    const restarted = new ClientCredentialsProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      store,
      fetch: unexpectedFetch,
    })
    await expect(restarted.getAccessToken()).resolves.toBe('app-access-2')
    expect(unexpectedFetch).not.toHaveBeenCalled()
  })

  it('serializes refresh across provider instances sharing one store', async () => {
    const store = new MemorySessionStore()
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        access_token: 'shared-access',
        expires_in: 3600,
        refresh_token: 'shared-refresh',
        scope: '',
      }),
    )
    const options = {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      store,
      fetch,
    }
    const first = new ClientCredentialsProvider(options)
    const second = new ClientCredentialsProvider(options)

    await expect(
      Promise.all([first.getAccessToken(), second.getAccessToken()]),
    ).resolves.toEqual(['shared-access', 'shared-access'])
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('backs off and retries a rate-limited token exchange', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { error: 'rate_limited' },
          { status: 429, headers: { 'retry-after': '0' } },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          access_token: 'access-after-backoff',
          expires_in: 3600,
          refresh_token: 'refresh-after-backoff',
          scope: '',
        }),
      )
    const provider = new ClientCredentialsProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      fetch,
    })

    await expect(provider.getAccessToken()).resolves.toBe(
      'access-after-backoff',
    )
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
