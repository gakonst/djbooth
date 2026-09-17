// Runs inside the built Linux image. Offline by default; an optional one-track
// provider snapshot exercises real acquisition through the same public CLI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { cloudWorkflow } from "/app/dist/cloud-workflow.js";
import { MasterDatabase } from "@gakonst/rekordbox";
import { createManifest, RekordboxPipelineStore } from "@gakonst/tracks";
import { inspectImportDetails } from "@gakonst/tracks/pipeline-state";

const root = await mkdtemp("/tmp/playlist-smoke-");
try {
  const path = join(root, "master.db");
  MasterDatabase.createManaged(path).close();
  const providerFile = process.argv[2];
  const provider = providerFile ? JSON.parse(await readFile(providerFile, "utf8")) : undefined;
  if (provider) assert.equal(provider.tracks.length, 1, "Use a one-recording provider fixture");
  const source = provider?.url ?? "https://soundcloud.com/fixture/set";
  const audio = join(root, "pulse.wav");
  if (!provider) {
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
    const manifest = createManifest({
      source,
      provider: "agent",
      url: "https://www.1001tracklists.com/tracklist/container-fixture.html",
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
  }
  const sourceArgs = providerFile
    ? [
        "--provider-playlist-file",
        providerFile,
        "--reference-ytdlp",
        "--analysis-concurrency",
        "2",
        "--analysis-threads",
        "2",
      ]
    : ["--source-set-path", audio];
  const run = (args) => {
    const output = execFileSync("djbooth", [...args, "--format", "json"], {
      cwd: "/app",
      encoding: "utf8",
      timeout: 600_000,
    });
    const result = JSON.parse(output);
    assert.notEqual(result.ok, false, JSON.stringify(result));
    return result.data ?? result;
  };
  const expanded = run([
    "resolve",
    source,
    "--db-path",
    path,
    "--output-directory",
    root,
    ...(providerFile ? ["--provider-playlist-file", providerFile] : []),
    "--progress",
    "never",
  ]);
  assert.equal(expanded.entries.length, 1);
  const importStarted = performance.now();
  const result = run([
    "import",
    source,
    ...sourceArgs,
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
  const reportDB = new MasterDatabase({ path, readonly: true, playlistXml: false });
  try {
    const report = inspectImportDetails(reportDB, source);
    assert.equal(report.tracks.length, 1);
    assert.equal(report.tracks[0].analyzed, true);
    // The offline fixture is also the source-set file, so acquisition must
    // honestly classify its audio as an extract. Provider fixtures are singles.
    assert.equal(report.tracks[0].kind, provider ? "individual" : "source-set-clip");
  } finally {
    reportDB.close();
  }
  const importMs = Math.round(performance.now() - importStarted);
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
      if (new URL(request.url, "http://fixture").pathname === "/v1/sync/changes") {
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
    const publish = (extra = []) =>
      new Promise((resolve, reject) => {
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
            ...extra,
          ],
          {
            env: { ...process.env, DJBOOTH_CLOUD_TOKEN: "container-binding" },
            stdio: ["ignore", "pipe", "inherit"],
          },
        );
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0
            ? resolve(JSON.parse(output))
            : reject(new Error(`Publish exited ${code}: ${output}`)),
        );
      });
    const progress = [];
    const createWorkflow = () =>
      cloudWorkflow({
        source,
        paths: {
          dbPath: path,
          outputDirectory: root,
          namespace: "cloud:11111111-1111-1111-1111-111111111111",
          endpoint: `http://127.0.0.1:${server.address().port}`,
          token: "container-binding",
          ...(providerFile ? { providerPlaylistFile: providerFile } : {}),
        },
        signal: new AbortController().signal,
        save: async () => {},
        progress: (value) => progress.push(value),
      });
    const stage = async (executor, name, imported) => {
      let receipt = await executor({
        operation: "start",
        stage: name,
        process_id: `${name}-1`,
        imported,
      });
      while (receipt.status === "running")
        receipt = await executor({ operation: "poll", process_id: receipt.process_id });
      assert.equal(receipt.status, "completed", JSON.stringify(receipt));
      return receipt.result;
    };
    const workflow = createWorkflow();
    assert.equal((await stage(workflow, "resolve")).entries, 1);
    const imported = await stage(workflow, "import");
    assert.equal(imported.playlistId, result.playlistId);
    if (provider) await stage(workflow, "enrich");
    assert.equal(
      progress.some((value) => value.status === "complete"),
      false,
    );
    // Restart transport between stages, retaining only the saved CLI result/database.
    const output = await stage(createWorkflow(), "publish", imported);
    assert.equal(output.status, "complete");
    assert.equal(progress.at(-1).status, "complete");
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
    const previous = changes.findLast((change) => change.kind === "track");
    const edited = { ...published, title: "Edited on the phone" };
    delete edited.analysis;
    changes.push({
      ...previous,
      operationID: "phone-edit",
      sequence: changes.length + 1,
      payload: JSON.stringify(edited),
    });
    const repaired = await publish(["--artifacts-only"]);
    assert.equal((repaired.data ?? repaired).cdjReady, 1);
    const restored = JSON.parse(changes.at(-1).payload);
    assert.equal(restored.title, edited.title);
    assert.deepEqual(restored.analysis, published.analysis);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const resumeStarted = performance.now();
  const resume = run([
    "import",
    source,
    ...sourceArgs,
    "--db-path",
    path,
    "--output-directory",
    root,
    "--progress",
    "never",
  ]);
  assert.equal(resume.playlistId, result.playlistId);
  assert.equal(resume.entries, 1);
  assert.equal(resume.downloaded, 0);
  assert.equal(resume.resumed, 1);
  assert.equal(resume.analyzed, 0);
  assert.equal(resume.analysisCacheHits, 1);
  console.log(
    "Linux import, Rust analysis, audio + DAT/EXT/2EX/RGB publication, and resume passed",
    { importMs, resumeMs: Math.round(performance.now() - resumeStarted) },
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
