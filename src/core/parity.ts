import type { Format, MediaInfo } from './types.js'

export interface ParityDifference {
  field: string
  native: unknown
  reference: unknown
}

export interface ParityReport {
  matches: boolean
  differences: ParityDifference[]
  nativeFormatCount: number
  referenceFormatCount: number
  nativeSubtitleLanguages: string[]
  referenceSubtitleLanguages: string[]
}

const INFO_FIELDS: Array<keyof MediaInfo> = [
  'id',
  'title',
  'description',
  'uploader',
  'uploader_id',
  'channel',
  'channel_id',
  'duration',
  'timestamp',
  'upload_date',
  'live_status',
  'view_count',
  'like_count',
  'age_limit',
]

const FORMAT_FIELDS: Array<keyof Format> = [
  'ext',
  'width',
  'height',
  'fps',
  'vcodec',
  'acodec',
  'tbr',
  'abr',
  'language',
]

export function compareMediaInfo(native: MediaInfo, reference: MediaInfo): ParityReport {
  const differences: ParityDifference[] = []
  for (const field of INFO_FIELDS) {
    compareField(String(field), native[field], reference[field], differences)
  }

  const nativeFormats = native.formats ?? []
  const referenceFormats = reference.formats ?? []
  const referenceById = new Map(referenceFormats.map((format) => [format.format_id, format]))
  for (const nativeFormat of nativeFormats) {
    const referenceFormat = referenceById.get(nativeFormat.format_id)
    if (!referenceFormat) continue
    for (const field of FORMAT_FIELDS) {
      compareField(
        `formats.${nativeFormat.format_id}.${String(field)}`,
        nativeFormat[field],
        referenceFormat[field],
        differences,
      )
    }
  }

  const nativeSubtitleLanguages = subtitleLanguages(native)
  const referenceSubtitleLanguages = subtitleLanguages(reference)
  compareField('subtitle_languages', nativeSubtitleLanguages, referenceSubtitleLanguages, differences)
  compareField('format_count', nativeFormats.length, referenceFormats.length, differences)

  return {
    matches: differences.length === 0,
    differences,
    nativeFormatCount: nativeFormats.length,
    referenceFormatCount: referenceFormats.length,
    nativeSubtitleLanguages,
    referenceSubtitleLanguages,
  }
}

function compareField(
  field: string,
  native: unknown,
  reference: unknown,
  differences: ParityDifference[],
): void {
  if (equivalent(native, reference)) return
  differences.push({ field, native: native ?? null, reference: reference ?? null })
}

function equivalent(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (typeof left === 'number' && typeof right === 'number') {
    return Math.abs(left - right) <= Math.max(0.001, Math.abs(right) * 0.001)
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => equivalent(value, right[index]))
  }
  return false
}

function subtitleLanguages(info: MediaInfo): string[] {
  return [...new Set([...Object.keys(info.subtitles ?? {}), ...Object.keys(info.automatic_captions ?? {})])].sort()
}
