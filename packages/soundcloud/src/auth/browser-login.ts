import { createServer } from 'node:http'

import open from 'open'

import type { SoundCloudOAuth } from './oauth.js'
import type { TokenSet } from './types.js'

export interface BrowserLoginOptions {
  oauth: SoundCloudOAuth
  openBrowser?: boolean
  timeoutMs?: number
  onAuthorizationUrl?: (url: string) => void
}

export async function loginWithBrowser(
  options: BrowserLoginOptions,
): Promise<TokenSet> {
  const redirect = new URL(options.oauth.redirectUri)
  const isLoopback =
    redirect.hostname === '127.0.0.1' || redirect.hostname === '[::1]'
  if (redirect.protocol !== 'http:' || !isLoopback) {
    throw new Error(
      'Browser login requires an http://127.0.0.1 or http://[::1] redirect URI',
    )
  }
  const port = Number(redirect.port)
  if (!port) throw new Error('Browser login redirect URI must include a port')

  const authorization = options.oauth.createAuthorizationRequest()
  let settle: ((code: string) => void) | undefined
  let rejectCallback: ((error: Error) => void) | undefined
  const callback = new Promise<string>((resolve, reject) => {
    settle = resolve
    rejectCallback = reject
  })
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', redirect.origin)
    if (requestUrl.pathname !== redirect.pathname) {
      response.writeHead(404).end('Not found')
      return
    }

    const state = requestUrl.searchParams.get('state')
    const error = requestUrl.searchParams.get('error')
    const code = requestUrl.searchParams.get('code')
    if (!options.oauth.verifyState(authorization.state, state)) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Invalid OAuth state. Return to the terminal and try again.')
      return
    }
    if (error || !code) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(
        `SoundCloud authorization failed: ${error ?? 'missing code'}`,
      )
      rejectCallback?.(
        new Error(
          `SoundCloud authorization failed: ${error ?? 'missing code'}`,
        ),
      )
      return
    }

    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(
      '<!doctype html><title>SoundCloud authorized</title><h1>SoundCloud connected</h1><p>You can close this tab and return to the terminal.</p>',
    )
    settle?.(code)
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(
      port,
      redirect.hostname.replaceAll('[', '').replaceAll(']', ''),
      () => {
        server.off('error', onError)
        server.on('error', (error) => rejectCallback?.(error))
        resolve()
      },
    )
  })

  const timeout = setTimeout(() => {
    rejectCallback?.(
      new Error('Timed out waiting for SoundCloud authorization'),
    )
  }, options.timeoutMs ?? 300_000)
  timeout.unref()

  try {
    options.onAuthorizationUrl?.(authorization.url)
    if (options.openBrowser !== false)
      await open(authorization.url).catch(() => undefined)
    const code = await callback
    return await options.oauth.exchangeCode(code, authorization.verifier)
  } finally {
    clearTimeout(timeout)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
