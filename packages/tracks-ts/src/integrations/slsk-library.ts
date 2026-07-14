import { mkdir, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

import type {
  BackendAvailability,
  IndividualDownload,
  TrackAcquirer,
} from "../acquire-manifest.js";
import { safeFilename } from "../acquisition.js";
import type {
  ScoredYoutubeCandidate,
  YoutubeSearchCandidate,
  YoutubeTarget,
} from "../acquisition.js";

export type SoulseekFileAttributes = {
  bitrate?: number;
  length?: number;
  variableBitrate?: boolean;
  encoder?: number;
  sampleRate?: number;
  bitDepth?: number;
};

export type SoulseekSharedFile = {
  code: number;
  filename: string;
  size: bigint;
  extension?: string;
  attributes: SoulseekFileAttributes;
};

export type SoulseekSearchResult = {
  username: string;
  files: readonly SoulseekSharedFile[];
  privateFiles?: readonly SoulseekSharedFile[];
  freeUploadSlots: boolean;
  uploadSpeed: number;
  queueLength: number;
};

export type SoulseekDownloadResult = {
  path: string;
  received: bigint;
  resumedFrom: bigint;
  size: bigint;
  username: string;
};

/** The structural subset of slsk-ts used by this adapter. */
export type SoulseekLibraryClient = {
  state?: "disconnected" | "connecting" | "connected" | "disconnecting";
  connect?(username: string, password: string, options?: { signal?: AbortSignal }): Promise<void>;
  search(
    query: string,
    options?: { timeout?: number; maxResults?: number; signal?: AbortSignal },
  ): Promise<readonly SoulseekSearchResult[]>;
  download(
    username: string,
    filename: string,
    destination: string,
    options?: { resume?: boolean; signal?: AbortSignal; temporaryPath?: string; timeout?: number },
  ): Promise<SoulseekDownloadResult>;
};

export type SoulseekCandidateMetadata = {
  username: string;
  filename: string;
  sizeBytes: string;
  durationSeconds?: number;
  bitrateKbps?: number;
  estimatedBitrateKbps?: number;
  sampleRate?: number;
  bitDepth?: number;
  likelyLossless: boolean;
  qualityScore: number;
  durationScore: number;
  peerScore: number;
  sourceQualityScore: number;
};

export type SoulseekSearchCandidate = YoutubeSearchCandidate & {
  /** Source-specific quality hint. Generic candidate scoring can use this as a tie-break. */
  sourceQualityScore: number;
  soulseek: SoulseekCandidateMetadata;
};

export type SoulseekLibraryAcquirerOptions = {
  credentials?: { username?: string; password?: string };
  environment?: Partial<Pick<NodeJS.ProcessEnv, "SLSK_USERNAME" | "SLSK_PASSWORD">>;
  searchTimeoutMs?: number;
  maxPeerResults?: number;
  maxCandidates?: number;
  transferTimeoutMs?: number;
  /** Cancels connection setup, search waits, and active peer transfers. */
  signal?: AbortSignal;
};

export type SoulseekRemoteFile = {
  username: string;
  file: SoulseekSharedFile;
  freeUploadSlots: boolean;
  uploadSpeed: number;
  queueLength: number;
};

const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".aif",
  ".aiff",
  ".alac",
  ".flac",
  ".m4a",
  ".mp3",
  ".ogg",
  ".opus",
  ".wav",
  ".wave",
]);

/** Direct slsk-ts library adapter. The caller owns the injected client's lifecycle. */
export class SoulseekLibraryAcquirer implements TrackAcquirer {
  readonly backend = "slsk" as const;
  readonly #client: SoulseekLibraryClient | undefined;
  readonly #credentials: { username: string | undefined; password: string | undefined };
  readonly #searchTimeoutMs: number;
  readonly #maxPeerResults: number;
  readonly #maxCandidates: number;
  readonly #transferTimeoutMs: number | undefined;
  readonly #signal: AbortSignal | undefined;
  #connecting: Promise<void> | undefined;
  readonly #searches = new Map<string, Promise<SoulseekSearchCandidate[]>>();

  constructor(
    client: SoulseekLibraryClient | undefined,
    options: SoulseekLibraryAcquirerOptions = {},
  ) {
    const environment = options.environment ?? process.env;
    this.#client = client;
    this.#credentials = {
      username: options.credentials ? options.credentials.username : environment.SLSK_USERNAME,
      password: options.credentials ? options.credentials.password : environment.SLSK_PASSWORD,
    };
    this.#searchTimeoutMs = positiveInteger(options.searchTimeoutMs, 8_000, "searchTimeoutMs");
    this.#maxPeerResults = positiveInteger(options.maxPeerResults, 100, "maxPeerResults");
    this.#maxCandidates = positiveInteger(options.maxCandidates, 200, "maxCandidates");
    this.#transferTimeoutMs = optionalPositiveInteger(
      options.transferTimeoutMs,
      "transferTimeoutMs",
    );
    this.#signal = options.signal;
  }

  availability(): Promise<BackendAvailability> {
    if (!this.#client) {
      return Promise.resolve({
        available: false,
        reason: "slsk-ts library client was not provided",
      });
    }
    if (this.#client.state === "connected") return Promise.resolve({ available: true });
    if (!this.#credentials.username || !this.#credentials.password) {
      return Promise.resolve({
        available: false,
        reason: "SLSK_USERNAME/SLSK_PASSWORD are not configured",
      });
    }
    if (!this.#client.connect) {
      return Promise.resolve({
        available: false,
        reason: "Injected slsk-ts client is disconnected and does not expose connect()",
      });
    }
    if (this.#client.state && this.#client.state !== "disconnected") {
      return Promise.resolve({
        available: false,
        reason: `Injected slsk-ts client is ${this.#client.state}`,
      });
    }
    return Promise.resolve({ available: true });
  }

  search(target: YoutubeTarget): Promise<SoulseekSearchCandidate[]> {
    const key = JSON.stringify({
      artists: target.artists,
      title: target.title,
      durationSeconds: target.durationSeconds,
    });
    const running = this.#searches.get(key);
    if (running) return running;
    const search = this.#search(target).finally(() => {
      if (this.#searches.get(key) === search) this.#searches.delete(key);
    });
    this.#searches.set(key, search);
    return search;
  }

  async #search(target: YoutubeTarget): Promise<SoulseekSearchCandidate[]> {
    const client = await this.#connectedClient();
    const query = [...target.artists, target.title].join(" ").trim();
    const responses = await client.search(query, {
      timeout: this.#searchTimeoutMs,
      maxResults: this.#maxPeerResults,
      ...(this.#signal ? { signal: this.#signal } : {}),
    });
    const seen = new Set<string>();
    const candidates = responses.flatMap((response) =>
      response.files.flatMap((file) => {
        const remote: SoulseekRemoteFile = {
          username: response.username,
          file,
          freeUploadSlots: response.freeUploadSlots,
          uploadSpeed: response.uploadSpeed,
          queueLength: response.queueLength,
        };
        const key = `${remote.username}\u0000${remote.file.filename}`;
        if (seen.has(key) || !isAudioFile(remote.file)) return [];
        seen.add(key);
        return [mapRemoteFile(target, remote)];
      }),
    );
    return candidates
      .sort(
        (left, right) =>
          right.sourceQualityScore - left.sourceQualityScore || left.id.localeCompare(right.id),
      )
      .slice(0, this.#maxCandidates);
  }

  async download(
    candidate: ScoredYoutubeCandidate,
    destinationDirectory: string,
    basename: string,
  ): Promise<IndividualDownload> {
    const client = await this.#connectedClient();
    const remote = parseSoulseekSource(candidate.source);
    this.#signal?.throwIfAborted();
    await mkdir(destinationDirectory, { recursive: true });
    const extension = audioExtension(remote.filename) ?? remote.extension ?? ".audio";
    const destination = resolve(
      join(destinationDirectory, `${safeFilename(basename)}${extension}`),
    );
    const partial = `${destination}.part`;

    if (await nonemptyFile(destination)) {
      this.#signal?.throwIfAborted();
      return {
        path: destination,
        source: candidate.source,
        engine: "native",
        temporary: true,
        qualityNote: "Reused a completed Soulseek staging artifact.",
      };
    }

    await client.download(remote.username, remote.filename, destination, {
      resume: true,
      temporaryPath: partial,
      ...(this.#signal ? { signal: this.#signal } : {}),
      ...(this.#transferTimeoutMs === undefined ? {} : { timeout: this.#transferTimeoutMs }),
    });
    return {
      path: destination,
      source: candidate.source,
      engine: "native",
      temporary: true,
      qualityNote: qualityNote(candidate),
    };
  }

  async #connectedClient(): Promise<SoulseekLibraryClient> {
    this.#signal?.throwIfAborted();
    if (this.#connecting) {
      await this.#connecting;
      this.#signal?.throwIfAborted();
      return this.#client!;
    }
    const availability = await this.availability();
    if (!availability.available) throw new Error(`Soulseek unavailable: ${availability.reason}`);
    const client = this.#client!;
    if (client.state === "connected") return client;
    if (!client.connect) return client;
    const connecting = this.#signal
      ? client.connect(this.#credentials.username!, this.#credentials.password!, {
          signal: this.#signal,
        })
      : client.connect(this.#credentials.username!, this.#credentials.password!);
    this.#connecting ??= connecting.finally(() => {
      this.#connecting = undefined;
    });
    await this.#connecting;
    this.#signal?.throwIfAborted();
    return client;
  }
}

export function scoreSoulseekFile(
  targetDurationSeconds: number | undefined,
  remote: SoulseekRemoteFile,
): SoulseekCandidateMetadata {
  const attributes = remote.file.attributes;
  const durationSeconds = validPositive(attributes.length);
  const reportedBitrate = normalizeBitrateKbps(attributes.bitrate);
  const estimatedBitrate = estimateBitrateKbps(remote.file.size, durationSeconds);
  const bitrateForQuality = Math.max(reportedBitrate ?? 0, estimatedBitrate ?? 0) || undefined;
  const sampleRate = validPositive(attributes.sampleRate);
  const bitDepth = validPositive(attributes.bitDepth);
  const bitrateEvidence = qualityFromBitrate(bitrateForQuality);
  const pcmEvidence = qualityFromPcm(sampleRate, bitDepth);
  const likelyLossless =
    (bitDepth !== undefined &&
      bitDepth >= 16 &&
      sampleRate !== undefined &&
      sampleRate >= 44_100) ||
    (reportedBitrate !== undefined && reportedBitrate >= 500) ||
    (estimatedBitrate !== undefined && estimatedBitrate >= 500);
  const extensionHint = losslessExtension(remote.file) ? 0.025 : 0;
  const qualityScore = round(clamp(Math.max(bitrateEvidence, pcmEvidence) + extensionHint, 0, 1));
  const durationScore = round(durationSimilarity(targetDurationSeconds, durationSeconds));
  const peerScore = round(scorePeer(remote));
  const sourceQualityScore = round(qualityScore * 0.7 + durationScore * 0.25 + peerScore * 0.05);

  return {
    username: remote.username,
    filename: remote.file.filename,
    sizeBytes: remote.file.size.toString(),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    ...(reportedBitrate === undefined ? {} : { bitrateKbps: reportedBitrate }),
    ...(estimatedBitrate === undefined ? {} : { estimatedBitrateKbps: estimatedBitrate }),
    ...(sampleRate === undefined ? {} : { sampleRate }),
    ...(bitDepth === undefined ? {} : { bitDepth }),
    likelyLossless,
    qualityScore,
    durationScore,
    peerScore,
    sourceQualityScore,
  };
}

function mapRemoteFile(target: YoutubeTarget, remote: SoulseekRemoteFile): SoulseekSearchCandidate {
  const metadata = scoreSoulseekFile(target.durationSeconds, remote);
  const names = trackNames(remote.file.filename);
  const source = soulseekSource(
    remote.username,
    remote.file.filename,
    normalizedExtension(remote.file.extension),
  );
  return {
    id: source,
    source,
    title: names.title,
    ...(names.artist ? { artist: names.artist } : {}),
    uploader: remote.username,
    ...(metadata.durationSeconds === undefined
      ? {}
      : { durationSeconds: metadata.durationSeconds }),
    sourceQualityScore: metadata.sourceQualityScore,
    soulseek: metadata,
  };
}

function soulseekSource(username: string, filename: string, extension?: string): string {
  const url = new URL("slsk://download");
  url.searchParams.set("username", username);
  url.searchParams.set("filename", filename);
  if (extension && AUDIO_EXTENSIONS.has(extension)) url.searchParams.set("extension", extension);
  return url.href;
}

function parseSoulseekSource(source: string): {
  username: string;
  filename: string;
  extension?: string;
} {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error(`Invalid Soulseek source: ${source}`);
  }
  const username = url.searchParams.get("username");
  const filename = url.searchParams.get("filename");
  const extension = normalizedExtension(url.searchParams.get("extension") ?? undefined);
  if (url.protocol !== "slsk:" || url.hostname !== "download" || !username || !filename) {
    throw new Error(`Invalid Soulseek source: ${source}`);
  }
  return {
    username,
    filename,
    ...(extension && AUDIO_EXTENSIONS.has(extension) ? { extension } : {}),
  };
}

function trackNames(filename: string): { title: string; artist?: string } {
  const leaf = filename.replaceAll("\\", "/").split("/").at(-1) ?? filename;
  const stem = leaf.slice(0, Math.max(0, leaf.length - extname(leaf).length));
  const withoutTrackNumber = stem.replace(/^\s*\d{1,3}\s*[-._]\s*/u, "").trim();
  const parts = withoutTrackNumber.split(/\s+[-–—]\s+/u);
  if (parts.length >= 2) {
    const artist = parts.shift()!.trim();
    const title = parts.join(" - ").trim();
    if (artist && title) return { artist, title };
  }
  return { title: withoutTrackNumber || stem || leaf };
}

function isAudioFile(file: SoulseekSharedFile): boolean {
  const extension = audioExtension(file.filename) ?? normalizedExtension(file.extension);
  return extension !== undefined && AUDIO_EXTENSIONS.has(extension);
}

function audioExtension(filename: string): string | undefined {
  const extension = normalizedExtension(extname(filename.replaceAll("\\", "/")));
  return extension && AUDIO_EXTENSIONS.has(extension) ? extension : undefined;
}

function normalizedExtension(extension?: string): string | undefined {
  if (!extension) return undefined;
  const normalized = `${extension.startsWith(".") ? "" : "."}${extension}`.toLocaleLowerCase(
    "en-US",
  );
  return /^\.[a-z0-9]{1,8}$/u.test(normalized) ? normalized : undefined;
}

function losslessExtension(file: SoulseekSharedFile): boolean {
  const extension = audioExtension(file.filename) ?? normalizedExtension(file.extension);
  return (
    extension !== undefined &&
    [".aif", ".aiff", ".alac", ".flac", ".wav", ".wave"].includes(extension)
  );
}

function normalizeBitrateKbps(value?: number): number | undefined {
  const valid = validPositive(value);
  if (valid === undefined) return undefined;
  return valid > 10_000 ? Math.round(valid / 1_000) : Math.round(valid);
}

function estimateBitrateKbps(size: bigint, durationSeconds?: number): number | undefined {
  if (!durationSeconds || size <= 0n) return undefined;
  const maximumSafe = BigInt(Number.MAX_SAFE_INTEGER);
  if (size > maximumSafe) return undefined;
  return Math.round((Number(size) * 8) / durationSeconds / 1_000);
}

function qualityFromBitrate(bitrateKbps?: number): number {
  if (bitrateKbps === undefined) return 0.2;
  if (bitrateKbps >= 900) return 1;
  if (bitrateKbps >= 500) return 0.9;
  if (bitrateKbps >= 320) return 0.72;
  if (bitrateKbps >= 256) return 0.62;
  if (bitrateKbps >= 192) return 0.5;
  if (bitrateKbps >= 128) return 0.38;
  return 0.25;
}

function qualityFromPcm(sampleRate?: number, bitDepth?: number): number {
  if (sampleRate === undefined || bitDepth === undefined) return 0;
  if (sampleRate >= 88_200 && bitDepth >= 24) return 1;
  if (sampleRate >= 44_100 && bitDepth >= 24) return 0.96;
  if (sampleRate >= 44_100 && bitDepth >= 16) return 0.9;
  return 0.35;
}

function durationSimilarity(expected?: number, actual?: number): number {
  if (expected === undefined || actual === undefined) return 0.5;
  const difference = Math.abs(expected - actual);
  if (difference <= 2) return 1;
  return clamp(1 - difference / Math.max(30, expected * 0.15), 0, 1);
}

function scorePeer(remote: SoulseekRemoteFile): number {
  const slots = remote.freeUploadSlots ? 0.55 : 0.2;
  const queue = 0.25 / (1 + Math.max(0, remote.queueLength));
  const speed = clamp(Math.log10(Math.max(1, remote.uploadSpeed)) / 8, 0, 0.2);
  return clamp(slots + queue + speed, 0, 1);
}

function qualityNote(candidate: ScoredYoutubeCandidate): string {
  const soulseek = (candidate as Partial<SoulseekSearchCandidate>).soulseek;
  if (!soulseek) return "Downloaded directly from a Soulseek peer with resumable staging.";
  const bitrate = soulseek.bitrateKbps ?? soulseek.estimatedBitrateKbps;
  const detail = [
    soulseek.likelyLossless ? "lossless-grade metadata" : undefined,
    bitrate === undefined
      ? undefined
      : `${bitrate} kbps${soulseek.bitrateKbps ? " reported" : " estimated"}`,
    soulseek.sampleRate === undefined ? undefined : `${soulseek.sampleRate} Hz`,
    soulseek.bitDepth === undefined ? undefined : `${soulseek.bitDepth}-bit`,
  ]
    .filter(Boolean)
    .join(", ");
  return `Downloaded directly from a Soulseek peer with resumable staging${detail ? ` (${detail})` : ""}.`;
}

async function nonemptyFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function validPositive(value?: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result <= 0) throw new RangeError(`${name} must be positive`);
  return result;
}

function optionalPositiveInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  return positiveInteger(value, value, name);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
