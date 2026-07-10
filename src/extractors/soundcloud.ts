import { YtdlpError } from '../core/errors.js'
import { downloadText } from '../core/network.js'
import type { Format, MediaInfo, Thumbnail } from '../core/types.js'
import { uploadDate } from '../core/utils.js'
import type { Extractor, ExtractorContext } from './base.js'

type JsonRecord = Record<string, unknown>

interface ResolvedTranscoding {
  transcoding: JsonRecord
  url: string
}

let cachedClientId: Promise<string> | undefined

export class SoundcloudExtractor implements Extractor {
  readonly key = 'Soundcloud'
  readonly name = 'SoundCloud tracks'

  suitable(url: URL): boolean {
    return /(^|\.)(?:soundcloud\.com|snd\.sc)$/iu.test(url.hostname)
  }

  async extract(url: URL, context: ExtractorContext): Promise<MediaInfo> {
    const page = await downloadText(url.href, {
      ...(context.signal ? { signal: context.signal } : undefined),
      maxBytes: 8 * 1024 * 1024,
    })
    const hydration = parseSoundcloudHydration(page.text)
    const track = hydration.find((item) => item.hydratable === 'sound')?.data
    if (!isRecord(track)) {
      throw new YtdlpError(
        'SOUNDCLOUD_TRACK_UNAVAILABLE',
        'The URL is not a public SoundCloud track; playlists and profiles currently use the reference engine',
      )
    }
    const transcodings = array(record(track.media)?.transcodings)
      .map(record)
      .filter((item): item is JsonRecord => item !== undefined)
    if (transcodings.length === 0) {
      throw new YtdlpError('SOUNDCLOUD_NO_FORMATS', 'SoundCloud returned no playable transcodings')
    }

    const clientId = await discoverClientId(page.text, page.response.url, context)
    const trackAuthorization = string(track.track_authorization)
    const resolved = (
      await Promise.all(
        transcodings.map(async (transcoding): Promise<ResolvedTranscoding | undefined> => {
          const endpoint = string(transcoding.url)
          if (!endpoint) return undefined
          try {
            const apiUrl = new URL(endpoint)
            apiUrl.searchParams.set('client_id', clientId)
            if (trackAuthorization) apiUrl.searchParams.set('track_authorization', trackAuthorization)
            const response = await downloadText(apiUrl.href, {
              ...(context.signal ? { signal: context.signal } : undefined),
              maxBytes: 1024 * 1024,
            })
            const stream = JSON.parse(response.text) as JsonRecord
            const streamUrl = string(stream.url)
            return streamUrl ? { transcoding, url: streamUrl } : undefined
          } catch {
            return undefined
          }
        }),
      )
    ).filter((item): item is ResolvedTranscoding => item !== undefined)
    if (resolved.length === 0) {
      throw new YtdlpError(
        'SOUNDCLOUD_STREAM_RESOLUTION_FAILED',
        'SoundCloud media endpoints could not be resolved; use engine auto/reference',
      )
    }
    return parseSoundcloudTrack(track, resolved, page.response.url)
  }
}

export function parseSoundcloudHydration(
  webpage: string,
): Array<{ hydratable: string; data: unknown }> {
  const marker = 'window.__sc_hydration'
  const markerIndex = webpage.indexOf(marker)
  if (markerIndex < 0) throw new YtdlpError('SOUNDCLOUD_HYDRATION_MISSING', 'SoundCloud hydration data was not found')
  const start = webpage.indexOf('[', markerIndex + marker.length)
  if (start < 0) throw new YtdlpError('SOUNDCLOUD_HYDRATION_MISSING', 'SoundCloud hydration data was not found')
  const json = extractBalancedArray(webpage, start)
  if (!json) throw new YtdlpError('SOUNDCLOUD_HYDRATION_INVALID', 'SoundCloud hydration data is incomplete')
  try {
    const value: unknown = JSON.parse(json)
    if (!Array.isArray(value)) throw new Error('expected an array')
    return value.filter(
      (item): item is { hydratable: string; data: unknown } =>
        isRecord(item) && typeof item.hydratable === 'string',
    )
  } catch (error) {
    throw new YtdlpError('SOUNDCLOUD_HYDRATION_INVALID', 'SoundCloud hydration JSON is invalid', {
      cause: error instanceof Error ? error.message : String(error),
    })
  }
}

export function parseSoundcloudTrack(
  track: JsonRecord,
  streams: ResolvedTranscoding[],
  webpageUrl: string,
): MediaInfo {
  const user = record(track.user) ?? {}
  const id = String(track.id ?? track.urn ?? 'unknown')
  const formats = streams.map(({ transcoding, url }, index) =>
    soundcloudFormat(transcoding, url, webpageUrl, index),
  )
  const artworkUrl = string(track.artwork_url)
  const thumbnails: Thumbnail[] = artworkUrl
    ? [
        { id: 'large', url: artworkUrl },
        { id: 'original', url: artworkUrl.replace(/-large(?=\.[a-z]+(?:$|\?))/iu, '-original'), preference: 1 },
      ]
    : []
  const createdAt = string(track.created_at)
  const timestamp = createdAt ? Date.parse(createdAt) / 1_000 : Number.NaN
  const date = uploadDate(createdAt)
  const durationMs = number(track.full_duration) ?? number(track.duration)
  const description = string(track.description)
  const uploader = string(user.username)
  const viewCount = number(track.playback_count)
  const likeCount = number(track.likes_count)
  const genre = string(track.genre)
  const license = string(track.license)
  return {
    id,
    title: string(track.title) ?? id,
    webpage_url: string(track.permalink_url) ?? webpageUrl,
    original_url: webpageUrl,
    extractor: 'soundcloud',
    extractor_key: 'Soundcloud',
    ...(description ? { description } : undefined),
    ...(uploader ? { uploader } : undefined),
    ...(user.id !== undefined ? { uploader_id: String(user.id) } : undefined),
    ...(durationMs !== undefined ? { duration: durationMs / 1_000 } : undefined),
    ...(Number.isFinite(timestamp) ? { timestamp } : undefined),
    ...(date ? { upload_date: date } : undefined),
    ...(viewCount !== undefined ? { view_count: viewCount } : undefined),
    ...(likeCount !== undefined ? { like_count: likeCount } : undefined),
    ...(genre ? { genre } : undefined),
    ...(license ? { license } : undefined),
    formats,
    ...(artworkUrl ? { thumbnails, thumbnail: artworkUrl } : undefined),
  }
}

async function discoverClientId(
  webpage: string,
  webpageUrl: string,
  context: ExtractorContext,
): Promise<string> {
  cachedClientId ??= discoverClientIdUncached(webpage, webpageUrl, context).catch((error) => {
    cachedClientId = undefined
    throw error
  })
  return cachedClientId
}

async function discoverClientIdUncached(
  webpage: string,
  webpageUrl: string,
  context: ExtractorContext,
): Promise<string> {
  const scriptUrls = [...webpage.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/giu)]
    .map((match) => new URL(match[1]!, webpageUrl).href)
    .reverse()
  for (const scriptUrl of scriptUrls) {
    try {
      const script = await downloadText(scriptUrl, {
        ...(context.signal ? { signal: context.signal } : undefined),
        maxBytes: 6 * 1024 * 1024,
      })
      const clientId =
        /\bclient_id\s*[:=]\s*["']([\w-]{20,})["']/u.exec(script.text)?.[1] ??
        /[?&]client_id=([\w-]{20,})/u.exec(script.text)?.[1]
      if (clientId) return clientId
    } catch {
      // Asset bundles are independently deployed; continue to the next bundle.
    }
  }
  throw new YtdlpError(
    'SOUNDCLOUD_CLIENT_ID_MISSING',
    'Could not discover SoundCloud API credentials; use engine auto/reference',
  )
}

function soundcloudFormat(
  transcoding: JsonRecord,
  url: string,
  webpageUrl: string,
  index: number,
): Format {
  const format = record(transcoding.format) ?? {}
  const protocol = string(format.protocol) ?? 'progressive'
  const mime = string(format.mime_type) ?? ''
  const preset = string(transcoding.preset) ?? String(index)
  const hls = protocol === 'hls'
  const aac = /(?:aac|mp4a|audio\/mp4)/iu.test(mime) || preset.startsWith('aac')
  const opus = /opus/iu.test(mime) || preset.startsWith('opus')
  const ext = aac ? 'm4a' : opus ? 'opus' : 'mp3'
  const bitrate = /(?:_|^)(\d{2,3})k(?:_|$)/u.exec(preset)?.[1]
  const abr = bitrate ? Number(bitrate) : preset.startsWith('mp3_0') ? 128 : undefined
  const formatNote = string(transcoding.quality)
  return {
    format_id: `${hls ? 'hls' : 'http'}_${preset}`,
    url,
    ext,
    protocol: hls ? 'm3u8_native' : 'https',
    vcodec: 'none',
    acodec: aac ? 'mp4a.40.2' : opus ? 'opus' : 'mp3',
    ...(abr !== undefined ? { abr, tbr: abr } : undefined),
    ...(formatNote ? { format_note: formatNote } : undefined),
    http_headers: { Referer: webpageUrl },
  }
}

function extractBalancedArray(value: string, start: number): string | undefined {
  let depth = 0
  let quote = false
  let escaped = false
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quote = false
      continue
    }
    if (character === '"') quote = true
    else if (character === '[') depth += 1
    else if (character === ']' && --depth === 0) return value.slice(start, index + 1)
  }
  return undefined
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function record(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined
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
