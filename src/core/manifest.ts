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

function parseAttributes(value: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  const pattern = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))(?:,|$)/giu
  for (const match of value.matchAll(pattern)) attributes[match[1]!] = match[2] ?? match[3] ?? ''
  return attributes
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
