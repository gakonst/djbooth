import { createServer } from 'node:http'

import open from 'open'

import type { TokenSet } from './types.js'
import type { SpotifyOAuth } from './oauth.js'

export interface BrowserLoginOptions {
  oauth: SpotifyOAuth
  scopes: readonly string[]
  openBrowser?: boolean
  timeoutMs?: number
  onAuthorizationUrl?: (url: string) => void
}

export async function loginWithBrowser(options: BrowserLoginOptions): Promise<TokenSet> {
  const redirect = new URL(options.oauth.redirectUri)
  const isLoopback = redirect.hostname === '127.0.0.1' || redirect.hostname === '[::1]'
  if (redirect.protocol !== 'http:' || !isLoopback) {
    throw new Error('Browser login requires an http://127.0.0.1 or http://[::1] redirect URI')
  }
  const port = Number(redirect.port)
  if (!port) throw new Error('Browser login redirect URI must include a port')

  const authorization = options.oauth.createAuthorizationRequest(options.scopes)
  const callback = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close()
      reject(new Error('Timed out waiting for Spotify authorization'))
    }, options.timeoutMs ?? 300_000)
    timeout.unref()

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
        response.end(`Spotify authorization failed: ${error ?? 'missing code'}`)
        clearTimeout(timeout)
        server.close()
        reject(new Error(`Spotify authorization failed: ${error ?? 'missing code'}`))
        return
      }

      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(
        '<!doctype html><title>spots authorized</title><h1>Spotify connected</h1><p>You can close this tab and return to the terminal.</p>',
      )
      clearTimeout(timeout)
      server.close()
      resolve(code)
    })

    server.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    server.listen(port, redirect.hostname.replaceAll('[', '').replaceAll(']', ''))
  })

  options.onAuthorizationUrl?.(authorization.url)
  if (options.openBrowser !== false) await open(authorization.url)
  const code = await callback
  return options.oauth.exchangeCode(code, authorization.verifier)
}
