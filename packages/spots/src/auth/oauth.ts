import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import type {
  AccessTokenProvider,
  FetchLike,
  SessionStore,
  StoredSession,
  TokenSet,
} from './types.js'

const accountsBaseUrl = 'https://accounts.spotify.com'

export interface SpotifyOAuthOptions {
  clientId: string
  redirectUri: string
  store: SessionStore
  clientSecret?: string
  fetch?: FetchLike
  refreshLeewayMs?: number
}

export interface AuthorizationRequest {
  url: string
  verifier: string
  state: string
}

export class SpotifyOAuth implements AccessTokenProvider {
  readonly clientId: string
  readonly redirectUri: string
  readonly store: SessionStore
  readonly #clientSecret: string | undefined
  readonly #fetch: FetchLike
  readonly #refreshLeewayMs: number
  #refreshing: Promise<TokenSet> | undefined

  constructor(options: SpotifyOAuthOptions) {
    this.clientId = options.clientId
    this.redirectUri = options.redirectUri
    this.store = options.store
    this.#clientSecret = options.clientSecret
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#refreshLeewayMs = options.refreshLeewayMs ?? 30_000
  }

  createAuthorizationRequest(scopes: readonly string[]): AuthorizationRequest {
    const verifier = base64Url(randomBytes(64))
    const state = base64Url(randomBytes(32))
    const challenge = base64Url(createHash('sha256').update(verifier).digest())
    const url = new URL('/authorize', accountsBaseUrl)
    url.search = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      state,
      scope: [...new Set(scopes)].join(' '),
    }).toString()
    return { url: url.toString(), verifier, state }
  }

  verifyState(expected: string, actual: string | null): boolean {
    if (!actual) return false
    const expectedBytes = Buffer.from(expected)
    const actualBytes = Buffer.from(actual)
    return (
      expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes)
    )
  }

  async exchangeCode(code: string, verifier: string): Promise<TokenSet> {
    const token = await this.#requestToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      code_verifier: verifier,
      ...(!this.#clientSecret ? { client_id: this.clientId } : {}),
    })
    await this.#saveToken(token)
    return token
  }

  async getAccessToken(): Promise<string> {
    const session = await this.store.load()
    this.#assertSession(session)
    if (session.token.expiresAt - this.#refreshLeewayMs > Date.now()) {
      return session.token.accessToken
    }
    if (!session.token.refreshToken) {
      throw new Error(
        'Spotify access token expired and no refresh token is available; log in again',
      )
    }
    const refreshed = await this.#refresh(session.token)
    return refreshed.accessToken
  }

  async invalidateAccessToken(): Promise<void> {
    const session = await this.store.load()
    if (!session) return
    await this.store.save({
      ...session,
      token: { ...session.token, expiresAt: 0 },
    })
  }

  async refresh(): Promise<TokenSet> {
    const session = await this.store.load()
    this.#assertSession(session)
    if (!session.token.refreshToken) throw new Error('No Spotify refresh token is available')
    return this.#refresh(session.token)
  }

  async #refresh(previous: TokenSet): Promise<TokenSet> {
    const refreshToken = previous.refreshToken
    if (!refreshToken) throw new Error('No Spotify refresh token is available')
    if (!this.#refreshing) {
      this.#refreshing = this.#requestToken({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        ...(!this.#clientSecret ? { client_id: this.clientId } : {}),
      })
        .then(async (token) => {
          const merged = {
            ...token,
            refreshToken: token.refreshToken ?? refreshToken,
            scopes: token.scopes.length ? token.scopes : previous.scopes,
          }
          await this.#saveToken(merged)
          return merged
        })
        .finally(() => {
          this.#refreshing = undefined
        })
    }
    return this.#refreshing
  }

  async #requestToken(parameters: Record<string, string>): Promise<TokenSet> {
    const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' })
    if (this.#clientSecret) {
      headers.set(
        'authorization',
        `Basic ${Buffer.from(`${this.clientId}:${this.#clientSecret}`).toString('base64')}`,
      )
    }

    const response = await this.#fetch(`${accountsBaseUrl}/api/token`, {
      method: 'POST',
      headers,
      body: new URLSearchParams(parameters),
    })
    const body = (await response.json().catch(() => undefined)) as TokenResponse | undefined
    if (!response.ok || !body?.access_token || !Number.isFinite(body.expires_in)) {
      const message = body?.error_description ?? body?.error ?? response.statusText
      throw new Error(`Spotify authorization failed (${response.status}): ${message}`)
    }
    return {
      accessToken: body.access_token,
      tokenType: 'Bearer',
      expiresAt: Date.now() + body.expires_in * 1000,
      scopes: body.scope ? body.scope.split(' ').filter(Boolean) : [],
      ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
    }
  }

  async #saveToken(token: TokenSet): Promise<void> {
    await this.store.save({
      version: 1,
      clientId: this.clientId,
      redirectUri: this.redirectUri,
      token,
    })
  }

  #assertSession(session: StoredSession | undefined): asserts session is StoredSession {
    if (!session) throw new Error('Not logged in to Spotify; run `spots auth login`')
    if (session.clientId !== this.clientId) {
      throw new Error('Stored Spotify session belongs to a different client ID; log in again')
    }
  }
}

interface TokenResponse {
  access_token?: string
  token_type?: string
  scope?: string
  expires_in: number
  refresh_token?: string
  error?: string
  error_description?: string
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url')
}
