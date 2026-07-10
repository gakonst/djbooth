import { describe, expect, it } from 'vitest'

import type { MediaInfo } from '../src/core/types.js'

describe('yt-dlp info model', () => {
  it('keeps extension fields while requiring stable identity fields', () => {
    const info: MediaInfo = {
      id: 'abc',
      title: 'Example',
      extractor_key: 'Generic',
      upstream_extension: { nested: true },
    }

    expect(info).toMatchObject({
      id: 'abc',
      title: 'Example',
      upstream_extension: { nested: true },
    })
  })
})
