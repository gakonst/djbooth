export class SpotifyApiError extends Error {
  readonly status: number
  readonly headers: Headers
  readonly body: unknown

  constructor(options: { status: number; statusText: string; headers: Headers; body: unknown }) {
    const detail = errorMessage(options.body)
    super(`Spotify API error ${options.status}${detail ? `: ${detail}` : ` ${options.statusText}`}`)
    this.name = 'SpotifyApiError'
    this.status = options.status
    this.headers = options.headers
    this.body = options.body
  }

  static async fromResponse(response: Response): Promise<SpotifyApiError> {
    const clone = response.clone()
    const contentType = clone.headers.get('content-type') ?? ''
    const body = contentType.includes('json')
      ? await clone.json().catch(() => undefined)
      : await clone.text().catch(() => undefined)
    return new SpotifyApiError({
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body,
    })
  }
}

function errorMessage(body: unknown): string | undefined {
  if (typeof body === 'string') return body || undefined
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  if (typeof record.message === 'string') return record.message
  if (typeof record.error === 'string') return record.error
  if (typeof record.error === 'object' && record.error !== null) {
    const nested = record.error as Record<string, unknown>
    if (typeof nested.message === 'string') return nested.message
  }
  return undefined
}
