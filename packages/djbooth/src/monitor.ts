import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection, type Socket } from "node:net";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

export type MonitorServerOptions = {
  assetDirectory?: string;
  host?: "127.0.0.1" | "localhost" | "::1";
  port?: number;
  stateHost?: string;
  statePort?: number;
};

export type RunningMonitorServer = {
  close(): Promise<void>;
  host: string;
  port: number;
  url: string;
};

/** Serve the built hardware monitor and bridge its HTTP/WebSocket state traffic to djbooth-rs. */
export async function startMonitorServer(
  options: MonitorServerOptions = {},
): Promise<RunningMonitorServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4183;
  const stateHost = options.stateHost ?? "127.0.0.1";
  const statePort = options.statePort ?? 4182;
  const assetDirectory = options.assetDirectory ?? resolveMonitorAssets();
  const connections = new Set<Socket>();
  const server = createServer((incoming, response) => {
    void handleRequest(incoming, response, assetDirectory, stateHost, statePort);
  });
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  server.on("upgrade", (incoming, socket, head) => {
    if (!incoming.url?.startsWith("/v1/")) {
      socket.destroy();
      return;
    }
    const upstream = createConnection({ host: stateHost, port: statePort }, () => {
      const headers = Object.entries(incoming.headers)
        .filter(([name, value]) => name !== "host" && value !== undefined)
        .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(", ") : value}`);
      upstream.write(
        `${incoming.method ?? "GET"} ${incoming.url} HTTP/${incoming.httpVersion}\r\nHost: ${stateHost}:${String(statePort)}\r\n${headers.join("\r\n")}\r\n\r\n`,
      );
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  return {
    close: () => {
      for (const socket of connections) socket.destroy();
      return new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    },
    host,
    port: boundPort,
    url: `http://${host === "::1" ? "[::1]" : host}:${String(boundPort)}/`,
  };
}

function resolveMonitorAssets(): string {
  const candidates = [
    process.env.DJBOOTH_MONITOR_DIR?.trim(),
    fileURLToPath(new URL("../monitor/", import.meta.url)),
    fileURLToPath(new URL("../../../apps/dj-monitor/dist/", import.meta.url)),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const directory = candidates.find((candidate) => existsSync(join(candidate, "index.html")));
  if (directory) return directory;
  throw new Error(
    "DJ monitor assets are missing; run `pnpm --filter @gakonst/dj-monitor build` or set DJBOOTH_MONITOR_DIR",
  );
}

async function handleRequest(
  incoming: IncomingMessage,
  response: ServerResponse,
  assetDirectory: string,
  stateHost: string,
  statePort: number,
): Promise<void> {
  try {
    const pathname = new URL(incoming.url ?? "/", "http://localhost").pathname;
    if (pathname.startsWith("/v1/") || pathname.startsWith("/api/")) {
      proxyHttp(incoming, response, stateHost, statePort);
      return;
    }
    const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    const relative = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
    let path = join(assetDirectory, relative);
    if (!path.startsWith(assetDirectory)) {
      response.writeHead(403).end();
      return;
    }
    if (!(await isFile(path)) && !extname(path)) path = join(assetDirectory, "index.html");
    const body = await readFile(path);
    response.writeHead(200, {
      "cache-control":
        extname(path) === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
      "content-type": contentType(path),
    });
    response.end(body);
  } catch (error) {
    const code = error instanceof Error && "code" in error && error.code === "ENOENT" ? 404 : 500;
    response.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
    response.end(code === 404 ? "Not found\n" : "Monitor server error\n");
  }
}

function proxyHttp(
  incoming: IncomingMessage,
  response: ServerResponse,
  stateHost: string,
  statePort: number,
): void {
  const upstream = request(
    {
      headers: { ...incoming.headers, host: `${stateHost}:${String(statePort)}` },
      host: stateHost,
      method: incoming.method,
      path: incoming.url,
      port: statePort,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
    response.end("DJ Link state API unavailable\n");
  });
  incoming.pipe(upstream);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}
