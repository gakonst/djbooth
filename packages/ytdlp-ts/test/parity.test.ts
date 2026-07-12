import { describe, expect, it } from 'vitest'

import { compareMediaInfo } from '../src/core/parity.js'

describe('parity reports', () => {
  it('compares stable fields, shared formats, counts, and caption languages', () => {
    const report = compareMediaInfo(
      {
        id: 'id',
        title: 'Native title',
        duration: 10.0001,
        formats: [{ format_id: '18', url: 'https://native', ext: 'mp4', height: 360 }],
        subtitles: { en: [{ url: 'https://native/en' }] },
      },
      {
        id: 'id',
        title: 'Reference title',
        duration: 10,
        formats: [
          { format_id: '18', url: 'https://reference', ext: 'mp4', height: 360 },
          { format_id: '22', url: 'https://reference/22', ext: 'mp4', height: 720 },
        ],
        subtitles: { en: [{ url: 'https://reference/en' }] },
      },
    )

    expect(report.matches).toBe(false)
    expect(report.differences).toEqual([
      { field: 'title', native: 'Native title', reference: 'Reference title' },
      { field: 'format_count', native: 1, reference: 2 },
    ])
  })
})
