import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { Miniflare } from "miniflare";

const TOKEN = "test-only-library-token-at-least-32-characters";
let runtime;
let database;
before(async () => {
  runtime = new Miniflare({
    workers: [
      {
        name: "library",
        modules: true,
        scriptPath: new URL("../dist/index.js", import.meta.url).pathname,
        compatibilityDate: "2026-08-01",
        d1Databases: { LIBRARY_DB: "library" },
        r2Buckets: ["MEDIA"],
        bindings: { SYNC_TOKEN: TOKEN },
        durableObjects: {
          PLAYLIST_CONTAINERS: { className: "TestPlaylist", scriptName: "processor" },
        },
      },
      {
        name: "processor",
        modules: true,
        script: `import { DurableObject } from "cloudflare:workers";
      export class TestPlaylist extends DurableObject {
        async enqueue(id, source) {
          await this.env.LIBRARY_DB.prepare("INSERT INTO test_launches (id, source) VALUES (?, ?) ON CONFLICT(id) DO NOTHING").bind(id, source).run();
        }
      }
      export default { fetch() { return new Response("test"); } };`,
        d1Databases: { LIBRARY_DB: "library" },
      },
    ],
  });
  database = await runtime.getD1Database("LIBRARY_DB", "library");
  const migration = await readFile(
    new URL("../migrations/0001_library.sql", import.meta.url),
    "utf8",
  );
  await database.exec(migration.replace(/^--.*$/gm, "").replace(/\n/g, " "));
  const annotations = await readFile(
    new URL("../migrations/0002_annotations.sql", import.meta.url),
    "utf8",
  );
  await database.exec(annotations.replace(/^--.*$/gm, "").replace(/\n/g, " "));
  const imports = await readFile(
    new URL("../migrations/0003_import_requests.sql", import.meta.url),
    "utf8",
  );
  await database.exec(imports.replace(/^--.*$/gm, "").replace(/\n/g, " "));
  await database.exec("CREATE TABLE test_launches (id TEXT PRIMARY KEY, source TEXT)");
});
after(async () => runtime?.dispose());

function request(path, init = {}) {
  return runtime.dispatchFetch(`https://library.test${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...init.headers },
  });
}

function makeOperation(kind = "collection", overrides = {}) {
  const entityID = randomUUID();
  return {
    operationID: randomUUID(),
    kind,
    entityID,
    baseVersion: 0,
    payload: JSON.stringify({ id: entityID, name: "DJ Sets I like", trackIDs: ["rekordbox:42"] }),
    deleted: false,
    ...overrides,
  };
}

function push(operation) {
  return request("/v1/sync/changes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(operation),
  });
}

test("playlist publication can reconcile its own history without downloading other libraries", async () => {
  const namespace = `cloud:${randomUUID()}`;
  const entityID = `${namespace}:playlist:1`;
  const first = makeOperation("collection", {
    entityID,
    payload: JSON.stringify({ id: entityID, name: "Scoped playlist", trackIDs: [] }),
  });
  assert.equal((await push(first)).status, 201);
  assert.equal((await push(makeOperation())).status, 201);
  const page = await (
    await request(`/v1/sync/changes?namespace=${encodeURIComponent(namespace)}`)
  ).json();
  assert.deepEqual(
    page.changes.map((change) => change.entityID),
    [entityID],
  );
  assert.equal(page.hasMore, false);
  const next = await (
    await request(
      `/v1/sync/changes?namespace=${encodeURIComponent(namespace)}&after=${page.cursor}`,
    )
  ).json();
  assert.equal(next.changes.length, 0);
  assert.equal((await request("/v1/sync/changes?namespace=cloud:%25")).status, 400);
});

test("private routes deny missing and incorrect credentials", async () => {
  for (const path of ["/v1/imports", "/v1/sync/changes", `/v1/media/${"a".repeat(64)}`]) {
    assert.equal((await runtime.dispatchFetch(`https://library.test${path}`)).status, 401);
    assert.equal((await request(path, { headers: { authorization: "Bearer wrong" } })).status, 401);
  }
  assert.equal((await runtime.dispatchFetch("https://library.test/health")).status, 200);
  const closed = new Miniflare({
    modules: true,
    scriptPath: new URL("../dist/index.js", import.meta.url).pathname,
  });
  try {
    assert.equal((await closed.dispatchFetch("https://library.test/v1/sync/changes")).status, 401);
  } finally {
    await closed.dispose();
  }
});

test("append, replay, reject changed replay, conflict and tombstone", async () => {
  const op = makeOperation();
  const response = await push(op);
  assert.equal(response.status, 201);
  const first = await response.json();
  assert.ok(first.sequence > 0);
  assert.equal(first.entityID, op.entityID);
  const repeated = await push(op);
  assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), first);
  assert.equal(
    (await push({ ...op, payload: op.payload.replace("DJ Sets", "Other Sets") })).status,
    422,
  );
  const stale = await push({ ...op, operationID: randomUUID() });
  assert.equal(stale.status, 409);
  assert.deepEqual((await stale.json()).current, first);
  // Swift omits a nil payload; the wire protocol accepts both null and omission.
  const { payload: _, ...withoutPayload } = op;
  const removed = await push({
    ...withoutPayload,
    operationID: randomUUID(),
    baseVersion: first.sequence,
    deleted: true,
  });
  assert.equal(removed.status, 201);
  const tombstone = await removed.json();
  assert.equal(tombstone.payload, null);
  assert.equal(tombstone.deleted, true);
  assert.equal(
    (await push({ ...op, operationID: randomUUID(), baseVersion: first.sequence })).status,
    409,
  );
  // An old acknowledged operation still replays after newer versions exist.
  assert.deepEqual(await (await push(op)).json(), first);
});

test("simultaneous writes against one base produce one winner", async () => {
  const op = makeOperation();
  const attempts = Array.from({ length: 8 }, () => push({ ...op, operationID: randomUUID() }));
  const responses = await Promise.all(attempts);
  assert.equal(responses.filter((response) => response.status === 201).length, 1);
  assert.equal(responses.filter((response) => response.status === 409).length, 7);
  const count = await database
    .prepare("SELECT count(*) AS n FROM sync_changes WHERE entity_id = ?")
    .bind(op.entityID)
    .first();
  assert.equal(count.n, 1);
});

test("simultaneous exact retries append only once", async () => {
  const op = makeOperation();
  const responses = await Promise.all(Array.from({ length: 6 }, () => push(op)));
  assert.equal(responses.filter((response) => response.status === 201).length, 1);
  assert.equal(responses.filter((response) => response.status === 200).length, 5);
  const values = await Promise.all(responses.map((response) => response.json()));
  for (const value of values) assert.deepEqual(value, values[0]);
});

test("pagination never skips a change and catches writes after a previous empty page", async () => {
  const start = await database
    .prepare("SELECT coalesce(max(sequence), 0) AS cursor FROM sync_changes")
    .first();
  for (let i = 0; i < 103; i++) assert.equal((await push(makeOperation())).status, 201);
  const first = await (await request(`/v1/sync/changes?after=${start.cursor}`)).json();
  assert.equal(first.changes.length, 100);
  assert.equal(first.hasMore, true);
  assert.equal(first.cursor, first.changes.at(-1).sequence);
  const second = await (await request(`/v1/sync/changes?after=${first.cursor}`)).json();
  assert.equal(second.changes.length, 3);
  assert.equal(second.hasMore, false);
  assert.ok(second.changes[0].sequence > first.cursor);
  const empty = await (await request(`/v1/sync/changes?after=${second.cursor}`)).json();
  assert.equal(empty.cursor, second.cursor);
  assert.deepEqual(empty.changes, []);
  const late = await (await push(makeOperation())).json();
  const subsequent = await (await request(`/v1/sync/changes?after=${empty.cursor}`)).json();
  assert.deepEqual(subsequent.changes, [late]);
});

test("large pages are bounded by bytes without truncating an entity", async () => {
  const start = await database
    .prepare("SELECT coalesce(max(sequence), 0) AS cursor FROM sync_changes")
    .first();
  for (let i = 0; i < 6; i++) {
    const entityID = randomUUID();
    const payload = JSON.stringify({
      id: entityID,
      name: "Long collection",
      trackIDs: Array.from({ length: 1000 }, (_, n) => `${n}-${"a".repeat(200)}`),
    });
    assert.equal((await push(makeOperation("collection", { entityID, payload }))).status, 201);
  }
  const page = await (await request(`/v1/sync/changes?after=${start.cursor}`)).json();
  assert.ok(page.changes.length > 0 && page.changes.length < 6);
  assert.ok(JSON.stringify(page).length < 1024 * 1024);
  assert.equal(page.hasMore, true);
  const rest = await (await request(`/v1/sync/changes?after=${page.cursor}`)).json();
  assert.equal(page.changes.length + rest.changes.length, 6);
});

test("malformed or incompatible operations never poison native decoding", async () => {
  for (const override of [
    { kind: "playlist" },
    { entityID: "" },
    { baseVersion: -1 },
    { baseVersion: 0.5 },
    { deleted: true },
    { payload: "{}" },
    { payload: "broken" },
    { payload: '"string"' },
  ])
    assert.equal((await push(makeOperation("collection", override))).status, 400);
  const id = randomUUID();
  const track = {
    id,
    title: "Native Track",
    artworkAvailable: false,
    fileExists: true,
    analyzed: true,
    mediaHash: "a".repeat(64),
    mediaExtension: "m4a",
  };
  assert.equal(
    (await push(makeOperation("track", { entityID: id, payload: JSON.stringify(track) }))).status,
    201,
  );
  for (const extra of [
    { mediaHash: "../private" },
    { bpm: "120" },
    { hosted: {} },
    { filePath: "/Users/private/music.mp3" },
    { waveform: { peaks: ["wrong"], source: "rekordbox" } },
    { waveform: { peaks: [0.5], source: ["rekordbox"] } },
    { waveform: { peaks: Array(8193).fill(0.5), source: "rekordbox" } },
    { waveform: { peaks: [0.5], source: "rekordbox", colors: [[1.2, 2, 3]] } },
    ...[
      { times: [0, 0], beats: [1, 2] },
      { times: [0, 1], beats: [1] },
      { times: [-1], beats: [1] },
      { times: [0], beats: [5] },
      { times: Array.from({ length: 20_001 }, (_, index) => index), beats: Array(20_001).fill(1) },
    ].map((beatGrid) => ({ waveform: { peaks: [0.5], source: "rekordbox", beatGrid } })),
  ]) {
    assert.equal(
      (
        await push(
          makeOperation("track", { entityID: id, payload: JSON.stringify({ ...track, ...extra }) }),
        )
      ).status,
      400,
    );
  }
  const waveformID = randomUUID();
  assert.equal(
    (
      await push(
        makeOperation("track", {
          entityID: waveformID,
          payload: JSON.stringify({
            ...track,
            id: waveformID,
            waveform: {
              peaks: Array(8192).fill(0.3333),
              colors: Array(8192).fill([255, 255, 255]),
              source: "rekordbox",
              durationSeconds: 3600,
              beatGrid: { times: [0.013, 0.502, 0.991, 1.48, 1.969], beats: [1, 2, 3, 4, 1] },
            },
          }),
        }),
      )
    ).status,
    201,
  );
  for (const cursor of ["-1", "1.5", "NaN", "9007199254740992"]) {
    assert.equal((await request(`/v1/sync/changes?after=${cursor}`)).status, 400);
  }
  assert.equal(
    (
      await request("/v1/sync/changes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(512 * 1024 + 1),
      })
    ).status,
    413,
  );
});

test("media verifies SHA-256, remains immutable and supports seek/resume requests", async () => {
  const bytes = Buffer.from("0123456789abcdefghij");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const path = `/v1/media/${hash}`;
  const upload = await request(path, {
    method: "PUT",
    body: bytes,
    headers: { "content-type": "audio/mpeg", "content-length": String(bytes.length) },
  });
  assert.equal(upload.status, 201, await upload.text());
  const head = await request(path, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(bytes.length));
  assert.equal(head.headers.get("content-type"), "audio/mpeg");
  assert.equal(await head.text(), "");
  const full = await request(path);
  assert.equal(full.status, 200);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
  for (const [range, expected, contentRange] of [
    ["bytes=2-5", "2345", "bytes 2-5/20"],
    ["bytes=15-", "fghij", "bytes 15-19/20"],
    ["bytes=-3", "hij", "bytes 17-19/20"],
    ["bytes=18-100", "ij", "bytes 18-19/20"],
  ]) {
    const response = await request(path, { headers: { range } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), contentRange);
    assert.equal(await response.text(), expected);
  }
  for (const range of ["bytes=30-", "bytes=5-2", "bytes=-0", "bytes=0-1,5-6"]) {
    const response = await request(path, { headers: { range } });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get("content-range"), "bytes */20");
  }
  const unchanged = await request(path, { headers: { "if-none-match": `"${hash}"` } });
  assert.equal(unchanged.status, 304);
  assert.equal(
    (await request(path, { headers: { range: "bytes=2-5", "if-range": '"old"' } })).status,
    200,
  );
  const overwrite = await request(path, {
    method: "PUT",
    body: "wrong",
    headers: { "content-length": "5", "content-type": "application/octet-stream" },
  });
  assert.equal(overwrite.status, 200);
  assert.equal(await (await request(path)).text(), bytes.toString());
  assert.equal((await request(path, { method: "DELETE" })).status, 405);
  const corruptPath = `/v1/media/${"b".repeat(64)}`;
  const corrupt = await request(corruptPath, {
    method: "PUT",
    body: bytes,
    headers: { "content-length": String(bytes.length) },
  });
  assert.equal(corrupt.status, 422, await corrupt.text());
  assert.equal((await request(corruptPath)).status, 404);
});

test("resumable audio composition verifies the complete hash and seeks across chunk boundaries", async () => {
  const parts = [
    Buffer.from("first-audio-part"),
    Buffer.from("second-audio-part"),
    Buffer.from("last-audio-part"),
  ];
  const complete = Buffer.concat(parts);
  const hash = createHash("sha256").update(complete).digest("hex");
  const chunks = parts.map((part) => ({
    hash: createHash("sha256").update(part).digest("hex"),
    size: part.length,
  }));
  const path = `/v1/media/${hash}`;
  const completeRequest = (address = hash, selected = chunks) =>
    request(`/v1/media/${address}/compose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chunks: selected, contentType: "audio/mpeg" }),
    });
  // A dropped client can resume with HEAD for each immutable chunk. No incomplete
  // whole-file address is made visible while any part remains absent.
  assert.equal((await completeRequest()).status, 409);
  assert.equal((await request(path)).status, 404);
  for (const [index, chunk] of chunks.entries()) {
    const partPath = `/v1/media/${chunk.hash}`;
    assert.equal((await request(partPath, { method: "HEAD" })).status, 404);
    assert.equal(
      (
        await request(partPath, {
          method: "PUT",
          body: parts[index],
          headers: { "content-length": String(chunk.size) },
        })
      ).status,
      201,
    );
    assert.equal((await request(partPath, { method: "HEAD" })).status, 200);
  }
  assert.equal((await completeRequest("c".repeat(64))).status, 422);
  assert.equal((await request(`/v1/media/${"c".repeat(64)}`)).status, 404);
  assert.equal((await completeRequest(hash, [...chunks].reverse())).status, 422);
  const result = await completeRequest();
  assert.equal(result.status, 201, await result.text());
  assert.equal((await completeRequest()).status, 200);
  const head = await request(path, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(complete.length));
  assert.equal(head.headers.get("content-type"), "audio/mpeg");
  assert.deepEqual(Buffer.from(await (await request(path)).arrayBuffer()), complete);
  for (const [offset, end] of [
    [0, 3],
    [12, 21],
    [14, 35],
    [35, complete.length - 1],
  ]) {
    const response = await request(path, { headers: { range: `bytes=${offset}-${end}` } });
    assert.equal(response.status, 206);
    assert.equal(
      response.headers.get("content-range"),
      `bytes ${offset}-${end}/${complete.length}`,
    );
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), complete.subarray(offset, end + 1));
  }
  assert.equal(
    (await completeRequest("d".repeat(64), [{ hash: chunks[0].hash, size: 16 * 1024 * 1024 + 1 }]))
      .status,
    400,
  );
  assert.equal(
    (await completeRequest("d".repeat(64), [{ hash: chunks[0].hash, size: 2 }])).status,
    409,
  );
});

test("annotation edits are independent of track metadata, support replay/conflicts/clear, and validate input", async () => {
  const entityID = randomUUID();
  const track = makeOperation("track", {
    entityID,
    payload: JSON.stringify({
      id: entityID,
      title: "Recording",
      artworkAvailable: false,
      fileExists: false,
      analyzed: true,
    }),
  });
  const firstTrack = await (await push(track)).json();
  const note = makeOperation("annotation", {
    entityID,
    payload: JSON.stringify({ note: "  Bring in the bass\nAt 2:30 🎛️", color: "cyan" }),
  });
  const saved = await push(note);
  assert.equal(saved.status, 201);
  const annotation = await saved.json();
  assert.deepEqual(await (await push(note)).json(), annotation);
  const stale = await push({ ...note, operationID: randomUUID() });
  assert.equal(stale.status, 409);
  assert.deepEqual((await stale.json()).current, annotation);
  const refreshed = await push({
    ...track,
    operationID: randomUUID(),
    baseVersion: firstTrack.sequence,
    payload: track.payload.replace("Recording", "Corrected title"),
  });
  assert.equal(refreshed.status, 201);
  const afterRefresh = await database
    .prepare(
      "SELECT * FROM sync_changes WHERE kind = ? AND entity_id = ? ORDER BY sequence DESC LIMIT 1",
    )
    .bind("annotation", entityID)
    .first();
  assert.equal(afterRefresh.sequence, annotation.sequence);
  assert.equal(afterRefresh.payload, note.payload);
  const cleared = await push({
    ...note,
    operationID: randomUUID(),
    baseVersion: annotation.sequence,
    payload: null,
    deleted: true,
  });
  assert.equal(cleared.status, 201);
  assert.equal((await cleared.json()).deleted, true);
  for (const payload of [
    { note: 3 },
    { note: "", color: "green" },
    { note: "x", color: ["red"] },
    { note: "x", color: {} },
    { note: "x", color: 1 },
    { note: "x".repeat(16385) },
    { note: "🎶".repeat(4097) },
    { note: "x", path: "/private/file" },
  ]) {
    assert.equal(
      (await push(makeOperation("annotation", { payload: JSON.stringify(payload) }))).status,
      400,
    );
  }
  assert.equal(
    (
      await push(
        makeOperation("annotation", {
          payload: JSON.stringify({ note: "🎶".repeat(4096), color: null }),
        }),
      )
    ).status,
    201,
  );
});

test("legacy and opted-in clients page over interleaved annotations without losing global cursor progress", async () => {
  const start = await database
    .prepare("SELECT coalesce(max(sequence),0) AS cursor FROM sync_changes")
    .first();
  for (let i = 0; i < 101; i++)
    assert.equal(
      (await push(makeOperation("annotation", { payload: JSON.stringify({ note: `note ${i}` }) })))
        .status,
      201,
    );
  const collection = await (await push(makeOperation())).json();
  const legacyFirst = await (await request(`/v1/sync/changes?after=${start.cursor}`)).json();
  assert.deepEqual(legacyFirst.changes, []);
  assert.equal(legacyFirst.hasMore, true);
  assert.ok(legacyFirst.cursor > start.cursor);
  const legacyNext = await (await request(`/v1/sync/changes?after=${legacyFirst.cursor}`)).json();
  assert.deepEqual(legacyNext.changes, [collection]);
  assert.equal(legacyNext.hasMore, false);
  assert.equal(legacyNext.cursor, collection.sequence);
  const modernFirst = await (
    await request(
      `/v1/sync/changes?after=${start.cursor}&kinds=track,collection,favorite,annotation`,
    )
  ).json();
  assert.equal(modernFirst.changes.length, 100);
  assert.equal(modernFirst.cursor, legacyFirst.cursor);
  assert.equal(modernFirst.hasMore, true);
  const modernNext = await (
    await request(
      `/v1/sync/changes?after=${modernFirst.cursor}&kinds=track,collection,favorite,annotation`,
    )
  ).json();
  assert.deepEqual(
    modernNext.changes.map((c) => c.kind),
    ["annotation", "collection"],
  );
  assert.equal(modernNext.cursor, legacyNext.cursor);
  assert.equal((await request("/v1/sync/changes?kinds=unknown")).status, 400);
});

test("annotation migration preserves existing sequences, tombstones and idempotency keys", async () => {
  // Exercise the real migration on an isolated D1 database, with nontrivial sequence values.
  const isolated = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    d1Databases: { OLD: "old" },
  });
  try {
    const db = await isolated.getD1Database("OLD");
    const sql = async (name) =>
      (await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"))
        .replace(/^--.*$/gm, "")
        .replace(/\n/g, " ");
    await db.exec(await sql("0001_library.sql"));
    await db
      .prepare(
        "INSERT INTO sync_changes (sequence,operation_id,kind,entity_id,base_version,payload,deleted) VALUES (?,?,?,?,?,?,?)",
      )
      .bind(41, "preserved-op", "favorite", "track", 0, '{"enabled":true}', 0)
      .run();
    await db
      .prepare(
        "INSERT INTO sync_changes (sequence,operation_id,kind,entity_id,base_version,payload,deleted) VALUES (?,?,?,?,?,?,?)",
      )
      .bind(42, "preserved-delete", "favorite", "track", 41, null, 1)
      .run();
    const before = await db.prepare("SELECT * FROM sync_changes ORDER BY sequence").all();
    await db.exec(await sql("0002_annotations.sql"));
    assert.deepEqual(
      (await db.prepare("SELECT * FROM sync_changes ORDER BY sequence").all()).results,
      before.results,
    );
    await db
      .prepare(
        "INSERT INTO sync_changes (operation_id,kind,entity_id,base_version,payload,deleted) VALUES (?,?,?,?,?,?)",
      )
      .bind("annotation-new", "annotation", "track", 0, '{"note":"Mix in"}', 0)
      .run();
    assert.equal(
      (await db.prepare("SELECT max(sequence) AS sequence FROM sync_changes").first()).sequence,
      43,
    );
  } finally {
    await isolated.dispose();
  }
});

function submitImport(body, path = "/v1/imports") {
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
test("one playlist container across concurrent submissions and uncertain retries", async () => {
  const source = "https://soundcloud.com/artist/sets/" + randomUUID();
  const id = randomUUID();
  const responses = await Promise.all([
    submitImport({ id, source }),
    submitImport({ id, source }),
    submitImport({ id: randomUUID(), source }),
  ]);
  for (const response of responses) assert.equal(response.status, 200);
  const jobs = await Promise.all(responses.map((response) => response.json()));
  assert.equal(new Set(jobs.map((job) => job.id)).size, 1);
  const launches = await database
    .prepare("SELECT * FROM test_launches WHERE source=?")
    .bind(source)
    .all();
  assert.equal(launches.results.length, 1);
  assert.equal(
    (await submitImport({ id: jobs[0].id, source: "https://youtube.com/watch?v=different" }))
      .status,
    409,
  );
  assert.equal(jobs[0].status, "queued");
  assert.equal(JSON.stringify(jobs[0]).includes("leaseToken"), false);
  const page = await (await request("/v1/imports")).json();
  assert.ok(page.jobs.some((job) => job.id === jobs[0].id));
});
test("failed playlist retries reuse identity; completed playlists stay completed", async () => {
  const job = await (
    await submitImport({ id: randomUUID(), source: "https://youtu.be/" + randomUUID() })
  ).json();
  await database
    .prepare("UPDATE import_requests SET status='failed' WHERE id=?")
    .bind(job.id)
    .run();
  const retried = await (await submitImport({}, `/v1/imports/${job.id}/retry`)).json();
  assert.equal(retried.id, job.id);
  assert.equal(retried.status, "queued");
  await database
    .prepare("UPDATE import_requests SET status='complete' WHERE id=?")
    .bind(job.id)
    .run();
  assert.equal(
    (await (await submitImport({}, `/v1/imports/${job.id}/retry`)).json()).status,
    "complete",
  );
});
test("remote imports reject paths, CLI options, credentials, and untrusted hosts", async () => {
  for (const source of [
    "/private/master.db",
    "--whole-set",
    "file:///tmp/set",
    "http://localhost/set",
    "https://evil.test/set",
    "https://token@youtube.com/watch?v=1",
    "https://youtube.com:9000/watch?v=1",
  ]) {
    assert.equal((await submitImport({ id: randomUUID(), source })).status, 400);
  }
  assert.equal((await submitImport({}, "/v1/imports/claim")).status, 404);
});

test("snapshot access is not exposed through the public Worker", async () => {
  assert.equal((await request("/snapshot/files")).status, 404);
  assert.equal((await request("/snapshot/files/master.db")).status, 404);
});
