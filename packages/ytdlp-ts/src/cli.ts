#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Cli, z } from 'incur'

import { ReferenceClient, type DownloadReferenceOptions, type InspectReferenceOptions } from './bridge/reference.js'
import { inspect } from './core/engine.js'
import { errorMessage, YtdlpError } from './core/errors.js'
import { compareMediaInfo } from './core/parity.js'
import type { EngineKind } from './core/types.js'
import { ExtractorRegistry } from './extractors/registry.js'
import { downloadMedia, supportsNativeDownloadOptions } from './downloader/native.js'
import { downloadMusicBatch } from './music.js'

const { version: VERSION } = createRequire(import.meta.url)('../package.json') as {
  version: string
}
const engine = z.enum(['auto', 'native', 'reference']).default('auto').describe('Execution engine')

const inspectOptions = z.object({
  engine,
  playlist: z.boolean().default(true).describe('Extract playlists instead of a single item'),
  flatPlaylist: z.boolean().optional().describe('Do not resolve playlist entries'),
  cookies: z.string().optional().describe('Netscape cookie file'),
  cookiesFromBrowser: z.string().optional().describe('Browser cookie source specification'),
  username: z.string().optional().describe('Account username'),
  password: z.string().optional().describe('Account password'),
  videoPassword: z.string().optional().describe('Video-specific password'),
  proxy: z.string().optional().describe('HTTP/HTTPS/SOCKS proxy URL'),
  geoBypassCountry: z.string().optional().describe('ISO 3166-2 country code for geo bypass'),
  impersonate: z.string().optional().describe('Browser/client impersonation target'),
  extractorArgs: z.array(z.string()).optional().describe('Extractor argument key:value'),
  noCheckCertificates: z.boolean().optional().describe('Disable TLS certificate validation'),
  socketTimeout: z.number().int().positive().optional().describe('Socket timeout in seconds'),
})

export const cli = Cli.create('ytdlp-ts', {
  version: VERSION,
  description: 'Download highest-quality music and metadata from YouTube and SoundCloud.',
  mcp: {
    instructions:
      'Use inspect before download when format or subtitle selection matters. Results report the native or reference engine used.',
  },
  sync: {
    cwd: import.meta.dirname,
    suggestions: [
      'inspect a media URL and summarize its formats',
      'download the highest-quality source audio and metadata for a URL',
      'download several YouTube and SoundCloud tracks at the highest source quality with metadata',
      'list available subtitles for a media URL',
    ],
  },
})

cli.command('inspect', {
  description: 'Extract the complete yt-dlp-compatible information object for a URL.',
  args: z.object({ url: z.url().describe('Media or playlist URL') }),
  options: inspectOptions,
  alias: { cookies: 'c' },
  examples: [{ args: { url: 'https://www.youtube.com/watch?v=BaW_jenozKc' } }],
  async run(c) {
    try {
      const result = await inspect(c.args.url, c.options.engine as EngineKind, toInspectOptions(c.options))
      return { engine: result.engine, info: result.data }
    } catch (error) {
      return fail(c, error)
    }
  },
})

cli.command('formats', {
  description: 'List downloadable formats for a URL.',
  args: z.object({ url: z.url().describe('Media URL') }),
  options: inspectOptions,
  async run(c) {
    try {
      const result = await inspect(c.args.url, c.options.engine as EngineKind, toInspectOptions(c.options))
      const formats = result.data.formats ?? []
      return {
        engine: result.engine,
        id: result.data.id,
        title: result.data.title,
        count: formats.length,
        formats,
      }
    } catch (error) {
      return fail(c, error)
    }
  },
})

cli.command('subtitles', {
  description: 'List manual and automatically generated subtitles for a URL.',
  args: z.object({ url: z.url().describe('Media URL') }),
  options: inspectOptions,
  async run(c) {
    try {
      const result = await inspect(c.args.url, c.options.engine as EngineKind, toInspectOptions(c.options))
      return {
        engine: result.engine,
        id: result.data.id,
        title: result.data.title,
        subtitles: result.data.subtitles ?? {},
        automaticCaptions: result.data.automatic_captions ?? {},
      }
    } catch (error) {
      return fail(c, error)
    }
  },
})

cli.command('thumbnails', {
  description: 'List thumbnail images for a URL.',
  args: z.object({ url: z.url().describe('Media URL') }),
  options: inspectOptions,
  async run(c) {
    try {
      const result = await inspect(c.args.url, c.options.engine as EngineKind, toInspectOptions(c.options))
      return {
        engine: result.engine,
        id: result.data.id,
        title: result.data.title,
        thumbnails: result.data.thumbnails ?? [],
      }
    } catch (error) {
      return fail(c, error)
    }
  },
})

cli.command('parity', {
  description: 'Compare native extraction with the pinned yt-dlp behavior model.',
  args: z.object({ url: z.url().describe('Media URL') }),
  options: inspectOptions.omit({ engine: true }),
  async run(c) {
    const options = toInspectOptions(c.options)
    let nativeInfo
    try {
      nativeInfo = (await inspect(c.args.url, 'native', options)).data
    } catch (error) {
      try {
        const reference = (await inspect(c.args.url, 'reference', options)).data
        return {
          native: { supported: false, error: errorMessage(error) },
          reference: {
            id: reference.id,
            title: reference.title,
            extractor: reference.extractor_key ?? reference.extractor,
            formatCount: reference.formats?.length ?? 0,
          },
        }
      } catch (referenceError) {
        return fail(c, referenceError)
      }
    }
    try {
      const referenceInfo = (await inspect(c.args.url, 'reference', options)).data
      return {
        native: {
          supported: true,
          extractor: nativeInfo.extractor_key ?? nativeInfo.extractor,
        },
        reference: {
          extractor: referenceInfo.extractor_key ?? referenceInfo.extractor,
        },
        report: compareMediaInfo(nativeInfo, referenceInfo),
      }
    } catch (error) {
      return fail(c, error)
    }
  },
})

cli.command('music', {
  description: 'Download one or more music tracks at the highest source quality with metadata.',
  destructive: true,
  args: z.object({
    url: z.url().optional().describe('YouTube or SoundCloud track or playlist URL'),
  }),
  options: z.object({
    url: z.array(z.url()).optional().describe('Additional track URL; repeat for multiple tracks'),
    inputFile: z.string().optional().describe('Text file containing one URL per line'),
    engine,
    paths: z.string().default('.').describe('Music library directory'),
    output: z.string().optional().describe('yt-dlp-compatible output filename template'),
    audioFormat: z
      .enum(['best', 'aac', 'alac', 'flac', 'm4a', 'mp3', 'opus', 'vorbis', 'wav'])
      .default('best')
      .describe('Keep source audio or convert after download'),
    audioQuality: z.string().default('0').describe('FFmpeg quality when converting audio'),
    archive: z.string().optional().describe('Durable completed-track archive path'),
    concurrency: z.number().int().min(1).max(64).default(64).describe('Maximum parallel source inspections and tracks'),
    youtubeConcurrency: z.number().int().min(1).max(64).default(64).describe('Maximum parallel YouTube tracks'),
    retries: z.number().int().min(0).max(100).default(10).describe('Transfer and fragment retries'),
    rateLimit: z.string().optional().describe('Global download rate limit, e.g. 8M'),
    youtubeRateLimit: z.string().optional().describe('YouTube-specific rate limit, e.g. 4M'),
    youtubeRequestInterval: z.number().min(0).default(1).describe('Delay between YouTube requests'),
    youtubeMinSleep: z.number().min(0).default(2).describe('Minimum delay between YouTube tracks'),
    youtubeMaxSleep: z.number().min(0).default(5).describe('Maximum delay between YouTube tracks'),
    continueOnError: z.boolean().default(true).describe('Continue the batch after a failed track'),
    writeInfoJson: z.boolean().default(true).describe('Write full metadata JSON alongside audio'),
    writeThumbnail: z.boolean().default(true).describe('Write cover artwork alongside audio'),
    embedMetadata: z.boolean().default(true).describe('Embed tags when using the reference engine'),
    embedThumbnail: z.boolean().default(true).describe('Embed cover art when using the reference engine'),
    cookies: z.string().optional().describe('Netscape cookie file'),
    cookiesFromBrowser: z.string().optional().describe('Browser cookie source specification'),
    proxy: z.string().optional().describe('HTTP/HTTPS/SOCKS proxy URL'),
    extractorArgs: z.array(z.string()).optional().describe('Extractor argument key:value'),
  }),
  alias: { paths: 'P', output: 'o', url: 'u' },
  async run(c) {
    try {
      const fileUrls = c.options.inputFile
        ? (await readFile(c.options.inputFile, 'utf8'))
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith('#'))
        : []
      const urls = [c.args.url, ...(c.options.url ?? []), ...fileUrls].filter((url): url is string => Boolean(url))
      if (urls.length === 0) {
        return c.error({
          code: 'NO_MUSIC_URLS',
          message: 'Pass a URL, repeat --url, or provide --input-file.',
          exitCode: 2,
        })
      }
      return await downloadMusicBatch(
        urls,
        defined({
          ...c.options,
          archive: c.options.archive ?? join(c.options.paths, '.ytdlp-ts-music-archive'),
        }) as Parameters<typeof downloadMusicBatch>[1],
      )
    } catch (error) {
      return fail(c, error)
    }
  },
})

cli.command('download', {
  description: 'Download media and run requested post-processing.',
  destructive: true,
  args: z.object({ url: z.url().describe('Media or playlist URL') }),
  options: z.object({
    engine,
    mediaFormat: z.string().optional().describe('yt-dlp format selection expression'),
    output: z.string().optional().describe('Output filename template'),
    paths: z.string().optional().describe('Download directory'),
    playlist: z.boolean().default(true).describe('Download playlists instead of a single item'),
    noOverwrites: z.boolean().optional().describe('Do not overwrite existing files'),
    continueDownload: z.boolean().default(true).describe('Resume partial downloads'),
    concurrentFragments: z.number().int().positive().optional().describe('Concurrent fragment count'),
    retries: z.number().int().nonnegative().optional().describe('HTTP retry count'),
    fragmentRetries: z.number().int().nonnegative().optional().describe('Fragment retry count'),
    rateLimit: z.string().optional().describe('Maximum download rate, e.g. 4.2M'),
    extractAudio: z.boolean().optional().describe('Convert video files to audio-only files'),
    audioFormat: z.string().optional().describe('Audio conversion format'),
    audioQuality: z.string().optional().describe('FFmpeg audio quality'),
    mergeOutputFormat: z.string().optional().describe('Container used when merging formats'),
    remuxVideo: z.string().optional().describe('Remux output to a container'),
    writeSubtitles: z.boolean().optional().describe('Write manual subtitles'),
    writeAutoSubtitles: z.boolean().optional().describe('Write automatic subtitles'),
    subtitleLanguages: z.array(z.string()).optional().describe('Subtitle language expression'),
    subtitleFormat: z.string().optional().describe('Subtitle format preference'),
    embedSubtitles: z.boolean().optional().describe('Embed subtitles in the media file'),
    writeThumbnail: z.boolean().optional().describe('Write thumbnail image'),
    embedThumbnail: z.boolean().optional().describe('Embed thumbnail in the media file'),
    writeInfoJson: z.boolean().optional().describe('Write the info object as JSON'),
    embedMetadata: z.boolean().optional().describe('Embed media metadata'),
    embedChapters: z.boolean().optional().describe('Embed chapter markers'),
    sponsorblockRemove: z.array(z.string()).optional().describe('SponsorBlock categories to remove'),
    cookies: z.string().optional().describe('Netscape cookie file'),
    cookiesFromBrowser: z.string().optional().describe('Browser cookie source specification'),
    username: z.string().optional().describe('Account username'),
    password: z.string().optional().describe('Account password'),
    videoPassword: z.string().optional().describe('Video-specific password'),
    proxy: z.string().optional().describe('HTTP/HTTPS/SOCKS proxy URL'),
    geoBypassCountry: z.string().optional().describe('ISO 3166-2 country code for geo bypass'),
    impersonate: z.string().optional().describe('Browser/client impersonation target'),
    extractorArgs: z.array(z.string()).optional().describe('Extractor argument key:value'),
    noCheckCertificates: z.boolean().optional().describe('Disable TLS certificate validation'),
    socketTimeout: z.number().int().positive().optional().describe('Socket timeout in seconds'),
  }),
  alias: { mediaFormat: 'f', output: 'o', paths: 'P' },
  async run(c) {
    const nativeSupported = supportsNativeDownloadOptions(c.options)
    if (c.options.engine === 'native' && !nativeSupported) {
      return c.error({
        code: 'NATIVE_OPTION_UNAVAILABLE',
        message: 'At least one selected option is not native yet. Use --engine auto or reference.',
        exitCode: 2,
      })
    }
    if (c.options.engine !== 'reference' && nativeSupported) {
      try {
        const extracted = await inspect(c.args.url, 'native', toInspectOptions(c.options))
        let progressEvents = 0
        let lastProgress: unknown
        const result = await downloadMedia(extracted.data, {
          ...defined({
            format: c.options.mediaFormat,
            output: c.options.output,
            paths: c.options.paths,
            noOverwrites: c.options.noOverwrites,
            continueDownload: c.options.continueDownload,
            retries: c.options.retries,
            rateLimit: c.options.rateLimit,
            mergeOutputFormat: c.options.mergeOutputFormat,
            extractAudio: c.options.extractAudio,
            audioFormat: c.options.audioFormat,
            writeSubtitles: c.options.writeSubtitles,
            writeAutoSubtitles: c.options.writeAutoSubtitles,
            subtitleLanguages: c.options.subtitleLanguages,
            subtitleFormat: c.options.subtitleFormat,
            writeThumbnail: c.options.writeThumbnail,
            writeInfoJson: c.options.writeInfoJson,
          }),
          onProgress(event) {
            progressEvents += 1
            lastProgress = event
          },
        })
        return { engine: 'native', ...result, progressEvents, lastProgress }
      } catch (error) {
        if (c.options.engine === 'native') return fail(c, error)
      }
    }
    try {
      const result = await new ReferenceClient().download(c.args.url, toDownloadOptions(c.options))
      return {
        engine: 'reference',
        files: result.files,
        log: result.stdout,
        warnings: result.stderr,
      }
    } catch (error) {
      return fail(c, error)
    }
  },
})

cli.command('extractors', {
  description: 'List extractor names available through native and reference engines.',
  options: z.object({
    engine: z.enum(['native', 'reference', 'all']).default('all').describe('Extractor inventory'),
  }),
  async run(c) {
    try {
      const native = new ExtractorRegistry().list()
      if (c.options.engine === 'native') return { engine: 'native', count: native.length, extractors: native }
      const result = await new ReferenceClient().run(['--ignore-config', '--list-extractors'])
      const reference = result.stdout.split(/\r?\n/u).filter(Boolean)
      if (c.options.engine === 'reference') {
        return {
          engine: 'reference',
          count: reference.length,
          extractors: reference,
        }
      }
      return {
        engine: 'all',
        native: { count: native.length, extractors: native },
        reference: { count: reference.length, extractors: reference },
      }
    } catch (error) {
      return fail(c, error)
    }
  },
})

cli.command('compat', {
  description: 'Run arbitrary yt-dlp arguments through the exact reference engine.',
  destructive: true,
  options: z.object({
    arg: z.array(z.string()).default([]).describe('One argument; repeat for multiple arguments'),
  }),
  alias: { arg: 'a' },
  examples: [
    {
      options: {
        arg: ['--dump-single-json', 'https://www.youtube.com/watch?v=BaW_jenozKc'],
      },
      description: 'Pass exact yt-dlp arguments',
    },
  ],
  async run(c) {
    try {
      const result = await new ReferenceClient().run(c.options.arg, {
        maxCaptureBytes: 64 * 1024 * 1024,
      })
      return {
        engine: 'reference',
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      }
    } catch (error) {
      return fail(c, error)
    }
  },
})

cli.command('engines', {
  description: 'Report native and reference engine availability.',
  async run() {
    const reference = new ReferenceClient()
    try {
      const version = await reference.version()
      return {
        native: { available: true, extractors: new ExtractorRegistry().list() },
        reference: { available: true, binary: reference.binary, version },
      }
    } catch (error) {
      return {
        native: { available: true, extractors: new ExtractorRegistry().list() },
        reference: {
          available: false,
          binary: reference.binary,
          error: errorMessage(error),
        },
      }
    }
  },
})

function toInspectOptions(options: Record<string, unknown>): InspectReferenceOptions {
  return defined({
    playlist: options.playlist as boolean | undefined,
    flatPlaylist: options.flatPlaylist as boolean | undefined,
    cookies: options.cookies as string | undefined,
    cookiesFromBrowser: options.cookiesFromBrowser as string | undefined,
    username: options.username as string | undefined,
    password: options.password as string | undefined,
    videoPassword: options.videoPassword as string | undefined,
    proxy: options.proxy as string | undefined,
    geoBypassCountry: options.geoBypassCountry as string | undefined,
    impersonate: options.impersonate as string | undefined,
    extractorArgs: options.extractorArgs as string[] | undefined,
    noCheckCertificates: options.noCheckCertificates as boolean | undefined,
    socketTimeout: options.socketTimeout as number | undefined,
  }) as InspectReferenceOptions
}

function toDownloadOptions(options: Record<string, unknown>): DownloadReferenceOptions {
  return defined({
    ...toInspectOptions(options),
    format: options.mediaFormat as string | undefined,
    output: options.output as string | undefined,
    paths: options.paths as string | undefined,
    noOverwrites: options.noOverwrites as boolean | undefined,
    continueDownload: options.continueDownload as boolean | undefined,
    concurrentFragments: options.concurrentFragments as number | undefined,
    retries: options.retries as number | undefined,
    fragmentRetries: options.fragmentRetries as number | undefined,
    rateLimit: options.rateLimit as string | undefined,
    extractAudio: options.extractAudio as boolean | undefined,
    audioFormat: options.audioFormat as string | undefined,
    audioQuality: options.audioQuality as string | undefined,
    mergeOutputFormat: options.mergeOutputFormat as string | undefined,
    remuxVideo: options.remuxVideo as string | undefined,
    writeSubtitles: options.writeSubtitles as boolean | undefined,
    writeAutoSubtitles: options.writeAutoSubtitles as boolean | undefined,
    subtitleLanguages: options.subtitleLanguages as string[] | undefined,
    subtitleFormat: options.subtitleFormat as string | undefined,
    embedSubtitles: options.embedSubtitles as boolean | undefined,
    writeThumbnail: options.writeThumbnail as boolean | undefined,
    embedThumbnail: options.embedThumbnail as boolean | undefined,
    writeInfoJson: options.writeInfoJson as boolean | undefined,
    embedMetadata: options.embedMetadata as boolean | undefined,
    embedChapters: options.embedChapters as boolean | undefined,
    sponsorblockRemove: options.sponsorblockRemove as string[] | undefined,
  }) as DownloadReferenceOptions
}

function defined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

function fail(
  context: {
    error(options: { code: string; exitCode?: number; message: string; retryable?: boolean }): never
  },
  error: unknown,
): never {
  if (error instanceof YtdlpError) {
    return context.error({
      code: error.code,
      message: error.message,
      exitCode: 1,
      retryable: false,
    })
  }
  return context.error({
    code: 'YTDLP_TS_ERROR',
    message: errorMessage(error),
    exitCode: 1,
    retryable: false,
  })
}

export async function runYtdlpCli(argv?: string[]): Promise<void> {
  await cli.serve(argv)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href
) {
  await runYtdlpCli()
}

export default cli
