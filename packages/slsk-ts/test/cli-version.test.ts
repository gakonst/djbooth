import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

describe('CLI version', () => {
  it('matches the package manifest', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--version'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe(version)
  })
})
