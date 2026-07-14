import { describe, expect, it } from 'vitest'

import { inspect, type EngineDependencies } from '../src/core/engine.js'
import { YtdlpError } from '../src/core/errors.js'

const referenceInfo = { id: 'reference', title: 'Reference result' }

describe('engine fallback boundary', () => {
  it.each([
    'FORMAT_UNAVAILABLE',
    'NATIVE_OPTION_UNAVAILABLE',
    'NATIVE_PLAYLIST_UNSUPPORTED',
    'NO_FORMATS',
    'RANGE_NOT_SUPPORTED',
    'SOUNDCLOUD_CLIENT_ID_MISSING',
    'SOUNDCLOUD_NO_FORMATS',
    'SOUNDCLOUD_TRACK_UNAVAILABLE',
    'UNSUPPORTED_URL',
    'YOUTUBE_DIRECT_FORMATS_UNAVAILABLE',
  ])('reports reference provenance after typed native capability failure %s', async (code) => {
    let referenceCalls = 0
    const dependencies: EngineDependencies = {
      async extract() {
        throw new YtdlpError(code, code)
      },
      async inspectReference() {
        referenceCalls += 1
        return referenceInfo
      },
    }

    const result = await inspect('https://media.test/item', 'auto', {}, dependencies)

    expect(result).toEqual({
      engine: 'reference',
      fallback: { from: 'native', code },
      data: referenceInfo,
    })
    expect(referenceCalls).toBe(1)
  })

  it.each([
    'ABORTED',
    'CONTENT_TOO_LONG',
    'CONTENT_TOO_SHORT',
    'EMPTY_RESPONSE',
    'HTTP_ERROR',
    'INVALID_CONTENT_LENGTH',
    'INVALID_CONTENT_RANGE',
    'NETWORK_ERROR',
    'OUTPUT_LOCKED',
    'SOUNDCLOUD_HYDRATION_INVALID',
    'SOUNDCLOUD_STREAM_RESOLUTION_FAILED',
    'WRITE_FAILED',
    'YOUTUBE_IDENTITY_MISMATCH',
  ])('fails closed without reference execution after native %s', async (code) => {
    let referenceCalls = 0
    const dependencies: EngineDependencies = {
      async extract() {
        throw new YtdlpError(code, code)
      },
      async inspectReference() {
        referenceCalls += 1
        return referenceInfo
      },
    }

    await expect(
      inspect('https://media.test/item', 'auto', {}, dependencies),
    ).rejects.toMatchObject({ code })
    expect(referenceCalls).toBe(0)
  })

  it('wraps an untyped native failure and does not invoke the reference engine', async () => {
    let referenceCalls = 0
    const dependencies: EngineDependencies = {
      async extract() {
        throw new Error('unexpected native failure')
      },
      async inspectReference() {
        referenceCalls += 1
        return referenceInfo
      },
    }

    await expect(
      inspect('https://media.test/item', 'auto', {}, dependencies),
    ).rejects.toMatchObject({ code: 'NATIVE_EXTRACTION_FAILED' })
    expect(referenceCalls).toBe(0)
  })

  it('never delegates when native is explicitly selected', async () => {
    let referenceCalls = 0
    const dependencies: EngineDependencies = {
      async extract() {
        throw new YtdlpError('UNSUPPORTED_URL', 'unsupported')
      },
      async inspectReference() {
        referenceCalls += 1
        return referenceInfo
      },
    }

    await expect(
      inspect('https://media.test/item', 'native', {}, dependencies),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_URL' })
    expect(referenceCalls).toBe(0)
  })

  it('threads cancellation into native extraction and preserves typed abort identity', async () => {
    const controller = new AbortController()
    let receivedSignal: AbortSignal | undefined
    let referenceCalls = 0
    const dependencies: EngineDependencies = {
      async extract(_url, context) {
        receivedSignal = context?.signal
        controller.abort()
        throw new DOMException('cancelled', 'AbortError')
      },
      async inspectReference() {
        referenceCalls += 1
        return referenceInfo
      },
    }

    await expect(
      inspect('https://media.test/item', 'auto', { signal: controller.signal }, dependencies),
    ).rejects.toMatchObject({ code: 'ABORTED' })
    expect(receivedSignal).toBe(controller.signal)
    expect(referenceCalls).toBe(0)
  })
})
