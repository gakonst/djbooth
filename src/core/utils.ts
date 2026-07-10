import { createHash } from 'node:crypto'
import { extname } from 'node:path'

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: '\u00a0',
  quot: '"',
}

export function decodeHtml(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (match, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
    return HTML_ENTITIES[entity.toLowerCase()] ?? match
  })
}

export function cleanHtml(value: string | undefined): string | undefined {
  if (!value) return undefined
  return decodeHtml(value.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim()) || undefined
}

export function resolveUrl(value: string, baseUrl: string): string | undefined {
  try {
    const url = new URL(decodeHtml(value), baseUrl)
    if (!['http:', 'https:'].includes(url.protocol)) return undefined
    return url.href
  } catch {
    return undefined
  }
}

export function extensionFromUrl(value: string): string | undefined {
  try {
    const extension = extname(new URL(value).pathname).slice(1).toLowerCase()
    return extension || undefined
  } catch {
    return undefined
  }
}

export function idFromUrl(value: string): string {
  const url = new URL(value)
  const basename = url.pathname.split('/').filter(Boolean).at(-1)?.replace(/\.[^.]+$/u, '')
  return basename || createHash('sha1').update(value).digest('hex').slice(0, 12)
}

export function mimeToExtension(contentType: string | null): string | undefined {
  if (!contentType) return undefined
  const mime = contentType.split(';', 1)[0]?.trim().toLowerCase()
  return {
    'application/dash+xml': 'mpd',
    'application/ogg': 'ogg',
    'application/vnd.apple.mpegurl': 'm3u8',
    'application/x-mpegurl': 'm3u8',
    'audio/aac': 'aac',
    'audio/flac': 'flac',
    'audio/m4a': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'video/mp2t': 'ts',
    'video/mp4': 'mp4',
    'video/ogg': 'ogv',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
  }[mime ?? '']
}

export function isMediaContentType(contentType: string | null): boolean {
  if (!contentType) return false
  return /^(?:audio|video)\//iu.test(contentType) || isManifestContentType(contentType)
}

export function isManifestContentType(contentType: string | null): boolean {
  return /(?:mpegurl|dash\+xml)/iu.test(contentType ?? '')
}

export function parseIso8601Duration(value: string | undefined): number | undefined {
  if (!value) return undefined
  const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/iu.exec(
    value,
  )
  if (!match) return undefined
  return (
    Number(match[1] ?? 0) * 86_400 +
    Number(match[2] ?? 0) * 3_600 +
    Number(match[3] ?? 0) * 60 +
    Number(match[4] ?? 0)
  )
}

export function uploadDate(value: string | undefined): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return undefined
  return date.toISOString().slice(0, 10).replaceAll('-', '')
}
