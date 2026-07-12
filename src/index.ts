export {
  parseDescriptionTracklist,
  tracklistFromDescription,
  type DescriptionParseResult,
} from "./description.js";
export { isAbortError, TracksError, type TracksErrorCode } from "./errors.js";
export { identify } from "./identify.js";
export {
  getYtdlpTsCommand,
  inspectMediaMetadata,
  type CliCommand,
  type InspectMetadataOptions,
  type MediaMetadata,
} from "./integrations/ytdlp.js";
export {
  createManifest,
  MANIFEST_KIND,
  MANIFEST_SCHEMA_VERSION,
  parseManifest,
  trackSearchQuery,
  type AcquisitionBackend,
  type AcquisitionCandidate,
  type AcquisitionDownload,
  type AcquisitionState,
  type ManifestArtifacts,
  type ManifestSource,
  type ManifestTracklist,
  type PipelineError,
  type PipelineStage,
  type RekordboxState,
  type RekordboxTarget,
  type ResolvedTrack,
  type SetManifest,
  type SpotifyCandidate,
  type SpotifyState,
  type TrackCue,
  type TrackIdentity,
} from "./manifest.js";
export {
  extractClip,
  hasCompleteSampleCoverage,
  is1001Url,
  isHttpUrl,
  isSupportedDownloadUrl,
  prepareMedia,
  probeDuration,
  sampleOffsets,
  type PreparedMedia,
  type PrepareMediaOptions,
} from "./media.js";
export { AcrCloudClient, signAcrCloud, type AcrCloudClientOptions } from "./providers/acrcloud.js";
export {
  AudDClient,
  parseEnterpriseResult,
  type AudDClientOptions,
  type AudDEnterpriseOptions,
} from "./providers/audd.js";
export {
  DEFAULT_PARSE_API_BASE,
  Tracklists1001Client,
  databaseTracklistToEntries,
  isDatabaseMediaUrl,
  normalizeMediaUrl,
  type Tracklists1001ClientOptions,
} from "./providers/tracklists1001.js";
export {
  recognizeSamples,
  type ClipRecognizer,
  type SampleRecognitionResult,
} from "./recognize-samples.js";
export {
  parseTracklistJson,
  renderTracklist,
  type RenderOptions,
  type RenderStyle,
} from "./render.js";
export { buildTimeline, type TimelineOptions } from "./timeline.js";
export { formatTimestamp, parseTimestamp, requireTimestamp } from "./time.js";
export type * from "./types.js";
