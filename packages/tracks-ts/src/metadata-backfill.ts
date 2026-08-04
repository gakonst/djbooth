import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  DjmdAlbum,
  DjmdContent,
  DjmdGenre,
  DjmdLabel,
  MasterDatabase,
  type DatabaseRow,
  type ModelClass,
} from "@gakonst/rekordbox/masterdb";
import { getRekordboxProcessState } from "@gakonst/rekordbox/utils";

import { probeAudio } from "./acquisition.js";
import {
  MusicBrainzMetadataClient,
  type CatalogMetadata,
  type MusicBrainzMetadataClientOptions,
} from "./catalog-metadata.js";
import { TracksError } from "./errors.js";
import { mapConcurrent } from "./process.js";
import {
  acquireRekordboxDatabaseLock,
  assertRekordboxImportApproved,
  assertRekordboxStopped,
  backupRekordboxDatabase,
  type RekordboxBackup,
} from "./rekordbox-db.js";

export type RekordboxMetadataBackfillOptions = {
  approved?: boolean;
  backupRoot?: string;
  catalog?: MusicBrainzMetadataClient;
  catalogOptions?: MusicBrainzMetadataClientOptions;
  /** Include conservative artist/title catalog search when no ISRC exists. */
  catalogSearch?: boolean;
  dbDirectory?: string;
  dbPath?: string;
  /** Direct child playlists of this folder are included. */
  folderName?: string;
  manifestRoots?: string[];
  probeConcurrency?: number;
  write?: boolean;
  onProgress?: (progress: RekordboxMetadataBackfillProgress) => void;
};

export type RekordboxMetadataBackfillProgress = {
  phase: "inventory" | "embedded" | "catalog" | "write" | "verify";
  current: number;
  total: number;
  message: string;
};

export type MetadataFieldSource = "catalog" | "embedded" | "local" | "manifest";

export type RekordboxMetadataBackfillChange = {
  contentId: string;
  title: string;
  artist?: string;
  album?: string;
  label?: string;
  genre?: string;
  isrc?: string;
  releaseDate?: string;
  sources: Partial<
    Record<"album" | "label" | "genre" | "isrc" | "releaseDate", MetadataFieldSource>
  >;
};

export type RekordboxMetadataBackfillResult = {
  dbPath: string;
  folderName: string;
  tracks: number;
  changed: number;
  written: boolean;
  backup?: RekordboxBackup;
  coverageBefore: MetadataCoverage;
  coverageAfter: MetadataCoverage;
  sources: Record<MetadataFieldSource, number>;
  catalogQueries: number;
  catalogMatches: number;
  changes: RekordboxMetadataBackfillChange[];
};

type MetadataCoverage = {
  album: number;
  label: number;
  genre: number;
  isrc: number;
};

type LibraryTrack = {
  id: string;
  path?: string | undefined;
  title: string;
  artist?: string | undefined;
  album?: string | undefined;
  label?: string | undefined;
  genre?: string | undefined;
  isrc?: string | undefined;
  releaseDate?: string | undefined;
  durationSeconds?: number | undefined;
};

type MetadataCandidate = {
  album?: string | undefined;
  label?: string | undefined;
  genre?: string | undefined;
  isrc?: string | undefined;
  releaseDate?: string | undefined;
};

const DEFAULT_FOLDER_NAME = "DJ Sets I Like";

/** Backfill one Rekordbox playlist folder without overwriting trustworthy existing metadata. */
export async function backfillRekordboxMetadata(
  options: RekordboxMetadataBackfillOptions = {},
): Promise<RekordboxMetadataBackfillResult> {
  if (options.write) assertRekordboxImportApproved(options.approved);
  const reader = new MasterDatabase({
    ...(options.dbPath ? { path: resolve(options.dbPath) } : {}),
    ...(options.dbDirectory ? { dbDirectory: resolve(options.dbDirectory) } : {}),
    readonly: true,
    unlock: true,
  });
  const dbPath = reader.path;
  const dbDirectory = reader.dbDirectory;
  const folderName = options.folderName ?? DEFAULT_FOLDER_NAME;
  let tracks: LibraryTrack[];
  let allTracks: LibraryTrack[];
  try {
    tracks = folderTracks(reader, folderName);
    allTracks = databaseTracks(reader);
  } finally {
    reader.close();
  }
  options.onProgress?.({
    phase: "inventory",
    current: tracks.length,
    total: tracks.length,
    message: `${String(tracks.length)} unique tracks in ${folderName}`,
  });
  const coverageBefore = metadataCoverage(tracks);
  const manifestMetadata = await metadataFromManifestRoots(
    options.manifestRoots ?? defaultManifestRoots(),
  );
  const embeddedMetadata = new Map<string, MetadataCandidate>();
  const paths = tracks.flatMap((track) =>
    track.path && existsSync(track.path) ? [track.path] : [],
  );
  let probed = 0;
  await mapConcurrent(paths, options.probeConcurrency ?? 8, async (path) => {
    try {
      const tags = (await probeAudio(path)).tags;
      embeddedMetadata.set(path, {
        album: clean(tags.album),
        label: clean(tags.publisher) ?? clean(tags.label),
        genre: clean(tags.genre),
        isrc: clean(tags.isrc),
        releaseDate: clean(tags.date),
      });
    } catch {
      // Missing or unreadable files stay visible in the bounded result; DB recovery continues.
    } finally {
      probed += 1;
      options.onProgress?.({
        phase: "embedded",
        current: probed,
        total: paths.length,
        message: `Read embedded metadata ${String(probed)}/${String(paths.length)}`,
      });
    }
  });
  const localMetadata = localConsensus(allTracks);
  const drafts = tracks.map((track) =>
    createDraft(track, manifestMetadata, embeddedMetadata, localMetadata),
  );
  const catalog = options.catalog ?? new MusicBrainzMetadataClient(options.catalogOptions);
  let catalogQueries = 0;
  let catalogMatches = 0;
  const catalogTargets = drafts.filter(
    ({ track, value }) =>
      needsMetadata(value) &&
      !isSetExtract(track) &&
      Boolean(value.isrc || (options.catalogSearch && isCatalogSearchSafe(track))),
  );
  for (const [index, draft] of catalogTargets.entries()) {
    options.onProgress?.({
      phase: "catalog",
      current: index,
      total: catalogTargets.length,
      message: `Catalog lookup: ${draft.track.artist ?? "Unknown Artist"} — ${draft.track.title}`,
    });
    catalogQueries += 1;
    let metadata: CatalogMetadata | undefined;
    try {
      metadata = await catalog.lookup({
        title: draft.track.title,
        artists: draft.track.artist ? splitArtists(draft.track.artist) : ["Unknown Artist"],
        ...(draft.value.album ? { album: draft.value.album } : {}),
        ...(draft.value.isrc ? { isrc: draft.value.isrc } : {}),
        ...(draft.track.durationSeconds ? { durationSeconds: draft.track.durationSeconds } : {}),
      });
    } catch (error) {
      options.onProgress?.({
        phase: "catalog",
        current: index + 1,
        total: catalogTargets.length,
        message: `Catalog miss: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (metadata) {
      const before = JSON.stringify(draft.value);
      mergeMissing(draft, metadata, "catalog");
      if (JSON.stringify(draft.value) !== before) catalogMatches += 1;
    }
    options.onProgress?.({
      phase: "catalog",
      current: index + 1,
      total: catalogTargets.length,
      message: `Catalog lookup ${String(index + 1)}/${String(catalogTargets.length)}`,
    });
  }
  const changes = drafts.flatMap((draft) => changedDraft(draft));
  const projected = tracks.map(
    (track) => drafts.find((draft) => draft.track.id === track.id)!.value,
  );
  const coverageAfter = metadataCoverage(projected);
  const sources = countSources(changes);
  if (!options.write || !changes.length) {
    return {
      dbPath,
      folderName,
      tracks: tracks.length,
      changed: changes.length,
      written: false,
      coverageBefore,
      coverageAfter,
      sources,
      catalogQueries,
      catalogMatches,
      changes,
    };
  }

  assertRekordboxStopped(getRekordboxProcessState());
  const releaseLock = await acquireRekordboxDatabaseLock(dbPath);
  let backup: RekordboxBackup | undefined;
  try {
    backup = await backupRekordboxDatabase(dbDirectory, {
      dbPath,
      ...(options.backupRoot ? { backupRoot: options.backupRoot } : {}),
    });
    const writer = new MasterDatabase({
      path: dbPath,
      dbDirectory,
      readonly: false,
      unlock: true,
    });
    try {
      const albums = namedRows(writer, DjmdAlbum);
      const labels = namedRows(writer, DjmdLabel);
      const genres = namedRows(writer, DjmdGenre);
      for (const [index, change] of changes.entries()) {
        const content = writer.query(DjmdContent).where({ ID: change.contentId }).one();
        if (change.album) {
          const key = metadataKey(change.album);
          const album =
            albums.get(key) ??
            writer.addAlbum(change.album, content.Artist ? { artist: content.Artist } : {});
          albums.set(key, album);
          content.set("AlbumID", album.ID);
        }
        if (change.label) {
          const key = metadataKey(change.label);
          const label = labels.get(key) ?? writer.addLabel(change.label);
          labels.set(key, label);
          content.set("LabelID", label.ID);
        }
        if (change.genre) {
          const key = metadataKey(change.genre);
          const genre = genres.get(key) ?? writer.addGenre(change.genre);
          genres.set(key, genre);
          content.set("GenreID", genre.ID);
        }
        if (change.isrc) content.set("ISRC", change.isrc);
        if (change.releaseDate) {
          content.set("ReleaseDate", change.releaseDate);
          const year = /^\d{4}/u.exec(change.releaseDate)?.[0];
          if (year) content.set("ReleaseYear", Number(year));
        }
        if (writer.hasColumn(content.tableName, "TrackInfoUpdated")) content.TrackInfoUpdated = "2";
        if (writer.hasColumn(content.tableName, "updated_at"))
          content.set("updated_at", new Date());
        options.onProgress?.({
          phase: "write",
          current: index + 1,
          total: changes.length,
          message: `Staged metadata ${String(index + 1)}/${String(changes.length)}`,
        });
      }
      writer.commit();
    } finally {
      writer.close();
    }
  } finally {
    await releaseLock();
  }
  const verifier = new MasterDatabase({ path: dbPath, dbDirectory, readonly: true, unlock: true });
  try {
    verifyChanges(verifier, changes);
  } finally {
    verifier.close();
  }
  options.onProgress?.({
    phase: "verify",
    current: changes.length,
    total: changes.length,
    message: `Verified ${String(changes.length)} metadata updates`,
  });
  return {
    dbPath,
    folderName,
    tracks: tracks.length,
    changed: changes.length,
    written: true,
    backup,
    coverageBefore,
    coverageAfter,
    sources,
    catalogQueries,
    catalogMatches,
    changes,
  };
}

function folderTracks(db: MasterDatabase, folderName: string): LibraryTrack[] {
  const rows = db.selectRawRows(
    `SELECT DISTINCT content."ID" AS id, content."Title" AS title,
            content."FolderPath" AS path, content."ISRC" AS isrc,
            content."ReleaseDate" AS releaseDate, content."Length" AS durationSeconds,
            artist."Name" AS artist, album."Name" AS album,
            label."Name" AS label, genre."Name" AS genre
       FROM "djmdContent" content
       LEFT JOIN "djmdArtist" artist ON artist."ID" = content."ArtistID"
       LEFT JOIN "djmdAlbum" album ON album."ID" = content."AlbumID"
       LEFT JOIN "djmdLabel" label ON label."ID" = content."LabelID"
       LEFT JOIN "djmdGenre" genre ON genre."ID" = content."GenreID"
      WHERE content."ID" IN (
        SELECT membership."ContentID"
          FROM "djmdSongPlaylist" membership
          JOIN "djmdPlaylist" playlist ON playlist."ID" = membership."PlaylistID"
          JOIN "djmdPlaylist" folder ON folder."ID" = playlist."ParentID"
         WHERE folder."Name" = ? AND folder."Attribute" = 1 AND playlist."Attribute" = 0
      )`,
    [folderName],
  );
  if (!rows.length)
    throw new TracksError("INVALID_SOURCE", `No tracks found under '${folderName}'`);
  return rows.map(libraryTrack);
}

function databaseTracks(db: MasterDatabase): LibraryTrack[] {
  return db
    .selectRawRows(
      `SELECT content."ID" AS id, content."Title" AS title,
              content."FolderPath" AS path, content."ISRC" AS isrc,
              content."ReleaseDate" AS releaseDate, content."Length" AS durationSeconds,
              artist."Name" AS artist, album."Name" AS album,
              label."Name" AS label, genre."Name" AS genre
         FROM "djmdContent" content
         LEFT JOIN "djmdArtist" artist ON artist."ID" = content."ArtistID"
         LEFT JOIN "djmdAlbum" album ON album."ID" = content."AlbumID"
         LEFT JOIN "djmdLabel" label ON label."ID" = content."LabelID"
         LEFT JOIN "djmdGenre" genre ON genre."ID" = content."GenreID"`,
    )
    .map(libraryTrack);
}

function libraryTrack(row: Record<string, unknown>): LibraryTrack {
  return {
    id: String(row.id),
    title: clean(row.title) ?? "Untitled",
    ...(clean(row.path) ? { path: clean(row.path) } : {}),
    ...(clean(row.artist) ? { artist: clean(row.artist) } : {}),
    ...(trustedMetadata(row.album) ? { album: clean(row.album) } : {}),
    ...(trustedMetadata(row.label) ? { label: clean(row.label) } : {}),
    ...(trustedMetadata(row.genre) ? { genre: clean(row.genre) } : {}),
    ...(clean(row.isrc) ? { isrc: clean(row.isrc) } : {}),
    ...(clean(row.releaseDate) ? { releaseDate: clean(row.releaseDate) } : {}),
    ...(positiveNumber(row.durationSeconds)
      ? { durationSeconds: positiveNumber(row.durationSeconds) }
      : {}),
  };
}

type Draft = {
  track: LibraryTrack;
  value: LibraryTrack;
  sources: RekordboxMetadataBackfillChange["sources"];
};

function createDraft(
  track: LibraryTrack,
  manifests: Map<string, MetadataCandidate>,
  embedded: Map<string, MetadataCandidate>,
  local: Map<string, MetadataCandidate>,
): Draft {
  const draft: Draft = { track, value: { ...track }, sources: {} };
  if (track.path) mergeMissing(draft, manifests.get(resolve(track.path)), "manifest");
  if (track.path) mergeMissing(draft, embedded.get(resolve(track.path)), "embedded");
  for (const key of identityKeys(track)) mergeMissing(draft, local.get(key), "local");
  return draft;
}

function mergeMissing(
  draft: Draft,
  metadata: MetadataCandidate | CatalogMetadata | undefined,
  source: MetadataFieldSource,
): void {
  if (!metadata) return;
  for (const field of ["album", "label", "genre", "isrc", "releaseDate"] as const) {
    const value = sanitizeField(field, (metadata as MetadataCandidate)[field]);
    if (!draft.value[field] && value) {
      draft.value[field] = value;
      draft.sources[field] = source;
    }
  }
}

function changedDraft(draft: Draft): RekordboxMetadataBackfillChange[] {
  const fields = ["album", "label", "genre", "isrc", "releaseDate"] as const;
  if (!fields.some((field) => draft.value[field] && !draft.track[field])) return [];
  return [
    {
      contentId: draft.track.id,
      title: draft.track.title,
      ...(draft.track.artist ? { artist: draft.track.artist } : {}),
      ...Object.fromEntries(
        fields.flatMap((field) =>
          draft.value[field] && !draft.track[field] ? [[field, draft.value[field]]] : [],
        ),
      ),
      sources: draft.sources,
    },
  ];
}

function localConsensus(tracks: LibraryTrack[]): Map<string, MetadataCandidate> {
  const grouped = new Map<string, LibraryTrack[]>();
  for (const track of tracks) {
    for (const key of identityKeys(track)) {
      const values = grouped.get(key) ?? [];
      values.push(track);
      grouped.set(key, values);
    }
  }
  return new Map(
    [...grouped].flatMap(([key, values]) => {
      const metadata: MetadataCandidate = {};
      for (const field of ["album", "label", "genre", "isrc", "releaseDate"] as const) {
        const candidates = [...new Set(values.map((value) => value[field]).filter(Boolean))];
        if (candidates.length === 1) metadata[field] = candidates[0]!;
      }
      return Object.keys(metadata).length ? [[key, metadata]] : [];
    }),
  );
}

function identityKeys(track: Pick<LibraryTrack, "title" | "artist" | "isrc">): string[] {
  const isrc = normalizeIsrc(track.isrc);
  return [
    `text:${metadataKey(track.artist ?? "")}:${metadataKey(cleanTitle(track.title))}`,
    ...(isrc ? [`isrc:${isrc}`] : []),
  ];
}

async function metadataFromManifestRoots(roots: string[]): Promise<Map<string, MetadataCandidate>> {
  const metadata = new Map<string, MetadataCandidate>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const path of await manifestFiles(root)) {
      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      for (const rawEntry of array(manifest.entries)) {
        const entry = record(rawEntry);
        const identity = record(entry.identity);
        const spotify = record(entry.spotify);
        const acquisition = record(entry.acquisition);
        if (acquisition.status !== "downloaded") continue;
        const candidate: MetadataCandidate = {
          album: clean(spotify.album) ?? clean(identity.album),
          label: clean(identity.label),
          genre: clean(identity.genre),
          isrc: clean(spotify.isrc) ?? clean(identity.isrc),
          releaseDate: clean(spotify.releaseDate) ?? clean(identity.releaseDate),
        };
        for (const rawDownload of [acquisition.download, ...array(acquisition.alternatives)]) {
          const mediaPath = clean(record(rawDownload).mediaPath);
          if (mediaPath) metadata.set(resolve(mediaPath), candidate);
        }
      }
    }
  }
  return metadata;
}

async function manifestFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [resolve(root)];
  while (pending.length) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".music-ts") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name === "manifest.json") files.push(path);
    }
  }
  return files;
}

function defaultManifestRoots(): string[] {
  return [join(homedir(), ".djtools"), join(homedir(), "Music")];
}

function needsMetadata(track: LibraryTrack): boolean {
  return !track.album || !track.label || !track.genre;
}

function isSetExtract(track: LibraryTrack): boolean {
  return /\[set extract(?:\s*@[^\]]+)?\]|\bid remix\b/iu.test(track.title);
}

function isCatalogSearchSafe(track: LibraryTrack): boolean {
  return (
    Boolean(track.artist) &&
    !/^unknown artist$/iu.test(track.artist!) &&
    !/\b(?:edit|bootleg|unreleased|candidate|mashup)\b|https?:|www\./iu.test(track.title)
  );
}

function metadataCoverage(tracks: Array<MetadataCandidate>): MetadataCoverage {
  return {
    album: tracks.filter((track) => track.album).length,
    label: tracks.filter((track) => track.label).length,
    genre: tracks.filter((track) => track.genre).length,
    isrc: tracks.filter((track) => track.isrc).length,
  };
}

function countSources(
  changes: RekordboxMetadataBackfillChange[],
): Record<MetadataFieldSource, number> {
  const counts = { catalog: 0, embedded: 0, local: 0, manifest: 0 };
  for (const change of changes) {
    for (const source of Object.values(change.sources)) if (source) counts[source] += 1;
  }
  return counts;
}

function namedRows<row extends DatabaseRow & { Name?: string | null }>(
  db: MasterDatabase,
  model: ModelClass<row>,
): Map<string, row> {
  return new Map(
    db
      .query(model)
      .all()
      .flatMap((row) => (row.Name ? [[metadataKey(row.Name), row] as const] : [])),
  );
}

function verifyChanges(db: MasterDatabase, changes: RekordboxMetadataBackfillChange[]): void {
  const ids = new Set(changes.map((change) => change.contentId));
  const verified = databaseTracks(db).filter((track) => ids.has(track.id));
  for (const change of changes) {
    const track = verified.find((candidate) => candidate.id === change.contentId);
    if (!track) throw new Error(`Metadata verification lost content ${change.contentId}`);
    for (const field of ["album", "label", "genre", "isrc", "releaseDate"] as const) {
      if (change[field] && !metadataFieldEqual(field, track[field], change[field])) {
        throw new Error(`Metadata verification failed for ${change.contentId}: ${field}`);
      }
    }
  }
}

function metadataFieldEqual(
  field: "album" | "label" | "genre" | "isrc" | "releaseDate",
  actual: string | undefined,
  expected: string,
): boolean {
  if (field === "isrc") return normalizeIsrc(actual) === normalizeIsrc(expected);
  if (field === "releaseDate")
    return normalizeReleaseDate(actual) === normalizeReleaseDate(expected);
  return actual !== undefined && metadataKey(actual) === metadataKey(expected);
}

function cleanTitle(title: string): string {
  return title
    .replace(/\s*\[(?:set extract|explicit)\]\s*$/giu, "")
    .replace(/\s*\((?:original|extended) mix\)\s*$/giu, "")
    .trim();
}

function splitArtists(value: string): string[] {
  return value.split(/\s*(?:,|;|\/|\s+&\s+|\s+feat\.?\s+)\s*/iu).filter(Boolean);
}

function normalizeIsrc(value: string | undefined): string | undefined {
  const normalized = value?.replaceAll("-", "").toLocaleUpperCase("en-US");
  return normalized && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/u.test(normalized) ? normalized : undefined;
}

function trustedMetadata(value: unknown): string | undefined {
  const cleaned = clean(value);
  if (!cleaned || /^(?:unknown|none|n\/a)$/iu.test(cleaned)) return undefined;
  if (/^(?:https?:\/\/)?(?:www\.)?[\w-]+\.(?:com|net|org)$/iu.test(cleaned)) return undefined;
  return cleaned;
}

function sanitizeField(
  field: "album" | "label" | "genre" | "isrc" | "releaseDate",
  value: unknown,
): string | undefined {
  if (field === "isrc") return normalizeIsrc(clean(value));
  if (field === "releaseDate") return normalizeReleaseDate(clean(value));
  const trusted = trustedMetadata(value);
  if (field === "album" && trusted && /\s@\s|\[set extract[^\]]*\]/iu.test(trusted))
    return undefined;
  return trusted;
}

function normalizeReleaseDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const compact = /^(\d{4})(\d{2})(\d{2})$/u.exec(value);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const normalized = value.replace(/[./]/gu, "-");
  return /^\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?$/u.test(normalized)
    ? normalized
    : undefined;
}

function metadataKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function clean(value: unknown): string | undefined {
  const result = typeof value === "string" ? value.trim() : "";
  return result || undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
