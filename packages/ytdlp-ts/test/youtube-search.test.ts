import { describe, expect, it } from 'vitest'

import {
  searchYoutube,
  type YoutubeNativeSearchClientFactory,
} from '../src/extractors/youtube-innertube.js'

describe('native YouTube search', () => {
  it('returns bounded canonical video candidates across continuations', async () => {
    const queries: string[] = []
    let continuations = 0
    const createClient: YoutubeNativeSearchClientFactory = async () => ({
      async search(query, filters) {
        queries.push(query)
        expect(filters).toEqual({ type: 'video' })
        return {
          videos: [
            searchVideo('abcdefghijk', 'Artist - Track', 300),
            searchVideo('abcdefghijk', 'Duplicate', 300),
            { video_id: 'livevideo01', title: text('Live'), is_live: true },
          ],
          has_continuation: true,
          async getContinuation() {
            continuations += 1
            return {
              videos: [searchVideo('lmnopqrstuv', 'Artist - Track (Original Mix)', 305)],
            }
          },
        }
      },
    })

    const results = await searchYoutube('  Artist Track  ', { limit: 2 }, createClient)

    expect(queries).toEqual(['Artist Track'])
    expect(continuations).toBe(1)
    expect(results).toEqual([
      {
        id: 'abcdefghijk',
        title: 'Artist - Track',
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
        uploader: 'Artist - Topic',
        uploaderId: 'channel-id',
        durationSeconds: 300,
      },
      {
        id: 'lmnopqrstuv',
        title: 'Artist - Track (Original Mix)',
        url: 'https://www.youtube.com/watch?v=lmnopqrstuv',
        uploader: 'Artist - Topic',
        uploaderId: 'channel-id',
        durationSeconds: 305,
      },
    ])
  })

  it('honors requested result counts above fifty and rejects invalid limits', async () => {
    const createClient: YoutubeNativeSearchClientFactory = async () => ({
      async search() {
        return {
          videos: Array.from({ length: 60 }, (_, index) =>
            searchVideo(`id${String(index).padStart(9, '0')}`, `Track ${index}`, 180),
          ),
        }
      },
    })

    await expect(searchYoutube('track', { limit: 0 }, createClient)).rejects.toMatchObject({
      code: 'INVALID_SEARCH_LIMIT',
    })
    await expect(searchYoutube(' ', {}, createClient)).rejects.toMatchObject({
      code: 'EMPTY_SEARCH_QUERY',
    })
    expect(await searchYoutube('track', { limit: 100 }, createClient)).toHaveLength(60)
  })

  it.each([false, true])('continues beyond five pages (content IDs: %s)', async (contentIds) => {
    let pages = 0
    const page = (index: number): Awaited<ReturnType<YoutubeNativeSearchClientFactory>> extends {
      search(...args: never[]): Promise<infer Result>
    }
      ? Result
      : never => {
      pages += 1
      return {
        videos: [
          contentIds
            ? {
                content_type: 'VIDEO',
                content_id: `page${String(index).padStart(7, '0')}`,
                title: text(`Track ${index}`),
              }
            : searchVideo(`page${String(index).padStart(7, '0')}`, `Track ${index}`, 180),
        ],
        has_continuation: true,
        async getContinuation() {
          return page(index + 1)
        },
      }
    }
    const createClient: YoutubeNativeSearchClientFactory = async () => ({
      search: async () => page(0),
    })

    const results = await searchYoutube('track', { limit: 50 }, createClient)

    expect(results).toHaveLength(50)
    expect(pages).toBe(50)
  })

  it('stops on repeated pages instead of looping forever', async () => {
    let continuations = 0
    const page = {
      videos: [searchVideo('abcdefghijk', 'Artist - Track', 300)],
      has_continuation: true,
      async getContinuation() {
        continuations += 1
        return { ...page }
      },
    }
    const results = await searchYoutube('track', { limit: 100 }, async () => ({
      search: async () => page,
    }))
    expect(results).toHaveLength(1)
    expect(continuations).toBe(1)
  })

  it('keeps earlier results when a continuation fails or is empty', async () => {
    const firstResult = searchVideo('abcdefghijk', 'Artist - Track', 300)
    const continuationError = new Error('No contents found in search response')
    const failedContinuation: YoutubeNativeSearchClientFactory = async () => ({
      async search() {
        return {
          videos: [firstResult],
          has_continuation: true,
          async getContinuation() {
            throw continuationError
          },
        }
      },
    })
    const emptyContinuation: YoutubeNativeSearchClientFactory = async () => ({
      async search() {
        return {
          videos: [firstResult],
          has_continuation: true,
          async getContinuation() {
            return { videos: [] }
          },
        }
      },
    })

    await expect(searchYoutube('track', { limit: 2 }, failedContinuation)).resolves.toEqual([
      expect.objectContaining({ id: 'abcdefghijk' }),
    ])
    await expect(searchYoutube('track', { limit: 2 }, emptyContinuation)).resolves.toEqual([
      expect.objectContaining({ id: 'abcdefghijk' }),
    ])
  })

  it('preserves continuation errors when no valid results exist', async () => {
    const continuationError = new Error('No contents found in search response')
    const createClient: YoutubeNativeSearchClientFactory = async () => ({
      async search() {
        return {
          videos: [{ video_id: 'invalid', title: text('Invalid') }],
          has_continuation: true,
          async getContinuation() {
            throw continuationError
          },
        }
      },
    })

    await expect(searchYoutube('track', { limit: 2 }, createClient)).rejects.toBe(
      continuationError,
    )
  })

  it('preserves aborts while loading a continuation with earlier results', async () => {
    const controller = new AbortController()
    const createClient: YoutubeNativeSearchClientFactory = async () => ({
      async search() {
        return {
          videos: [searchVideo('abcdefghijk', 'Artist - Track', 300)],
          has_continuation: true,
          getContinuation: () =>
            new Promise(() => {
              controller.abort()
            }),
        }
      },
    })

    await expect(
      searchYoutube('track', { limit: 2, signal: controller.signal }, createClient),
    ).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('honors an already-aborted signal before creating a client', async () => {
    const controller = new AbortController()
    controller.abort()
    let clients = 0

    await expect(
      searchYoutube(
        'track',
        { signal: controller.signal },
        async () => {
          clients += 1
          return { search: async () => ({ videos: [] }) }
        },
      ),
    ).rejects.toMatchObject({ code: 'ABORTED' })
    expect(clients).toBe(0)
  })
})

function searchVideo(id: string, title: string, durationSeconds: number) {
  return {
    video_id: id,
    title: text(title),
    author: { id: 'channel-id', name: 'Artist - Topic' },
    duration: { seconds: durationSeconds },
  }
}

function text(value: string) {
  return { toString: () => value }
}
