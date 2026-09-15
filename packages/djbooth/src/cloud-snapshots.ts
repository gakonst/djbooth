import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const chunkSize = 16 * 1024 * 1024;
type SnapshotFile = { chunks: { hash: string; size: number }[] };
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const temporaryArtifact = (name: string) =>
  name.split("/").includes(".staging") || /\.(lock|part|tmp)$|\.part\.|\.db-(wal|shm)$/.test(name);
async function artifactVersion(path: string): Promise<string> {
  const value = await stat(path, { bigint: true });
  return `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
}

async function transferFiles(names: string[], transfer: (name: string) => Promise<void>) {
  // Bound both memory (four 16 MiB chunks) and outbound requests. Settle every in-flight
  // transfer before allowing the caller to commit a database or start another backup.
  for (let offset = 0; offset < names.length; offset += 4) {
    const results = await Promise.allSettled(names.slice(offset, offset + 4).map(transfer));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}
function validPath(path: string): boolean {
  return (
    path.length <= 900 &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

/** Artifact transport through a private Cloudflare outbound handler, without cloud credentials. */
export class CloudSnapshots {
  private readonly artifactVersions = new Map<string, string>();
  constructor(
    private endpoint: string,
    private signal: AbortSignal,
  ) {}
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(`${this.endpoint}/snapshot/${path}`, {
          ...init,
          redirect: "error",
          signal: AbortSignal.any([this.signal, AbortSignal.timeout(120_000)]),
        });
        if (response.ok || (response.status === 404 && (!init.method || init.method === "HEAD")))
          return response;
        await response.body?.cancel();
        throw new Error(`Snapshot transfer failed (${response.status})`);
      } catch (error) {
        if (attempt >= 2 || this.signal.aborted) throw error;
        await delay(500 * 2 ** attempt, undefined, { signal: this.signal });
      }
    }
  }
  async upload(path: string, name: string): Promise<void> {
    if (!validPath(name)) throw new Error("Invalid snapshot path");
    const file = await open(path, "r");
    const descriptor: SnapshotFile = { chunks: [] };
    try {
      const before = await file.stat();
      for (let start = 0; start < before.size; start += chunkSize) {
        const bytes = Buffer.alloc(Math.min(chunkSize, before.size - start));
        let offset = 0;
        while (offset < bytes.length) {
          const result = await file.read(bytes, offset, bytes.length - offset, start + offset);
          if (!result.bytesRead) throw new Error("Snapshot file changed while reading");
          offset += result.bytesRead;
        }
        const hash = digest(bytes);
        const exists = await this.request(`chunks/${hash}`, { method: "HEAD" });
        if (exists.status === 404)
          await this.request(`chunks/${hash}`, {
            method: "PUT",
            body: bytes,
            headers: { "content-length": String(bytes.length) },
          });
        descriptor.chunks.push({ hash, size: bytes.length });
      }
      const after = await file.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
        throw new Error("Snapshot file changed while reading");
    } finally {
      await file.close();
    }
    const body = JSON.stringify(descriptor);
    await this.request(`files/${encodeURIComponent(name)}`, {
      method: "PUT",
      body,
      headers: { "content-length": String(Buffer.byteLength(body)) },
    });
  }
  async saveArtifacts(root: string, relative = ""): Promise<void> {
    const files: string[] = [];
    const discover = async (directory: string) => {
      for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
        const name = directory ? `${directory}/${entry.name}` : entry.name;
        if (name.startsWith("master.db") || temporaryArtifact(name)) continue;
        if (entry.isDirectory()) await discover(name);
        else if (entry.isFile()) files.push(name);
      }
    };
    await discover(relative);
    await transferFiles(files, async (name) => {
      const path = join(root, name);
      const version = await artifactVersion(path);
      if (this.artifactVersions.get(path) === version) return;
      await this.upload(path, name);
      this.artifactVersions.set(path, version);
    });
  }
  private async restoreFile(root: string, name: string, response?: Response): Promise<void> {
    if (!validPath(name)) throw new Error("Invalid snapshot path");
    response ??= await this.request(`files/${encodeURIComponent(name)}`);
    if (!response.ok) throw new Error("Snapshot file is missing");
    const descriptor = (await response.json()) as SnapshotFile;
    if (!Array.isArray(descriptor.chunks) || descriptor.chunks.length > 4096)
      throw new Error("Invalid snapshot file");
    const path = join(root, name),
      temporary = `${path}.${randomUUID()}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    const file = await open(temporary, "wx");
    try {
      for (const part of descriptor.chunks) {
        if (
          !/^[a-f0-9]{64}$/.test(part.hash) ||
          !Number.isSafeInteger(part.size) ||
          part.size <= 0 ||
          part.size > chunkSize
        )
          throw new Error("Invalid snapshot chunk");
        const result = await this.request(`chunks/${part.hash}`);
        if (!result.ok) throw new Error("Missing snapshot chunk");
        const bytes = new Uint8Array(await result.arrayBuffer());
        if (bytes.length !== part.size || digest(bytes) !== part.hash)
          throw new Error("Snapshot checksum mismatch");
        await file.writeFile(bytes);
      }
      await file.sync();
      await file.close();
      await rename(temporary, path);
      if (name !== "master.db") this.artifactVersions.set(path, await artifactVersion(path));
    } finally {
      await file.close();
      await rm(temporary, { force: true });
    }
  }
  async restore(root: string): Promise<void> {
    const database = await this.request("files/master.db");
    if (database.status === 404) return; // Ignore artifacts from an interrupted first backup.
    const committedDatabase = await database.arrayBuffer();
    let cursor: string | null = null;
    do {
      const page = await this.request(
        `files${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      const result = (await page.json()) as { files: string[]; cursor: string | null };
      await transferFiles(
        result.files.filter((name) => name !== "master.db" && !temporaryArtifact(name)),
        (name) => this.restoreFile(root, name),
      );
      cursor = result.cursor;
    } while (cursor);
    await this.restoreFile(root, "master.db", new Response(committedDatabase));
  }
}
