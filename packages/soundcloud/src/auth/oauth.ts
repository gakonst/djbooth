import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import { authorizationBaseUrl, requestToken } from './token.js'
import type {
  AccessTokenProvider,
  FetchLike,
  SessionStore,
  StoredSession,
  TokenSet,
} from './types.js'

export interface SoundCloudOAuthOptions {
  clientId: string
  clientSecret: string
  redirectUri: string
  store: SessionStore
  fetch?: FetchLike
  refreshLeewayMs?: number
  /** Retain the supplied app secret in the private session for desktop refreshes. */
  persistClientSecret?: boolean
}

export interface AuthorizationRequest {
  url: string
  verifier: string
  state: string
}

export class SoundCloudOAuth implements AccessTokenProvider {
  readonly clientId: string
  readonly redirectUri: string
  readonly store: SessionStore
  readonly #clientSecret: string
  readonly #fetch: FetchLike
  readonly #refreshLeewayMs: number
  readonly #persistClientSecret: boolean
  #refreshing: Promise<TokenSet> | undefined

  constructor(options: SoundCloudOAuthOptions) {
    this.clientId = options.clientId
    this.redirectUri = options.redirectUri
    this.store = options.store
    this.#clientSecret = options.clientSecret
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#refreshLeewayMs = options.refreshLeewayMs ?? 30_000
    this.#persistClientSecret = options.persistClientSecret ?? false
  }

  createAuthorizationRequest(
    options: { display?: 'popup' } = {},
  ): AuthorizationRequest {
    const verifier = base64Url(randomBytes(64))
    const state = base64Url(randomBytes(32))
    const challenge = base64Url(createHash('sha256').update(verifier).digest())
    const url = new URL('/authorize', authorizationBaseUrl)
    url.search = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      state,
      ...(options.display ? { display: options.display } : {}),
    }).toString()
    return { url: url.toString(), verifier, state }
  }

  verifyState(expected: string, actual: string | null): boolean {
    if (!actual) return false
    const expectedBytes = Buffer.from(expected)
    const actualBytes = Buffer.from(actual)
    return (
      expectedBytes.length === actualBytes.length &&
      timingSafeEqual(expectedBytes, actualBytes)
    )
  }

  async exchangeCode(code: string, verifier: string): Promise<TokenSet> {
    const token = await requestToken({
      fetch: this.#fetch,
      parameters: {
        grant_type: 'authorization_code',
        client_id: this.clientId,
        client_secret: this.#clientSecret,
        redirect_uri: this.redirectUri,
        code_verifier: verifier,
        code,
      },
    })
    const save = () => this.#saveToken(token)
    await (this.store.withLock ? this.store.withLock(save) : save())
    return token
  }

  async getAccessToken(): Promise<string> {
    const session = await this.store.load()
    this.#assertSession(session)
    if (session.token.expiresAt - this.#refreshLeewayMs > Date.now()) {
      return session.token.accessToken
    }
    return (await this.#refresh(false)).accessToken
  }

  async invalidateAccessToken(accessToken?: string): Promise<void> {
    const invalidate = async () => {
      const session = await this.store.load()
      if (!session) return
      this.#assertSession(session)
      if (
        accessToken !== undefined &&
        session.token.accessToken !== accessToken
      )
        return
      await this.store.save({
        ...session,
        token: { ...session.token, expiresAt: 0 },
      })
    }
    await (this.store.withLock ? this.store.withLock(invalidate) : invalidate())
  }

  refresh(force = true): Promise<TokenSet> {
    return this.#refresh(force)
  }

  async #refresh(force: boolean): Promise<TokenSet> {
    if (!this.#refreshing) {
      const refresh = async () => {
        const session = await this.store.load()
        this.#assertSession(session)
        if (
          !force &&
          session.token.expiresAt - this.#refreshLeewayMs > Date.now()
        ) {
          return session.token
        }

        const token = await requestToken({
          fetch: this.#fetch,
          parameters: {
            grant_type: 'refresh_token',
            client_id: this.clientId,
            client_secret: this.#clientSecret,
            refresh_token: session.token.refreshToken,
          },
        })
        await this.#saveToken(token)
        return token
      }
      this.#refreshing = (
        this.store.withLock ? this.store.withLock(refresh) : refresh()
      ).finally(() => {
        this.#refreshing = undefined
      })
    }
    return this.#refreshing
  }

  async #saveToken(token: TokenSet): Promise<void> {
    await this.store.save({
      version: 1,
      grantType: 'authorization_code',
      clientId: this.clientId,
      ...(this.#persistClientSecret
        ? { clientSecret: this.#clientSecret }
        : {}),
      redirectUri: this.redirectUri,
      token,
    })
  }

  #assertSession(
    session: StoredSession | undefined,
  ): asserts session is StoredSession {
    if (!session || session.grantType !== 'authorization_code') {
      throw new Error(
        'Not logged in to SoundCloud; run `soundcloud auth login`',
      )
    }
    if (session.clientId !== this.clientId) {
      throw new Error(
        'Stored SoundCloud session belongs to a different client ID; log in again',
      )
    }
    if (session.redirectUri !== this.redirectUri) {
      throw new Error(
        'Stored SoundCloud session uses a different redirect URI; log in again',
      )
    }
  }
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url')
}
