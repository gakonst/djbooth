/** Schema version shared with the native DJ Link runtime. */
export const DJLINK_SNAPSHOT_SCHEMA_VERSION = 1 as const;

/** One local recording exposed through RemoteDB and NFS. */
export type DjLinkSnapshotTrack = {
  order: number;
  sourceEntryId: string;
  spotifyId?: string;
  trackId: number;
  title: string;
  artist: string;
  artistId: number;
  canonicalName: string;
  album: string;
  albumId: number;
  durationSec: number;
  bpmHundreds: number;
  key: string;
  camelot: string;
  keyId: number;
  bitrateKbps: number;
  comment: string;
  mountPath: string;
  analysisDatPath?: string;
  analysisExtPath?: string;
  analysisTwoexPath?: string;
  artworkId: number;
  artworkUrl?: string;
  genre: string;
  genreId: number;
  label: string;
  year: number;
  dateAddedId: number;
  dateAdded: string;
};

/** Ordered CDJ playlist projected from one durable tracks manifest. */
export type DjLinkSnapshotPlaylist = {
  playlistId: number;
  name: string;
  parentId: number;
  isFolder: boolean;
  sequence: number;
  tracks: number[];
};

/** Native-runtime library document projected from djbooth state. */
export type DjLinkSnapshot = {
  schemaVersion: typeof DJLINK_SNAPSHOT_SCHEMA_VERSION;
  sourceManifest: string;
  masterDbId: number;
  tracks: DjLinkSnapshotTrack[];
  playlists: DjLinkSnapshotPlaylist[];
  omittedEntries: Array<{ order: number; reason: string }>;
};

/** Durable source consumed by the native DJ Link daemon. */
export type DjLinkSourceKind = "manifest" | "rekordbox";

/** Bounded report from direct read-only Rekordbox database ingestion. */
export type DjLinkRekordboxReport = {
  databasePath: string;
  databaseTracks: number;
  servedTracks: number;
  playlists: number;
  folders: number;
  omittedMissingAudio: {
    count: number;
    sample: string[];
  };
  omittedInvalidTrackIds: number;
};

/** Native validation result. */
export type DjLinkDoctorResult = {
  ok: boolean;
  binaryPath: string;
  sourceKind: DjLinkSourceKind;
  sourcePath: string;
  tracks: number;
  playlists: number;
  analysis: { dat: number; ext: number; twoEx: number };
  missingAudio: string[];
  missingAnalysis: string[];
  omittedEntries: Array<{ order: number; reason: string }>;
  rekordbox?: DjLinkRekordboxReport;
};

/** Durable daemon metadata owned by the TypeScript lifecycle wrapper. */
export type DjLinkDaemonState = {
  schemaVersion: 2;
  pid: number;
  sourceKind: DjLinkSourceKind;
  sourcePath: string;
  snapshotPath?: string;
  socketPath: string;
  logPath: string;
  outputPath: string;
  binaryPath: string;
  startedAt: string;
};

/** Current native server status. */
export type DjLinkServerStatus = {
  running: true;
  pid: number;
  sourceKind: DjLinkSourceKind;
  sourcePath: string;
  snapshotPath?: string;
  socketPath: string;
  logPath: string;
  bindIp: string;
  broadcastIp: string;
  playerNumber: number;
  tracks: number;
  playlists: number;
  uptimeMs: number;
  remoteTransportSupported: boolean;
  remoteDeckPreparationSupported: boolean;
};

/** No active runtime was found. */
export type DjLinkStoppedStatus = {
  running: false;
  staleState: boolean;
};

/** One discovered Pro DJ Link device. */
export type DjLinkDevice = {
  playerNumber: number;
  ip: string;
  mac: string;
  model: string;
  lastSeenMsAgo: number;
};

/** Result of a safe ARP presence probe on the selected DJ Link interface. */
export type DjLinkArpProbeResult = {
  ip: string;
  present: boolean;
  mac: string | null;
  timeoutMs: number;
};

/** Latest compact telemetry for one player. */
export type DjLinkMonitorResult = {
  player: number;
  status: string | null;
  beat: string | null;
  position: string | null;
};

/** Search category exposed by the CDJ RemoteDB protocol. */
export type DjLinkSearchMode = "track" | "artist" | "album";

/** One bounded RemoteDB search result. */
export type DjLinkSearchItem = {
  entryId: number;
  entryType: number;
  label: string;
};

/** Read-only search profile from the running source's in-memory index. */
export type DjLinkSearchResult = {
  query: string;
  mode: DjLinkSearchMode;
  normalizedQuery: string;
  resultCount: number;
  elapsedUs: number;
  items: DjLinkSearchItem[];
  truncated: boolean;
};

/** Result of a remote track-load and playback request. */
export type DjLinkLoadResult = {
  player: number;
  trackId: number;
  order: number;
  title: string;
  artist: string;
  packetsSent: number;
  loaded: true;
  playing: boolean;
  transportNote: string;
};

/** Result of a phrase-aware remote deck preparation request. */
export type DjLinkPrepareResult = DjLinkLoadResult & {
  cue: {
    kind: "before-chorus";
    phraseBeat: number;
    cueBeat: number;
    cueMs: number;
    barsBefore: number;
  };
  tempoBpm: number;
  tempoSyncRequested: true;
  tempoConfirmed: boolean;
};

/** Complete Rekordbox library is serving and visible to at least one CDJ. */
export type DjLinkBrowseResult = {
  doctor: DjLinkDoctorResult;
  server: DjLinkServerStatus & { resumed: boolean };
  devices: DjLinkDevice[];
};

/** Completed manifest-to-deck handoff. */
export type DjLinkRunResult = DjLinkBrowseResult & {
  load: DjLinkLoadResult;
};
