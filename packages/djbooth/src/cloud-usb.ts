import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncLegacyDevicePlaylist } from "@gakonst/rekordbox/devicelib";

type Call = (path: string, init?: RequestInit, timeout?: number) => Promise<Response>;

/** Generate both real device catalogs before exposing a downloadable archive. */
export async function publishUsbExport(options: {
  playlistId: string;
  collectionId: string;
  trackIDs: string[];
  databasePath?: string;
  call: Call;
  progress: (phase: string, current: number, total: number) => void;
}) {
  const { call, progress } = options;
  const checked = async (response: Response) => {
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`USB export cloud request failed (${response.status})`);
    }
    return response;
  };
  const root = await mkdtemp(join(tmpdir(), "djbooth-usb-"));
  try {
    const mediaRoot = join(root, "media");
    await mkdir(mediaRoot);
    progress("usb-export", 0, 1);
    const result = await syncLegacyDevicePlaylist({
      targetDirectory: mediaRoot,
      playlistId: options.playlistId,
      ...(options.databasePath ? { databasePath: options.databasePath } : {}),
      fresh: true,
    });
    if (result.tracks !== options.trackIDs.length)
      throw new Error("Playlist changed during USB export; rerun cloud publish");
    for (const name of ["export.pdb", "exportLibrary.db"]) {
      const catalog = await stat(join(mediaRoot, "PIONEER", "rekordbox", name));
      if (!catalog.isFile() || catalog.size === 0) throw new Error(`USB export is missing ${name}`);
    }
    if (result.analysisFiles !== result.tracks * 3)
      throw new Error("USB export requires DAT, EXT, and 2EX analysis for every track");
    const archive = join(root, "usb.zip");
    progress("usb-archive", 0, 1);
    await new Promise<void>((resolve, reject) => {
      const child = spawn("zip", ["-0", "-q", "-r", archive, "Contents", "PIONEER"], {
        cwd: mediaRoot,
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error("USB archive creation failed; install zip")),
      );
    });
    progress("usb-verify", 0, 1);
    await new Promise<void>((resolve, reject) => {
      const child = spawn("zip", ["-T", archive], { stdio: "ignore" });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error("USB ZIP integrity verification failed")),
      );
    });
    const bytes = (await stat(archive)).size;
    if (bytes > 4 * 1024 ** 3) throw new Error("USB archives are limited to 4 GiB");
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(archive)) digest.update(chunk);
    const hash = digest.digest("hex");
    const existing = await call(`/v1/media/${hash}`, { method: "HEAD" });
    if (existing.status === 404) {
      const file = await open(archive, "r");
      const chunks: { hash: string; size: number }[] = [];
      const chunkSize = 16 * 1024 ** 2;
      try {
        for (let offset = 0; offset < bytes; offset += chunkSize) {
          const size = Math.min(chunkSize, bytes - offset);
          const buffer = Buffer.alloc(size);
          let read = 0;
          while (read < size) {
            const part = await file.read(buffer, read, size - read, offset + read);
            if (!part.bytesRead) throw new Error("USB archive was truncated");
            read += part.bytesRead;
          }
          const chunkHash = createHash("sha256").update(buffer).digest("hex");
          const head = await call(`/v1/media/${chunkHash}`, { method: "HEAD" });
          if (head.status === 404) {
            const uploaded = await checked(
              await call(
                `/v1/media/${chunkHash}`,
                {
                  method: "PUT",
                  body: buffer,
                  headers: {
                    "content-type": "application/octet-stream",
                    "content-length": String(size),
                  },
                },
                600_000,
              ),
            );
            await uploaded.body?.cancel();
          } else {
            await checked(head);
            await head.body?.cancel();
          }
          chunks.push({ hash: chunkHash, size });
          progress("usb-upload", chunks.length, Math.ceil(bytes / chunkSize));
        }
      } finally {
        await file.close();
      }
      const composed = await checked(
        await call(
          `/v1/media/${hash}/compose`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chunks }),
          },
          600_000,
        ),
      );
      await composed.body?.cancel();
    } else {
      await checked(existing);
      await existing.body?.cancel();
    }
    const response = await checked(
      await call(`/v1/usb/export?playlist=${encodeURIComponent(options.collectionId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hash, trackIDs: options.trackIDs }),
      }),
    );
    await response.body?.cancel();
    progress("usb-complete", 1, 1);
    return { collectionID: options.collectionId, hash, bytes, tracks: result.tracks };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
