import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";

import { TracksError } from "./errors.js";
import { parseManifest, type SetManifest } from "./manifest.js";
import { runProcess } from "./process.js";

export type AudioMetadata = {
  title: string;
  artists: string[];
  album?: string;
  albumArtists?: string[];
  label?: string;
  genre?: string;
  releaseDate?: string;
  isrc?: string;
  comment: string;
  trackNumber?: number;
  trackTotal?: number;
  grouping?: string;
};

export type AudioAcquisitionSource = {
  backend: "slsk" | "ytdlp";
  source: string;
};

export type AudioProbe = {
  durationSeconds: number;
  codec: string;
  bitrate?: number;
  tags: Record<string, string>;
};

export type YoutubeSearchCandidate = {
  id: string;
  source: string;
  title: string;
  artist?: string;
  uploader?: string;
  durationSeconds?: number;
  /** Optional backend-specific quality evidence used only as a bounded tie-break. */
  sourceQualityScore?: number;
};

export type YoutubeTarget = {
  title: string;
  artists: string[];
  durationSeconds?: number;
  /** Search hint only; matching still uses the original recording identity. */
  searchQuery?: string;
};

export type ScoredYoutubeCandidate = YoutubeSearchCandidate & {
  score: number;
};

export type VerifyAudioOptions = {
  expectedSha256?: string;
  expectedDurationSeconds?: number;
  durationToleranceSeconds?: number;
  expectedMetadata?: AudioMetadata;
};

/** Read and validate a pipeline manifest. */
export async function readManifest(path: string): Promise<SetManifest> {
  try {
    const contents = await readFile(path, "utf8");
    return parseManifest(JSON.parse(contents) as unknown);
  } catch (error) {
    throw new TracksError("INVALID_SOURCE", `Could not read manifest ${path}`, { cause: error });
  }
}

/**
 * Validate, fsync, and atomically replace a manifest. The temporary file lives beside the
 * destination so rename never crosses filesystems.
 */
export async function writeManifestAtomic(path: string, manifest: SetManifest): Promise<void> {
  parseManifest(manifest);
  const directory = dirname(path);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const contents = `${JSON.stringify(manifest, null, 2)}\n`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, contents, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const file = await open(temporary, "r+");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    await chmod(path, 0o600);
    await syncDirectory(directory);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Serialize every mutating pipeline stage for one durable manifest. */
export async function acquirePipelineManifestLock(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.pipeline.lock`;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      lock = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      if (attempt === 0 && (await isStalePipelineLock(lockPath))) {
        await rm(lockPath, { force: true });
        continue;
      }
      throw new TracksError(
        "TOOL_FAILED",
        `Pipeline lock already exists: ${lockPath}. Another stage may be active.`,
      );
    }
  }
  if (!lock) throw new TracksError("TOOL_FAILED", `Could not acquire lock ${lockPath}`);
  try {
    await lock.writeFile(
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
    );
    await lock.sync();
  } catch (error) {
    await lock.close().catch(() => undefined);
    await rm(lockPath, { force: true });
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await lock.close();
    } finally {
      await rm(lockPath, { force: true });
    }
  };
}

/** Backward-compatible alias for callers that previously acquired an acquisition-only lock. */
export const acquireManifestLock = acquirePipelineManifestLock;

async function isStalePipelineLock(lockPath: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
    if (typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0) {
      try {
        process.kill(value.pid, 0);
        return false;
      } catch (error) {
        return isNodeError(error) && error.code === "ESRCH";
      }
    }
  } catch {
    // A malformed lock is removable only after a conservative age threshold below.
  }
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs > 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

export function scoreYoutubeCandidates(
  target: YoutubeTarget,
  candidates: readonly YoutubeSearchCandidate[],
): ScoredYoutubeCandidate[] {
  return candidates
    .map((candidate) => ({ ...candidate, score: scoreYoutubeCandidate(target, candidate) }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

export function scoreYoutubeCandidate(
  target: YoutubeTarget,
  candidate: YoutubeSearchCandidate,
): number {
  const targetTitle = normalizeMatchText(target.title);
  const candidateTitle = normalizeMatchText(candidate.title);
  const targetArtists = normalizeMatchText(target.artists.join(" "));
  const candidateArtists = normalizeMatchText(
    [candidate.artist, candidate.uploader, candidate.title].filter(Boolean).join(" "),
  );
  const titleScore = textSimilarity(targetTitle, candidateTitle);
  const artistScore = tokenCoverage(targetArtists, candidateArtists);
  const durationScore = durationSimilarity(target.durationSeconds, candidate.durationSeconds);
  const officialBonus = /(?:topic|official|records?|music)$/iu.test(
    candidate.uploader?.trim() ?? "",
  )
    ? 0.04
    : 0;
  const unwantedPenalty = unwantedVersionPenalty(targetTitle, candidateTitle);
  const identityScore = clamp(
    titleScore * 0.48 + artistScore * 0.25 + durationScore * 0.27 + officialBonus - unwantedPenalty,
  );
  const qualityScore =
    candidate.sourceQualityScore === undefined ? undefined : clamp(candidate.sourceQualityScore);
  return clamp(
    roundScore(
      qualityScore === undefined ? identityScore : identityScore * 0.9 + qualityScore * 0.1,
    ),
  );
}

export function normalizeMatchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/&/gu, " and ")
    .replace(/\b(?:feat|featuring|ft)\.?\b/gu, " ")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

export function safeFilename(value: string): string {
  const clean = [...value.normalize("NFKC")]
    .map((character) => {
      const code = character.codePointAt(0)!;
      return code <= 31 || code === 127 || "/:\\".includes(character) ? "-" : character;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .replace(/\.{2,}/gu, ".")
    .trim()
    .replace(/^[. ]+|[. ]+$/gu, "");
  return (clean || "track").slice(0, 180).trim();
}

export async function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

export async function probeAudio(path: string, ffprobe = "ffprobe"): Promise<AudioProbe> {
  const result = await runProcess(ffprobe, [
    "-v",
    "error",
    "-show_entries",
    "format=duration,bit_rate:format_tags:stream=codec_name,codec_type:stream_tags",
    "-of",
    "json",
    path,
  ]);
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch (error) {
    throw new TracksError("INVALID_RESPONSE", `ffprobe returned invalid JSON for ${path}`, {
      cause: error,
    });
  }
  const body = asRecord(value);
  const format = asRecord(body.format);
  const streams = Array.isArray(body.streams) ? body.streams.map(asRecord) : [];
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const durationSeconds = numberValue(format.duration);
  const codec = audio?.codec_name;
  const bitrate = numberValue(format.bit_rate);
  const tags = normalizeTags({ ...asRecord(format.tags), ...asRecord(audio?.tags) });
  if (durationSeconds === undefined || durationSeconds <= 0 || typeof codec !== "string") {
    throw new TracksError("INVALID_RESPONSE", `No valid audio stream found in ${path}`);
  }
  return {
    durationSeconds,
    codec,
    tags,
    ...(bitrate === undefined ? {} : { bitrate: Math.round(bitrate) }),
  };
}

export async function verifyAudioFile(
  path: string,
  options: VerifyAudioOptions = {},
): Promise<{ probe: AudioProbe; sha256: string }> {
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0) throw new Error(`Audio file is empty: ${path}`);
  const [probe, sha256] = await Promise.all([probeAudio(path), sha256File(path)]);
  if (options.expectedSha256 && sha256 !== options.expectedSha256) {
    throw new Error(`SHA-256 mismatch for ${path}`);
  }
  if (options.expectedDurationSeconds !== undefined) {
    const tolerance = options.durationToleranceSeconds ?? 8;
    if (Math.abs(probe.durationSeconds - options.expectedDurationSeconds) > tolerance) {
      throw new Error(
        `Duration mismatch for ${path}: expected ${options.expectedDurationSeconds.toFixed(3)}s, got ${probe.durationSeconds.toFixed(3)}s`,
      );
    }
  }
  if (options.expectedMetadata) verifyAudioTags(path, probe.tags, options.expectedMetadata);
  // Container headers, duration and a stable hash do not prove the encoded packets are
  // playable. Reject corrupt acquisitions here so the normal candidate fallback can run,
  // rather than checkpointing bad audio and retrying analysis forever.
  await runProcess(process.env.FFMPEG_PATH ?? "ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-xerror",
    "-err_detect",
    "explode",
    "-i",
    path,
    "-map",
    "0:a:0",
    "-f",
    "null",
    "-",
  ]);
  return { probe, sha256 };
}

export async function createSourceSetClip(options: {
  sourcePath: string;
  outputPath: string;
  startSeconds: number;
  endSeconds: number;
  metadata: AudioMetadata;
  ffmpeg?: string;
}): Promise<{ probe: AudioProbe; sha256: string }> {
  if (options.endSeconds <= options.startSeconds)
    throw new Error("Clip end must follow clip start");
  const outputPath = resolve(options.outputPath);
  await mkdir(dirname(outputPath), { recursive: true });
  const temporary = temporaryMediaPath(outputPath);
  try {
    const source = await probeAudio(options.sourcePath);
    const encoding = sourceSetClipEncoding(source.codec, extname(outputPath));
    await runProcess(options.ffmpeg ?? "ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-ss",
      String(options.startSeconds),
      "-i",
      options.sourcePath,
      "-t",
      String(options.endSeconds - options.startSeconds),
      "-map",
      "0:a:0",
      "-vn",
      "-c:a",
      encoding.codec,
      ...(encoding.bitrate ? ["-b:a", encoding.bitrate] : []),
      "-map_metadata",
      "-1",
      ...metadataArguments(options.metadata, extname(outputPath)),
      temporary,
    ]);
    const verified = await verifyAudioFile(temporary, {
      expectedDurationSeconds: options.endSeconds - options.startSeconds,
      durationToleranceSeconds: 2,
      expectedMetadata: options.metadata,
    });
    await syncAndRename(temporary, outputPath);
    return verified;
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Select a container-compatible source-set clip encoding while preserving compatible source bytes.
 */
export function sourceSetClipEncoding(
  sourceCodec: string,
  outputExtension: string,
): { codec: "copy" | "aac" | "flac" | "libmp3lame"; bitrate?: string } {
  const codec = sourceCodec.toLocaleLowerCase("en-US");
  const extension = outputExtension.toLocaleLowerCase("en-US");
  if (extension === ".m4a") {
    return codec === "aac" || codec === "alac"
      ? { codec: "copy" }
      : { codec: "aac", bitrate: "320k" };
  }
  if (extension === ".flac") {
    return codec === "flac" ? { codec: "copy" } : { codec: "flac" };
  }
  if (extension === ".mp3") {
    return codec === "mp3" ? { codec: "copy" } : { codec: "libmp3lame", bitrate: "320k" };
  }
  throw new Error(`Unsupported source-set clip output extension: ${outputExtension}`);
}

export async function retagAudio(options: {
  sourcePath: string;
  outputPath: string;
  metadata: AudioMetadata;
  /** Durable canonical source appended to the embedded comment without replacing user metadata. */
  acquisitionSource?: AudioAcquisitionSource;
  expectedDurationSeconds?: number;
  ffmpeg?: string;
  audioCodec?: "copy" | "aac" | "flac";
}): Promise<{ probe: AudioProbe; sha256: string }> {
  const outputPath = resolve(options.outputPath);
  const outputMetadata = options.acquisitionSource
    ? audioMetadataWithAcquisitionSource(options.metadata, options.acquisitionSource)
    : options.metadata;
  await mkdir(dirname(outputPath), { recursive: true });
  const temporary = temporaryMediaPath(outputPath);
  try {
    await runProcess(options.ffmpeg ?? "ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-i",
      options.sourcePath,
      "-map",
      "0:a:0",
      "-vn",
      "-c:a",
      options.audioCodec ?? "copy",
      ...(options.audioCodec === "aac" ? ["-b:a", "320k"] : []),
      // Preserve useful source tags that the catalog could not supply, then overwrite every
      // canonical field below. This keeps album/label/genre from high-quality acquisitions.
      "-map_metadata",
      "0",
      ...metadataArguments(outputMetadata, extname(outputPath)),
      temporary,
    ]);
    const verified = await verifyAudioFile(temporary, {
      ...(options.expectedDurationSeconds === undefined
        ? {}
        : { expectedDurationSeconds: options.expectedDurationSeconds }),
      durationToleranceSeconds: Math.max(10, (options.expectedDurationSeconds ?? 0) * 0.035),
      expectedMetadata: outputMetadata,
    });
    await syncAndRename(temporary, outputPath);
    return verified;
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Append a stable, human-readable download source to an audio comment exactly once. */
export function audioMetadataWithAcquisitionSource(
  metadata: AudioMetadata,
  acquisitionSource: AudioAcquisitionSource,
): AudioMetadata {
  const source = acquisitionSource.source.trim();
  if (!source || metadata.comment.split(/\r?\n/u).some((line) => line.includes(source))) {
    return metadata;
  }
  return {
    ...metadata,
    comment: [
      metadata.comment.trimEnd(),
      `Downloaded from ${acquisitionSourceLabel(acquisitionSource)}: ${source}`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function acquisitionSourceLabel(acquisitionSource: AudioAcquisitionSource): string {
  if (acquisitionSource.backend === "slsk") return "Soulseek";
  try {
    const hostname = new URL(acquisitionSource.source).hostname.toLocaleLowerCase("en-US");
    if (
      hostname === "youtu.be" ||
      hostname === "youtube.com" ||
      hostname.endsWith(".youtube.com") ||
      hostname === "youtube-nocookie.com" ||
      hostname.endsWith(".youtube-nocookie.com")
    )
      return "YouTube";
    if (
      hostname === "snd.sc" ||
      hostname === "soundcloud.com" ||
      hostname.endsWith(".soundcloud.com")
    )
      return "SoundCloud";
  } catch {
    // Keep an auditable backend label for non-URL sources.
  }
  return "yt-dlp";
}

function textSimilarity(expected: string, actual: string): number {
  if (!expected || !actual) return 0;
  if (expected === actual) return 1;
  if (actual.includes(expected)) return 0.96;
  const expectedTokens = new Set(expected.split(" "));
  const actualTokens = new Set(actual.split(" "));
  const intersection = [...expectedTokens].filter((token) => actualTokens.has(token)).length;
  const union = new Set([...expectedTokens, ...actualTokens]).size;
  const jaccard = union ? intersection / union : 0;
  const coverage = expectedTokens.size ? intersection / expectedTokens.size : 0;
  return Math.min(1, jaccard * 0.45 + coverage * 0.55);
}

function tokenCoverage(expected: string, actual: string): number {
  const ignored = new Set(["and", "the", "vs"]);
  const expectedTokens = [...new Set(expected.split(" "))].filter(
    (token) => token.length > 1 && !ignored.has(token),
  );
  if (!expectedTokens.length) return 0.5;
  const actualTokens = new Set(actual.split(" "));
  return expectedTokens.filter((token) => actualTokens.has(token)).length / expectedTokens.length;
}

function durationSimilarity(expected?: number, actual?: number): number {
  if (expected === undefined || actual === undefined || expected <= 0 || actual <= 0) return 0.45;
  const difference = Math.abs(expected - actual);
  const tolerance = Math.max(8, expected * 0.025);
  if (difference <= tolerance) return 1;
  return Math.max(0, 1 - (difference - tolerance) / Math.max(35, expected * 0.2));
}

function unwantedVersionPenalty(expected: string, actual: string): number {
  const markers = ["live", "cover", "karaoke", "slowed", "sped up", "nightcore"];
  let penalty = 0;
  for (const marker of markers) {
    if (!expected.includes(marker) && actual.includes(marker)) penalty += 0.18;
  }
  if (!expected.includes("mixed") && /\bmixed\b/u.test(actual)) penalty += 0.12;
  if (!expected.includes("remix") && /\bremix\b/u.test(actual)) penalty += 0.1;
  return Math.min(0.45, penalty);
}

function metadataArguments(metadata: AudioMetadata, extension: string): string[] {
  const arguments_: string[] = [];
  if (extension.toLocaleLowerCase("en-US") === ".m4a") {
    arguments_.push("-movflags", "use_metadata_tags");
  } else if (extension.toLocaleLowerCase("en-US") === ".mp3") {
    arguments_.push("-id3v2_version", "3");
  }
  const fields: Array<[string, string | undefined]> = [
    ["title", metadata.title],
    ["artist", metadata.artists.join("; ")],
    ["album", metadata.album],
    ["album_artist", metadata.albumArtists?.join("; ")],
    ["publisher", metadata.label],
    ["genre", metadata.genre],
    ["date", metadata.releaseDate],
    ["ISRC", metadata.isrc],
    ["comment", metadata.comment],
    [
      "track",
      metadata.trackNumber === undefined
        ? undefined
        : metadata.trackTotal === undefined
          ? String(metadata.trackNumber)
          : `${metadata.trackNumber}/${metadata.trackTotal}`,
    ],
    ["grouping", metadata.grouping],
  ];
  for (const [key, value] of fields) {
    if (value !== undefined && value !== "") arguments_.push("-metadata", `${key}=${value}`);
  }
  return arguments_;
}

function normalizeTags(value: Record<string, unknown>): Record<string, string> {
  const tags = Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string | number] => {
        return typeof entry[1] === "string" || typeof entry[1] === "number";
      })
      .map(([key, tag]) => [key.toLocaleLowerCase("en-US"), String(tag)]),
  );
  if (!tags.isrc && tags["tsrc"]) tags.isrc = tags["tsrc"];
  if (!tags.date && tags.year) tags.date = tags.year;
  if (!tags.track && tags.tracknumber) tags.track = tags.tracknumber;
  if (!tags.album_artist && tags.albumartist) tags.album_artist = tags.albumartist;
  if (!tags.publisher && tags.label) tags.publisher = tags.label;
  if (!tags.grouping && tags.group) tags.grouping = tags.group;
  if (!tags.comment && tags.description) tags.comment = tags.description;
  return tags;
}

function verifyAudioTags(
  path: string,
  tags: Record<string, string>,
  metadata: AudioMetadata,
): void {
  const expected: Array<[string, string | undefined]> = [
    ["title", metadata.title],
    ["artist", metadata.artists.join("; ")],
    ["album", metadata.album],
    ["album_artist", metadata.albumArtists?.join("; ")],
    ["publisher", metadata.label],
    ["genre", metadata.genre],
    ["date", metadata.releaseDate],
    ["isrc", metadata.isrc],
    ["comment", metadata.comment],
    [
      "track",
      metadata.trackNumber === undefined
        ? undefined
        : metadata.trackTotal === undefined
          ? String(metadata.trackNumber)
          : `${metadata.trackNumber}/${metadata.trackTotal}`,
    ],
    ["grouping", metadata.grouping],
  ];
  for (const [key, value] of expected) {
    if (value === undefined) continue;
    const actual = tags[key];
    const matches =
      actual === value ||
      (key === "comment" && value.length > 0 && actual?.startsWith(`${value}\n`) === true);
    if (!matches) {
      throw new Error(
        `Metadata mismatch for ${path}: expected ${key}=${JSON.stringify(value)}, got ${JSON.stringify(actual)}`,
      );
    }
  }
}

function temporaryMediaPath(path: string): string {
  const extension = extname(path);
  return `${path.slice(0, -extension.length)}.${process.pid}.${Date.now()}.tmp${extension}`;
}

async function syncAndRename(temporary: string, destination: string): Promise<void> {
  const handle = await open(temporary, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, destination);
  await syncDirectory(dirname(destination));
}

async function syncDirectory(path: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directory = await open(path, "r");
    await directory.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySyncError(error)) throw error;
  } finally {
    await directory?.close();
  }
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberValue(value: unknown): number | undefined {
  const number =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  return (
    isNodeError(error) &&
    (error.code === "EINVAL" ||
      error.code === "ENOTSUP" ||
      error.code === "EISDIR" ||
      error.code === "EPERM")
  );
}
