import createOpenApiClient, { type Client } from 'openapi-fetch'

import type { AccessTokenProvider, FetchLike } from './auth/types.js'
import { StaticAccessTokenProvider } from './auth/providers.js'
import { SpotifyApiError } from './errors.js'
import type { components, paths } from './generated/spotify-schema.js'

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
  query?: Record<
    string,
    string | number | boolean | readonly (string | number | boolean)[] | undefined
  >
}

export interface CreatePlaylistWithTracksOptions {
  name: string
  tracks: readonly string[]
  public?: boolean
  collaborative?: boolean
  description?: string
}

export interface CreatePlaylistWithTracksResult {
  playlist: components['schemas']['PlaylistObject']
  trackUris: string[]
  snapshotIds: string[]
}

export interface UpdateSpotifyPlaylistOptions {
  name?: string
  description?: string
  public?: boolean
  collaborative?: boolean
  /** When present, replace the complete ordered playlist membership. */
  tracks?: readonly string[]
  signal?: AbortSignal
}

export interface UpdateSpotifyPlaylistResult {
  playlistId: string
  trackUris?: string[]
  snapshotIds: string[]
}

export interface DeleteSpotifyPlaylistResult {
  playlistId: string
  removedFromLibrary: true
  /** Spotify has no permanent playlist-delete operation. */
  permanentlyDeleted: false
}

export class SpotifyPlaylistCreationError extends Error {
  override readonly name = 'SpotifyPlaylistCreationError'
  readonly playlist: components['schemas']['PlaylistObject']
  readonly trackUris: string[]
  readonly snapshotIds: string[]
  readonly tracksAdded: number

  constructor(options: {
    playlist: components['schemas']['PlaylistObject']
    trackUris: string[]
    snapshotIds: string[]
    tracksAdded: number
    cause: unknown
  }) {
    const destination = options.playlist.external_urls?.spotify ?? options.playlist.id ?? 'unknown'
    super(
      `Spotify playlist ${destination} was created, but adding tracks failed after ${options.tracksAdded} of ${options.trackUris.length} tracks`,
      { cause: options.cause },
    )
    this.playlist = options.playlist
    this.trackUris = options.trackUris
    this.snapshotIds = options.snapshotIds
    this.tracksAdded = options.tracksAdded
  }
}

interface PlaylistSnapshot {
  snapshot_id: string
}

const spotifyIdPattern = /^[0-9A-Za-z]+$/
const playlistBatchSize = 100

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

  /** Fetch-compatible handler used by incur and other HTTP adapters. */
  fetch(request: Request): Promise<Response> {
    const incoming = new URL(request.url)
    const target = new URL(this.#baseUrl)
    target.pathname = `${target.pathname.replace(/\/$/, '')}/${incoming.pathname.replace(/^\//, '')}`
    target.search = incoming.search
    return this.#fetch(new Request(target, request))
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

  /** Create a playlist and append tracks in order, retaining duplicate entries. */
  async createPlaylistWithTracks(
    options: CreatePlaylistWithTracksOptions,
  ): Promise<CreatePlaylistWithTracksResult> {
    const input = validateCreatePlaylistWithTracksOptions(options)
    const playlist = await this.raw<components['schemas']['PlaylistObject']>(
      'POST',
      '/me/playlists',
      {
        body: {
          name: input.name,
          public: input.public,
          collaborative: input.collaborative,
          ...(input.description === undefined ? {} : { description: input.description }),
        },
      },
    )
    if (!playlist?.id) throw new Error('Spotify created a playlist without returning its ID')

    const snapshotIds: string[] = []
    let tracksAdded = 0
    for (let offset = 0; offset < input.trackUris.length; offset += playlistBatchSize) {
      const batch = input.trackUris.slice(offset, offset + playlistBatchSize)
      try {
        const snapshot = await this.raw<PlaylistSnapshot>(
          'POST',
          `/playlists/${encodeURIComponent(playlist.id)}/items`,
          { body: { uris: batch } },
        )
        if (!snapshot?.snapshot_id) {
          throw new Error('Spotify added playlist items without returning a snapshot ID')
        }
        snapshotIds.push(snapshot.snapshot_id)
        tracksAdded += batch.length
      } catch (cause) {
        throw new SpotifyPlaylistCreationError({
          playlist,
          trackUris: input.trackUris,
          snapshotIds,
          tracksAdded,
          cause,
        })
      }
    }

    return { playlist, trackUris: input.trackUris, snapshotIds }
  }

  /** Read a Spotify playlist by ID, URI, or open.spotify.com URL. */
  async getPlaylist(
    reference: string,
    options: Pick<RawRequestOptions, 'signal'> = {},
  ): Promise<components['schemas']['PlaylistObject']> {
    const playlistId = normalizeSpotifyPlaylistReference(reference)
    const playlist = await this.raw<components['schemas']['PlaylistObject']>(
      'GET',
      `/playlists/${encodeURIComponent(playlistId)}`,
      options,
    )
    if (!playlist?.id) throw new Error('Spotify returned a playlist without its ID')
    return playlist
  }

  /** Update playlist details and optionally replace the complete ordered track list. */
  async updatePlaylist(
    reference: string,
    options: UpdateSpotifyPlaylistOptions,
  ): Promise<UpdateSpotifyPlaylistResult> {
    const playlistId = normalizeSpotifyPlaylistReference(reference)
    const input = validateUpdateSpotifyPlaylistOptions(options)
    const details = {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.public === undefined ? {} : { public: input.public }),
      ...(input.collaborative === undefined ? {} : { collaborative: input.collaborative }),
    }
    if (Object.keys(details).length > 0) {
      await this.raw('PUT', `/playlists/${encodeURIComponent(playlistId)}`, {
        body: details,
        ...(input.signal ? { signal: input.signal } : {}),
      })
    }

    const snapshotIds: string[] = []
    if (input.trackUris !== undefined) {
      const firstBatch = input.trackUris.slice(0, playlistBatchSize)
      const firstSnapshot = await this.raw<PlaylistSnapshot>(
        'PUT',
        `/playlists/${encodeURIComponent(playlistId)}/items`,
        {
          body: { uris: firstBatch },
          ...(input.signal ? { signal: input.signal } : {}),
        },
      )
      if (!firstSnapshot?.snapshot_id) {
        throw new Error('Spotify replaced playlist items without returning a snapshot ID')
      }
      snapshotIds.push(firstSnapshot.snapshot_id)

      for (
        let offset = playlistBatchSize;
        offset < input.trackUris.length;
        offset += playlistBatchSize
      ) {
        const snapshot = await this.raw<PlaylistSnapshot>(
          'POST',
          `/playlists/${encodeURIComponent(playlistId)}/items`,
          {
            body: { uris: input.trackUris.slice(offset, offset + playlistBatchSize) },
            ...(input.signal ? { signal: input.signal } : {}),
          },
        )
        if (!snapshot?.snapshot_id) {
          throw new Error('Spotify added playlist items without returning a snapshot ID')
        }
        snapshotIds.push(snapshot.snapshot_id)
      }
    }

    return {
      playlistId,
      ...(input.trackUris === undefined ? {} : { trackUris: input.trackUris }),
      snapshotIds,
    }
  }

  /**
   * Remove a playlist from the current user's library. Spotify exposes no
   * permanent playlist deletion; owned playlists use this same operation.
   */
  async deletePlaylist(
    reference: string,
    options: Pick<RawRequestOptions, 'signal'> = {},
  ): Promise<DeleteSpotifyPlaylistResult> {
    const playlistId = normalizeSpotifyPlaylistReference(reference)
    await this.raw('DELETE', '/me/library', {
      query: { uris: `spotify:playlist:${playlistId}` },
      ...options,
    })
    return { playlistId, removedFromLibrary: true, permanentlyDeleted: false }
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
      if (
        attempt >= retry.maxAttempts ||
        !isRetryableMethod(request.method) ||
        !isRetryable(response.status)
      )
        return response

      const retryAfter = parseRetryAfter(response.headers.get('retry-after'))
      const exponential = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1))
      const delay = retryAfter ?? Math.round(exponential * (0.5 + Math.random() * 0.5))
      await response.body?.cancel()
      await sleep(delay)
    }
  }
}

function validateCreatePlaylistWithTracksOptions(options: CreatePlaylistWithTracksOptions): {
  name: string
  trackUris: string[]
  public: boolean
  collaborative: boolean
  description?: string
} {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('Playlist options must be an object')
  }
  if (typeof options.name !== 'string' || options.name.trim().length === 0) {
    throw new TypeError('Playlist name must not be empty')
  }
  if (!Array.isArray(options.tracks) || options.tracks.length === 0) {
    throw new TypeError('At least one Spotify track URI, URL, or ID is required')
  }
  if (options.public !== undefined && typeof options.public !== 'boolean') {
    throw new TypeError('Playlist public must be a boolean')
  }
  if (options.collaborative !== undefined && typeof options.collaborative !== 'boolean') {
    throw new TypeError('Playlist collaborative must be a boolean')
  }
  if (options.description !== undefined && typeof options.description !== 'string') {
    throw new TypeError('Playlist description must be a string')
  }

  const isPublic = options.public ?? true
  const collaborative = options.collaborative ?? false
  if (collaborative && isPublic) {
    throw new TypeError('A collaborative Spotify playlist must be private (public: false)')
  }

  return {
    name: options.name,
    trackUris: options.tracks.map(normalizeSpotifyTrackReference),
    public: isPublic,
    collaborative,
    ...(options.description === undefined ? {} : { description: options.description }),
  }
}

function validateUpdateSpotifyPlaylistOptions(options: UpdateSpotifyPlaylistOptions): {
  name?: string
  description?: string
  public?: boolean
  collaborative?: boolean
  trackUris?: string[]
  signal?: AbortSignal
} {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('Playlist update options must be an object')
  }
  if (options.name !== undefined && options.name.trim().length === 0) {
    throw new TypeError('Playlist name must not be empty')
  }
  if (options.description !== undefined && typeof options.description !== 'string') {
    throw new TypeError('Playlist description must be a string')
  }
  if (options.public !== undefined && typeof options.public !== 'boolean') {
    throw new TypeError('Playlist public must be a boolean')
  }
  if (options.collaborative !== undefined && typeof options.collaborative !== 'boolean') {
    throw new TypeError('Playlist collaborative must be a boolean')
  }
  if (options.collaborative === true && options.public !== false) {
    throw new TypeError('Making a Spotify playlist collaborative requires public: false')
  }
  if (options.tracks !== undefined && !Array.isArray(options.tracks)) {
    throw new TypeError('Playlist tracks must be an array')
  }
  if (
    options.name === undefined &&
    options.description === undefined &&
    options.public === undefined &&
    options.collaborative === undefined &&
    options.tracks === undefined
  ) {
    throw new TypeError('At least one Spotify playlist update is required')
  }
  return {
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(options.public === undefined ? {} : { public: options.public }),
    ...(options.collaborative === undefined ? {} : { collaborative: options.collaborative }),
    ...(options.tracks === undefined
      ? {}
      : { trackUris: options.tracks.map(normalizeSpotifyTrackReference) }),
    ...(options.signal ? { signal: options.signal } : {}),
  }
}

function normalizeSpotifyTrackReference(value: string, index: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`Track ${index + 1} must be a Spotify track URI, URL, or ID`)
  }
  const reference = value.trim()
  if (spotifyIdPattern.test(reference)) return `spotify:track:${reference}`

  const uriMatch = /^spotify:track:([^:]+)$/.exec(reference)
  if (uriMatch) return spotifyTrackUri(uriMatch[1] ?? '', index)

  let url: URL
  try {
    url = new URL(reference)
  } catch {
    throw new TypeError(`Track ${index + 1} is not a valid Spotify track URI, URL, or ID`)
  }
  if (url.protocol !== 'https:' || url.hostname !== 'open.spotify.com') {
    throw new TypeError(`Track ${index + 1} is not an open.spotify.com track URL`)
  }
  const segments = url.pathname.split('/').filter(Boolean)
  const trackIndex = segments[0]?.startsWith('intl-') ? 1 : 0
  if (segments[trackIndex] !== 'track' || segments.length !== trackIndex + 2) {
    throw new TypeError(`Track ${index + 1} is not an open.spotify.com track URL`)
  }
  return spotifyTrackUri(segments[trackIndex + 1] ?? '', index)
}

function spotifyTrackUri(id: string, index: number): string {
  if (!spotifyIdPattern.test(id)) {
    throw new TypeError(`Track ${index + 1} has an invalid Spotify track ID`)
  }
  return `spotify:track:${id}`
}

function normalizeSpotifyPlaylistReference(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('Spotify playlist ID, URI, or URL is required')
  }
  const reference = value.trim()
  if (spotifyIdPattern.test(reference)) return reference

  const uriMatch = /^spotify:playlist:([^:]+)$/.exec(reference)
  if (uriMatch && spotifyIdPattern.test(uriMatch[1] ?? '')) return uriMatch[1] as string

  let url: URL
  try {
    url = new URL(reference)
  } catch {
    throw new TypeError('Invalid Spotify playlist ID, URI, or URL')
  }
  if (url.protocol !== 'https:' || url.hostname !== 'open.spotify.com') {
    throw new TypeError('Spotify playlist URL must use open.spotify.com')
  }
  const segments = url.pathname.split('/').filter(Boolean)
  const playlistIndex = segments[0]?.startsWith('intl-') ? 1 : 0
  const id = segments[playlistIndex + 1]
  if (
    segments[playlistIndex] !== 'playlist' ||
    segments.length !== playlistIndex + 2 ||
    !id ||
    !spotifyIdPattern.test(id)
  ) {
    throw new TypeError('Spotify playlist URL must identify a playlist')
  }
  return id
}

function isRetryableMethod(method: string): boolean {
  return ['GET', 'HEAD', 'OPTIONS', 'TRACE', 'PUT', 'DELETE'].includes(method.toUpperCase())
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
