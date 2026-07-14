export class YtdlpError extends Error {
  readonly code: string
  readonly details?: Record<string, unknown>

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'YtdlpError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

const NATIVE_FALLBACK_ERROR_CODES = [
  'FORMAT_UNAVAILABLE',
  'NATIVE_OPTION_UNAVAILABLE',
  'NATIVE_PLAYLIST_UNSUPPORTED',
  'NO_FORMATS',
  'RANGE_NOT_SUPPORTED',
  'SOUNDCLOUD_CLIENT_ID_MISSING',
  'SOUNDCLOUD_NO_FORMATS',
  'SOUNDCLOUD_TRACK_UNAVAILABLE',
  'UNSUPPORTED_URL',
  'YOUTUBE_DIRECT_FORMATS_UNAVAILABLE',
] as const

export type NativeFallbackErrorCode = (typeof NATIVE_FALLBACK_ERROR_CODES)[number]

export interface NativeFallback {
  from: 'native'
  code: NativeFallbackErrorCode
}

const nativeFallbackErrorCodes: ReadonlySet<string> = new Set(NATIVE_FALLBACK_ERROR_CODES)

/**
 * Returns fallback provenance only for typed native capability gaps detected before response bytes
 * are committed. Abort, network, lock, write, identity, and content-validation failures fail closed.
 */
export function nativeFallbackFor(error: unknown): NativeFallback | undefined {
  if (!(error instanceof YtdlpError) || !nativeFallbackErrorCodes.has(error.code)) return undefined
  return { from: 'native', code: error.code as NativeFallbackErrorCode }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
