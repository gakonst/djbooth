import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const appDirectory = dirname(fileURLToPath(import.meta.url));
const defaultAudioDirectory = join(
  homedir(),
  "Music",
  "rekordbox-stems-demo",
  "London Grammar - Sights (Dennis Ferrer Remix) - 45s excerpt",
);

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const audioDirectory = resolve(valueAfter("--audio-dir") ?? defaultAudioDirectory);
const port = Number.parseInt(valueAfter("--port") ?? "4178", 10);
const shouldOpen = !args.includes("--no-open");

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new TypeError(`Invalid --port: ${String(valueAfter("--port"))}`);
}

const tracks = [
  { id: "mixture", file: "mixture.wav", label: "Original mix", role: "reference" },
  { id: "vocals", file: "vocals.wav", label: "Vocals", role: "stem" },
  { id: "drums", file: "drums.wav", label: "Drums", role: "stem" },
  { id: "bass", file: "bass.wav", label: "Bass", role: "stem" },
  { id: "other", file: "other.wav", label: "Other", role: "stem" },
];

const missing = tracks.filter(({ file }) => !existsSync(join(audioDirectory, file)));
if (missing.length > 0) {
  throw new Error(
    `Missing ${missing.map(({ file }) => file).join(", ")} in ${audioDirectory}. ` +
      "Pass --audio-dir with a complete stem directory.",
  );
}

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

function sendFile(request, response, path) {
  const { size } = statSync(path);
  const range = request.headers.range;
  const headers = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Type": mimeTypes[extname(path)] ?? "application/octet-stream",
  };

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      response.writeHead(416, { "Content-Range": `bytes */${size}` });
      response.end();
      return;
    }
    const start = match[1] === "" ? 0 : Number.parseInt(match[1], 10);
    const end = match[2] === "" ? size - 1 : Number.parseInt(match[2], 10);
    if (start < 0 || end < start || start >= size || end >= size) {
      response.writeHead(416, { "Content-Range": `bytes */${size}` });
      response.end();
      return;
    }
    response.writeHead(206, {
      ...headers,
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${size}`,
    });
    createReadStream(path, { start, end }).pipe(response);
    return;
  }

  response.writeHead(200, { ...headers, "Content-Length": size });
  createReadStream(path).pipe(response);
}

const staticFiles = new Map([
  ["/", "index.html"],
  ["/app.js", "app.js"],
  ["/styles.css", "styles.css"],
]);

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  response.setHeader("X-Content-Type-Options", "nosniff");

  if (url.pathname === "/manifest.json") {
    const body = JSON.stringify({
      audioDirectory,
      backend: "Mel-Band-RoFormer · MLX",
      excerpt: "1:15–2:00",
      title: "London Grammar — Sights (Dennis Ferrer Remix)",
      tracks: tracks.map(({ file, ...track }) => ({ ...track, url: `/audio/${file}` })),
    });
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(body),
      "Content-Type": "application/json; charset=utf-8",
    });
    response.end(body);
    return;
  }

  const audio = tracks.find(({ file }) => url.pathname === `/audio/${file}`);
  if (audio) {
    sendFile(request, response, join(audioDirectory, audio.file));
    return;
  }

  const staticFile = staticFiles.get(url.pathname);
  if (staticFile) {
    sendFile(request, response, join(appDirectory, staticFile));
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found\n");
});

server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}`;
  process.stdout.write(`Stems UI: ${url}\nAudio: ${audioDirectory}\n`);
  if (shouldOpen) {
    const opener = spawn("open", [url], { detached: true, stdio: "ignore" });
    opener.unref();
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
