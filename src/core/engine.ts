import { ReferenceClient, type InspectReferenceOptions } from '../bridge/reference.js'
import { YtdlpError } from './errors.js'
import type { EngineKind, MediaInfo } from './types.js'

export interface EngineResult<T> {
  engine: Exclude<EngineKind, 'auto'>
  data: T
}

export async function inspect(
  url: string,
  engine: EngineKind,
  options: InspectReferenceOptions,
): Promise<EngineResult<MediaInfo>> {
  if (engine === 'native') {
    throw new YtdlpError(
      'NATIVE_EXTRACTOR_UNAVAILABLE',
      'No native extractor currently supports this URL. Use --engine reference or --engine auto.',
      { url },
    )
  }
  const data = await new ReferenceClient().inspect(url, options)
  return { engine: 'reference', data }
}
