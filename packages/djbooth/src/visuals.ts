import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { Cli, z } from "incur";
import WebSocket, { WebSocketServer } from "ws";
import { visualsPage } from "./visuals-page.js";
import { readRemoteDeckMedia, type RemoteDeckMedia } from "./remote-deck-media.js";

export const visualsCli = Cli.create("visuals", {
  description:
    "Serve live CDJ-reactive WebGL visuals and open them on a Samsung TV. Keep this command running; Ctrl-C stops the visual feed.",
  options: z.object({
    host: z.string().refine(isIPv4, "Provide this computer's LAN IPv4 address"),
    tv: z.string().refine(isIPv4, "Provide the Samsung TV IPv4 address"),
    port: z.number().int().min(1024).max(65535).default(4190),
    open: z.boolean().default(true).describe("Open the TV browser; disable for HDMI or AirPlay"),
    preview: z
      .string()
      .optional()
      .describe("Serve a standalone HTML preview at / without changing the live display"),
    progress: z.enum(["auto", "always", "never"]).default("auto"),
  }),
  async run({ options }) {
    const progress = (message: string) => {
      if (options.progress !== "never") process.stderr.write(`[visuals] ${message}\n`);
    };
    progress("starting 0/3: preparing the TV visual feed");
    const url = `http://${options.host}:${options.port}/`;
    const preview = options.preview ? await readFile(options.preview, "utf8") : undefined;
    let browserId = "org.tizen.browser";
    for (const id of options.open ? ["3202010022079", "3201907018784", "org.tizen.browser"] : []) {
      try {
        const app = await fetch(`http://${options.tv}:8001/api/v2/applications/${id}`, {
          signal: AbortSignal.timeout(2000),
        });
        if (app.ok && ((await app.json()) as { id?: string }).id === id) {
          browserId = id;
          break;
        }
      } catch {
        /* Try the next known browser identifier. */
      }
    }
    let rendered = false;
    type Deck = {
      player: number;
      sourcePlayer?: number;
      sourceSlot?: number;
      trackId?: number;
      ip?: string;
      beatNumber?: number;
      [key: string]: unknown;
    };
    const media = new Map<string, Promise<RemoteDeckMedia>>();
    const mediaKey = (deck: Deck) => `${deck.sourcePlayer}:${deck.sourceSlot}:${deck.trackId}`;
    const remoteMedia = (deck: Deck) => {
      const key = mediaKey(deck);
      let result = media.get(key);
      if (!result) {
        result = (async () => {
          const state = (await (
            await fetch("http://127.0.0.1:4182/v1/state", { signal: AbortSignal.timeout(2000) })
          ).json()) as { decks: Deck[] };
          const source = state.decks.find((d) => d.player === deck.sourcePlayer);
          if (!source?.ip || !deck.trackId || !deck.sourceSlot)
            throw new Error("Source deck unavailable");
          const value = await readRemoteDeckMedia(
            source.ip,
            deck.sourceSlot,
            deck.trackId,
            source.player,
          );
          progress(`USB media: ${value.title}; ${value.waveform.peaks.length} waveform samples`);
          return value;
        })();
        media.set(key, result);
        if (media.size > 24) media.delete(media.keys().next().value!);
        result.catch(() => {
          setTimeout(() => {
            if (media.get(key) === result) media.delete(key);
          }, 10000).unref();
        });
      }
      return result;
    };
    const server = createServer(async (request, response) => {
      const address = request.socket.remoteAddress?.replace(/^::ffff:/, "");
      if (![options.tv, options.host, "127.0.0.1"].includes(address ?? "")) {
        response.writeHead(403).end();
        return;
      }
      const path = new URL(request.url ?? "/", url);
      response.setHeader("Cache-Control", "no-store");
      if (request.method !== "GET") {
        response.writeHead(405).end();
        return;
      }
      if (
        path.pathname.startsWith("/v1/tracks/") &&
        Number(path.searchParams.get("sourcePlayer")) > 0 &&
        Number(path.searchParams.get("sourcePlayer")) <= 6
      ) {
        try {
          const value = await remoteMedia({
            player: 0,
            sourcePlayer: Number(path.searchParams.get("sourcePlayer")),
            sourceSlot: Number(path.searchParams.get("sourceSlot")),
            trackId: Number(path.pathname.split("/")[3]),
          });
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify(value.waveform));
        } catch {
          response.writeHead(503).end('{"error":"USB media temporarily unavailable"}');
        }
        return;
      }
      if (
        path.pathname === "/booth" ||
        path.pathname.startsWith("/assets/") ||
        path.pathname.startsWith("/hardware/") ||
        path.pathname.startsWith("/v1/tracks/")
      ) {
        try {
          const upstream = await fetch(`http://127.0.0.1:4179${path.pathname}${path.search}`, {
            signal: AbortSignal.timeout(8000),
          });
          response.statusCode = upstream.status;
          response.setHeader(
            "Content-Type",
            upstream.headers.get("content-type") ?? "application/octet-stream",
          );
          if (path.pathname === "/booth") {
            const html = await upstream.text();
            response.end(
              html
                .replace(
                  "</head>",
                  `<style>html,body,#root{margin:0!important;width:100%;height:100%;overflow:hidden!important;background:#030509!important}.view-switcher,.monitor-header,.activity-panel,.skip-link{display:none!important}.hardware-view,.monitor-shell{padding:0!important;margin:0!important;max-width:none!important;min-width:0!important}.booth-grid{display:flex!important;justify-content:space-evenly!important;align-items:center!important;height:100vh!important;gap:0!important}.cdj3000{height:auto!important;width:min(22vw,70vh)!important;flex:none!important;aspect-ratio:2478/3300!important}.djma9{display:block!important;height:auto!important;width:min(28vw,89.7vh)!important;flex:none!important;aspect-ratio:1061/1104!important}</style></head>`,
                )
                .replace(
                  "</body>",
                  `<script>setInterval(function(){fetch('/report?message='+encodeURIComponent('booth '+document.querySelectorAll('.cdj3000').length+' decks '+(document.querySelector('.status-pill')||{}).textContent)).catch(function(){});},5000);</script></body>`,
                ),
            );
          } else response.end(Buffer.from(await upstream.arrayBuffer()));
        } catch {
          response.writeHead(502).end("Booth temporarily unavailable");
        }
      } else if (path.pathname === "/state") {
        try {
          const upstream = await fetch("http://127.0.0.1:4182/v1/state", {
            signal: AbortSignal.timeout(1500),
          });
          if (!upstream.ok) throw new Error("Telemetry unavailable");
          response.setHeader("Content-Type", "application/json");
          response.end(await upstream.text());
        } catch {
          response.writeHead(503).end('{"decks":[]}');
        }
      } else if (path.pathname === "/report") {
        const message = (path.searchParams.get("message") ?? "")
          .replace(/[\r\n]/g, " ")
          .slice(0, 200);
        progress(`${address}: ${message}`);
        if (address === options.tv && message.startsWith("rendering") && !rendered) {
          rendered = true;
          progress("success 3/3: TV confirms rendered frames");
        }
        response.end("ok");
      } else if (path.pathname === "/visual") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(visualsPage);
      } else if (path.pathname === "/") {
        progress(`screen requested by ${address}`);
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(
          preview ??
            `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>DJ BOOTH LIVE</title><style>*{box-sizing:border-box}html,body{margin:0;background:#030509;width:100%;height:100%;overflow:hidden}iframe{border:0;width:100%;display:block}#visual{height:52%}#decks{height:48%;border-top:1px solid #163246}</style></head><body><iframe id="visual" src="/visual" title="Live visuals"></iframe><iframe id="decks" src="/booth?assistant=0&hardwareMidi=1" title="Three live CDJ decks and DJM-A9 mixer"></iframe><script>document.addEventListener('keydown',function(e){if(e.keyCode===13&&document.documentElement.requestFullscreen)document.documentElement.requestFullscreen();});</script></body></html>`,
        );
      } else response.writeHead(404).end();
    });
    const sockets = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      const address = request.socket.remoteAddress?.replace(/^::ffff:/, "");
      if (
        request.url !== "/v1/events" ||
        ![options.tv, options.host, "127.0.0.1"].includes(address ?? "")
      ) {
        socket.destroy();
        return;
      }
      sockets.handleUpgrade(request, socket, head, (client) => {
        const upstream = new WebSocket("ws://127.0.0.1:4182/v1/events");
        const pending = new Map<number, string>();
        const latest = new Map<number, Record<string, unknown> & { deck: Deck }>();
        const hydrate = (message: Record<string, unknown> & { deck: Deck }) => {
          const deck = message.deck;
          latest.set(deck.player, message);
          if (!deck.sourcePlayer || deck.sourcePlayer > 6 || !deck.trackId) return;
          void remoteMedia(deck)
            .then((value) => {
              const current = latest.get(deck.player);
              if (!current || mediaKey(current.deck) !== mediaKey(deck)) return;
              const updated = {
                ...current.deck,
                trackTitle: value.title,
                trackArtist: value.artist,
                trackLengthSec: value.duration,
              };
              pending.set(deck.player, JSON.stringify({ ...current, deck: updated }));
            })
            .catch(() => {});
        };
        const flush = setInterval(() => {
          if (client.readyState !== WebSocket.OPEN || client.bufferedAmount > 65536) return;
          for (const data of pending.values()) client.send(data);
          pending.clear();
        }, 100);
        upstream.on("message", (data) => {
          try {
            const message = JSON.parse(String(data));
            if (message.type === "snapshot" && client.readyState === WebSocket.OPEN) {
              client.send(String(data));
              for (const deck of message.snapshot.decks)
                hydrate({
                  type: "deck",
                  schemaVersion: 1,
                  sequence: message.snapshot.sequence,
                  observedAtUs: message.snapshot.observedAtUs,
                  deck,
                });
            } else if (message.type === "deck") {
              pending.set(message.deck.player, String(data));
              hydrate(message);
            } else if (message.type === "meters") {
              pending.set(-1, String(data));
            } else if (message.type === "event" && client.readyState === WebSocket.OPEN) {
              client.send(String(data));
            }
          } catch {
            /* Ignore malformed telemetry. */
          }
        });
        upstream.on("error", () => client.close());
        upstream.on("close", () => client.close());
        client.on("close", () => {
          clearInterval(flush);
          upstream.close();
        });
        client.on("error", () => upstream.close());
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, resolve);
    });
    progress(`serving 1/3: ${url}`);
    if (options.open)
      try {
        await fetch(`http://${options.tv}:8001/api/v2/applications/${browserId}`, {
          method: "POST",
          signal: AbortSignal.timeout(3000),
        });
      } catch {
        progress("Browser REST launch unavailable; trying the paired remote connection");
      }
    const socket = options.open
      ? new WebSocket(
          `wss://${options.tv}:8002/api/v2/channels/samsung.remote.control?name=${Buffer.from("DJ Booth Visuals").toString("base64")}`,
          { rejectUnauthorized: false },
        )
      : undefined;
    socket?.on("message", (raw) => {
      try {
        const message = JSON.parse(String(raw));
        progress(`TV: ${message.event}`);
        if (message.event === "ms.channel.connect") {
          socket.send(
            JSON.stringify({
              method: "ms.channel.emit",
              params: {
                event: "ed.apps.launch",
                to: "host",
                data: { appId: browserId, action_type: "NATIVE_LAUNCH", metaTag: url },
              },
            }),
          );
          progress("opening 2/3: browser launch sent; waiting for the TV renderer");
        }
      } catch {
        progress("TV sent an unrecognized response");
      }
    });
    socket?.on("error", (error) =>
      progress(`TV connection: ${error.message}; open ${url} in the TV browser`),
    );
    const heartbeat = setInterval(() => {
      if (!rendered) progress(`waiting 2/3: accept the TV connection prompt or open ${url}`);
    }, 15000);
    await new Promise<void>((resolve) => {
      const stop = () => {
        clearInterval(heartbeat);
        socket?.close();
        for (const client of sockets.clients) client.close();
        sockets.close();
        server.close();
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return { url, rendered, stopped: true };
  },
});
