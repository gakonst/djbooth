import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { snapshots } from "../src/snapshots.js";
import { CloudSnapshots } from "../../../packages/djbooth/src/cloud-snapshots.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(latency = 0) {
  const objects = new Map<string, Uint8Array>();
  let writes = 0;
  let active = 0,
    peak = 0;
  const bucket = {
    async head(key: string) {
      const value = objects.get(key);
      return value ? { size: value.length } : null;
    },
    async get(key: string) {
      const value = objects.get(key);
      return value ? { size: value.length, body: value } : null;
    },
    async put(key: string, value: ArrayBuffer) {
      objects.set(key, new Uint8Array(value));
      writes++;
    },
    async list({ prefix, cursor }: { prefix: string; cursor?: string }) {
      const all = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = Number(cursor ?? 0),
        keys = all.slice(start, start + 2);
      return {
        objects: keys.map((key) => ({ key })),
        truncated: start + 2 < all.length,
        cursor: String(start + 2),
      };
    },
  } as unknown as R2Bucket;
  const server = createServer(async (incoming, outgoing) => {
    active++;
    peak = Math.max(peak, active);
    try {
      if (latency) await delay(latency);
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const response = await snapshots(
        new Request(`http://internal${incoming.url}`, {
          method: incoming.method,
          headers: incoming.headers as Record<string, string>,
          ...(body.length ? { body } : {}),
        }),
        bucket,
        "container-a",
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(500).end();
    } finally {
      active--;
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const root = await mkdtemp(join(tmpdir(), "djbooth-snapshot-"));
  cleanup.push(() => rm(root, { force: true, recursive: true }));
  const port = (server.address() as { port: number }).port;
  return {
    objects,
    bucket,
    root,
    get writes() {
      return writes;
    },
    get peak() {
      return peak;
    },
    storage: new CloudSnapshots(`http://127.0.0.1:${port}`, new AbortController().signal),
  };
}

test("artifact transfers run with bounded concurrency and omit transient downloader files", async () => {
  const f = await fixture(5);
  for (let i = 0; i < 9; i++) await writeFile(join(f.root, `track-${i}.flac`), `audio-${i}`);
  await mkdir(join(f.root, ".staging"));
  await writeFile(join(f.root, ".staging/resume.json"), "temporary");
  await writeFile(join(f.root, "track.flac.part.ytdlp-ts.json"), "temporary");
  await writeFile(join(f.root, "master.db"), "database");
  await f.storage.saveArtifacts(f.root);
  const names = [...f.objects.keys()].filter((key) => key.includes("/files/"));
  expect(names).toHaveLength(9);
  expect(names.every((name) => name.endsWith(".flac"))).toBe(true);
  expect(f.peak).toBeGreaterThan(1);
  expect(f.peak).toBeLessThanOrEqual(4);
  const committed = f.writes;
  await f.storage.saveArtifacts(f.root);
  expect(f.writes).toBe(committed);
  await writeFile(join(f.root, "track-0.flac"), "changed");
  await f.storage.saveArtifacts(f.root);
  expect(f.writes).toBe(committed + 2);
  await f.storage.upload(join(f.root, "master.db"), "master.db");
  const destination = join(f.root, "restored");
  await f.storage.restore(destination);
  for (let i = 0; i < 9; i++)
    expect(await readFile(join(destination, `track-${i}.flac`), "utf8")).toBe(
      i === 0 ? "changed" : `audio-${i}`,
    );
  expect(await readFile(join(destination, "master.db"), "utf8")).toBe("database");
});

test("large artifacts and database restore through the binding with chunk reuse and pagination", async () => {
  const f = await fixture();
  const audio = Buffer.alloc(16 * 1024 * 1024 + 17, 42);
  await writeFile(join(f.root, "audio"), audio);
  await writeFile(join(f.root, "empty"), "");
  await writeFile(join(f.root, "database"), "encrypted database");
  await f.storage.upload(join(f.root, "audio"), "nested/audio.flac");
  const writes = f.writes;
  await f.storage.upload(join(f.root, "audio"), "nested/audio.flac");
  expect(f.writes - writes).toBe(1); // only the descriptor; immutable chunks are reused
  await f.storage.upload(join(f.root, "empty"), "empty");
  await f.storage.upload(join(f.root, "database"), "master.db");
  const restored = join(f.root, "restored");
  await f.storage.restore(restored);
  expect((await readFile(join(restored, "nested/audio.flac"))).equals(audio)).toBe(true);
  expect(await readFile(join(restored, "master.db"), "utf8")).toBe("encrypted database");
  expect((await readFile(join(restored, "empty"))).length).toBe(0);
  expect(
    [...f.objects.keys()].every((key) => key.startsWith("playlist-snapshots/container-a/")),
  ).toBe(true);
});

test("missing committed database ignores a partially uploaded first snapshot", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "xml"), "partial");
  await f.storage.upload(join(f.root, "xml"), "masterPlaylists6.xml");
  await f.storage.restore(join(f.root, "restored"));
  await expect(readFile(join(f.root, "restored/masterPlaylists6.xml"))).rejects.toThrow();
});

test("binding rejects traversal, checksum mismatch, missing chunks and cross-container reads", async () => {
  const f = await fixture();
  const call = (path: string, init?: RequestInit, id = "container-a") =>
    snapshots(new Request(`http://internal/snapshot/${path}`, init), f.bucket, id);
  expect((await call("files/%2e%2e%2fsecret")).status).toBe(400);
  expect(
    (
      await call(`chunks/${"a".repeat(64)}`, {
        method: "PUT",
        body: "bad",
        headers: { "content-length": "3" },
      })
    ).status,
  ).toBe(422);
  const body = JSON.stringify({ chunks: [{ hash: "a".repeat(64), size: 3 }] });
  expect(
    (
      await call("files/master.db", {
        method: "PUT",
        body,
        headers: { "content-length": String(body.length) },
      })
    ).status,
  ).toBe(409);
  await writeFile(join(f.root, "db"), "database");
  await f.storage.upload(join(f.root, "db"), "master.db");
  expect((await call("files/master.db", undefined, "container-b")).status).toBe(404);
});
