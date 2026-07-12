import type { MediaInfo } from '../core/types.js'

export interface ExtractorContext {
  signal?: AbortSignal
}

export interface Extractor {
  readonly key: string
  readonly name: string
  suitable(url: URL): boolean
  extract(url: URL, context: ExtractorContext): Promise<MediaInfo>
}
