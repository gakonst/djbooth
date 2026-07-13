import { ClientType, Innertube } from 'youtubei.js'

import { YtdlpError } from '../core/errors.js'
import type { Format, MediaInfo, Subtitle, Thumbnail } from '../core/types.js'
import { uploadDate } from '../core/utils.js'
import type { ExtractorContext } from './base.js'

type YoutubeFormat = {
  itag: number
  url?: string
  signature_cipher?: string
  cipher?: string
  mime_type: string
  has_audio: boolean
  has_video: boolean
  width?: number
  height?: number
  fps?: number
  quality_label?: string
  audio_quality?: string
  average_bitrate?: number
  bitrate: number
  content_length?: number
  language?: string | null
}

type YoutubeVideoInfo = {
  basic_info: {
    id?: string
    title?: string
    duration?: number
    short_description?: string
    author?: string
    channel_id?: string
    view_count?: number
    is_live?: boolean
    is_live_content?: boolean
    thumbnail?: Array<{ url: string; width: number; height: number }>
  }
  streaming_data?: {
    formats: YoutubeFormat[]
    adaptive_formats: YoutubeFormat[]
  }
  captions?: {
    caption_tracks?: Array<{
      base_url: string
      language_code: string
      kind?: 'asr' | 'frc'
      name: { toString(): string }
    }>
  }
  page: [
    {
      microformat?: {
        upload_date?: string
        publish_date?: string
      }
    },
    unknown?,
  ]
}

type YoutubeCaptionTrack = NonNullable<
  NonNullable<YoutubeVideoInfo['captions']>['caption_tracks']
>[number]

export type YoutubeNativeClient = {
  getBasicInfo(videoId: string, options: { client: 'ANDROID_VR' }): Promise<YoutubeVideoInfo>
}

export type YoutubeNativeClientFactory = () => Promise<YoutubeNativeClient>

let sharedDirectClient: Promise<YoutubeNativeClient> | undefined

export async function extractYoutubeWithInnertube(
  videoId: string,
  context: ExtractorContext,
  createClient: YoutubeNativeClientFactory = defaultClient,
): Promise<MediaInfo> {
  throwIfAborted(context.signal)
  const client = await abortable(createClient(), context.signal)
  const video = await abortable(
    client.getBasicInfo(videoId, { client: 'ANDROID_VR' }),
    context.signal,
  )
  throwIfAborted(context.signal)

  const basic = video.basic_info
  if (basic.id !== videoId) {
    throw new YtdlpError(
      'YOUTUBE_IDENTITY_MISMATCH',
      `YouTube returned video '${basic.id ?? 'missing'}' for requested ID '${videoId}'`,
    )
  }
  if (!basic.title) throw new YtdlpError('YOUTUBE_METADATA_MISSING', 'YouTube returned no title')

  const sourceFormats = [
    ...(video.streaming_data?.formats ?? []),
    ...(video.streaming_data?.adaptive_formats ?? []),
  ]
  const formats = sourceFormats.flatMap((source) => {
    const format = source.url ? youtubeFormat(source, source.url) : undefined
    return format ? [format] : []
  })

  if (!formats.some((format) => format.acodec && format.acodec !== 'none')) {
    throw new YtdlpError(
      'YOUTUBE_DIRECT_FORMATS_UNAVAILABLE',
      'YouTube Android VR returned no direct audio formats; native extraction will not execute player code or fall back to another engine',
    )
  }

  const webpageUrl = `https://www.youtube.com/watch?v=${videoId}`
  const thumbnails = youtubeThumbnails(basic.thumbnail)
  const { subtitles, automaticCaptions } = youtubeCaptions(video.captions?.caption_tracks)
  const microformat = video.page[0]?.microformat
  const date = uploadDate(microformat?.upload_date ?? microformat?.publish_date)

  return {
    id: videoId,
    title: basic.title,
    webpage_url: webpageUrl,
    original_url: webpageUrl,
    extractor: 'youtube',
    extractor_key: 'Youtube',
    ...(basic.short_description ? { description: basic.short_description } : undefined),
    ...(basic.author ? { uploader: basic.author, channel: basic.author } : undefined),
    ...(basic.channel_id
      ? { uploader_id: basic.channel_id, channel_id: basic.channel_id }
      : undefined),
    ...(basic.duration !== undefined ? { duration: basic.duration } : undefined),
    ...(basic.view_count !== undefined ? { view_count: basic.view_count } : undefined),
    ...(date ? { upload_date: date } : undefined),
    live_status: basic.is_live || basic.is_live_content ? 'is_live' : 'not_live',
    formats: deduplicateFormats(formats),
    ...(thumbnails.length ? { thumbnails, thumbnail: thumbnails.at(-1)!.url } : undefined),
    ...(Object.keys(subtitles).length ? { subtitles } : undefined),
    ...(Object.keys(automaticCaptions).length
      ? { automatic_captions: automaticCaptions }
      : undefined),
  }
}

async function defaultClient(): Promise<YoutubeNativeClient> {
  sharedDirectClient ??= (
    Innertube.create({
      lang: 'en',
      location: 'US',
      retrieve_player: false,
      generate_session_locally: false,
      enable_session_cache: false,
      client_type: ClientType.ANDROID_VR,
    }) as Promise<YoutubeNativeClient>
  ).catch((error: unknown) => {
    sharedDirectClient = undefined
    throw error
  })
  return sharedDirectClient
}

function youtubeFormat(source: YoutubeFormat, url: string): Format | undefined {
  let mediaUrl: URL
  try {
    mediaUrl = new URL(url)
  } catch {
    return undefined
  }
  if (mediaUrl.protocol !== 'https:' || !/(^|\.)googlevideo\.com$/iu.test(mediaUrl.hostname)) {
    return undefined
  }
  const mime = source.mime_type
  const mimeType = mime.split(';', 1)[0]?.trim() ?? ''
  const codecs =
    /codecs="([^"]+)"/u
      .exec(mime)?.[1]
      ?.split(',')
      .map((value) => value.trim()) ?? []
  const audio = source.has_audio
  const video = source.has_video
  if (
    audio &&
    !video &&
    (!Number.isSafeInteger(source.content_length) || (source.content_length ?? 0) <= 0)
  ) {
    return undefined
  }
  const extension = mimeType.includes('webm') ? 'webm' : audio && !video ? 'm4a' : 'mp4'
  const audioCodec = audio ? ((video ? codecs.at(-1) : codecs[0]) ?? 'unknown') : 'none'
  const videoCodec = video ? (codecs[0] ?? 'unknown') : 'none'
  return {
    format_id: String(source.itag),
    url,
    ext: extension,
    protocol: 'https',
    ...(source.quality_label || source.audio_quality
      ? { format_note: source.quality_label ?? source.audio_quality }
      : undefined),
    ...(source.width === undefined ? {} : { width: source.width }),
    ...(source.height === undefined ? {} : { height: source.height }),
    ...(source.fps === undefined ? {} : { fps: source.fps }),
    tbr: source.bitrate / 1_000,
    ...(audio ? { abr: (source.average_bitrate ?? source.bitrate) / 1_000 } : undefined),
    ...(source.content_length === undefined ? {} : { filesize: source.content_length }),
    ...(source.language ? { language: source.language } : undefined),
    content_identity: `${source.itag}:${mediaUrl.searchParams.get('lmt') ?? 'unknown'}:${source.content_length ?? 'unknown'}`,
    http_headers: {
      'User-Agent':
        'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    },
    downloader_options: { http_chunk_size: 1024 * 1024, http_chunk_concurrency: 2 },
    vcodec: videoCodec,
    acodec: audioCodec,
  }
}

function youtubeThumbnails(values: YoutubeVideoInfo['basic_info']['thumbnail']): Thumbnail[] {
  return (values ?? []).map(({ url, width, height }) => ({ url, width, height }))
}

function youtubeCaptions(values: YoutubeCaptionTrack[] | undefined): {
  subtitles: Record<string, Subtitle[]>
  automaticCaptions: Record<string, Subtitle[]>
} {
  const subtitles: Record<string, Subtitle[]> = {}
  const automaticCaptions: Record<string, Subtitle[]> = {}
  for (const track of values ?? []) {
    const subtitle: Subtitle = {
      url: withQuery(track.base_url, 'fmt', 'vtt'),
      ext: 'vtt',
      name: track.name.toString(),
    }
    const target = track.kind === 'asr' ? automaticCaptions : subtitles
    ;(target[track.language_code] ??= []).push(subtitle)
  }
  return { subtitles, automaticCaptions }
}

function deduplicateFormats(values: Format[]): Format[] {
  const seen = new Set<string>()
  return values.filter((format) => {
    const key = `${format.format_id}\u0000${format.url}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function withQuery(value: string, key: string, next: string): string {
  const url = new URL(value)
  url.searchParams.set(key, next)
  return url.toString()
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new YtdlpError('ABORTED', 'YouTube extraction was aborted')
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  throwIfAborted(signal)
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new YtdlpError('ABORTED', 'YouTube extraction was aborted'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}
