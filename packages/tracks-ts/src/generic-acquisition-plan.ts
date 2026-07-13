import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";

import type {
  AcquisitionClipPlan,
  AcquisitionPlan,
  AcquisitionRecordingVariant,
} from "./acquire-manifest.js";
import type { AudioMetadata } from "./acquisition.js";
import type { ResolvedTrack, SetManifest, SpotifyCandidate } from "./manifest.js";

export type BuildAcquisitionPlanOptions = {
  /** Absolute destination for acquired, retagged recordings. */
  outputDirectory: string;
  /** Absolute directories searched recursively for explicitly adopted local recordings. */
  localDirectories?: readonly string[];
  /** Explicitly permit cue-bounded recovery of unresolved IDs from a verified local set source. */
  allowSourceSetClips?: boolean;
  /** Absolute path matching manifest.artifacts.sourceSet.path. Never downloaded by this builder. */
  sourceSetPath?: string;
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
  releaseDate?: string;
  durationMs?: number;
  searchQuery: string;
};

type LocalArtifact = {
  path: string;
  normalizedStem: string;
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
  requireAbsolute(options.outputDirectory, "outputDirectory");
  const stagingDirectory = options.stagingDirectory ?? join(options.outputDirectory, ".staging");
  requireAbsolute(stagingDirectory, "stagingDirectory");
  for (const directory of options.localDirectories ?? []) {
    requireAbsolute(directory, "localDirectories");
  }
  const sourceSet = sourceSetForClips(manifest, options);
  const artifacts = await discoverLocalArtifacts(options.localDirectories ?? []);
  const adoptedPaths = new Set<string>();
  const recordings = manifest.entries.flatMap((entry) => {
    const identities = recordingIdentities(entry);
    if (!identities.length) return [];
    return [
      {
        entryOrder: entry.order,
        variants: identities.map((identity) => {
          const local = selectLocalArtifact(identity, artifacts, adoptedPaths);
          if (local) adoptedPaths.add(local.path);
          return recordingVariant(manifest, entry, identity, options.outputDirectory, local);
        }),
      },
    ];
  });
  const clips = sourceSet
    ? manifest.entries.flatMap((entry) =>
        entry.identity.status === "unidentified"
          ? unresolvedClip(manifest, entry, options.outputDirectory, sourceSet)
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
  const primary =
    entry.spotify.status === "matched"
      ? [spotifyIdentity(entry.spotify, entry)]
      : entry.spotify.status === "ambiguous"
        ? entry.spotify.candidates.map((candidate) => spotifyIdentity(candidate, entry))
        : entry.spotify.status === "unmatched" && entry.identity.status === "identified"
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
          normalizeIdentity(candidate.title) === normalizeIdentity(identity.title) &&
          normalizeIdentity(candidate.artists.join(" ")) ===
            normalizeIdentity(identity.artists.join(" ")),
      ) === index,
  );
}

function tracklistIdentity(entry: ResolvedTrack): RecordingIdentity {
  if (entry.identity.status !== "identified") throw new Error("Track identity is unresolved");
  const title = displayIdentityTitle(entry.identity.title, entry.identity.mix);
  return {
    ...(entry.identity.isrc ? { isrc: entry.identity.isrc } : {}),
    title,
    artists: [entry.identity.artist],
    ...(entry.identity.album ? { album: entry.identity.album } : {}),
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
  const basename = filesystemSafe(
    `${String(entry.order).padStart(3, "0")} - ${identity.artists.join(", ")} - ${identity.title} [${suffix}]`,
  );
  const metadata: AudioMetadata = {
    title: identity.title,
    artists: [...identity.artists],
    ...(identity.album ? { album: identity.album } : {}),
    ...(identity.releaseDate ? { releaseDate: identity.releaseDate } : {}),
    ...(identity.isrc ? { isrc: identity.isrc } : {}),
    comment: recordingComment(manifest, identity),
    trackNumber: entry.order,
    trackTotal: manifest.entries.length,
    grouping: "music-ts resolved set",
  };
  return {
    ...(identity.spotifyId ? { spotifyId: identity.spotifyId } : {}),
    ...(identity.isrc ? { isrc: identity.isrc } : {}),
    title: identity.title,
    artists: [...identity.artists],
    ...(identity.album ? { album: identity.album } : {}),
    ...(identity.albumArtists ? { albumArtists: [...identity.albumArtists] } : {}),
    ...(identity.releaseDate ? { releaseDate: identity.releaseDate } : {}),
    ...(identity.durationMs === undefined ? {} : { durationMs: identity.durationMs }),
    outputPath: join(outputDirectory, `${basename}${extension}`),
    metadata,
    searchQuery: identity.searchQuery,
    ...(local
      ? {
          localArtifact: {
            sourcePath: local.path,
            matchedBy: localMatchKind(identity, local),
          },
        }
      : {}),
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
      outputPath: join(
        outputDirectory,
        `${filesystemSafe(`${String(entry.order).padStart(3, "0")} - ${artist} - ${title} [set-extract]`)}${extension}`,
      ),
      startSeconds,
      endSeconds,
      metadata,
      qualityNote: "Cue-bounded set recording; transitions and lossy ancestry may be present.",
      containsTransitions: true,
    },
  ];
}

async function discoverLocalArtifacts(directories: readonly string[]): Promise<LocalArtifact[]> {
  const paths = (
    await Promise.all(directories.map((directory) => walkAudioFiles(resolve(directory))))
  )
    .flat()
    .toSorted((left, right) => left.localeCompare(right));
  return [...new Set(paths)].map((path) => ({
    path,
    normalizedStem: normalizeIdentity(
      path.slice(0, -extname(path).length).split("/").at(-1) ?? path,
    ),
  }));
}

async function walkAudioFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map(async (entry): Promise<string[]> => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return walkAudioFiles(path);
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
        right.score - left.score || left.artifact.path.localeCompare(right.artifact.path),
    );
  if (!ranked[0] || (ranked[1] && ranked[1].score === ranked[0].score)) return undefined;
  return ranked[0].artifact;
}

function localMatchScore(identity: RecordingIdentity, artifact: LocalArtifact): number {
  const stem = artifact.normalizedStem;
  if (identity.spotifyId && stem.includes(normalizeIdentity(identity.spotifyId))) return 300;
  if (identity.isrc && stem.includes(normalizeIdentity(identity.isrc))) return 250;
  const title = normalizeIdentity(identity.title);
  const artists = identity.artists.map(normalizeIdentity).filter(Boolean);
  if (!title || !stem.includes(title) || !artists.some((artist) => stem.includes(artist))) return 0;
  return stem === normalizeIdentity(`${identity.artists.join(" ")} ${identity.title}`) ? 200 : 100;
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
  return value
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function filesystemSafe(value: string): string {
  const withoutControls = [...value.normalize("NFKC")]
    .map((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || code === 127 ? " " : character;
    })
    .join("");
  const safe = withoutControls
    .replaceAll(/[<>:"/\\|?*]+/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .replaceAll(/[. ]+$/gu, "")
    .trim();
  return (safe || "track").slice(0, 180).replaceAll(/[. ]+$/gu, "");
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
