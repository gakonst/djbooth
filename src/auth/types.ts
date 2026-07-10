export interface TokenSet {
  accessToken: string
  tokenType: 'Bearer'
  expiresAt: number
  scopes: string[]
  refreshToken?: string
}

export interface StoredSession {
  version: 1
  clientId: string
  redirectUri: string
  token: TokenSet
}

export interface SessionStore {
  load(): Promise<StoredSession | undefined>
  save(session: StoredSession): Promise<void>
  clear(): Promise<void>
}

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>
  invalidateAccessToken?(): Promise<void> | void
}

export interface FetchLike {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>
}
