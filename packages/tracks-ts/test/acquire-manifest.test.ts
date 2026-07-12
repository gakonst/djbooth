import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  acquireManifest,
  type AcquisitionPlan,
  type TrackAcquirer,
} from "../src/acquire-manifest.js";
import { acquireManifestLock, readManifest, writeManifestAtomic } from "../src/acquisition.js";
import { createManifest, parseManifest, type SetManifest } from "../src/manifest.js";

const audioToolTest = process.platform === "win32" ? test.skip : test;

function oneTrackManifest(): SetManifest {
  const manifest = createManifest({
    source: "https://youtube.test/set",
    provider: "description",
    complete: true,
    tracks: [
      {
        order: 1,
        timestamp: "00:00:10",
        startSeconds: 10,
        endSeconds: 110,
        artist: "Artist",
        title: "Track",
      },
    ],
  });
  manifest.entries[0]!.spotify = {
    status: "matched",
    query: "Artist - Track",
    score: 1,
    id: "spotify-1",
    uri: "spotify:track:spotify-1",
    name: "Track",
    artists: ["Artist"],
    durationMs: 100_000,
  };
  return manifest;
}

function recordingPlan(directory: string): AcquisitionPlan {
  return {
    clips: [],
    recordings: [
      {
        entryOrder: 1,
        variants: [
          {
            spotifyId: "spotify-1",
            title: "Track",
            artists: ["Artist"],
            durationMs: 100_000,
            outputPath: join(directory, "track.m4a"),
            metadata: { title: "Track", artists: ["Artist"], comment: "test" },
          },
        ],
      },
    ],
    stagingDirectory: join(directory, "staging"),
  };
}

async function installFakeAudioTools(directory: string): Promise<string> {
  const bin = join(directory, "bin");
  await mkdir(bin);
  const windows = process.platform === "win32";
  const ffprobe = join(bin, windows ? "ffprobe.cmd" : "ffprobe");
  const ffmpeg = join(bin, windows ? "ffmpeg.cmd" : "ffmpeg");
  await writeFile(
    ffprobe,
    windows
      ? `@echo off\necho {"format":{"duration":"100","bit_rate":"128000","tags":{"title":"Track","artist":"Artist","comment":"test"}},"streams":[{"codec_type":"audio","codec_name":"aac"}]}\n`
      : `#!/bin/sh\nprintf '%s\\n' '{"format":{"duration":"100","bit_rate":"128000","tags":{"title":"Track","artist":"Artist","comment":"test"}},"streams":[{"codec_type":"audio","codec_name":"aac"}]}'\n`,
  );
  await writeFile(
    ffmpeg,
    windows
      ? '@echo off\nsetlocal EnableDelayedExpansion\nset "previous="\nfor %%A in (%*) do (\n  if "!previous!"=="-i" set "input=%%~A"\n  set "previous=%%~A"\n  set "output=%%~A"\n)\ncopy /Y "!input!" "!output!" >nul\n'
      : '#!/bin/sh\ninput=\'\'\nprevious=\'\'\nfor argument in "$@"; do\n  if [ "$previous" = \'-i\' ]; then input="$argument"; fi\n  previous="$argument"\n  output="$argument"\ndone\ncp "$input" "$output"\n',
  );
  await Promise.all([chmod(ffprobe, 0o700), chmod(ffmpeg, 0o700)]);
  return bin;
}

describe("acquireManifest", () => {
  test("rejects incomplete and unsafe plans before writing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tracks-plan-"));
    const manifestPath = join(directory, "manifest.json");
    await writeManifestAtomic(manifestPath, oneTrackManifest());
    const original = await readFile(manifestPath, "utf8");

    await expect(
      acquireManifest({
        manifestPath,
        plan: {
          clips: [],
          recordings: [{ entryOrder: 1, variants: [] }],
          stagingDirectory: join(directory, "staging"),
        },
        acquirers: [],
        requireCompletePlan: true,
      }),
    ).rejects.toThrow("has no variants");

    expect(await readFile(manifestPath, "utf8")).toBe(original);
    await expect(readFile(`${manifestPath}.acquire.lock`, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("requires clip ranges to match cues and use a checksummed source", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tracks-clip-plan-"));
    const manifestPath = join(directory, "manifest.json");
    await writeManifestAtomic(manifestPath, oneTrackManifest());

    await expect(
      acquireManifest({
        manifestPath,
        plan: {
          clips: [
            {
              entryOrder: 1,
              sourcePath: join(directory, "set.mp3"),
              sourceUrl: "https://soundcloud.test/set",
              outputPath: join(directory, "clip.mp3"),
              startSeconds: 11,
              endSeconds: 110,
              metadata: { title: "Track", artists: ["Artist"], comment: "clip" },
              qualityNote: "set extract",
              containsTransitions: true,
            },
          ],
          recordings: [],
          stagingDirectory: join(directory, "staging"),
        },
        acquirers: [],
        dryRun: true,
      }),
    ).rejects.toThrow("no verified source checksum");

    const withSource = oneTrackManifest();
    const sourcePath = join(directory, "set.mp3");
    withSource.artifacts.sourceSet = {
      url: "https://soundcloud.test/set",
      path: sourcePath,
      sha256: "a".repeat(64),
      durationSeconds: 200,
      codec: "mp3",
      bitrate: 128_000,
    };
    await writeManifestAtomic(manifestPath, withSource);
    await expect(
      acquireManifest({
        manifestPath,
        plan: {
          clips: [
            {
              entryOrder: 1,
              sourcePath,
              sourceUrl: "https://soundcloud.test/set",
              outputPath: join(directory, "clip.mp3"),
              startSeconds: 10,
              endSeconds: 110,
              metadata: {
                title: "Track",
                artists: ["Artist"],
                isrc: "USAAA2600001",
                comment: "clip",
              },
              qualityNote: "set extract",
              containsTransitions: true,
            },
          ],
          recordings: [],
          stagingDirectory: join(directory, "staging"),
          sourceSets: [
            {
              path: sourcePath,
              sha256: "a".repeat(64),
              durationSeconds: 200,
              codec: "mp3",
              bitrate: 128_000,
            },
          ],
        },
        acquirers: [],
        dryRun: true,
      }),
    ).rejects.toThrow("must not claim an ISRC");
  });

  test("binds recording plans to the complete Spotify decision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tracks-spotify-plan-"));
    const manifestPath = join(directory, "manifest.json");
    await writeManifestAtomic(manifestPath, oneTrackManifest());
    const unapproved = recordingPlan(directory);
    unapproved.recordings[0]!.variants[0]!.spotifyId = "not-approved";

    await expect(
      acquireManifest({
        manifestPath,
        plan: unapproved,
        acquirers: [],
        dryRun: true,
        requireCompletePlan: true,
      }),
    ).rejects.toThrow("unapproved Spotify ID");

    const ambiguous = oneTrackManifest();
    ambiguous.entries[0]!.spotify = {
      status: "ambiguous",
      query: "Artist - Track",
      candidates: ["spotify-1", "spotify-2"].map((id) => ({
        score: 1,
        id,
        uri: `spotify:track:${id}`,
        name: "Track",
        artists: ["Artist"],
        durationMs: 100_000,
      })),
    };
    await writeManifestAtomic(manifestPath, ambiguous);
    await expect(
      acquireManifest({
        manifestPath,
        plan: recordingPlan(directory),
        acquirers: [],
        dryRun: true,
        requireCompletePlan: true,
      }),
    ).rejects.toThrow("must include every Spotify candidate");

    await expect(
      acquireManifest({
        manifestPath,
        plan: {
          ...recordingPlan(directory),
          recordings: [
            {
              entryOrder: 1,
              variants: [
                {
                  ...recordingPlan(directory).recordings[0]!.variants[0]!,
                  outputPath: join(directory, "track.mp3"),
                },
              ],
            },
          ],
        },
        acquirers: [],
        dryRun: true,
      }),
    ).rejects.toThrow("M4A staging target");
  });

  test("invalidates an imported Rekordbox checkpoint when metadata changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tracks-invalidate-"));
    const manifestPath = join(directory, "manifest.json");
    const manifest = oneTrackManifest();
    manifest.entries[0]!.acquisition = {
      status: "downloaded",
      download: {
        backend: "ytdlp",
        mediaPath: join(directory, "old.m4a"),
        files: [join(directory, "old.m4a")],
        sha256: "a".repeat(64),
      },
    };
    manifest.entries[0]!.rekordbox = {
      status: "imported",
      target: "rekordbox-db",
      dbContentId: "content-1",
      playlistMembershipId: "membership-1",
    };
    await writeManifestAtomic(manifestPath, manifest);

    const result = await acquireManifest({
      manifestPath,
      prepare(current) {
        current.entries[0]!.identity.releaseDate = "2026-01-01";
        return current;
      },
      plan: recordingPlan(directory),
      acquirers: [],
      dryRun: true,
      requireCompletePlan: true,
    });

    expect(result.manifest.entries[0]!.rekordbox).toEqual({ status: "pending" });
    expect((await readManifest(manifestPath)).entries[0]!.rekordbox.status).toBe("imported");
  });

  audioToolTest("tries the next viable candidate after a broken first result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tracks-candidate-fallback-"));
    const manifestPath = join(directory, "manifest.json");
    const bin = await installFakeAudioTools(directory);
    await writeManifestAtomic(manifestPath, oneTrackManifest());
    const attempted: string[] = [];
    const acquirer: TrackAcquirer = {
      backend: "slsk",
      async availability() {
        return { available: true };
      },
      async search() {
        return [
          {
            id: "a-broken",
            source: "slsk://peer/a",
            title: "Artist - Track",
            artist: "Artist",
            durationSeconds: 100,
          },
          {
            id: "b-good",
            source: "slsk://peer/b",
            title: "Artist - Track",
            artist: "Artist",
            durationSeconds: 100,
          },
        ];
      },
      async download(candidate, destination) {
        attempted.push(candidate.id);
        await mkdir(destination, { recursive: true });
        const path = `${destination}.wav`;
        if (candidate.id === "a-broken") {
          await writeFile(path, "candidate A bytes");
          throw new Error("HTTP 403 after completed staging file");
        }
        try {
          await readFile(path);
        } catch {
          await writeFile(path, "candidate B bytes");
        }
        return { path, source: candidate.source, temporary: true };
      },
    };
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
    try {
      const result = await acquireManifest({
        manifestPath,
        plan: recordingPlan(directory),
        acquirers: [acquirer],
        requireCompletePlan: true,
        continueOnError: false,
      });
      expect(result.failures).toEqual([]);
      expect(result.verification?.files).toBe(1);
      expect(attempted).toEqual(["a-broken", "b-good"]);
      expect(result.manifest.entries[0]!.acquisition).toMatchObject({
        status: "downloaded",
        download: {
          backend: "slsk",
          mediaPath: join(directory, "track.flac"),
          source: "slsk://peer/b",
        },
      });
      expect(result.manifest.entries[0]!.warnings).toContain(
        "spotify-1 Soulseek PCM source was losslessly converted to FLAC",
      );
      expect(await readFile(join(directory, "track.flac"), "utf8")).toBe("candidate B bytes");
    } finally {
      process.env.PATH = previousPath;
    }
  });

  audioToolTest("retains a failed ambiguity error when a later variant succeeds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tracks-partial-ambiguity-"));
    const manifestPath = join(directory, "manifest.json");
    const bin = await installFakeAudioTools(directory);
    const manifest = oneTrackManifest();
    manifest.entries[0]!.spotify = {
      status: "ambiguous",
      query: "Artist - Track",
      candidates: ["spotify-1", "spotify-2"].map((id) => ({
        score: 1,
        id,
        uri: `spotify:track:${id}`,
        name: "Track",
        artists: ["Artist"],
        durationMs: 100_000,
      })),
    };
    await writeManifestAtomic(manifestPath, manifest);
    let searchIndex = 0;
    const acquirer: TrackAcquirer = {
      backend: "ytdlp",
      async availability() {
        return { available: true };
      },
      async search() {
        const id = searchIndex++ === 0 ? "first-fails" : "second-works";
        return [
          {
            id,
            source: `https://youtube.test/${id}`,
            title: "Artist - Track",
            artist: "Artist",
            durationSeconds: 100,
          },
        ];
      },
      async download(candidate, destination) {
        await mkdir(destination, { recursive: true });
        if (candidate.id === "first-fails") throw new Error("source unavailable");
        const path = `${destination}.m4a`;
        await writeFile(path, "mock audio");
        return { path, source: candidate.source, temporary: true };
      },
    };
    const plan = recordingPlan(directory);
    plan.recordings[0]!.variants.push({
      ...structuredClone(plan.recordings[0]!.variants[0]!),
      spotifyId: "spotify-2",
      outputPath: join(directory, "track-2.m4a"),
    });
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
    try {
      const result = await acquireManifest({
        manifestPath,
        plan,
        acquirers: [acquirer],
        requireCompletePlan: true,
      });

      expect(result.failures).toHaveLength(1);
      expect(result.manifest.entries[0]!.acquisition).toMatchObject({
        status: "downloaded",
        download: { spotifyId: "spotify-2" },
      });
      expect(result.manifest.entries[0]!.errors).toEqual([
        expect.objectContaining({
          stage: "acquisition",
          message: expect.stringContaining("source unavailable"),
        }),
      ]);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  audioToolTest("preserves an imported checkpoint across a no-op ambiguous resume", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tracks-ambiguous-resume-"));
    const manifestPath = join(directory, "manifest.json");
    const bin = await installFakeAudioTools(directory);
    const manifest = oneTrackManifest();
    manifest.entries[0]!.spotify = {
      status: "ambiguous",
      query: "Artist - Track",
      candidates: ["spotify-1", "spotify-2"].map((id) => ({
        score: 1,
        id,
        uri: `spotify:track:${id}`,
        name: "Track",
        artists: ["Artist"],
        durationMs: 100_000,
      })),
    };
    await writeManifestAtomic(manifestPath, manifest);
    const makePlan = (): AcquisitionPlan => {
      const plan = recordingPlan(directory);
      plan.recordings[0]!.variants.push({
        ...structuredClone(plan.recordings[0]!.variants[0]!),
        spotifyId: "spotify-2",
        outputPath: join(directory, "track-2.m4a"),
      });
      return plan;
    };
    let searches = 0;
    let downloads = 0;
    const acquirer: TrackAcquirer = {
      backend: "ytdlp",
      async availability() {
        return { available: true };
      },
      async search() {
        const id = `source-${++searches}`;
        return [
          {
            id,
            source: `https://youtube.test/${id}`,
            title: "Artist - Track",
            artist: "Artist",
            durationSeconds: 100,
          },
        ];
      },
      async download(candidate, destination) {
        downloads += 1;
        await mkdir(destination, { recursive: true });
        const path = join(destination, `${candidate.id}.m4a`);
        await writeFile(path, `audio ${candidate.id}`);
        return { path, source: candidate.source, temporary: true };
      },
    };
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
    try {
      const first = await acquireManifest({
        manifestPath,
        plan: makePlan(),
        acquirers: [acquirer],
        requireCompletePlan: true,
      });
      expect(first.failures).toEqual([]);
      expect(downloads).toBe(2);
      first.manifest.entries[0]!.rekordbox = {
        status: "imported",
        target: "rekordbox-db",
        artifact: "/rekordbox/master.db",
        dbContentId: "content-1",
        playlistMembershipId: "membership-1",
        dbContentIds: ["content-1", "content-2"],
        playlistMembershipIds: ["membership-1", "membership-2"],
      };
      first.manifest.artifacts.rekordbox = {
        target: "rekordbox-db",
        dbPath: "/rekordbox/master.db",
        folderName: "DJ Sets I Like",
        folderId: "folder-1",
        playlistName: "Set [tracks-ts]",
        playlistId: "playlist-1",
        backupDirectory: "/backups/one",
      };
      await writeManifestAtomic(manifestPath, first.manifest);
      downloads = 0;

      const resumed = await acquireManifest({
        manifestPath,
        plan: makePlan(),
        acquirers: [acquirer],
        requireCompletePlan: true,
      });

      expect(downloads).toBe(0);
      expect(resumed.resumed).toHaveLength(2);
      expect(resumed.manifest.entries[0]!.acquisition).toMatchObject({
        status: "downloaded",
        alternatives: [expect.objectContaining({ spotifyId: "spotify-2" })],
      });
      expect(resumed.manifest.entries[0]!.rekordbox.status).toBe("imported");
      expect(resumed.manifest.artifacts.rekordbox?.playlistId).toBe("playlist-1");
    } finally {
      process.env.PATH = previousPath;
    }
  });

  audioToolTest(
    "runs independent recording jobs concurrently with serialized checkpoints",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tracks-parallel-recordings-"));
      const manifestPath = join(directory, "manifest.json");
      const manifest = createManifest({
        source: "https://youtube.test/parallel-set",
        provider: "description",
        complete: true,
        tracks: [1, 2, 3].map((order) => ({
          order,
          startSeconds: order * 100,
          endSeconds: (order + 1) * 100,
          artist: "Artist",
          title: "Track",
        })),
      });
      for (const entry of manifest.entries) {
        entry.spotify = {
          status: "matched",
          query: "Artist - Track",
          score: 1,
          id: "spotify-shared",
          uri: "spotify:track:spotify-shared",
          name: "Track",
          artists: ["Artist"],
          durationMs: 100_000,
        };
      }
      await writeManifestAtomic(manifestPath, manifest);
      const plan: AcquisitionPlan = {
        clips: [],
        recordings: manifest.entries.map((entry) => ({
          entryOrder: entry.order,
          variants: [
            {
              spotifyId: "spotify-shared",
              title: "Track",
              artists: ["Artist"],
              durationMs: 100_000,
              outputPath: join(directory, `track-${entry.order}.m4a`),
              metadata: { title: "Track", artists: ["Artist"], comment: "test" },
            },
          ],
        })),
        stagingDirectory: join(directory, "staging"),
      };
      let active = 0;
      let maximumActive = 0;
      const stagingDirectories = new Set<string>();
      const acquirer: TrackAcquirer = {
        backend: "ytdlp",
        availability: () => Promise.resolve({ available: true }),
        search: async (target) => [
          {
            id: target.title,
            source: `https://youtube.test/${encodeURIComponent(target.title)}`,
            title: target.title,
            artist: target.artists[0]!,
            ...(target.durationSeconds === undefined
              ? {}
              : { durationSeconds: target.durationSeconds }),
          },
        ],
        async download(candidate, destination) {
          stagingDirectories.add(destination);
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 30));
          await mkdir(destination, { recursive: true });
          const path = join(destination, `${candidate.id}.m4a`);
          await writeFile(path, `audio ${candidate.id}`);
          active -= 1;
          return { path, source: candidate.source, temporary: true };
        },
      };
      const bin = await installFakeAudioTools(directory);
      const previousPath = process.env.PATH;
      process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
      try {
        const result = await acquireManifest({
          manifestPath,
          plan,
          acquirers: [acquirer],
          requireCompletePlan: true,
          concurrency: 3,
        });

        expect(maximumActive).toBe(3);
        expect(stagingDirectories.size).toBe(3);
        expect(result.failures).toEqual([]);
        expect(result.downloaded).toHaveLength(3);
        expect(result.performance).toMatchObject({ concurrency: 3 });
        expect(result.performance.stages).toContainEqual(
          expect.objectContaining({ stage: "recordings" }),
        );
        expect(
          (await readManifest(manifestPath)).entries.map((entry) => entry.acquisition.status),
        ).toEqual(["downloaded", "downloaded", "downloaded"]);
      } finally {
        process.env.PATH = previousPath;
      }
    },
  );

  audioToolTest(
    "rejects a resumed artifact changed while another recording downloads",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tracks-resume-toctou-"));
      const manifestPath = join(directory, "manifest.json");
      const firstPath = join(directory, "track-1.m4a");
      const firstBytes = "verified first recording";
      await writeFile(firstPath, firstBytes);
      const manifest = createManifest({
        source: "https://youtube.test/toctou-set",
        provider: "description",
        complete: true,
        tracks: [1, 2].map((order) => ({
          order,
          startSeconds: order * 100,
          endSeconds: (order + 1) * 100,
          artist: "Artist",
          title: "Track",
        })),
      });
      for (const [index, entry] of manifest.entries.entries()) {
        entry.spotify = {
          status: "matched",
          query: "Artist - Track",
          score: 1,
          id: `spotify-${index + 1}`,
          uri: `spotify:track:spotify-${index + 1}`,
          name: "Track",
          artists: ["Artist"],
          durationMs: 100_000,
        };
      }
      manifest.entries[0]!.acquisition = {
        status: "downloaded",
        download: {
          backend: "ytdlp",
          kind: "individual",
          mediaPath: firstPath,
          files: [firstPath],
          spotifyId: "spotify-1",
          sha256: createHash("sha256").update(firstBytes).digest("hex"),
        },
      };
      await writeManifestAtomic(manifestPath, manifest);
      const plan: AcquisitionPlan = {
        clips: [],
        recordings: manifest.entries.map((entry) => ({
          entryOrder: entry.order,
          variants: [
            {
              spotifyId: `spotify-${entry.order}`,
              title: "Track",
              artists: ["Artist"],
              durationMs: 100_000,
              outputPath: join(directory, `track-${entry.order}.m4a`),
              metadata: { title: "Track", artists: ["Artist"], comment: "test" },
            },
          ],
        })),
        stagingDirectory: join(directory, "staging"),
      };
      const acquirer: TrackAcquirer = {
        backend: "ytdlp",
        availability: () => Promise.resolve({ available: true }),
        search: (target) =>
          Promise.resolve([
            {
              id: "second",
              source: "https://youtube.test/second",
              title: target.title,
              artist: target.artists[0]!,
              ...(target.durationSeconds === undefined
                ? {}
                : { durationSeconds: target.durationSeconds }),
            },
          ]),
        async download(candidate, destination) {
          await mkdir(destination, { recursive: true });
          const path = join(destination, "second.m4a");
          await writeFile(path, "second recording");
          await writeFile(firstPath, "changed after preflight");
          return { path, source: candidate.source, temporary: true };
        },
      };
      const bin = await installFakeAudioTools(directory);
      const previousPath = process.env.PATH;
      process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
      try {
        await expect(
          acquireManifest({
            manifestPath,
            plan,
            acquirers: [acquirer],
            requireCompletePlan: true,
            concurrency: 2,
          }),
        ).rejects.toThrow(/SHA-256|checksum/iu);
      } finally {
        process.env.PATH = previousPath;
      }
    },
  );
});

describe("manifest locking and compare-and-swap writes", () => {
  test("rejects a stale expected snapshot without losing the newer edit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tracks-cas-"));
    const path = join(directory, "manifest.json");
    const first = oneTrackManifest();
    await writeManifestAtomic(path, first);
    const expectedContents = await readFile(path, "utf8");
    const newer = structuredClone(first);
    newer.warnings.push("manual edit");
    await writeManifestAtomic(path, newer);

    const stale = structuredClone(first);
    stale.warnings.push("stale stage edit");
    await expect(writeManifestAtomic(path, stale, { expectedContents })).rejects.toThrow(
      "Manifest changed",
    );
    expect(parseManifest(JSON.parse(await readFile(path, "utf8")) as unknown)).toEqual(newer);
  });

  test("recovers a lock owned by a dead process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tracks-stale-lock-"));
    const path = join(directory, "manifest.json");
    const lockPath = `${path}.pipeline.lock`;
    await writeFile(lockPath, `${JSON.stringify({ pid: 99_999_999 })}\n`);

    const release = await acquireManifestLock(path);
    await release();

    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
