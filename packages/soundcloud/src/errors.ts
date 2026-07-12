export interface SoundCloudRateLimit {
  group?: string
  maxRequests?: number
  remainingRequests?: number
  resetTime?: string
  timeWindow?: string
}

export class SoundCloudApiError extends Error {
  readonly status: number
  readonly headers: Headers
  readonly body: unknown
  readonly code: number | string | undefined
  readonly link: string | undefined
  readonly rateLimit: SoundCloudRateLimit | undefined

  constructor(options: {
    status: number
    statusText: string
    headers: Headers
    body: unknown
  }) {
    const detail = errorMessage(options.body)
    super(
      `SoundCloud API error ${options.status}${detail ? `: ${detail}` : ` ${options.statusText}`}`,
    )
    this.name = 'SoundCloudApiError'
    this.status = options.status
    this.headers = options.headers
    this.body = options.body
    this.code = errorCode(options.body)
    this.link = errorLink(options.body)
    this.rateLimit = rateLimit(options.body)
  }

  static async fromResponse(response: Response): Promise<SoundCloudApiError> {
    const clone = response.clone()
    const contentType = clone.headers.get('content-type') ?? ''
    const body: unknown = contentType.includes('json')
      ? await clone.json().catch(() => undefined)
      : await clone.text().catch(() => undefined)
    return new SoundCloudApiError({
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body,
    })
  }
}

function errorMessage(body: unknown): string | undefined {
  if (typeof body === 'string') return body || undefined
  const record = asRecord(body)
  if (!record) return undefined
  if (typeof record.message === 'string') return record.message
  if (typeof record.error_description === 'string')
    return record.error_description
  if (typeof record.error === 'string') return record.error
  if (Array.isArray(record.errors)) {
    for (const value of record.errors) {
      const error = asRecord(value)
      if (typeof error?.error_message === 'string') return error.error_message
    }
  }
  return undefined
}

function errorCode(body: unknown): number | string | undefined {
  const value = asRecord(body)?.code
  return typeof value === 'number' || typeof value === 'string'
    ? value
    : undefined
}

function errorLink(body: unknown): string | undefined {
  const value = asRecord(body)?.link
  return typeof value === 'string' ? value : undefined
}

function rateLimit(body: unknown): SoundCloudRateLimit | undefined {
  const errors = asRecord(body)?.errors
  if (!Array.isArray(errors)) return undefined
  for (const value of errors) {
    const error = asRecord(value)
    const meta = asRecord(error?.meta)
    const limit = asRecord(meta?.rate_limit)
    if (!limit && !meta) continue
    return {
      ...(typeof limit?.group === 'string' ? { group: limit.group } : {}),
      ...(typeof limit?.max_nr_of_requests === 'number'
        ? { maxRequests: limit.max_nr_of_requests }
        : {}),
      ...(typeof meta?.remaining_requests === 'number'
        ? { remainingRequests: meta.remaining_requests }
        : {}),
      ...(typeof meta?.reset_time === 'string'
        ? { resetTime: meta.reset_time }
        : {}),
      ...(typeof limit?.time_window === 'string'
        ? { timeWindow: limit.time_window }
        : {}),
    }
  }
  return undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
