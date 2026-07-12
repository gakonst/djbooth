import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { ScoredYoutubeCandidate } from "../src/acquisition.js";
import {
  SoulseekLibraryAcquirer,
  type SoulseekDownloadResult,
  type SoulseekLibraryClient,
  type SoulseekSearchResult,
} from "../src/integrations/slsk-library.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((task) => task()));
});

describe("SoulseekLibraryAcquirer", () => {
  test("reports missing injected client and missing credentials without touching the network", async () => {
    const noClient = new SoulseekLibraryAcquirer(undefined, { environment: {} });
    await expect(noClient.availability()).resolves.toEqual({
      available: false,
      reason: "slsk-ts library client was not provided",
    });

    const disconnected = fakeClient([]);
    const noCredentials = new SoulseekLibraryAcquirer(disconnected.client, { environment: {} });
    await expect(noCredentials.availability()).resolves.toEqual({
      available: false,
      reason: "SLSK_USERNAME/SLSK_PASSWORD are not configured",
    });
    expect(disconnected.connect).not.toHaveBeenCalled();

    disconnected.client.state = "connected";
    await expect(noCredentials.availability()).resolves.toEqual({ available: true });
  });

  test("connects lazily and ranks measured audio quality and duration over filename extensions", async () => {
    const responses: SoulseekSearchResult[] = [
      response("peer-a", [
        file("Music\\Artist - Track.flac", 4_800_000n, {
          bitrate: 128,
          length: 300,
        }),
        file("Music\\Artist - Track.mp3", 12_000_000n, {
          bitrate: 320,
          length: 300,
        }),
        file("Music\\01 - Artist - Track.wav", 52_920_000n, {
          length: 300,
          sampleRate: 44_100,
          bitDepth: 16,
        }),
        file("Music\\Artist - Track (wrong duration).flac", 79_368_750n, {
          bitrate: 1_411,
          length: 450,
          sampleRate: 44_100,
          bitDepth: 16,
        }),
        file("Music\\notes.txt", 10n, {}),
      ]),
      {
        ...response("peer-b", []),
        privateFiles: [file("Private\\Artist - Track.flac", 52_920_000n, { length: 300 })],
      },
    ];
    const fake = fakeClient(responses);
    const acquirer = new SoulseekLibraryAcquirer(fake.client, {
      credentials: { username: "local", password: "secret" },
      searchTimeoutMs: 321,
      maxPeerResults: 12,
    });

    const candidates = await acquirer.search({
      title: "Track",
      artists: ["Artist"],
      durationSeconds: 300,
    });

    expect(fake.connect).toHaveBeenCalledWith("local", "secret");
    expect(fake.search).toHaveBeenCalledWith("Artist Track", { timeout: 321, maxResults: 12 });
    expect(candidates).toHaveLength(4);
    expect(candidates.map(({ soulseek }) => soulseek.filename)).toEqual([
      "Music\\01 - Artist - Track.wav",
      "Music\\Artist - Track.mp3",
      "Music\\Artist - Track (wrong duration).flac",
      "Music\\Artist - Track.flac",
    ]);
    expect(candidates[0]).toMatchObject({
      title: "Track",
      artist: "Artist",
      durationSeconds: 300,
      soulseek: { likelyLossless: true, bitDepth: 16, sampleRate: 44_100 },
    });
    expect(candidates[1]!.soulseek.qualityScore).toBeGreaterThan(
      candidates[3]!.soulseek.qualityScore,
    );
    expect(candidates[3]!.soulseek.likelyLossless).toBe(false);
    expect(candidates.every(({ source }) => source.startsWith("slsk://download?"))).toBe(true);
  });

  test("passes a stable staging path and explicit resume file to the direct client download", async () => {
    const fake = fakeClient([
      response("peer name", [
        file("Lossless\\Artist - Track.flac", 52_920_000n, {
          length: 300,
          sampleRate: 44_100,
          bitDepth: 16,
        }),
      ]),
    ]);
    fake.client.state = "connected";
    const acquirer = new SoulseekLibraryAcquirer(fake.client, {
      environment: {},
      transferTimeoutMs: 45_000,
    });
    const [candidate] = await acquirer.search({
      title: "Track",
      artists: ["Artist"],
      durationSeconds: 300,
    });
    const root = await mkdtemp(join(tmpdir(), "tracks-slsk-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));

    const downloaded = await acquirer.download(
      { ...candidate!, score: 1 },
      join(root, "staging"),
      "spotify:id/unsafe",
    );

    const expected = join(root, "staging", "spotify-id-unsafe.flac");
    expect(fake.download).toHaveBeenCalledWith(
      "peer name",
      "Lossless\\Artist - Track.flac",
      expected,
      { resume: true, temporaryPath: `${expected}.part`, timeout: 45_000 },
    );
    expect(downloaded).toMatchObject({
      path: expected,
      source: candidate!.source,
      engine: "native",
      temporary: true,
    });
    expect(downloaded.qualityNote).toContain("lossless-grade metadata");
  });

  test("reuses a nonempty completed staging artifact", async () => {
    const fake = fakeClient([]);
    fake.client.state = "connected";
    const acquirer = new SoulseekLibraryAcquirer(fake.client, { environment: {} });
    const root = await mkdtemp(join(tmpdir(), "tracks-slsk-resume-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, "staging");
    await writeFile(join(root, "placeholder"), "x");
    const candidate: ScoredYoutubeCandidate = {
      id: "candidate",
      source: "slsk://download?username=peer&filename=Music%5CArtist+-+Track.flac",
      title: "Track",
      score: 1,
    };
    await acquirer.download(candidate, directory, "track");
    await writeFile(join(directory, "track.flac"), "already complete");

    const resumed = await acquirer.download(candidate, directory, "track");

    expect(fake.download).toHaveBeenCalledTimes(1);
    expect(resumed.qualityNote).toContain("Reused");
  });
});

function file(
  filename: string,
  size: bigint,
  attributes: SoulseekSearchResult["files"][number]["attributes"],
): SoulseekSearchResult["files"][number] {
  return { code: 1, filename, size, attributes };
}

function response(username: string, files: SoulseekSearchResult["files"]): SoulseekSearchResult {
  return {
    username,
    files,
    privateFiles: [],
    freeUploadSlots: true,
    uploadSpeed: 1_000_000,
    queueLength: 0,
  };
}

function fakeClient(responses: readonly SoulseekSearchResult[]): {
  client: SoulseekLibraryClient;
  connect: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  download: ReturnType<typeof vi.fn>;
} {
  const connect = vi.fn(async function (this: SoulseekLibraryClient) {
    this.state = "connected";
  });
  const search = vi.fn(async () => responses);
  const download = vi.fn(
    async (
      username: string,
      _filename: string,
      destination: string,
    ): Promise<SoulseekDownloadResult> => ({
      path: destination,
      received: 1n,
      resumedFrom: 0n,
      size: 1n,
      username,
    }),
  );
  return {
    client: { state: "disconnected", connect, search, download },
    connect,
    search,
    download,
  };
}
