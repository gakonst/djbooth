import { afterAll, describe, expect, it } from 'vitest'

import { SoulseekClient } from '../../src/client.js'

const username = process.env.SLSK_E2E_USERNAME
const password = process.env.SLSK_E2E_PASSWORD
const enabled = username && password ? describe : describe.skip
const client = new SoulseekClient({ requestTimeout: 15_000, searchTimeout: 1_000 })

enabled('Soulseek live network', () => {
  afterAll(async () => client.disconnect())

  it('logs in and submits a bounded search', async () => {
    await client.connect(username!, password!)
    expect(client.state).toBe('connected')
    const results = await client.search(`codex-smoke-${Date.now()}`, { timeout: 1_000, maxResults: 1 })
    expect(results).toEqual([])
  })
})
