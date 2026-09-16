import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";

import { nativeFallbackFor, YtdlpError } from "@gakonst/ytdlp-ts";
import { describe, expect, test } from "vitest";

import {
  acquireManifest,
  type AcquisitionPlan,
  type TrackAcquirer,
} from "../src/acquire-manifest.js";
import { acquireManifestLock, readManifest, writeManifestAtomic } from "../src/acquisition.js";
import { buildAcquisitionPlan } from "../src/generic-acquisition-plan.js";
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
      : `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const input = process.argv.at(-1);
let comment = "test";
let duration = "100";
try { comment = readFileSync(input + ".comment", "utf8"); } catch {}
try { duration = readFileSync(input + ".duration", "utf8").trim(); } catch {}
process.stdout.write(JSON.stringify({
  format: { duration, bit_rate: "128000", tags: { title: "Track", artist: "Artist", comment } },
  streams: [{ codec_type: "audio", codec_name: "aac" }],
}) + "\\n");
`,
  );
  await writeFile(
    ffmpeg,
    windows
      ? '@echo off\nsetlocal EnableDelayedExpansion\nset "previous="\nfor %%A in (%*) do (\n  if "!previous!"=="-i" set "input=%%~A"\n  set "previous=%%~A"\n  set "output=%%~A"\n)\ncopy /Y "!input!" "!output!" >nul\n'
      : `#!/usr/bin/env node
const { copyFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
let input;
let comment = "test";
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "-i") input = args[index + 1];
  if (args[index] === "-metadata" && args[index + 1]?.startsWith("comment=")) {
    comment = args[index + 1].slice("comment=".length);
  }
}
const output = args.at(-1);
copyFileSync(input, output);
writeFileSync(output + ".comment", comment);
`,
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

  audioToolTest(
    "recovers a failed checkpoint from a verified output already in place",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tracks-in-place-"));
      const manifestPath = join(directory, "manifest.json");
      const outputPath = join(directory, "track.m4a");
      const contents = "existing audio bytes";
      await Promise.all([
        writeManifestAtomic(manifestPath, oneTrackManifest()),
        writeFile(outputPath, contents),
      ]);
      const plan = recordingPlan(directory);
      plan.recordings[0]!.variants[0]!.localArtifact = {
        sourcePath: outputPath,
        matchedBy: "spotify-id",
      };
      const bin = await installFakeAudioTools(directory);
      const previousPath = process.env.PATH;
      process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
      try {
        const callbacks: string[] = [];
        const result = await acquireManifest({
          manifestPath,
          plan,
          acquirers: [],
          continueOnError: false,
          requireCompletePlan: true,
          onArtifactVerified(artifact) {
            callbacks.push(artifact.status);
          },
        });
        expect(result.downloaded).toEqual([]);
        expect(result.resumed).toEqual([outputPath]);
        expect(callbacks).toEqual(["resumed"]);
        expect(await readFile(outputPath, "utf8")).toBe(contents);
        const entry = result.manifest.entries[0]!;
        expect(entry.acquisition.status).toBe("downloaded");
        if (entry.acquisition.status !== "downloaded") throw new Error("test acquisition");
        expect(entry.acquisition.download).toMatchObject({
          backend: "local",
          mediaPath: outputPath,
          source: outputPath,
        });
      } finally {
        process.env.PATH = previousPath;
      }
    },
  );

  audioToolTest(
    "falls through to acquisition when a local artifact has the wrong duration",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tracks-stale-local-"));
      const manifestPath = join(directory, "manifest.json");
      const stalePath = join(directory, "track.flac");
      const replacementPath = join(directory, "track.m4a");
      const staleContents = "wrong local recording";
      await Promise.all([
        writeManifestAtomic(manifestPath, oneTrackManifest()),
        writeFile(stalePath, staleContents),
        writeFile(`${stalePath}.duration`, "200"),
      ]);
      const plan = recordingPlan(directory);
      plan.recordings[0]!.variants[0]!.outputPath = stalePath;
      plan.recordings[0]!.variants[0]!.localArtifact = {
        sourcePath: stalePath,
        matchedBy: "spotify-id",
      };
      let searches = 0;
      let downloads = 0;
      const acquirer: TrackAcquirer = {
        backend: "ytdlp",
        availability: () => Promise.resolve({ available: true }),
        search: async () => {
          searches += 1;
          return [
            {
              id: "replacement",
              source: "https://youtube.test/replacement",
              title: "Artist - Track",
              artist: "Artist",
              durationSeconds: 100,
            },
          ];
        },
        async download(candidate, destination) {
          downloads += 1;
          await mkdir(destination, { recursive: true });
          const path = join(destination, "replacement.m4a");
          await writeFile(path, "correct replacement recording");
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
          continueOnError: false,
        });

        expect(searches).toBe(1);
        expect(downloads).toBe(1);
        expect(result.failures).toEqual([]);
        expect(result.downloaded).toEqual([replacementPath]);
        expect(plan.recordings[0]!.variants[0]).toMatchObject({
          outputPath: replacementPath,
        });
        expect(plan.recordings[0]!.variants[0]!.localArtifact).toBeUndefined();
        expect(result.manifest.entries[0]!.acquisition).toMatchObject({
          status: "downloaded",
          download: {
            backend: "ytdlp",
            mediaPath: replacementPath,
            source: "https://youtube.test/replacement",
          },
        });
        expect(result.manifest.entries[0]!.warnings).toContainEqual(
          expect.stringMatching(/skipped local artifact.*Duration mismatch/iu),
        );
        expect(await readFile(stalePath, "utf8")).toBe(staleContents);
        await expect(readFile(replacementPath, "utf8")).resolves.toBe(
          "correct replacement recording",
        );
      } finally {
        process.env.PATH = previousPath;
      }
    },
  );

  audioToolTest(
    "preserves legacy two-digit recording and clip paths without enforcing regenerated tags",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tracks-legacy-resume-"));
      const manifestPath = join(directory, "manifest.json");
      const outputDirectory = join(directory, "tracks");
      const legacyDirectory = join(directory, "legacy");
      const sourcePath = join(directory, "source", "set.mp3");
      const value = createManifest({
        source: "https://youtube.test/legacy-set",
        provider: "description",
        complete: true,
        tracks: [
          {
            order: 1,
            startSeconds: 0,
            endSeconds: 100,
            artist: "Legacy Artist",
            title: "Legacy Recording",
          },
          { order: 2, isId: true, startSeconds: 100, endSeconds: 200 },
        ],
      });
      value.entries[0]!.spotify = {
        status: "unmatched",
        query: "Legacy Artist Legacy Recording",
      };
      value.entries[1]!.spotify = { status: "skipped", reason: "Unresolved ID" };
      value.artifacts.sourceSet = {
        url: "https://soundcloud.test/legacy-set",
        path: sourcePath,
        sha256: "a".repeat(64),
        durationSeconds: 200,
        codec: "mp3",
        bitrate: 128_000,
      };

      const legacyPaths = [
        join(legacyDirectory, "01 - Legacy Artist - Legacy Recording [set-extract].mp3"),
        join(legacyDirectory, "02 - Unknown Artist - ID [set-extract].mp3"),
      ];
      const contents = ["legacy recording bytes", "legacy id bytes"];
      await mkdir(legacyDirectory, { recursive: true });
      await Promise.all(legacyPaths.map((path, index) => writeFile(path, contents[index]!)));
      for (const [index, entry] of value.entries.entries()) {
        const mediaPath = legacyPaths[index]!;
        const sha256 = createHash("sha256").update(contents[index]!).digest("hex");
        entry.acquisition = {
          status: "downloaded",
          query: entry.identity.title ?? `Track ${entry.order}`,
          download: {
            backend: "ytdlp",
            kind: "source-set-clip",
            mediaPath,
            files: [mediaPath],
            source: value.artifacts.sourceSet.url,
            engine: "reference",
            sha256,
            clip: {
              sourceSetUrl: value.artifacts.sourceSet.url,
              startSeconds: entry.cue.startSeconds!,
              endSeconds: entry.cue.endSeconds!,
              containsTransitions: true,
              qualityNote: "legacy checkpoint",
            },
          },
        };
        entry.rekordbox = {
          status: "imported",
          target: "rekordbox-db",
          dbContentId: `content-${entry.order}`,
          playlistMembershipId: `membership-${entry.order}`,
        };
      }
      value.artifacts.rekordbox = {
        target: "rekordbox-db",
        dbPath: "/rekordbox/master.db",
        folderName: "DJ Sets I Like",
        folderId: "folder-1",
        playlistName: "Legacy Set",
        playlistId: "playlist-1",
      };
      await writeManifestAtomic(manifestPath, value);

      const plan = await buildAcquisitionPlan(value, {
        outputDirectory,
        allowSourceSetClips: true,
        sourceSetPath: sourcePath,
      });
      expect(dirname(plan.recordings[0]!.variants[0]!.outputPath)).toBe(
        join(outputDirectory, "Legacy Artist", "Singles"),
      );
      expect(dirname(plan.clips[0]!.outputPath)).toBe(
        join(outputDirectory, "Unknown Artist", "DJ Set Extract"),
      );
      const bin = await installFakeAudioTools(directory);
      const previousPath = process.env.PATH;
      process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
      try {
        const callbacks: string[] = [];
        const result = await acquireManifest({
          manifestPath,
          plan,
          acquirers: [],
          continueOnError: false,
          requireCompletePlan: true,
          onArtifactVerified(artifact) {
            callbacks.push(artifact.path);
          },
        });

        expect(result.downloaded).toEqual([]);
        expect(result.resumed).toEqual(legacyPaths.toSorted());
        expect(callbacks.toSorted()).toEqual(legacyPaths.toSorted());
        expect(plan.recordings[0]!.variants[0]!.outputPath).toBe(legacyPaths[0]);
        expect(plan.clips[0]!.outputPath).toBe(legacyPaths[1]);
        expect(
          result.manifest.entries.map((entry) =>
            entry.acquisition.status === "downloaded"
              ? entry.acquisition.download.mediaPath
              : undefined,
          ),
        ).toEqual(legacyPaths);
        expect(
          result.manifest.entries.every((entry) => entry.rekordbox.status === "imported"),
        ).toBe(true);
        expect(result.manifest.artifacts.rekordbox?.playlistId).toBe("playlist-1");
        await Promise.all(
          legacyPaths.map(async (path, index) => {
            expect(basename(path)).toMatch(/^0[12] -/u);
            expect(await readFile(path, "utf8")).toBe(contents[index]);
          }),
        );
      } finally {
        process.env.PATH = previousPath;
      }
    },
  );

  audioToolTest(
    "does not bind unkeyed checkpoint variants by position after paths change",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tracks-legacy-variants-"));
      const manifestPath = join(directory, "manifest.json");
      const outputDirectory = join(directory, "tracks");
      const legacyDirectory = join(directory, "legacy");
      const value = oneTrackManifest();
      value.entries[0]!.spotify = { status: "unmatched", query: "Artist Track" };
      value.entries[0]!.identity.overlaps = [
        { artist: "Overlap Artist", title: "Overlap Track", confidence: 0.9 },
      ];
      const legacyPaths = [
        join(legacyDirectory, "01 - Artist - Track.m4a"),
        join(legacyDirectory, "01 - Overlap Artist - Overlap Track.m4a"),
      ];
      const contents = ["primary legacy bytes", "overlap legacy bytes"];
      await mkdir(legacyDirectory, { recursive: true });
      await Promise.all(legacyPaths.map((path, index) => writeFile(path, contents[index]!)));
      const downloads = legacyPaths.map((mediaPath, index) => ({
        backend: "ytdlp" as const,
        kind: "individual" as const,
        mediaPath,
        files: [mediaPath],
        source: `https://youtube.test/legacy-${index + 1}`,
        engine: "reference" as const,
        sha256: createHash("sha256").update(contents[index]!).digest("hex"),
      }));
      value.entries[0]!.acquisition = {
        status: "downloaded",
        query: "Artist Track",
        download: downloads[0]!,
        alternatives: [downloads[1]!],
      };
      await writeManifestAtomic(manifestPath, value);

      const plan = await buildAcquisitionPlan(value, { outputDirectory });
      expect(plan.recordings[0]!.variants).toHaveLength(2);
      expect(plan.recordings[0]!.variants.map((variant) => dirname(variant.outputPath))).toEqual([
        join(outputDirectory, "Artist", "Singles"),
        join(outputDirectory, "Overlap Artist", "Singles"),
      ]);
      const bin = await installFakeAudioTools(directory);
      const previousPath = process.env.PATH;
      process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
      try {
        await expect(
          acquireManifest({
            manifestPath,
            plan,
            acquirers: [],
            continueOnError: false,
            requireCompletePlan: true,
          }),
        ).rejects.toThrow(/no available backend/iu);
        expect(plan.recordings[0]!.variants.map((variant) => variant.outputPath)).not.toEqual(
          legacyPaths,
        );
        await Promise.all(
          legacyPaths.map(async (path, index) => {
            expect(await readFile(path, "utf8")).toBe(contents[index]);
          }),
        );
      } finally {
        process.env.PATH = previousPath;
      }
    },
  );

  audioToolTest(
    "maps reordered plan variants by durable key without rewriting checkpoint order",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tracks-keyed-variants-"));
      const manifestPath = join(directory, "manifest.json");
      const outputDirectory = join(directory, "tracks");
      const value = oneTrackManifest();
      value.entries[0]!.spotify = { status: "unmatched", query: "Artist Track" };
      value.entries[0]!.identity.overlaps = [
        { artist: "Overlap Artist", title: "Overlap Track", confidence: 0.9 },
      ];
      const plan = await buildAcquisitionPlan(value, { outputDirectory });
      const variants = plan.recordings[0]!.variants;
      const legacyPaths = [
        join(outputDirectory, "01 - primary.m4a"),
        join(outputDirectory, "01 - overlap.m4a"),
      ];
      const contents = ["primary keyed bytes", "overlap keyed bytes"];
      await mkdir(outputDirectory, { recursive: true });
      await Promise.all(legacyPaths.map((path, index) => writeFile(path, contents[index]!)));
      const downloads = variants.map((variant, index) => ({
        backend: "ytdlp" as const,
        kind: "individual" as const,
        mediaPath: legacyPaths[index]!,
        files: [legacyPaths[index]!],
        source: `https://youtube.test/keyed-${String(index + 1)}`,
        engine: "native" as const,
        sha256: createHash("sha256").update(contents[index]!).digest("hex"),
        variantKey:
          variant.spotifyId ??
          createHash("sha256")
            .update(
              `${variant.artists.join("\u0000")}\u0000${variant.title}\u0000${variant.isrc ?? ""}`,
            )
            .digest("hex")
            .slice(0, 20),
      }));
      value.entries[0]!.acquisition = {
        status: "downloaded",
        query: "Artist Track",
        download: downloads[0]!,
        alternatives: [downloads[1]!],
      };
      await writeManifestAtomic(manifestPath, value);
      variants.reverse();

      const bin = await installFakeAudioTools(directory);
      const previousPath = process.env.PATH;
      process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
      try {
        const result = await acquireManifest({
          manifestPath,
          plan,
          acquirers: [],
          continueOnError: false,
          requireCompletePlan: true,
        });

        expect(result.downloaded).toEqual([]);
        expect(result.resumed.toSorted()).toEqual(legacyPaths.toSorted());
        expect(variants.map((variant) => variant.outputPath)).toEqual(legacyPaths.toReversed());
        expect(result.manifest.entries[0]!.acquisition).toMatchObject({
          status: "downloaded",
          download: { variantKey: downloads[0]!.variantKey },
          alternatives: [{ variantKey: downloads[1]!.variantKey }],
        });
      } finally {
        process.env.PATH = previousPath;
      }
    },
  );

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
    manifest.artifacts.analysis = [
      {
        backend: "test",
        key: "Bm",
        keySource: "test",
        mediaPath: join(directory, "old.m4a"),
        sourceMtimeMs: 0,
        sourceSize: 1,
        summaryPath: join(directory, "analysis.json"),
        tempoBpm: 128,
      },
    ];
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
    expect(result.manifest.artifacts.analysis).toBeUndefined();
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
        async onArtifactVerified(artifact) {
          expect((await readManifest(manifestPath)).entries[0]!.acquisition.status).toBe(
            "downloaded",
          );
          expect(artifact.status).toBe("downloaded");
        },
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
      };
      await writeManifestAtomic(manifestPath, first.manifest);
      downloads = 0;
      const resumedArtifacts: string[] = [];

      const resumed = await acquireManifest({
        manifestPath,
        plan: makePlan(),
        acquirers: [acquirer],
        requireCompletePlan: true,
        onArtifactVerified(artifact) {
          expect(artifact.status).toBe("resumed");
          resumedArtifacts.push(artifact.path);
        },
      });

      expect(downloads).toBe(0);
      expect(resumed.resumed).toHaveLength(2);
      expect(resumedArtifacts.toSorted()).toEqual(resumed.resumed);
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

  audioToolTest("overlaps fallback searches while preserving backend priority", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tracks-parallel-search-"));
    const manifestPath = join(directory, "manifest.json");
    const bin = await installFakeAudioTools(directory);
    await writeManifestAtomic(manifestPath, oneTrackManifest());
    let startFallbackSearch!: () => void;
    const fallbackSearchStarted = new Promise<void>((resolve) => {
      startFallbackSearch = resolve;
    });
    const downloadedBy: string[] = [];
    const primary: TrackAcquirer = {
      backend: "slsk",
      availability: () => Promise.resolve({ available: true }),
      async search() {
        await fallbackSearchStarted;
        return [
          {
            id: "primary",
            source: "slsk://peer/track.wav",
            title: "Artist - Track",
            artist: "Artist",
            durationSeconds: 100,
          },
        ];
      },
      async download(candidate, destination) {
        downloadedBy.push("slsk");
        await mkdir(destination, { recursive: true });
        const path = join(destination, "track.wav");
        await writeFile(path, "primary audio");
        return { path, source: candidate.source, temporary: true };
      },
    };
    const fallback: TrackAcquirer = {
      backend: "ytdlp",
      availability: () => Promise.resolve({ available: true }),
      async search() {
        startFallbackSearch();
        return [];
      },
      async download() {
        downloadedBy.push("ytdlp");
        throw new Error("fallback download must not run");
      },
    };
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
    try {
      await expect(
        acquireManifest({
          manifestPath,
          plan: recordingPlan(directory),
          acquirers: [primary, fallback],
          requireCompletePlan: true,
          continueOnError: false,
        }),
      ).resolves.toMatchObject({ failures: [] });
      expect(downloadedBy).toEqual(["slsk"]);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  audioToolTest(
    "preserves the audited provider source across native and reference fallback",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tracks-provider-fallback-"));
      const manifestPath = join(directory, "manifest.json");
      const bin = await installFakeAudioTools(directory);
      await writeManifestAtomic(manifestPath, oneTrackManifest());
      const events: string[] = [];
      const soulseek: TrackAcquirer = {
        backend: "slsk",
        availability: () => Promise.resolve({ available: true }),
        search: async () => {
          events.push("slsk-search");
          return [];
        },
        download: async () => {
          throw new Error("Soulseek had no candidate");
        },
      };
      const provider: TrackAcquirer = {
        backend: "ytdlp",
        availability: () => Promise.resolve({ available: true }),
        search: async () => {
          events.push("ytdlp-search");
          return [];
        },
        download: async (candidate, destination) => {
          events.push(`ytdlp-download:${candidate.id}`);
          await mkdir(destination, { recursive: true });
          const path = join(destination, "provider.wav");
          await writeFile(path, "provider audio");
          return { path, source: candidate.source, temporary: true };
        },
      };
      const native: TrackAcquirer = {
        backend: "ytdlp",
        availability: async () => ({ available: true }),
        search: async () => {
          events.push("native-search");
          return [];
        },
        download: async () => {
          events.push("native-download");
          throw new YtdlpError("FORMAT_UNAVAILABLE", "No compatible native audio");
        },
        shouldContinueAfterError: (error) => nativeFallbackFor(error) ?? false,
      };
      const plan = recordingPlan(directory);
      plan.recordings[0]!.variants[0]!.preferredCandidate = {
        backend: "ytdlp",
        id: "soundcloud:tracks:1",
        source: "https://soundcloud.com/artist/track",
        title: "Track",
        artist: "Artist",
        durationSeconds: 100,
      };
      plan.recordings[0]!.variants[0]!.preferredCandidatePlacement = "backend-fallback";
      const previousPath = process.env.PATH;
      process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
      try {
        await expect(
          acquireManifest({
            manifestPath,
            plan,
            acquirers: [soulseek, native, provider],
            requireCompletePlan: true,
            continueOnError: false,
          }),
        ).resolves.toMatchObject({ failures: [] });
        expect(events).toEqual([
          "slsk-search",
          "native-download",
          "native-search",
          "ytdlp-download:soundcloud:tracks:1",
        ]);
      } finally {
        process.env.PATH = previousPath;
      }
    },
  );

  test("does not download through a later acquirer after a fail-closed native error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tracks-fail-closed-acquirer-"));
    const manifestPath = join(directory, "manifest.json");
    await writeManifestAtomic(manifestPath, oneTrackManifest());
    const nativeError = new Error("native write failed");
    let referenceSearches = 0;
    let referenceDownloads = 0;
    const native: TrackAcquirer = {
      backend: "ytdlp",
      availability: () => Promise.resolve({ available: true }),
      search: () => Promise.reject(nativeError),
      download: () => Promise.reject(new Error("not used")),
      shouldContinueAfterError: () => false,
    };
    const reference: TrackAcquirer = {
      backend: "ytdlp",
      requiresPriorCapabilityFailure: true,
      availability: () => Promise.resolve({ available: true }),
      search: () => {
        referenceSearches += 1;
        return Promise.resolve([
          {
            id: "abcdefghijk",
            source: "https://www.youtube.com/watch?v=abcdefghijk",
            title: "Artist - Track",
            artist: "Artist",
            durationSeconds: 100,
          },
        ]);
      },
      download: () => {
        referenceDownloads += 1;
        return Promise.reject(new Error("reference download must not run"));
      },
    };

    await expect(
      acquireManifest({
        manifestPath,
        plan: recordingPlan(directory),
        acquirers: [native, reference],
        requireCompletePlan: true,
        continueOnError: false,
      }),
    ).rejects.toBe(nativeError);
    expect(referenceSearches).toBe(0);
    expect(referenceDownloads).toBe(0);
  });

  audioToolTest.each(["capability", "cdn403"] as const)(
    "retains the selected recording across %s fallback when reference search misses it",
    async (reason) => {
      const directory = await mkdtemp(join(tmpdir(), "tracks-typed-reference-fallback-"));
      const manifestPath = join(directory, "manifest.json");
      const bin = await installFakeAudioTools(directory);
      await writeManifestAtomic(manifestPath, oneTrackManifest());
      const candidate = {
        id: "abcdefghijk",
        source: "https://www.youtube.com/watch?v=abcdefghijk",
        title: "Artist - Track",
        artist: "Artist",
        durationSeconds: 100,
      };
      const native: TrackAcquirer = {
        backend: "ytdlp",
        availability: () => Promise.resolve({ available: true }),
        search: () => Promise.resolve([candidate]),
        download: () =>
          Promise.reject(
            reason === "capability"
              ? new YtdlpError("YOUTUBE_DIRECT_FORMATS_UNAVAILABLE", "no direct M4A")
              : new YtdlpError("HTTP_ERROR", "HTTP 403", { status: 403 }),
          ),
        shouldContinueAfterError: (error) =>
          reason === "cdn403" ? undefined : (nativeFallbackFor(error) ?? false),
      };
      let referenceSearches = 0;
      let referenceDownloads = 0;
      const reference: TrackAcquirer = {
        backend: "ytdlp",
        requiresPriorCapabilityFailure: reason === "capability",
        availability: () => Promise.resolve({ available: true }),
        search: () => {
          referenceSearches += 1;
          return Promise.resolve([]);
        },
        async download(selected, destination) {
          referenceDownloads += 1;
          expect(selected.id).toBe(candidate.id);
          await mkdir(destination, { recursive: true });
          const path = join(destination, "track.m4a");
          await writeFile(path, "reference audio");
          return {
            path,
            source: selected.source,
            engine: "reference",
            temporary: true,
          };
        },
      };
      const previousPath = process.env.PATH;
      process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
      try {
        const result = await acquireManifest({
          manifestPath,
          plan: recordingPlan(directory),
          acquirers: [native, reference],
          requireCompletePlan: true,
          continueOnError: false,
        });

        expect(referenceSearches).toBe(1);
        expect(referenceDownloads).toBe(1);
        expect(result.manifest.entries[0]!.acquisition).toMatchObject({
          status: "downloaded",
          download: {
            engine: "reference",
            ...(reason === "capability"
              ? { fallback: { from: "native", code: "YOUTUBE_DIRECT_FORMATS_UNAVAILABLE" } }
              : {}),
          },
        });
      } finally {
        process.env.PATH = previousPath;
      }
    },
  );

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
    "awaits active workers and leaves unfinished entries pending on cancellation",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tracks-cancel-workers-"));
      const manifestPath = join(directory, "manifest.json");
      const manifest = createManifest({
        source: "https://youtube.test/cancel-set",
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
      const controller = new AbortController();
      let releaseFirst = (): void => undefined;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let notifyFirstStarted = (): void => undefined;
      const firstStarted = new Promise<void>((resolve) => {
        notifyFirstStarted = resolve;
      });
      let notifyAborted = (): void => undefined;
      const aborted = new Promise<void>((resolve) => {
        notifyAborted = resolve;
      });
      let searches = 0;
      let thirdSearches = 0;
      const acquirer: TrackAcquirer = {
        backend: "ytdlp",
        availability: () => Promise.resolve({ available: true }),
        async search(target) {
          searches += 1;
          if (searches === 2) {
            await firstStarted;
            controller.abort(new DOMException("test cancellation", "AbortError"));
            notifyAborted();
            throw controller.signal.reason;
          }
          if (searches > 2) thirdSearches += 1;
          return [
            {
              id: searches === 1 ? "first" : "unexpected",
              source: `https://youtube.test/${String(searches)}`,
              title: target.title,
              artist: target.artists[0]!,
              ...(target.durationSeconds === undefined
                ? {}
                : { durationSeconds: target.durationSeconds }),
            },
          ];
        },
        async download(candidate, destination) {
          if (candidate.id === "first") {
            notifyFirstStarted();
            await firstGate;
          }
          await mkdir(destination, { recursive: true });
          const path = join(destination, `${candidate.id}.m4a`);
          await writeFile(path, "audio");
          return { path, source: candidate.source, temporary: true };
        },
      };
      const bin = await installFakeAudioTools(directory);
      const previousPath = process.env.PATH;
      process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
      try {
        let settled = false;
        const outcome = acquireManifest({
          manifestPath,
          plan,
          acquirers: [acquirer],
          requireCompletePlan: true,
          continueOnError: false,
          concurrency: 2,
          signal: controller.signal,
        }).then(
          () => {
            settled = true;
            return undefined;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );

        await aborted;
        await new Promise((resolve) => setTimeout(resolve, 30));
        try {
          expect(settled).toBe(false);
          expect(thirdSearches).toBe(0);
        } finally {
          releaseFirst();
        }

        const error = await outcome;
        expect(error).toMatchObject({ name: "AbortError" });
        const durable = await readManifest(manifestPath);
        expect(durable.entries.map((entry) => entry.acquisition.status)).toEqual([
          "pending",
          "pending",
          "pending",
        ]);
        expect(
          durable.entries.flatMap((entry) =>
            entry.errors.filter((item) => item.stage === "acquisition"),
          ),
        ).toEqual([]);
      } finally {
        releaseFirst();
        process.env.PATH = previousPath;
      }
    },
  );

  audioToolTest(
    "fans every set variant through one bounded queue and preserves ambiguity order",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tracks-set-fanout-"));
      const manifestPath = join(directory, "manifest.json");
      const manifest = createManifest({
        source: "https://youtube.test/26-track-set",
        provider: "agent",
        complete: true,
        tracks: Array.from({ length: 26 }, (_, index) => ({
          order: index + 1,
          artist: "Artist",
          title: "Track",
          startSeconds: index * 100,
          endSeconds: (index + 1) * 100,
        })),
      });
      for (const entry of manifest.entries) {
        const ids =
          entry.order <= 8
            ? [`spotify-${entry.order}-a`, `spotify-${entry.order}-b`]
            : [`spotify-${entry.order}`];
        entry.spotify =
          ids.length === 1
            ? {
                status: "matched",
                query: "Artist - Track",
                score: 1,
                id: ids[0]!,
                uri: `spotify:track:${ids[0]}`,
                name: "Track",
                artists: ["Artist"],
                durationMs: 100_000,
              }
            : {
                status: "ambiguous",
                query: "Artist - Track",
                candidates: ids.map((id) => ({
                  score: 1,
                  id,
                  uri: `spotify:track:${id}`,
                  name: "Track",
                  artists: ["Artist"],
                  durationMs: 100_000,
                })),
              };
      }
      await writeManifestAtomic(manifestPath, manifest);
      const plan: AcquisitionPlan = {
        clips: [],
        recordings: manifest.entries.map((entry) => {
          const spotifyIds =
            entry.spotify.status === "matched"
              ? [entry.spotify.id]
              : entry.spotify.status === "ambiguous"
                ? entry.spotify.candidates.map((candidate) => candidate.id)
                : [];
          return {
            entryOrder: entry.order,
            variants: spotifyIds.map((spotifyId, variantIndex) => ({
              spotifyId,
              title: "Track",
              artists: ["Artist"],
              durationMs: 100_000,
              outputPath: join(directory, `track-${entry.order}-${variantIndex + 1}.m4a`),
              metadata: { title: "Track", artists: ["Artist"], comment: "test" },
            })),
          };
        }),
        stagingDirectory: join(directory, "staging"),
      };
      let active = 0;
      let maximumActive = 0;
      let downloadCalls = 0;
      const acquirer: TrackAcquirer = {
        backend: "ytdlp",
        availability: () => Promise.resolve({ available: true }),
        search: (target) =>
          Promise.resolve([
            {
              id: "candidate",
              source: "https://youtube.test/individual-track",
              title: target.title,
              artist: target.artists[0]!,
              ...(target.durationSeconds === undefined
                ? {}
                : { durationSeconds: target.durationSeconds }),
            },
          ]),
        async download(candidate, destination) {
          downloadCalls += 1;
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 15));
          await mkdir(destination, { recursive: true });
          const path = join(destination, "source.m4a");
          await writeFile(path, `audio ${destination}`);
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
        });
        if (process.env.TRACKS_PERF_LOG === "1") {
          process.stderr.write(
            `${JSON.stringify({
              artifacts: 34,
              downloadCalls,
              maximumActive,
              performance: result.performance,
            })}\n`,
          );
        }

        expect(downloadCalls).toBe(34);
        expect(maximumActive).toBe(3);
        expect(result.downloaded).toHaveLength(34);
        expect(result.performance).toMatchObject({
          concurrency: 3,
          verificationConcurrency: 8,
          spotifyConcurrency: 8,
        });
        expect(result.performance.stages).toContainEqual(
          expect.objectContaining({
            stage: "recordings",
            operations: 34,
            maxConcurrency: 3,
          }),
        );
        expect(result.performance.checkpoints).toMatchObject({ calls: 36 });
        expect(result.performance.checkpoints.flushes).toBeLessThanOrEqual(36);
        expect(result.performance.checkpoints.coalesced).toBe(
          36 - result.performance.checkpoints.flushes,
        );
        expect(
          result.manifest.entries.every((entry) => entry.acquisition.status === "downloaded"),
        ).toBe(true);
        expect(result.manifest.entries[0]!.acquisition).toMatchObject({
          status: "downloaded",
          download: { spotifyId: "spotify-1-a" },
          alternatives: [{ spotifyId: "spotify-1-b" }],
        });
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

describe("manifest locking", () => {
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
