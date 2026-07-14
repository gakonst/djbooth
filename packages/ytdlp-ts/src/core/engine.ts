import { ReferenceClient, type InspectReferenceOptions } from '../bridge/reference.js'
import { nativeFallbackFor, type NativeFallback, YtdlpError } from './errors.js'
import type { EngineKind, MediaInfo } from './types.js'
import { ExtractorRegistry } from '../extractors/registry.js'

export interface EngineResult<T> {
  engine: Exclude<EngineKind, 'auto'>
  data: T
  fallback?: NativeFallback
}

export interface EngineDependencies {
  extract(url: string, context?: { signal?: AbortSignal }): Promise<MediaInfo>
  inspectReference(url: string, options: InspectReferenceOptions): Promise<MediaInfo>
}

const defaultDependencies: EngineDependencies = {
  extract: (url, context) => new ExtractorRegistry().extract(url, context),
  inspectReference: async (url, options) => new ReferenceClient().inspect(url, options),
}

export async function inspect(
  url: string,
  engine: EngineKind,
  options: InspectReferenceOptions,
  dependencies: EngineDependencies = defaultDependencies,
): Promise<EngineResult<MediaInfo>> {
  if (options.signal?.aborted) throw new YtdlpError('ABORTED', 'Media inspection was aborted')
  let fallback: NativeFallback | undefined
  if (engine !== 'reference') {
    try {
      if (nativePlaylistRequested(url, options)) {
        throw new YtdlpError(
          'NATIVE_PLAYLIST_UNSUPPORTED',
          'Native YouTube playlist expansion is not implemented; use an exact video URL with playlists disabled or the explicit auto/reference path',
        )
      }
      const data = await dependencies.extract(
        url,
        options.signal ? { signal: options.signal } : undefined,
      )
      if (options.signal?.aborted) throw new YtdlpError('ABORTED', 'Native extraction was aborted')
      return { engine: 'native', data }
    } catch (error) {
      if (options.signal?.aborted) {
        throw new YtdlpError('ABORTED', 'Native extraction was aborted')
      }
      const nativeError =
        error instanceof YtdlpError
          ? error
          : new YtdlpError('NATIVE_EXTRACTION_FAILED', String(error), { url })
      fallback = nativeFallbackFor(nativeError)
      if (engine === 'native' || !fallback) throw nativeError
    }
  }
  const data = await dependencies.inspectReference(url, options)
  if (options.signal?.aborted) throw new YtdlpError('ABORTED', 'Reference inspection was aborted')
  return { engine: 'reference', data, ...(fallback ? { fallback } : undefined) }
}

function nativePlaylistRequested(url: string, options: InspectReferenceOptions): boolean {
  if (options.playlist === false) return false
  try {
    const value = new URL(url)
    return (
      /(^|\.)youtube\.com$/iu.test(value.hostname) &&
      (value.searchParams.has('list') || value.pathname === '/playlist')
    )
  } catch {
    return false
  }
}
