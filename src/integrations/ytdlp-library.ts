import { mkdir, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type {
  BackendAvailability,
  IndividualDownload,
  TrackAcquirer,
} from "../acquire-manifest.js";
import type {
  ScoredYoutubeCandidate,
  YoutubeSearchCandidate,
  YoutubeTarget,
} from "../acquisition.js";
import { probeAudio } from "../acquisition.js";

export type YtdlpMediaInfo = {
  id: string;
  title: string;
  webpage_url?: string;
  original_url?: string;
  url?: string;
  extractor?: string;
  uploader?: string;
  artist?: string;
  creator?: string;
  duration?: number;
  entries?: YtdlpMediaInfo[];
  formats?: Array<{
    ext?: string;
    acodec?: string;
    vcodec?: string;
  }>;
};

export type YtdlpReferenceClient = {
  inspect(
    url: string,
    options?: { playlist?: boolean; flatPlaylist?: boolean; extractorArgs?: string[] },
  ): Promise<YtdlpMediaInfo>;
  download(
    url: string,
    options?: {
      playlist?: boolean;
      format?: string;
      output?: string;
      paths?: string;
      noOverwrites?: boolean;
      continueDownload?: boolean;
      retries?: number;
      fragmentRetries?: number;
      extractAudio?: boolean;
      audioFormat?: string;
      audioQuality?: string;
      embedMetadata?: boolean;
      extractorArgs?: string[];
    },
  ): Promise<{ files: string[]; stdout: string; stderr: string }>;
};

export class YtdlpReferenceAcquirer implements TrackAcquirer {
  readonly backend = "ytdlp" as const;
  readonly #client: YtdlpReferenceClient;
  readonly #searchLimit: number;

  constructor(client: YtdlpReferenceClient, options: { searchLimit?: number } = {}) {
    this.#client = client;
    this.#searchLimit = options.searchLimit ?? 10;
  }

  availability(): Promise<BackendAvailability> {
    return Promise.resolve({ available: true });
  }

  async search(target: YoutubeTarget): Promise<YoutubeSearchCandidate[]> {
    const query = [...target.artists, target.title].join(" ");
    const result = await this.#client.inspect(`ytsearch${this.#searchLimit}:${query}`, {
      flatPlaylist: true,
      extractorArgs: ["youtube:player_client=android_vr"],
    });
    return (result.entries ?? []).flatMap((entry) => {
      const source = mediaUrl(entry);
      if (!source || !entry.id || !entry.title) return [];
      return [
        {
          id: entry.id,
          source,
          title: entry.title,
          ...((entry.artist ?? entry.creator) ? { artist: entry.artist ?? entry.creator } : {}),
          ...(entry.uploader ? { uploader: entry.uploader } : {}),
          ...(entry.duration === undefined ? {} : { durationSeconds: entry.duration }),
        },
      ];
    });
  }

  async download(
    candidate: ScoredYoutubeCandidate,
    destinationDirectory: string,
    basename: string,
  ): Promise<IndividualDownload> {
    await mkdir(destinationDirectory, { recursive: true });
    const existing = await existingOutput(destinationDirectory, basename);
    if (existing) {
      try {
        await probeAudio(existing);
        return {
          path: existing,
          source: candidate.source,
          engine: "reference",
          temporary: true,
          qualityNote: "Resumed a previously completed yt-dlp staging artifact.",
        };
      } catch {
        await rm(existing, { force: true });
      }
    }
    const info = await this.#client.inspect(candidate.source, {
      playlist: false,
      extractorArgs: ["youtube:player_client=android_vr"],
    });
    const directM4a = hasDirectM4a(info);
    const result = await this.#client.download(candidate.source, {
      playlist: false,
      format: directM4a ? "bestaudio[ext=m4a]/bestaudio/best" : "bestaudio/best",
      paths: destinationDirectory,
      output: `${basename}.%(ext)s`,
      noOverwrites: true,
      continueDownload: true,
      retries: 5,
      fragmentRetries: 5,
      extractAudio: true,
      audioFormat: "m4a",
      audioQuality: "0",
      embedMetadata: false,
      extractorArgs: ["youtube:player_client=android_vr"],
    });
    const path = await findOutputFile(result.files, destinationDirectory, basename);
    return {
      path,
      source: candidate.source,
      engine: "reference",
      temporary: true,
      transcoded: !directM4a,
      qualityNote: directM4a
        ? "Downloaded the source AAC/M4A audio and stream-copied tags without re-encoding."
        : "No AAC/M4A source was advertised; yt-dlp converted the best available audio to M4A for Rekordbox compatibility.",
    };
  }
}

async function existingOutput(directory: string, basename: string): Promise<string | undefined> {
  const files = await readdir(directory);
  const file = files.find(
    (candidate) =>
      candidate.startsWith(`${basename}.`) && candidate.toLocaleLowerCase("en-US").endsWith(".m4a"),
  );
  return file ? join(directory, file) : undefined;
}

export function unavailableTrackAcquirer(backend: "slsk" | "ytdlp", reason: string): TrackAcquirer {
  return {
    backend,
    availability: () => Promise.resolve({ available: false, reason }),
    search: () => Promise.resolve([]),
    download: () => Promise.reject(new Error(`${backend} unavailable: ${reason}`)),
  };
}

function mediaUrl(info: YtdlpMediaInfo): string | undefined {
  if (info.webpage_url) return info.webpage_url;
  if (info.original_url?.startsWith("http")) return info.original_url;
  if (info.url?.startsWith("http")) return info.url;
  if (/youtube/iu.test(info.extractor ?? "") || /^[\w-]{11}$/u.test(info.id)) {
    return `https://www.youtube.com/watch?v=${info.id}`;
  }
  return undefined;
}

function hasDirectM4a(info: YtdlpMediaInfo): boolean {
  return (info.formats ?? []).some((format) => {
    return (
      format.ext === "m4a" &&
      format.acodec !== undefined &&
      format.acodec !== "none" &&
      (format.vcodec === undefined || format.vcodec === "none")
    );
  });
}

async function findOutputFile(
  reported: readonly string[],
  directory: string,
  basename: string,
): Promise<string> {
  const reportedM4a = reported.find((path) => path.toLocaleLowerCase("en-US").endsWith(".m4a"));
  if (reportedM4a) {
    return isAbsolute(reportedM4a) ? reportedM4a : resolve(directory, reportedM4a);
  }
  const files = await readdir(directory);
  const existing = files.find(
    (file) => file.startsWith(`${basename}.`) && file.toLocaleLowerCase("en-US").endsWith(".m4a"),
  );
  if (!existing) throw new Error(`yt-dlp did not report an M4A output for ${basename}`);
  return join(directory, existing);
}
