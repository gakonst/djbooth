import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  ReferenceClient,
  type DownloadReferenceOptions,
  type InspectReferenceOptions,
} from './bridge/reference.js'
import { inspect, type EngineResult } from './core/engine.js'
import { errorMessage, nativeFallbackFor, type NativeFallback, YtdlpError } from './core/errors.js'
import { selectFormats } from './core/format-selector.js'
import type { EngineKind, MediaInfo } from './core/types.js'
import {
  downloadMedia,
  type NativeDownloadOptions,
  type NativeDownloadResult,
} from './downloader/native.js'

export const MUSIC_FORMAT_SPEC = 'bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio/best'
export const MUSIC_OUTPUT_TEMPLATE = '%(uploader,channel)s/%(title)s [%(id)s].%(ext)s'
export const DEFAULT_MUSIC_CONCURRENCY = 3
export const MAX_MUSIC_CONCURRENCY = 16
export const DEFAULT_YOUTUBE_CONCURRENCY = 1
export const MAX_YOUTUBE_CONCURRENCY = 4
export const DEFAULT_NATIVE_YOUTUBE_CONCURRENCY = 3
export const MAX_NATIVE_YOUTUBE_CONCURRENCY = 16

export interface MusicDownloadOptions extends InspectReferenceOptions {
  engine?: EngineKind
  paths?: string
  output?: string
  audioFormat?: 'best' | 'aac' | 'alac' | 'flac' | 'm4a' | 'mp3' | 'opus' | 'vorbis' | 'wav'
  audioQuality?: string
  archive?: string
  concurrency?: number
  youtubeConcurrency?: number
  nativeYoutubeConcurrency?: number
  retries?: number
  rateLimit?: string
  youtubeRateLimit?: string
  youtubeRequestInterval?: number
  youtubeMinSleep?: number
  youtubeMaxSleep?: number
  continueOnError?: boolean
  writeInfoJson?: boolean
  writeThumbnail?: boolean
  embedMetadata?: boolean
  embedThumbnail?: boolean
  signal?: AbortSignal
}

export interface MusicDownloadItem {
  url: string
  id?: string
  title?: string
  engine?: 'native' | 'reference'
  fallback?: NativeFallback
  status: 'downloaded' | 'skipped' | 'failed'
  files?: string[]
  error?: string
}

export interface MusicBatchResult {
  requested: number
  tracks: number
  downloaded: number
  skipped: number
  failed: number
  items: MusicDownloadItem[]
}

export interface MusicDependencies {
  inspect(
    url: string,
    engine: EngineKind,
    options: InspectReferenceOptions,
  ): Promise<EngineResult<MediaInfo>>
  downloadNative(info: MediaInfo, options: NativeDownloadOptions): Promise<NativeDownloadResult>
  downloadReference(
    url: string,
    options: DownloadReferenceOptions,
  ): Promise<{ files: string[]; stdout: string; stderr: string }>
}

const defaultDependencies: MusicDependencies = {
  inspect,
  downloadNative: downloadMedia,
  downloadReference: (url, options) => new ReferenceClient().download(url, options),
}

interface PreparedTrack {
  url: string
  info: MediaInfo
  extractionEngine: 'native' | 'reference'
  fallback?: NativeFallback
}

type PlannedItem =
  { kind: 'track'; track: PreparedTrack } | { kind: 'result'; item: MusicDownloadItem }

export async function downloadMusicBatch(
  sources: string[],
  options: MusicDownloadOptions = {},
  dependencies: MusicDependencies = defaultDependencies,
): Promise<MusicBatchResult> {
  const uniqueSources = [...new Set(sources.map((source) => source.trim()).filter(Boolean))]
  if (uniqueSources.length === 0)
    throw new YtdlpError('NO_MUSIC_URLS', 'At least one music URL is required')
  const controller = new AbortController()
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal
  const controlledOptions: MusicDownloadOptions = { ...options, signal }
  throwIfAborted(signal)
  const archive = await DownloadArchive.open(controlledOptions.archive)
  const concurrency = boundedConcurrency(
    controlledOptions.concurrency,
    DEFAULT_MUSIC_CONCURRENCY,
    MAX_MUSIC_CONCURRENCY,
  )
  const concurrentControl = { controller, signal }
  const plannedBySource = await mapConcurrent(
    uniqueSources,
    concurrency,
    async (source) => {
      throwIfAborted(signal)
      if (archive.has(makeUrlArchiveKey(source))) {
        return [
          {
            kind: 'result',
            item: { url: source, status: 'skipped', files: [] },
          },
        ] satisfies PlannedItem[]
      }
      try {
        const requestedEngine = controlledOptions.engine ?? 'auto'
        const optionGap = nativeInspectionCapabilityGap(controlledOptions)
        let inspectionEngine = requestedEngine
        let fallback: NativeFallback | undefined
        if (requestedEngine !== 'reference' && optionGap) {
          const nativeFallback = nativeFallbackFor(optionGap)
          if (requestedEngine === 'native' || !nativeFallback) throw optionGap
          inspectionEngine = 'reference'
          fallback = nativeFallback
        }
        const result = await dependencies.inspect(
          source,
          inspectionEngine,
          inspectOptions(controlledOptions),
        )
        throwIfAborted(signal)
        fallback ??= inspectionFallback(result, requestedEngine)
        if (result.data.entries?.length) {
          return result.data.entries.flatMap((entry): PlannedItem[] => {
            const entryUrl = mediaWebpageUrl(entry)
            return entryUrl
              ? [
                  {
                    kind: 'track',
                    track: {
                      url: entryUrl,
                      info: entry,
                      extractionEngine: result.engine,
                      ...(fallback ? { fallback } : undefined),
                    },
                  },
                ]
              : []
          })
        }
        return [
          {
            kind: 'track',
            track: {
              url: source,
              info: result.data,
              extractionEngine: result.engine,
              ...(fallback ? { fallback } : undefined),
            },
          },
        ] satisfies PlannedItem[]
      } catch (error) {
        if (signal.aborted || controlledOptions.continueOnError === false) throw error
        return [
          {
            kind: 'result',
            item: { url: source, status: 'failed', error: errorMessage(error) },
          },
        ] satisfies PlannedItem[]
      }
    },
    concurrentControl,
  )

  throwIfAborted(signal)
  const plan = deduplicatePlan(plannedBySource.flat())
  const queue = plan.flatMap((item) => (item.kind === 'track' ? [item.track] : []))
  const completed = new Map<PreparedTrack, MusicDownloadItem>()
  const youtubeSemaphore = new Semaphore(
    boundedConcurrency(
      controlledOptions.youtubeConcurrency,
      DEFAULT_YOUTUBE_CONCURRENCY,
      MAX_YOUTUBE_CONCURRENCY,
    ),
  )
  const nativeYoutubeSemaphore = new Semaphore(
    boundedConcurrency(
      controlledOptions.nativeYoutubeConcurrency,
      DEFAULT_NATIVE_YOUTUBE_CONCURRENCY,
      MAX_NATIVE_YOUTUBE_CONCURRENCY,
    ),
  )
  await mapConcurrent(
    queue,
    concurrency,
    async (track) => {
      throwIfAborted(signal)
      const release = isYouTube(track)
        ? await (
            track.extractionEngine === 'native' ? nativeYoutubeSemaphore : youtubeSemaphore
          ).acquire(signal)
        : () => undefined
      try {
        throwIfAborted(signal)
        completed.set(
          track,
          await downloadPreparedTrack(track, archive, controlledOptions, dependencies),
        )
      } catch (error) {
        if (signal.aborted || controlledOptions.continueOnError === false) throw error
        completed.set(track, {
          url: track.url,
          id: track.info.id,
          title: track.info.title,
          ...(track.extractionEngine === 'reference'
            ? { engine: 'reference' as const }
            : undefined),
          ...(track.fallback ? { fallback: track.fallback } : undefined),
          status: 'failed',
          error: errorMessage(error),
        })
      } finally {
        release()
      }
    },
    concurrentControl,
  )

  throwIfAborted(signal)
  const items = plan.map((item) => {
    if (item.kind === 'result') return item.item
    const completedItem = completed.get(item.track)
    if (!completedItem)
      throw new YtdlpError('MUSIC_BATCH_INCOMPLETE', `No result for ${item.track.url}`)
    return completedItem
  })

  return {
    requested: uniqueSources.length,
    tracks: queue.length,
    downloaded: items.filter((item) => item.status === 'downloaded').length,
    skipped: items.filter((item) => item.status === 'skipped').length,
    failed: items.filter((item) => item.status === 'failed').length,
    items,
  }
}

async function downloadPreparedTrack(
  track: PreparedTrack,
  archive: DownloadArchive,
  options: MusicDownloadOptions,
  dependencies: MusicDependencies,
): Promise<MusicDownloadItem> {
  throwIfAborted(options.signal)
  const archiveKey = makeArchiveKey(track.info)
  if (archiveKey && archive.has(archiveKey)) {
    await archive.add(makeUrlArchiveKey(track.url), options.signal)
    return {
      url: track.url,
      id: track.info.id,
      title: track.info.title,
      ...(track.fallback ? { fallback: track.fallback } : undefined),
      status: 'skipped',
      files: [],
    }
  }

  let current = track
  let fallback = track.fallback
  if (isYouTube(current) && current.extractionEngine === 'native') {
    try {
      current = await refreshNativeYoutube(current, options, dependencies)
    } catch (error) {
      const nativeFallback = nativeFallbackFor(error)
      if (options.engine === 'native' || !nativeFallback) throw error
      fallback = nativeFallback
      current = { ...current, extractionEngine: 'reference' }
    }
  }
  throwIfAborted(options.signal)
  const nativeCapabilityGap =
    options.engine !== 'reference' && current.extractionEngine === 'native'
      ? nativeMusicCapabilityGap(current.info, options)
      : undefined
  if (nativeCapabilityGap) {
    const nativeFallback = nativeFallbackFor(nativeCapabilityGap)
    if (options.engine === 'native' || !nativeFallback) throw nativeCapabilityGap
    fallback = nativeFallback
  }
  const useNative =
    options.engine !== 'reference' &&
    current.extractionEngine === 'native' &&
    nativeCapabilityGap === undefined
  let files: string[] | undefined
  let selectedEngine: 'native' | 'reference' | undefined
  if (useNative) {
    try {
      let result
      try {
        result = await dependencies.downloadNative(
          current.info,
          nativeMusicOptions(current, options),
        )
      } catch (error) {
        if (!isYouTube(current) || !isForbiddenMediaError(error)) throw error
        current = await refreshNativeYoutube(current, options, dependencies)
        result = await dependencies.downloadNative(
          current.info,
          nativeMusicOptions(current, options),
        )
      }
      throwIfAborted(options.signal)
      files = result.files
      selectedEngine = 'native'
    } catch (error) {
      const nativeFallback = nativeFallbackFor(error)
      if (options.engine === 'native' || !nativeFallback) throw error
      fallback = nativeFallback
    }
  }
  if (!files) {
    if (options.engine === 'native') {
      throw new YtdlpError(
        'NATIVE_MUSIC_UNAVAILABLE',
        'This track requires behavior unavailable in the TypeScript-native engine',
      )
    }
    if (options.engine !== 'reference' && !fallback) {
      throw new YtdlpError(
        'NATIVE_FALLBACK_PROVENANCE_MISSING',
        'Auto mode refused reference execution without a typed native capability fallback',
      )
    }
    const youtube = isYouTube(current)
    const audioFormat = options.audioFormat ?? 'best'
    try {
      const result = await dependencies.downloadReference(
        current.url,
        omitUndefined({
          ...inspectOptions(options),
          playlist: false,
          format: MUSIC_FORMAT_SPEC,
          output: options.output ?? MUSIC_OUTPUT_TEMPLATE,
          paths: options.paths,
          continueDownload: true,
          concurrentFragments: youtube ? 1 : undefined,
          retries: options.retries ?? 10,
          fragmentRetries: options.retries ?? 10,
          rateLimit: youtube ? (options.youtubeRateLimit ?? options.rateLimit) : options.rateLimit,
          extractAudio: true,
          audioFormat,
          audioQuality: options.audioQuality ?? '0',
          writeInfoJson: options.writeInfoJson ?? true,
          writeThumbnail: options.writeThumbnail ?? true,
          embedMetadata: options.embedMetadata ?? true,
          embedThumbnail: options.embedThumbnail ?? true,
          embedChapters: true,
          sleepRequests: youtube ? (options.youtubeRequestInterval ?? 1) : undefined,
          sleepInterval: youtube ? (options.youtubeMinSleep ?? 2) : undefined,
          maxSleepInterval: youtube ? (options.youtubeMaxSleep ?? 5) : undefined,
          throttledRate: youtube ? '100K' : undefined,
          retrySleep: ['http:exp=1:20', 'fragment:exp=1:20', 'extractor:exp=1:20'],
        }) as DownloadReferenceOptions,
      )
      throwIfAborted(options.signal)
      files = result.files
    } catch (error) {
      if (options.signal?.aborted || options.continueOnError === false) throw error
      return {
        url: current.url,
        id: current.info.id,
        title: current.info.title,
        engine: 'reference',
        ...(fallback ? { fallback } : undefined),
        status: 'failed',
        error: errorMessage(error),
      }
    }
    selectedEngine = 'reference'
  }

  throwIfAborted(options.signal)
  await archive.addAll(
    [archiveKey, makeUrlArchiveKey(current.url)].filter(
      (value): value is string => value !== undefined,
    ),
    options.signal,
  )
  return {
    url: current.url,
    id: current.info.id,
    title: current.info.title,
    ...(selectedEngine ? { engine: selectedEngine } : undefined),
    ...(fallback ? { fallback } : undefined),
    status: 'downloaded',
    files,
  }
}

function nativeMusicOptions(
  track: PreparedTrack,
  options: MusicDownloadOptions,
): NativeDownloadOptions {
  return omitUndefined({
    format: MUSIC_FORMAT_SPEC,
    output: options.output ?? MUSIC_OUTPUT_TEMPLATE,
    paths: options.paths,
    continueDownload: true,
    retries: options.retries ?? 5,
    rateLimit: isYouTube(track)
      ? (options.youtubeRateLimit ?? options.rateLimit)
      : options.rateLimit,
    writeInfoJson: options.writeInfoJson ?? true,
    writeThumbnail: options.writeThumbnail ?? true,
    signal: options.signal,
  }) as NativeDownloadOptions
}

async function refreshNativeYoutube(
  track: PreparedTrack,
  options: MusicDownloadOptions,
  dependencies: MusicDependencies,
): Promise<PreparedTrack> {
  const refreshed = await dependencies.inspect(track.url, 'native', {
    ...inspectOptions(options),
    playlist: false,
  })
  if (refreshed.engine !== 'native' || refreshed.data.id !== track.info.id) {
    throw new YtdlpError(
      'YOUTUBE_IDENTITY_MISMATCH',
      `Fresh native inspection returned '${refreshed.data.id}' for '${track.info.id}'`,
    )
  }
  return { ...track, info: refreshed.data, extractionEngine: 'native' }
}

function isForbiddenMediaError(error: unknown): boolean {
  return error instanceof YtdlpError && error.code === 'HTTP_ERROR' && error.details?.status === 403
}

function inspectOptions(options: MusicDownloadOptions): InspectReferenceOptions {
  return omitUndefined({
    signal: options.signal,
    playlist: options.playlist,
    flatPlaylist: options.flatPlaylist,
    cookies: options.cookies,
    cookiesFromBrowser: options.cookiesFromBrowser,
    username: options.username,
    password: options.password,
    videoPassword: options.videoPassword,
    proxy: options.proxy,
    geoBypassCountry: options.geoBypassCountry,
    impersonate: options.impersonate,
    extractorArgs: options.extractorArgs,
    noCheckCertificates: options.noCheckCertificates,
    socketTimeout: options.socketTimeout,
  }) as InspectReferenceOptions
}

function mediaWebpageUrl(info: MediaInfo): string | undefined {
  for (const value of [info.webpage_url, info.original_url, info.url]) {
    if (typeof value !== 'string') continue
    try {
      const url = new URL(value)
      if (['http:', 'https:'].includes(url.protocol)) return url.href
    } catch {
      // Playlist entries may contain extractor IDs rather than URLs.
    }
  }
  return undefined
}

function deduplicatePlan(items: PlannedItem[]): PlannedItem[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (item.kind === 'result') return true
    const key = makeArchiveKey(item.track.info) ?? item.track.url
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function boundedConcurrency(
  value: number | undefined,
  defaultValue: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return defaultValue
  return Math.min(maximum, Math.max(1, Math.trunc(value)))
}

async function mapConcurrent<Input, Output>(
  values: Input[],
  concurrency: number,
  operation: (value: Input, index: number) => Promise<Output>,
  control: { controller: AbortController; signal: AbortSignal },
): Promise<Output[]> {
  const output = new Array<Output>(values.length)
  let cursor = 0
  const noFailure = Symbol('no-failure')
  let firstFailure: unknown | typeof noFailure = noFailure
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(values.length, 1)) },
    async () => {
      while (!control.signal.aborted && cursor < values.length) {
        const index = cursor++
        try {
          output[index] = await operation(values[index]!, index)
        } catch (error) {
          if (firstFailure === noFailure) {
            firstFailure = error
            control.controller.abort(error)
          }
          return
        }
      }
    },
  )
  await Promise.allSettled(workers)
  if (firstFailure !== noFailure) throw firstFailure
  throwIfAborted(control.signal)
  return output
}

function makeArchiveKey(info: MediaInfo): string | undefined {
  if (!info.id) return undefined
  const extractor = String(info.extractor_key ?? info.extractor ?? 'generic')
    .replace(/IE$/u, '')
    .toLowerCase()
  return `${extractor} ${info.id}`
}

function makeUrlArchiveKey(value: string): string {
  let normalized = value.trim()
  try {
    const url = new URL(normalized)
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith('utm_') || ['si', 'feature', 't'].includes(key))
        url.searchParams.delete(key)
    }
    normalized = url.href
  } catch {
    // Non-URL extractor inputs still receive a stable fingerprint.
  }
  return `url ${createHash('sha256').update(normalized).digest('hex')}`
}

function isYouTube(track: PreparedTrack): boolean {
  return (
    /youtube/iu.test(String(track.info.extractor_key ?? track.info.extractor ?? '')) ||
    /(?:youtube\.com|youtu\.be)/iu.test(track.url)
  )
}

function isSoundCloud(track: PreparedTrack): boolean {
  return (
    /soundcloud/iu.test(String(track.info.extractor_key ?? track.info.extractor ?? '')) ||
    /soundcloud\.com/iu.test(track.url)
  )
}

function nativeMusicCapabilityGap(
  info: MediaInfo,
  options: MusicDownloadOptions,
): YtdlpError | undefined {
  if ((options.audioFormat ?? 'best') !== 'best') {
    return new YtdlpError(
      'NATIVE_OPTION_UNAVAILABLE',
      `Native music downloads do not yet support --audio-format ${options.audioFormat}`,
      { option: 'audioFormat', value: options.audioFormat },
    )
  }
  try {
    const selected = selectFormats(info.formats ?? [], MUSIC_FORMAT_SPEC)
    if (
      selected.some(
        (format) =>
          format.protocol?.startsWith('m3u8') ||
          format.protocol === 'dash' ||
          /\.(?:m3u8|mpd)(?:$|\?)/iu.test(format.url),
      )
    ) {
      return new YtdlpError(
        'RANGE_NOT_SUPPORTED',
        'The selected audio requires fragment-aware transfer unavailable in the native music downloader',
      )
    }
    return undefined
  } catch (error) {
    if (nativeFallbackFor(error)) return error as YtdlpError
    throw error
  }
}

const NATIVE_UNSUPPORTED_INSPECTION_OPTIONS = [
  'cookies',
  'cookiesFromBrowser',
  'username',
  'password',
  'videoPassword',
  'proxy',
  'geoBypassCountry',
  'impersonate',
  'extractorArgs',
  'noCheckCertificates',
  'socketTimeout',
] as const satisfies readonly (keyof InspectReferenceOptions)[]

function nativeInspectionCapabilityGap(options: MusicDownloadOptions): YtdlpError | undefined {
  const option = NATIVE_UNSUPPORTED_INSPECTION_OPTIONS.find((key) => {
    const value = options[key]
    if (Array.isArray(value)) return value.length > 0
    return value !== undefined && value !== false
  })
  return option
    ? new YtdlpError(
        'NATIVE_OPTION_UNAVAILABLE',
        `Native music inspection does not yet support --${option.replace(/[A-Z]/gu, (value) => `-${value.toLowerCase()}`)}`,
        { option },
      )
    : undefined
}

function inspectionFallback(
  result: EngineResult<MediaInfo>,
  requestedEngine: EngineKind,
): NativeFallback | undefined {
  if (result.engine === 'native' || requestedEngine === 'reference') return undefined
  if (!result.fallback) {
    throw new YtdlpError(
      'NATIVE_FALLBACK_PROVENANCE_MISSING',
      'Auto inspection returned a reference result without typed native fallback provenance',
    )
  }
  const fallback = nativeFallbackFor(
    new YtdlpError(result.fallback.code, 'Revalidate inspection fallback provenance'),
  )
  if (!fallback) {
    throw new YtdlpError(
      'NATIVE_FALLBACK_PROVENANCE_INVALID',
      `Auto inspection returned an unsupported native fallback code: ${result.fallback.code}`,
    )
  }
  return fallback
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new YtdlpError('ABORTED', 'Music batch was aborted')
}

class DownloadArchive {
  private readonly values = new Set<string>()
  private appendChain = Promise.resolve()

  private constructor(private readonly path?: string) {}

  static async open(path?: string): Promise<DownloadArchive> {
    const archive = new DownloadArchive(path)
    if (!path) return archive
    try {
      const content = await readFile(path, 'utf8')
      for (const line of content.split(/\r?\n/u)) if (line.trim()) archive.values.add(line.trim())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return archive
  }

  has(value: string): boolean {
    return this.values.has(value)
  }

  async add(value: string, signal?: AbortSignal): Promise<void> {
    await this.addAll([value], signal)
  }

  async addAll(values: readonly string[], signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    const additions = [...new Set(values)].filter((value) => !this.values.has(value))
    if (additions.length === 0) return
    for (const value of additions) this.values.add(value)
    if (!this.path) return
    this.appendChain = this.appendChain.then(async () => {
      throwIfAborted(signal)
      await mkdir(dirname(this.path!), { recursive: true })
      throwIfAborted(signal)
      await appendFile(this.path!, `${additions.join('\n')}\n`, 'utf8')
    })
    await this.appendChain
  }
}

class Semaphore {
  private active = 0
  private readonly waiters: Array<{
    resolve(): void
    reject(error: unknown): void
    signal?: AbortSignal
    abort?: () => void
  }> = []

  constructor(private readonly limit: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    throwIfAborted(signal)
    if (this.active < this.limit) {
      this.active += 1
    } else {
      await new Promise<void>((resolve, reject) => {
        const waiter: (typeof this.waiters)[number] = {
          resolve,
          reject,
          ...(signal ? { signal } : undefined),
        }
        const abort = () => {
          const index = this.waiters.indexOf(waiter)
          if (index < 0) return
          this.waiters.splice(index, 1)
          signal?.removeEventListener('abort', abort)
          reject(new YtdlpError('ABORTED', 'Music batch was aborted'))
        }
        waiter.abort = abort
        this.waiters.push(waiter)
        signal?.addEventListener('abort', abort, { once: true })
      })
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiters.shift()
      if (next) {
        next.signal?.removeEventListener('abort', next.abort!)
        next.resolve()
      } else {
        this.active -= 1
      }
    }
  }
}

function omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}
