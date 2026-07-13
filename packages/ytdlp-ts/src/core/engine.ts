import { ReferenceClient, type InspectReferenceOptions } from '../bridge/reference.js'
import { YtdlpError } from './errors.js'
import type { EngineKind, MediaInfo } from './types.js'
import { ExtractorRegistry } from '../extractors/registry.js'

export interface EngineResult<T> {
  engine: Exclude<EngineKind, 'auto'>
  data: T
}

export async function inspect(
  url: string,
  engine: EngineKind,
  options: InspectReferenceOptions,
): Promise<EngineResult<MediaInfo>> {
  if (engine !== 'reference') {
    try {
      if (nativePlaylistRequested(url, options)) {
        throw new YtdlpError(
          'NATIVE_PLAYLIST_UNSUPPORTED',
          'Native YouTube playlist expansion is not implemented; use an exact video URL with playlists disabled or the explicit auto/reference path',
        )
      }
      const data = await new ExtractorRegistry().extract(url)
      return { engine: 'native', data }
    } catch (error) {
      if (error instanceof YtdlpError && error.code === 'ABORTED') throw error
      if (engine === 'native') {
        if (error instanceof YtdlpError) throw error
        throw new YtdlpError('NATIVE_EXTRACTION_FAILED', String(error), { url })
      }
    }
  }
  const data = await new ReferenceClient().inspect(url, options)
  return { engine: 'reference', data }
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
