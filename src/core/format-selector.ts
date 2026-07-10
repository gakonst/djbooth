import { YtdlpError } from './errors.js'
import type { Format } from './types.js'

export const DEFAULT_FORMAT_SPEC = 'bv*+ba/b'

export function selectFormats(formats: readonly Format[], specification = DEFAULT_FORMAT_SPEC): Format[] {
  if (formats.length === 0) throw new YtdlpError('NO_FORMATS', 'No formats are available')
  const selections = splitTopLevel(specification, ',').flatMap((part) => selectFallback(formats, part))
  if (selections.length === 0) {
    throw new YtdlpError('FORMAT_UNAVAILABLE', `Requested format is not available: ${specification}`)
  }
  const seen = new Set<string>()
  return selections.filter((format) => {
    const key = `${format.format_id}\0${format.url}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function selectFallback(formats: readonly Format[], value: string): Format[] {
  for (const alternative of splitTopLevel(value, '/')) {
    const selected = splitTopLevel(alternative, '+').flatMap((part) => selectAtom(formats, part))
    if (selected.length > 0) return selected
  }
  return []
}

function selectAtom(formats: readonly Format[], value: string): Format[] {
  const filters = [...value.matchAll(/\[([^\]]+)\]/gu)].map((match) => match[1]!)
  let base = value.replace(/\[[^\]]+\]/gu, '').trim()
  const indexMatch = /\.(\d+)$/u.exec(base)
  const index = indexMatch ? Number(indexMatch[1]) : 1
  if (indexMatch) base = base.slice(0, -indexMatch[0].length)
  const candidates = formats.filter((format) => filters.every((filter) => matchesFilter(format, filter)))

  if (base === 'all' || base === '*') return [...candidates].sort(compareQuality).reverse()
  const worst = /^(?:w|worst)/u.test(base)
  const normalized = base.replace(/\*$/u, '')
  const allowMuxed = base.endsWith('*')
  let matching: Format[]
  switch (normalized) {
    case 'b':
    case 'best':
    case 'w':
    case 'worst':
      matching = candidates.filter(hasAudioAndVideo)
      if (matching.length === 0) matching = candidates
      break
    case 'bv':
    case 'bestvideo':
    case 'wv':
    case 'worstvideo':
      matching = candidates.filter(
        (format) => hasVideo(format) && (allowMuxed || !hasAudio(format)),
      )
      break
    case 'ba':
    case 'bestaudio':
    case 'wa':
    case 'worstaudio':
      matching = candidates.filter(
        (format) => hasAudio(format) && (allowMuxed || !hasVideo(format)),
      )
      break
    default:
      matching = candidates.filter((format) => format.format_id === base)
  }
  matching.sort(compareQuality)
  const selected = worst ? matching[index - 1] : matching.at(-index)
  return selected ? [selected] : []
}

function matchesFilter(format: Format, expression: string): boolean {
  const match = /^([\w.-]+)\s*(\^=|\$=|\*=|~=|!=|<=|>=|=|<|>)\s*(.*?)\s*(\?)?$/u.exec(expression)
  if (!match) throw new YtdlpError('INVALID_FORMAT_FILTER', `Invalid format filter: [${expression}]`)
  const [, field, operator, rawExpected, allowUnknown] = match
  const actual = format[field!]
  if (actual === undefined || actual === null || actual === 'none') return Boolean(allowUnknown)
  const expected = unquote(rawExpected ?? '')
  const numericActual = typeof actual === 'number' ? actual : Number(actual)
  const numericExpected = Number(expected)
  const numeric = Number.isFinite(numericActual) && Number.isFinite(numericExpected)
  const left = String(actual)

  switch (operator) {
    case '=':
      return numeric ? numericActual === numericExpected : left.toLowerCase() === expected.toLowerCase()
    case '!=':
      return numeric ? numericActual !== numericExpected : left.toLowerCase() !== expected.toLowerCase()
    case '<':
      return numeric && numericActual < numericExpected
    case '<=':
      return numeric && numericActual <= numericExpected
    case '>':
      return numeric && numericActual > numericExpected
    case '>=':
      return numeric && numericActual >= numericExpected
    case '^=':
      return left.startsWith(expected)
    case '$=':
      return left.endsWith(expected)
    case '*=':
      return left.includes(expected)
    case '~=':
      return new RegExp(expected, 'u').test(left)
    default:
      return false
  }
}

function compareQuality(left: Format, right: Format): number {
  const fields: Array<keyof Format> = [
    'preference',
    'quality',
    'height',
    'width',
    'fps',
    'tbr',
    'vbr',
    'abr',
    'filesize',
    'filesize_approx',
  ]
  for (const field of fields) {
    const difference = number(left[field]) - number(right[field])
    if (difference !== 0) return difference
  }
  return left.format_id.localeCompare(right.format_id)
}

function hasVideo(format: Format): boolean {
  return format.vcodec !== 'none' && (format.vcodec !== undefined || format.height !== undefined)
}

function hasAudio(format: Format): boolean {
  return format.acodec !== 'none' && (format.acodec !== undefined || !hasVideo(format))
}

function hasAudioAndVideo(format: Format): boolean {
  return hasAudio(format) && hasVideo(format)
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : -1
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function splitTopLevel(value: string, delimiter: string): string[] {
  const parts: string[] = []
  let bracketDepth = 0
  let start = 0
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === '[') bracketDepth += 1
    else if (character === ']') bracketDepth -= 1
    else if (character === delimiter && bracketDepth === 0) {
      parts.push(value.slice(start, index).trim())
      start = index + 1
    }
  }
  parts.push(value.slice(start).trim())
  return parts.filter(Boolean)
}
