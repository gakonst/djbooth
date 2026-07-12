import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

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
    expect(stdout).toContain('skills')
  })
})
