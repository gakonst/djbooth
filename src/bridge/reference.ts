import { spawn } from 'node:child_process'

import { YtdlpError } from '../core/errors.js'
import type { MediaInfo } from '../core/types.js'

const DEFAULT_MAX_CAPTURE_BYTES = 32 * 1024 * 1024

export interface ReferenceRunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  maxCaptureBytes?: number
  signal?: AbortSignal
}

export interface ReferenceResult {
  command: string
  args: string[]
  exitCode: number
  stdout: string
  stderr: string
}

export interface InspectReferenceOptions {
  playlist?: boolean
  flatPlaylist?: boolean
  cookies?: string
  cookiesFromBrowser?: string
  username?: string
  password?: string
  videoPassword?: string
  proxy?: string
  geoBypassCountry?: string
  impersonate?: string
  extractorArgs?: string[]
  noCheckCertificates?: boolean
  socketTimeout?: number
}

export interface DownloadReferenceOptions extends InspectReferenceOptions {
  format?: string
  output?: string
  paths?: string
  noOverwrites?: boolean
  continueDownload?: boolean
  concurrentFragments?: number
  retries?: number
  fragmentRetries?: number
  rateLimit?: string
  extractAudio?: boolean
  audioFormat?: string
  audioQuality?: string
  mergeOutputFormat?: string
  remuxVideo?: string
  writeSubtitles?: boolean
  writeAutoSubtitles?: boolean
  subtitleLanguages?: string[]
  subtitleFormat?: string
  embedSubtitles?: boolean
  writeThumbnail?: boolean
  embedThumbnail?: boolean
  writeInfoJson?: boolean
  embedMetadata?: boolean
  embedChapters?: boolean
  sponsorblockRemove?: string[]
  downloadArchive?: string
  sleepRequests?: number
  sleepInterval?: number
  maxSleepInterval?: number
  throttledRate?: string
  retrySleep?: string[]
}

export class ReferenceClient {
  readonly binary: string

  constructor(binary = process.env.YTDLP_TS_REFERENCE_BINARY || 'yt-dlp') {
    this.binary = binary
  }

  async run(args: string[], options: ReferenceRunOptions = {}): Promise<ReferenceResult> {
    const maxCaptureBytes = options.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES

    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let captureBytes = 0
      let aborted = false

      const capture = (target: 'stdout' | 'stderr', chunk: Buffer) => {
        captureBytes += chunk.byteLength
        if (captureBytes > maxCaptureBytes) {
          child.kill('SIGTERM')
          reject(
            new YtdlpError('REFERENCE_OUTPUT_LIMIT', 'Reference engine output exceeded the limit', {
              maxCaptureBytes,
            }),
          )
          return
        }
        if (target === 'stdout') stdout += chunk.toString('utf8')
        else stderr += chunk.toString('utf8')
      }

      child.stdout.on('data', (chunk: Buffer) => capture('stdout', chunk))
      child.stderr.on('data', (chunk: Buffer) => capture('stderr', chunk))

      const abort = () => {
        aborted = true
        child.kill('SIGTERM')
      }
      options.signal?.addEventListener('abort', abort, { once: true })

      child.once('error', (error: NodeJS.ErrnoException) => {
        options.signal?.removeEventListener('abort', abort)
        if (error.code === 'ENOENT') {
          reject(
            new YtdlpError(
              'REFERENCE_ENGINE_NOT_FOUND',
              `Could not find reference executable ${JSON.stringify(this.binary)}. Install yt-dlp or set YTDLP_TS_REFERENCE_BINARY.`,
            ),
          )
          return
        }
        reject(new YtdlpError('REFERENCE_ENGINE_START_FAILED', error.message))
      })

      child.once('close', (exitCode, signal) => {
        options.signal?.removeEventListener('abort', abort)
        if (aborted) {
          reject(new YtdlpError('ABORTED', 'Reference engine execution was aborted'))
          return
        }
        const code = exitCode ?? 1
        const result = { command: this.binary, args, exitCode: code, stdout, stderr }
        if (code !== 0) {
          reject(
            new YtdlpError('REFERENCE_ENGINE_FAILED', lastMeaningfulLine(stderr) || `yt-dlp exited via ${signal ?? code}`, {
              exitCode: code,
              stderr: tail(stderr, 8_000),
            }),
          )
          return
        }
        resolve(result)
      })
    })
  }

  async version(): Promise<string> {
    const result = await this.run(['--version'])
    return result.stdout.trim()
  }

  async inspect(url: string, options: InspectReferenceOptions = {}): Promise<MediaInfo> {
    const args = buildInspectArgs(url, options)
    const result = await this.run(args)
    return parseSingleJson(result.stdout)
  }

  async download(url: string, options: DownloadReferenceOptions = {}): Promise<{
    files: string[]
    stdout: string
    stderr: string
  }> {
    const args = buildDownloadArgs(url, options)
    const result = await this.run(args, { maxCaptureBytes: 64 * 1024 * 1024 })
    const files = result.stdout
      .split(/\r?\n/u)
      .filter((line) => line.startsWith('__YTDLP_TS_FILE__:'))
      .map((line) => line.slice('__YTDLP_TS_FILE__:'.length))
    return {
      files,
      stdout: stripControlLines(result.stdout),
      stderr: tail(result.stderr, 16_000),
    }
  }
}

export function buildInspectArgs(url: string, options: InspectReferenceOptions = {}): string[] {
  const args = ['--ignore-config', '--dump-single-json', '--skip-download', '--no-warnings']
  if (options.playlist === false) args.push('--no-playlist')
  if (options.flatPlaylist) args.push('--flat-playlist')
  appendNetworkAndAuthArgs(args, options)
  args.push('--', url)
  return args
}

export function buildDownloadArgs(url: string, options: DownloadReferenceOptions = {}): string[] {
  const args = [
    '--ignore-config',
    '--newline',
    '--print',
    'after_move:__YTDLP_TS_FILE__:%(filepath)s',
  ]
  if (options.playlist === false) args.push('--no-playlist')
  appendValue(args, '-f', options.format)
  appendValue(args, '-o', options.output)
  appendValue(args, '-P', options.paths)
  if (options.noOverwrites) args.push('--no-overwrites')
  if (options.continueDownload === false) args.push('--no-continue')
  appendNumber(args, '--concurrent-fragments', options.concurrentFragments)
  appendNumber(args, '--retries', options.retries)
  appendNumber(args, '--fragment-retries', options.fragmentRetries)
  appendValue(args, '--limit-rate', options.rateLimit)
  if (options.extractAudio) args.push('--extract-audio')
  appendValue(args, '--audio-format', options.audioFormat)
  appendValue(args, '--audio-quality', options.audioQuality)
  appendValue(args, '--merge-output-format', options.mergeOutputFormat)
  appendValue(args, '--remux-video', options.remuxVideo)
  if (options.writeSubtitles) args.push('--write-subs')
  if (options.writeAutoSubtitles) args.push('--write-auto-subs')
  for (const language of options.subtitleLanguages ?? []) appendValue(args, '--sub-langs', language)
  appendValue(args, '--sub-format', options.subtitleFormat)
  if (options.embedSubtitles) args.push('--embed-subs')
  if (options.writeThumbnail) args.push('--write-thumbnail')
  if (options.embedThumbnail) args.push('--embed-thumbnail')
  if (options.writeInfoJson) args.push('--write-info-json')
  if (options.embedMetadata) args.push('--embed-metadata')
  if (options.embedChapters) args.push('--embed-chapters')
  for (const category of options.sponsorblockRemove ?? []) {
    appendValue(args, '--sponsorblock-remove', category)
  }
  appendValue(args, '--download-archive', options.downloadArchive)
  appendNumber(args, '--sleep-requests', options.sleepRequests)
  appendNumber(args, '--sleep-interval', options.sleepInterval)
  appendNumber(args, '--max-sleep-interval', options.maxSleepInterval)
  appendValue(args, '--throttled-rate', options.throttledRate)
  for (const value of options.retrySleep ?? []) appendValue(args, '--retry-sleep', value)
  appendNetworkAndAuthArgs(args, options)
  args.push('--', url)
  return args
}

function appendNetworkAndAuthArgs(args: string[], options: InspectReferenceOptions): void {
  appendValue(args, '--cookies', options.cookies)
  appendValue(args, '--cookies-from-browser', options.cookiesFromBrowser)
  appendValue(args, '--username', options.username)
  appendValue(args, '--password', options.password)
  appendValue(args, '--video-password', options.videoPassword)
  appendValue(args, '--proxy', options.proxy)
  appendValue(args, '--geo-bypass-country', options.geoBypassCountry)
  appendValue(args, '--impersonate', options.impersonate)
  for (const value of options.extractorArgs ?? []) appendValue(args, '--extractor-args', value)
  if (options.noCheckCertificates) args.push('--no-check-certificates')
  appendNumber(args, '--socket-timeout', options.socketTimeout)
}

function appendValue(args: string[], name: string, value: string | undefined): void {
  if (value !== undefined) args.push(name, value)
}

function appendNumber(args: string[], name: string, value: number | undefined): void {
  if (value !== undefined) args.push(name, String(value))
}

function parseSingleJson(stdout: string): MediaInfo {
  const value = stdout.trim()
  try {
    return JSON.parse(value) as MediaInfo
  } catch (error) {
    throw new YtdlpError('REFERENCE_INVALID_JSON', 'Reference engine returned invalid JSON', {
      cause: error instanceof Error ? error.message : String(error),
      stdout: tail(stdout, 8_000),
    })
  }
}

function lastMeaningfulLine(value: string): string | undefined {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
}

function tail(value: string, length: number): string {
  return value.length <= length ? value : value.slice(-length)
}

function stripControlLines(stdout: string): string {
  return stdout
    .split(/\r?\n/u)
    .filter((line) => !line.startsWith('__YTDLP_TS_FILE__:'))
    .join('\n')
    .trim()
}
