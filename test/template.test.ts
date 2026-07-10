import { describe, expect, it } from 'vitest'

import { renderOutputTemplate } from '../src/core/template.js'

describe('output templates', () => {
  it('renders fields, fallback keys, widths, and percent escapes', () => {
    expect(
      renderOutputTemplate('%(title)s-%(missing,id)05s-%%.%(ext)s', { id: '7', title: 'A/B' }, 'mp4'),
    ).toBe('A_B-00007-%.mp4')
  })
})
