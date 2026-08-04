import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  DjmdAlbum,
  DjmdArtist,
  DjmdContent,
  DjmdGenre,
  DjmdLabel,
  MasterDatabase,
  type DatabaseRow,
  type ModelClass,
} from "@gakonst/rekordbox/masterdb";
import { getRekordboxProcessState } from "@gakonst/rekordbox/utils";

import { normalizeMatchText, probeAudio } from "./acquisition.js";
import { AppleMetadataClient, type AppleMetadataClientOptions } from "./apple-metadata.js";
import {
  MusicBrainzMetadataClient,
  type CatalogMetadata,
  type MusicBrainzMetadataClientOptions,
} from "./catalog-metadata.js";
import { DeezerMetadataClient, type DeezerMetadataClientOptions } from "./deezer-metadata.js";
import { DiscogsMetadataClient, type DiscogsMetadataClientOptions } from "./discogs-metadata.js";
import { TracksError } from "./errors.js";
import { mapConcurrent } from "./process.js";
import {
  acquireRekordboxDatabaseLock,
  assertRekordboxImportApproved,
  assertRekordboxStopped,
  backupRekordboxDatabase,
  type RekordboxBackup,
} from "./rekordbox-db.js";
import {
  exactSourcesFromRekordboxComment,
  exactSourcesFromUrls,
  AppleSourceMetadataClient,
  DeezerSourceMetadataClient,
  LinkPageMetadataClient,
  SidecarMetadataClient,
  SoundCloudMetadataClient,
  type ExactSourceMetadataClient,
  type ExactSourceMetadata,
  type ExactSourceProvider,
  type ExactTrackSource,
} from "./source-metadata.js";

export type RekordboxMetadataBackfillOptions = {
  approved?: boolean;
  backupRoot?: string;
  catalog?: MusicBrainzMetadataClient;
  catalogOptions?: MusicBrainzMetadataClientOptions;
  apple?: AppleMetadataClient;
  appleOptions?: AppleMetadataClientOptions;
  deezer?: DeezerMetadataClient;
  deezerOptions?: DeezerMetadataClientOptions;
  discogs?: DiscogsMetadataClient;
  discogsOptions?: DiscogsMetadataClientOptions;
  /** Include conservative artist/title catalog search when no ISRC exists. */
  catalogSearch?: boolean;
  dbDirectory?: string;
  dbPath?: string;
  /** Direct child playlists of this folder are included. */
  folderName?: string;
  manifestRoots?: string[];
  probeConcurrency?: number;
  sourceClients?: ExactSourceMetadataClient[];
  write?: boolean;
  onProgress?: (progress: RekordboxMetadataBackfillProgress) => void;
};

export type RekordboxMetadataBackfillProgress = {
  phase: "inventory" | "embedded" | "identity" | "source" | "catalog" | "write" | "verify";
  current: number;
  total: number;
  message: string;
};

export type MetadataFieldSource =
  | "apple"
  | "bandcamp"
  | "deezer"
  | "discogs"
  | "embedded"
  | "filename"
  | "local"
  | "local-artist"
  | "local-release"
  | "linkpage"
  | "manifest"
  | "musicbrainz"
  | "sanitized"
  | "sidecar"
  | "soundcloud"
  | "spotify"
  | "title"
  | "youtube";

type RepairableMetadataField = "album" | "label" | "genre" | "isrc" | "releaseDate";
type RepairableIdentityField = "updatedTitle" | "updatedArtist";

export type RekordboxMetadataBackfillChange = {
  contentId: string;
  title: string;
  artist?: string;
  updatedTitle?: string;
  updatedArtist?: string;
  album?: string | null;
  label?: string | null;
  genre?: string | null;
  isrc?: string | null;
  releaseDate?: string | null;
  sources: Partial<Record<RepairableMetadataField | RepairableIdentityField, MetadataFieldSource>>;
};

export type MetadataProviderStats = {
  queries: number;
  matches: number;
  fields: number;
  cache?: CacheSnapshot;
};

export type RekordboxMetadataGap = {
  contentId: string;
  title: string;
  artist?: string;
  missing: Array<"album" | "label" | "genre">;
  reasons: Array<
    | "catalog-miss"
    | "catalog-genre-too-broad"
    | "edit-or-unreleased"
    | "genre-taxonomy-missing"
    | "identity-unparsed"
    | "no-isrc"
    | "no-exact-source"
    | "source-metadata-miss"
    | "set-extract"
  >;
};

export type RekordboxMetadataGapSummary = {
  tracks: number;
  fields: number;
  byField: Record<"album" | "label" | "genre", number>;
  byReason: Record<RekordboxMetadataGap["reasons"][number], number>;
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
  providers: Record<string, MetadataProviderStats>;
  provenance: {
    tracks: number;
    links: number;
    byProvider: Partial<Record<Exclude<ExactSourceProvider, "sidecar">, number>>;
  };
  unresolvedSummary: RekordboxMetadataGapSummary;
  unresolved: RekordboxMetadataGap[];
  changes: RekordboxMetadataBackfillChange[];
};

type CacheSnapshot = ReturnType<MusicBrainzMetadataClient["cacheStats"]>;

type MetadataCoverage = {
  album: number;
  label: number;
  genre: number;
  isrc: number;
  releaseDate: number;
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
  exactSources: ExactTrackSource[];
  invalidFields: RepairableMetadataField[];
};

type MetadataCandidate = {
  title?: string | undefined;
  artist?: string | undefined;
  album?: string | undefined;
  label?: string | undefined;
  genre?: string | undefined;
  isrc?: string | undefined;
  releaseDate?: string | undefined;
};

const DEFAULT_FOLDER_NAME = "DJ Sets I Like";

type ManifestMetadataIndex = {
  metadata: Map<string, MetadataCandidate>;
  sources: Map<string, ExactTrackSource[]>;
};

type MetadataCatalogClient = {
  provider: CatalogMetadata["provider"];
  lookup(
    query: Parameters<MusicBrainzMetadataClient["lookup"]>[0],
  ): Promise<CatalogMetadata | undefined>;
  cacheStats(): CacheSnapshot;
};

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
  const manifestRoots = options.manifestRoots ?? defaultManifestRoots();
  const manifestMetadata = await metadataFromManifestRoots(manifestRoots);
  const embeddedMetadata = new Map<string, MetadataCandidate>();
  const paths = tracks.flatMap((track) =>
    track.path && existsSync(track.path) ? [track.path] : [],
  );
  let probed = 0;
  await mapConcurrent(paths, options.probeConcurrency ?? 8, async (path) => {
    try {
      const tags = (await probeAudio(path)).tags;
      embeddedMetadata.set(path, {
        title: clean(tags.title),
        artist: clean(tags.artist),
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
  const localArtistGenres = localArtistGenreConsensus(allTracks);
  const localReleaseMetadata = localReleaseConsensus(allTracks);
  const drafts = tracks.map((track) =>
    createDraft(
      track,
      manifestMetadata,
      embeddedMetadata,
      localMetadata,
      localArtistGenres,
      localReleaseMetadata,
      allTracks,
    ),
  );
  const identityRepairs = drafts.filter(
    (draft) => draft.sources.updatedArtist || draft.sources.updatedTitle,
  ).length;
  options.onProgress?.({
    phase: "identity",
    current: identityRepairs,
    total: tracks.length,
    message: `Recovered ${String(identityRepairs)} local identities`,
  });
  const deezer = options.deezer ?? new DeezerMetadataClient(options.deezerOptions);
  const discogs = options.discogs ?? new DiscogsMetadataClient(options.discogsOptions);
  const apple = options.apple ?? new AppleMetadataClient(options.appleOptions);
  const sourceClients: ExactSourceMetadataClient[] = [
    new SidecarMetadataClient(manifestRoots),
    new SoundCloudMetadataClient(
      options.catalogOptions?.cacheMode ? { cacheMode: options.catalogOptions.cacheMode } : {},
    ),
    new LinkPageMetadataClient(
      options.catalogOptions?.cacheMode ? { cacheMode: options.catalogOptions.cacheMode } : {},
    ),
    new AppleSourceMetadataClient(apple),
    new DeezerSourceMetadataClient(deezer),
    ...(options.sourceClients ?? []).filter(
      (client) => client.provider !== "sidecar" && client.provider !== "soundcloud",
    ),
  ];
  const catalogs: MetadataCatalogClient[] = [
    options.catalog ?? new MusicBrainzMetadataClient(options.catalogOptions),
    apple,
    deezer,
    discogs,
    ...sourceClients.flatMap((client) =>
      client.lookupCatalog
        ? [
            {
              provider: client.provider as CatalogMetadata["provider"],
              lookup: client.lookupCatalog.bind(client),
              cacheStats: client.cacheStats.bind(client),
            },
          ]
        : [],
    ),
  ];
  const providers: Record<string, MetadataProviderStats> = Object.fromEntries(
    [...sourceClients, ...catalogs].map((provider) => [
      provider.provider,
      { queries: 0, matches: 0, fields: 0 },
    ]),
  );
  const sourceTargets = drafts.filter(
    (draft) =>
      needsMetadata(draft.value) && !isSetExtract(draft.value) && draft.exactSources.length,
  );
  let completedSourceTargets = 0;
  await mapConcurrent(sourceTargets, 4, async (draft) => {
    const index = completedSourceTargets;
    const queue = draft.exactSources.map((source) => ({ url: source.url, depth: 0 }));
    const visited = new Set<string>();
    while (queue.length && visited.size < 16) {
      if (!needsMetadata(draft.value)) break;
      const source = queue.shift()!;
      if (visited.has(source.url)) continue;
      visited.add(source.url);
      for (const client of sourceClients) {
        if (!client.supports(source.url)) continue;
        const stats = providers[client.provider]!;
        stats.queries += 1;
        draft.sourceAttempted = true;
        try {
          const metadata = await client.lookup(source.url);
          if (!metadata) continue;
          if (source.depth > 0 && !relatedSourceMatches(draft.value, metadata)) continue;
          const before = metadataFieldCount(draft.value);
          mergeMissing(draft, metadata, client.provider);
          stats.matches += 1;
          stats.fields += metadataFieldCount(draft.value) - before;
          draft.sourceMatched = true;
          for (const related of metadata.relatedUrls ?? []) {
            if (
              !visited.has(related) &&
              sourceClients.some((candidate) => candidate.supports(related))
            )
              queue.push({ url: related, depth: source.depth + 1 });
          }
        } catch (error) {
          options.onProgress?.({
            phase: "source",
            current: index,
            total: sourceTargets.length,
            message: `${client.provider} miss: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    }
    completedSourceTargets += 1;
    options.onProgress?.({
      phase: "source",
      current: completedSourceTargets,
      total: sourceTargets.length,
      message: `Exact-source lookup ${String(completedSourceTargets)}/${String(sourceTargets.length)}`,
    });
  });
  for (const client of sourceClients) {
    const cache = client.cacheStats();
    if (cache) providers[client.provider]!.cache = cache;
  }
  const catalogTargets = drafts.filter(
    ({ value }) =>
      needsMetadata(value) &&
      !isSetExtract(value) &&
      Boolean(value.isrc || (options.catalogSearch && isCatalogSearchSafe(value))),
  );
  let completedCatalogTargets = 0;
  let catalogQueries = 0;
  let catalogMatches = 0;
  await mapConcurrent(catalogTargets, 4, async (draft) => {
    const index = completedCatalogTargets;
    options.onProgress?.({
      phase: "catalog",
      current: index,
      total: catalogTargets.length,
      message: `Catalog lookup: ${draft.track.artist ?? "Unknown Artist"} — ${draft.track.title}`,
    });
    draft.catalogAttempted = true;
    const query = {
      title: catalogLookupTitle(draft.value),
      artists: draft.value.artist ? splitArtists(draft.value.artist) : ["Unknown Artist"],
      ...(draft.value.album ? { album: draft.value.album } : {}),
      ...(draft.value.isrc ? { isrc: draft.value.isrc } : {}),
      ...(draft.value.durationSeconds ? { durationSeconds: draft.value.durationSeconds } : {}),
    };
    const results = await Promise.all(
      catalogs.map(async (catalog) => {
        providers[catalog.provider]!.queries += 1;
        catalogQueries += 1;
        try {
          return await catalog.lookup(query);
        } catch (error) {
          options.onProgress?.({
            phase: "catalog",
            current: index,
            total: catalogTargets.length,
            message: `${catalog.provider} miss: ${error instanceof Error ? error.message : String(error)}`,
          });
          return undefined;
        }
      }),
    );
    for (const metadata of results
      .filter((value): value is CatalogMetadata => value !== undefined)
      .toSorted(
        (left, right) => catalogProviderRank(left.provider) - catalogProviderRank(right.provider),
      )) {
      const before = metadataFieldCount(draft.value);
      mergeMissing(draft, metadata, metadata.provider);
      const fields = metadataFieldCount(draft.value) - before;
      providers[metadata.provider]!.matches += 1;
      providers[metadata.provider]!.fields += fields;
      catalogMatches += 1;
      draft.catalogMatched = true;
    }
    completedCatalogTargets += 1;
    options.onProgress?.({
      phase: "catalog",
      current: completedCatalogTargets,
      total: catalogTargets.length,
      message: `Catalog lookup ${String(completedCatalogTargets)}/${String(catalogTargets.length)}`,
    });
  });
  for (const catalog of catalogs) {
    const cache = catalog.cacheStats();
    if (cache) providers[catalog.provider]!.cache = cache;
  }
  const changes = drafts.flatMap((draft) => changedDraft(draft));
  const projected = tracks.map(
    (track) => drafts.find((draft) => draft.track.id === track.id)!.value,
  );
  const coverageAfter = metadataCoverage(projected);
  const sources = countSources(changes);
  const provenance = summarizeProvenance(drafts);
  const unresolved = unresolvedGaps(drafts);
  const unresolvedSummary = summarizeGaps(unresolved);
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
      providers,
      provenance,
      unresolvedSummary,
      unresolved,
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
      const artists = namedRows(writer, DjmdArtist);
      const albums = namedRows(writer, DjmdAlbum);
      const labels = namedRows(writer, DjmdLabel);
      const genres = namedRows(writer, DjmdGenre);
      for (const [index, change] of changes.entries()) {
        const content = writer.query(DjmdContent).where({ ID: change.contentId }).one();
        let artist = content.Artist;
        if (change.updatedArtist) {
          const key = metadataKey(change.updatedArtist);
          artist = artists.get(key) ?? writer.addArtist(change.updatedArtist);
          artists.set(key, artist);
          content.set("ArtistID", artist.ID);
        }
        if (change.updatedTitle) content.set("Title", change.updatedTitle);
        if (change.album !== undefined) {
          if (change.album === null) content.set("AlbumID", null);
          else {
            const key = metadataKey(change.album);
            const album =
              albums.get(key) ?? writer.addAlbum(change.album, artist ? { artist } : {});
            albums.set(key, album);
            content.set("AlbumID", album.ID);
          }
        }
        if (change.label !== undefined) {
          if (change.label === null) content.set("LabelID", null);
          else {
            const key = metadataKey(change.label);
            const label = labels.get(key) ?? writer.addLabel(change.label);
            labels.set(key, label);
            content.set("LabelID", label.ID);
          }
        }
        if (change.genre !== undefined) {
          if (change.genre === null) content.set("GenreID", null);
          else {
            const key = metadataKey(change.genre);
            const genre = genres.get(key) ?? writer.addGenre(change.genre);
            genres.set(key, genre);
            content.set("GenreID", genre.ID);
          }
        }
        if (change.isrc !== undefined) content.set("ISRC", change.isrc);
        if (change.releaseDate !== undefined) {
          content.set("ReleaseDate", change.releaseDate);
          const year = change.releaseDate ? /^\d{4}/u.exec(change.releaseDate)?.[0] : undefined;
          if (year) content.set("ReleaseYear", Number(year));
          else if (change.releaseDate === null) content.set("ReleaseYear", null);
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
    providers,
    provenance,
    unresolvedSummary,
    unresolved,
    changes,
  };
}

function folderTracks(db: MasterDatabase, folderName: string): LibraryTrack[] {
  const rows = db.selectRawRows(
    `SELECT DISTINCT content."ID" AS id, content."Title" AS title,
            content."FolderPath" AS path, content."Commnt" AS comment,
            content."ISRC" AS isrc,
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
              content."FolderPath" AS path, content."Commnt" AS comment,
              content."ISRC" AS isrc,
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
  const rawMetadata: Record<RepairableMetadataField, unknown> = {
    album: row.album,
    label: row.label,
    genre: row.genre,
    isrc: row.isrc,
    releaseDate: row.releaseDate,
  };
  const metadata = Object.fromEntries(
    (Object.keys(rawMetadata) as RepairableMetadataField[]).flatMap((field) => {
      const value = sanitizeField(field, rawMetadata[field]);
      return value ? [[field, value]] : [];
    }),
  ) as MetadataCandidate;
  const invalidFields = (Object.keys(rawMetadata) as RepairableMetadataField[]).filter(
    (field) => clean(rawMetadata[field]) && !metadata[field],
  );
  return {
    id: String(row.id),
    ...(clean(row.path) ? { path: clean(row.path) } : {}),
    ...metadata,
    title: clean(row.title) ?? "Untitled",
    ...(trustedArtist(row.artist) ? { artist: trustedArtist(row.artist) } : {}),
    ...(positiveNumber(row.durationSeconds)
      ? { durationSeconds: positiveNumber(row.durationSeconds) }
      : {}),
    exactSources: exactSourcesFromRekordboxComment(clean(row.comment)),
    invalidFields,
  };
}

type Draft = {
  track: LibraryTrack;
  value: LibraryTrack;
  sources: RekordboxMetadataBackfillChange["sources"];
  broadCatalogGenreRejected: boolean;
  catalogAttempted: boolean;
  catalogMatched: boolean;
  exactSources: ExactTrackSource[];
  sourceAttempted: boolean;
  sourceMatched: boolean;
};

function createDraft(
  track: LibraryTrack,
  manifests: ManifestMetadataIndex,
  embedded: Map<string, MetadataCandidate>,
  local: Map<string, MetadataCandidate>,
  localArtistGenres: Map<string, MetadataCandidate>,
  localReleaseMetadata: Map<string, MetadataCandidate>,
  allTracks: LibraryTrack[],
): Draft {
  const draft: Draft = {
    track,
    value: { ...track },
    sources: {},
    broadCatalogGenreRejected: false,
    catalogAttempted: false,
    catalogMatched: false,
    exactSources: [...track.exactSources],
    sourceAttempted: false,
    sourceMatched: false,
  };
  let trustedLocalIdentity = false;
  if (track.path) {
    const path = resolve(track.path);
    mergeCandidate(draft, manifests.metadata.get(path), "manifest");
    draft.exactSources = uniqueTrackSources([
      ...draft.exactSources,
      ...(manifests.sources.get(path) ?? []),
    ]);
  }
  if (track.path) mergeCandidate(draft, embedded.get(resolve(track.path)), "embedded");
  if (!draft.value.artist) {
    const repair = inferLocalIdentity(draft.value, allTracks);
    if (repair) {
      mergeCandidate(draft, repair, "filename");
      trustedLocalIdentity = true;
    } else {
      mergeCandidate(draft, inferNamedIdentity(draft.value, allTracks), "filename");
    }
  }
  if (!draft.sources.updatedArtist || trustedLocalIdentity) {
    for (const key of identityKeys(draft.value)) mergeMissing(draft, local.get(key), "local");
  }
  if (draft.value.artist) {
    mergeMissing(
      draft,
      localArtistGenres.get(identityArtistKey(draft.value.artist)),
      "local-artist",
    );
    mergeMissing(draft, localReleaseMetadata.get(releaseFamilyKey(draft.value)), "local-release");
  }
  mergeMissing(draft, titleMetadata(draft.value.title), "title");
  return draft;
}

function mergeCandidate(
  draft: Draft,
  candidate: MetadataCandidate | undefined,
  source: MetadataFieldSource,
): void {
  if (!candidate) return;
  const candidateArtist = trustedArtist(candidate.artist);
  if (!draft.value.artist && candidateArtist) {
    draft.value.artist = candidateArtist;
    draft.sources.updatedArtist = source;
  }
  if (
    candidate.title?.trim() &&
    Boolean(draft.sources.updatedArtist) &&
    metadataKey(candidate.title) !== metadataKey(draft.value.title)
  ) {
    draft.value.title = candidate.title.trim();
    draft.sources.updatedTitle = source;
  }
  mergeMissing(draft, candidate, source);
}

function mergeMissing(
  draft: Draft,
  metadata: MetadataCandidate | CatalogMetadata | undefined,
  source: MetadataFieldSource,
): void {
  if (!metadata) return;
  for (const field of ["album", "label", "genre", "isrc", "releaseDate"] as const) {
    const value = sanitizeField(field, (metadata as MetadataCandidate)[field]);
    if (
      field === "genre" &&
      ["apple", "deezer", "discogs", "musicbrainz", "spotify"].includes(source) &&
      value &&
      isBroadCatalogGenre(value)
    ) {
      draft.broadCatalogGenreRejected = true;
      continue;
    }
    if (!draft.value[field] && value) {
      draft.value[field] = value;
      draft.sources[field] = source;
    }
  }
}

function changedDraft(draft: Draft): RekordboxMetadataBackfillChange[] {
  const fields: RepairableMetadataField[] = ["album", "label", "genre", "isrc", "releaseDate"];
  const entries: Array<[RepairableMetadataField, string | null]> = [];
  for (const field of fields) {
    const current = draft.track[field];
    const value = draft.value[field];
    if (value && (!current || !metadataFieldEqual(field, current, value)))
      entries.push([field, value]);
    else if (!value && draft.track.invalidFields.includes(field)) {
      draft.sources[field] = "sanitized";
      entries.push([field, null]);
    }
  }
  const metadataChanges = Object.fromEntries(entries) as Partial<
    Record<RepairableMetadataField, string | null>
  >;
  const updatedTitle =
    metadataKey(draft.value.title) !== metadataKey(draft.track.title)
      ? draft.value.title
      : undefined;
  const updatedArtist =
    draft.value.artist && metadataKey(draft.value.artist) !== metadataKey(draft.track.artist ?? "")
      ? draft.value.artist
      : undefined;
  if (!updatedTitle && !updatedArtist && !Object.keys(metadataChanges).length) return [];
  return [
    {
      contentId: draft.track.id,
      title: draft.track.title,
      ...(draft.track.artist ? { artist: draft.track.artist } : {}),
      ...(updatedTitle ? { updatedTitle } : {}),
      ...(updatedArtist ? { updatedArtist } : {}),
      ...metadataChanges,
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
        const candidates = [
          ...new Set(
            values
              .map((value) => value[field])
              .filter(
                (candidate): candidate is string =>
                  Boolean(candidate) && (field !== "album" || !isSourceCollectionAlbum(candidate!)),
              ),
          ),
        ];
        if (candidates.length === 1) metadata[field] = candidates[0]!;
      }
      return Object.keys(metadata).length ? [[key, metadata]] : [];
    }),
  );
}

function localArtistGenreConsensus(tracks: LibraryTrack[]): Map<string, MetadataCandidate> {
  const grouped = new Map<string, string[]>();
  for (const track of tracks) {
    if (!track.artist || !track.genre || isBroadCatalogGenre(track.genre)) continue;
    const key = identityArtistKey(track.artist);
    const values = grouped.get(key) ?? [];
    values.push(track.genre);
    grouped.set(key, values);
  }
  return new Map(
    [...grouped].flatMap(([artist, values]) => {
      const counts = new Map<string, { genre: string; count: number }>();
      for (const genre of values) {
        const key = metadataKey(genre);
        const prior = counts.get(key);
        counts.set(key, { genre: prior?.genre ?? genre, count: (prior?.count ?? 0) + 1 });
      }
      const ranked = [...counts.values()].toSorted(
        (left, right) => right.count - left.count || left.genre.localeCompare(right.genre),
      );
      const best = ranked[0];
      if (!best || best.count < 2 || best.count / values.length < 0.75) return [];
      return [[artist, { genre: best.genre }]];
    }),
  );
}

function localReleaseConsensus(tracks: LibraryTrack[]): Map<string, MetadataCandidate> {
  const grouped = new Map<string, LibraryTrack[]>();
  for (const track of tracks) {
    if (!track.artist) continue;
    const key = releaseFamilyKey(track);
    const values = grouped.get(key) ?? [];
    values.push(track);
    grouped.set(key, values);
  }
  return new Map(
    [...grouped].flatMap(([key, values]) => {
      if (values.length < 2) return [];
      const metadata: MetadataCandidate = {};
      for (const field of ["album", "label", "genre", "releaseDate"] as const) {
        const candidates = [
          ...new Set(
            values
              .map((value) => value[field])
              .filter(
                (candidate): candidate is string =>
                  Boolean(candidate) && (field !== "album" || !isSourceCollectionAlbum(candidate!)),
              ),
          ),
        ];
        if (candidates.length === 1) metadata[field] = candidates[0]!;
      }
      return Object.keys(metadata).length ? [[key, metadata]] : [];
    }),
  );
}

function releaseFamilyKey(track: Pick<LibraryTrack, "artist" | "title">): string {
  return `${identityArtistKey(track.artist ?? "")}:${identityTitle(track.title)}`;
}

function titleMetadata(title: string): MetadataCandidate | undefined {
  const label = /\[([^\]]*(?:records?|recordings|music|sounds?))\]\s*$/iu.exec(title)?.[1]?.trim();
  return label ? { label } : undefined;
}

function isSourceCollectionAlbum(value: string): boolean {
  return /\s@\s|\blive\s*@\b|—\s*reviewed recordings$/iu.test(value);
}

function inferLocalIdentity(
  track: LibraryTrack,
  allTracks: LibraryTrack[],
): MetadataCandidate | undefined {
  if (track.artist) return undefined;
  const candidates = filenameIdentityCandidates(track.title);
  const matches = candidates
    .flatMap((candidate) =>
      allTracks.flatMap((known) => {
        if (!known.artist || known.id === track.id) return [];
        if (identityTitle(candidate.title) !== identityTitle(known.title)) return [];
        const artistScore = identitySimilarity(candidate.artist, known.artist);
        if (artistScore < 0.6) return [];
        const durationScore = durationSimilarity(track.durationSeconds, known.durationSeconds);
        if (durationScore < 0.6) return [];
        return [{ known, score: artistScore * 0.75 + durationScore * 0.25 }];
      }),
    )
    .toSorted((left, right) => right.score - left.score);
  const unique = matches.filter(
    (match, index, values) =>
      values.findIndex(
        (candidate) =>
          identityArtistKey(candidate.known.artist ?? "") ===
            identityArtistKey(match.known.artist ?? "") &&
          identityTitle(candidate.known.title) === identityTitle(match.known.title),
      ) === index,
  );
  const best = unique[0];
  if (!best || best.score < 0.72 || best.score - (unique[1]?.score ?? 0) < 0.08) return undefined;
  return {
    title: best.known.title,
    artist: best.known.artist,
    ...(best.known.album ? { album: best.known.album } : {}),
    ...(best.known.label ? { label: best.known.label } : {}),
    ...(best.known.genre ? { genre: best.known.genre } : {}),
    ...(best.known.isrc ? { isrc: best.known.isrc } : {}),
    ...(best.known.releaseDate ? { releaseDate: best.known.releaseDate } : {}),
  };
}

function inferNamedIdentity(
  track: LibraryTrack,
  allTracks: LibraryTrack[],
): MetadataCandidate | undefined {
  const matches = filenameIdentityCandidates(track.title)
    .flatMap((candidate) =>
      allTracks.flatMap((known) => {
        if (!known.artist || known.id === track.id) return [];
        if (identityTitle(candidate.title) !== identityTitle(known.title)) return [];
        const score = identitySimilarity(candidate.artist, known.artist);
        return score >= 0.75 ? [{ known, score }] : [];
      }),
    )
    .toSorted((left, right) => right.score - left.score);
  const unique = matches.filter(
    (match, index, values) =>
      values.findIndex(
        (candidate) =>
          identityArtistKey(candidate.known.artist ?? "") ===
            identityArtistKey(match.known.artist ?? "") &&
          identityTitle(candidate.known.title) === identityTitle(match.known.title),
      ) === index,
  );
  const best = unique[0];
  if (!best || best.score - (unique[1]?.score ?? 0) < 0.08) return undefined;
  return { title: best.known.title, artist: best.known.artist };
}

function filenameIdentityCandidates(value: string): Array<{ artist: string; title: string }> {
  const parts = value
    .split(/\s+-\s+/u)
    .map(cleanIdentityFragment)
    .filter(Boolean);
  const candidates: Array<{ artist: string; title: string }> = [];
  for (let index = 1; index < parts.length; index += 1) {
    const left = parts.slice(0, index).join(" - ");
    const right = parts.slice(index).join(" - ");
    candidates.push({ artist: left, title: right }, { artist: right, title: left });
  }
  return candidates;
}

function cleanIdentityFragment(value: string): string {
  return value
    .replace(/\s+(?:https?:\/\/|www\.).*$/iu, "")
    .replace(/\s+\d{2,3}\s*$/u, "")
    .trim();
}

function identityTitle(value: string): string {
  return normalizeMatchText(cleanTitle(cleanIdentityFragment(value)))
    .replace(/\b(?:original|extended|radio)(?:\s+(?:mix|edit))?\b/gu, "")
    .trim();
}

function identitySimilarity(left: string, right: string): number {
  const expected = normalizeMatchText(left);
  const actual = normalizeMatchText(right);
  if (!expected || !actual) return 0;
  if (expected === actual) return 1;
  const expectedTokens = new Set(expected.split(" ").filter((token) => token !== "and"));
  const actualTokens = new Set(actual.split(" ").filter((token) => token !== "and"));
  const matched = [...expectedTokens].filter((token) => actualTokens.has(token)).length;
  return matched / Math.max(expectedTokens.size, actualTokens.size);
}

function relatedSourceMatches(track: LibraryTrack, metadata: ExactSourceMetadata): boolean {
  if (track.durationSeconds && metadata.durationSeconds) {
    const difference = Math.abs(track.durationSeconds - metadata.durationSeconds);
    if (difference > Math.max(10, track.durationSeconds * 0.06)) return false;
  }
  if (metadata.title && identitySimilarity(track.title, metadata.title) < 0.5) return false;
  if (track.artist && metadata.artist && identitySimilarity(track.artist, metadata.artist) < 0.45)
    return false;
  return true;
}

function identityArtistKey(value: string): string {
  return normalizeMatchText(value)
    .split(" ")
    .filter((token) => token && token !== "and")
    .toSorted()
    .join(" ");
}

function durationSimilarity(left: number | undefined, right: number | undefined): number {
  if (!left || !right) return 0;
  const difference = Math.abs(left - right);
  return Math.max(0, 1 - difference / Math.max(10, Math.max(left, right) * 0.04));
}

function identityKeys(
  track: Pick<LibraryTrack, "title" | "artist" | "isrc" | "durationSeconds">,
): string[] {
  const isrc = normalizeIsrc(track.isrc);
  const durationBucket = track.durationSeconds
    ? `:duration:${String(Math.round(track.durationSeconds / 5) * 5)}`
    : undefined;
  return [
    ...(durationBucket
      ? [
          `text:${metadataKey(track.artist ?? "")}:${metadataKey(cleanTitle(track.title))}${durationBucket}`,
        ]
      : []),
    ...(isrc ? [`isrc:${isrc}`] : []),
  ];
}

async function metadataFromManifestRoots(roots: string[]): Promise<ManifestMetadataIndex> {
  const metadata = new Map<string, MetadataCandidate>();
  const sources = new Map<string, ExactTrackSource[]>();
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
          title: clean(identity.title) ?? clean(spotify.name),
          artist:
            clean(identity.artist) ?? array(spotify.artists).map(clean).filter(Boolean).join(", "),
          album: clean(spotify.album) ?? clean(identity.album),
          label: clean(identity.label),
          genre: clean(identity.genre),
          isrc: clean(spotify.isrc) ?? clean(identity.isrc),
          releaseDate: clean(spotify.releaseDate) ?? clean(identity.releaseDate),
        };
        for (const rawDownload of [acquisition.download, ...array(acquisition.alternatives)]) {
          const download = record(rawDownload);
          const mediaPath = clean(download.mediaPath);
          if (!mediaPath) continue;
          const resolvedPath = resolve(mediaPath);
          metadata.set(resolvedPath, candidate);
          if (!record(download.clip).sourceSetUrl) {
            const spotifyUrl =
              clean(spotify.url) ??
              (clean(download.spotifyId)
                ? `https://open.spotify.com/track/${clean(download.spotifyId)!}`
                : undefined);
            const exactSources = exactSourcesFromUrls([clean(download.source), spotifyUrl]);
            if (exactSources.length) sources.set(resolvedPath, exactSources);
          }
        }
      }
    }
  }
  return { metadata, sources };
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
  const title = catalogLookupTitle(track);
  return (
    Boolean(track.artist) &&
    Boolean(track.durationSeconds) &&
    !/^unknown artist$/iu.test(track.artist!) &&
    !/\b(?:edit|bootleg|unreleased|candidate|mashup)\b|https?:|www\./iu.test(title)
  );
}

function catalogLookupTitle(track: Pick<LibraryTrack, "artist" | "title">): string {
  const title = cleanIdentityFragment(track.title);
  if (!track.artist) return title;
  const [prefix, ...rest] = title.split(/\s+-\s+/u);
  if (!prefix || !rest.length) return title;
  const normalizedPrefix = normalizeMatchText(prefix);
  const normalizedArtist = normalizeMatchText(track.artist);
  const prefixMatchesArtist =
    identitySimilarity(prefix, track.artist) >= 0.6 ||
    normalizedPrefix.startsWith(normalizedArtist) ||
    normalizedArtist.startsWith(normalizedPrefix);
  return prefixMatchesArtist ? rest.join(" - ") : title;
}

function metadataCoverage(tracks: Array<MetadataCandidate>): MetadataCoverage {
  return {
    album: tracks.filter((track) => track.album).length,
    label: tracks.filter((track) => track.label).length,
    genre: tracks.filter((track) => track.genre).length,
    isrc: tracks.filter((track) => track.isrc).length,
    releaseDate: tracks.filter((track) => track.releaseDate).length,
  };
}

function countSources(
  changes: RekordboxMetadataBackfillChange[],
): Record<MetadataFieldSource, number> {
  const counts: Record<MetadataFieldSource, number> = {
    apple: 0,
    bandcamp: 0,
    deezer: 0,
    discogs: 0,
    embedded: 0,
    filename: 0,
    linkpage: 0,
    local: 0,
    "local-artist": 0,
    "local-release": 0,
    manifest: 0,
    musicbrainz: 0,
    sanitized: 0,
    sidecar: 0,
    soundcloud: 0,
    spotify: 0,
    title: 0,
    youtube: 0,
  };
  for (const change of changes) {
    for (const source of Object.values(change.sources)) if (source) counts[source] += 1;
  }
  return counts;
}

function catalogProviderRank(provider: CatalogMetadata["provider"]): number {
  return provider === "musicbrainz"
    ? 0
    : provider === "spotify"
      ? 1
      : provider === "discogs"
        ? 2
        : provider === "apple"
          ? 3
          : 4;
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
    if (change.updatedTitle && metadataKey(track.title) !== metadataKey(change.updatedTitle)) {
      throw new Error(`Metadata verification failed for ${change.contentId}: title`);
    }
    if (
      change.updatedArtist &&
      metadataKey(track.artist ?? "") !== metadataKey(change.updatedArtist)
    ) {
      throw new Error(`Metadata verification failed for ${change.contentId}: artist`);
    }
    for (const field of ["album", "label", "genre", "isrc", "releaseDate"] as const) {
      if (change[field] === undefined) continue;
      const matches =
        change[field] === null
          ? track[field] === undefined
          : metadataFieldEqual(field, track[field], change[field]);
      if (!matches) {
        throw new Error(`Metadata verification failed for ${change.contentId}: ${field}`);
      }
    }
  }
}

function metadataFieldCount(track: MetadataCandidate): number {
  return [track.album, track.label, track.genre, track.isrc, track.releaseDate].filter(Boolean)
    .length;
}

function unresolvedGaps(drafts: Draft[]): RekordboxMetadataGap[] {
  return drafts.flatMap((draft) => {
    const missing = (["album", "label", "genre"] as const).filter((field) => !draft.value[field]);
    if (!missing.length) return [];
    const reasons = new Set<RekordboxMetadataGap["reasons"][number]>();
    if (!draft.value.artist) reasons.add("identity-unparsed");
    if (isSetExtract(draft.value)) reasons.add("set-extract");
    if (/\b(?:edit|bootleg|unreleased|candidate|mashup)\b/iu.test(draft.value.title))
      reasons.add("edit-or-unreleased");
    if (!draft.value.isrc) reasons.add("no-isrc");
    if (!draft.exactSources.length) reasons.add("no-exact-source");
    if (draft.sourceAttempted && !draft.sourceMatched) reasons.add("source-metadata-miss");
    if (draft.catalogAttempted && !draft.catalogMatched) reasons.add("catalog-miss");
    if (missing.includes("genre") && draft.broadCatalogGenreRejected)
      reasons.add("catalog-genre-too-broad");
    if (missing.includes("genre")) reasons.add("genre-taxonomy-missing");
    return [
      {
        contentId: draft.track.id,
        title: draft.value.title,
        ...(draft.value.artist ? { artist: draft.value.artist } : {}),
        missing: [...missing],
        reasons: [...reasons],
      },
    ];
  });
}

function summarizeGaps(gaps: RekordboxMetadataGap[]): RekordboxMetadataGapSummary {
  const byField: RekordboxMetadataGapSummary["byField"] = { album: 0, label: 0, genre: 0 };
  const byReason: RekordboxMetadataGapSummary["byReason"] = {
    "catalog-miss": 0,
    "catalog-genre-too-broad": 0,
    "edit-or-unreleased": 0,
    "genre-taxonomy-missing": 0,
    "identity-unparsed": 0,
    "no-isrc": 0,
    "no-exact-source": 0,
    "source-metadata-miss": 0,
    "set-extract": 0,
  };
  let fields = 0;
  for (const gap of gaps) {
    fields += gap.missing.length;
    for (const field of gap.missing) byField[field] += 1;
    for (const reason of gap.reasons) byReason[reason] += 1;
  }
  return { tracks: gaps.length, fields, byField, byReason };
}

function summarizeProvenance(drafts: Draft[]): RekordboxMetadataBackfillResult["provenance"] {
  const byProvider: RekordboxMetadataBackfillResult["provenance"]["byProvider"] = {};
  let links = 0;
  let tracks = 0;
  for (const draft of drafts) {
    if (!draft.exactSources.length) continue;
    tracks += 1;
    links += draft.exactSources.length;
    for (const provider of new Set(draft.exactSources.map((source) => source.provider))) {
      byProvider[provider] = (byProvider[provider] ?? 0) + 1;
    }
  }
  return { tracks, links, byProvider };
}

function uniqueTrackSources(sources: ExactTrackSource[]): ExactTrackSource[] {
  return [
    ...new Map(
      sources.map((source) => [`${source.provider}:${source.url}`, source] as const),
    ).values(),
  ];
}

function isBroadCatalogGenre(value: string): boolean {
  return /^(?:dance|electro|electronic)$/iu.test(value.trim());
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

function trustedMetadata(
  field: Exclude<RepairableMetadataField, "isrc" | "releaseDate">,
  value: unknown,
): string | undefined {
  const cleaned = clean(value);
  if (!cleaned || /^(?:unknown|none|n\/a)$/iu.test(cleaned)) return undefined;
  if (
    /https?:|www\.|\b(?:djsoundtop|electronicfresh|fordjonly|iptorrents)\b|whatsapp|contatos|acesse:|drive(?:dos)?djs/iu.test(
      cleaned,
    )
  )
    return undefined;
  if (field === "genre" && (cleaned.length > 80 || (cleaned.match(/,/gu)?.length ?? 0) > 3))
    return undefined;
  if (field === "label" && cleaned.length > 100) return undefined;
  return cleaned;
}

function trustedArtist(value: unknown): string | undefined {
  const cleaned = clean(value);
  if (!cleaned || /^(?:id|unknown artist|none|n\/a|\d{1,3})$/iu.test(cleaned)) return undefined;
  return cleaned;
}

function sanitizeField(
  field: "album" | "label" | "genre" | "isrc" | "releaseDate",
  value: unknown,
): string | undefined {
  if (field === "isrc") return normalizeIsrc(clean(value));
  if (field === "releaseDate") return normalizeReleaseDate(clean(value));
  return trustedMetadata(field, value);
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
