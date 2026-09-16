// Runs inside the built Linux image. No external providers or paid services.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
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
  // Exercise publication from the actual Linux image, including Rust-generated
  // ANLZ artifacts. A dry run alone cannot catch an old audio-only publisher.
  const changes = [];
  const media = new Map();
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/sync/changes") {
        if (request.method === "GET") {
          response.end(JSON.stringify({ changes, cursor: changes.length, hasMore: false }));
        } else {
          const change = { ...JSON.parse(body), sequence: changes.length + 1 };
          changes.push(change);
          response.writeHead(201).end(JSON.stringify(change));
        }
        return;
      }
      const hash = request.url.split("/").at(-1);
      if (request.method === "HEAD") {
        response.writeHead(media.has(hash) ? 200 : 404).end();
      } else if (request.method === "PUT") {
        assert.equal(createHash("sha256").update(body).digest("hex"), hash);
        media.set(hash, body);
        response.writeHead(201).end("{}");
      } else response.writeHead(404).end();
    } catch (error) {
      response.writeHead(500).end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(
        "djbooth",
        [
          "cloud",
          "publish",
          "--endpoint",
          `http://127.0.0.1:${server.address().port}`,
          "--db-path",
          path,
          "--playlist",
          result.playlistId,
          "--namespace",
          "cloud:11111111-1111-1111-1111-111111111111",
          "--progress",
          "never",
          "--format",
          "json",
        ],
        {
          env: { ...process.env, DJBOOTH_CLOUD_TOKEN: "fixture-token" },
          stdio: ["ignore", "pipe", "inherit"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve(JSON.parse(output)) : reject(new Error(`Publish exited ${code}`)),
      );
    });
    assert.equal((output.data ?? output).cdjReady, 1);
    const published = JSON.parse(changes.findLast((change) => change.kind === "track").payload);
    assert.equal(published.analysis.mediaHash, published.mediaHash);
    for (const key of ["dat", "ext", "twoEx"]) {
      const bytes = media.get(published.analysis[key]);
      assert.equal(bytes.subarray(0, 4).toString(), "PMAI");
    }
    assert.ok(
      media.get(published.analysis.ext).includes(Buffer.from("PWV5")),
      "RGB waveform is published",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
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
  console.log(
    "Linux import, Rust analysis, audio + DAT/EXT/2EX/RGB publication, and resume passed",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
