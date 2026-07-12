import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { SessionStore, StoredSession } from './types.js'

export function defaultCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SPOTS_CREDENTIALS_PATH) return env.SPOTS_CREDENTIALS_PATH
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'spots', 'credentials.json')
  if (process.platform === 'win32' && env.APPDATA)
    return join(env.APPDATA, 'spots', 'credentials.json')
  return join(homedir(), '.config', 'spots', 'credentials.json')
}

export class FileSessionStore implements SessionStore {
  readonly path: string

  constructor(path = defaultCredentialsPath()) {
    this.path = path
  }

  async load(): Promise<StoredSession | undefined> {
    let contents: string
    try {
      contents = await readFile(this.path, 'utf8')
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return undefined
      throw error
    }

    const value: unknown = JSON.parse(contents)
    if (!isStoredSession(value)) {
      throw new Error(`Invalid spots credential file at ${this.path}`)
    }
    return value
  }

  async save(session: StoredSession): Promise<void> {
    const directory = dirname(this.path)
    const temporary = `${this.path}.${process.pid}.tmp`
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.path)
    await chmod(this.path, 0o600)
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true })
  }
}

export class MemorySessionStore implements SessionStore {
  #session: StoredSession | undefined

  constructor(session?: StoredSession) {
    this.#session = session
  }

  load(): Promise<StoredSession | undefined> {
    return Promise.resolve(this.#session ? structuredClone(this.#session) : undefined)
  }

  save(session: StoredSession): Promise<void> {
    this.#session = structuredClone(session)
    return Promise.resolve()
  }

  clear(): Promise<void> {
    this.#session = undefined
    return Promise.resolve()
  }
}

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null) return false
  const session = value as Partial<StoredSession>
  const token = session.token as Partial<StoredSession['token']> | undefined
  return (
    session.version === 1 &&
    typeof session.clientId === 'string' &&
    typeof session.redirectUri === 'string' &&
    typeof token?.accessToken === 'string' &&
    token.tokenType === 'Bearer' &&
    typeof token.expiresAt === 'number' &&
    Array.isArray(token.scopes) &&
    token.scopes.every((scope) => typeof scope === 'string') &&
    (token.refreshToken === undefined || typeof token.refreshToken === 'string')
  )
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
