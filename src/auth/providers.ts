import type { AccessTokenProvider, FetchLike } from './types.js'

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
  refreshLeewayMs?: number
}

export class ClientCredentialsProvider implements AccessTokenProvider {
  readonly #clientId: string
  readonly #clientSecret: string
  readonly #fetch: FetchLike
  readonly #refreshLeewayMs: number
  #token: { value: string; expiresAt: number } | undefined
  #refreshing: Promise<string> | undefined

  constructor(options: ClientCredentialsOptions) {
    this.#clientId = options.clientId
    this.#clientSecret = options.clientSecret
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#refreshLeewayMs = options.refreshLeewayMs ?? 30_000
  }

  async getAccessToken(): Promise<string> {
    if (this.#token && this.#token.expiresAt - this.#refreshLeewayMs > Date.now()) {
      return this.#token.value
    }
    this.#refreshing ??= this.#requestToken().finally(() => {
      this.#refreshing = undefined
    })
    return this.#refreshing
  }

  invalidateAccessToken(): void {
    this.#token = undefined
  }

  async #requestToken(): Promise<string> {
    const response = await this.#fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${this.#clientId}:${this.#clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
    })
    const body = (await response.json().catch(() => undefined)) as
      { access_token?: string; expires_in?: number; error_description?: string } | undefined
    if (!response.ok || !body?.access_token || !body.expires_in) {
      throw new Error(
        `Spotify client credentials authorization failed (${response.status}): ${body?.error_description ?? response.statusText}`,
      )
    }
    this.#token = {
      value: body.access_token,
      expiresAt: Date.now() + body.expires_in * 1000,
    }
    return this.#token.value
  }
}
