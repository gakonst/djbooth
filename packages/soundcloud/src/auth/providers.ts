import { requestToken } from './token.js'
import { MemorySessionStore } from './store.js'
import type {
  AccessTokenProvider,
  FetchLike,
  SessionStore,
  StoredSession,
  TokenSet,
} from './types.js'

export class StaticAccessTokenProvider implements AccessTokenProvider {
  constructor(readonly accessToken: string) {}

  getAccessToken(): Promise<string> {
    return Promise.resolve(this.accessToken)
  }
}

export interface ClientCredentialsOptions {
  clientId: string
  clientSecret: string
  fetch?: FetchLike
  store?: SessionStore
  refreshLeewayMs?: number
}

export class ClientCredentialsProvider implements AccessTokenProvider {
  readonly #clientId: string
  readonly #clientSecret: string
  readonly #fetch: FetchLike
  readonly #store: SessionStore
  readonly #refreshLeewayMs: number
  #refreshing: Promise<TokenSet> | undefined

  constructor(options: ClientCredentialsOptions) {
    this.#clientId = options.clientId
    this.#clientSecret = options.clientSecret
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#store = options.store ?? new MemorySessionStore()
    this.#refreshLeewayMs = options.refreshLeewayMs ?? 30_000
  }

  async getAccessToken(): Promise<string> {
    const session = await this.#store.load()
    if (session) this.#assertSession(session)
    if (
      session &&
      session.token.expiresAt - this.#refreshLeewayMs > Date.now()
    ) {
      return session.token.accessToken
    }
    return (await this.#refreshOrCreate(false)).accessToken
  }

  async invalidateAccessToken(accessToken?: string): Promise<void> {
    const invalidate = async () => {
      const session = await this.#store.load()
      if (!session) return
      this.#assertSession(session)
      if (
        accessToken !== undefined &&
        session.token.accessToken !== accessToken
      )
        return
      await this.#store.save({
        ...session,
        token: { ...session.token, expiresAt: 0 },
      })
    }
    await (this.#store.withLock
      ? this.#store.withLock(invalidate)
      : invalidate())
  }

  refresh(force = true): Promise<TokenSet> {
    return this.#refreshOrCreate(force)
  }

  async #refreshOrCreate(force: boolean): Promise<TokenSet> {
    if (!this.#refreshing) {
      const refresh = async () => {
        const current = await this.#store.load()
        if (current) this.#assertSession(current)
        if (
          !force &&
          current &&
          current.token.expiresAt - this.#refreshLeewayMs > Date.now()
        ) {
          return current.token
        }

        const token = current
          ? await requestToken({
              fetch: this.#fetch,
              parameters: {
                grant_type: 'refresh_token',
                client_id: this.#clientId,
                client_secret: this.#clientSecret,
                refresh_token: current.token.refreshToken,
              },
            })
          : await requestToken({
              fetch: this.#fetch,
              parameters: { grant_type: 'client_credentials' },
              basicCredentials: {
                clientId: this.#clientId,
                clientSecret: this.#clientSecret,
              },
            })
        await this.#store.save({
          version: 1,
          grantType: 'client_credentials',
          clientId: this.#clientId,
          token,
        })
        return token
      }
      this.#refreshing = (
        this.#store.withLock ? this.#store.withLock(refresh) : refresh()
      ).finally(() => {
        this.#refreshing = undefined
      })
    }
    return this.#refreshing
  }

  #assertSession(session: StoredSession): void {
    if (
      session.grantType !== 'client_credentials' ||
      session.clientId !== this.#clientId
    ) {
      throw new Error(
        'Stored SoundCloud client-credentials token belongs to another client',
      )
    }
  }
}
