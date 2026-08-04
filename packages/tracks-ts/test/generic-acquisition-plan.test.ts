import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "vitest";

import { acquireManifest } from "../src/acquire-manifest.js";
import { writeManifestAtomic } from "../src/acquisition.js";
import { buildAcquisitionPlan } from "../src/generic-acquisition-plan.js";
import { createManifest, type SetManifest, type SpotifyCandidate } from "../src/manifest.js";

function candidate(id: string, name: string, artist: string): SpotifyCandidate {
  return {
    score: 0.95,
    id,
    uri: `spotify:track:${id}`,
    name,
    artists: [artist],
    durationMs: 240_000,
  };
}

function manifest(sourcePath: string): SetManifest {
  const value = createManifest({
    source: "https://youtube.test/set",
    title: "Test Set",
    provider: "description",
    complete: true,
    tracks: [
      {
        order: 1,
        startSeconds: 0,
        endSeconds: 240,
        artist: "Artist One",
        title: "Track: One?",
        mediaLinks: [
          {
            platform: "spotify",
            sourceId: "match-1",
            url: "https://open.spotify.com/track/match-1",
            durationSeconds: 240,
          },
          {
            platform: "youtube",
            sourceId: "exact-video",
            url: "https://www.youtube.com/watch?v=exact-video",
            durationSeconds: 240,
          },
        ],
      },
      {
        order: 2,
        startSeconds: 240,
        endSeconds: 480,
        artist: "Artist Two",
        title: "Track Two",
      },
      {
        order: 3,
        startSeconds: 480,
        endSeconds: 720,
        artist: "Artist Three",
        title: "Track Three",
      },
      { order: 4, isId: true, startSeconds: 720, endSeconds: 840 },
    ],
  });
  const matched = candidate("match-1", "Track: One?", "Artist One");
  value.entries[0]!.spotify = {
    status: "matched",
    query: "Artist One Track One",
    ...matched,
    candidates: [matched],
  };
  value.entries[0]!.identity.overlaps = [
    { artist: "Forty Thieves", title: "Don't Turn It Off", confidence: 0.9 },
  ];
  value.entries[1]!.spotify = {
    status: "ambiguous",
    query: "Artist Two Track Two",
    candidates: [
      candidate("ambiguous-a", "Track Two", "Artist Two"),
      candidate("ambiguous-b", "Track Two", "Artist Two"),
    ],
  };
  value.entries[2]!.spotify = { status: "unmatched", query: "Artist Three Track Three" };
  value.entries[3]!.spotify = { status: "skipped", reason: "Unresolved ID" };
  value.artifacts.sourceSet = {
    url: "https://soundcloud.test/set",
    path: sourcePath,
    sha256: "a".repeat(64),
    durationSeconds: 900,
    codec: "mp3",
    bitrate: 128_000,
  };
  return value;
}

describe("buildAcquisitionPlan", () => {
  test("fans out Spotify ambiguity and preserves an identified Spotify miss", async () => {
    const directory = await mkdtemp(join(tmpdir(), "generic-plan-"));
    const outputDirectory = join(directory, "output");
    const value = manifest(join(directory, "set.mp3"));
    if (value.entries[0]!.identity.status !== "identified") throw new Error("test identity");
    value.entries[0]!.identity.label = "Night Records";
    value.entries[0]!.identity.genre = "House";

    const plan = await buildAcquisitionPlan(value, { outputDirectory });

    expect(plan.clips).toEqual([]);
    expect(plan.recordings.map(({ entryOrder }) => entryOrder)).toEqual([1, 2, 3]);
    expect(plan.recordings[0]!.variants).toHaveLength(2);
    expect(plan.recordings[0]!.variants[1]).toMatchObject({
      title: "Don't Turn It Off",
      artists: ["Forty Thieves"],
      searchQuery: "Forty Thieves - Don't Turn It Off",
    });
    expect(plan.recordings[0]!.variants[1]).not.toHaveProperty("spotifyId");
    expect(plan.recordings[1]!.variants.map(({ spotifyId }) => spotifyId)).toEqual([
      "ambiguous-a",
      "ambiguous-b",
    ]);
    expect(plan.recordings[2]!.variants[0]).toMatchObject({
      title: "Track Three",
      artists: ["Artist Three"],
      searchQuery: "Artist Three - Track Three",
    });
    expect(plan.recordings[2]!.variants[0]).not.toHaveProperty("spotifyId");
    expect(plan.recordings[0]!.variants[0]!.outputPath).not.toMatch(/[?:*]/u);
    expect(plan.recordings[0]!.variants[0]!.outputPath).toBe(
      join(outputDirectory, "Artist One", "Singles", "Track One [spotify-match-1].m4a"),
    );
    expect(plan.recordings[0]!.variants[0]!.outputPath).not.toContain("001 -");
    expect(plan.recordings[0]!.variants[0]).toMatchObject({
      preferredCandidate: {
        backend: "ytdlp",
        id: "exact-video",
        source: "https://www.youtube.com/watch?v=exact-video",
        durationSeconds: 240,
      },
      preferredCandidatePlacement: "backend-fallback",
      metadata: { label: "Night Records", genre: "House" },
    });
    expect(plan.recordings[0]!.variants[1]).not.toHaveProperty("preferredCandidate");
    expect(plan.stagingDirectory).toBe(join(outputDirectory, ".staging"));
  });

  test("finds an existing canonical recording without another local-directory option", async () => {
    const directory = await mkdtemp(join(tmpdir(), "generic-canonical-resume-"));
    const outputDirectory = join(directory, "library");
    const existing = join(
      outputDirectory,
      "Artist One",
      "Singles",
      "Track One [spotify-match-1].flac",
    );
    await mkdir(join(outputDirectory, "Artist One", "Singles"), { recursive: true });
    await writeFile(existing, "local");

    const plan = await buildAcquisitionPlan(manifest(join(directory, "set.mp3")), {
      outputDirectory,
    });

    expect(plan.recordings[0]!.variants[0]).toMatchObject({
      outputPath: existing,
      localArtifact: { sourcePath: existing, matchedBy: "spotify-id" },
    });
  });

  test("does not adopt interrupted files from the canonical staging directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "generic-canonical-staging-"));
    const outputDirectory = join(directory, "library");
    const interrupted = join(outputDirectory, ".staging", "Artist One match-1.flac");
    await mkdir(join(outputDirectory, ".staging"), { recursive: true });
    await writeFile(interrupted, "partial");

    const plan = await buildAcquisitionPlan(manifest(join(directory, "set.mp3")), {
      outputDirectory,
    });

    expect(plan.recordings[0]!.variants[0]!.localArtifact).toBeUndefined();
  });

  test("adopts unique explicit local matches before backend acquisition", async () => {
    const directory = await mkdtemp(join(tmpdir(), "generic-local-"));
    const localDirectory = join(directory, "library");
    const duplicateDirectory = join(directory, "duplicate-library");
    await mkdir(join(localDirectory, "nested"), { recursive: true });
    await mkdir(duplicateDirectory, { recursive: true });
    await Promise.all([
      writeFile(join(localDirectory, "Artist One - Track One [match-1].flac"), "local"),
      writeFile(join(localDirectory, "nested", "Artist Three - Track Three.mp3"), "local"),
      writeFile(join(duplicateDirectory, "Artist Three - Track Three.mp3"), "duplicate"),
    ]);
    const value = manifest(join(directory, "set.mp3"));
    if (value.entries[2]!.identity.status !== "identified") throw new Error("test identity");
    value.entries[2]!.identity.title = "Track Three (Unreleased Edit)";
    const plan = await buildAcquisitionPlan(value, {
      outputDirectory: join(directory, "output"),
      localDirectories: [localDirectory, duplicateDirectory],
    });

    expect(plan.recordings[0]!.variants[0]!.localArtifact).toMatchObject({
      sourcePath: join(localDirectory, "Artist One - Track One [match-1].flac"),
      matchedBy: "spotify-id",
    });
    expect(plan.recordings[0]!.variants[0]!.outputPath).toMatch(/\.flac$/u);
    expect(plan.recordings[2]!.variants[0]!.localArtifact).toMatchObject({
      sourcePath: join(localDirectory, "nested", "Artist Three - Track Three.mp3"),
      matchedBy: "artist-title",
    });
    expect(plan.recordings[2]!.variants[0]!.outputPath).toMatch(/\.mp3$/u);
  });

  test("preserves artist-title provenance when rescanning a generated Spotify-ID path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "generic-local-resume-"));
    const outputDirectory = join(directory, "output");
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(
      join(outputDirectory, "001 - Artist One - Track One [spotify-match-1].flac"),
      "local",
    );
    const value = manifest(join(directory, "set.mp3"));
    value.entries[0]!.warnings.push("match-1 adopted local artifact matched by artist-title");

    const plan = await buildAcquisitionPlan(value, {
      outputDirectory,
      localDirectories: [outputDirectory],
    });

    expect(plan.recordings[0]!.variants[0]!.localArtifact).toMatchObject({
      matchedBy: "artist-title",
    });
    expect(plan.recordings[0]!.variants[0]!.metadata).not.toHaveProperty("isrc");
  });

  test("uses ASCII-safe paths and resumes a failed individual as an approved cue clip", async () => {
    const directory = await mkdtemp(join(tmpdir(), "generic-fallback-"));
    const outputDirectory = join(directory, "output");
    const sourcePath = join(directory, "set.m4a");
    const value = manifest(sourcePath);
    if (value.entries[2]!.identity.status !== "identified") throw new Error("test identity");
    value.entries[2]!.identity.artist = "JØRD";
    value.entries[2]!.errors.push({
      stage: "acquisition",
      message: "No reviewed individual candidate passed verification",
      retryable: true,
    });

    const plan = await buildAcquisitionPlan(value, {
      outputDirectory,
      allowSourceSetClips: true,
      sourceSetPath: sourcePath,
    });
    const variant = plan.recordings[2]!.variants[0]!;
    expect(variant.outputPath).toContain("JORD");
    expect([...variant.outputPath].every((character) => character.codePointAt(0)! <= 0x7f)).toBe(
      true,
    );
    expect(variant.sourceClip).toMatchObject({
      sourcePath,
      startSeconds: 480,
      endSeconds: 720,
      containsTransitions: true,
    });
    expect(variant.metadata.title).toContain("[Set Extract]");
    expect(variant.metadata).not.toHaveProperty("isrc");
    await mkdir(dirname(variant.outputPath), { recursive: true });
    await writeFile(variant.outputPath, "set extract");

    value.entries[2]!.errors = [];
    value.entries[2]!.acquisition = {
      status: "downloaded",
      download: {
        backend: "ytdlp",
        kind: "source-set-clip",
        mediaPath: variant.outputPath,
        files: [variant.outputPath],
        clip: {
          sourceSetUrl: value.artifacts.sourceSet!.url,
          startSeconds: 480,
          endSeconds: 720,
          containsTransitions: true,
          qualityNote: "test",
        },
      },
    };
    const resumed = await buildAcquisitionPlan(value, {
      outputDirectory,
      allowSourceSetClips: true,
      sourceSetPath: sourcePath,
    });
    expect(resumed.recordings[2]!.variants[0]!.localArtifact).toBeUndefined();
    expect(resumed.recordings[2]!.variants[0]!.sourceClip).toBeDefined();

    value.entries[2]!.acquisition = {
      status: "downloaded",
      download: {
        backend: "local",
        kind: "individual",
        mediaPath: variant.outputPath,
        files: [variant.outputPath],
        source: variant.outputPath,
      },
    };
    value.entries[2]!.warnings.push(
      "Artist Three — Track Three is a cue-based source-set extract, not a verified release master",
    );
    const repaired = await buildAcquisitionPlan(value, {
      outputDirectory,
      localDirectories: [directory],
      allowSourceSetClips: true,
      sourceSetPath: sourcePath,
    });
    expect(repaired.recordings[2]!.variants[0]!.localArtifact).toBeUndefined();
    expect(repaired.recordings[2]!.variants[0]!.sourceClip).toBeDefined();
  });

  test("requires explicit verified source opt-in and validates the complete dry-run plan", async () => {
    const directory = await mkdtemp(join(tmpdir(), "generic-clips-"));
    const sourcePath = join(directory, "set.mp3");
    const value = manifest(sourcePath);
    await expect(
      buildAcquisitionPlan(value, {
        outputDirectory: join(directory, "output"),
        sourceSetPath: sourcePath,
      }),
    ).rejects.toThrow("requires allowSourceSetClips");

    const plan = await buildAcquisitionPlan(value, {
      outputDirectory: join(directory, "output"),
      allowSourceSetClips: true,
      sourceSetPath: sourcePath,
    });
    expect(plan.clips).toHaveLength(1);
    expect(plan.clips[0]).toMatchObject({
      entryOrder: 4,
      sourcePath,
      startSeconds: 720,
      endSeconds: 840,
      containsTransitions: true,
    });
    const manifestPath = join(directory, "manifest.json");
    await writeManifestAtomic(manifestPath, value);
    await expect(
      acquireManifest({
        manifestPath,
        plan,
        acquirers: [],
        requireCompletePlan: true,
        dryRun: true,
      }),
    ).resolves.toMatchObject({ failures: [] });
  });
});
