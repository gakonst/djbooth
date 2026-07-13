#!/usr/bin/env node

import { existsSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadEnvFile } from 'node:process'
import { pathToFileURL } from 'node:url'

import { Cli, z } from 'incur'

import packageJson from '../package.json' with { type: 'json' }
import {
  DEFAULT_SCOPES,
  FileSessionStore,
  SPOTIFY_SCOPES,
  SpotifyOAuth,
  loginWithBrowser,
} from './auth/index.js'
import { ClientCredentialsProvider, StaticAccessTokenProvider } from './auth/providers.js'
import { SpotifyClient } from './client.js'
import { SpotifyApiError } from './errors.js'
import spotifyOpenApi from './generated/spotify-openapi.json' with { type: 'json' }

function loadWorkspaceEnvironment(): void {
  const candidates = [resolve(import.meta.dirname, '../../../.env'), resolve(process.cwd(), '.env')]
  const path = candidates.find((candidate) => existsSync(candidate))
  if (path) loadEnvFile(path)
}

export const spotsCli = Cli.create('spots', {
  version: packageJson.version,
  description: 'Typed Spotify Web API client for humans and agents.',
  sync: {
    suggestions: [
      'show my recently played Spotify tracks',
      'search Spotify for an artist',
      'show my Spotify profile',
      'list my saved Spotify albums',
      'create a Spotify playlist from these tracks',
    ],
  },
})
const cli = spotsCli

const auth = Cli.create('auth', { description: 'Authenticate with Spotify.' })

auth.command('login', {
  description: 'Log in as a Spotify user with Authorization Code + PKCE.',
  env: z.object({
    SPOTIFY_CLIENT_ID: z.string().optional().describe('Spotify application client ID'),
    SPOTIFY_CLIENT_SECRET: z.string().optional().describe('Optional Spotify application secret'),
    SPOTIFY_REDIRECT_URI: z.string().optional().describe('Registered loopback redirect URI'),
  }),
  options: z.object({
    clientId: z.string().optional().describe('Spotify application client ID'),
    redirectUri: z
      .string()
      .optional()
      .describe('Registered loopback redirect URI (default http://127.0.0.1:8787/callback)'),
    scopes: z.string().optional().describe('Comma- or space-separated OAuth scopes'),
    allScopes: z.boolean().default(false).describe('Request every Web API scope'),
    noBrowser: z.boolean().default(false).describe('Print the URL without opening a browser'),
  }),
  alias: { clientId: 'i' },
  examples: [{ description: 'Log in with the default read scopes' }],
  async run(context) {
    const clientId = context.options.clientId ?? context.env.SPOTIFY_CLIENT_ID
    if (!clientId) {
      throw new Error('Spotify client ID required via --client-id or SPOTIFY_CLIENT_ID')
    }
    const redirectUri =
      context.options.redirectUri ??
      context.env.SPOTIFY_REDIRECT_URI ??
      'http://127.0.0.1:8787/callback'
    const store = new FileSessionStore()
    const oauth = new SpotifyOAuth({
      clientId,
      redirectUri,
      store,
      ...(context.env.SPOTIFY_CLIENT_SECRET
        ? { clientSecret: context.env.SPOTIFY_CLIENT_SECRET }
        : {}),
    })
    const scopes = context.options.allScopes
      ? SPOTIFY_SCOPES
      : context.options.scopes
        ? parseScopes(context.options.scopes)
        : DEFAULT_SCOPES

    const token = await loginWithBrowser({
      oauth,
      scopes,
      openBrowser: !context.options.noBrowser,
      onAuthorizationUrl(url) {
        process.stderr.write(`Open this URL to authorize spots:\n${url}\n`)
      },
    })
    return {
      loggedIn: true,
      expiresAt: new Date(token.expiresAt).toISOString(),
      scopes: token.scopes,
      credentialsPath: store.path,
    }
  },
})

auth.command('status', {
  description: 'Show the saved login and verify it against Spotify.',
  async run() {
    const store = new FileSessionStore()
    const session = await store.load()
    if (!session) return { loggedIn: false, credentialsPath: store.path }
    const client = await createSpotifyClient()
    const result = await client.GET('/me')
    const profile = await unwrap(result)
    return {
      loggedIn: true,
      clientId: session.clientId,
      expiresAt: new Date(session.token.expiresAt).toISOString(),
      scopes: session.token.scopes,
      profile,
      credentialsPath: store.path,
    }
  },
})

auth.command('refresh', {
  description: 'Refresh the saved Spotify user token now.',
  async run() {
    const store = new FileSessionStore()
    const session = await store.load()
    if (!session) throw new Error('Not logged in to Spotify; run `spots auth login`')
    const oauth = new SpotifyOAuth({
      clientId: session.clientId,
      redirectUri: session.redirectUri,
      store,
      ...(process.env.SPOTIFY_CLIENT_SECRET
        ? { clientSecret: process.env.SPOTIFY_CLIENT_SECRET }
        : {}),
    })
    const token = await oauth.refresh()
    return { refreshed: true, expiresAt: new Date(token.expiresAt).toISOString() }
  },
})

auth.command('logout', {
  description: 'Delete the locally saved Spotify session.',
  async run() {
    const store = new FileSessionStore()
    await store.clear()
    return { loggedOut: true, credentialsPath: store.path }
  },
})

auth.command('scopes', {
  description: 'List the OAuth scopes understood by this Spotify schema.',
  run() {
    return { default: DEFAULT_SCOPES, available: SPOTIFY_SCOPES }
  },
})

cli.command(auth)

cli.command('me', {
  description: "Get the logged-in user's Spotify profile.",
  async run() {
    return unwrap(await (await createSpotifyClient()).GET('/me'))
  },
})

cli.command('recent', {
  description: "Get the logged-in user's recently played tracks.",
  options: z.object({
    limit: z.coerce.number().int().min(1).max(50).default(20).describe('Items per request'),
    after: z.coerce.number().int().optional().describe('Unix timestamp in milliseconds'),
    before: z.coerce.number().int().optional().describe('Unix timestamp in milliseconds'),
    all: z.boolean().default(false).describe('Follow pagination until no next page remains'),
  }),
  examples: [
    { description: 'Show the 20 most recent plays' },
    { options: { limit: 50, all: true }, description: 'Follow every available page' },
  ],
  async run(context) {
    const client = await createSpotifyClient()
    const query = {
      limit: context.options.limit,
      ...(context.options.after !== undefined ? { after: context.options.after } : {}),
      ...(context.options.before !== undefined ? { before: context.options.before } : {}),
    }
    if (context.options.all) {
      const items = []
      for await (const item of client.paginate('/me/player/recently-played', query))
        items.push(item)
      return { items, total: items.length }
    }
    return unwrap(
      await client.GET('/me/player/recently-played', {
        params: { query },
      }),
    )
  },
})

const playlist = Cli.create('playlist', { description: 'Create and manage Spotify playlists.' })

playlist.command('create', {
  description: 'Create a Spotify playlist and add tracks in the supplied order.',
  destructive: true,
  args: z.object({ name: z.string().min(1).describe('Playlist name') }),
  options: z.object({
    track: z
      .array(z.string().min(1))
      .default([])
      .describe('Spotify track URI, open.spotify.com URL, or ID; repeat in playlist order'),
    inputFile: z
      .string()
      .optional()
      .describe('Text file with one Spotify track URI, URL, or ID per line'),
    visibility: z
      .enum(['private', 'public'])
      .default('private')
      .describe('Whether the playlist is private or public'),
    collaborative: z.boolean().default(false).describe('Allow other Spotify users to modify it'),
    description: z.string().optional().describe('Playlist description'),
  }),
  examples: [
    {
      args: { name: 'Late night' },
      options: { track: ['spotify:track:4iV5W9uYEdYUVa79Axb7Rh'] },
      description: 'Create a private playlist from one track',
    },
    {
      args: { name: 'Shared finds' },
      options: { inputFile: 'tracks.txt', collaborative: true },
      description: 'Create a collaborative private playlist from a file',
    },
  ],
  async run(context) {
    const fileTracks = context.options.inputFile
      ? await readTrackReferences(context.options.inputFile)
      : []
    const tracks = [...context.options.track, ...fileTracks]
    const isPublic = context.options.visibility === 'public'
    if (context.options.collaborative && isPublic) {
      throw new Error('A collaborative Spotify playlist must use --visibility private')
    }
    await assertPlaylistWriteScopes({
      public: isPublic,
      collaborative: context.options.collaborative,
    })

    try {
      const result = await (
        await createSpotifyClient()
      ).createPlaylistWithTracks({
        name: context.args.name,
        tracks,
        public: isPublic,
        collaborative: context.options.collaborative,
        ...(context.options.description === undefined
          ? {}
          : { description: context.options.description }),
      })
      return {
        playlist: result.playlist,
        tracksAdded: result.trackUris.length,
        batches: result.snapshotIds.length,
        trackUris: result.trackUris,
        snapshotIds: result.snapshotIds,
      }
    } catch (error) {
      if (error instanceof SpotifyApiError && error.status === 403) {
        const scopes = requiredPlaylistWriteScopes(isPublic, context.options.collaborative)
        throw new Error(
          `Spotify refused playlist creation; log in again with: spots auth login --scopes '${scopes.join(',')}'`,
          { cause: error },
        )
      }
      throw error
    }
  },
})

playlist.command('get', {
  description: 'Read a Spotify playlist by ID, URI, or URL.',
  args: z.object({ playlist: z.string().min(1).describe('Spotify playlist ID, URI, or URL') }),
  async run(context) {
    return (await createSpotifyClient()).getPlaylist(context.args.playlist)
  },
})

playlist.command('update', {
  description: 'Update Spotify playlist details and optionally replace all tracks.',
  destructive: true,
  args: z.object({ playlist: z.string().min(1).describe('Spotify playlist ID, URI, or URL') }),
  options: z.object({
    name: z.string().min(1).optional().describe('New playlist name'),
    description: z.string().optional().describe('New playlist description'),
    visibility: z.enum(['private', 'public']).optional().describe('New playlist visibility'),
    collaborative: z.boolean().optional().describe('New collaborative state'),
    track: z
      .array(z.string().min(1))
      .optional()
      .describe('Replacement track URI, URL, or ID; repeat in playlist order'),
    inputFile: z.string().optional().describe('Replacement tracks, one reference per line'),
    clearTracks: z.boolean().default(false).describe('Remove every track from the playlist'),
  }),
  async run(context) {
    if (
      context.options.clearTracks &&
      (context.options.track !== undefined || context.options.inputFile !== undefined)
    ) {
      throw new Error('--clear-tracks cannot be combined with --track or --input-file')
    }
    const fileTracks = context.options.inputFile
      ? await readTrackReferences(context.options.inputFile)
      : []
    const hasTrackUpdate =
      context.options.clearTracks ||
      context.options.track !== undefined ||
      context.options.inputFile !== undefined
    const isPublic =
      context.options.visibility === undefined ? undefined : context.options.visibility === 'public'
    if (context.options.collaborative === true && isPublic !== false) {
      throw new Error('Making a playlist collaborative requires --visibility private')
    }
    await assertSpotifyScopes(
      requiredPlaylistWriteScopes(isPublic, context.options.collaborative === true),
    )
    return (await createSpotifyClient()).updatePlaylist(context.args.playlist, {
      ...(context.options.name === undefined ? {} : { name: context.options.name }),
      ...(context.options.description === undefined
        ? {}
        : { description: context.options.description }),
      ...(isPublic === undefined ? {} : { public: isPublic }),
      ...(context.options.collaborative === undefined
        ? {}
        : { collaborative: context.options.collaborative }),
      ...(hasTrackUpdate
        ? {
            tracks: context.options.clearTracks
              ? []
              : [...(context.options.track ?? []), ...fileTracks],
          }
        : {}),
    })
  },
})

playlist.command('delete', {
  description:
    "Remove a playlist from the current user's library (Spotify has no permanent delete API).",
  destructive: true,
  args: z.object({ playlist: z.string().min(1).describe('Spotify playlist ID, URI, or URL') }),
  async run(context) {
    await assertSpotifyScopes(['user-library-modify'])
    return (await createSpotifyClient()).deletePlaylist(context.args.playlist)
  },
})

cli.command(playlist)

cli.command('request', {
  description: 'Make a raw authenticated Spotify request (forward-compatibility escape hatch).',
  args: z.object({
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).describe('HTTP method'),
    path: z.string().describe('API path relative to /v1, or a full Spotify API URL'),
  }),
  options: z.object({
    query: z.string().optional().describe('Query parameters as a JSON object'),
    body: z.string().optional().describe('JSON body, plain text, or @path to read a file'),
    headers: z.string().optional().describe('Headers as a JSON object'),
  }),
  examples: [
    { args: { method: 'GET', path: '/me' }, description: 'Get the current user profile' },
    {
      args: { method: 'GET', path: '/search' },
      options: { query: '{"q":"Miles Davis","type":"artist"}' },
      description: 'Search for an artist',
    },
  ],
  async run(context) {
    const headers = context.options.headers
      ? parseJsonRecord(context.options.headers, '--headers')
      : undefined
    const query = context.options.query
      ? parseJsonRecord(context.options.query, '--query')
      : undefined
    const body = await parseBody(context.options.body)
    return (await createSpotifyClient()).raw(context.args.method, context.args.path, {
      ...(headers ? { headers: stringRecord(headers, '--headers') } : {}),
      ...(query ? { query: queryRecord(query) } : {}),
      ...(body !== undefined ? { body } : {}),
    })
  },
})

cli.command('api', {
  description: 'All operations from the official Spotify OpenAPI schema.',
  openapi: spotifyOpenApi,
  fetch: async (request: Request) => (await createSpotifyClient()).fetch(request),
})

export async function runSpotsCli(argv = process.argv.slice(2)): Promise<void> {
  loadWorkspaceEnvironment()
  await spotsCli.serve(argv)
}

async function createSpotifyClient(): Promise<SpotifyClient> {
  if (process.env.SPOTIFY_ACCESS_TOKEN) {
    return new SpotifyClient({
      auth: new StaticAccessTokenProvider(process.env.SPOTIFY_ACCESS_TOKEN),
    })
  }

  const store = new FileSessionStore()
  const session = await store.load()
  if (session) {
    return new SpotifyClient({
      auth: new SpotifyOAuth({
        clientId: session.clientId,
        redirectUri: session.redirectUri,
        store,
        ...(process.env.SPOTIFY_CLIENT_SECRET
          ? { clientSecret: process.env.SPOTIFY_CLIENT_SECRET }
          : {}),
      }),
    })
  }

  if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
    return new SpotifyClient({
      auth: new ClientCredentialsProvider({
        clientId: process.env.SPOTIFY_CLIENT_ID,
        clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      }),
    })
  }

  throw new Error(
    'No Spotify credentials found; run `spots auth login`, set SPOTIFY_ACCESS_TOKEN, or set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET',
  )
}

async function unwrap<T>(result: {
  data?: T
  error?: unknown
  response: Response
}): Promise<T | undefined> {
  if (result.error !== undefined || !result.response.ok) {
    throw await SpotifyApiError.fromResponse(result.response)
  }
  return result.data
}

function parseScopes(value: string): string[] {
  const scopes = value.split(/[\s,]+/).filter(Boolean)
  const invalid = scopes.filter((scope) => !SPOTIFY_SCOPES.includes(scope as never))
  if (invalid.length) throw new Error(`Unknown Spotify scope(s): ${invalid.join(', ')}`)
  return scopes
}

async function readTrackReferences(path: string): Promise<string[]> {
  return (await readFile(path, 'utf8'))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

function requiredPlaylistWriteScopes(
  isPublic: boolean | undefined,
  collaborative: boolean,
): string[] {
  if (collaborative) return ['playlist-modify-private', 'playlist-modify-public']
  if (isPublic === undefined) return ['playlist-modify-private', 'playlist-modify-public']
  return [isPublic ? 'playlist-modify-public' : 'playlist-modify-private']
}

async function assertPlaylistWriteScopes(options: {
  public: boolean
  collaborative: boolean
}): Promise<void> {
  return assertSpotifyScopes(requiredPlaylistWriteScopes(options.public, options.collaborative))
}

async function assertSpotifyScopes(required: readonly string[]): Promise<void> {
  if (process.env.SPOTIFY_ACCESS_TOKEN) return

  const store = new FileSessionStore()
  const session = await store.load()
  if (!session) {
    if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
      throw new Error(
        'Spotify playlist creation requires user OAuth; run `spots auth login` (Client Credentials cannot modify user playlists)',
      )
    }
    return
  }

  const missing = required.filter((scope) => !session.token.scopes.includes(scope))
  if (missing.length) {
    throw new Error(
      `Saved Spotify login is missing ${missing.join(', ')}; run \`spots auth login\` again (playlist creation scopes are now requested by default)`,
    )
  }
}

function parseJsonRecord(value: string, option: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(`${option} must be valid JSON`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${option} must be a JSON object`)
  }
  return parsed as Record<string, unknown>
}

async function parseBody(
  value: string | undefined,
): Promise<BodyInit | Record<string, unknown> | readonly unknown[] | undefined> {
  if (value === undefined) return undefined
  const contents = value.startsWith('@') ? await readFile(value.slice(1)) : value
  const text = typeof contents === 'string' ? contents : contents.toString('utf8')
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null)
      return parsed as Record<string, unknown> | readonly unknown[]
  } catch {
    // Plain text is a valid raw request body.
  }
  return contents
}

function stringRecord(record: Record<string, unknown>, option: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'string') throw new Error(`${option} values must be strings`)
    result[key] = value
  }
  return result
}

function queryRecord(
  record: Record<string, unknown>,
): Record<string, string | number | boolean | readonly (string | number | boolean)[]> {
  const result: Record<string, string | number | boolean | readonly (string | number | boolean)[]> =
    {}
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value
      continue
    }
    if (
      Array.isArray(value) &&
      value.every(
        (item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean',
      )
    ) {
      result[key] = value
      continue
    }
    throw new Error(`--query value for ${key} must be a primitive or primitive array`)
  }
  return result
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1]
  if (!entrypoint) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(resolve(entrypoint))).href
  } catch {
    return false
  }
}

if (isMainModule()) await runSpotsCli()

export default spotsCli
