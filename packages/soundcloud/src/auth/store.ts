import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { SessionStore, StoredSession } from './types.js'

export function defaultCredentialsPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.SOUNDCLOUD_CREDENTIALS_PATH) return env.SOUNDCLOUD_CREDENTIALS_PATH
  return configPath('credentials.json', env)
}

export function defaultClientCredentialsPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.SOUNDCLOUD_CLIENT_CREDENTIALS_PATH)
    return env.SOUNDCLOUD_CLIENT_CREDENTIALS_PATH
  return configPath('client-credentials.json', env)
}

export class FileSessionStore implements SessionStore {
  readonly path: string
  readonly #lockTimeoutMs: number

  constructor(
    path = defaultCredentialsPath(),
    options: { lockTimeoutMs?: number } = {},
  ) {
    this.path = path
    this.#lockTimeoutMs = options.lockTimeoutMs ?? 5_000
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
      throw new Error(`Invalid SoundCloud credential file at ${this.path}`)
    }
    return value
  }

  async save(session: StoredSession): Promise<void> {
    const directory = dirname(this.path)
    const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, {
      mode: 0o600,
    })
    await rename(temporary, this.path)
    await chmod(this.path, 0o600)
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true })
  }

  async withLock<T>(task: () => Promise<T>): Promise<T> {
    const lockPath = `${this.path}.lock`
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const startedAt = Date.now()

    for (;;) {
      let handle
      try {
        handle = await open(lockPath, 'wx', 0o600)
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST') throw error
        if (await recoverAbandonedLock(lockPath)) continue
        if (Date.now() - startedAt >= this.#lockTimeoutMs) {
          throw new Error(
            `Timed out waiting for SoundCloud credential lock at ${lockPath}`,
          )
        }
        await sleep(25)
        continue
      }

      try {
        await handle.writeFile(`${process.pid}\n`)
        return await task()
      } finally {
        await handle.close()
        await rm(lockPath, { force: true })
      }
    }
  }
}

export class MemorySessionStore implements SessionStore {
  #session: StoredSession | undefined
  #lock: Promise<void> = Promise.resolve()

  constructor(session?: StoredSession) {
    this.#session = session
  }

  load(): Promise<StoredSession | undefined> {
    return Promise.resolve(
      this.#session ? structuredClone(this.#session) : undefined,
    )
  }

  save(session: StoredSession): Promise<void> {
    this.#session = structuredClone(session)
    return Promise.resolve()
  }

  clear(): Promise<void> {
    this.#session = undefined
    return Promise.resolve()
  }

  async withLock<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.#lock
    let release = () => {}
    this.#lock = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await task()
    } finally {
      release()
    }
  }
}

function configPath(file: string, env: NodeJS.ProcessEnv): string {
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'soundcloud', file)
  if (process.platform === 'win32' && env.APPDATA)
    return join(env.APPDATA, 'soundcloud', file)
  return join(homedir(), '.config', 'soundcloud', file)
}

async function recoverAbandonedLock(path: string): Promise<boolean> {
  let contents: string
  try {
    contents = await readFile(path, 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false
    throw error
  }

  const ownerPid = Number(contents.trim())
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
    if (Date.now() - (await stat(path)).mtimeMs < 5_000) return false
  } else {
    try {
      process.kill(ownerPid, 0)
      return false
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ESRCH') return false
    }
  }

  await rm(path, { force: true })
  return true
}

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null) return false
  const session = value as Partial<StoredSession>
  const token = session.token as Partial<StoredSession['token']> | undefined
  return (
    session.version === 1 &&
    (session.grantType === 'authorization_code' ||
      session.grantType === 'client_credentials') &&
    typeof session.clientId === 'string' &&
    (session.redirectUri === undefined ||
      typeof session.redirectUri === 'string') &&
    typeof token?.accessToken === 'string' &&
    typeof token.refreshToken === 'string' &&
    typeof token.expiresAt === 'number' &&
    typeof token.scope === 'string'
  )
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
