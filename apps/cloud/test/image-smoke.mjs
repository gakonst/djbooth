// Runs inside the built Linux image. No external providers or paid services.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { MasterDatabase } from "@gakonst/rekordbox";
import { createManifest, RekordboxPipelineStore } from "@gakonst/tracks";

const root = await mkdtemp("/tmp/playlist-smoke-");
try {
  const path = join(root, "master.db");
  MasterDatabase.createManaged(path).close();
  const audio = join(root, "pulse.wav");
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc=0.5*sin(2*PI*220*t)*exp(-30*mod(t\\,0.5)):s=44100:d=20",
    "-ac",
    "2",
    audio,
  ]);
  const source = "https://soundcloud.com/fixture/set";
  const manifest = createManifest({
    source,
    provider: "description",
    title: "Container fixture",
    complete: true,
    tracks: [
      { order: 1, startSeconds: 0, endSeconds: 20, artist: "Fixture artist", title: "Pulse" },
    ],
    warnings: [],
  });
  manifest.entries[0].acquisition = {
    status: "downloaded",
    download: {
      backend: "ytdlp",
      kind: "individual",
      source,
      mediaPath: audio,
      files: [audio],
      sha256: createHash("sha256")
        .update(await readFile(audio))
        .digest("hex"),
    },
  };
  const store = new RekordboxPipelineStore({ source, outputDirectory: root, dbPath: path });
  manifest.artifacts.root = store.artifactDirectory;
  manifest.artifacts.downloadDirectory = root;
  await store.save(manifest);
  store.close();
  const run = (args) => {
    const output = execFileSync("djbooth", [...args, "--format", "json"], {
      cwd: "/app",
      encoding: "utf8",
      timeout: 180_000,
    });
    const result = JSON.parse(output);
    assert.notEqual(result.ok, false, JSON.stringify(result));
    return result.data ?? result;
  };
  const result = run([
    "import",
    source,
    "--source-set-path",
    audio,
    "--db-path",
    path,
    "--output-directory",
    root,
    "--progress",
    "never",
  ]);
  assert.equal(result.entries, 1);
  assert.ok(result.playlistId);
  assert.equal(result.analyzed + result.analysisCacheHits, 1);
  const library = run([
    "cloud",
    "publish",
    "--dry-run",
    "--db-path",
    path,
    "--playlist",
    result.playlistId,
    "--namespace",
    "cloud:11111111-1111-1111-1111-111111111111",
    "--progress",
    "never",
  ]);
  assert.equal(library.tracks, 1);
  assert.equal(library.availableAudio, 1);
  const resume = run([
    "import",
    source,
    "--source-set-path",
    audio,
    "--db-path",
    path,
    "--output-directory",
    root,
    "--progress",
    "never",
  ]);
  assert.equal(resume.playlistId, result.playlistId);
  assert.equal(resume.entries, 1);
  console.log("Linux playlist import, real analysis, publish selection, and resume passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
