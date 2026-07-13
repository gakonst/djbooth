import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'

import { YtdlpError } from '../core/errors.js'
import { selectFormats } from '../core/format-selector.js'
import { request } from '../core/network.js'
import { DEFAULT_OUTPUT_TEMPLATE, renderOutputTemplate } from '../core/template.js'
import type { Format, MediaInfo, ProgressEvent, Subtitle, Thumbnail } from '../core/types.js'
import { extensionFromUrl } from '../core/utils.js'

export interface NativeDownloadOptions {
  format?: string
  output?: string
  paths?: string
  noOverwrites?: boolean
  continueDownload?: boolean
  retries?: number
  rateLimit?: string
  mergeOutputFormat?: string
  extractAudio?: boolean
  audioFormat?: string
  writeSubtitles?: boolean
  writeAutoSubtitles?: boolean
  subtitleLanguages?: string[]
  subtitleFormat?: string
  writeThumbnail?: boolean
  writeInfoJson?: boolean
  onProgress?: (event: ProgressEvent) => void
  signal?: AbortSignal
}

export interface NativeDownloadResult {
  files: string[]
  selectedFormats: string[]
}

export async function downloadMedia(
  info: MediaInfo,
  options: NativeDownloadOptions = {},
): Promise<NativeDownloadResult> {
  const selected = selectFormats(info.formats ?? [], options.format)
  const mediaKey = `${info.extractor_key ?? info.extractor ?? 'unknown'}:${info.id}`
  const extension = outputExtension(selected, options)
  const relativeName = renderOutputTemplate(
    options.output ?? DEFAULT_OUTPUT_TEMPLATE,
    info,
    extension,
  )
  const outputPath = resolve(options.paths ?? '.', relativeName)
  await mkdir(dirname(outputPath), { recursive: true })

  return withOutputLock(outputPath, async () => {
    if (options.noOverwrites && (await exists(outputPath))) {
      return { files: [outputPath], selectedFormats: selected.map((format) => format.format_id) }
    }

    if (selected.length === 1) {
      await downloadFormat(selected[0]!, outputPath, options, mediaKey)
    } else {
      const temporary: string[] = []
      try {
        for (let index = 0; index < selected.length; index += 1) {
          const format = selected[index]!
          const path = join(
            dirname(outputPath),
            `.${info.id}.f${format.format_id}.${format.ext ?? 'media'}`,
          )
          temporary.push(path)
          await downloadFormat(format, path, options, mediaKey)
        }
        options.onProgress?.({
          status: 'postprocessing',
          filename: outputPath,
          operation: 'merge',
        })
        await ffmpeg(
          ['-y', ...temporary.flatMap((path) => ['-i', path]), '-c', 'copy', outputPath],
          options.signal,
        )
      } finally {
        await Promise.all(temporary.map((path) => rm(path, { force: true })))
      }
    }

    let finalPath = outputPath
    if (options.extractAudio) {
      const audioExtension = options.audioFormat ?? 'm4a'
      const audioPath = outputPath.replace(
        new RegExp(`${escapeRegex(extname(outputPath))}$`, 'u'),
        `.${audioExtension}`,
      )
      options.onProgress?.({
        status: 'postprocessing',
        filename: outputPath,
        operation: 'extract-audio',
      })
      await ffmpeg(
        ['-y', '-i', outputPath, '-vn', audioCodecArgs(audioExtension), audioPath].flat(),
        options.signal,
      )
      await rm(outputPath, { force: true })
      finalPath = audioPath
    }

    const files = [finalPath]
    const sidecarBase = withoutExtension(finalPath)
    if (options.writeInfoJson) {
      const path = `${sidecarBase}.info.json`
      await writeFile(
        path,
        `${JSON.stringify(sanitizeMediaInfoForOutput(info), null, 2)}\n`,
        'utf8',
      )
      files.push(path)
    }
    if (options.writeThumbnail && info.thumbnails?.length) {
      const thumbnail = selectThumbnail(info.thumbnails)
      const extension = extensionFromUrl(thumbnail.url) ?? 'jpg'
      const path = `${sidecarBase}.${extension}`
      await downloadHttp(
        { format_id: 'thumbnail', url: thumbnail.url, ext: extension },
        path,
        options,
      )
      files.push(path)
    }
    if (options.writeSubtitles) {
      files.push(...(await writeSubtitleSidecars(info.subtitles ?? {}, sidecarBase, options)))
    }
    if (options.writeAutoSubtitles) {
      files.push(
        ...(await writeSubtitleSidecars(info.automatic_captions ?? {}, sidecarBase, options)),
      )
    }

    return { files, selectedFormats: selected.map((format) => format.format_id) }
  })
}

/** Signed media URLs are short-lived capabilities and must not enter sidecars or CLI output. */
export function sanitizeMediaInfoForOutput(info: MediaInfo): MediaInfo {
  return sanitizeOutputValue(info) as MediaInfo
}

function sanitizeOutputValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeOutputValue)
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' && isTransientMediaUrl(value)
      ? '[redacted-transient-media-url]'
      : value
  }
  const record = value as Record<string, unknown>
  const transient = typeof record.url === 'string' && isTransientMediaUrl(record.url)
  return Object.fromEntries(
    Object.entries(record).flatMap(([key, item]) => {
      if (transient && key === 'http_headers') return []
      return [[key, sanitizeOutputValue(item)]]
    }),
  )
}

function isTransientMediaUrl(value: string | undefined): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    if (/(^|\.)googlevideo\.com$/iu.test(url.hostname)) return true
    const keys = new Set([...url.searchParams.keys()].map((key) => key.toLowerCase()))
    return (
      keys.has('sig') ||
      keys.has('signature') ||
      keys.has('lsig') ||
      keys.has('pot') ||
      keys.has('po_token') ||
      keys.has('token') ||
      (keys.has('expire') && keys.has('key'))
    )
  } catch {
    return false
  }
}

export function supportsNativeDownloadOptions(options: Record<string, unknown>): boolean {
  const unsupported = [
    'embedSubtitles',
    'embedThumbnail',
    'embedMetadata',
    'embedChapters',
    'sponsorblockRemove',
    'remuxVideo',
    'audioQuality',
    'concurrentFragments',
    'fragmentRetries',
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
  ]
  return unsupported.every((key) => options[key] === undefined || options[key] === false)
}

async function writeSubtitleSidecars(
  subtitles: Record<string, Subtitle[]>,
  basePath: string,
  options: NativeDownloadOptions,
): Promise<string[]> {
  const files: string[] = []
  for (const [language, entries] of Object.entries(subtitles)) {
    if (!languageSelected(language, options.subtitleLanguages)) continue
    const subtitle = selectSubtitle(entries, options.subtitleFormat)
    if (!subtitle) continue
    const extension = subtitle.ext ?? extensionFromUrl(subtitle.url) ?? 'vtt'
    const path = `${basePath}.${language}.${extension}`
    if (subtitle.data !== undefined) {
      await writeFile(path, subtitle.data, 'utf8')
    } else {
      await downloadHttp(
        { format_id: `subtitle-${language}`, url: subtitle.url, ext: extension },
        path,
        options,
      )
    }
    files.push(path)
  }
  return files
}

function languageSelected(language: string, expressions: string[] | undefined): boolean {
  if (!expressions?.length) return language === 'en' || language.startsWith('en-')
  let selected = false
  for (const expressionList of expressions) {
    for (const rawExpression of expressionList.split(',')) {
      const expression = rawExpression.trim()
      if (!expression) continue
      const exclude = expression.startsWith('-')
      const pattern = exclude ? expression.slice(1) : expression
      const matches = pattern === 'all' || wildcardRegex(pattern).test(language)
      if (matches) selected = !exclude
    }
  }
  return selected
}

function selectSubtitle(entries: Subtitle[], preference: string | undefined): Subtitle | undefined {
  if (!preference) return entries[0]
  for (const extension of preference.split('/')) {
    const match = entries.find((entry) => entry.ext === extension || extension === 'best')
    if (match) return match
  }
  return entries[0]
}

function selectThumbnail(thumbnails: Thumbnail[]): Thumbnail {
  return [...thumbnails]
    .sort((left, right) => {
      const preference = (left.preference ?? -1) - (right.preference ?? -1)
      if (preference !== 0) return preference
      return (left.width ?? 0) * (left.height ?? 0) - (right.width ?? 0) * (right.height ?? 0)
    })
    .at(-1)!
}

function wildcardRegex(value: string): RegExp {
  return new RegExp(`^${value.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '.*')}$`, 'u')
}

function withoutExtension(path: string): string {
  const extension = extname(path)
  return extension ? path.slice(0, -extension.length) : path
}

async function downloadFormat(
  format: Format,
  outputPath: string,
  options: NativeDownloadOptions,
  mediaKey: string,
): Promise<void> {
  if (
    format.protocol?.startsWith('m3u8') ||
    format.protocol === 'dash' ||
    /\.(?:m3u8|mpd)(?:$|\?)/iu.test(format.url)
  ) {
    const partPath = `${outputPath}.part${extname(outputPath) || '.mp4'}`
    options.onProgress?.({
      status: 'postprocessing',
      filename: outputPath,
      operation: 'hls-download',
    })
    await ffmpeg(['-y', '-i', format.url, '-c', 'copy', partPath], options.signal)
    await rename(partPath, outputPath)
    return
  }
  await downloadHttp(format, outputPath, options, mediaKey)
}

async function downloadHttp(
  format: Format,
  outputPath: string,
  options: NativeDownloadOptions,
  mediaKey = `asset:${format.format_id}`,
): Promise<void> {
  const retries = options.retries ?? 3
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await downloadHttpAttempt(format, outputPath, options, mediaKey)
      return
    } catch (error) {
      lastError = error
      if (options.signal?.aborted || isExpiredCapabilityError(error) || attempt === retries) break
      await abortableDelay(Math.min(500 * 2 ** attempt, 10_000), options.signal)
    }
  }
  throw lastError
}

async function downloadHttpAttempt(
  format: Format,
  outputPath: string,
  options: NativeDownloadOptions,
  mediaKey: string,
): Promise<void> {
  const partPath = `${outputPath}.part`
  const expectedBytes = format.filesize
  const receiptPath = `${partPath}.ytdlp-ts.json`
  const binding: PartReceipt = {
    version: 1,
    mediaKey,
    formatId: format.format_id,
    expectedBytes: expectedBytes ?? null,
    contentIdentity: typeof format.content_identity === 'string' ? format.content_identity : null,
  }
  let resumeBytes = await preparePartFile(
    partPath,
    receiptPath,
    binding,
    options.continueDownload !== false,
  )
  if (expectedBytes !== undefined && resumeBytes === expectedBytes) {
    await rename(partPath, outputPath)
    await rm(receiptPath, { force: true })
    options.onProgress?.({ status: 'finished', filename: outputPath, totalBytes: expectedBytes })
    return
  }
  if (expectedBytes !== undefined && resumeBytes > expectedBytes) {
    await rm(partPath, { force: true })
    resumeBytes = 0
  }
  const chunkBytes = httpChunkBytes(format)
  if (expectedBytes !== undefined && chunkBytes !== undefined) {
    await downloadHttpChunks(
      format,
      partPath,
      outputPath,
      resumeBytes,
      expectedBytes,
      chunkBytes,
      options,
    )
    await rm(receiptPath, { force: true })
    return
  }
  const headers: Record<string, string> = { Accept: '*/*', 'Accept-Encoding': 'identity' }
  if (resumeBytes > 0) headers.Range = `bytes=${resumeBytes}-`
  const response = await request(format.url, {
    headers: { ...format.http_headers, ...headers },
    retries: 0,
    ...(options.signal ? { signal: options.signal } : undefined),
    timeoutMs: 30_000,
  })
  const canResume = resumeBytes > 0 && response.status === 206
  const startingBytes = canResume ? resumeBytes : 0
  const contentBytes = numberHeader(response.headers, 'content-length')
  const totalBytes = contentBytes === undefined ? undefined : startingBytes + contentBytes
  const handle = await open(partPath, canResume ? 'a' : 'w')
  let downloadedBytes = startingBytes
  const startedAt = Date.now()
  const rateLimit = parseRate(options.rateLimit)

  try {
    const reader = response.body?.getReader()
    if (!reader) {
      throw new YtdlpError('EMPTY_RESPONSE', `No response body for format ${format.format_id}`)
    }
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      await writeAll(handle, value)
      downloadedBytes += value.byteLength
      const elapsedSeconds = Math.max((Date.now() - startedAt) / 1_000, 0.001)
      const speed = (downloadedBytes - startingBytes) / elapsedSeconds
      const remaining = totalBytes === undefined ? undefined : totalBytes - downloadedBytes
      options.onProgress?.({
        status: 'downloading',
        filename: outputPath,
        downloadedBytes,
        ...(totalBytes !== undefined ? { totalBytes } : undefined),
        speed,
        ...(remaining !== undefined && speed > 0 ? { eta: remaining / speed } : undefined),
      })
      if (rateLimit !== undefined && speed > rateLimit) {
        const targetElapsed = (downloadedBytes - startingBytes) / rateLimit
        const delay = targetElapsed - elapsedSeconds
        if (delay > 0) await abortableDelay(delay * 1_000, options.signal)
      }
    }
  } finally {
    await handle.close()
  }
  if (totalBytes !== undefined && downloadedBytes < totalBytes) {
    throw new YtdlpError(
      'CONTENT_TOO_SHORT',
      `Downloaded ${downloadedBytes} of ${totalBytes} bytes`,
    )
  }
  await rename(partPath, outputPath)
  await rm(receiptPath, { force: true })
  options.onProgress?.({ status: 'finished', filename: outputPath, totalBytes: downloadedBytes })
}

type PartReceipt = {
  version: 1
  mediaKey: string
  formatId: string
  expectedBytes: number | null
  contentIdentity: string | null
}

async function preparePartFile(
  partPath: string,
  receiptPath: string,
  binding: PartReceipt,
  continueDownload: boolean,
): Promise<number> {
  let bytes = await fileSize(partPath)
  const receipt = await readPartReceipt(receiptPath)
  if (!continueDownload || (bytes > 0 && !samePartReceipt(receipt, binding))) {
    await Promise.all([rm(partPath, { force: true }), rm(receiptPath, { force: true })])
    bytes = 0
  } else if (bytes === 0 && receipt) {
    await rm(receiptPath, { force: true })
  }
  if (bytes === 0) await writePartReceipt(receiptPath, binding)
  return bytes
}

async function readPartReceipt(path: string): Promise<PartReceipt | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const receipt = value as Partial<PartReceipt>
    if (
      receipt.version !== 1 ||
      typeof receipt.mediaKey !== 'string' ||
      typeof receipt.formatId !== 'string' ||
      (receipt.expectedBytes !== null && typeof receipt.expectedBytes !== 'number') ||
      (receipt.contentIdentity !== null && typeof receipt.contentIdentity !== 'string')
    ) {
      return undefined
    }
    return receipt as PartReceipt
  } catch {
    return undefined
  }
}

function samePartReceipt(left: PartReceipt | undefined, right: PartReceipt): boolean {
  return (
    left?.version === right.version &&
    left.mediaKey === right.mediaKey &&
    left.formatId === right.formatId &&
    left.expectedBytes === right.expectedBytes &&
    left.contentIdentity === right.contentIdentity
  )
}

async function writePartReceipt(path: string, receipt: PartReceipt): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

const GOOGLEVIDEO_CHUNK_BYTES = 1024 * 1024

async function downloadHttpChunks(
  format: Format,
  partPath: string,
  outputPath: string,
  resumeBytes: number,
  expectedBytes: number,
  chunkBytes: number,
  options: NativeDownloadOptions,
): Promise<void> {
  const handle = await open(partPath, resumeBytes > 0 ? 'a' : 'w')
  const startedAt = Date.now()
  const startingBytes = resumeBytes
  const rateLimit = parseRate(options.rateLimit)
  const concurrency = rateLimit === undefined ? httpChunkConcurrency(format) : 1
  let downloadedBytes = resumeBytes
  try {
    while (downloadedBytes < expectedBytes) {
      const ranges: Array<{ start: number; end: number }> = []
      for (let index = 0; index < concurrency; index += 1) {
        const start = downloadedBytes + index * chunkBytes
        if (start >= expectedBytes) break
        ranges.push({ start, end: Math.min(start + chunkBytes - 1, expectedBytes - 1) })
      }
      const batchController = new AbortController()
      const signal = options.signal
        ? AbortSignal.any([options.signal, batchController.signal])
        : batchController.signal
      const requests = ranges.map(({ start, end }) =>
        fetchHttpChunk(format, start, end, expectedBytes, options, signal),
      )
      let chunks: Buffer[]
      try {
        chunks = await Promise.all(requests)
      } catch (error) {
        batchController.abort()
        await Promise.allSettled(requests)
        throw error
      }
      // Network requests run concurrently; commits stay ordered so a .part file is always a valid
      // contiguous prefix and can resume safely after interruption.
      for (const [index, chunk] of chunks.entries()) {
        const range = ranges[index]!
        await writeAll(handle, chunk)
        downloadedBytes += chunk.byteLength
        const elapsedSeconds = Math.max((Date.now() - startedAt) / 1_000, 0.001)
        const speed = (downloadedBytes - startingBytes) / elapsedSeconds
        const remaining = expectedBytes - downloadedBytes
        options.onProgress?.({
          status: 'downloading',
          filename: outputPath,
          downloadedBytes,
          totalBytes: expectedBytes,
          speed,
          ...(speed > 0 ? { eta: remaining / speed } : undefined),
        })
        if (rateLimit !== undefined && speed > rateLimit) {
          const targetElapsed = (downloadedBytes - startingBytes) / rateLimit
          const delay = targetElapsed - elapsedSeconds
          if (delay > 0) await abortableDelay(delay * 1_000, options.signal)
        }
        if (downloadedBytes !== range.end + 1) {
          throw new YtdlpError(
            'CONTENT_TOO_SHORT',
            `Ordered HTTP range commit ended at ${downloadedBytes - 1}, expected ${range.end}`,
          )
        }
      }
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(partPath, outputPath)
  options.onProgress?.({ status: 'finished', filename: outputPath, totalBytes: expectedBytes })
}

async function fetchHttpChunk(
  format: Format,
  rangeStart: number,
  rangeEnd: number,
  expectedBytes: number,
  options: NativeDownloadOptions,
  signal: AbortSignal,
): Promise<Buffer> {
  const response = await request(format.url, {
    headers: {
      Accept: '*/*',
      'Accept-Encoding': 'identity',
      ...format.http_headers,
      Range: `bytes=${rangeStart}-${rangeEnd}`,
    },
    retries: 0,
    signal,
    timeoutMs: 30_000,
  })
  if (response.status !== 206) {
    throw new YtdlpError(
      'RANGE_NOT_SUPPORTED',
      `Format ${format.format_id} ignored the bounded range request`,
      { status: response.status, rangeStart, rangeEnd },
    )
  }
  validateContentRange(response.headers.get('content-range'), rangeStart, rangeEnd, expectedBytes)
  const expectedChunkBytes = rangeEnd - rangeStart + 1
  const declaredBytes = numberHeader(response.headers, 'content-length')
  if (declaredBytes !== undefined && declaredBytes !== expectedChunkBytes) {
    throw new YtdlpError(
      'INVALID_CONTENT_LENGTH',
      `Expected ${expectedChunkBytes} bytes for HTTP range ${rangeStart}-${rangeEnd}, got ${declaredBytes}`,
    )
  }
  const reader = response.body?.getReader()
  if (!reader) {
    throw new YtdlpError('EMPTY_RESPONSE', `No response body for format ${format.format_id}`)
  }
  const parts: Uint8Array[] = []
  let received = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > expectedChunkBytes) {
      await reader.cancel()
      throw new YtdlpError(
        'CONTENT_TOO_LONG',
        `HTTP range ${rangeStart}-${rangeEnd} exceeded its declared boundary`,
      )
    }
    parts.push(value)
  }
  if (received !== expectedChunkBytes) {
    throw new YtdlpError(
      'CONTENT_TOO_SHORT',
      `Downloaded ${received} of ${expectedChunkBytes} bytes for HTTP range ${rangeStart}-${rangeEnd}`,
    )
  }
  return Buffer.concat(parts, received)
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  value: Uint8Array,
): Promise<void> {
  let offset = 0
  while (offset < value.byteLength) {
    const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset)
    if (bytesWritten <= 0) throw new YtdlpError('WRITE_FAILED', 'Audio part write made no progress')
    offset += bytesWritten
  }
}

function validateContentRange(
  value: string | null,
  expectedStart: number,
  expectedEnd: number,
  expectedTotal: number,
): void {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(value ?? '')
  if (
    !match ||
    Number(match[1]) !== expectedStart ||
    Number(match[2]) !== expectedEnd ||
    Number(match[3]) !== expectedTotal
  ) {
    throw new YtdlpError(
      'INVALID_CONTENT_RANGE',
      `Expected bytes ${expectedStart}-${expectedEnd}/${expectedTotal}, got ${value ?? 'none'}`,
    )
  }
}

function httpChunkBytes(format: Format): number | undefined {
  const configured = format.downloader_options
  if (configured && typeof configured === 'object' && !Array.isArray(configured)) {
    const value = (configured as Record<string, unknown>).http_chunk_size
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  }
  try {
    if (/(^|\.)googlevideo\.com$/iu.test(new URL(format.url).hostname)) {
      return GOOGLEVIDEO_CHUNK_BYTES
    }
  } catch {
    // Non-URL inputs are rejected by the request layer.
  }
  return undefined
}

function httpChunkConcurrency(format: Format): number {
  const configured = format.downloader_options
  if (configured && typeof configured === 'object' && !Array.isArray(configured)) {
    const value = (configured as Record<string, unknown>).http_chunk_concurrency
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 8) {
      return value
    }
  }
  return 3
}

function outputExtension(formats: Format[], options: NativeDownloadOptions): string {
  if (options.extractAudio) return formats[0]?.ext ?? 'media'
  if (formats.length > 1) return options.mergeOutputFormat ?? 'mkv'
  return formats[0]?.ext ?? 'mp4'
}

async function ffmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], {
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-16_000)
    })
    const abort = () => child.kill('SIGTERM')
    signal?.addEventListener('abort', abort, { once: true })
    child.once('error', (error: NodeJS.ErrnoException) => {
      signal?.removeEventListener('abort', abort)
      reject(
        error.code === 'ENOENT'
          ? new YtdlpError('FFMPEG_NOT_FOUND', 'FFmpeg is required for this download')
          : error,
      )
    })
    child.once('close', (code) => {
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) reject(new YtdlpError('ABORTED', 'FFmpeg was aborted'))
      else if (code === 0) resolvePromise()
      else reject(new YtdlpError('FFMPEG_FAILED', stderr.trim() || `FFmpeg exited with ${code}`))
    })
  })
}

function audioCodecArgs(extension: string): string[] {
  return (
    {
      aac: ['-c:a', 'aac'],
      flac: ['-c:a', 'flac'],
      m4a: ['-c:a', 'aac'],
      mp3: ['-c:a', 'libmp3lame'],
      opus: ['-c:a', 'libopus'],
      vorbis: ['-c:a', 'libvorbis'],
      wav: ['-c:a', 'pcm_s16le'],
    }[extension] ?? ['-c:a', 'copy']
  )
}

export function parseRate(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const match = /^([\d.]+)\s*([kmgtpezy]?)(?:i?b)?$/iu.exec(value.trim())
  if (!match) throw new YtdlpError('INVALID_RATE', `Invalid rate limit: ${value}`)
  const powers = ['', 'k', 'm', 'g', 't', 'p', 'e', 'z', 'y']
  return Number(match[1]) * 1_000 ** powers.indexOf((match[2] ?? '').toLowerCase())
}

function numberHeader(headers: Headers, name: string): number | undefined {
  const value = Number(headers.get(name))
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

type OutputLock = {
  version: 1
  pid: number
  token: string
  startedAt: string
}

async function withOutputLock<T>(outputPath: string, run: () => Promise<T>): Promise<T> {
  const lockPath = `${outputPath}.ytdlp-ts.lock`
  const lock: OutputLock = {
    version: 1,
    pid: process.pid,
    token: randomUUID(),
    startedAt: new Date().toISOString(),
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify(lock)}\n`, 'utf8')
      await handle.sync()
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const owner = await readOutputLock(lockPath)
      if (owner && processIsAlive(owner.pid)) {
        throw new YtdlpError(
          'OUTPUT_LOCKED',
          `Another download owns the output path: ${outputPath}`,
          { outputPath, ownerPid: owner.pid, startedAt: owner.startedAt },
        )
      }
      if (!owner) {
        throw new YtdlpError(
          'OUTPUT_LOCKED',
          `Another download owns the output path: ${outputPath}`,
          {
            outputPath,
          },
        )
      }
      await rm(lockPath, { force: true })
    }
  }
  if (!handle) {
    throw new YtdlpError('OUTPUT_LOCKED', `Could not acquire the output path: ${outputPath}`)
  }
  try {
    return await run()
  } finally {
    await handle.close()
    const current = await readOutputLock(lockPath)
    if (current?.token === lock.token) await rm(lockPath, { force: true })
  }
}

async function readOutputLock(path: string): Promise<OutputLock | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<OutputLock>
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.pid) ||
      typeof value.pid !== 'number' ||
      typeof value.token !== 'string' ||
      typeof value.startedAt !== 'string'
    ) {
      return undefined
    }
    return value as OutputLock
  } catch {
    return undefined
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function isExpiredCapabilityError(error: unknown): boolean {
  return error instanceof YtdlpError && error.code === 'HTTP_ERROR' && error.details?.status === 403
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(resolvePromise, milliseconds)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new YtdlpError('ABORTED', 'Download was aborted'))
      },
      { once: true },
    )
  })
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
