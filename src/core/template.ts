import type { MediaInfo } from './types.js'

export const DEFAULT_OUTPUT_TEMPLATE = '%(title)s [%(id)s].%(ext)s'

export function renderOutputTemplate(
  template: string,
  info: MediaInfo,
  extension: string,
): string {
  const fields: Record<string, unknown> = { ...info, ext: extension }
  const rendered = template.replace(
    /%%|%\(([^)]+)\)([-+0 #]*)(\d+)?(?:\.(\d+))?([sdif])/gu,
    (token, fieldList: string | undefined, flags: string, width: string | undefined, precision: string | undefined, type: string | undefined) => {
      if (token === '%%') return '%'
      const field = fieldList!.split(',').find((name) => fields[name] !== undefined) ?? fieldList!
      const raw = fields[field]
      let value = raw === undefined || raw === null ? 'NA' : formatValue(raw, type!)
      if (precision) value = value.slice(0, Number(precision))
      if (width && value.length < Number(width)) {
        const fill = flags.includes('0') ? '0' : ' '
        value = flags.includes('-') ? value.padEnd(Number(width), fill) : value.padStart(Number(width), fill)
      }
      return sanitizeComponent(value)
    },
  )
  return rendered || `${sanitizeComponent(info.id)}.${sanitizeComponent(extension)}`
}

export function sanitizeComponent(value: string): string {
  const sanitized = value
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/[\\/:*?"<>|]/gu, '_')
    .replace(/[. ]+$/gu, '')
  return sanitized || '_'
}

function formatValue(value: unknown, type: string): string {
  if (type === 'd' || type === 'i') return Math.trunc(Number(value)).toString()
  if (type === 'f') return Number(value).toString()
  return typeof value === 'string' ? value : JSON.stringify(value)
}
