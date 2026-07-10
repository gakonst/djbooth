import { YtdlpError } from '../core/errors.js'
import { parseM3u8Formats, parseMpdFormats } from '../core/manifest.js'
import { downloadText } from '../core/network.js'
import type { Format, MediaInfo, Subtitle, Thumbnail } from '../core/types.js'
import { uploadDate } from '../core/utils.js'
import type { Extractor, ExtractorContext } from './base.js'

type JsonRecord = Record<string, unknown>

export class YoutubeExtractor implements Extractor {
  readonly key = 'Youtube'
  readonly name = 'YouTube videos'

  suitable(url: URL): boolean {
    return /(^|\.)youtube\.com$/iu.test(url.hostname) || /(^|\.)youtu\.be$/iu.test(url.hostname)
  }

  async extract(url: URL, context: ExtractorContext): Promise<MediaInfo> {
    const videoId = extractYoutubeId(url)
    if (!videoId) throw new YtdlpError('INVALID_YOUTUBE_URL', `Could not determine video ID from ${url.href}`)
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}&bpctr=9999999999&has_verified=1`
    const { text } = await downloadText(watchUrl, {
      ...(context.signal ? { signal: context.signal } : undefined),
      maxBytes: 12 * 1024 * 1024,
    })
    const playerResponse = extractPlayerResponse(text)
    if (!playerResponse) throw new YtdlpError('YOUTUBE_PLAYER_RESPONSE_MISSING', 'YouTube player response was not found')
    const info = await parseYoutubePlayerResponse(playerResponse, watchUrl, context)
    if (!info.formats?.length) {
      throw new YtdlpError(
        'YOUTUBE_SIGNATURE_REQUIRED',
        'Available YouTube formats require player signature transformation; use engine auto/reference',
      )
    }
    return info
  }
}

export function extractYoutubeId(url: URL): string | undefined {
  if (/youtu\.be$/iu.test(url.hostname)) return validId(url.pathname.split('/').filter(Boolean)[0])
  const fromQuery = validId(url.searchParams.get('v') ?? undefined)
  if (fromQuery) return fromQuery
  const parts = url.pathname.split('/').filter(Boolean)
  if (['embed', 'shorts', 'live'].includes(parts[0] ?? '')) return validId(parts[1])
  return undefined
}

function validId(value: string | undefined): string | undefined {
  return value && /^[\w-]{11}$/u.test(value) ? value : undefined
}

export function extractPlayerResponse(webpage: string): JsonRecord | undefined {
  for (const marker of ['ytInitialPlayerResponse =', 'ytInitialPlayerResponse=', 'var ytInitialPlayerResponse =']) {
    const index = webpage.indexOf(marker)
    if (index < 0) continue
    const json = extractBalancedJson(webpage, index + marker.length)
    if (!json) continue
    try {
      return JSON.parse(json) as JsonRecord
    } catch {
      // Try the next marker.
    }
  }
  const escaped = /"playerResponse"\s*:\s*"((?:\\.|[^"\\])*)"/u.exec(webpage)?.[1]
  if (escaped) {
    try {
      return JSON.parse(JSON.parse(`"${escaped}"`)) as JsonRecord
    } catch {
      return undefined
    }
  }
  return undefined
}

export async function parseYoutubePlayerResponse(
  response: JsonRecord,
  webpageUrl: string,
  context: ExtractorContext = {},
): Promise<MediaInfo> {
  const playability = record(response.playabilityStatus)
  const status = string(playability?.status)
  if (status && !['OK', 'LIVE_STREAM_OFFLINE'].includes(status)) {
    throw new YtdlpError(
      status === 'LOGIN_REQUIRED' ? 'YOUTUBE_LOGIN_REQUIRED' : 'YOUTUBE_UNAVAILABLE',
      string(playability?.reason) ?? `YouTube player status: ${status}`,
    )
  }
  const details = record(response.videoDetails) ?? {}
  const microformat = record(record(response.microformat)?.playerMicroformatRenderer) ?? {}
  const streaming = record(response.streamingData) ?? {}
  const formats = [...array(streaming.formats), ...array(streaming.adaptiveFormats)]
    .map((value) => parseYoutubeFormat(record(value)))
    .filter((value): value is Format => value !== undefined)
  const hlsUrl = string(streaming.hlsManifestUrl)
  if (hlsUrl) {
    try {
      const manifest = await downloadText(hlsUrl, {
        ...(context.signal ? { signal: context.signal } : undefined),
        maxBytes: 4 * 1024 * 1024,
      })
      formats.push(...parseM3u8Formats(manifest.text, manifest.response.url))
    } catch {
      formats.push({ format_id: 'hls', url: hlsUrl, ext: 'mp4', protocol: 'm3u8_native' })
    }
  }
  const dashUrl = string(streaming.dashManifestUrl)
  if (dashUrl) {
    try {
      const manifest = await downloadText(dashUrl, {
        ...(context.signal ? { signal: context.signal } : undefined),
        maxBytes: 4 * 1024 * 1024,
      })
      formats.push(...parseMpdFormats(manifest.text, manifest.response.url))
    } catch {
      formats.push({ format_id: 'dash', url: dashUrl, ext: 'mp4', protocol: 'dash' })
    }
  }

  const thumbnails: Thumbnail[] = array(record(details.thumbnail)?.thumbnails)
    .map((value) => record(value))
    .filter((value): value is JsonRecord => value !== undefined && string(value.url) !== undefined)
    .map((value) => {
      const width = number(value.width)
      const height = number(value.height)
      return {
        url: string(value.url)!,
        ...(width !== undefined ? { width } : undefined),
        ...(height !== undefined ? { height } : undefined),
      }
    })
  const subtitles: Record<string, Subtitle[]> = {}
  const automaticCaptions: Record<string, Subtitle[]> = {}
  const captionTracks = array(
    record(record(response.captions)?.playerCaptionsTracklistRenderer)?.captionTracks,
  )
  for (const trackValue of captionTracks) {
    const track = record(trackValue)
    const baseUrl = string(track?.baseUrl)
    const language = string(track?.languageCode)
    if (!track || !baseUrl || !language) continue
    const name = text(track.name)
    const subtitle: Subtitle = {
      url: withQuery(baseUrl, 'fmt', 'vtt'),
      ext: 'vtt',
      ...(name ? { name } : undefined),
    }
    const target = string(track.kind) === 'asr' ? automaticCaptions : subtitles
    ;(target[language] ??= []).push(subtitle)
  }
  const id = string(details.videoId) ?? new URL(webpageUrl).searchParams.get('v') ?? 'unknown'
  const duration = number(details.lengthSeconds)
  const viewCount = number(details.viewCount)
  const publishDate = uploadDate(string(microformat.publishDate) ?? string(microformat.uploadDate))
  const description = string(details.shortDescription)
  const author = string(details.author)
  const channelId = string(details.channelId)
  return {
    id,
    title: string(details.title) ?? id,
    webpage_url: webpageUrl,
    original_url: webpageUrl,
    extractor: 'youtube',
    extractor_key: 'Youtube',
    ...(description ? { description } : undefined),
    ...(author ? { uploader: author, channel: author } : undefined),
    ...(channelId ? { uploader_id: channelId, channel_id: channelId } : undefined),
    ...(duration !== undefined ? { duration } : undefined),
    ...(viewCount !== undefined ? { view_count: viewCount } : undefined),
    ...(publishDate ? { upload_date: publishDate } : undefined),
    live_status: details.isLiveContent === true ? 'is_live' : 'not_live',
    formats,
    ...(thumbnails.length > 0 ? { thumbnails, thumbnail: thumbnails.at(-1)!.url } : undefined),
    ...(Object.keys(subtitles).length > 0 ? { subtitles } : undefined),
    ...(Object.keys(automaticCaptions).length > 0
      ? { automatic_captions: automaticCaptions }
      : undefined),
  }
}

function parseYoutubeFormat(value: JsonRecord | undefined): Format | undefined {
  if (!value) return undefined
  let url = string(value.url)
  if (!url && string(value.signatureCipher)) {
    const cipher = new URLSearchParams(string(value.signatureCipher))
    url = cipher.get('url') ?? undefined
    const signature = cipher.get('sig')
    if (url && signature) url = withQuery(url, cipher.get('sp') ?? 'signature', signature)
    if (cipher.has('s')) return undefined
  }
  if (!url) return undefined
  const mime = string(value.mimeType) ?? ''
  const codecs = /codecs="([^"]+)"/u.exec(mime)?.[1]?.split(',').map((codec) => codec.trim()) ?? []
  const video = mime.startsWith('video/')
  const audio = mime.startsWith('audio/')
  const formatNote = string(value.qualityLabel)
  const width = number(value.width)
  const height = number(value.height)
  const fps = number(value.fps)
  const bitrate = number(value.bitrate)
  const contentLength = number(value.contentLength)
  return {
    format_id: String(value.itag ?? 'unknown'),
    url,
    ext: mime.includes('webm') ? 'webm' : audio ? 'm4a' : 'mp4',
    protocol: 'https',
    ...(formatNote ? { format_note: formatNote } : undefined),
    ...(width !== undefined ? { width } : undefined),
    ...(height !== undefined ? { height } : undefined),
    ...(fps !== undefined ? { fps } : undefined),
    ...(bitrate !== undefined ? { tbr: bitrate / 1_000 } : undefined),
    ...(contentLength !== undefined ? { filesize: contentLength } : undefined),
    vcodec: audio ? 'none' : codecs[0] ?? (video ? 'unknown' : 'none'),
    acodec: video && codecs.length < 2 ? 'none' : codecs.at(-1) ?? (audio ? 'unknown' : 'none'),
  }
}

function extractBalancedJson(value: string, start: number): string | undefined {
  const opening = value.indexOf('{', start)
  if (opening < 0) return undefined
  let depth = 0
  let quote = false
  let escaped = false
  for (let index = opening; index < value.length; index += 1) {
    const character = value[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quote = false
      continue
    }
    if (character === '"') quote = true
    else if (character === '{') depth += 1
    else if (character === '}' && --depth === 0) return value.slice(opening, index + 1)
  }
  return undefined
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function number(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

function text(value: unknown): string | undefined {
  const object = record(value)
  return (
    string(object?.simpleText) ??
    (array(object?.runs)
      .map((run) => string(record(run)?.text) ?? '')
      .join('') || undefined)
  )
}

function withQuery(value: string, key: string, item: string): string {
  const url = new URL(value)
  url.searchParams.set(key, item)
  return url.href
}
