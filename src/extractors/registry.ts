import { YtdlpError } from '../core/errors.js'
import type { MediaInfo } from '../core/types.js'
import type { Extractor, ExtractorContext } from './base.js'
import { DirectExtractor } from './direct.js'
import { GenericExtractor } from './generic.js'

export class ExtractorRegistry {
  readonly extractors: readonly Extractor[]

  constructor(extractors: readonly Extractor[] = [new DirectExtractor(), new GenericExtractor()]) {
    this.extractors = extractors
  }

  async extract(value: string, context: ExtractorContext = {}): Promise<MediaInfo> {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new YtdlpError('INVALID_URL', `Invalid URL: ${value}`)
    }
    for (const extractor of this.extractors) {
      if (extractor.suitable(url)) return extractor.extract(url, context)
    }
    throw new YtdlpError('UNSUPPORTED_URL', `No native extractor supports ${value}`)
  }

  list(): Array<{ key: string; name: string }> {
    return this.extractors.map(({ key, name }) => ({ key, name }))
  }
}
