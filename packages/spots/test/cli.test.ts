import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { Cli } from 'incur'
import { describe, expect, it } from 'vitest'

import { spotsCli } from '../src/cli.js'
import metadata from '../src/generated/metadata.json' with { type: 'json' }

const exec = promisify(execFile)

describe('spots CLI', () => {
  it('loads every operation in the official schema as an incur command', async () => {
    const { stdout } = await exec(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'api',
      '--help',
    ])

    expect(metadata.operations).toBeGreaterThanOrEqual(90)
    expect(stdout).toContain('get-recently-played')
    expect(stdout).toContain('get-current-users-profile')
    expect(stdout.match(/^ {2}[a-z0-9][a-z0-9-]+\s{2,}/gm)).toHaveLength(metadata.operations)
  })

  it('exposes incur discovery and MCP integration', async () => {
    const { stdout } = await exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--help'])

    expect(stdout).toContain('--llms')
    expect(stdout).toContain('mcp')
  })

  it('exposes first-class playlist CRUD', async () => {
    const { stdout } = await exec(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'playlist',
      'create',
      '--help',
    ])

    expect(stdout).toContain('spots playlist create <name>')
    expect(stdout).toContain('--track')
    expect(stdout).toContain('--input-file')
    expect(stdout).toContain('--visibility')
    expect(stdout).toContain('--collaborative')

    const { stdout: playlistHelp } = await exec(process.execPath, [
      '--import',
      'tsx',
      'src/cli.ts',
      'playlist',
      '--help',
    ])
    expect(playlistHelp).toContain('create')
    expect(playlistHelp).toContain('get')
    expect(playlistHelp).toContain('update')
    expect(playlistHelp).toContain('delete')
  })

  it('mounts as a side-effect-free Incur command group', async () => {
    const parent = Cli.create('music').command(spotsCli)
    let output = ''

    await parent.serve(['spots', 'playlist', 'create', '--help'], {
      stdout(value) {
        output += value
      },
      exit(code) {
        throw new Error(`Unexpected CLI exit ${code}`)
      },
    })

    expect(output).toContain('music spots playlist create <name>')
    expect(output).toContain('--track')
  })
})
