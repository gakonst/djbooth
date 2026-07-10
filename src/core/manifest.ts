import type { Format } from './types.js'

export function parseM3u8Formats(text: string, manifestUrl: string): Format[] {
  const lines = text.split(/\r?\n/u).map((line) => line.trim())
  const formats: Format[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line?.startsWith('#EXT-X-STREAM-INF:')) continue
    const attributes = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length))
    const mediaLine = lines.slice(index + 1).find((candidate) => candidate && !candidate.startsWith('#'))
    if (!mediaLine) continue
    const resolution = /^(\d+)x(\d+)$/u.exec(attributes.RESOLUTION ?? '')
    const codecs = attributes.CODECS?.split(',').map((value) => value.trim()) ?? []
    const videoCodec = codecs.find((codec) => /^(?:avc|av01|hev|hvc|vp0?9)/iu.test(codec))
    const audioCodec = codecs.find((codec) => /^(?:mp4a|aac|ac-3|ec-3|opus|vorbis)/iu.test(codec))
    const height = numberOrUndefined(resolution?.[2])
    const bandwidth = numberOrUndefined(attributes['AVERAGE-BANDWIDTH'] ?? attributes.BANDWIDTH)
    formats.push({
      format_id: attributes.NAME ?? (height ? `hls-${height}` : `hls-${formats.length}`),
      url: new URL(mediaLine, manifestUrl).href,
      ext: 'mp4',
      protocol: 'm3u8_native',
      ...(resolution
        ? { width: Number(resolution[1]), height: Number(resolution[2]) }
        : undefined),
      ...(attributes['FRAME-RATE'] ? { fps: Number(attributes['FRAME-RATE']) } : undefined),
      ...(bandwidth ? { tbr: bandwidth / 1_000 } : undefined),
      ...(videoCodec ? { vcodec: videoCodec } : undefined),
      ...(audioCodec ? { acodec: audioCodec } : undefined),
    })
  }

  if (formats.length === 0 && lines.some((line) => line.startsWith('#EXTINF:'))) {
    formats.push({
      format_id: 'hls',
      url: manifestUrl,
      ext: 'mp4',
      protocol: 'm3u8_native',
    })
  }
  return deduplicateFormats(formats)
}

export function parseMpdFormats(text: string, manifestUrl: string): Format[] {
  const formats: Format[] = []
  for (const adaptationMatch of text.matchAll(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/giu)) {
    const adaptation = parseXmlAttributes(adaptationMatch[1] ?? '')
    const adaptationBody = adaptationMatch[2] ?? ''
    const adaptationBase = firstXmlText(adaptationBody, 'BaseURL')
    for (const representationMatch of adaptationBody.matchAll(
      /<Representation\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Representation>)/giu,
    )) {
      const representation = { ...adaptation, ...parseXmlAttributes(representationMatch[1] ?? '') }
      const body = representationMatch[2] ?? ''
      const base = firstXmlText(body, 'BaseURL') ?? adaptationBase
      if (!base) continue
      const mimeType = representation.mimeType ?? ''
      const codecs = representation.codecs
      const bandwidth = numberOrUndefined(representation.bandwidth)
      const frameRate = parseFrameRate(representation.frameRate)
      const width = numberOrUndefined(representation.width)
      const height = numberOrUndefined(representation.height)
      formats.push({
        format_id: representation.id ?? `dash-${formats.length}`,
        url: new URL(decodeXml(base), manifestUrl).href,
        ext: mimeType.includes('webm') ? 'webm' : mimeType.startsWith('audio/') ? 'm4a' : 'mp4',
        protocol: 'https',
        ...(width !== undefined ? { width } : undefined),
        ...(height !== undefined ? { height } : undefined),
        ...(frameRate !== undefined ? { fps: frameRate } : undefined),
        ...(bandwidth !== undefined ? { tbr: bandwidth / 1_000 } : undefined),
        ...(mimeType.startsWith('video/') ? { vcodec: codecs ?? 'unknown', acodec: 'none' } : undefined),
        ...(mimeType.startsWith('audio/') ? { vcodec: 'none', acodec: codecs ?? 'unknown' } : undefined),
      })
    }
  }
  if (formats.length === 0) {
    formats.push({ format_id: 'dash', url: manifestUrl, ext: 'mp4', protocol: 'dash' })
  }
  return deduplicateFormats(formats)
}

function parseAttributes(value: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  const pattern = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))(?:,|$)/giu
  for (const match of value.matchAll(pattern)) attributes[match[1]!] = match[2] ?? match[3] ?? ''
  return attributes
}

function parseXmlAttributes(value: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const match of value.matchAll(/([:\w-]+)\s*=\s*["']([^"']*)["']/gu)) {
    attributes[match[1]!] = decodeXml(match[2] ?? '')
  }
  return attributes
}

function firstXmlText(value: string, tag: string): string | undefined {
  return new RegExp(`<${tag}\\b[^>]*>([^<]+)</${tag}>`, 'iu').exec(value)?.[1]?.trim()
}

function decodeXml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos);/gu, (entity) => ({
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&apos;': "'",
  })[entity]!)
}

function parseFrameRate(value: string | undefined): number | undefined {
  if (!value) return undefined
  const [numerator, denominator] = value.split('/').map(Number)
  const result = denominator ? numerator! / denominator : numerator
  return result !== undefined && Number.isFinite(result) ? result : undefined
}

function numberOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

export function deduplicateFormats(formats: Format[]): Format[] {
  const seen = new Set<string>()
  return formats.filter((format) => {
    const key = `${format.url}\0${format.format_id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
