#!/usr/bin/env node

import { openAsBlob, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'

import { Cli, z } from 'incur'

import packageJson from '../package.json' with { type: 'json' }
import {
  ClientCredentialsProvider,
  FileSessionStore,
  SoundCloudOAuth,
  StaticAccessTokenProvider,
  defaultClientCredentialsPath,
  loginWithBrowser,
} from './auth/index.js'
import {
  SoundCloudClient,
  type RawQueryValue,
  type SoundCloudCollection,
  type SoundCloudPlaylist,
  type SoundCloudTrack,
  type SoundCloudTrackAccess,
} from './client.js'
import soundcloudOpenApi from './generated/soundcloud-openapi.json' with { type: 'json' }

loadPackageEnvironment()

const cli = Cli.create('soundcloud', {
  version: packageJson.version,
  description: 'Typed SoundCloud API client for humans and agents.',
  sync: {
    suggestions: [
      'show my liked SoundCloud tracks',
      'list the SoundCloud URLs for all my likes',
      'search SoundCloud for a track',
      'show my SoundCloud profile',
      'resolve a SoundCloud permalink',
    ],
  },
})

const auth = Cli.create('auth', {
  description: 'Authenticate with SoundCloud OAuth 2.1.',
})

auth.command('login', {
  description: 'Log in as a SoundCloud user with Authorization Code + PKCE.',
  env: z.object({
    SOUNDCLOUD_CLIENT_ID: z
      .string()
      .optional()
      .describe('SoundCloud application client ID'),
    SOUNDCLOUD_CLIENT_SECRET: z
      .string()
      .optional()
      .describe('SoundCloud application client secret'),
    SOUNDCLOUD_REDIRECT_URI: z
      .string()
      .optional()
      .describe('Registered loopback redirect URI'),
    SOUNDCLOUD_CREDENTIALS_PATH: z
      .string()
      .optional()
      .describe('Saved user credential file'),
  }),
  options: z.object({
    clientId: z
      .string()
      .optional()
      .describe('SoundCloud application client ID'),
    redirectUri: z
      .string()
      .optional()
      .describe(
        'Registered loopback redirect URI (default http://127.0.0.1:8788/callback)',
      ),
    noBrowser: z
      .boolean()
      .default(false)
      .describe('Print the URL without opening a browser'),
  }),
  alias: { clientId: 'i' },
  examples: [{ description: 'Log in and save a refreshable user session' }],
  async run(context) {
    const clientId =
      context.options.clientId ?? context.env.SOUNDCLOUD_CLIENT_ID
    const clientSecret = context.env.SOUNDCLOUD_CLIENT_SECRET
    if (!clientId) {
      throw new Error(
        'SoundCloud client ID required via --client-id or SOUNDCLOUD_CLIENT_ID',
      )
    }
    if (!clientSecret) {
      throw new Error(
        'SoundCloud client secret required via SOUNDCLOUD_CLIENT_SECRET',
      )
    }
    const redirectUri =
      context.options.redirectUri ??
      context.env.SOUNDCLOUD_REDIRECT_URI ??
      'http://127.0.0.1:8788/callback'
    const store = new FileSessionStore(context.env.SOUNDCLOUD_CREDENTIALS_PATH)
    const oauth = new SoundCloudOAuth({
      clientId,
      clientSecret,
      redirectUri,
      store,
    })

    const token = await loginWithBrowser({
      oauth,
      openBrowser: !context.options.noBrowser,
      onAuthorizationUrl(url) {
        process.stderr.write(`Open this URL to authorize soundcloud:\n${url}\n`)
      },
    })
    return {
      loggedIn: true,
      expiresAt: new Date(token.expiresAt).toISOString(),
      credentialsPath: store.path,
    }
  },
})

auth.command('status', {
  description: 'Show the saved login and verify it against SoundCloud.',
  async run() {
    const store = new FileSessionStore()
    const session = await store.load()
    if (!session || session.grantType !== 'authorization_code') {
      return { loggedIn: false, credentialsPath: store.path }
    }
    const client = await createSoundCloudClient()
    return {
      loggedIn: true,
      clientId: session.clientId,
      redirectUri: session.redirectUri,
      expiresAt: new Date(session.token.expiresAt).toISOString(),
      profile: await client.getMe(),
      credentialsPath: store.path,
    }
  },
})

auth.command('refresh', {
  description: 'Rotate the saved SoundCloud user token now.',
  env: z.object({
    SOUNDCLOUD_CLIENT_SECRET: z
      .string()
      .optional()
      .describe('SoundCloud application client secret'),
  }),
  async run(context) {
    const store = new FileSessionStore()
    const session = await store.load()
    if (
      !session ||
      session.grantType !== 'authorization_code' ||
      !session.redirectUri
    ) {
      throw new Error(
        'Not logged in to SoundCloud; run `soundcloud auth login`',
      )
    }
    if (!context.env.SOUNDCLOUD_CLIENT_SECRET) {
      throw new Error(
        'SoundCloud client secret required via SOUNDCLOUD_CLIENT_SECRET',
      )
    }
    const oauth = new SoundCloudOAuth({
      clientId: session.clientId,
      clientSecret: context.env.SOUNDCLOUD_CLIENT_SECRET,
      redirectUri: session.redirectUri,
      store,
    })
    const token = await oauth.refresh(true)
    return {
      refreshed: true,
      expiresAt: new Date(token.expiresAt).toISOString(),
    }
  },
})

auth.command('logout', {
  description: 'Delete the locally saved SoundCloud user session.',
  async run() {
    const store = new FileSessionStore()
    await store.withLock(() => store.clear())
    return { loggedOut: true, credentialsPath: store.path }
  },
})

cli.command(auth)

cli.command('me', {
  description: "Get the logged-in user's SoundCloud profile.",
  async run() {
    return (await createSoundCloudClient()).getMe()
  },
})

cli.command('recent', {
  description: "Get the logged-in user's last 25 unique played tracks.",
  async run() {
    const tracks =
      (await (await createSoundCloudClient()).getRecentlyPlayedTracks()) ?? []
    return { tracks, total: tracks.length }
  },
})

const likes = Cli.create('likes', {
  description: 'Query the logged-in user’s SoundCloud likes.',
})

likes.command('tracks', {
  description:
    'List liked tracks, optionally following every page or returning track permalinks.',
  options: z.object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe('Items per API page'),
    all: z
      .boolean()
      .default(false)
      .describe('Follow linked pagination until complete'),
    maxItems: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe('Stop after this many items'),
    access: z
      .string()
      .default('playable,preview,blocked')
      .describe(
        'Comma-separated playable, preview, and/or blocked access states',
      ),
    urls: z
      .boolean()
      .default(false)
      .describe('Return canonical track permalinks for use with ytdlp-ts'),
  }),
  examples: [
    { description: 'Show the first 50 liked tracks' },
    {
      options: { all: true, urls: true },
      description: 'Collect every liked track permalink',
    },
  ],
  async run(context) {
    const client = await createSoundCloudClient()
    const access = parseAccess(context.options.access)
    const tracks = context.options.all
      ? await client.getAllLikedTracks({
          limit: context.options.limit,
          access,
          ...(context.options.maxItems
            ? { maxItems: context.options.maxItems }
            : {}),
        })
      : normalizeCollection(
          await client.raw<SoundCloudCollection<SoundCloudTrack>>(
            'GET',
            '/me/likes/tracks',
            {
              query: {
                limit: context.options.limit,
                access,
                linked_partitioning: true,
              },
            },
          ),
        )
    const limitedTracks =
      !context.options.all && context.options.maxItems
        ? tracks.slice(0, context.options.maxItems)
        : tracks
    if (context.options.urls) {
      const urls = limitedTracks.flatMap((track) =>
        typeof track.permalink_url === 'string' ? [track.permalink_url] : [],
      )
      return { urls, total: urls.length }
    }
    return { tracks: limitedTracks, total: limitedTracks.length }
  },
})

likes.command('playlists', {
  description: 'List liked playlists, optionally following every linked page.',
  options: z.object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe('Items per API page'),
    all: z
      .boolean()
      .default(false)
      .describe('Follow linked pagination until complete'),
    maxItems: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe('Stop after this many items'),
  }),
  async run(context) {
    const client = await createSoundCloudClient()
    const playlists = context.options.all
      ? await client.getAllLikedPlaylists({
          limit: context.options.limit,
          ...(context.options.maxItems
            ? { maxItems: context.options.maxItems }
            : {}),
        })
      : normalizeCollection(
          await client.raw<SoundCloudCollection<SoundCloudPlaylist>>(
            'GET',
            '/me/likes/playlists',
            {
              query: {
                limit: context.options.limit,
                linked_partitioning: true,
              },
            },
          ),
        )
    const limitedPlaylists =
      !context.options.all && context.options.maxItems
        ? playlists.slice(0, context.options.maxItems)
        : playlists
    return { playlists: limitedPlaylists, total: limitedPlaylists.length }
  },
})

cli.command(likes)

const search = Cli.create('search', {
  description: 'Search public SoundCloud resources.',
})
for (const resource of ['tracks', 'playlists', 'users'] as const) {
  search.command(resource, {
    description: `Search SoundCloud ${resource}.`,
    args: z.object({ query: z.string().min(1).describe('Search query') }),
    options: z.object({
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(200)
        .default(20)
        .describe('Maximum results'),
    }),
    async run(context) {
      const collection = await (
        await createSoundCloudClient()
      ).raw<SoundCloudCollection<unknown>>('GET', `/${resource}`, {
        query: {
          q: context.args.query,
          limit: context.options.limit,
          linked_partitioning: true,
        },
      })
      const items = normalizeCollection(collection)
      return { [resource]: items, total: items.length }
    },
  })
}
cli.command(search)

cli.command('resolve', {
  description: 'Resolve a soundcloud.com permalink to its API resource.',
  args: z.object({ url: z.url().describe('SoundCloud permalink') }),
  async run(context) {
    return (await createSoundCloudClient()).raw('GET', '/resolve', {
      query: { url: context.args.url },
    })
  },
})

cli.command('upload', {
  description:
    'Upload an audio file through SoundCloud multipart track creation.',
  args: z.object({ file: z.string().min(1).describe('Local audio file') }),
  options: z.object({
    title: z
      .string()
      .optional()
      .describe('Track title (defaults to the file name)'),
    description: z.string().optional().describe('Track description'),
    genre: z.string().optional().describe('Track genre'),
    tags: z.string().optional().describe('Space-separated SoundCloud tag list'),
    sharing: z
      .enum(['public', 'private'])
      .default('private')
      .describe('Sharing mode'),
    downloadable: z
      .boolean()
      .default(false)
      .describe('Allow listener downloads'),
    contentType: z.string().optional().describe('Audio MIME type override'),
  }),
  async run(context) {
    const fileName = basename(context.args.file)
    const stem = fileName.slice(0, -extname(fileName).length)
    const title = context.options.title ?? (stem || fileName)
    const form = new FormData()
    form.set('track[title]', title)
    form.set(
      'track[asset_data]',
      await openAsBlob(context.args.file, {
        type:
          context.options.contentType ?? audioContentType(context.args.file),
      }),
      fileName,
    )
    form.set('track[sharing]', context.options.sharing)
    form.set('track[downloadable]', String(context.options.downloadable))
    if (context.options.description)
      form.set('track[description]', context.options.description)
    if (context.options.genre) form.set('track[genre]', context.options.genre)
    if (context.options.tags) form.set('track[tag_list]', context.options.tags)
    return (await createSoundCloudClient()).raw('POST', '/tracks', {
      body: form,
    })
  },
})

cli.command('request', {
  description:
    'Make a raw authenticated SoundCloud request (forward-compatibility escape hatch).',
  args: z.object({
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).describe('HTTP method'),
    path: z
      .string()
      .describe('API path or full https://api.soundcloud.com URL'),
  }),
  options: z.object({
    query: z.string().optional().describe('Query parameters as a JSON object'),
    body: z
      .string()
      .optional()
      .describe('JSON body, plain text, or @path to read a file'),
    headers: z.string().optional().describe('Headers as a JSON object'),
  }),
  examples: [
    {
      args: { method: 'GET', path: '/me' },
      description: 'Get the current user profile',
    },
    {
      args: { method: 'GET', path: '/tracks' },
      options: { query: '{"q":"Burial","limit":10}' },
      description: 'Search for tracks',
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
    return (await createSoundCloudClient()).raw(
      context.args.method,
      context.args.path,
      {
        ...(headers ? { headers: stringRecord(headers, '--headers') } : {}),
        ...(query ? { query: queryRecord(query) } : {}),
        ...(body !== undefined ? { body } : {}),
      },
    )
  },
})

cli.command('api', {
  description: 'All operations from the official SoundCloud OpenAPI schema.',
  openapi: soundcloudOpenApi as never,
  fetch: async (request: Request) =>
    (await createSoundCloudClient()).fetch(request),
})

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void cli.serve()

export default cli

export async function createSoundCloudClient(): Promise<SoundCloudClient> {
  if (process.env.SOUNDCLOUD_ACCESS_TOKEN) {
    return new SoundCloudClient({
      auth: new StaticAccessTokenProvider(process.env.SOUNDCLOUD_ACCESS_TOKEN),
    })
  }

  const store = new FileSessionStore()
  const session = await store.load()
  if (session?.grantType === 'authorization_code') {
    if (!process.env.SOUNDCLOUD_CLIENT_SECRET || !session.redirectUri) {
      throw new Error(
        'Saved SoundCloud login requires SOUNDCLOUD_CLIENT_SECRET to refresh its user token',
      )
    }
    return new SoundCloudClient({
      auth: new SoundCloudOAuth({
        clientId: session.clientId,
        clientSecret: process.env.SOUNDCLOUD_CLIENT_SECRET,
        redirectUri: session.redirectUri,
        store,
      }),
    })
  }

  if (
    process.env.SOUNDCLOUD_CLIENT_ID &&
    process.env.SOUNDCLOUD_CLIENT_SECRET
  ) {
    return new SoundCloudClient({
      auth: new ClientCredentialsProvider({
        clientId: process.env.SOUNDCLOUD_CLIENT_ID,
        clientSecret: process.env.SOUNDCLOUD_CLIENT_SECRET,
        store: new FileSessionStore(defaultClientCredentialsPath()),
      }),
    })
  }

  throw new Error(
    'No SoundCloud credentials found; run `soundcloud auth login`, set SOUNDCLOUD_ACCESS_TOKEN, or set SOUNDCLOUD_CLIENT_ID and SOUNDCLOUD_CLIENT_SECRET',
  )
}

function loadPackageEnvironment(): void {
  try {
    loadEnvFile(resolve(import.meta.dirname, '../.env'))
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error
  }
}

function normalizeCollection<T>(
  value: SoundCloudCollection<T> | undefined,
): T[] {
  if (!value) return []
  return Array.isArray(value) ? value : value.collection
}

function parseAccess(value: string): SoundCloudTrackAccess[] {
  const access = value.split(',').map((item) => item.trim())
  const allowed: SoundCloudTrackAccess[] = ['playable', 'preview', 'blocked']
  const invalid = access.filter(
    (item) => !allowed.includes(item as SoundCloudTrackAccess),
  )
  if (invalid.length)
    throw new Error(`Unknown SoundCloud access value(s): ${invalid.join(', ')}`)
  return [...new Set(access)] as SoundCloudTrackAccess[]
}

function parseJsonRecord(
  value: string,
  option: string,
): Record<string, unknown> {
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
): Promise<
  BodyInit | Record<string, unknown> | readonly unknown[] | undefined
> {
  if (value === undefined) return undefined
  const contents = value.startsWith('@')
    ? await readFile(value.slice(1))
    : value
  const text =
    typeof contents === 'string' ? contents : contents.toString('utf8')
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, unknown> | readonly unknown[]
    }
  } catch {
    // Plain text is a valid raw request body.
  }
  return contents
}

function stringRecord(
  record: Record<string, unknown>,
  option: string,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'string')
      throw new Error(`${option} values must be strings`)
    result[key] = value
  }
  return result
}

function queryRecord(
  record: Record<string, unknown>,
): Record<string, RawQueryValue> {
  const result: Record<string, RawQueryValue> = {}
  for (const [key, value] of Object.entries(record)) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      result[key] = value
      continue
    }
    if (
      Array.isArray(value) &&
      value.every(
        (item) =>
          typeof item === 'string' ||
          typeof item === 'number' ||
          typeof item === 'boolean',
      )
    ) {
      result[key] = value
      continue
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const nested: Record<string, string | number | boolean | undefined> = {}
      for (const [nestedKey, nestedValue] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (
          nestedValue !== undefined &&
          typeof nestedValue !== 'string' &&
          typeof nestedValue !== 'number' &&
          typeof nestedValue !== 'boolean'
        ) {
          throw new Error(
            `--query nested value for ${key}.${nestedKey} must be a primitive`,
          )
        }
        nested[nestedKey] = nestedValue
      }
      result[key] = nested
      continue
    }
    throw new Error(
      `--query value for ${key} must be a primitive, array, or shallow object`,
    )
  }
  return result
}

function audioContentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.aif':
    case '.aiff':
      return 'audio/aiff'
    case '.flac':
      return 'audio/flac'
    case '.m4a':
      return 'audio/mp4'
    case '.mp3':
      return 'audio/mpeg'
    case '.ogg':
      return 'audio/ogg'
    case '.wav':
      return 'audio/wav'
    default:
      return 'application/octet-stream'
  }
}
