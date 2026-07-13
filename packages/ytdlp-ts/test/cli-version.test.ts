import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

import { Cli } from 'incur'
import { describe, expect, it } from 'vitest'

import ytdlpCli from '../src/cli.js'

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
        "const module = await import('./src/cli.ts'); if (module.cli !== module.default || module.cli.name !== 'ytdlp-ts' || typeof module.runYtdlpCli !== 'function') throw new Error('BAD_EXPORTS'); process.stdout.write('imported\\n')",
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

  it('accepts the documented --no-overwrites boolean flag', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/cli.ts',
        'download',
        'not-a-url',
        '--no-overwrites',
        '--format',
        'json',
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    )

    expect(`${result.stdout}\n${result.stderr}`).not.toContain('Unknown flag: --no-overwrites')
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
      'compat',
      'download',
      'engines',
      'extractors',
      'formats',
      'inspect',
      'music',
      'parity',
      'subtitles',
      'thumbnails',
    ])
  })

  it('mounts every command on a parent Incur CLI', async () => {
    let output = ''
    await Cli.create('music').command(ytdlpCli).serve(['--llms-full', '--format', 'json'], {
      stdout: (value) => {
        output += value
      },
      exit: (code) => {
        throw new Error(`unexpected exit ${code}`)
      },
    })

    const manifest = JSON.parse(output) as { commands: { name: string }[] }
    expect(manifest.commands.map((command) => command.name)).toEqual([
      'ytdlp-ts compat',
      'ytdlp-ts download',
      'ytdlp-ts engines',
      'ytdlp-ts extractors',
      'ytdlp-ts formats',
      'ytdlp-ts inspect',
      'ytdlp-ts music',
      'ytdlp-ts parity',
      'ytdlp-ts subtitles',
      'ytdlp-ts thumbnails',
    ])
  })
})
