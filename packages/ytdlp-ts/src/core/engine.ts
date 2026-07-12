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
      const data = await new ExtractorRegistry().extract(url)
      return { engine: 'native', data }
    } catch (error) {
      if (engine === 'native') {
        if (error instanceof YtdlpError) throw error
        throw new YtdlpError('NATIVE_EXTRACTION_FAILED', String(error), { url })
      }
    }
  }
  const data = await new ReferenceClient().inspect(url, options)
  return { engine: 'reference', data }
}
