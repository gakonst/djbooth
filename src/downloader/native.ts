import { spawn } from 'node:child_process'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'

import { YtdlpError } from '../core/errors.js'
import { selectFormats } from '../core/format-selector.js'
import { request } from '../core/network.js'
import { DEFAULT_OUTPUT_TEMPLATE, renderOutputTemplate } from '../core/template.js'
import type { Format, MediaInfo, ProgressEvent } from '../core/types.js'

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

  return { files: [finalPath], selectedFormats: selected.map((format) => format.format_id) }
}

export function supportsNativeDownloadOptions(options: Record<string, unknown>): boolean {
  const unsupported = [
    'writeSubtitles',
    'writeAutoSubtitles',
    'embedSubtitles',
    'writeThumbnail',
    'embedThumbnail',
    'writeInfoJson',
    'embedMetadata',
    'embedChapters',
    'sponsorblockRemove',
    'remuxVideo',
    'audioQuality',
    'concurrentFragments',
    'fragmentRetries',
    'subtitleLanguages',
    'subtitleFormat',
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
  const partPath = `${outputPath}.part`
  const resumeBytes = options.continueDownload === false ? 0 : await fileSize(partPath)
  const headers: Record<string, string> = { Accept: '*/*', 'Accept-Encoding': 'identity' }
  if (resumeBytes > 0) headers.Range = `bytes=${resumeBytes}-`
  const response = await request(format.url, {
    headers: { ...headers, ...format.http_headers },
    ...(options.retries !== undefined ? { retries: options.retries } : undefined),
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
