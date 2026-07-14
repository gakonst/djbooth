export type { EngineKind, Format, MediaInfo, ProgressEvent, Subtitle, Thumbnail } from './core/types.js'
export { ReferenceClient } from './bridge/reference.js'
export type {
  DownloadReferenceOptions,
  InspectReferenceOptions,
  ReferenceResult,
  ReferenceRunOptions,
} from './bridge/reference.js'
export { nativeFallbackFor, YtdlpError } from './core/errors.js'
export type {
  NativeFallback,
  NativeFallbackErrorCode,
} from './core/errors.js'
export { ExtractorRegistry } from './extractors/registry.js'
export { DirectExtractor } from './extractors/direct.js'
export { GenericExtractor } from './extractors/generic.js'
export { parseM3u8Formats, parseMpdFormats } from './core/manifest.js'
export {
  YoutubeExtractor,
  extractPlayerResponse,
  extractYoutubeId,
  parseYoutubePlayerResponse,
} from './extractors/youtube.js'
export {
  DEFAULT_YOUTUBE_SEARCH_RESULTS,
  MAX_YOUTUBE_SEARCH_RESULTS,
  searchYoutube,
} from './extractors/youtube-innertube.js'
export type {
  YoutubeNativeSearchClient,
  YoutubeNativeSearchClientFactory,
  YoutubeSearchOptions,
  YoutubeSearchResult,
} from './extractors/youtube-innertube.js'
export { SoundcloudExtractor, parseSoundcloudHydration, parseSoundcloudTrack } from './extractors/soundcloud.js'
export { DEFAULT_FORMAT_SPEC, selectFormats } from './core/format-selector.js'
export { DEFAULT_OUTPUT_TEMPLATE, renderOutputTemplate, sanitizeComponent } from './core/template.js'
export { downloadMedia, parseRate, supportsNativeDownloadOptions } from './downloader/native.js'
export type { NativeDownloadOptions, NativeDownloadResult } from './downloader/native.js'
export { compareMediaInfo } from './core/parity.js'
export type { ParityDifference, ParityReport } from './core/parity.js'
export {
  DEFAULT_MUSIC_CONCURRENCY,
  DEFAULT_NATIVE_YOUTUBE_CONCURRENCY,
  DEFAULT_YOUTUBE_CONCURRENCY,
  downloadMusicBatch,
  MAX_MUSIC_CONCURRENCY,
  MAX_NATIVE_YOUTUBE_CONCURRENCY,
  MAX_YOUTUBE_CONCURRENCY,
  MUSIC_FORMAT_SPEC,
  MUSIC_OUTPUT_TEMPLATE,
} from './music.js'
export type { MusicBatchResult, MusicDependencies, MusicDownloadItem, MusicDownloadOptions } from './music.js'
