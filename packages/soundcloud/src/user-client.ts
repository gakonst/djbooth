import { FileSessionStore } from './auth/store.js'
import { SoundCloudOAuth } from './auth/oauth.js'
import { SoundCloudClient, type SoundCloudClientOptions } from './client.js'

export interface CreateSoundCloudUserClientOptions extends Omit<
  SoundCloudClientOptions,
  'auth'
> {
  /** Explicit user access token. Defaults to SOUNDCLOUD_ACCESS_TOKEN. */
  accessToken?: string
  /** OAuth application secret. Defaults to SOUNDCLOUD_CLIENT_SECRET. */
  clientSecret?: string
  /** Saved Authorization Code session path. */
  credentialsPath?: string
}

/**
 * Create a client that requires user authorization and never falls back to
 * Client Credentials. An explicit access token must be a user access token.
 */
export async function createSoundCloudUserClient(
  options: CreateSoundCloudUserClientOptions = {},
): Promise<SoundCloudClient> {
  const {
    accessToken = process.env.SOUNDCLOUD_ACCESS_TOKEN,
    clientSecret = process.env.SOUNDCLOUD_CLIENT_SECRET,
    credentialsPath,
    ...clientOptions
  } = options
  if (accessToken)
    return new SoundCloudClient({
      ...clientOptions,
      auth: accessToken,
    })

  const store = new FileSessionStore(credentialsPath)
  const session = await store.load()
  if (session?.grantType !== 'authorization_code' || !session.redirectUri) {
    throw new Error(
      'SoundCloud user authentication required; run `soundcloud auth login` or set a user SOUNDCLOUD_ACCESS_TOKEN',
    )
  }
  if (!clientSecret) {
    throw new Error(
      'Saved SoundCloud login requires SOUNDCLOUD_CLIENT_SECRET to refresh its user token',
    )
  }
  return new SoundCloudClient({
    ...clientOptions,
    auth: new SoundCloudOAuth({
      clientId: session.clientId,
      clientSecret,
      redirectUri: session.redirectUri,
      store,
      ...(clientOptions.fetch ? { fetch: clientOptions.fetch } : {}),
    }),
  })
}
