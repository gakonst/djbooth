import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, realpath, stat, statfs } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

import { inspectLegacyDevicePdb } from "@gakonst/rekordbox/devicelib";
import { AnlzFile } from "@gakonst/rekordbox/anlz";
import {
  Content,
  DeviceLibraryPlus,
  History,
  HistoryContent,
  Playlist,
  PlaylistContent,
  PlaylistType,
} from "@gakonst/rekordbox/devicelib-plus";

import type {
  PlaylistItem,
  TrackSummary,
  TrackWaveform,
  UsbLibraryFormat,
  UsbMediaDevice,
  UsbMediaResponse,
} from "../shared/types.js";
import { waveformFromAnlzFiles } from "./library.js";

const DEVICE_LIBRARY_PATH = join("PIONEER", "rekordbox", "export.pdb");
const ONE_LIBRARY_PATH = join("PIONEER", "rekordbox", "exportLibrary.db");

type UsbSnapshot = {
  device: UsbMediaDevice;
  playlists: PlaylistItem[];
  playlistTrackIds: Map<string, number[]>;
  tracks: Map<number, TrackSummary>;
  trackIds: Map<string, number>;
  analysisPaths: Map<number, string[]>;
};

type CachedUsbSnapshot = {
  signature: string;
  snapshot: UsbSnapshot;
};

export type MountedUsbMediaOptions = {
  /** Directories whose immediate children are mounted volumes. */
  mountRoots?: string[];
};

/** Read mounted Rekordbox media without mutating the stick or treating it as workflow state. */
export class MountedUsbMediaService {
  private readonly mountRoots: string[];
  private readonly cache = new Map<string, CachedUsbSnapshot>();
  private readonly waveformCache = new Map<string, TrackWaveform>();
  private snapshots: UsbSnapshot[] = [];
  private scanPromise: Promise<UsbMediaResponse> | undefined;

  constructor(options: MountedUsbMediaOptions = {}) {
    this.mountRoots = options.mountRoots ?? defaultMountRoots();
  }

  async scan(): Promise<UsbMediaResponse> {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = this.performScan().finally(() => {
      this.scanPromise = undefined;
    });
    return this.scanPromise;
  }

  private async performScan(): Promise<UsbMediaResponse> {
    const mounts = await discoverMountedVolumes(this.mountRoots);
    const snapshots = await Promise.all(mounts.map((mountPath) => this.loadMount(mountPath)));
    this.snapshots = snapshots.sort((left, right) =>
      left.device.name.localeCompare(right.device.name, undefined, { sensitivity: "base" }),
    );
    const active = new Set(mounts);
    for (const mountPath of this.cache.keys())
      if (!active.has(mountPath)) this.cache.delete(mountPath);
    return {
      devices: this.snapshots.map(({ device }) => device),
      playlists: this.snapshots.flatMap(({ playlists }) => playlists),
    };
  }

  async getTracks(playlistId: string): Promise<TrackSummary[]> {
    await this.ensureSnapshot();
    for (const snapshot of this.snapshots) {
      const trackIds = snapshot.playlistTrackIds.get(playlistId);
      if (!trackIds) continue;
      return trackIds.flatMap((trackId, index) => {
        const track = snapshot.tracks.get(trackId);
        return track
          ? [
              {
                ...track,
                playlistMembershipId: `${playlistId}:item:${String(index + 1)}`,
                trackNumber: index + 1,
              },
            ]
          : [];
      });
    }
    throw new RangeError(`USB playlist '${playlistId}' is not available`);
  }

  async getAudioPath(trackId: string): Promise<string> {
    await this.ensureSnapshot();
    for (const snapshot of this.snapshots) {
      const nativeId = snapshot.trackIds.get(trackId);
      const track = nativeId === undefined ? undefined : snapshot.tracks.get(nativeId);
      if (!track?.path || !track.fileExists) continue;
      return track.path;
    }
    throw new RangeError(`USB track '${trackId}' is not available`);
  }

  async getWaveform(trackId: string): Promise<TrackWaveform> {
    const cached = this.waveformCache.get(trackId);
    if (cached) return cached;
    await this.ensureSnapshot();
    for (const snapshot of this.snapshots) {
      const nativeId = snapshot.trackIds.get(trackId);
      if (nativeId === undefined) continue;
      const track = snapshot.tracks.get(nativeId);
      const files = (snapshot.analysisPaths.get(nativeId) ?? []).flatMap((path) => {
        try {
          return [AnlzFile.parseFile(path)];
        } catch {
          return [];
        }
      });
      const waveform = waveformFromAnlzFiles(files, track?.durationSeconds ?? null);
      this.waveformCache.set(trackId, waveform);
      return waveform;
    }
    throw new RangeError(`USB track '${trackId}' is not available`);
  }

  private async loadMount(mountPath: string): Promise<UsbSnapshot> {
    const signature = await mountSignature(mountPath);
    const cached = this.cache.get(mountPath);
    if (cached?.signature === signature) return cached.snapshot;
    const snapshot = await readMount(mountPath);
    this.waveformCache.clear();
    this.cache.set(mountPath, { signature, snapshot });
    return snapshot;
  }

  private async ensureSnapshot(): Promise<void> {
    if (!this.snapshots.length) await this.scan();
  }
}

async function readMount(mountPath: string): Promise<UsbSnapshot> {
  const deviceId = createHash("sha256").update(mountPath).digest("hex").slice(0, 16);
  const name = basename(mountPath);
  const pdbPath = join(mountPath, DEVICE_LIBRARY_PATH);
  const oneLibraryPath = join(mountPath, ONE_LIBRARY_PATH);
  const hasPdb = existsSync(pdbPath);
  const hasOneLibrary = existsSync(oneLibraryPath);
  const libraryFormat = usbLibraryFormat(hasPdb, hasOneLibrary);
  const space = await volumeSpace(mountPath);
  const staging = !libraryFormat && (await hasStagingDirectory(mountPath));

  if (!libraryFormat) {
    return emptySnapshot({
      id: deviceId,
      name,
      mountPath,
      libraryFormat: null,
      status: staging ? "staging" : "empty",
      tracks: 0,
      playlists: 0,
      histories: 0,
      ...space,
    });
  }

  try {
    const parsed = hasPdb
      ? parseLegacyLibrary(deviceId, mountPath, await readFile(pdbPath))
      : parseOneLibrary(deviceId, mountPath, oneLibraryPath);
    return {
      ...parsed,
      device: {
        id: deviceId,
        name,
        mountPath,
        libraryFormat,
        status: "ready",
        tracks: parsed.tracks.size,
        playlists: parsed.playlists.filter(
          (playlist) => playlist.usb?.kind === "playlist" && playlist.type !== "folder",
        ).length,
        histories: parsed.playlists.filter(
          (playlist) => playlist.usb?.kind === "history" && playlist.type !== "folder",
        ).length,
        ...space,
      },
    };
  } catch (error) {
    return emptySnapshot({
      id: deviceId,
      name,
      mountPath,
      libraryFormat,
      status: "error",
      tracks: 0,
      playlists: 0,
      histories: 0,
      ...space,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseLegacyLibrary(
  deviceId: string,
  mountPath: string,
  data: Buffer,
): Omit<UsbSnapshot, "device"> {
  const inspection = inspectLegacyDevicePdb(data);
  const tracks = new Map<number, TrackSummary>();
  const trackIds = new Map<string, number>();
  const analysisPaths = new Map<number, string[]>();
  for (const source of inspection.tracks) {
    const id = usbTrackId(deviceId, source.id);
    const path = mountedTrackPath(mountPath, source.filePath);
    tracks.set(source.id, {
      id,
      title: source.title || source.filename || `Track ${String(source.id)}`,
      artist: source.artist,
      album: source.album,
      genre: source.genre,
      key: source.key,
      colorId: null,
      bpm: source.tempo > 0 ? source.tempo / 100 : null,
      durationSeconds: source.duration || null,
      rating: 0,
      playCount: source.playCount,
      analyzed: Boolean(source.analyzePath),
      artworkAvailable: false,
      fileExists: Boolean(path && existsSync(path)),
      path,
      usb: { deviceId, nativeId: source.id },
    });
    trackIds.set(id, source.id);
    analysisPaths.set(source.id, mountedAnalysisPaths(mountPath, source.analyzePath));
  }

  const playlists: PlaylistItem[] = [allTracksPlaylist(deviceId, tracks.size)];
  const playlistTrackIds = new Map<string, number[]>([
    [usbAllPlaylistId(deviceId), [...tracks.keys()]],
  ]);
  const playlistIds = new Map(
    inspection.playlists.map((playlist) => [
      playlist.id,
      usbPlaylistId(deviceId, "playlist", playlist.id),
    ]),
  );
  inspection.playlists.forEach((playlist, index) => {
    const id = playlistIds.get(playlist.id)!;
    playlists.push({
      id,
      name: playlist.name,
      parentId: playlistIds.get(playlist.parentId) ?? usbRootId(deviceId),
      seq: index + 2,
      type: playlist.folder ? "folder" : "playlist",
      trackCount: playlist.folder ? null : playlist.trackIds.length,
      usb: { deviceId, kind: "playlist", nativeId: playlist.id },
    });
    if (!playlist.folder) playlistTrackIds.set(id, playlist.trackIds);
  });
  appendHistories(deviceId, inspection.histories, playlists, playlistTrackIds);
  return { playlists, playlistTrackIds, tracks, trackIds, analysisPaths };
}

function parseOneLibrary(
  deviceId: string,
  mountPath: string,
  databasePath: string,
): Omit<UsbSnapshot, "device"> {
  const database = new DeviceLibraryPlus(databasePath);
  database.open();
  try {
    const sourceTracks = database.query(Content).all();
    const sourcePlaylists = database.query(Playlist).all();
    const memberships = database.query(PlaylistContent).all();
    const sourceHistories = database.query(History).all();
    const historyMemberships = database.query(HistoryContent).all();
    const tracks = new Map<number, TrackSummary>();
    const trackIds = new Map<string, number>();
    const analysisPaths = new Map<number, string[]>();
    for (const source of sourceTracks) {
      const id = usbTrackId(deviceId, source.content_id);
      const path = mountedTrackPath(mountPath, source.path);
      tracks.set(source.content_id, {
        id,
        title: source.title || source.fileName || `Track ${String(source.content_id)}`,
        artist: source.artist_name ?? null,
        album: source.album_name ?? null,
        genre: source.genre?.name ?? null,
        key: source.key?.name ?? null,
        colorId: null,
        bpm: source.bpmx100 && source.bpmx100 > 0 ? source.bpmx100 / 100 : null,
        durationSeconds: source.length || null,
        rating: source.rating ?? 0,
        playCount: 0,
        analyzed: Boolean(source.analysisDataFilePath),
        artworkAvailable: Boolean(source.image_path),
        fileExists: Boolean(path && existsSync(path)),
        path,
        usb: { deviceId, nativeId: source.content_id },
      });
      trackIds.set(id, source.content_id);
      analysisPaths.set(
        source.content_id,
        mountedAnalysisPaths(mountPath, source.analysisDataFilePath),
      );
    }
    const byPlaylist = new Map<number, Array<{ sequence: number; trackId: number }>>();
    for (const membership of memberships) {
      const current = byPlaylist.get(membership.playlist_id) ?? [];
      current.push({ sequence: membership.sequenceNo, trackId: membership.content_id });
      byPlaylist.set(membership.playlist_id, current);
    }
    const playlists: PlaylistItem[] = [allTracksPlaylist(deviceId, tracks.size)];
    const playlistTrackIds = new Map<string, number[]>([
      [usbAllPlaylistId(deviceId), [...tracks.keys()]],
    ]);
    const playlistIds = new Map(
      sourcePlaylists.map((playlist) => [
        playlist.playlist_id,
        usbPlaylistId(deviceId, "playlist", playlist.playlist_id),
      ]),
    );
    sourcePlaylists
      .sort((left, right) => left.sequenceNo - right.sequenceNo)
      .forEach((playlist, index) => {
        const id = playlistIds.get(playlist.playlist_id)!;
        const folder = playlist.attribute === PlaylistType.FOLDER;
        const members = (byPlaylist.get(playlist.playlist_id) ?? [])
          .sort((left, right) => left.sequence - right.sequence)
          .map(({ trackId }) => trackId);
        playlists.push({
          id,
          name: playlist.name,
          parentId: playlistIds.get(playlist.playlist_id_parent ?? 0) ?? usbRootId(deviceId),
          seq: index + 2,
          type: folder ? "folder" : "playlist",
          trackCount: folder ? null : members.length,
          usb: { deviceId, kind: "playlist", nativeId: playlist.playlist_id },
        });
        if (!folder) playlistTrackIds.set(id, members);
      });
    const historyTracks = new Map<number, Array<{ sequence: number; trackId: number }>>();
    for (const membership of historyMemberships) {
      const current = historyTracks.get(membership.history_id) ?? [];
      current.push({
        sequence: membership.sequenceNo ?? current.length + 1,
        trackId: membership.content_id,
      });
      historyTracks.set(membership.history_id, current);
    }
    appendHistories(
      deviceId,
      sourceHistories
        .sort((left, right) => (left.sequenceNo ?? 0) - (right.sequenceNo ?? 0))
        .map((history) => ({
          id: history.history_id,
          name: history.name || `History ${String(history.history_id)}`,
          trackIds: (historyTracks.get(history.history_id) ?? [])
            .sort((left, right) => left.sequence - right.sequence)
            .map(({ trackId }) => trackId),
        })),
      playlists,
      playlistTrackIds,
    );
    return { playlists, playlistTrackIds, tracks, trackIds, analysisPaths };
  } finally {
    database.close();
  }
}

function appendHistories(
  deviceId: string,
  histories: Array<{ id: number; name: string; trackIds: number[] }>,
  playlists: PlaylistItem[],
  playlistTrackIds: Map<string, number[]>,
): void {
  if (!histories.length) return;
  const parentId = `${usbRootId(deviceId)}:histories`;
  playlists.push({
    id: parentId,
    name: "Play History",
    parentId: usbRootId(deviceId),
    seq: playlists.length + 1,
    type: "folder",
    trackCount: null,
    usb: { deviceId, kind: "history", nativeId: null },
  });
  histories.forEach((history, index) => {
    const id = usbPlaylistId(deviceId, "history", history.id);
    playlists.push({
      id,
      name: history.name,
      parentId,
      seq: index + 1,
      type: "playlist",
      trackCount: history.trackIds.length,
      usb: { deviceId, kind: "history", nativeId: history.id },
    });
    playlistTrackIds.set(id, history.trackIds);
  });
}

function allTracksPlaylist(deviceId: string, trackCount: number): PlaylistItem {
  return {
    id: usbAllPlaylistId(deviceId),
    name: "All tracks",
    parentId: usbRootId(deviceId),
    seq: 1,
    type: "playlist",
    trackCount,
    usb: { deviceId, kind: "all", nativeId: null },
  };
}

function emptySnapshot(device: UsbMediaDevice): UsbSnapshot {
  return {
    device,
    playlists: [],
    playlistTrackIds: new Map(),
    tracks: new Map(),
    trackIds: new Map(),
    analysisPaths: new Map(),
  };
}

function usbRootId(deviceId: string): string {
  return `usb:${deviceId}:root`;
}

function usbAllPlaylistId(deviceId: string): string {
  return `usb:${deviceId}:all`;
}

function usbPlaylistId(deviceId: string, kind: "playlist" | "history", nativeId: number): string {
  return `usb:${deviceId}:${kind}:${String(nativeId)}`;
}

function usbTrackId(deviceId: string, nativeId: number): string {
  return `usb:${deviceId}:track:${String(nativeId)}`;
}

function mountedTrackPath(mountPath: string, devicePath: string | null | undefined): string | null {
  if (!devicePath) return null;
  const relativePath = devicePath.replace(/^[/\\]+/u, "");
  if (!relativePath || relativePath.split(/[/\\]+/u).includes("..")) return null;
  const candidate = resolve(mountPath, relativePath);
  const prefix = mountPath.endsWith(sep) ? mountPath : `${mountPath}${sep}`;
  return candidate.startsWith(prefix) ? candidate : null;
}

function mountedAnalysisPaths(mountPath: string, devicePath: string | null | undefined): string[] {
  const datPath = mountedTrackPath(mountPath, devicePath);
  if (!datPath) return [];
  const directory = dirname(datPath);
  // DAT carries beat grids and EXT carries the waveform forms used by this UI. Parsing 2EX adds
  // latency but no PWV2–PWV5 data, so leave it to the decks rather than reading it here.
  return ["DAT", "EXT"]
    .map((extension) => join(directory, `ANLZ0000.${extension}`))
    .filter((path) => existsSync(path));
}

function usbLibraryFormat(hasPdb: boolean, hasOneLibrary: boolean): UsbLibraryFormat | null {
  if (hasPdb && hasOneLibrary) return "dual";
  if (hasPdb) return "device-library";
  if (hasOneLibrary) return "one-library";
  return null;
}

async function discoverMountedVolumes(mountRoots: readonly string[]): Promise<string[]> {
  const mounts = new Set<string>();
  for (const root of mountRoots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      try {
        mounts.add(await realpath(join(root, entry.name)));
      } catch {
        // A volume can disappear between directory discovery and inspection.
      }
    }
  }
  return [...mounts].sort();
}

async function mountSignature(mountPath: string): Promise<string> {
  const paths = [join(mountPath, DEVICE_LIBRARY_PATH), join(mountPath, ONE_LIBRARY_PATH)];
  const versions = await Promise.all(
    paths.map(async (path) => {
      try {
        const metadata = await stat(path);
        return `${metadata.size}:${metadata.mtimeMs}`;
      } catch {
        return "missing";
      }
    }),
  );
  const published = versions.some((version) => version !== "missing");
  const state = published
    ? "published"
    : (await hasStagingDirectory(mountPath))
      ? "staging"
      : "idle";
  return `${versions.join("|")}|${state}`;
}

async function hasStagingDirectory(mountPath: string): Promise<boolean> {
  try {
    return (await readdir(mountPath)).some((name) =>
      name.startsWith(".music-cdj-playlist-staging-"),
    );
  } catch {
    return false;
  }
}

async function volumeSpace(
  mountPath: string,
): Promise<Pick<UsbMediaDevice, "availableBytes" | "totalBytes">> {
  try {
    const info = await statfs(mountPath);
    return {
      totalBytes: info.blocks * info.bsize,
      availableBytes: info.bavail * info.bsize,
    };
  } catch {
    return { totalBytes: null, availableBytes: null };
  }
}

function defaultMountRoots(): string[] {
  if (process.platform === "darwin") return ["/Volumes"];
  if (process.platform === "linux") return ["/media", "/mnt", "/run/media"];
  return [];
}
