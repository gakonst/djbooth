import { access, mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";

import { normalizeRekordboxKeyName } from "@gakonst/rekordbox";
import { readManifest, type RekordboxAnalysisArtifact, type SetManifest } from "@gakonst/tracks";

import {
  DJLINK_SNAPSHOT_SCHEMA_VERSION,
  type DjLinkSnapshot,
  type DjLinkSnapshotTrack,
} from "./types.js";

const artworkBasenames = new Set(["cover", "folder", "artwork", "albumart", "album_art"]);
const artworkExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);

/** Project one acquired/analyzed tracks manifest into the native DJ Link library schema. */
export async function buildDjLinkSnapshot(manifestPath: string): Promise<DjLinkSnapshot> {
  const absoluteManifestPath = resolve(manifestPath);
  const manifest = await readManifest(absoluteManifestPath);
  const analysisByMedia = new Map(
    (manifest.artifacts.analysis ?? []).map((artifact) => [resolve(artifact.mediaPath), artifact]),
  );
  const tracks: DjLinkSnapshotTrack[] = [];
  const omittedEntries: Array<{ order: number; reason: string }> = [];
  const usedTrackIds = new Set<number>();

  for (const entry of manifest.entries) {
    if (entry.acquisition.status !== "downloaded") {
      omittedEntries.push({ order: entry.order, reason: "recording is not downloaded" });
      continue;
    }
    if (entry.identity.status !== "identified") {
      omittedEntries.push({ order: entry.order, reason: "track identity is unresolved" });
      continue;
    }
    const mediaPath = resolve(entry.acquisition.download.mediaPath);
    if (!(await isReadableFile(mediaPath))) {
      omittedEntries.push({ order: entry.order, reason: `recording is missing: ${mediaPath}` });
      continue;
    }
    const analysis = analysisByMedia.get(mediaPath);
    const artist =
      entry.spotify.status === "matched" && entry.spotify.artists?.length
        ? entry.spotify.artists.join(", ")
        : entry.identity.artist;
    const title =
      entry.spotify.status === "matched" && entry.spotify.name
        ? entry.spotify.name
        : entry.identity.title;
    const album =
      entry.spotify.status === "matched"
        ? (entry.spotify.album ?? entry.identity.album ?? "")
        : (entry.identity.album ?? "");
    const key = analysis?.key?.trim() ?? "";
    const camelot = normalizeKey(key);
    const durationSec = durationSeconds(manifest, entry.order, entry, analysis);
    const file = await stat(mediaPath);
    const bitrateKbps =
      durationSec > 0 ? Math.max(1, Math.round((file.size * 8) / durationSec / 1_000)) : 0;
    const canonicalName = `${artist} - ${title}`;
    const trackId = uniqueStableId(`${entry.id}\0${mediaPath}`, usedTrackIds);
    const artworkUrl = await findArtwork(mediaPath);
    const dateAdded = file.birthtimeMs > 0 ? file.birthtime : file.mtime;
    const spotifyId = entry.spotify.status === "matched" ? entry.spotify.id : undefined;
    const commentParts = [
      entry.acquisition.download.kind === "source-set-clip" ? "music-ts set extract" : "music-ts",
      spotifyId ? `spotify:${spotifyId}` : undefined,
      entry.acquisition.download.source ? `source:${entry.acquisition.download.source}` : undefined,
    ].filter((value): value is string => Boolean(value));
    const analysisPaths = await resolveAnalysisPaths(analysis);

    tracks.push({
      order: entry.order,
      sourceEntryId: entry.id,
      ...(spotifyId ? { spotifyId } : {}),
      trackId,
      title,
      artist,
      artistId: stableId(artist),
      canonicalName,
      album,
      albumId: stableId(album),
      durationSec,
      bpmHundreds: Math.max(0, Math.round((analysis?.tempoBpm ?? 0) * 100)),
      key,
      camelot,
      keyId: stableId(camelot || key),
      bitrateKbps,
      comment: commentParts.join(" | "),
      mountPath: mediaPath,
      ...analysisPaths,
      artworkId: artworkUrl ? stableId(artworkUrl) : 0,
      ...(artworkUrl ? { artworkUrl } : {}),
      genre: "",
      genreId: 0,
      label: entry.identity.label ?? "",
      year: releaseYear(entry.identity.releaseDate),
      dateAddedId: stableId(dateAdded.toISOString().slice(0, 10)),
      dateAdded: dateAdded.toISOString().slice(0, 10),
    });
  }

  if (tracks.length === 0) {
    throw new TypeError(`Manifest ${absoluteManifestPath} contains no playable local recordings`);
  }
  const playlistName =
    manifest.artifacts.rekordbox?.playlistName ??
    `${manifest.source.title ?? basename(absoluteManifestPath, extname(absoluteManifestPath))} [music-ts]`;

  return {
    schemaVersion: DJLINK_SNAPSHOT_SCHEMA_VERSION,
    sourceManifest: absoluteManifestPath,
    masterDbId: stableId(absoluteManifestPath),
    tracks,
    playlists: [
      {
        playlistId: stableId(`${absoluteManifestPath}\0${playlistName}`),
        name: playlistName,
        parentId: 0,
        isFolder: false,
        sequence: 1,
        tracks: tracks.map((track) => track.trackId),
      },
    ],
    omittedEntries,
  };
}

/** Atomically persist a protected native DJ Link snapshot. */
export async function writeDjLinkSnapshot(path: string, snapshot: DjLinkSnapshot): Promise<void> {
  const absolutePath = resolve(path);
  const temporary = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, absolutePath);
}

/** Resolve a human selector against the exact daemon snapshot. */
export function resolveDjLinkTrack(
  snapshot: DjLinkSnapshot,
  selector: string,
): DjLinkSnapshotTrack {
  const value = selector.trim();
  if (!value) throw new TypeError("Track selector must not be empty");
  const numeric = /^\d+$/u.test(value) ? Number(value) : undefined;
  if (numeric !== undefined) {
    const byOrder = snapshot.tracks.filter((track) => track.order === numeric);
    if (byOrder.length === 1) return byOrder[0]!;
    const byId = snapshot.tracks.filter((track) => track.trackId === numeric);
    if (byId.length === 1) return byId[0]!;
  }
  const normalized = value.toLocaleLowerCase();
  const exact = snapshot.tracks.filter(
    (track) =>
      track.sourceEntryId.toLocaleLowerCase() === normalized ||
      track.spotifyId?.toLocaleLowerCase() === normalized ||
      track.title.toLocaleLowerCase() === normalized ||
      track.canonicalName.toLocaleLowerCase() === normalized,
  );
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) throw ambiguousSelector(value, exact);
  const contains = snapshot.tracks.filter(
    (track) =>
      track.title.toLocaleLowerCase().includes(normalized) ||
      track.artist.toLocaleLowerCase().includes(normalized) ||
      track.canonicalName.toLocaleLowerCase().includes(normalized),
  );
  if (contains.length === 1) return contains[0]!;
  if (contains.length > 1) throw ambiguousSelector(value, contains);
  throw new TypeError(`No DJ Link track matches '${value}'`);
}

/** Stable positive 31-bit FNV-1a identity shared with the native server. */
export function stableId(value: string): number {
  if (!value.trim()) return 0;
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return Math.max(hash & 0x7fffffff, 1);
}

async function resolveAnalysisPaths(
  analysis: RekordboxAnalysisArtifact | undefined,
): Promise<Pick<DjLinkSnapshotTrack, "analysisDatPath" | "analysisExtPath" | "analysisTwoexPath">> {
  if (!analysis) return {};
  const root = dirname(resolve(analysis.summaryPath));
  const dat = resolve(root, "ANLZ0000.DAT");
  const ext = resolve(root, "ANLZ0000.EXT");
  const twoEx = resolve(root, "ANLZ0000.2EX");
  return {
    ...((await isReadableFile(dat)) ? { analysisDatPath: dat } : {}),
    ...((await isReadableFile(ext)) ? { analysisExtPath: ext } : {}),
    ...((await isReadableFile(twoEx)) ? { analysisTwoexPath: twoEx } : {}),
  };
}

async function findArtwork(mediaPath: string): Promise<string | undefined> {
  const directory = dirname(mediaPath);
  const stem = basename(mediaPath, extname(mediaPath)).toLocaleLowerCase();
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return undefined;
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(directory, entry.name))
    .find((path) => {
      const extension = extname(path).toLocaleLowerCase();
      const name = basename(path, extension).toLocaleLowerCase();
      return artworkExtensions.has(extension) && (artworkBasenames.has(name) || name === stem);
    });
}

function durationSeconds(
  manifest: SetManifest,
  order: number,
  entry: SetManifest["entries"][number],
  analysis: RekordboxAnalysisArtifact | undefined,
): number {
  if (entry.acquisition.status === "downloaded" && entry.acquisition.download.clip) {
    return Math.max(
      0,
      Math.round(
        entry.acquisition.download.clip.endSeconds - entry.acquisition.download.clip.startSeconds,
      ),
    );
  }
  if (entry.spotify.status === "matched" && entry.spotify.durationMs) {
    return Math.max(0, Math.round(entry.spotify.durationMs / 1_000));
  }
  const next = manifest.entries.find((candidate) => candidate.order > order);
  if (
    entry.cue.startSeconds !== undefined &&
    next?.cue.startSeconds !== undefined &&
    next.cue.startSeconds > entry.cue.startSeconds
  ) {
    return Math.round(next.cue.startSeconds - entry.cue.startSeconds);
  }
  if (analysis) return 0;
  return 0;
}

function normalizeKey(key: string): string {
  if (!key) return "";
  try {
    return normalizeRekordboxKeyName(key);
  } catch {
    return "";
  }
}

function releaseYear(value: string | undefined): number {
  const year = value?.slice(0, 4);
  return year && /^\d{4}$/u.test(year) ? Number(year) : 0;
}

function uniqueStableId(value: string, used: Set<number>): number {
  let attempt = 0;
  while (true) {
    const id = stableId(attempt === 0 ? value : `${value}\0${String(attempt)}`);
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
    attempt += 1;
  }
}

function ambiguousSelector(selector: string, tracks: DjLinkSnapshotTrack[]): TypeError {
  const choices = tracks
    .slice(0, 6)
    .map((track) => `${track.order}: ${track.canonicalName}`)
    .join("; ");
  return new TypeError(`DJ Link track selector '${selector}' is ambiguous: ${choices}`);
}

async function isReadableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
