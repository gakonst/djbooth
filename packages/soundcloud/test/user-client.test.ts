import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { FileSessionStore } from '../src/auth/index.js'
import { createSoundCloudUserClient } from '../src/user-client.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe('createSoundCloudUserClient', () => {
  it('uses an explicit user access token', async () => {
    const fetch = vi.fn((input: string | URL | Request) => {
      expect((input as Request).headers.get('authorization')).toBe(
        'OAuth user-token',
      )
      return Promise.resolve(Response.json({ urn: 'soundcloud:users:1' }))
    })
    const client = await createSoundCloudUserClient({
      accessToken: 'user-token',
      fetch,
    })

    await expect(client.getMe()).resolves.toMatchObject({
      urn: 'soundcloud:users:1',
    })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('rejects a saved Client Credentials session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'soundcloud-user-client-'))
    temporaryDirectories.push(directory)
    const credentialsPath = join(directory, 'credentials.json')
    await new FileSessionStore(credentialsPath).save({
      version: 1,
      grantType: 'client_credentials',
      clientId: 'client-id',
      token: {
        accessToken: 'app-token',
        refreshToken: '',
        expiresAt: Date.now() + 60_000,
        scope: '',
      },
    })

    await expect(
      createSoundCloudUserClient({
        accessToken: '',
        clientSecret: 'secret',
        credentialsPath,
      }),
    ).rejects.toThrow(
      'SoundCloud user authentication required; run `soundcloud auth login`',
    )
  })

  it('reuses the private app credential retained by an interactive login', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'soundcloud-user-client-'))
    temporaryDirectories.push(directory)
    const credentialsPath = join(directory, 'credentials.json')
    await new FileSessionStore(credentialsPath).save({
      version: 1,
      grantType: 'authorization_code',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'http://127.0.0.1:8788/callback',
      token: {
        accessToken: 'user-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 60_000,
        scope: '',
      },
    })
    const fetch = vi.fn((input: string | URL | Request) => {
      expect((input as Request).headers.get('authorization')).toBe(
        'OAuth user-token',
      )
      return Promise.resolve(Response.json({ urn: 'soundcloud:users:1' }))
    })
    const client = await createSoundCloudUserClient({
      accessToken: '',
      clientSecret: '',
      credentialsPath,
      fetch,
    })

    await expect(client.getMe()).resolves.toMatchObject({
      urn: 'soundcloud:users:1',
    })
  })
})
