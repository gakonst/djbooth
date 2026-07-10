import createOpenApiClient, { type Client } from 'openapi-fetch'

import type { AccessTokenProvider, FetchLike } from './auth/types.js'
import { StaticAccessTokenProvider } from './auth/providers.js'
import { SpotifyApiError } from './errors.js'
import type { paths } from './generated/spotify-schema.js'

const defaultBaseUrl = 'https://api.spotify.com/v1'

export interface RetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
}

export interface SpotifyClientOptions {
  auth: string | AccessTokenProvider
  baseUrl?: string
  fetch?: FetchLike
  retry?: RetryOptions | false
}

export interface RawRequestOptions extends Omit<RequestInit, 'body'> {
  body?: BodyInit | Record<string, unknown> | readonly unknown[] | null
  query?: Record<string, string | number | boolean | readonly (string | number | boolean)[] | undefined>
}

export class SpotifyClient {
  readonly api: Client<paths>
  readonly GET: Client<paths>['GET']
  readonly PUT: Client<paths>['PUT']
  readonly POST: Client<paths>['POST']
  readonly DELETE: Client<paths>['DELETE']
  readonly #baseUrl: string
  readonly #fetch: (request: Request) => Promise<Response>

  constructor(options: SpotifyClientOptions) {
    const provider =
      typeof options.auth === 'string' ? new StaticAccessTokenProvider(options.auth) : options.auth
    this.#baseUrl = (options.baseUrl ?? defaultBaseUrl).replace(/\/$/, '')
    this.#fetch = authenticatedFetch({
      provider,
      fetch: options.fetch ?? globalThis.fetch,
      retry: options.retry,
    })
    this.api = createOpenApiClient<paths>({ baseUrl: this.#baseUrl, fetch: this.#fetch })
    this.GET = this.api.GET.bind(this.api)
    this.PUT = this.api.PUT.bind(this.api)
    this.POST = this.api.POST.bind(this.api)
    this.DELETE = this.api.DELETE.bind(this.api)
  }

  async raw<T = unknown>(
    method: string,
    path: string,
    options: RawRequestOptions = {},
  ): Promise<T | undefined> {
    const url = new URL(path.replace(/^\//, ''), `${this.#baseUrl}/`)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined) continue
      if (Array.isArray(value)) url.searchParams.set(key, value.join(','))
      else url.searchParams.set(key, String(value))
    }

    const { body: inputBody, query: _query, ...requestOptions } = options
    const headers = new Headers(requestOptions.headers)
    let body: BodyInit | null | undefined
    if (isBodyInit(inputBody) || inputBody == null) {
      body = inputBody
    } else {
      headers.set('content-type', 'application/json')
      body = JSON.stringify(inputBody)
    }
    const response = await this.#fetch(
      new Request(url, {
        ...requestOptions,
        method: method.toUpperCase(),
        headers,
        ...(body === undefined ? {} : { body }),
      }),
    )
    if (!response.ok) throw await SpotifyApiError.fromResponse(response)
    if (response.status === 204 || response.headers.get('content-length') === '0') return undefined
    const contentType = response.headers.get('content-type') ?? ''
    return (contentType.includes('json') ? await response.json() : await response.text()) as T
  }

  async *paginate<T>(pathOrUrl: string, query: RawRequestOptions['query'] = {}): AsyncGenerator<T> {
    let next: string | null = pathOrUrl
    let first = true
    while (next) {
      const page: SpotifyPage<T> | undefined = await this.raw<SpotifyPage<T>>(
        'GET',
        next,
        first ? { query } : {},
      )
      if (!page) return
      yield* page.items
      next = page.next
      first = false
    }
  }
}

export interface SpotifyPage<T> {
  items: T[]
  next: string | null
}

function authenticatedFetch(options: {
  provider: AccessTokenProvider
  fetch: FetchLike
  retry: RetryOptions | false | undefined
}): (request: Request) => Promise<Response> {
  const retry =
    options.retry === false
      ? { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 }
      : {
          maxAttempts: options.retry?.maxAttempts ?? 3,
          baseDelayMs: options.retry?.baseDelayMs ?? 250,
          maxDelayMs: options.retry?.maxDelayMs ?? 10_000,
        }

  return async (request) => {
    let refreshedAfterUnauthorized = false
    for (let attempt = 1; ; attempt++) {
      const headers = new Headers(request.headers)
      if (!headers.has('authorization')) {
        headers.set('authorization', `Bearer ${await options.provider.getAccessToken()}`)
      }
      const response = await options.fetch(new Request(request.clone(), { headers }))

      if (
        response.status === 401 &&
        !refreshedAfterUnauthorized &&
        options.provider.invalidateAccessToken
      ) {
        refreshedAfterUnauthorized = true
        await options.provider.invalidateAccessToken()
        continue
      }
      if (attempt >= retry.maxAttempts || !isRetryable(response.status)) return response

      const retryAfter = parseRetryAfter(response.headers.get('retry-after'))
      const exponential = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1))
      const delay = retryAfter ?? Math.round(exponential * (0.5 + Math.random() * 0.5))
      await response.body?.cancel()
      await sleep(delay)
    }
  }
}

function isRetryable(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - Date.now())
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function isBodyInit(value: unknown): value is BodyInit {
  return (
    typeof value === 'string' ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    value instanceof Blob ||
    value instanceof FormData ||
    value instanceof URLSearchParams ||
    value instanceof ReadableStream
  )
}
