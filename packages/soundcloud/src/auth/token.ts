import type { FetchLike, TokenSet } from './types.js'

export const authorizationBaseUrl = 'https://secure.soundcloud.com'

export interface TokenResponse {
  access_token?: string
  token_type?: string
  expires_in?: number | string
  refresh_token?: string
  scope?: string
  error?: string
  error_description?: string
}

export async function requestToken(options: {
  fetch: FetchLike
  parameters: Record<string, string>
  basicCredentials?: { clientId: string; clientSecret: string }
}): Promise<TokenSet> {
  const headers = new Headers({
    accept: 'application/json; charset=utf-8',
    'content-type': 'application/x-www-form-urlencoded',
  })
  if (options.basicCredentials) {
    const { clientId, clientSecret } = options.basicCredentials
    headers.set(
      'authorization',
      `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    )
  }

  let response: Response | undefined
  for (let attempt = 1; attempt <= 3; attempt++) {
    response = await options.fetch(`${authorizationBaseUrl}/oauth/token`, {
      method: 'POST',
      headers,
      body: new URLSearchParams(options.parameters),
    })
    if (response.status !== 429 || attempt === 3) break

    const retryAfter = parseRetryAfter(response.headers.get('retry-after'))
    if (retryAfter !== undefined && retryAfter > 10_000) break
    await response.body?.cancel()
    await sleep(
      retryAfter ?? Math.round(Math.random() * 250 * 2 ** (attempt - 1)),
    )
  }
  if (!response)
    throw new Error(
      'SoundCloud authorization failed before receiving a response',
    )
  const body = (await response.json().catch(() => undefined)) as
    TokenResponse | undefined
  const expiresIn = Number(body?.expires_in)
  if (
    !response.ok ||
    !body?.access_token ||
    !body.refresh_token ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    const message =
      body?.error_description ??
      body?.error ??
      (!body?.refresh_token && response.ok
        ? 'response did not include a replacement refresh token'
        : response.statusText)
    throw new Error(
      `SoundCloud authorization failed (${response.status}): ${message}`,
    )
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + expiresIn * 1000,
    scope: body.scope ?? '',
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp)
    ? undefined
    : Math.max(0, timestamp - Date.now())
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
