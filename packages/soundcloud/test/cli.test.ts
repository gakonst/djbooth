import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import soundcloudCliDefault, {
  runSoundCloudCli,
  soundcloudCli,
} from '../src/cli.js'
import metadata from '../src/generated/metadata.json' with { type: 'json' }

const exec = promisify(execFile)
const packageRoot = resolve(import.meta.dirname, '..')
const cleanEnvironment = {
  HOME: tmpdir(),
  TMPDIR: tmpdir(),
  NO_COLOR: '1',
  FORCE_COLOR: '0',
}

describe('soundcloud CLI', () => {
  it('exports an import-safe Incur definition for direct composition', () => {
    expect(soundcloudCliDefault).toBe(soundcloudCli)
    expect(typeof soundcloudCli.serve).toBe('function')
    expect(typeof runSoundCloudCli).toBe('function')
  })

  it('loads all 63 official operations as Incur commands', async () => {
    const { stdout } = await runCli('api', '--help')

    expect(metadata.operations).toBe(63)
    expect(stdout).toContain('get-me')
    expect(stdout).toContain('get-me-likes-tracks')
    expect(stdout).toContain('get-tracks')
    expect(stdout.match(/^ {2}[a-z0-9][a-z0-9-]+\s{2,}/gm)).toHaveLength(
      metadata.operations,
    )
  })

  it('exposes Incur discovery, MCP, and skills integration', async () => {
    const { stdout } = await runCli('--help')

    expect(stdout).toContain('--llms')
    expect(stdout).toContain('mcp')
    expect(stdout).toContain('skills')
  })

  it('documents account likes and ytdlp permalink output', async () => {
    const { stdout } = await runCli('likes', 'tracks', '--help')

    expect(stdout).toContain('List liked tracks')
    expect(stdout).toContain('--all')
    expect(stdout).toContain('--max-items')
    expect(stdout).toContain('--access')
    expect(stdout).toContain('--urls')
    expect(stdout).toContain('ytdlp-ts')
  })

  it('keeps tokens out of argv and exposes JSON comments plus multipart uploads', async () => {
    const likes = await runCli('api', 'get-me-likes-tracks', '--help')
    expect(likes.stdout).not.toContain('--authorization')

    const comments = await runCli(
      'api',
      'post-tracks-track-urn-comments',
      '--help',
    )
    expect(comments.stdout).toContain('--comment')

    const upload = await runCli('upload', '--help')
    expect(upload.stdout).toContain('multipart track creation')
    expect(upload.stdout).toContain('--title')
    expect(upload.stdout).toContain('--sharing')
  })

  it('documents playlist CRUD', async () => {
    const { stdout } = await runCli('playlist', 'create', '--help')

    expect(stdout).toContain('ordered SoundCloud track references')
    expect(stdout).toContain('--track')
    expect(stdout).toContain('--input-file')
    expect(stdout).toContain('--description')
    expect(stdout).toContain('--sharing')
    expect(stdout).toContain('soundcloud:tracks:* URN')

    const playlist = await runCli('playlist', '--help')
    expect(playlist.stdout).toContain('create')
    expect(playlist.stdout).toContain('get')
    expect(playlist.stdout).toContain('update')
    expect(playlist.stdout).toContain('delete')
  })
})

function runCli(...arguments_: string[]) {
  return exec(
    process.execPath,
    [
      '--import',
      'tsx',
      '--import',
      './test/disable-env-load.ts',
      'src/cli.ts',
      ...arguments_,
    ],
    {
      cwd: packageRoot,
      env: cleanEnvironment,
    },
  )
}
