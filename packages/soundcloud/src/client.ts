import createOpenApiClient, { type Client } from 'openapi-fetch'

import { StaticAccessTokenProvider } from './auth/providers.js'
import type { AccessTokenProvider, FetchLike } from './auth/types.js'
import { SoundCloudApiError } from './errors.js'
import type { components, paths } from './generated/soundcloud-schema.js'

const defaultBaseUrl = 'https://api.soundcloud.com'

export type SoundCloudUserUrn = `soundcloud:users:${string}`
export type SoundCloudTrackUrn = `soundcloud:tracks:${string}`
export type SoundCloudPlaylistUrn = `soundcloud:playlists:${string}`
export type SoundCloudTrackAccess = 'playable' | 'preview' | 'blocked'
export type SoundCloudPlaylistSharing = 'public' | 'private'
export type SoundCloudTrackReference = number | string

export type SoundCloudUser = components['schemas']['User']
export type SoundCloudMe = components['schemas']['Me']
export type SoundCloudTrack = components['schemas']['Track']
export type SoundCloudPlaylist = components['schemas']['Playlist']

export interface SoundCloudPage<T> {
  collection: T[]
  next_href?: string | null
}

export type SoundCloudCollection<T> = SoundCloudPage<T> | T[]

export interface RetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  retryUnsafeMethods?: boolean
}

export interface SoundCloudClientOptions {
  auth: string | AccessTokenProvider
  baseUrl?: string
  fetch?: FetchLike
  retry?: RetryOptions | false
}

type QueryPrimitive = string | number | boolean
export type RawQueryValue =
  | QueryPrimitive
  | readonly QueryPrimitive[]
  | Record<string, QueryPrimitive | undefined>
  | undefined

export interface RawRequestOptions extends Omit<RequestInit, 'body'> {
  body?: BodyInit | Record<string, unknown> | readonly unknown[] | null
  query?: Record<string, RawQueryValue>
}

export interface PaginationOptions {
  maxItems?: number
  maxPages?: number
  signal?: AbortSignal
}

export interface LikedTracksOptions extends PaginationOptions {
  limit?: number
  access?: readonly SoundCloudTrackAccess[]
}

export interface LikedPlaylistsOptions extends PaginationOptions {
  limit?: number
}

export interface CreateSoundCloudPlaylistInput {
  title: string
  tracks: readonly SoundCloudTrackReference[]
  description?: string
  sharing?: SoundCloudPlaylistSharing
  signal?: AbortSignal
}

export interface UpdateSoundCloudPlaylistInput {
  title?: string
  description?: string
  sharing?: SoundCloudPlaylistSharing
  /** When present, replace the complete ordered playlist membership. */
  tracks?: readonly SoundCloudTrackReference[]
  signal?: AbortSignal
}

export interface DeleteSoundCloudPlaylistResult {
  playlistUrn: SoundCloudPlaylistUrn
  deleted: true
}

export class SoundCloudClient {
  readonly api: Client<paths>
  readonly GET: Client<paths>['GET']
  readonly PUT: Client<paths>['PUT']
  readonly POST: Client<paths>['POST']
  readonly DELETE: Client<paths>['DELETE']
  readonly #baseUrl: URL
  readonly #fetch: (request: Request) => Promise<Response>

  constructor(options: SoundCloudClientOptions) {
    const provider =
      typeof options.auth === 'string'
        ? new StaticAccessTokenProvider(options.auth)
        : options.auth
    this.#baseUrl = new URL(
      `${(options.baseUrl ?? defaultBaseUrl).replace(/\/$/, '')}/`,
    )
    this.#fetch = authenticatedFetch({
      provider,
      fetch: options.fetch ?? globalThis.fetch,
      retry: options.retry,
    })
    this.api = createOpenApiClient<paths>({
      baseUrl: this.#baseUrl.href.replace(/\/$/, ''),
      fetch: this.#fetch,
    })
    this.GET = this.api.GET.bind(this.api)
    this.PUT = this.api.PUT.bind(this.api)
    this.POST = this.api.POST.bind(this.api)
    this.DELETE = this.api.DELETE.bind(this.api)
  }

  /** Fetch-compatible handler used by Incur and other OpenAPI adapters. */
  fetch(request: Request): Promise<Response> {
    const incoming = new URL(request.url)
    const target = new URL(incoming.pathname.replace(/^\//, ''), this.#baseUrl)
    target.search = incoming.search
    return this.#fetch(new Request(target, request))
  }

  async raw<T = unknown>(
    method: string,
    pathOrUrl: string,
    options: RawRequestOptions = {},
  ): Promise<T | undefined> {
    const url = this.#apiUrl(pathOrUrl)
    appendQuery(url, options.query)

    const { body: inputBody, query: requestQuery, ...requestOptions } = options
    void requestQuery
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
    if (!response.ok) throw await SoundCloudApiError.fromResponse(response)
    if (
      response.status === 204 ||
      response.headers.get('content-length') === '0'
    )
      return undefined
    const contentType = response.headers.get('content-type') ?? ''
    return (
      contentType.includes('json')
        ? await response.json()
        : await response.text()
    ) as T
  }

  async *paginate<T>(
    pathOrUrl: string,
    query: RawRequestOptions['query'] = {},
    options: PaginationOptions = {},
  ): AsyncGenerator<T> {
    let next: string | null = pathOrUrl
    let first = true
    let pages = 0
    let items = 0
    const seen = new Set<string>()

    while (next) {
      options.signal?.throwIfAborted()
      if (options.maxItems !== undefined && items >= options.maxItems) return
      if (options.maxPages !== undefined && pages >= options.maxPages) return
      const pageUrl = this.#apiUrl(next).toString()
      if (seen.has(pageUrl)) {
        const safeUrl = new URL(pageUrl)
        throw new Error(
          `SoundCloud pagination cycle detected at ${safeUrl.origin}${safeUrl.pathname}`,
        )
      }
      seen.add(pageUrl)

      const response: SoundCloudCollection<T> | undefined = await this.raw<
        SoundCloudCollection<T>
      >(
        'GET',
        next,
        first
          ? {
              query: { ...query, linked_partitioning: true },
              ...(options.signal ? { signal: options.signal } : {}),
            }
          : options.signal
            ? { signal: options.signal }
            : {},
      )
      if (!response) return
      const collection = Array.isArray(response)
        ? response
        : response.collection
      for (const item of collection) {
        if (options.maxItems !== undefined && items >= options.maxItems) return
        yield item
        items += 1
      }
      next = Array.isArray(response) ? null : (response.next_href ?? null)
      first = false
      pages += 1
    }
  }

  getMe(
    options: Pick<RawRequestOptions, 'signal'> = {},
  ): Promise<SoundCloudMe | undefined> {
    return this.raw<SoundCloudMe>('GET', '/me', options)
  }

  getRecentlyPlayedTracks(
    options: Pick<RawRequestOptions, 'signal'> = {},
  ): Promise<SoundCloudTrack[] | undefined> {
    return this.raw<SoundCloudTrack[]>(
      'GET',
      '/me/recently-played/tracks',
      options,
    )
  }

  iterateLikedTracks(
    options: LikedTracksOptions = {},
  ): AsyncGenerator<SoundCloudTrack> {
    const {
      limit = 200,
      access = ['playable', 'preview', 'blocked'],
      ...pagination
    } = options
    return this.paginate<SoundCloudTrack>(
      '/me/likes/tracks',
      { limit, access },
      pagination,
    )
  }

  iterateLikedPlaylists(
    options: LikedPlaylistsOptions = {},
  ): AsyncGenerator<SoundCloudPlaylist> {
    const { limit = 200, ...pagination } = options
    return this.paginate<SoundCloudPlaylist>(
      '/me/likes/playlists',
      { limit },
      pagination,
    )
  }

  async getAllLikedTracks(
    options: LikedTracksOptions = {},
  ): Promise<SoundCloudTrack[]> {
    const tracks: SoundCloudTrack[] = []
    for await (const track of this.iterateLikedTracks(options))
      tracks.push(track)
    return tracks
  }

  async getAllLikedPlaylists(
    options: LikedPlaylistsOptions = {},
  ): Promise<SoundCloudPlaylist[]> {
    const playlists: SoundCloudPlaylist[] = []
    for await (const playlist of this.iterateLikedPlaylists(options))
      playlists.push(playlist)
    return playlists
  }

  /** Create a user playlist from ordered track IDs, URNs, or SoundCloud URLs. */
  async createPlaylist(
    input: CreateSoundCloudPlaylistInput,
  ): Promise<SoundCloudPlaylist> {
    const title = input.title.trim()
    if (!title) throw new Error('SoundCloud playlist title is required')
    if (input.tracks.length === 0)
      throw new Error('A SoundCloud playlist requires at least one track')
    if (input.tracks.length > 500)
      throw new Error('SoundCloud playlists support at most 500 tracks')

    const tracks: { urn: SoundCloudTrackUrn }[] = []
    for (const reference of input.tracks) {
      input.signal?.throwIfAborted()
      tracks.push({ urn: await this.#resolveTrackUrn(reference, input.signal) })
    }

    const playlist = await this.raw<SoundCloudPlaylist>('POST', '/playlists', {
      body: {
        playlist: {
          title,
          ...(input.description === undefined
            ? {}
            : { description: input.description }),
          sharing: input.sharing ?? 'private',
          tracks,
        },
      },
      ...(input.signal ? { signal: input.signal } : {}),
    })
    if (
      !playlist ||
      typeof playlist.urn !== 'string' ||
      !/^soundcloud:playlists:[^:]+$/u.test(playlist.urn)
    )
      throw new Error('SoundCloud returned no playlist after creation')
    return playlist
  }

  /** Read a playlist by numeric ID, URN, or SoundCloud URL. */
  async getPlaylist(
    reference: string | number,
    options: Pick<RawRequestOptions, 'signal'> = {},
  ): Promise<SoundCloudPlaylist> {
    const playlistUrn = await this.#resolvePlaylistUrn(
      reference,
      options.signal ?? undefined,
    )
    const playlist = await this.raw<SoundCloudPlaylist>(
      'GET',
      `/playlists/${playlistUrn}`,
      options,
    )
    return requireSoundCloudPlaylist(playlist, 'read')
  }

  /** Update playlist details and optionally replace the complete ordered track list. */
  async updatePlaylist(
    reference: string | number,
    input: UpdateSoundCloudPlaylistInput,
  ): Promise<SoundCloudPlaylist> {
    if (typeof input !== 'object' || input === null) {
      throw new TypeError(
        'SoundCloud playlist update options must be an object',
      )
    }
    if (input.title !== undefined && input.title.trim().length === 0) {
      throw new TypeError('SoundCloud playlist title must not be empty')
    }
    if (
      input.sharing !== undefined &&
      input.sharing !== 'private' &&
      input.sharing !== 'public'
    ) {
      throw new TypeError(
        'SoundCloud playlist sharing must be private or public',
      )
    }
    if (
      input.tracks !== undefined &&
      !isSoundCloudTrackReferenceArray(input.tracks)
    ) {
      throw new TypeError('SoundCloud playlist tracks must be an array')
    }
    if (input.tracks && input.tracks.length > 500) {
      throw new TypeError('SoundCloud playlists support at most 500 tracks')
    }
    if (
      input.title === undefined &&
      input.description === undefined &&
      input.sharing === undefined &&
      input.tracks === undefined
    ) {
      throw new TypeError('At least one SoundCloud playlist update is required')
    }

    const playlistUrn = await this.#resolvePlaylistUrn(reference, input.signal)
    let tracks: { urn: SoundCloudTrackUrn }[] | undefined
    if (input.tracks !== undefined) {
      tracks = []
      for (const track of input.tracks) {
        input.signal?.throwIfAborted()
        tracks.push({ urn: await this.#resolveTrackUrn(track, input.signal) })
      }
    }

    const playlist = await this.raw<SoundCloudPlaylist>(
      'PUT',
      `/playlists/${playlistUrn}`,
      {
        body: {
          playlist: {
            ...(input.title === undefined ? {} : { title: input.title.trim() }),
            ...(input.description === undefined
              ? {}
              : { description: input.description }),
            ...(input.sharing === undefined ? {} : { sharing: input.sharing }),
            ...(tracks === undefined ? {} : { tracks }),
          },
        },
        ...(input.signal ? { signal: input.signal } : {}),
      },
    )
    return requireSoundCloudPlaylist(playlist, 'update')
  }

  /** Permanently delete a playlist owned by the authenticated SoundCloud user. */
  async deletePlaylist(
    reference: string | number,
    options: Pick<RawRequestOptions, 'signal'> = {},
  ): Promise<DeleteSoundCloudPlaylistResult> {
    const playlistUrn = await this.#resolvePlaylistUrn(
      reference,
      options.signal ?? undefined,
    )
    await this.raw('DELETE', `/playlists/${playlistUrn}`, options)
    return { playlistUrn, deleted: true }
  }

  async #resolveTrackUrn(
    reference: SoundCloudTrackReference,
    signal?: AbortSignal,
  ): Promise<SoundCloudTrackUrn> {
    if (typeof reference === 'number') {
      if (!Number.isSafeInteger(reference) || reference <= 0)
        throw new Error(`Invalid SoundCloud track ID: ${reference}`)
      return `soundcloud:tracks:${reference}`
    }

    const value = reference.trim()
    if (/^[1-9]\d*$/u.test(value)) return `soundcloud:tracks:${value}`
    if (/^soundcloud:tracks:[^:]+$/u.test(value))
      return value as SoundCloudTrackUrn

    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new Error(`Invalid SoundCloud track reference: ${reference}`)
    }
    if (
      url.protocol !== 'https:' ||
      !['soundcloud.com', 'www.soundcloud.com', 'on.soundcloud.com'].includes(
        url.hostname,
      )
    ) {
      throw new Error(`Unsupported SoundCloud track URL: ${reference}`)
    }

    const resource = await this.raw<SoundCloudTrack>('GET', '/resolve', {
      query: { url: url.href },
      ...(signal ? { signal } : {}),
    })
    if (
      !resource ||
      (resource.kind !== undefined && resource.kind !== 'track') ||
      typeof resource.urn !== 'string' ||
      !/^soundcloud:tracks:[^:]+$/u.test(resource.urn)
    ) {
      throw new Error(
        `SoundCloud URL does not resolve to a track: ${reference}`,
      )
    }
    return resource.urn as SoundCloudTrackUrn
  }

  async #resolvePlaylistUrn(
    reference: string | number,
    signal?: AbortSignal,
  ): Promise<SoundCloudPlaylistUrn> {
    if (typeof reference === 'number') {
      if (!Number.isSafeInteger(reference) || reference <= 0) {
        throw new Error(`Invalid SoundCloud playlist ID: ${reference}`)
      }
      return `soundcloud:playlists:${reference}`
    }

    const value = reference.trim()
    if (/^[1-9]\d*$/u.test(value)) return `soundcloud:playlists:${value}`
    if (/^soundcloud:playlists:[^:]+$/u.test(value)) {
      return value as SoundCloudPlaylistUrn
    }

    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new Error(`Invalid SoundCloud playlist reference: ${reference}`)
    }
    if (
      url.protocol !== 'https:' ||
      !['soundcloud.com', 'www.soundcloud.com', 'on.soundcloud.com'].includes(
        url.hostname,
      )
    ) {
      throw new Error(`Unsupported SoundCloud playlist URL: ${reference}`)
    }
    const resource = await this.raw<SoundCloudPlaylist>('GET', '/resolve', {
      query: { url: url.href },
      ...(signal ? { signal } : {}),
    })
    return requireSoundCloudPlaylist(resource, `resolve ${reference}`).urn
  }

  #apiUrl(pathOrUrl: string): URL {
    const url = new URL(pathOrUrl.replace(/^\//, ''), this.#baseUrl)
    if (url.origin !== this.#baseUrl.origin) {
      throw new Error(
        `Refusing to send SoundCloud credentials to ${url.origin}`,
      )
    }
    return url
  }
}

function requireSoundCloudPlaylist(
  playlist: SoundCloudPlaylist | undefined,
  operation: string,
): SoundCloudPlaylist & { urn: SoundCloudPlaylistUrn } {
  if (
    !playlist ||
    typeof playlist.urn !== 'string' ||
    !/^soundcloud:playlists:[^:]+$/u.test(playlist.urn)
  ) {
    throw new Error(`SoundCloud returned no playlist after ${operation}`)
  }
  return playlist as SoundCloudPlaylist & { urn: SoundCloudPlaylistUrn }
}

function isSoundCloudTrackReferenceArray(
  value: unknown,
): value is readonly SoundCloudTrackReference[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' || typeof item === 'number')
  )
}

function authenticatedFetch(options: {
  provider: AccessTokenProvider
  fetch: FetchLike
  retry: RetryOptions | false | undefined
}): (request: Request) => Promise<Response> {
  const retry =
    options.retry === false
      ? {
          maxAttempts: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
          retryUnsafeMethods: false,
        }
      : {
          maxAttempts: options.retry?.maxAttempts ?? 3,
          baseDelayMs: options.retry?.baseDelayMs ?? 250,
          maxDelayMs: options.retry?.maxDelayMs ?? 10_000,
          retryUnsafeMethods: options.retry?.retryUnsafeMethods ?? false,
        }
  const cooldown = new RequestCooldownGate(
    Math.min(250, Math.max(25, retry.baseDelayMs)),
  )

  return async (request) => {
    let refreshedAfterUnauthorized = false
    for (let attempt = 1; ; attempt++) {
      await cooldown.wait(request.signal)
      const headers = new Headers(request.headers)
      let injectedAccessToken: string | undefined
      if (!headers.has('authorization')) {
        injectedAccessToken = await options.provider.getAccessToken()
        headers.set('authorization', `OAuth ${injectedAccessToken}`)
      }

      let response: Response
      try {
        response = await options.fetch(
          new Request(request.clone(), { headers }),
        )
      } catch (error) {
        if (
          attempt >= retry.maxAttempts ||
          !canRetry(request.method, retry.retryUnsafeMethods)
        ) {
          throw error
        }
        await sleep(
          backoff(attempt, retry.baseDelayMs, retry.maxDelayMs),
          request.signal,
        )
        continue
      }

      if (
        response.status === 401 &&
        injectedAccessToken !== undefined &&
        !refreshedAfterUnauthorized &&
        options.provider.invalidateAccessToken
      ) {
        refreshedAfterUnauthorized = true
        await options.provider.invalidateAccessToken(injectedAccessToken)
        await response.body?.cancel()
        continue
      }
      const serverCooldown = await responseCooldown(response)
      const retryable = isRetryable(response.status)
      const retryDelay =
        serverCooldown ??
        (retryable
          ? backoff(attempt, retry.baseDelayMs, retry.maxDelayMs)
          : undefined)
      if (serverCooldown !== undefined) cooldown.defer(serverCooldown)
      if (
        attempt >= retry.maxAttempts ||
        !canRetry(request.method, retry.retryUnsafeMethods) ||
        !retryable
      ) {
        return response
      }

      if (serverCooldown !== undefined && serverCooldown > retry.maxDelayMs)
        return response
      await response.body?.cancel()
      if (serverCooldown === undefined && retryDelay !== undefined)
        await sleep(retryDelay, request.signal)
    }
  }
}

class RequestCooldownGate {
  #notBefore = 0
  #nextStart = 0

  constructor(readonly spacingMs: number) {}

  defer(milliseconds: number): void {
    this.#notBefore = Math.max(
      this.#notBefore,
      Date.now() + Math.max(0, milliseconds),
    )
    this.#nextStart = Math.max(this.#nextStart, this.#notBefore)
  }

  async wait(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    let releaseAt = Math.max(this.#notBefore, this.#nextStart)
    if (releaseAt <= Date.now()) return
    this.#nextStart = releaseAt + this.spacingMs

    for (;;) {
      await sleep(Math.max(0, releaseAt - Date.now()), signal)
      if (this.#notBefore <= Date.now()) return
      releaseAt = Math.max(this.#notBefore, this.#nextStart)
      this.#nextStart = releaseAt + this.spacingMs
    }
  }
}

async function responseCooldown(
  response: Response,
): Promise<number | undefined> {
  const delays: number[] = []
  const retryAfter = parseRetryAfter(response.headers.get('retry-after'))
  if (retryAfter !== undefined) delays.push(retryAfter)

  if (rateLimitExhausted(response)) {
    for (const name of [
      'ratelimit-reset',
      'x-ratelimit-reset',
      'x-rate-limit-reset',
    ]) {
      const delay = parseRateLimitReset(response.headers.get(name))
      if (delay !== undefined) delays.push(delay)
    }
    if (response.status === 429) {
      const error = await SoundCloudApiError.fromResponse(response)
      const delay = parseRateLimitReset(error.rateLimit?.resetTime ?? null)
      if (delay !== undefined) delays.push(delay)
    }
  }

  return delays.length ? Math.max(...delays) : undefined
}

function rateLimitExhausted(response: Response): boolean {
  if (response.status === 429) return true
  for (const name of [
    'ratelimit-remaining',
    'x-ratelimit-remaining',
    'x-rate-limit-remaining',
  ]) {
    const remaining = response.headers.get(name)
    if (remaining !== null && Number(remaining) === 0) return true
  }
  return false
}

function appendQuery(url: URL, query: RawRequestOptions['query']): void {
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      url.searchParams.set(key, value.join(','))
      continue
    }
    if (typeof value === 'object') {
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        if (nestedValue !== undefined)
          url.searchParams.set(`${key}[${nestedKey}]`, String(nestedValue))
      }
      continue
    }
    url.searchParams.set(key, String(value))
  }
}

function canRetry(method: string, retryUnsafeMethods: boolean): boolean {
  return (
    retryUnsafeMethods ||
    ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())
  )
}

function isRetryable(status: number): boolean {
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  )
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp)
    ? undefined
    : Math.max(0, timestamp - Date.now())
}

function parseRateLimitReset(value: string | null): number | undefined {
  if (!value) return undefined
  const numeric = Number(value)
  if (Number.isFinite(numeric)) {
    const timestamp =
      numeric >= 1_000_000_000_000
        ? numeric
        : numeric >= 1_000_000_000
          ? numeric * 1000
          : Date.now() + numeric * 1000
    return Math.max(0, timestamp - Date.now())
  }
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp)
    ? undefined
    : Math.max(0, timestamp - Date.now())
}

function backoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
  return Math.round(Math.random() * ceiling)
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    const abort = () => {
      clearTimeout(timeout)
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException('The operation was aborted', 'AbortError'),
      )
    }
    const timeout = setTimeout(finish, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
  })
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
