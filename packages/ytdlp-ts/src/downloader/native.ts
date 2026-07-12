import { spawn } from 'node:child_process'
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises'
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
  const extension = outputExtension(selected, options)
  const relativeName = renderOutputTemplate(options.output ?? DEFAULT_OUTPUT_TEMPLATE, info, extension)
  const outputPath = resolve(options.paths ?? '.', relativeName)
  await mkdir(dirname(outputPath), { recursive: true })

  if (options.noOverwrites && (await exists(outputPath))) {
    return { files: [outputPath], selectedFormats: selected.map((format) => format.format_id) }
  }

  if (selected.length === 1) {
    await downloadFormat(selected[0]!, outputPath, options)
  } else {
    const temporary: string[] = []
    try {
      for (let index = 0; index < selected.length; index += 1) {
        const format = selected[index]!
        const path = join(dirname(outputPath), `.${info.id}.f${format.format_id}.${format.ext ?? 'media'}`)
        temporary.push(path)
        await downloadFormat(format, path, options)
      }
      options.onProgress?.({ status: 'postprocessing', filename: outputPath, operation: 'merge' })
      await ffmpeg(['-y', ...temporary.flatMap((path) => ['-i', path]), '-c', 'copy', outputPath], options.signal)
    } finally {
      await Promise.all(temporary.map((path) => rm(path, { force: true })))
    }
  }

  let finalPath = outputPath
  if (options.extractAudio) {
    const audioExtension = options.audioFormat ?? 'm4a'
    const audioPath = outputPath.replace(new RegExp(`${escapeRegex(extname(outputPath))}$`, 'u'), `.${audioExtension}`)
    options.onProgress?.({ status: 'postprocessing', filename: outputPath, operation: 'extract-audio' })
    await ffmpeg(['-y', '-i', outputPath, '-vn', audioCodecArgs(audioExtension), audioPath].flat(), options.signal)
    await rm(outputPath, { force: true })
    finalPath = audioPath
  }

  const files = [finalPath]
  const sidecarBase = withoutExtension(finalPath)
  if (options.writeInfoJson) {
    const path = `${sidecarBase}.info.json`
    await writeFile(path, `${JSON.stringify(info, null, 2)}\n`, 'utf8')
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
    files.push(...(await writeSubtitleSidecars(info.automatic_captions ?? {}, sidecarBase, options)))
  }

  return { files, selectedFormats: selected.map((format) => format.format_id) }
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
  return new RegExp(
    `^${value.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '.*')}$`,
    'u',
  )
}

function withoutExtension(path: string): string {
  const extension = extname(path)
  return extension ? path.slice(0, -extension.length) : path
}

async function downloadFormat(
  format: Format,
  outputPath: string,
  options: NativeDownloadOptions,
): Promise<void> {
  if (
    format.protocol?.startsWith('m3u8') ||
    format.protocol === 'dash' ||
    /\.(?:m3u8|mpd)(?:$|\?)/iu.test(format.url)
  ) {
    const partPath = `${outputPath}.part${extname(outputPath) || '.mp4'}`
    options.onProgress?.({ status: 'postprocessing', filename: outputPath, operation: 'hls-download' })
    await ffmpeg(['-y', '-i', format.url, '-c', 'copy', partPath], options.signal)
    await rename(partPath, outputPath)
    return
  }
  await downloadHttp(format, outputPath, options)
}

async function downloadHttp(
  format: Format,
  outputPath: string,
  options: NativeDownloadOptions,
): Promise<void> {
  const retries = options.retries ?? 3
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await downloadHttpAttempt(format, outputPath, options)
      return
    } catch (error) {
      lastError = error
      if (options.signal?.aborted || attempt === retries) break
      await abortableDelay(Math.min(500 * 2 ** attempt, 10_000), options.signal)
    }
  }
  throw lastError
}

async function downloadHttpAttempt(
  format: Format,
  outputPath: string,
  options: NativeDownloadOptions,
): Promise<void> {
  const partPath = `${outputPath}.part`
  const resumeBytes = options.continueDownload === false ? 0 : await fileSize(partPath)
  const headers: Record<string, string> = { Accept: '*/*', 'Accept-Encoding': 'identity' }
  if (resumeBytes > 0) headers.Range = `bytes=${resumeBytes}-`
  const response = await request(format.url, {
    headers: { ...headers, ...format.http_headers },
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
    if (!reader) throw new YtdlpError('EMPTY_RESPONSE', `No response body for ${format.url}`)
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      await handle.write(value)
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
    throw new YtdlpError('CONTENT_TOO_SHORT', `Downloaded ${downloadedBytes} of ${totalBytes} bytes`)
  }
  await rename(partPath, outputPath)
  options.onProgress?.({ status: 'finished', filename: outputPath, totalBytes: downloadedBytes })
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
  return {
    aac: ['-c:a', 'aac'],
    flac: ['-c:a', 'flac'],
    m4a: ['-c:a', 'aac'],
    mp3: ['-c:a', 'libmp3lame'],
    opus: ['-c:a', 'libopus'],
    vorbis: ['-c:a', 'libvorbis'],
    wav: ['-c:a', 'pcm_s16le'],
  }[extension] ?? ['-c:a', 'copy']
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
