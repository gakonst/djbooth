export const SPOTIFY_SCOPES = [
  'app-remote-control',
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-public',
  'playlist-modify-private',
  'user-library-read',
  'user-library-modify',
  'user-read-private',
  'user-read-email',
  'user-follow-read',
  'user-follow-modify',
  'user-top-read',
  'user-read-playback-position',
  'user-read-playback-state',
  'user-read-recently-played',
  'user-read-currently-playing',
  'user-modify-playback-state',
  'ugc-image-upload',
  'streaming',
] as const

export type SpotifyScope = (typeof SPOTIFY_SCOPES)[number]

export const DEFAULT_SCOPES: readonly SpotifyScope[] = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
  'user-read-private',
  'user-follow-read',
  'user-top-read',
  'user-read-playback-position',
  'user-read-playback-state',
  'user-read-recently-played',
  'user-read-currently-playing',
]
