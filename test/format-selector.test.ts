import { describe, expect, it } from 'vitest'

import { selectFormats } from '../src/core/format-selector.js'
import type { Format } from '../src/core/types.js'

const formats: Format[] = [
  { format_id: 'muxed-360', url: 'https://x/360.mp4', ext: 'mp4', height: 360, vcodec: 'avc1', acodec: 'aac', tbr: 500 },
  { format_id: 'video-720', url: 'https://x/720.mp4', ext: 'mp4', height: 720, vcodec: 'avc1', acodec: 'none', tbr: 1500 },
  { format_id: 'video-1080', url: 'https://x/1080.webm', ext: 'webm', height: 1080, vcodec: 'vp9', acodec: 'none', tbr: 2500 },
  { format_id: 'audio-128', url: 'https://x/audio.m4a', ext: 'm4a', vcodec: 'none', acodec: 'aac', abr: 128 },
]

describe('format selector', () => {
  it('selects best separate video and audio', () => {
    expect(selectFormats(formats, 'bv+ba').map((format) => format.format_id)).toEqual([
      'video-1080',
      'audio-128',
    ])
  })

  it('applies numeric and string filters with fallback', () => {
    expect(
      selectFormats(formats, 'bv[height<=720][ext=mp4]+ba/b').map((format) => format.format_id),
    ).toEqual(['video-720', 'audio-128'])
  })

  it('supports explicit IDs and nth-best selection', () => {
    expect(selectFormats(formats, 'video-720').map((format) => format.format_id)).toEqual(['video-720'])
    expect(selectFormats(formats, 'bv.2').map((format) => format.format_id)).toEqual(['video-720'])
  })
})
