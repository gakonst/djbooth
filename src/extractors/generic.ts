import { downloadText } from '../core/network.js'
import { deduplicateFormats, parseM3u8Formats } from '../core/manifest.js'
import type { Format, MediaInfo, Thumbnail } from '../core/types.js'
import {
  cleanHtml,
  extensionFromUrl,
  idFromUrl,
  isMediaContentType,
  mimeToExtension,
  parseIso8601Duration,
  resolveUrl,
  uploadDate,
} from '../core/utils.js'
import { YtdlpError } from '../core/errors.js'
import type { Extractor, ExtractorContext } from './base.js'

export class GenericExtractor implements Extractor {
  readonly key = 'Generic'
  readonly name = 'generic HTML media discovery'

  suitable(url: URL): boolean {
    return ['http:', 'https:'].includes(url.protocol)
  }

  async extract(url: URL, context: ExtractorContext): Promise<MediaInfo> {
    const { response, text } = await downloadText(url.href, {
      ...(context.signal ? { signal: context.signal } : undefined),
      maxBytes: 24 * 1024 * 1024,
    })
    const contentType = response.headers.get('content-type')
    if (isMediaContentType(contentType)) {
      const ext = mimeToExtension(contentType) ?? extensionFromUrl(response.url) ?? 'unknown_video'
      return this.createInfo(response.url, idFromUrl(response.url), idFromUrl(response.url), [
        { format_id: 'direct', url: response.url, ext },
      ])
    }

    const metadata = parseMetadata(text)
    const jsonLd = parseJsonLd(text).find(isVideoObject)
    const mediaUrls = new Set<string>()
    for (const value of [
      ...metadataValues(metadata, ['og:video', 'og:video:url', 'og:video:secure_url']),
      ...metadataValues(metadata, ['og:audio', 'og:audio:url', 'og:audio:secure_url']),
      ...metadataValues(metadata, ['twitter:player:stream']),
      ...extractTagUrls(text),
      ...stringValues(jsonLd?.contentUrl),
      ...stringValues(jsonLd?.embedUrl),
    ]) {
      const resolved = resolveUrl(value, response.url)
      if (resolved) mediaUrls.add(resolved)
    }

    const formats: Format[] = []
    for (const mediaUrl of mediaUrls) {
      const ext = extensionFromUrl(mediaUrl)
      if (ext === 'm3u8') {
        try {
          const manifest = await downloadText(mediaUrl, {
            ...(context.signal ? { signal: context.signal } : undefined),
            maxBytes: 4 * 1024 * 1024,
          })
          formats.push(...parseM3u8Formats(manifest.text, manifest.response.url))
          continue
        } catch {
          // Keep the manifest as a directly consumable format if expansion fails.
        }
      }
      formats.push({
        format_id: `http-${formats.length}`,
        url: mediaUrl,
        ...(ext ? { ext } : undefined),
        protocol: ext === 'm3u8' ? 'm3u8_native' : new URL(mediaUrl).protocol.slice(0, -1),
      })
    }

    if (formats.length === 0) {
      throw new YtdlpError('UNSUPPORTED_URL', `No media was discovered at ${response.url}`)
    }

    const canonicalUrl = firstMetadata(metadata, ['og:url'])
    const title =
      cleanHtml(firstString(jsonLd?.name)) ??
      cleanHtml(firstMetadata(metadata, ['og:title', 'twitter:title'])) ??
      cleanHtml(firstMatch(text, /<title\b[^>]*>([\s\S]*?)<\/title>/iu)) ??
      idFromUrl(response.url)
    const description =
      cleanHtml(firstString(jsonLd?.description)) ??
      cleanHtml(firstMetadata(metadata, ['og:description', 'twitter:description', 'description']))
    const thumbnailUrls = [
      ...metadataValues(metadata, ['og:image', 'twitter:image', 'twitter:image:src']),
      ...stringValues(jsonLd?.thumbnailUrl),
    ]
      .map((value) => resolveUrl(value, response.url))
      .filter((value): value is string => value !== undefined)
    const thumbnails: Thumbnail[] = [...new Set(thumbnailUrls)].map((thumbnailUrl) => ({
      url: thumbnailUrl,
    }))
    const duration = parseIso8601Duration(firstString(jsonLd?.duration))
    const date = uploadDate(firstString(jsonLd?.uploadDate))

    return {
      ...this.createInfo(
        canonicalUrl ? resolveUrl(canonicalUrl, response.url) ?? response.url : response.url,
        idFromUrl(response.url),
        title,
        deduplicateFormats(formats),
      ),
      ...(description ? { description } : undefined),
      ...(duration !== undefined ? { duration } : undefined),
      ...(date ? { upload_date: date } : undefined),
      ...(thumbnails.length > 0 ? { thumbnail: thumbnails[0]!.url, thumbnails } : undefined),
    }
  }

  private createInfo(webpageUrl: string, id: string, title: string, formats: Format[]): MediaInfo {
    return {
      id,
      title,
      original_url: webpageUrl,
      webpage_url: webpageUrl,
      extractor: 'generic',
      extractor_key: this.key,
      formats,
    }
  }
}

type JsonRecord = Record<string, unknown>

function parseMetadata(html: string): Map<string, string[]> {
  const metadata = new Map<string, string[]>()
  for (const match of html.matchAll(/<meta\b([^>]*?)\/?\s*>/giu)) {
    const attributes = parseHtmlAttributes(match[1] ?? '')
    const key = (attributes.property ?? attributes.name ?? attributes.itemprop)?.toLowerCase()
    const value = attributes.content
    if (!key || !value) continue
    const values = metadata.get(key) ?? []
    values.push(value)
    metadata.set(key, values)
  }
  return metadata
}

function parseHtmlAttributes(value: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  const pattern = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu
  for (const match of value.matchAll(pattern)) {
    attributes[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? ''
  }
  return attributes
}

function extractTagUrls(html: string): string[] {
  const urls: string[] = []
  for (const match of html.matchAll(/<(?:video|audio|source)\b([^>]*)>/giu)) {
    const attributes = parseHtmlAttributes(match[1] ?? '')
    if (attributes.src) urls.push(attributes.src)
  }
  return urls
}

function parseJsonLd(html: string): JsonRecord[] {
  const objects: JsonRecord[] = []
  for (const match of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu,
  )) {
    try {
      const parsed: unknown = JSON.parse(match[1]!.trim())
      flattenJsonLd(parsed, objects)
    } catch {
      // Malformed JSON-LD must not prevent other generic discovery methods.
    }
  }
  return objects
}

function flattenJsonLd(value: unknown, output: JsonRecord[]): void {
  if (Array.isArray(value)) {
    for (const item of value) flattenJsonLd(item, output)
  } else if (value !== null && typeof value === 'object') {
    const record = value as JsonRecord
    output.push(record)
    if ('@graph' in record) flattenJsonLd(record['@graph'], output)
  }
}

function isVideoObject(value: JsonRecord): boolean {
  const types = stringValues(value['@type'])
  return types.some((type) => ['VideoObject', 'AudioObject', 'MediaObject'].includes(type))
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return []
}

function firstString(value: unknown): string | undefined {
  return stringValues(value)[0]
}

function metadataValues(metadata: Map<string, string[]>, keys: string[]): string[] {
  return keys.flatMap((key) => metadata.get(key) ?? [])
}

function firstMetadata(metadata: Map<string, string[]>, keys: string[]): string | undefined {
  return metadataValues(metadata, keys)[0]
}

function firstMatch(value: string, pattern: RegExp): string | undefined {
  return pattern.exec(value)?.[1]
}
