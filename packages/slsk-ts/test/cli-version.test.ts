import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

import { Cli } from 'incur'
import { describe, expect, it } from 'vitest'

import slskCli from '../src/cli.js'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

describe('CLI version', () => {
  it('exports an inert, composable CLI definition', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        "import process from 'node:process'; import { syncBuiltinESMExports } from 'node:module'; process.loadEnvFile = () => { throw new Error('ENV_LOADED') }; syncBuiltinESMExports(); const module = await import('./src/cli.ts'); if (module.cli !== module.default || module.cli.name !== 'slsk' || typeof module.runSlskCli !== 'function') throw new Error('BAD_EXPORTS'); process.stdout.write('imported\\n')",
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    )

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('imported\n')
  })

  it('matches the package manifest', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--version'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe(version)
  })

  it('discovers every standalone command', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', '--llms-full', '--format', 'json'],
      { cwd: process.cwd(), encoding: 'utf8' },
    )

    expect(result.status, result.stderr).toBe(0)
    const manifest = JSON.parse(result.stdout) as { commands: { name: string }[] }
    expect(manifest.commands.map((command) => command.name)).toEqual([
      'browse',
      'download',
      'info',
      'interests add',
      'interests recommendations',
      'interests remove',
      'interests user',
      'login',
      'message send',
      'raw',
      'room join',
      'room list',
      'room say',
      'search',
      'serve',
    ])
  })

  it('mounts every command on a parent Incur CLI', async () => {
    let output = ''
    await Cli.create('music').command(slskCli).serve(['--llms-full', '--format', 'json'], {
      stdout: (value) => {
        output += value
      },
      exit: (code) => {
        throw new Error(`unexpected exit ${code}`)
      },
    })

    const manifest = JSON.parse(output) as { commands: { name: string }[] }
    expect(manifest.commands.map((command) => command.name)).toEqual([
      'slsk browse',
      'slsk download',
      'slsk info',
      'slsk interests add',
      'slsk interests recommendations',
      'slsk interests remove',
      'slsk interests user',
      'slsk login',
      'slsk message send',
      'slsk raw',
      'slsk room join',
      'slsk room list',
      'slsk room say',
      'slsk search',
      'slsk serve',
    ])
  })
})
