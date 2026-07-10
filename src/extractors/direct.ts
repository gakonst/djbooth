import { downloadText, request } from '../core/network.js'
import { parseM3u8Formats } from '../core/manifest.js'
import type { Format, MediaInfo } from '../core/types.js'
import {
  extensionFromUrl,
  idFromUrl,
  isManifestContentType,
  isMediaContentType,
  mimeToExtension,
} from '../core/utils.js'
import type { Extractor, ExtractorContext } from './base.js'

const MEDIA_EXTENSIONS = new Set([
  '3gp',
  'aac',
  'flac',
  'm3u8',
  'm4a',
  'm4v',
  'mkv',
  'mov',
  'mp3',
  'mp4',
  'mpd',
  'ogg',
  'ogv',
  'opus',
  'ts',
  'wav',
  'webm',
])

export class DirectExtractor implements Extractor {
  readonly key = 'Direct'
  readonly name = 'direct media URL'

  suitable(url: URL): boolean {
    const extension = extensionFromUrl(url.href)
    return extension !== undefined && MEDIA_EXTENSIONS.has(extension)
  }

  async extract(url: URL, context: ExtractorContext): Promise<MediaInfo> {
    const extension = extensionFromUrl(url.href)
    if (extension === 'm3u8') {
      const { text } = await downloadText(url.href, {
        ...(context.signal ? { signal: context.signal } : undefined),
      })
      return this.info(url, 'm3u8', parseM3u8Formats(text, url.href))
    }
    const response = await request(url.href, {
      headers: { Range: 'bytes=0-0', Accept: '*/*' },
      ...(context.signal ? { signal: context.signal } : undefined),
    })
    const contentType = response.headers.get('content-type')
    if (!isMediaContentType(contentType) && !MEDIA_EXTENSIONS.has(extension ?? '')) {
      throw new Error(`URL did not return media: ${contentType ?? 'unknown content type'}`)
    }
    if (isManifestContentType(contentType)) {
      const text = await response.text()
      return this.info(url, 'm3u8', parseM3u8Formats(text, response.url))
    }
    const ext = mimeToExtension(contentType) ?? extension ?? 'unknown_video'
    const filesize = numberHeader(response.headers, 'content-length')
    return this.info(url, ext, [
      {
        format_id: 'direct',
        url: response.url,
        ext,
        protocol: url.protocol.slice(0, -1),
        ...(filesize !== undefined ? { filesize } : undefined),
      },
    ])
  }

  private info(url: URL, ext: string, formats: Format[]): MediaInfo {
    const id = idFromUrl(url.href)
    return {
      id,
      title: id,
      original_url: url.href,
      webpage_url: url.href,
      extractor: 'direct',
      extractor_key: this.key,
      ext,
      formats,
    }
  }
}

function numberHeader(headers: Headers, name: string): number | undefined {
  const value = Number(headers.get(name))
  return Number.isFinite(value) && value >= 0 ? value : undefined
}
