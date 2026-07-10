import { YtdlpError } from './errors.js'

export const DEFAULT_HEADERS: Readonly<Record<string, string>> = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-us,en;q=0.5',
  'Sec-Fetch-Mode': 'navigate',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
}

export interface RequestOptions {
  headers?: Record<string, string>
  retries?: number
  timeoutMs?: number
  signal?: AbortSignal
}

export async function request(url: string, options: RequestOptions = {}): Promise<Response> {
  const retries = options.retries ?? 2
  let lastError: unknown

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 20_000)
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
    try {
      const response = await fetch(url, {
        headers: { ...DEFAULT_HEADERS, ...options.headers },
        redirect: 'follow',
        signal,
      })
      if (response.ok) return response
      if (response.status < 500 || attempt === retries) {
        throw new YtdlpError('HTTP_ERROR', `HTTP ${response.status} for ${url}`, {
          status: response.status,
          url,
        })
      }
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      if (error instanceof YtdlpError) throw error
      lastError = error
      if (options.signal?.aborted) throw new YtdlpError('ABORTED', 'Request was aborted')
      if (attempt === retries) break
    }
    await sleep(Math.min(250 * 2 ** attempt, 2_000), options.signal)
  }

  throw new YtdlpError('NETWORK_ERROR', `Unable to fetch ${url}`, {
    cause: lastError instanceof Error ? lastError.message : String(lastError),
  })
}

export async function downloadText(
  url: string,
  options: RequestOptions & { maxBytes?: number } = {},
): Promise<{ response: Response; text: string }> {
  const response = await request(url, options)
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new YtdlpError('RESPONSE_TOO_LARGE', `Response exceeds ${maxBytes} bytes`, {
      contentLength: declaredLength,
      url,
    })
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > maxBytes) {
    throw new YtdlpError('RESPONSE_TOO_LARGE', `Response exceeds ${maxBytes} bytes`, {
      contentLength: buffer.byteLength,
      url,
    })
  }
  return { response, text: buffer.toString('utf8') }
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new YtdlpError('ABORTED', 'Request was aborted'))
      },
      { once: true },
    )
  })
}
