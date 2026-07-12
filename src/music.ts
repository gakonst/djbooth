import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  ReferenceClient,
  type DownloadReferenceOptions,
  type InspectReferenceOptions,
} from './bridge/reference.js'
import { inspect, type EngineResult } from './core/engine.js'
import { errorMessage, YtdlpError } from './core/errors.js'
import { selectFormats } from './core/format-selector.js'
import type { EngineKind, MediaInfo } from './core/types.js'
import {
  downloadMedia,
  type NativeDownloadOptions,
  type NativeDownloadResult,
} from './downloader/native.js'

export const MUSIC_FORMAT_SPEC = 'bestaudio/best'
export const MUSIC_OUTPUT_TEMPLATE = '%(uploader,channel)s/%(title)s [%(id)s].%(ext)s'

export interface MusicDownloadOptions extends InspectReferenceOptions {
  engine?: EngineKind
  paths?: string
  output?: string
  audioFormat?: 'best' | 'aac' | 'alac' | 'flac' | 'm4a' | 'mp3' | 'opus' | 'vorbis' | 'wav'
  audioQuality?: string
  archive?: string
  concurrency?: number
  youtubeConcurrency?: number
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
}

export async function downloadMusicBatch(
  sources: string[],
  options: MusicDownloadOptions = {},
  dependencies: MusicDependencies = defaultDependencies,
): Promise<MusicBatchResult> {
  const uniqueSources = [...new Set(sources.map((source) => source.trim()).filter(Boolean))]
  if (uniqueSources.length === 0) throw new YtdlpError('NO_MUSIC_URLS', 'At least one music URL is required')
  const archive = await DownloadArchive.open(options.archive)
  const items: MusicDownloadItem[] = []
  const prepared: PreparedTrack[] = []

  for (const source of uniqueSources) {
    if (archive.has(makeUrlArchiveKey(source))) {
      items.push({ url: source, status: 'skipped', files: [] })
      continue
    }
    try {
      const result = await dependencies.inspect(source, options.engine ?? 'auto', inspectOptions(options))
      if (result.data.entries?.length) {
        for (const entry of result.data.entries) {
          const entryUrl = mediaWebpageUrl(entry)
          if (!entryUrl) continue
          prepared.push({ url: entryUrl, info: entry, extractionEngine: result.engine })
        }
      } else {
        prepared.push({ url: source, info: result.data, extractionEngine: result.engine })
      }
    } catch (error) {
      items.push({ url: source, status: 'failed', error: errorMessage(error) })
      if (options.continueOnError === false) throw error
    }
  }

  const queue = deduplicatePrepared(prepared)
  let cursor = 0
  const youtubeSemaphore = new Semaphore(Math.max(1, options.youtubeConcurrency ?? 1))
  const workers = Array.from(
    { length: Math.min(Math.max(1, options.concurrency ?? 3), Math.max(queue.length, 1)) },
    async () => {
      while (cursor < queue.length) {
        const track = queue[cursor++]!
        const release = isYouTube(track) ? await youtubeSemaphore.acquire() : () => undefined
        try {
          items.push(await downloadPreparedTrack(track, archive, options, dependencies))
        } catch (error) {
          items.push({
            url: track.url,
            id: track.info.id,
            title: track.info.title,
            status: 'failed',
            error: errorMessage(error),
          })
          if (options.continueOnError === false) throw error
        } finally {
          release()
        }
      }
    },
  )
  await Promise.all(workers)

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
  const archiveKey = makeArchiveKey(track.info)
  if (archiveKey && archive.has(archiveKey)) {
    await archive.add(makeUrlArchiveKey(track.url))
    return {
      url: track.url,
      id: track.info.id,
      title: track.info.title,
      status: 'skipped',
      files: [],
    }
  }

  const useNative =
    options.engine !== 'reference' &&
    track.extractionEngine === 'native' &&
    isSoundCloud(track) &&
    hasNativelyResumableBestAudio(track.info) &&
    (options.audioFormat ?? 'best') === 'best'
  let files: string[]
  let selectedEngine: 'native' | 'reference'
  if (useNative) {
    const result = await dependencies.downloadNative(track.info, omitUndefined({
      format: MUSIC_FORMAT_SPEC,
      output: options.output ?? MUSIC_OUTPUT_TEMPLATE,
      paths: options.paths,
      continueDownload: true,
      retries: options.retries ?? 5,
      rateLimit: options.rateLimit,
      writeInfoJson: options.writeInfoJson ?? true,
      writeThumbnail: options.writeThumbnail ?? true,
      signal: options.signal,
    }) as NativeDownloadOptions)
    files = result.files
    selectedEngine = 'native'
  } else {
    if (options.engine === 'native') {
      throw new YtdlpError(
        'NATIVE_MUSIC_UNAVAILABLE',
        'This track requires the reference engine for highest-quality music download',
      )
    }
    const youtube = isYouTube(track)
    const audioFormat = options.audioFormat ?? 'best'
    const result = await dependencies.downloadReference(track.url, omitUndefined({
      ...inspectOptions(options),
      playlist: false,
      format: MUSIC_FORMAT_SPEC,
      output: options.output ?? MUSIC_OUTPUT_TEMPLATE,
      paths: options.paths,
      continueDownload: true,
      concurrentFragments: youtube ? 1 : undefined,
      retries: options.retries ?? 10,
      fragmentRetries: options.retries ?? 10,
      rateLimit: youtube ? options.youtubeRateLimit ?? options.rateLimit : options.rateLimit,
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
    }) as DownloadReferenceOptions)
    files = result.files
    selectedEngine = 'reference'
  }

  if (archiveKey) await archive.add(archiveKey)
  await archive.add(makeUrlArchiveKey(track.url))
  return {
    url: track.url,
    id: track.info.id,
    title: track.info.title,
    engine: selectedEngine,
    status: 'downloaded',
    files,
  }
}

function inspectOptions(options: MusicDownloadOptions): InspectReferenceOptions {
  return omitUndefined({
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

function deduplicatePrepared(tracks: PreparedTrack[]): PreparedTrack[] {
  const seen = new Set<string>()
  return tracks.filter((track) => {
    const key = makeArchiveKey(track.info) ?? track.url
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
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
      if (key.startsWith('utm_') || ['si', 'feature', 't'].includes(key)) url.searchParams.delete(key)
    }
    normalized = url.href
  } catch {
    // Non-URL extractor inputs still receive a stable fingerprint.
  }
  return `url ${createHash('sha256').update(normalized).digest('hex')}`
}

function isYouTube(track: PreparedTrack): boolean {
  return /youtube/iu.test(String(track.info.extractor_key ?? track.info.extractor ?? '')) ||
    /(?:youtube\.com|youtu\.be)/iu.test(track.url)
}

function isSoundCloud(track: PreparedTrack): boolean {
  return /soundcloud/iu.test(String(track.info.extractor_key ?? track.info.extractor ?? '')) ||
    /soundcloud\.com/iu.test(track.url)
}

function hasNativelyResumableBestAudio(info: MediaInfo): boolean {
  try {
    return selectFormats(info.formats ?? [], MUSIC_FORMAT_SPEC).every(
      (format) =>
        !format.protocol?.startsWith('m3u8') &&
        format.protocol !== 'dash' &&
        !/\.(?:m3u8|mpd)(?:$|\?)/iu.test(format.url),
    )
  } catch {
    return false
  }
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

  async add(value: string): Promise<void> {
    if (this.values.has(value)) return
    this.values.add(value)
    if (!this.path) return
    this.appendChain = this.appendChain.then(async () => {
      await mkdir(dirname(this.path!), { recursive: true })
      await appendFile(this.path!, `${value}\n`, 'utf8')
    })
    await this.appendChain
  }
}

class Semaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve))
    this.active += 1
    return () => {
      this.active -= 1
      this.waiters.shift()?.()
    }
  }
}

function omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}
