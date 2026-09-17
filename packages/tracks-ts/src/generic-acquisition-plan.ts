import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  AcquisitionClipPlan,
  AcquisitionPlan,
  AcquisitionRecordingVariant,
} from "./acquire-manifest.js";
import type { AudioMetadata } from "./acquisition.js";
import { canonicalTrackPath, defaultTrackLibraryRoot, latinize } from "./library-paths.js";
import type { ResolvedTrack, SetManifest, SpotifyCandidate } from "./manifest.js";

export type BuildAcquisitionPlanOptions = {
  /** Canonical library root. Defaults to DJBOOTH_LIBRARY_ROOT or ~/.djtools/tracks. */
  outputDirectory?: string;
  /** Absolute directories searched recursively for explicitly adopted local recordings. */
  localDirectories?: readonly string[];
  /** Explicitly permit cue-bounded recovery of unresolved IDs from a verified local set source. */
  allowSourceSetClips?: boolean;
  /** Absolute path matching manifest.artifacts.sourceSet.path. Never downloaded by this builder. */
  sourceSetPath?: string;
  /** Keep an entire verified mix as one recording, instead of acquiring its constituent tracks. */
  wholeSet?: boolean;
  /** Re-attempt standalone recordings before honoring earlier set-clip failures. */
  retryIndividualRecordings?: boolean;
  /** Absolute scratch directory. Defaults to `<outputDirectory>/.staging`. */
  stagingDirectory?: string;
};

type RecordingIdentity = {
  spotifyId?: string;
  relationship?: "overlap";
  isrc?: string;
  title: string;
  artists: string[];
  album?: string;
  albumArtists?: string[];
  label?: string;
  genre?: string;
  releaseDate?: string;
  durationMs?: number;
  searchQuery: string;
};

type LocalArtifact = {
  path: string;
  normalizedStem: string;
  directoryIndex: number;
};

const ADOPTABLE_AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".aif",
  ".aiff",
  ".flac",
  ".m4a",
  ".mp3",
  ".wav",
  ".wave",
]);

/**
 * Derive a complete individual-recording plan from any resolved manifest. Spotify ambiguities fan
 * out to every candidate; identified Spotify misses retain their tracklist identity. The builder
 * only plans individual downloads unless cue clips and an already verified local source are both
 * explicitly supplied.
 */
export async function buildAcquisitionPlan(
  manifest: SetManifest,
  options: BuildAcquisitionPlanOptions,
): Promise<AcquisitionPlan> {
  const outputDirectory = options.outputDirectory ?? defaultTrackLibraryRoot();
  requireAbsolute(outputDirectory, "outputDirectory");
  const stagingDirectory = options.stagingDirectory ?? join(outputDirectory, ".staging");
  requireAbsolute(stagingDirectory, "stagingDirectory");
  for (const directory of options.localDirectories ?? []) {
    requireAbsolute(directory, "localDirectories");
  }
  const sourceSet = sourceSetForClips(manifest, options);
  if (options.wholeSet) {
    if (
      !sourceSet ||
      manifest.entries.length !== 1 ||
      manifest.entries[0]!.identity.status !== "identified"
    )
      throw new Error(
        "Whole-set acquisition requires one identified entry and a verified source set",
      );
    const entry = manifest.entries[0]!;
    const identity = tracklistIdentity(entry);
    return {
      stagingDirectory,
      recordings: [],
      sourceSets: [sourceSet.descriptor],
      clips: [
        {
          entryOrder: entry.order,
          sourcePath: sourceSet.descriptor.path,
          sourceUrl: sourceSet.artifact.url,
          outputPath: canonicalTrackPath(outputDirectory, {
            title: identity.title,
            artists: identity.artists,
            qualifier: `full-set-${sourceSet.artifact.sha256.slice(0, 12)}`,
            extension: clipOutputExtension(sourceSet.artifact.path),
          }),
          startSeconds: 0,
          endSeconds: sourceSet.artifact.durationSeconds,
          metadata: {
            title: identity.title,
            artists: identity.artists,
            album: "DJ Sets",
            grouping: "djbooth full DJ set",
            comment: `Full DJ set\nSource: ${sourceSet.artifact.url}`,
          },
          qualityNote:
            "Complete original DJ mix; transitions and original source quality preserved.",
          containsTransitions: true,
        },
      ],
    };
  }
  const localDirectories = [...new Set([outputDirectory, ...(options.localDirectories ?? [])])];
  // A set excerpt is never a standalone recording, even when its filename/Spotify ID matches.
  const clipPaths = new Set(
    manifest.entries.flatMap((entry) =>
      entry.acquisition.status === "downloaded"
        ? [entry.acquisition.download, ...(entry.acquisition.alternatives ?? [])]
            .filter(
              (download) => download.kind === "source-set-clip" || download.clip !== undefined,
            )
            .map((download) => resolve(download.mediaPath))
        : [],
    ),
  );
  const artifacts = (await discoverLocalArtifacts(localDirectories)).filter(
    (artifact) =>
      !clipPaths.has(resolve(artifact.path)) && !/\[set[ -]extract(?:\]|-)/i.test(artifact.path),
  );
  const adoptedPaths = new Set<string>();
  const recordings = manifest.entries.flatMap((entry) => {
    const identities = recordingIdentities(entry);
    if (!identities.length) return [];
    // Re-resolving a set can replace identities and their old failure history.
    // Its output directory can still contain extracts named like recordings.
    // Verified individual downloads resume from their durable acquisition rows.
    const availableArtifacts = sourceSet
      ? artifacts.filter((artifact) => !isWithin(outputDirectory, artifact.path))
      : artifacts;
    return [
      {
        entryOrder: entry.order,
        variants: identities.map((identity) => {
          const local = selectLocalArtifact(identity, availableArtifacts, adoptedPaths);
          if (local) adoptedPaths.add(local.path);
          return recordingVariant(
            manifest,
            entry,
            identity,
            outputDirectory,
            local,
            options.retryIndividualRecordings ? undefined : sourceSet,
          );
        }),
      },
    ];
  });
  const clips = sourceSet
    ? manifest.entries.flatMap((entry) =>
        entry.identity.status === "unidentified"
          ? unresolvedClip(manifest, entry, outputDirectory, sourceSet)
          : [],
      )
    : [];

  return {
    clips,
    recordings,
    stagingDirectory,
    ...(sourceSet ? { sourceSets: [sourceSet.descriptor] } : {}),
  };
}

function recordingIdentities(entry: ResolvedTrack): RecordingIdentity[] {
  if (entry.acquisition.status === "skipped") return [];
  const primary =
    entry.spotify.status === "matched"
      ? [spotifyIdentity(entry.spotify, entry)]
      : entry.spotify.status === "ambiguous"
        ? entry.spotify.candidates.map((candidate) => spotifyIdentity(candidate, entry))
        : (entry.spotify.status === "unmatched" || entry.spotify.status === "pending") &&
            entry.identity.status === "identified"
          ? [tracklistIdentity(entry)]
          : [];
  const overlaps = primary.length
    ? (entry.identity.overlaps ?? []).map(
        (overlap): RecordingIdentity => ({
          relationship: "overlap",
          title: overlap.title,
          artists: [overlap.artist],
          searchQuery: `${overlap.artist} - ${overlap.title}`,
        }),
      )
    : [];
  return [...primary, ...overlaps].filter(
    (identity, index, identities) =>
      identities.findIndex(
        (candidate) =>
          candidate.spotifyId === identity.spotifyId &&
          candidate.relationship === identity.relationship &&
          (identity.spotifyId !== undefined ||
            (normalizeIdentity(candidate.title) === normalizeIdentity(identity.title) &&
              normalizeIdentity(candidate.artists.join(" ")) ===
                normalizeIdentity(identity.artists.join(" ")))),
      ) === index,
  );
}

function tracklistIdentity(entry: ResolvedTrack): RecordingIdentity {
  if (entry.identity.status !== "identified") throw new Error("Track identity is unresolved");
  const title = displayIdentityTitle(entry.identity.title, entry.identity.mix);
  const duration = entry.identity.mediaLinks?.find(
    (link) => link.platform === "soundcloud",
  )?.durationSeconds;
  return {
    ...(entry.identity.isrc ? { isrc: entry.identity.isrc } : {}),
    title,
    ...(duration === undefined ? {} : { durationMs: duration * 1000 }),
    artists: [entry.identity.artist],
    ...(entry.identity.album ? { album: entry.identity.album } : {}),
    ...(entry.identity.label ? { label: entry.identity.label } : {}),
    ...(entry.identity.genre ? { genre: entry.identity.genre } : {}),
    ...(entry.identity.releaseDate ? { releaseDate: entry.identity.releaseDate } : {}),
    searchQuery: entry.identity.searchQuery,
  };
}

function spotifyIdentity(
  candidate: SpotifyCandidate | Extract<ResolvedTrack["spotify"], { status: "matched" }>,
  entry: ResolvedTrack,
): RecordingIdentity {
  const title = candidate.name ?? entry.identity.title ?? `Track ${entry.order}`;
  const artists =
    candidate.artists ?? (entry.identity.artist ? [entry.identity.artist] : ["Unknown Artist"]);
  return {
    spotifyId: candidate.id,
    ...(candidate.isrc ? { isrc: candidate.isrc } : {}),
    title,
    artists: [...artists],
    ...(candidate.album ? { album: candidate.album } : {}),
    ...(candidate.albumArtists ? { albumArtists: [...candidate.albumArtists] } : {}),
    ...(entry.identity.label ? { label: entry.identity.label } : {}),
    ...(entry.identity.genre ? { genre: entry.identity.genre } : {}),
    ...(candidate.releaseDate ? { releaseDate: candidate.releaseDate } : {}),
    ...(candidate.durationMs === undefined ? {} : { durationMs: candidate.durationMs }),
    searchQuery: `${artists.join(" ")} ${title}`,
  };
}

function recordingVariant(
  manifest: SetManifest,
  entry: ResolvedTrack,
  identity: RecordingIdentity,
  outputDirectory: string,
  local: LocalArtifact | undefined,
  sourceSet: ReturnType<typeof sourceSetForClips>,
): AcquisitionRecordingVariant {
  const identityKey =
    identity.spotifyId ??
    createHash("sha256")
      .update(
        `${identity.artists.join("\u0000")}\u0000${identity.title}\u0000${identity.isrc ?? ""}`,
      )
      .digest("hex")
      .slice(0, 12);
  const suffix = identity.spotifyId
    ? `spotify-${identity.spotifyId}`
    : `${identity.relationship ?? "identity"}-${identityKey}`;
  const extension = local ? adoptedOutputExtension(local.path) : ".m4a";
  const matchedBy = local
    ? (priorLocalMatchKind(entry, identity) ?? localMatchKind(identity, local))
    : undefined;
  const fallbackClip =
    !local && hasSourceSetRecoveryHistory(entry) && sourceSet
      ? identifiedFailureClip(entry, sourceSet)
      : undefined;
  const metadata: AudioMetadata = {
    title: identity.title,
    artists: [...identity.artists],
    ...(identity.album ? { album: identity.album } : {}),
    ...(identity.albumArtists?.length ? { albumArtists: [...identity.albumArtists] } : {}),
    ...(identity.label ? { label: identity.label } : {}),
    ...(identity.genre ? { genre: identity.genre } : {}),
    ...(identity.releaseDate ? { releaseDate: identity.releaseDate } : {}),
    ...(identity.isrc ? { isrc: identity.isrc } : {}),
    comment: recordingComment(manifest, identity),
    trackNumber: entry.order,
    trackTotal: manifest.entries.length,
    grouping: "music-ts resolved set",
  };
  if (matchedBy === "artist-title" && identity.spotifyId) {
    delete metadata.isrc;
    metadata.comment = `${metadata.comment}\n[Local artist/title match; exact Spotify recording identity unconfirmed]`;
  }
  if (fallbackClip) {
    delete metadata.isrc;
    metadata.title = `${metadata.title} [Set Extract]`;
    metadata.comment = `${metadata.comment}\n[Individual acquisition failed; recovered from verified set cue ${String(fallbackClip.startSeconds)}–${String(fallbackClip.endSeconds)}s]`;
    metadata.grouping = "music-ts set extract";
  }
  const preferredCandidate =
    !local && !fallbackClip ? exactMediaCandidate(entry, identity) : undefined;
  return {
    ...(identity.spotifyId ? { spotifyId: identity.spotifyId } : {}),
    ...(identity.isrc ? { isrc: identity.isrc } : {}),
    title: identity.title,
    artists: [...identity.artists],
    ...(identity.album ? { album: identity.album } : {}),
    ...(identity.albumArtists ? { albumArtists: [...identity.albumArtists] } : {}),
    ...(identity.label ? { label: identity.label } : {}),
    ...(identity.genre ? { genre: identity.genre } : {}),
    ...(identity.releaseDate ? { releaseDate: identity.releaseDate } : {}),
    ...(identity.durationMs === undefined ? {} : { durationMs: identity.durationMs }),
    outputPath: canonicalTrackPath(outputDirectory, {
      title: identity.title,
      artists: identity.artists,
      ...(identity.album ? { album: identity.album } : {}),
      qualifier: suffix,
      extension,
    }),
    metadata,
    searchQuery: identity.searchQuery,
    ...(preferredCandidate
      ? {
          preferredCandidate,
          preferredCandidatePlacement: "backend-fallback" as const,
        }
      : {}),
    ...(local
      ? {
          localArtifact: {
            sourcePath: local.path,
            matchedBy: matchedBy!,
          },
        }
      : {}),
    ...(fallbackClip ? { sourceClip: fallbackClip } : {}),
  };
}

function exactMediaCandidate(
  entry: ResolvedTrack,
  identity: RecordingIdentity,
): AcquisitionRecordingVariant["preferredCandidate"] {
  if (identity.relationship) return undefined;
  const media = entry.identity.mediaLinks ?? [];
  if (
    identity.spotifyId &&
    !media.some((link) => link.platform === "spotify" && link.sourceId === identity.spotifyId)
  ) {
    return undefined;
  }
  const exact =
    media.find((link) => link.platform === "soundcloud") ??
    media.find((link) => link.platform === "youtube");
  if (!exact) return undefined;
  return {
    backend: "ytdlp",
    id: exact.sourceId,
    source: exact.url,
    title: identity.title,
    artist: identity.artists.join(", "),
    ...(exact.durationSeconds === undefined && identity.durationMs === undefined
      ? {}
      : {
          durationSeconds: exact.durationSeconds ?? Math.round(identity.durationMs! / 1000),
        }),
  };
}

function priorLocalMatchKind(
  entry: ResolvedTrack,
  identity: RecordingIdentity,
): "spotify-id" | "isrc" | "artist-title" | undefined {
  if (!identity.spotifyId) return undefined;
  const prefix = `${identity.spotifyId} adopted local artifact matched by `;
  const warning = entry.warnings.find((value) => value.startsWith(prefix));
  const matchedBy = warning?.slice(prefix.length);
  return matchedBy === "spotify-id" || matchedBy === "isrc" || matchedBy === "artist-title"
    ? matchedBy
    : undefined;
}

function hasSourceSetRecoveryHistory(entry: ResolvedTrack): boolean {
  const downloads =
    entry.acquisition.status === "downloaded"
      ? [entry.acquisition.download, ...(entry.acquisition.alternatives ?? [])]
      : [];
  return (
    downloads.some((download) => download.kind === "source-set-clip") ||
    entry.errors.some((error) => error.stage === "acquisition") ||
    entry.warnings.some((warning) => warning.includes("cue-based source-set extract"))
  );
}

function identifiedFailureClip(
  entry: ResolvedTrack,
  sourceSet: NonNullable<ReturnType<typeof sourceSetForClips>>,
): NonNullable<AcquisitionRecordingVariant["sourceClip"]> | undefined {
  const { startSeconds, endSeconds } = entry.cue;
  if (startSeconds === undefined || endSeconds === undefined || endSeconds <= startSeconds) {
    return undefined;
  }
  return {
    sourcePath: sourceSet.descriptor.path,
    sourceUrl: sourceSet.artifact.url,
    startSeconds,
    endSeconds,
    qualityNote:
      "Cue-bounded set recovery after individual acquisition failed; transitions and lossy ancestry may be present.",
    containsTransitions: true,
  };
}

function recordingComment(manifest: SetManifest, identity: RecordingIdentity): string {
  return [
    identity.spotifyId
      ? `[Spotify Enriched] https://open.spotify.com/track/${identity.spotifyId}`
      : identity.relationship === "overlap"
        ? "[Tracklist Overlap Identity]"
        : "[Tracklist Identity; Spotify Unmatched]",
    ...(identity.isrc ? [`ISRC: ${identity.isrc}`] : []),
    `Set: ${manifest.source.title ?? manifest.source.input}`,
    ...(manifest.tracklist.url ? [`Tracklist: ${manifest.tracklist.url}`] : []),
  ].join("\n");
}

function sourceSetForClips(manifest: SetManifest, options: BuildAcquisitionPlanOptions) {
  if (!options.allowSourceSetClips) {
    if (options.sourceSetPath) {
      throw new Error("sourceSetPath requires allowSourceSetClips: true");
    }
    return undefined;
  }
  if (!options.sourceSetPath) {
    throw new Error("allowSourceSetClips requires an explicit sourceSetPath");
  }
  requireAbsolute(options.sourceSetPath, "sourceSetPath");
  const artifact = manifest.artifacts.sourceSet;
  if (!artifact) {
    throw new Error("Cue clips require manifest.artifacts.sourceSet verification metadata");
  }
  if (resolve(artifact.path) !== resolve(options.sourceSetPath)) {
    throw new Error("sourceSetPath must match manifest.artifacts.sourceSet.path");
  }
  return {
    artifact,
    descriptor: {
      path: resolve(artifact.path),
      sha256: artifact.sha256,
      durationSeconds: artifact.durationSeconds,
      codec: artifact.codec,
      bitrate: artifact.bitrate,
    },
  };
}

function unresolvedClip(
  manifest: SetManifest,
  entry: ResolvedTrack,
  outputDirectory: string,
  sourceSet: NonNullable<ReturnType<typeof sourceSetForClips>>,
): AcquisitionClipPlan[] {
  const { startSeconds, endSeconds } = entry.cue;
  if (startSeconds === undefined || endSeconds === undefined || endSeconds <= startSeconds)
    return [];
  const artist = entry.identity.artist?.trim() || "Unknown Artist";
  const title = entry.identity.title?.trim() || `Unresolved ID ${entry.order}`;
  const extension = clipOutputExtension(sourceSet.artifact.path);
  const metadata: AudioMetadata = {
    title: `${title} [Set Extract]`,
    artists: [artist],
    album: manifest.source.title ?? "DJ Set Extract",
    comment: [
      "[Set Extract]",
      `Source: ${manifest.source.title ?? manifest.source.input}`,
      `Source URL: ${sourceSet.artifact.url}`,
      `Set range: ${startSeconds}–${endSeconds}s`,
      "Quality: cue-bounded set recording; transitions may be present",
    ].join("\n"),
    trackNumber: entry.order,
    trackTotal: manifest.entries.length,
    grouping: "music-ts set extract",
  };
  return [
    {
      entryOrder: entry.order,
      sourcePath: sourceSet.descriptor.path,
      sourceUrl: sourceSet.artifact.url,
      ...(manifest.source.title ? { sourceTitle: manifest.source.title } : {}),
      outputPath: canonicalTrackPath(outputDirectory, {
        title,
        artists: [artist],
        ...(metadata.album ? { album: metadata.album } : {}),
        qualifier: `set-extract-${createHash("sha256")
          .update(
            `${sourceSet.artifact.url}\u0000${String(startSeconds)}\u0000${String(endSeconds)}`,
          )
          .digest("hex")
          .slice(0, 12)}`,
        extension,
      }),
      startSeconds,
      endSeconds,
      metadata,
      qualityNote: "Cue-bounded set recording; transitions and lossy ancestry may be present.",
      containsTransitions: true,
    },
  ];
}

async function discoverLocalArtifacts(directories: readonly string[]): Promise<LocalArtifact[]> {
  const groups = await Promise.all(
    directories.map(async (directory, directoryIndex) =>
      (await walkAudioFiles(resolve(directory))).map((path) => ({ path, directoryIndex })),
    ),
  );
  const seen = new Set<string>();
  return groups.flat().flatMap(({ path, directoryIndex }) => {
    if (seen.has(path)) return [];
    seen.add(path);
    return [
      {
        path,
        directoryIndex,
        normalizedStem: normalizeIdentity(path.slice(0, -extname(path).length)),
      },
    ];
  });
}

async function walkAudioFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const paths = await Promise.all(
    entries
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map(async (entry): Promise<string[]> => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return entry.name === ".staging" ? [] : walkAudioFiles(path);
        if (!entry.isFile() || !ADOPTABLE_AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          return [];
        }
        return [path];
      }),
  );
  return paths.flat();
}

function selectLocalArtifact(
  identity: RecordingIdentity,
  artifacts: readonly LocalArtifact[],
  adopted: ReadonlySet<string>,
): LocalArtifact | undefined {
  const ranked = artifacts
    .filter((artifact) => !adopted.has(artifact.path))
    .map((artifact) => ({ artifact, score: localMatchScore(identity, artifact) }))
    .filter(({ score }) => score > 0)
    .toSorted(
      (left, right) =>
        right.score - left.score ||
        left.artifact.directoryIndex - right.artifact.directoryIndex ||
        left.artifact.path.localeCompare(right.artifact.path),
    );
  return ranked[0]?.artifact;
}

function localMatchScore(identity: RecordingIdentity, artifact: LocalArtifact): number {
  const stem = artifact.normalizedStem;
  if (identity.spotifyId && stem.includes(normalizeIdentity(identity.spotifyId))) return 300;
  if (identity.isrc && stem.includes(normalizeIdentity(identity.isrc))) return 250;
  const title = normalizeIdentity(identity.title);
  const baseTitle = normalizeIdentity(identity.title.replace(/\s*[([][^\])]*[\])]\s*$/u, ""));
  const artists = identity.artists.map(normalizeIdentity).filter(Boolean);
  const artistTokens = new Set(
    artists.flatMap((artist) => artist.split(" ").filter((token) => token.length >= 3)),
  );
  const artistMatch =
    artists.some((artist) => stem.includes(artist)) ||
    [...artistTokens].some((token) => stem.split(" ").includes(token));
  if (!artistMatch) return 0;
  if (title && stem.includes(title)) {
    return stem === normalizeIdentity(`${identity.artists.join(" ")} ${identity.title}`)
      ? 200
      : 160;
  }
  return baseTitle && baseTitle.length >= 4 && stem.includes(baseTitle) ? 120 : 0;
}

function localMatchKind(
  identity: RecordingIdentity,
  artifact: LocalArtifact,
): "spotify-id" | "isrc" | "artist-title" {
  if (
    identity.spotifyId &&
    artifact.normalizedStem.includes(normalizeIdentity(identity.spotifyId))
  ) {
    return "spotify-id";
  }
  if (identity.isrc && artifact.normalizedStem.includes(normalizeIdentity(identity.isrc))) {
    return "isrc";
  }
  return "artist-title";
}

function normalizeIdentity(value: string): string {
  return latinize(value)
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function isWithin(directory: string, path: string): boolean {
  const value = relative(directory, path);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function adoptedOutputExtension(path: string): ".flac" | ".m4a" | ".mp3" {
  const extension = extname(path).toLowerCase();
  if ([".aif", ".aiff", ".flac", ".wav", ".wave"].includes(extension)) return ".flac";
  if (extension === ".mp3") return ".mp3";
  return ".m4a";
}

function clipOutputExtension(path: string): ".flac" | ".m4a" | ".mp3" {
  return adoptedOutputExtension(path);
}

function displayIdentityTitle(title: string, mix?: string): string {
  if (!mix?.trim() || normalizeIdentity(title).includes(normalizeIdentity(mix))) return title;
  return `${title} (${mix})`;
}

function requireAbsolute(path: string, name: string): void {
  if (!isAbsolute(path)) throw new Error(`${name} must be an absolute path: ${path}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
