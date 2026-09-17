import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { Miniflare, createFetchMock } from "miniflare";

const GRANT = `0x${"1".repeat(64)}`;
const TOKEN = `nc1.${GRANT}.${"a".repeat(43)}`;
const TOKEN_B = `nc1.${GRANT}.${"b".repeat(43)}`;
const GRANT_RELOGIN = `0x${"2".repeat(64)}`;
const TOKEN_RELOGIN = `nc1.${GRANT_RELOGIN}.${"c".repeat(43)}`;
let revoked = false;
let issuerStatus = 200;
let grantStatus = "active";
let expired = false;
let agentRequests = [];
let issuerRequests = [];
let musicConnectors = {};
const phoneCatalog = JSON.parse(
  await readFile(
    new URL(
      "../../apple/DJBoothKit/Sources/DJBoothKit/Resources/phone-tools.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const phoneDigest = `0x${createHash("sha256")
  .update(`nanocodex-app-tool-catalog-v1\0${canonical(phoneCatalog)}`)
  .digest("hex")}`;
let approvedPhoneDigest = phoneDigest;
let capabilities = ["nanocodex.agent", "chatgpt", "spotify", "soundcloud", "agent.output.final"];
async function connectIssuer(request) {
  assert.equal(request.headers.get("x-nanocodex-app-id"), "djbooth");
  assert.equal(request.headers.get("origin"), "https://library.test");
  if (issuerStatus !== 200) return new Response(null, { status: issuerStatus });
  const token = request.headers.get("authorization");
  if (
    revoked ||
    ![`Bearer ${"a".repeat(43)}`, `Bearer ${"b".repeat(43)}`, `Bearer ${"c".repeat(43)}`].includes(
      token,
    )
  )
    return new Response(null, { status: 401 });
  const path = new URL(request.url).pathname;
  issuerRequests.push(path);
  const who = token.endsWith("b") ? "b" : "a";
  if (path.includes("/agents/")) {
    if (path.endsWith("/tool-host/ticket")) {
      assert.equal(path, `/v1/grants/${GRANT}/agents/agent-${who}/tool-host/ticket`);
      assert.equal(request.method, "POST");
      return Response.json({ ticket: `ticket-${who}` });
    }
    assert.ok(path.startsWith(`/v1/grants/${GRANT}/agents/agent-${who}/turns`));
    assert.equal(request.method, "POST");
    const body = await request.text();
    agentRequests.push({
      path,
      idempotencyKey: request.headers.get("idempotency-key"),
      body: body ? JSON.parse(body) : undefined,
    });
    if (path.endsWith("/turns/other-account-turn")) return new Response(null, { status: 404 });
    return Response.json({
      turn_id: "native-turn",
      terminal: {
        type: "turn_completed",
        final_message: `Reply for ${who}`,
        raw_trace: "private trace",
      },
      credentials: "never forward",
    });
  }
  return Response.json({
    account_id: `account-${who}`,
    ...(path.endsWith("/connectors") ? { connectors: musicConnectors } : {}),
    agent_id: `agent-${who}`,
    grant: {
      id: token.endsWith("c") ? GRANT_RELOGIN : GRANT,
      status: grantStatus,
      expires_at: Math.floor(Date.now() / 1000) + (expired ? -1 : 3600),
      capabilities,
      ...(approvedPhoneDigest ? { app_tool_catalog_digest: approvedPhoneDigest } : {}),
    },
  });
}
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
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          LEGACY_LIBRARY_OWNER: `nc_${createHash("sha256").update("account-a").digest("hex")}`,
        },
        d1Databases: { LIBRARY_DB: "library" },
        r2Buckets: ["MEDIA"],
        serviceBindings: { CONNECT_API_SERVICE: "broker" },
        durableObjects: {
          PLAYLIST_CONTAINERS: { className: "TestPlaylist", scriptName: "processor" },
          AGENT_TOOLS: { className: "AgentTools" },
        },
      },
      {
        name: "broker",
        modules: true,
        compatibilityDate: "2026-08-01",
        serviceBindings: { API: connectIssuer },
        bindings: { EXPECTED_CATALOG: phoneCatalog },
        durableObjects: { BROKER: { className: "TestBroker" } },
        script: `import { DurableObject } from "cloudflare:workers"; const sockets = new Map(); const pending = new Map();
          function canonical(v) { if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'; if(v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'; return JSON.stringify(v); }
          export class TestBroker extends DurableObject { async fetch(request) {
            const env = this.env; const url = new URL(request.url);
            if (request.headers.get('upgrade') === 'websocket') {
              const pair = new WebSocketPair(); const ws = pair[1]; ws.accept();
              sockets.set(url.searchParams.get('ticket'), ws);
              ws.addEventListener('message', event => {
                const f = JSON.parse(event.data);
                if (f.type === 'catalog') {
                  if (canonical([...f.tools].sort((a,b) => canonical(a).localeCompare(canonical(b)))) !== canonical([...env.EXPECTED_CATALOG].sort((a,b) => canonical(a).localeCompare(canonical(b))))) { ws.close(1008, 'catalog mismatch'); return; }
                  ws.send(JSON.stringify({type:'ready'}));
                } else if (f.type === 'ping') ws.send(JSON.stringify({type:'pong',nonce:f.nonce}));
                else if (f.type === 'drain') ws.send(JSON.stringify({type:'draining'}));
                else if (f.type === 'result') { pending.get(f.call_id)?.(f); pending.delete(f.call_id); ws.send(JSON.stringify({type:'ack',call_id:f.call_id})); }
              });
              return new Response(null, {status:101, webSocket:pair[0]});
            }
            if(url.pathname === '/test/call') {
              const body = await request.json(); const ws = sockets.get(body.ticket);
              if(!ws) return new Response('no socket', {status:404});
              const id = crypto.randomUUID();
              const result = new Promise(resolve => { pending.set(id, resolve); setTimeout(() => { pending.delete(id); resolve({timeout:true}); }, 12000); });
              ws.send(JSON.stringify({type:'call',session_id:'test-session',model:'test-model',call_id:id,name:body.name,input:body.input,deadline_at:Date.now()+10000,output_byte_budget:16000,output_token_budget:4000}));
              return Response.json(await result);
            }
            return env.API.fetch(request);
          }};
          export default { fetch(request, env) { return env.BROKER.getByName('broker').fetch(request); } };`,
      },
      {
        name: "processor",
        modules: true,
        script: `import { DurableObject } from "cloudflare:workers";
      export class TestPlaylist extends DurableObject {
        async poll() {}
        async execute(account, grant, agent, id, input) { return { account, grant, agent, id, operation: input.operation }; }
        async enqueue(account, id, source) {
          await this.env.LIBRARY_DB.prepare("INSERT INTO test_launches (account_id, id, source) VALUES (?, ?, ?) ON CONFLICT(account_id, id) DO NOTHING").bind(account, id, source).run();
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
  await database
    .prepare(
      "INSERT INTO sync_changes(operation_id,kind,entity_id,base_version,payload,deleted) VALUES (?,?,?,?,?,?)",
    )
    .bind(
      "legacy-operation",
      "collection",
      "legacy-collection",
      0,
      JSON.stringify({ id: "legacy-collection", name: "Unowned library", trackIDs: [] }),
      0,
    )
    .run();
  const accounts = await readFile(
    new URL("../migrations/0004_accounts.sql", import.meta.url),
    "utf8",
  );
  await database.exec(accounts.replace(/^--.*$/gm, "").replace(/\n/g, " "));
  const cdj = await readFile(
    new URL("../migrations/0005_cdj_analysis.sql", import.meta.url),
    "utf8",
  );
  await database.exec(cdj.replace(/^--.*$/gm, "").replace(/\n/g, " "));
  const agents = await readFile(
    new URL("../migrations/0006_agent_imports.sql", import.meta.url),
    "utf8",
  );
  await database.exec(agents.replace(/^--.*$/gm, "").replace(/\n/g, " "));
  await database.exec(
    await readFile(new URL("../migrations/0007_import_progress.sql", import.meta.url), "utf8"),
  );
  await database.exec(
    (await readFile(new URL("../migrations/0008_download_workflows.sql", import.meta.url), "utf8"))
      .replace(/^--.*$/gm, "")
      .replace(/\n/g, " "),
  );
  await database.exec(
    (await readFile(new URL("../migrations/0009_crews.sql", import.meta.url), "utf8"))
      .replace(/^--.*$/gm, "")
      .replace(/\n/g, " "),
  );
  await database.exec(
    "CREATE TABLE test_launches (account_id TEXT, id TEXT, source TEXT, PRIMARY KEY(account_id,id))",
  );
});
after(async () => runtime?.dispose());

function request(path, init = {}) {
  return runtime.dispatchFetch(`https://library.test${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...init.headers },
  });
}

test("crews share item-level crates without exposing them to non-members", async () => {
  const send = (token, path, body, method = "POST") =>
    runtime.dispatchFetch(`https://library.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const createdResponse = await send(TOKEN, "/v1/crews", {
    name: "No Static",
    displayName: "Georgios",
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.match(created.id, /^crew_/);
  assert.deepEqual((await (await send(TOKEN_B, "/v1/crews", null, "GET")).json()).crews, []);

  const inviteResponse = await send(TOKEN, `/v1/crews/${created.id}/invites`, { role: "dj" });
  assert.equal(inviteResponse.status, 201);
  const invite = await inviteResponse.json();
  assert.equal(invite.token.length, 43);
  const accepted = await send(TOKEN_B, `/v1/crew-invites/${invite.token}/accept`, {
    displayName: "John",
  });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).members.length, 2);
  assert.equal(
    (await (await send(TOKEN_B, "/v1/crews", null, "GET")).json()).crews[0].name,
    "No Static",
  );

  const crateResponse = await send(TOKEN, `/v1/crews/${created.id}/crates`, { name: "Late night" });
  assert.equal(crateResponse.status, 201);
  const crate = await crateResponse.json();
  const shared = await send(TOKEN_B, `/v1/crews/${created.id}/crates/${crate.id}/items`, {
    track: {
      recordingID: "track-1",
      localTrackID: "local-a",
      title: "Apathy",
      artist: "Bontan",
      bpm: 123,
      musicalKey: "8A",
    },
    note: "Closer",
  });
  assert.equal(shared.status, 200);
  const detail = await shared.json();
  assert.equal(detail.items.length, 1);
  assert.equal(detail.items[0].title, "Apathy");
  assert.equal(detail.items[0].note, "Closer");
  const second = await (
    await send(TOKEN, `/v1/crews/${created.id}/crates/${crate.id}/items`, {
      track: { recordingID: "track-2", title: "Dancing Shoes", artist: "ATSOU", bpm: 122 },
    })
  ).json();
  const moved = await send(
    TOKEN_B,
    `/v1/crews/${created.id}/crates/${crate.id}/items/${detail.items[0].id}`,
    { afterItemID: second.items[1].id },
    "PATCH",
  );
  assert.equal(moved.status, 200);
  assert.deepEqual(
    (await moved.json()).items.map((item) => item.recordingID),
    ["track-2", "track-1"],
  );

  const outsider = `nc1.${GRANT}.${"c".repeat(43)}`;
  assert.equal((await send(outsider, `/v1/crews/${created.id}`, null, "GET")).status, 401);
});

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

test("music sources authenticate and read live approved identities in one issuer call", async () => {
  issuerRequests = [];
  musicConnectors = {
    spotify: { connections: [{ id: "approved", account_id: "alice", label: "Alice" }] },
  };
  const first = await runtime.dispatchFetch("https://library.test/v1/music/sources", {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal((await first.json()).sources[0].accountID, "alice");
  assert.deepEqual(issuerRequests, [`/v1/grants/${GRANT}/connectors`]);
  musicConnectors = {};
  const next = await runtime.dispatchFetch("https://library.test/v1/music/sources", {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.deepEqual((await next.json()).sources, []);
  assert.equal(issuerRequests.length, 2);
});

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
    .prepare("UPDATE import_requests SET status='failed',stage_progress=? WHERE id=?")
    .bind(JSON.stringify({ resolve: { status: "complete", current: 50, total: 50 } }), job.id)
    .run();
  const retried = await (await submitImport({}, `/v1/imports/${job.id}/retry`)).json();
  assert.equal(retried.id, job.id);
  assert.equal(retried.status, "queued");
  assert.deepEqual(retried.stages, { resolve: { status: "complete", current: 50, total: 50 } });
  const page = await (await request("/v1/imports")).json();
  assert.deepEqual(page.jobs.find((value) => value.id === job.id).stages, retried.stages);
  assert.equal("stageProgress" in retried, false);
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

test("accounts isolate sync IDs, conflicts, annotations, cursors and guessed media hashes", async () => {
  const op = makeOperation();
  const a = await (await push(op)).json();
  const asB = (path, init = {}) =>
    request(path, { ...init, headers: { ...init.headers, authorization: `Bearer ${TOKEN_B}` } });
  const postB = (body) =>
    asB("/v1/sync/changes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal((await asB("/v1/sync/changes").then((r) => r.json())).changes.length, 0);
  assert.equal((await postB({ ...op, baseVersion: a.sequence })).status, 409);
  assert.equal((await postB(op)).status, 201);
  const b = await (await asB("/v1/sync/changes")).json();
  assert.equal(b.changes.length, 1);
  assert.equal(b.changes[0].entityID, op.entityID);
  const bytes = Buffer.from("private account recording");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const path = `/v1/media/${hash}`;
  assert.equal(
    (
      await request(path, {
        method: "PUT",
        body: bytes,
        headers: { "content-type": "audio/mpeg", "content-length": String(bytes.length) },
      })
    ).status,
    201,
  );
  for (const method of ["GET", "HEAD"]) assert.equal((await asB(path, { method })).status, 404);
  assert.equal(
    (
      await asB(`${path}/compose`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chunks: [{ hash, size: bytes.length }] }),
      })
    ).status,
    409,
  );
  assert.equal((await request(path)).headers.get("cache-control"), "private, no-store");
});

test("import deduplication, request IDs and retries belong to the account", async () => {
  const id = randomUUID();
  const source = "https://soundcloud.com/account-isolation/sets/test";
  const submit = (token, path, body) =>
    request(path, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal((await submit(TOKEN, "/v1/imports", { id, source })).status, 200);
  assert.equal((await submit(TOKEN_B, `/v1/imports/${id}/retry`, {})).status, 404);
  assert.equal((await submit(TOKEN_B, "/v1/imports", { id, source })).status, 200);
  const launches = await database.prepare("SELECT * FROM test_launches WHERE id=?").bind(id).all();
  assert.equal(launches.results.length, 2);
  assert.notEqual(launches.results[0].account_id, launches.results[1].account_id);
});

test("Connect login verifies the issuer, rejects cross-origin requests and honors revocation", async () => {
  const login = await request("/v1/auth/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grantId: GRANT, token: "a".repeat(43), accountId: "account-b" }),
  });
  assert.equal(login.status, 200);
  const { account } = await login.json();
  assert.equal(account.id, `nc_${createHash("sha256").update("account-a").digest("hex")}`);
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal(
    (
      await runtime.dispatchFetch("https://library.test/v1/auth/session", {
        headers: { cookie: cookie.split(";")[0] },
      })
    ).status,
    200,
  );
  assert.equal(
    (await request("/v1/sync/changes", { headers: { origin: "https://evil.test" } })).status,
    403,
  );
  revoked = true;
  try {
    assert.equal((await request("/v1/sync/changes")).status, 401);
  } finally {
    revoked = false;
  }
  assert.equal(
    (
      await request("/v1/auth/session", {
        headers: { authorization: `Bearer nc1.${GRANT}.${"c".repeat(43)}` },
      })
    ).status,
    401,
  );
});

test("native login codes are short-lived, proof-bound and atomically consumed", async () => {
  const verifier = "v".repeat(64);
  const post = (path, body) =>
    request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const login = await post("/v1/auth/connect", {
    grantId: GRANT,
    token: "a".repeat(43),
    challenge: createHash("sha256").update(verifier).digest("hex"),
  });
  const { code } = await login.json();
  assert.ok(code);
  assert.equal((await post("/v1/auth/exchange", { code, verifier: "x".repeat(64) })).status, 401);
  const responses = await Promise.all([
    post("/v1/auth/exchange", { code, verifier }),
    post("/v1/auth/exchange", { code, verifier }),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 401]);
  const exchanged = await responses.find((r) => r.status === 200).json();
  assert.equal(exchanged.token, TOKEN);
});

test("expired or inactive grants and issuer outages fail closed", async () => {
  try {
    expired = true;
    assert.equal((await request("/v1/auth/session")).status, 401);
    expired = false;
    grantStatus = "revoked";
    assert.equal((await request("/v1/sync/changes")).status, 401);
    grantStatus = "active";
    issuerStatus = 503;
    assert.equal((await request("/v1/imports")).status, 503);
    issuerStatus = 302;
    assert.equal((await request("/v1/auth/session")).status, 503);
  } finally {
    expired = false;
    grantStatus = "active";
    issuerStatus = 200;
  }
});

test("migration preserves unowned data without assigning it to a new account", async () => {
  const legacy = await database
    .prepare("SELECT * FROM legacy_sync_changes WHERE operation_id=?")
    .bind("legacy-operation")
    .first();
  assert.equal(legacy.entity_id, "legacy-collection");
  assert.equal(
    (
      await database
        .prepare("SELECT count(*) n FROM sync_changes WHERE operation_id=?")
        .bind("legacy-operation")
        .first()
    ).n,
    0,
  );
  const bucket = await runtime.getR2Bucket("MEDIA", "library");
  const bytes = Buffer.from("legacy recording");
  const hash = createHash("sha256").update(bytes).digest("hex");
  await bucket.put(`sha256/${hash}`, bytes);
  assert.equal((await request(`/v1/media/${hash}`)).status, 404);
  assert.ok(await bucket.head(`sha256/${hash}`));
});

test("production authentication uses the Workers global fetch receiver", async () => {
  const issuer = createFetchMock();
  issuer.disableNetConnect();
  issuer
    .get("https://nanocodex-connect-api.gakonst.workers.dev")
    .intercept({
      method: "GET",
      path: `/v1/grants/${GRANT}`,
      headers: {
        authorization: `Bearer ${"a".repeat(43)}`,
        origin: "https://library.test",
        "x-nanocodex-app-id": "djbooth",
      },
    })
    .reply(401, JSON.stringify({ error: { message: "Invalid grant" } }));
  const worker = new Miniflare({
    modules: true,
    scriptPath: new URL("../dist/index.js", import.meta.url).pathname,
    compatibilityDate: "2026-08-01",
    compatibilityFlags: ["nodejs_compat"],
    fetchMock: issuer,
  });
  try {
    const response = await worker.dispatchFetch("https://library.test/v1/auth/session", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 401);
    issuer.assertNoPendingInterceptors();
  } finally {
    await worker.dispose();
  }
});

test("native agent routes use the verified grant agent and project only allowed output", async () => {
  agentRequests = [];
  for (const [token, who] of [
    [TOKEN, "a"],
    [TOKEN_B, "b"],
  ]) {
    const response = await request("/v1/agent/turns", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        id: "native-turn",
        input: "Suggest a set",
        agentId: "other-agent",
        accountId: "other-account",
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), {
      id: "native-turn",
      status: "completed",
      finalMessage: `Reply for ${who}`,
    });
  }
  assert.equal(agentRequests.length, 2);
  assert.equal(agentRequests[0].idempotencyKey, "djbooth:native-turn");
  assert.match(agentRequests[0].body.input, /Suggest a set/);
  assert.equal(agentRequests[0].body.agentId, undefined);
  assert.equal((await request("/v1/agent/turns/other-account-turn")).status, 404);
  assert.equal((await request("/v1/agent/turns/native-turn")).status, 200);
  assert.equal(
    (await request("/v1/agent/turns/native-turn/cancel", { method: "POST" })).status,
    200,
  );
  assert.equal((await request("/v1/agent/turns/native-turn/steal")).status, 404);
});
test("native agent rejects malformed prompts and enforces grant visibility and revocation", async () => {
  const before = agentRequests.length;
  for (const body of [
    { id: "../escape", input: "Hi" },
    { id: "valid", input: "" },
    { id: "valid", input: "x".repeat(16001) },
  ]) {
    assert.equal(
      (
        await request("/v1/agent/turns", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status,
      400,
    );
  }
  assert.equal(agentRequests.length, before);
  const saved = capabilities;
  try {
    capabilities = ["chatgpt"];
    const hidden = await request("/v1/agent/turns/native-turn");
    assert.equal((await hidden.json()).finalMessage, undefined);
    capabilities = [];
    assert.equal((await request("/v1/agent/turns/native-turn")).status, 403);
    revoked = true;
    assert.equal((await request("/v1/agent/turns/native-turn")).status, 401);
  } finally {
    capabilities = saved;
    revoked = false;
  }
});

test("a new grant for the same Nanocodex account reopens the same library and media", async () => {
  const op = makeOperation();
  const created = await push(op);
  assert.equal(created.status, 201);
  const receipt = await created.json();
  const bytes = Buffer.from("account stable across login grants");
  const hash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    (
      await request(`/v1/media/${hash}`, {
        method: "PUT",
        body: bytes,
        headers: { "content-type": "audio/mpeg", "content-length": String(bytes.length) },
      })
    ).status,
    201,
  );
  const headers = { authorization: `Bearer ${TOKEN_RELOGIN}` };
  const original = await (await request("/v1/auth/session")).json();
  const relogin = await (await request("/v1/auth/session", { headers })).json();
  assert.equal(relogin.account.id, original.account.id);
  assert.notEqual(relogin.account.grantId, original.account.grantId);
  const page = await (
    await request(`/v1/sync/changes?after=${receipt.sequence - 1}`, { headers })
  ).json();
  assert.ok(page.changes.some((change) => change.entityID === op.entityID));
  assert.deepEqual(
    Buffer.from(await (await request(`/v1/media/${hash}`, { headers })).arrayBuffer()),
    bytes,
  );
  assert.equal(
    (
      await request("/v1/sync/changes", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(op),
      })
    ).status,
    200,
  );
});

test("phone tool tickets require the exact approved catalog and stay bound to the verified agent", async () => {
  approvedPhoneDigest = undefined;
  assert.equal((await request("/v1/agent/tool-host/ticket", { method: "POST" })).status, 403);
  approvedPhoneDigest = `0x${"0".repeat(64)}`;
  assert.equal((await request("/v1/agent/tool-host/ticket", { method: "POST" })).status, 403);
  try {
    approvedPhoneDigest = phoneDigest;
    for (const [token, _owner] of [
      [TOKEN, "a"],
      [TOKEN_B, "b"],
    ]) {
      const response = await request("/v1/agent/tool-host/ticket", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ agentId: "other-agent", accountId: "other-user" }),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      const value = await response.json();
      assert.equal(value.catalogDigest, phoneDigest);
      assert.match(
        value.url,
        /^wss:\/\/library\.test\/v1\/agent\/phone\/[a-f0-9]{64}\/tool-host\?ticket=[a-f0-9-]{36}$/,
      );
      assert.deepEqual(Object.keys(value).sort(), ["catalogDigest", "url"]);
    }
    revoked = true;
    assert.equal((await request("/v1/agent/tool-host/ticket", { method: "POST" })).status, 401);
  } finally {
    approvedPhoneDigest = phoneDigest;
    revoked = false;
  }
});

test("explicit legacy migration isolates ownership, resumes copies and retains edits and tombstones", async () => {
  const bucket = await runtime.getR2Bucket("MEDIA", "library");
  const bytes = Buffer.from("legacy audio recording");
  const hash = createHash("sha256").update(bytes).digest("hex");
  await bucket.put(`sha256/${hash}`, bytes);
  const legacyTrack = JSON.stringify({ id: "legacy-track", title: "Original", mediaHash: hash });
  await database
    .prepare(
      "INSERT INTO legacy_sync_changes(operation_id,kind,entity_id,base_version,payload,deleted) VALUES (?,?,?,?,?,?)",
    )
    .bind("legacy-track-op", "track", "legacy-track", 0, legacyTrack, 0)
    .run();
  await database
    .prepare(
      "INSERT INTO legacy_sync_changes(operation_id,kind,entity_id,base_version,payload,deleted) VALUES (?,?,?,?,?,?)",
    )
    .bind("legacy-delete-op", "collection", "legacy-deleted", 0, null, 1)
    .run();
  const call = (token, body) =>
    runtime.dispatchFetch("https://library.test/v1/migrations/legacy", {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  assert.equal((await call(TOKEN_B)).status, 403);
  assert.equal((await call(TOKEN_B, { phase: "entities" })).status, 403);
  const plan = await (await call(TOKEN)).json();
  assert.equal(plan.imports, 0);
  const owner = plan.accountId;
  const copy = await (await call(TOKEN, { phase: "objects", task: 0 })).json();
  assert.ok(copy.copied >= 1);
  assert.deepEqual(
    Buffer.from(await (await bucket.get(`accounts/${owner}/sha256/${hash}`)).arrayBuffer()),
    bytes,
  );
  assert.ok(await bucket.head(`sha256/${hash}`));
  const again = await (await call(TOKEN, { phase: "objects", task: 0 })).json();
  assert.equal(again.copied, 0);
  const rows = await (await call(TOKEN, { phase: "entities" })).json();
  assert.ok(rows.copied >= 3);
  assert.deepEqual(rows.conflicts, []);
  const repeated = await (await call(TOKEN, { phase: "entities" })).json();
  assert.equal(repeated.copied, 0);
  assert.ok(repeated.reused >= 3);
  await database
    .prepare(
      "INSERT INTO sync_changes(account_id,operation_id,kind,entity_id,base_version,payload,deleted) VALUES (?,?,?,?,?,?,?)",
    )
    .bind(
      owner,
      "new-edit",
      "track",
      "legacy-track",
      0,
      JSON.stringify({ id: "legacy-track", title: "Keep my edit" }),
      0,
    )
    .run();
  const changed = await (await call(TOKEN, { phase: "entities" })).json();
  assert.ok(changed.conflicts.includes("track:legacy-track"));
  const deletion = await database
    .prepare("SELECT deleted FROM sync_changes WHERE account_id=? AND entity_id='legacy-deleted'")
    .bind(owner)
    .first();
  assert.equal(deletion.deleted, 1);
  const kept = await database
    .prepare(
      "SELECT payload FROM sync_changes WHERE account_id=? AND entity_id='legacy-track' ORDER BY sequence DESC LIMIT 1",
    )
    .bind(owner)
    .first();
  assert.equal(JSON.parse(kept.payload).title, "Keep my edit");
});

test("legacy migration copies chunked media and import backups into the new container namespace", async () => {
  const id = randomUUID();
  await database
    .prepare(
      "INSERT INTO legacy_import_requests(id,source,status,phase,current,total,message,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      id,
      `https://youtube.com/watch?v=${id}`,
      "running",
      "analyze",
      1,
      2,
      "In progress",
      100,
      200,
    )
    .run();
  const namespace = await runtime.getDurableObjectNamespace("PLAYLIST_CONTAINERS", "library");
  const owner = `nc_${createHash("sha256").update("account-a").digest("hex")}`;
  const oldID = namespace.idFromName(id).toString();
  const newID = namespace.idFromName(`${owner}:${id}`).toString();
  const bucket = await runtime.getR2Bucket("MEDIA", "library");
  const bytes = Buffer.from("saved analysis and audio");
  const hash = createHash("sha256").update(bytes).digest("hex");
  await bucket.put(`sha256/${hash}`, bytes);
  await bucket.put(
    `compositions/${hash}`,
    JSON.stringify({
      version: 1,
      size: bytes.length,
      contentType: "audio/mpeg",
      chunks: [{ hash, size: bytes.length }],
    }),
  );
  await bucket.put(`playlist-snapshots/${oldID}/chunks/${hash}`, bytes);
  await bucket.put(
    `playlist-snapshots/${oldID}/files/master.db`,
    JSON.stringify({ chunks: [{ hash, size: bytes.length }] }),
  );
  const call = (body) =>
    runtime.dispatchFetch("https://library.test/v1/migrations/legacy", {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const plan = await (await call()).json();
  for (const task of plan.objects) {
    let cursor;
    do {
      const response = await call({ phase: "objects", task: task.id, cursor });
      assert.equal(response.status, 200);
      cursor = (await response.json()).cursor ?? undefined;
    } while (cursor);
  }
  const result = await (await call({ phase: "imports" })).json();
  assert.equal(result.copied, 1);
  assert.equal((await (await call({ phase: "imports" })).json()).copied, 0);
  assert.ok(await bucket.head(`playlist-snapshots/${owner}/${newID}/files/master.db`));
  assert.ok(await bucket.head(`playlist-snapshots/${owner}/${newID}/chunks/${hash}`));
  assert.ok(await bucket.head(`playlist-snapshots/${oldID}/files/master.db`));
  const job = await database
    .prepare("SELECT * FROM import_requests WHERE account_id=? AND id=?")
    .bind(owner, id)
    .first();
  assert.equal(job.container_id, newID);
  assert.equal(job.status, "failed");
  const media = await runtime.dispatchFetch(`https://library.test/v1/media/${hash}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(media.status, 200);
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), bytes);
});

test("cloud tools execute only for the job's exact user, agent and live grant, with the phone closed", async () => {
  const id = randomUUID();
  const response = await submitImport({ id, source: `https://soundcloud.com/owner/sets/${id}` });
  assert.equal(response.status, 200);
  const row = await database
    .prepare("SELECT agent_grant_id, agent_id, agent_turn_id FROM import_requests WHERE id=?")
    .bind(id)
    .first();
  assert.equal(row.agent_grant_id, GRANT);
  assert.equal(row.agent_id, "agent-a");
  assert.match(row.agent_turn_id, /^[a-f0-9-]{36}$/);
  assert.ok(
    agentRequests.some(
      (v) => v.body?.input.includes(`Job ID: ${id}`) && v.body.input.includes("AGENTS.md"),
    ),
  );
  const broker = await runtime.getWorker("broker");
  async function call(ticket, name, input) {
    const response = await broker.fetch("https://issuer.test/test/call", {
      method: "POST",
      body: JSON.stringify({ ticket, name, input }),
    });
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.timeout, undefined, JSON.stringify(value));
    return value.outcome.output;
  }
  const input = { job_id: id, operation: "instructions" };
  const good = await call("ticket-a", "djbooth_exec", input);
  assert.equal(good.success, true, JSON.stringify(good));
  assert.match(good.output, /agent-a/);
  assert.equal((await call("ticket-b", "djbooth_exec", input)).success, false);
  await database
    .prepare("UPDATE import_requests SET agent_grant_id=? WHERE id=?")
    .bind(GRANT_RELOGIN, id)
    .run();
  assert.equal((await call("ticket-a", "djbooth_exec", input)).success, false);
  await database
    .prepare("UPDATE import_requests SET agent_grant_id=? WHERE id=?")
    .bind(GRANT, id)
    .run();
  const phone = await call("ticket-a", "djbooth_query", { resource: "state" });
  assert.equal(phone.success, false);
  assert.match(phone.output, /Open DJ Booth/);
  try {
    revoked = true;
    assert.equal((await call("ticket-a", "djbooth_exec", input)).success, false);
  } finally {
    revoked = false;
  }
});

test("cloud execution requires new signed approval; old read-only grants cannot launch downloads", async () => {
  const prior = approvedPhoneDigest;
  approvedPhoneDigest = undefined;
  try {
    const id = randomUUID();
    const response = await submitImport({ id, source: `https://youtu.be/${id}` });
    assert.equal(response.status, 403);
    assert.equal(
      await database.prepare("SELECT id FROM import_requests WHERE id=?").bind(id).first(),
      null,
    );
  } finally {
    approvedPhoneDigest = prior;
  }
});

test("phone query bridge consumes its ticket once and forwards live results through the cloud host", async () => {
  const response = await request("/v1/agent/tool-host/ticket", { method: "POST" });
  assert.equal(response.status, 200);
  const { url } = await response.json();
  const target = new URL(url);
  target.protocol = "https:";
  const upgrade = await runtime.dispatchFetch(target, {
    headers: { upgrade: "websocket", origin: "https://library.test" },
  });
  assert.equal(upgrade.status, 101);
  const ws = upgrade.webSocket;
  ws.accept();
  const next = () =>
    new Promise((resolve) =>
      ws.addEventListener("message", (event) => resolve(JSON.parse(event.data)), { once: true }),
    );
  const ready = next();
  ws.send(JSON.stringify({ type: "catalog", tools: phoneCatalog }));
  assert.equal((await ready).type, "ready");
  assert.equal(
    (
      await runtime.dispatchFetch(target, {
        headers: { upgrade: "websocket", origin: "https://library.test" },
      })
    ).status,
    401,
  );
  const incoming = next();
  const broker = await runtime.getWorker("broker");
  const answer = broker.fetch("https://issuer.test/test/call", {
    method: "POST",
    body: JSON.stringify({
      ticket: "ticket-a",
      name: "djbooth_query",
      input: { resource: "state" },
    }),
  });
  const frame = await incoming;
  assert.equal(frame.name, "djbooth_query");
  ws.send(
    JSON.stringify({
      type: "result",
      call_id: frame.call_id,
      outcome: {
        status: "completed",
        output: {
          output: '{"tracks":42}',
          success: true,
          structured_result: null,
          metadata: null,
          process_trace: null,
        },
      },
    }),
  );
  const result = await (await answer).json();
  assert.equal(result.outcome.output.success, true);
  assert.match(result.outcome.output.output, /42/);
  ws.close();
});
