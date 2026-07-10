import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { FileSessionStore } from '../src/auth/index.js'

describe('FileSessionStore', () => {
  it('round-trips a session in a private file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'spots-store-'))
    const store = new FileSessionStore(join(directory, 'nested', 'credentials.json'))
    const session = {
      version: 1 as const,
      clientId: 'client',
      redirectUri: 'http://127.0.0.1:8787/callback',
      token: {
        accessToken: 'access',
        tokenType: 'Bearer' as const,
        expiresAt: 123,
        scopes: ['user-read-private'],
        refreshToken: 'refresh',
      },
    }

    await store.save(session)

    expect(await store.load()).toEqual(session)
    if (process.platform !== 'win32') {
      expect((await stat(store.path)).mode & 0o777).toBe(0o600)
    }
    await store.clear()
    expect(await store.load()).toBeUndefined()
  })
})
