export type SoundCloudGrantType = 'authorization_code' | 'client_credentials'

export interface TokenSet {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scope: string
}

export interface StoredSession {
  version: 1
  grantType: SoundCloudGrantType
  clientId: string
  /**
   * Confidential OAuth app credential retained only when an interactive local
   * login explicitly opts in. FileSessionStore protects the session as 0600.
   */
  clientSecret?: string
  redirectUri?: string
  token: TokenSet
}

export interface SessionStore {
  load(): Promise<StoredSession | undefined>
  save(session: StoredSession): Promise<void>
  clear(): Promise<void>
  withLock?<T>(task: () => Promise<T>): Promise<T>
}

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>
  invalidateAccessToken?(accessToken?: string): Promise<void> | void
}

export interface FetchLike {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>
}
