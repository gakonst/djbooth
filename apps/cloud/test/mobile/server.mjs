// Local-only integration fixture: real Worker/D1/R2 and Connect browser SDK;
// fake Nanocodex approval/agent, no external accounts or paid requests.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { Miniflare } from "miniflare";
const require = createRequire(import.meta.url);
const sdkRequire = createRequire(import.meta.resolve("nanocodex/connect"));
const { build } = createRequire(require.resolve("wrangler/package.json"))("esbuild");
const origin = "http://127.0.0.1:8791";
const issuerOrigin = "http://127.0.0.1:8792";
const grant = (who) => `0x${(who === "Alice" ? "1" : "2").repeat(64)}`;
const token = (who) => (who === "Alice" ? "a" : "b").repeat(43);
const account = (who) => `nc_${createHash("sha256").update(who).digest("hex")}`;
const turns = new Map();
const wire = (who) => ({
  account_id: who,
  account_address: `0x${"1".repeat(40)}`,
  agent_id: `agent-${who}`,
  authorization_mode: "hosted",
  grant_token: token(who),
  grant: {
    id: grant(who),
    permission: "agent.run",
    status: "active",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    capabilities: [
      "nanocodex.agent",
      "agent.output.final",
      "agent.output.actions",
      "spotify",
      "soundcloud",
      "chatgpt",
    ],
    mcp_connections: [],
  },
});
async function issuer(request) {
  const path = new URL(request.url).pathname;
  if (path === "/v1/connections" && request.method === "POST") {
    const body = await request.json();
    if (
      !["Alice", "Bob"].includes(body.approval_id) ||
      body.authorization_mode !== "hosted" ||
      !body.requested_connectors.includes("spotify") ||
      !body.requested_connectors.includes("soundcloud")
    )
      return new Response("Invalid approval", { status: 400 });
    return Response.json(wire(body.approval_id));
  }
  const who =
    request.headers.get("authorization") === `Bearer ${token("Alice")}`
      ? "Alice"
      : request.headers.get("authorization") === `Bearer ${token("Bob")}`
        ? "Bob"
        : undefined;
  if (!who || !path.startsWith(`/v1/grants/${grant(who)}`))
    return new Response(null, { status: 401 });
  if (path === `/v1/grants/${grant(who)}`) return Response.json(wire(who));
  const prefix = `/v1/grants/${grant(who)}/agents/agent-${who}/turns`;
  if (!path.startsWith(prefix) || request.method !== "POST")
    return new Response(null, { status: 404 });
  const tail = path.slice(prefix.length);
  if (!tail) {
    const body = await request.json();
    turns.set(`${who}:${body.id}`, { text: body.input, polls: 0 });
    return Response.json({ turn_id: body.id, accepted_cursor: "1" });
  }
  const id = tail.split("/")[1];
  const turn = turns.get(`${who}:${id}`);
  if (!turn) return new Response(null, { status: 404 });
  if (tail.endsWith("/cancel")) {
    turn.cancelled = true;
    return Response.json({ turn_id: id });
  }
  turn.polls++;
  return Response.json({
    turn_id: id,
    ...(turn.cancelled
      ? { terminal: { type: "turn_cancelled" } }
      : turn.polls >= 2 && !turn.text.includes("slow")
        ? {
            terminal: {
              type: "turn_completed",
              final_message: `${who}'s Spotify and SoundCloud: try a warm opening set. Local test reply.`,
            },
          }
        : {}),
  });
}
const bundled = await build({
  stdin: {
    contents: `import { Wata, postMessage } from ${JSON.stringify(sdkRequire.resolve("wata/host"))};
const session = Wata.create({transports:[postMessage({targetOrigin:${JSON.stringify(origin)}})]}).start();
session.onRequest(async c => {
 if(c.method !== 'wallet_connect') return;
 document.getElementById('state').textContent='Choose a test account';
 for(const who of ['Alice','Bob']) document.getElementById(who).onclick=async()=>{
  await c.respond({accounts:[{address:'0x'+'1'.repeat(40),capabilities:{auth:{approval_id:who}}}]});
 };
});`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "esm",
});
const runtime = new Miniflare({
  workers: [
    {
      name: "library",
      modules: true,
      scriptPath: new URL("../../dist/index.js", import.meta.url).pathname,
      compatibilityDate: "2026-08-01",
      d1Databases: { LIBRARY_DB: "mobile" },
      r2Buckets: ["MEDIA"],
      serviceBindings: {
        CONNECT_API_SERVICE: issuer,
        ASSETS: async (request) => {
          const path = new URL(request.url).pathname;
          try {
            const data = await readFile(
              new URL(`../../public${path === "/" ? "/index.html" : path}`, import.meta.url),
            );
            return new Response(data, {
              headers: {
                "content-type": path.endsWith(".js")
                  ? "text/javascript"
                  : path.endsWith(".css")
                    ? "text/css"
                    : "text/html",
              },
            });
          } catch {
            return new Response(null, { status: 404 });
          }
        },
      },
      durableObjects: {
        PLAYLIST_CONTAINERS: { className: "FixtureImport", scriptName: "imports" },
      },
    },
    {
      name: "imports",
      modules: true,
      compatibilityDate: "2026-08-01",
      d1Databases: { LIBRARY_DB: "mobile" },
      script: `import {DurableObject} from 'cloudflare:workers'; export class FixtureImport extends DurableObject { async enqueue(account,id,source) { await this.env.LIBRARY_DB.prepare("UPDATE import_requests SET status='running',phase='resolve',message='Local test import running' WHERE account_id=? AND id=?").bind(account,id).run(); } } export default {fetch(){return new Response('fixture')}};`,
    },
  ],
});
const db = await runtime.getD1Database("LIBRARY_DB", "library");
for (const file of (await readdir(new URL("../../migrations/", import.meta.url))).sort())
  await db.exec(
    (await readFile(new URL(`../../migrations/${file}`, import.meta.url), "utf8"))
      .replace(/^--.*$/gm, "")
      .replace(/\n/g, " "),
  );
for (const who of ["Alice", "Bob"]) {
  await db
    .prepare(
      "INSERT INTO sync_changes(account_id,operation_id,kind,entity_id,base_version,payload,deleted) VALUES (?,?,?,?,?,?,0)",
    )
    .bind(
      account(who),
      "seed",
      "collection",
      "shared-playlist-id",
      0,
      JSON.stringify({
        id: "shared-playlist-id",
        name: `${who} private playlist`,
        trackIDs: [],
        kind: "playlist",
      }),
    )
    .run();
}
async function serve(port, handler) {
  const server = createServer(async (req, res) => {
    try {
      const body = [];
      for await (const chunk of req) body.push(chunk);
      const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
        method: req.method,
        headers: req.headers,
        ...(body.length ? { body: Buffer.concat(body) } : {}),
      });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      console.error(e);
      res.writeHead(500);
      res.end("fixture error");
    }
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return server;
}
const app = await serve(8791, async (request) =>
  new URL(request.url).pathname === "/__mobile_fixture"
    ? new Response("djbooth-mobile-fixture")
    : new URL(request.url).pathname === "/v1/auth/config"
      ? Response.json({ appId: "djbooth", api: issuerOrigin, dialog: `${issuerOrigin}/dialog` })
      : runtime.dispatchFetch(request.url, {
          method: request.method,
          headers: Object.fromEntries(request.headers),
          ...(request.body ? { body: await request.arrayBuffer() } : {}),
        }),
);
const auth = await serve(8792, async (request) => {
  const path = new URL(request.url).pathname;
  let response;
  if (path === "/dialog")
    response = new Response(
      `<meta name="viewport" content="width=device-width,initial-scale=1"><h1>Local Nanocodex fixture</h1><p id="state">Waiting for Connect</p><button id="Alice">Approve Alice</button><button id="Bob">Approve Bob</button><script type="module" src="/dialog.js"></script>`,
      { headers: { "content-type": "text/html" } },
    );
  else if (path === "/dialog.js")
    response = new Response(bundled.outputFiles[0].text, {
      headers: { "content-type": "text/javascript" },
    });
  else if (request.method === "OPTIONS") response = new Response(null, { status: 204 });
  else response = await issuer(request);
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-credentials", "true");
  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  headers.set(
    "access-control-allow-headers",
    "authorization,content-type,x-nanocodex-app-id,idempotency-key",
  );
  return new Response(response.body, { status: response.status, headers });
});
console.log(
  `Local mobile fixture ready at ${origin}. External authorization and agent execution are simulated.`,
);
const stop = async () => {
  app.close();
  auth.close();
  await runtime.dispose();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
