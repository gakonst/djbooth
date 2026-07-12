export {
  acquireManifest,
  refreshKnownSpotifyTracks,
  verifyAcquisitionPlan,
  type AcquireFailure,
  type AcquireManifestOptions,
  type AcquireManifestResult,
  type AcquireProgress,
  type AcquisitionClipPlan,
  type AcquisitionPlan,
  type AcquisitionRecordingPlan,
  type AcquisitionRecordingVariant,
  type AcquisitionVerification,
  type BackendAvailability,
  type IndividualDownload,
  type SpotifyLibraryClient,
  type TrackAcquirer,
} from "./acquire-manifest.js";
export {
  acquireManifestLock,
  acquirePipelineManifestLock,
  createSourceSetClip,
  normalizeMatchText,
  probeAudio,
  readManifest,
  retagAudio,
  safeFilename,
  scoreYoutubeCandidate,
  scoreYoutubeCandidates,
  sha256File,
  verifyAudioFile,
  writeManifestAtomic,
  type AudioMetadata,
  type AudioProbe,
  type ScoredYoutubeCandidate,
  type VerifyAudioOptions,
  type WriteManifestOptions,
  type YoutubeSearchCandidate,
  type YoutubeTarget,
} from "./acquisition.js";
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
  SoulseekLibraryAcquirer,
  scoreSoulseekFile,
  type SoulseekCandidateMetadata,
  type SoulseekDownloadResult,
  type SoulseekFileAttributes,
  type SoulseekLibraryAcquirerOptions,
  type SoulseekLibraryClient,
  type SoulseekRemoteFile,
  type SoulseekSearchCandidate,
  type SoulseekSearchResult,
  type SoulseekSharedFile,
} from "./integrations/slsk-library.js";
export {
  YtdlpReferenceAcquirer,
  unavailableTrackAcquirer,
  type YtdlpMediaInfo,
  type YtdlpReferenceClient,
} from "./integrations/ytdlp-library.js";
export {
  createManifest,
  MANIFEST_KIND,
  MANIFEST_SCHEMA_VERSION,
  parseManifest,
  trackSearchQuery,
  type AcquisitionBackend,
  type AcquisitionCandidate,
  type AcquisitionDownload,
  type AcquisitionKind,
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
  BRUNELLO_1001_URL,
  BRUNELLO_MANIFEST_PATH,
  BRUNELLO_ROOT,
  BRUNELLO_SET_TITLE,
  BRUNELLO_SOUNDCLOUD_URL,
  BRUNELLO_SOURCE_PATH,
  BRUNELLO_YOUTUBE_URL,
  buildBrunelloAcquisitionPlan,
  reconcileBrunelloManifest,
} from "./presets/brunello-lib-2026.js";
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
  enrichSpotifyManifest,
  scoreSpotifyCandidate,
  scoreSpotifyCandidates,
  spotifySearchQuery,
  type SpotifyEnrichmentOptions,
  type SpotifyEnrichmentProgress,
  type SpotifyEnrichmentResult,
  type SpotifyScoringTarget,
  type SpotifySearchClient,
  type SpotifyTrackCandidate,
} from "./spotify-enrichment.js";
export {
  applyRekordboxImportResults,
  assertRekordboxImportApproved,
  assertRekordboxStopped,
  backupRekordboxDatabase,
  defaultRekordboxPlaylistName,
  importManifestToRekordbox,
  planRekordboxImport,
  rekordboxBackupSources,
  validateMasterPlaylistSidecar,
  writeRekordboxPlan,
  type ImportManifestToRekordboxOptions,
  type ImportManifestToRekordboxResult,
  type MasterPlaylistSidecarExpectation,
  type RekordboxBackup,
  type RekordboxBackupFile,
  type RekordboxImportedItem,
  type RekordboxImportItem,
  type RekordboxImportPlan,
  type RekordboxLibrary,
  type RekordboxMasterDatabase,
  type RekordboxPlaylistArtifact,
  type RekordboxTrackMetadata,
  type RekordboxVerification,
} from "./rekordbox-db.js";
export {
  parseTracklistJson,
  renderTracklist,
  type RenderOptions,
  type RenderStyle,
} from "./render.js";
export {
  runBrunelloAcquisition,
  type RunBrunelloAcquisitionOptions,
  type SpotsModule,
  type YtdlpModule,
} from "./run-brunello-acquisition.js";
export { buildTimeline, type TimelineOptions } from "./timeline.js";
export { formatTimestamp, parseTimestamp, requireTimestamp } from "./time.js";
export type * from "./types.js";
