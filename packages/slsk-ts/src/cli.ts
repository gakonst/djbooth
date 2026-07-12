#!/usr/bin/env node
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Cli, z } from 'incur'

import { SoulseekClient } from './client.js'
import { BinaryWriter, ServerCode, server } from './protocol/index.js'

const auth = z.object({
  SLSK_USERNAME: z.string().min(1).describe('Soulseek username (new names are registered on first login)'),
  SLSK_PASSWORD: z.string().min(1).describe('Soulseek password'),
  SLSK_SERVER: z.string().default('server.slsknet.org:2242').describe('Soulseek server as host:port'),
  SLSK_LISTEN_PORT: z.coerce.number().int().min(0).max(65_535).default(0).describe('Inbound peer port'),
})

type Auth = z.infer<typeof auth>

function address(value: string): { host: string; port: number } {
  const separator = value.lastIndexOf(':')
  if (separator < 1) throw new TypeError('SLSK_SERVER must use host:port format')
  const host = value.slice(0, separator)
  const port = Number(value.slice(separator + 1))
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new RangeError('Invalid server port')
  return { host, port }
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (Buffer.isBuffer(value)) return value.toString('base64')
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, jsonSafe(nested)]))
  }
  return value
}

async function connected<T>(env: Auth, run: (client: SoulseekClient) => Promise<T>): Promise<T> {
  const client = new SoulseekClient({ server: address(env.SLSK_SERVER), listenPort: env.SLSK_LISTEN_PORT })
  try {
    await client.connect(env.SLSK_USERNAME, env.SLSK_PASSWORD)
    return await run(client)
  } finally {
    await client.disconnect()
  }
}

const cli = Cli.create('slsk', {
  version: (createRequire(import.meta.url)('../package.json') as { version: string }).version,
  description: 'A complete command-line client for the Soulseek network.',
  sync: {
    suggestions: [
      'search Soulseek for music',
      'browse a Soulseek user shares',
      'download a file from Soulseek',
      'send a Soulseek private message',
    ],
  },
})

cli.command('login', {
  description: 'Verify credentials or register a new username on first login.',
  env: auth,
  run: async ({ env }) => connected(env, async (client) => ({ connected: true, username: client.username })),
})

cli.command('search', {
  description: 'Search the network, a room, or one user for shared files.',
  env: auth,
  args: z.object({ query: z.string().min(1).describe('Search query') }),
  options: z.object({
    user: z.string().optional().describe('Restrict search to this user'),
    room: z.string().optional().describe('Restrict search to this room'),
    timeout: z.number().positive().default(8).describe('Collection window in seconds'),
    maxResults: z.number().int().positive().default(100).describe('Maximum peer result sets'),
  }),
  examples: [
    { args: { query: 'autechre flac' }, description: 'Search the full network' },
    { args: { query: 'live set' }, options: { user: 'some-user' }, description: 'Search one user' },
  ],
  run: async ({ env, args, options }) =>
    connected(env, async (client) =>
      jsonSafe(
        await client.search(args.query, {
          timeout: options.timeout * 1000,
          maxResults: options.maxResults,
          ...(options.user ? { user: options.user } : {}),
          ...(options.room ? { room: options.room } : {}),
        }),
      ),
    ),
})

cli.command('browse', {
  description: "Browse a user's public and visible private shares.",
  env: auth,
  args: z.object({ username: z.string().min(1).describe('Soulseek username') }),
  run: async ({ env, args }) => connected(env, async (client) => jsonSafe(await client.browse(args.username))),
})

cli.command('info', {
  description: "Fetch a user's profile and upload status.",
  env: auth,
  args: z.object({ username: z.string().min(1).describe('Soulseek username') }),
  run: async ({ env, args }) => connected(env, async (client) => jsonSafe(await client.userInfo(args.username))),
})

cli.command('download', {
  description: 'Queue and download a shared file, resuming an existing .part file by default.',
  env: auth,
  args: z.object({
    username: z.string().min(1).describe('User sharing the file'),
    remote: z.string().min(1).describe('Virtual Soulseek filename'),
    destination: z.string().optional().describe('Local destination path'),
  }),
  options: z.object({
    resume: z.boolean().default(true).describe('Resume an existing partial download'),
    timeout: z.number().positive().default(120).describe('Queue and transfer timeout in seconds'),
  }),
  run: async ({ env, args, options }) =>
    connected(env, async (client) =>
      jsonSafe(
        await client.download(
          args.username,
          args.remote,
          args.destination ?? path.win32.basename(args.remote),
          { resume: options.resume, timeout: options.timeout * 1000 },
        ),
      ),
    ),
})

const message = Cli.create('message', { description: 'Private messaging commands.' })
message.command('send', {
  description: 'Send a private message.',
  env: auth,
  args: z.object({
    username: z.string().min(1).describe('Recipient username'),
    text: z.string().min(1).describe('Message text'),
  }),
  run: async ({ env, args }) =>
    connected(env, async (client) => {
      await client.sendPrivateMessage(args.username, args.text)
      return { sent: true, recipient: args.username }
    }),
})
cli.command(message)

const room = Cli.create('room', { description: 'Chat room commands.' })
room.command('list', {
  description: 'List public and private rooms.',
  env: auth,
  run: async ({ env }) =>
    connected(env, async (client) => {
      const response = client.serverConnection!.waitFor((item) => item.code === ServerCode.RoomList)
      await client.send(server.roomList())
      return jsonSafe((await response).data)
    }),
})
room.command('join', {
  description: 'Join a room and return its current user list.',
  env: auth,
  args: z.object({ name: z.string().min(1).describe('Room name') }),
  options: z.object({ private: z.boolean().default(false).describe('Create a private room if absent') }),
  run: async ({ env, args, options }) =>
    connected(env, async (client) => jsonSafe(await client.joinRoom(args.name, options.private))),
})
room.command('say', {
  description: 'Send a message to a room.',
  env: auth,
  args: z.object({ name: z.string().min(1).describe('Room name'), text: z.string().min(1).describe('Message text') }),
  run: async ({ env, args }) =>
    connected(env, async (client) => {
      await client.sendRoomMessage(args.name, args.text)
      return { sent: true, room: args.name }
    }),
})
cli.command(room)

const interests = Cli.create('interests', { description: 'Recommendations and interest commands.' })
interests.command('recommendations', {
  description: 'Fetch personal or global recommendations.',
  env: auth,
  options: z.object({ global: z.boolean().default(false).describe('Return global instead of personal recommendations') }),
  run: async ({ env, options }) =>
    connected(env, async (client) => {
      const code = options.global ? ServerCode.GlobalRecommendations : ServerCode.Recommendations
      const response = client.serverConnection!.waitFor((item) => item.code === code)
      await client.send(options.global ? server.globalRecommendations() : server.recommendations())
      return jsonSafe((await response).data)
    }),
})
interests.command('user', {
  description: "Fetch a user's likes and hates.",
  env: auth,
  args: z.object({ username: z.string().min(1).describe('Soulseek username') }),
  run: async ({ env, args }) =>
    connected(env, async (client) => {
      const response = client.serverConnection!.waitFor(
        (item) => item.code === ServerCode.UserInterests,
      )
      await client.send(server.userInterests(args.username))
      return jsonSafe((await response).data)
    }),
})
interests.command('add', {
  description: 'Add a like or hate.',
  env: auth,
  args: z.object({ item: z.string().min(1).describe('Interest text') }),
  options: z.object({ hate: z.boolean().default(false).describe('Add to hates instead of likes') }),
  run: async ({ env, args, options }) =>
    connected(env, async (client) => {
      await client.send(options.hate ? server.addHate(args.item) : server.addLike(args.item))
      return { added: args.item, list: options.hate ? 'hates' : 'likes' }
    }),
})
interests.command('remove', {
  description: 'Remove a like or hate.',
  env: auth,
  args: z.object({ item: z.string().min(1).describe('Interest text') }),
  options: z.object({ hate: z.boolean().default(false).describe('Remove from hates instead of likes') }),
  run: async ({ env, args, options }) =>
    connected(env, async (client) => {
      await client.send(options.hate ? server.removeHate(args.item) : server.removeLike(args.item))
      return { removed: args.item, list: options.hate ? 'hates' : 'likes' }
    }),
})
cli.command(interests)

cli.command('serve', {
  description: 'Stay online and share a local directory until interrupted.',
  env: auth,
  args: z.object({ directory: z.string().describe('Local directory to share') }),
  options: z.object({ alias: z.string().optional().describe('Virtual top-level folder name') }),
  run: async ({ env, args, options }) => {
    const client = new SoulseekClient({ server: address(env.SLSK_SERVER), listenPort: env.SLSK_LISTEN_PORT })
    const files = await client.shares.addDirectory(args.directory, options.alias ? { alias: options.alias } : {})
    await client.connect(env.SLSK_USERNAME, env.SLSK_PASSWORD)
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
    await client.disconnect()
    return { sharedFiles: files, stopped: true }
  },
})

cli.command('raw', {
  description: 'Send an arbitrary server message for protocol experimentation.',
  env: auth,
  args: z.object({
    code: z.coerce.number().int().min(0).max(0xffff_ffff).describe('Server message code'),
    payload: z.string().regex(/^(?:[0-9a-fA-F]{2})*$/u).default('').describe('Hex payload without 0x'),
  }),
  options: z.object({
    waitCode: z.number().int().min(0).max(0xffff_ffff).optional().describe('Wait for this response code'),
    timeout: z.number().positive().default(10).describe('Response timeout in seconds'),
  }),
  run: async ({ env, args, options }) =>
    connected(env, async (client) => {
      const response =
        options.waitCode === undefined
          ? undefined
          : client.serverConnection!.waitFor((item) => item.code === options.waitCode, {
              timeout: options.timeout * 1000,
            })
      await client.send(server.raw(args.code, new BinaryWriter().raw(Buffer.from(args.payload, 'hex'))))
      return response ? jsonSafe(await response) : { sent: true, code: args.code }
    }),
})

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) void cli.serve()

export default cli
import { realpathSync } from 'node:fs'
