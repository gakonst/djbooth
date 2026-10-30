import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// The workbench dev server (apps/djbooth) owns the Rekordbox library API.
const workbench = process.env.DJBOOTH_URL ?? "http://127.0.0.1:4179";
const showPath = resolve(import.meta.dirname, "show.json");
const thumbDir = resolve(import.meta.dirname, "thumbs");
const thumbPath = /^\/thumbs\/([a-z0-9-]{1,64})\.jpg$/u;

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 4_000_000) throw new Error("Body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function atomicWrite(path: string, data: Buffer | string) {
  await writeFile(`${path}.tmp`, data);
  await rename(`${path}.tmp`, path);
}

/** Persist the show and its thumbnails as plain files beside this app. */
function showStore(): Plugin {
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://local");
    const send = (status: number, type: string, data: Buffer | string) => {
      response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      response.end(data);
    };
    if (url.pathname === "/show") {
      if (request.method === "GET") {
        try {
          return send(200, "application/json", await readFile(showPath));
        } catch {
          return send(404, "application/json", "null");
        }
      }
      if (request.method === "PUT") {
        const data = await body(request);
        const show = JSON.parse(data.toString("utf8")) as { version?: number };
        if (show?.version !== 1) return send(400, "text/plain", "Unsupported show version");
        await atomicWrite(showPath, JSON.stringify(show, null, 2) + "\n");
        return send(204, "text/plain", "");
      }
    }
    const thumb = thumbPath.exec(url.pathname);
    if (thumb) {
      const path = resolve(thumbDir, `${thumb[1]}.jpg`);
      if (request.method === "GET") {
        try {
          return send(200, "image/jpeg", await readFile(path));
        } catch {
          return send(404, "text/plain", "");
        }
      }
      if (request.method === "PUT") {
        await mkdir(thumbDir, { recursive: true });
        await atomicWrite(path, await body(request));
        return send(204, "text/plain", "");
      }
    }
    send(404, "text/plain", "Not found");
  };
  return {
    name: "party-show-store",
    configureServer(server) {
      server.middlewares.use("/party", (request, response) => {
        handle(request, response).catch((error: unknown) => {
          response.writeHead(500, { "content-type": "text/plain" });
          response.end(String(error));
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), showStore()],
  server: {
    host: "127.0.0.1",
    port: 4185,
    strictPort: true,
    proxy: {
      "/api": workbench,
      "/v1": { target: workbench, ws: true },
    },
  },
});
