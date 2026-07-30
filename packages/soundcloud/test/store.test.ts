import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { FileSessionStore, type StoredSession } from '../src/auth/index.js'

describe('FileSessionStore', () => {
  it('round-trips a session through a private directory and file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'soundcloud-store-'))
    const store = new FileSessionStore(
      join(directory, 'nested', 'credentials.json'),
    )
    const session: StoredSession = {
      version: 1,
      grantType: 'authorization_code',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'http://127.0.0.1:8788/callback',
      token: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: 123,
        scope: '',
      },
    }

    try {
      await store.save(session)

      expect(await store.load()).toEqual(session)
      if (process.platform !== 'win32') {
        expect((await stat(store.path)).mode & 0o777).toBe(0o600)
        expect((await stat(dirname(store.path))).mode & 0o777).toBe(0o700)
      }
      await store.clear()
      expect(await store.load()).toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
