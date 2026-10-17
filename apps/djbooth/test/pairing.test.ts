import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket } from "node:tls";

import { MasterDatabase } from "@gakonst/rekordbox";
import { afterEach, expect, it, vi } from "vitest";

import { startLibraryServer, type RunningLibraryServer } from "../src/server/server.js";
import { rotateLibraryPairing, type PairingDescriptor } from "../src/server/pairing.js";

const roots: string[] = [];
const servers: RunningLibraryServer[] = [];
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
// Real 2×1 raster images, not merely matching magic bytes.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGPUSDnBwMAAAAYSAVaUPKqOAAAAAElFTkSuQmCC",
  "base64",
);
const jpeg = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDm6KKKxP0Q/9k=",
  "base64",
);

function mp3WithCover(image: Buffer): Buffer {
  const picture = Buffer.concat([Buffer.from("\0image/jpeg\0\x03\0"), image]);
  const frame = Buffer.alloc(10);
  frame.write("APIC");
  frame.writeUInt32BE(picture.length, 4);
  const tag = Buffer.concat([frame, picture]);
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]);
  for (let index = 0; index < 4; index++)
    header[6 + index] = (tag.length >>> ((3 - index) * 7)) & 0x7f;
  const audioFrame = Buffer.alloc(417);
  audioFrame.writeUInt32BE(0xfffb9000);
  return Buffer.concat([header, tag, audioFrame, audioFrame, audioFrame]);
}

function paddedJpeg(size: number): Buffer {
  const chunks = [jpeg.subarray(0, 2)];
  let remaining = size - jpeg.length;
  while (remaining > 0) {
    let length = Math.min(65_536, remaining);
    if (remaining > length && remaining - length < 4) length -= 4;
    const comment = Buffer.alloc(length);
    comment.writeUInt16BE(0xfffe);
    comment.writeUInt16BE(length - 2, 2);
    chunks.push(comment);
    remaining -= length;
  }
  return Buffer.concat([...chunks, jpeg.subarray(2)]);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function fixture(cover?: "file" | "embedded") {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "djbooth-paired-"));
  roots.push(root);
  vi.stubEnv("DJBOOTH_PAIRING_DIR", join(root, "private"));
  const dbPath = join(root, "library", "master.db");
  const database = MasterDatabase.createManaged(dbPath);
  const audioPath = join(root, "A.mp3");
  const audio = cover === "embedded" ? mp3WithCover(jpeg) : Buffer.alloc(256 * 1024, 0x41);
  const coverPath = join(root, "library", "cover.data");
  const album =
    cover === "file" ? database.addAlbum("Artwork", { imagePath: "cover.data" }) : undefined;
  if (cover === "file") writeFileSync(coverPath, png);
  writeFileSync(audioPath, audio);
  writeFileSync(join(root, "B.mp3"), "other audio");
  const a = database.addContent(audioPath, {
    Title: "A",
    ...(album ? { AlbumID: album.ID } : {}),
    AnalysisDataPath: "/PIONEER/USBANLZ/one/ANLZ0000.DAT",
    Analysed: 105,
  });
  const b = database.addContent(join(root, "B.mp3"), { Title: "B" });
  const folder = database.createPlaylistFolder("Sets");
  const nested = database.createPlaylistFolder("Nested", { parent: folder });
  const playlist = database.createPlaylist("Friday", { parent: nested });
  database.addToPlaylist(playlist, a);
  database.addToPlaylist(playlist, b);
  database.addToPlaylist(playlist, a);
  database.commit();
  const analysisDirectory = join(database.shareDirectory, "PIONEER/USBANLZ/one");
  mkdirSync(analysisDirectory, { recursive: true });
  for (const kind of ["DAT", "EXT", "2EX"])
    writeFileSync(join(analysisDirectory, `ANLZ0000.${kind}`), `analysis ${kind}`);
  database.close();
  const pairingFile = join(root, "pair.json");
  const start = async (path = dbPath, destination = pairingFile) => {
    const server = await startLibraryServer({
      dbPath: path,
      port: 0,
      shareHost: "127.0.0.1",
      sharePort: 0,
      pairingFile: destination,
      assistantEnabled: false,
      hosted: false,
      usbMedia: false,
    });
    servers.push(server);
    return {
      server,
      descriptor: JSON.parse(readFileSync(destination, "utf8")) as PairingDescriptor,
    };
  };
  return {
    root,
    dbPath,
    pairingFile,
    audioPath,
    audio,
    coverPath,
    analysisDirectory,
    a: a.ID,
    b: b.ID,
    folder: folder.ID,
    nested: nested.ID,
    playlist: playlist.ID,
    start,
    ...(await start()),
  };
}

function get(
  pair: PairingDescriptor,
  path: string,
  options: {
    authorization?: string | false;
    headers?: Record<string, string | undefined>;
    method?: string;
    pin?: string;
  } = {},
): Promise<{ status: number; body: Buffer; headers: IncomingHttpHeaders }> {
  return new Promise((done, reject) => {
    const req = request(
      new URL(path, pair.url),
      {
        rejectUnauthorized: false,
        agent: false,
        method: options.method ?? "GET",
        headers: {
          ...(options.authorization === false
            ? {}
            : { authorization: options.authorization ?? `Bearer ${pair.token}` }),
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () =>
          done({
            status: response.statusCode!,
            body: Buffer.concat(chunks),
            headers: response.headers,
          }),
        );
      },
    );
    req.on("socket", (socket) => {
      if (socket instanceof TLSSocket)
        socket.once("secureConnect", () => {
          if (digest(socket.getPeerCertificate().raw) !== (options.pin ?? pair.certificateSHA256))
            req.destroy(new Error("Certificate pin mismatch"));
        });
    });
    req.on("error", reject);
    req.end();
  });
}

it("serves a private TLS-pinned metadata snapshot with nested ordered duplicate memberships and safe refresh", async () => {
  const f = await fixture();
  expect(statSync(f.pairingFile).mode & 0o777).toBe(0o600);
  const privateDirectory = join(f.root, "private", digest(realpathSync(f.dbPath)));
  expect(statSync(privateDirectory).mode & 0o777).toBe(0o700);
  expect(statSync(join(privateDirectory, "credentials.json")).mode & 0o777).toBe(0o600);
  expect(Object.keys(f.descriptor).sort()).toEqual([
    "certificateSHA256",
    "libraryID",
    "name",
    "token",
    "url",
    "version",
  ]);
  expect(/^[a-f0-9]{64}$/u.test(f.descriptor.token)).toBe(true);
  expect(f.descriptor.url.startsWith("https://127.0.0.1:")).toBe(true);
  const response = await get(f.descriptor, "/pair/v1/catalog");
  expect(response.status).toBe(200);
  const snapshot = JSON.parse(response.body.toString());
  expect(snapshot).toMatchObject({ libraryID: f.descriptor.libraryID, name: "Mac library" });
  expect(snapshot.playlists).toHaveLength(3);
  expect(snapshot.playlists).toEqual(
    expect.arrayContaining([
      { id: f.folder, name: "Sets", parentId: "root", type: "folder", seq: 1, trackIDs: [] },
      { id: f.nested, name: "Nested", parentId: f.folder, type: "folder", seq: 1, trackIDs: [] },
      {
        id: f.playlist,
        name: "Friday",
        parentId: f.nested,
        type: "playlist",
        seq: 1,
        trackIDs: [f.a, f.b, f.a],
      },
    ]),
  );
  expect(snapshot.tracks.map((track: { title: string }) => track.title)).toEqual(["A", "B"]);
  expect(snapshot.tracks[0]).toMatchObject({
    id: f.a,
    fileExists: true,
    analyzed: true,
    artworkAvailable: false,
    sourceRevision: expect.any(String),
  });
  expect(snapshot.tracks[1]).toMatchObject({ id: f.b, analyzed: false });
  expect(snapshot.tracks[0]).not.toHaveProperty("mediaHash");
  for (const forbidden of [f.root, f.descriptor.token, "FolderPath", '"path"', '"analysisPath"'])
    expect(response.body.includes(forbidden)).toBe(false);
  expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  expect(response.headers["set-cookie"]).toBeUndefined();
  await expect(get(f.descriptor, "/pair/v1/catalog", { pin: "0".repeat(64) })).rejects.toThrow(
    "Certificate pin mismatch",
  );
  await expect(
    fetch(`${f.descriptor.url.replace("https:", "http:")}/pair/v1/catalog`),
  ).rejects.toThrow();

  const writer = new MasterDatabase({ path: f.dbPath, readonly: false });
  writer.renamePlaylist(f.playlist, "Renamed");
  writer.addToPlaylist(f.playlist, f.b);
  writer.connection!.prepare("UPDATE djmdContent SET Title = ? WHERE ID = ?").run("Changed A", f.a);
  writer.commit();
  writer.close();
  const refreshed = JSON.parse((await get(f.descriptor, "/pair/v1/catalog")).body.toString());
  expect(refreshed.playlists.find((item: { id: string }) => item.id === f.playlist)).toMatchObject({
    name: "Renamed",
    trackIDs: [f.a, f.b, f.a, f.b],
  });
  const updated = refreshed.tracks.find((item: { id: string }) => item.id === f.a);
  expect(updated.title).toBe("Changed A");
  expect(updated.sourceRevision).not.toBe(snapshot.tracks[0].sourceRevision);
  const removed = new MasterDatabase({ path: f.dbPath, readonly: false });
  removed.connection!.prepare("UPDATE djmdContent SET rb_local_deleted = 1 WHERE ID = ?").run(f.b);
  removed.close();
  const afterRemoval = JSON.parse((await get(f.descriptor, "/pair/v1/catalog")).body.toString());
  expect(afterRemoval.tracks.map((item: { id: string }) => item.id)).toEqual([f.a]);
  expect(
    afterRemoval.playlists.find((item: { id: string }) => item.id === f.playlist).trackIDs,
  ).toEqual([f.a, f.a]);
});

it("exports library addition times in UTC without invalidating audio, omitting unknown dates", async () => {
  const f = await fixture();
  const original = JSON.parse(
    (await get(f.descriptor, `/pair/v1/tracks/${f.a}`)).body.toString(),
  ).track;
  const writer = new MasterDatabase({ path: f.dbPath, readonly: false });
  try {
    // Both were added on the same day; retain within-day chronology and normalize offsets.
    writer
      .connection!.prepare("UPDATE djmdContent SET created_at = ? WHERE ID = ?")
      .run("2026-10-17 08:15:02.123 -04:00", f.a);
    writer
      .connection!.prepare("UPDATE djmdContent SET created_at = ? WHERE ID = ?")
      .run("2026-10-17 13:15:02.456 +00:00", f.b);
    writer.commit();
    const snapshot = JSON.parse((await get(f.descriptor, "/pair/v1/catalog")).body.toString());
    expect(snapshot.tracks.map((track: { addedAt: string }) => track.addedAt)).toEqual([
      "2026-10-17T12:15:02.123Z",
      "2026-10-17T13:15:02.456Z",
    ]);
    const detail = JSON.parse(
      (await get(f.descriptor, `/pair/v1/tracks/${f.a}`)).body.toString(),
    ).track;
    expect(detail.addedAt).toBe("2026-10-17T12:15:02.123Z");
    expect(detail.sourceRevision).toBe(original.sourceRevision);
    expect(detail.mediaHash).toBe(original.mediaHash);
    expect(snapshot.tracks[0].sourceRevision).toBe(original.sourceRevision);

    writer
      .connection!.prepare("UPDATE djmdContent SET updated_at = ? WHERE ID = ?")
      .run("2026-10-18 17:00:00.000 +00:00", f.a);
    writer.connection!.prepare("UPDATE djmdContent SET created_at = ? WHERE ID = ?").run(null, f.b);
    writer.commit();
    const response = await get(f.descriptor, "/pair/v1/catalog");
    expect(response.status, response.body.toString()).toBe(200);
    const refreshed = JSON.parse(response.body.toString());
    expect(refreshed.tracks[0].addedAt).toBe("2026-10-17T12:15:02.123Z");
    expect(refreshed.tracks[1]).not.toHaveProperty("addedAt");
    const unknown = JSON.parse(
      (await get(f.descriptor, `/pair/v1/tracks/${f.b}`)).body.toString(),
    ).track;
    expect(unknown).not.toHaveProperty("addedAt");
  } finally {
    writer.close();
  }
});

it("requires bearer auth on every route, rejects browser/mutation requests and exposes no loopback routes", async () => {
  const f = await fixture();
  for (const path of [
    "/pair/v1/catalog",
    `/pair/v1/tracks/${f.a}`,
    `/pair/v1/tracks/${f.a}/audio?hash=${digest(f.audio)}`,
    `/pair/v1/tracks/${f.a}/artwork?hash=${digest(png)}`,
    ...["dat", "ext", "twoEx"].map(
      (kind) => `/pair/v1/tracks/${f.a}/analysis/${kind}?hash=${"0".repeat(64)}`,
    ),
    "/api/bootstrap",
    "/v1/state",
    "/responses",
    "/",
  ]) {
    for (const authorization of [false, "Bearer invalid", `Bearer ${"0".repeat(64)}`] as const) {
      const denied = await get(f.descriptor, path, { authorization });
      expect(denied.status).toBe(401);
      expect(denied.body.includes(f.root)).toBe(false);
      expect(denied.body.includes(f.descriptor.token)).toBe(false);
    }
  }
  for (const headers of [
    { origin: "https://attacker.invalid" },
    { referer: "https://attacker.invalid/" },
    { "sec-fetch-site": "none" },
    { cookie: "session=anything" },
  ])
    expect((await get(f.descriptor, "/pair/v1/catalog", { headers })).status).toBe(403);
  expect((await get(f.descriptor, "/pair/v1/catalog", { method: "POST" })).status).toBe(405);
  expect(
    (await get(f.descriptor, "/pair/v1/catalog", { headers: { "content-length": "1" } })).status,
  ).toBe(413);
  for (const path of [
    "/api/bootstrap",
    "/v1/state",
    "/responses",
    "/pair/v1/tracks/%2Fetc%2Fpasswd/audio",
    "/pair/v1/tracks/%2Fetc%2Fpasswd/artwork?hash=" + digest(png),
    "/pair/v1/tracks/missing",
  ])
    expect((await get(f.descriptor, path)).status).toBe(404);
});

it("lazily hashes and streams immutable audio/analysis, rejects stale media bindings and symlinks", async () => {
  const f = await fixture();
  const detail = JSON.parse(
    (await get(f.descriptor, `/pair/v1/tracks/${f.a}`)).body.toString(),
  ).track;
  expect(detail).toMatchObject({
    mediaHash: digest(f.audio),
    mediaExtension: "mp3",
    analysis: {
      mediaHash: digest(f.audio),
      dat: digest("analysis DAT"),
      ext: digest("analysis EXT"),
      twoEx: digest("analysis 2EX"),
    },
  });
  const audioRoute = `/pair/v1/tracks/${f.a}/audio?hash=${detail.mediaHash}`;
  const downloaded = await get(f.descriptor, audioRoute);
  expect(downloaded.status).toBe(200);
  expect(downloaded.body.equals(f.audio)).toBe(true);
  for (const [kind, extension] of [
    ["dat", "DAT"],
    ["ext", "EXT"],
    ["twoEx", "2EX"],
  ]) {
    const response = await get(
      f.descriptor,
      `/pair/v1/tracks/${f.a}/analysis/${kind}?hash=${detail.analysis[kind!]}&mediaHash=${detail.mediaHash}`,
    );
    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe(`analysis ${extension}`);
  }
  const analysisRoute = `/pair/v1/tracks/${f.a}/analysis/dat?hash=${detail.analysis.dat}&mediaHash=${detail.mediaHash}`;
  expect(
    (await get(f.descriptor, `/pair/v1/tracks/${f.a}/analysis/dat?hash=${detail.analysis.dat}`))
      .status,
  ).toBe(400);
  writeFileSync(f.audioPath, "replacement audio");
  expect((await get(f.descriptor, audioRoute)).status).toBe(409);
  expect((await get(f.descriptor, analysisRoute)).status).toBe(409);
  const changed = JSON.parse(
    (await get(f.descriptor, `/pair/v1/tracks/${f.a}`)).body.toString(),
  ).track;
  expect(changed.mediaHash).toBe(digest("replacement audio"));
  expect(changed.sourceRevision).not.toBe(detail.sourceRevision);
  writeFileSync(join(f.analysisDirectory, "ANLZ0000.DAT"), "new analysis");
  expect(
    (
      await get(
        f.descriptor,
        `/pair/v1/tracks/${f.a}/analysis/dat?hash=${detail.analysis.dat}&mediaHash=${changed.mediaHash}`,
      )
    ).status,
  ).toBe(409);
  const updated = JSON.parse(
    (await get(f.descriptor, `/pair/v1/tracks/${f.a}`)).body.toString(),
  ).track;
  expect(updated.sourceRevision).not.toBe(changed.sourceRevision);
  rmSync(join(f.analysisDirectory, "ANLZ0000.2EX"));
  const incomplete = JSON.parse(
    (await get(f.descriptor, `/pair/v1/tracks/${f.a}`)).body.toString(),
  ).track;
  expect(incomplete.analysis).toBeUndefined();
  expect(incomplete.analyzed).toBe(false);
  rmSync(f.audioPath);
  symlinkSync(join(f.root, "B.mp3"), f.audioPath);
  expect((await get(f.descriptor, `/pair/v1/tracks/${f.a}`)).status).toBe(404);
  const catalog = JSON.parse((await get(f.descriptor, "/pair/v1/catalog")).body.toString());
  expect(catalog.tracks.find((item: { id: string }) => item.id === f.a).fileExists).toBe(false);
});

it("serves hash-bound artwork bytes without invalidating audio when an external cover changes", async () => {
  const f = await fixture("file");
  const catalog = JSON.parse((await get(f.descriptor, "/pair/v1/catalog")).body.toString());
  const row = catalog.tracks.find((track: { id: string }) => track.id === f.a);
  expect(row.artworkAvailable).toBe(true);
  expect(row.artworkHash).toBeUndefined();
  const detailResponse = await get(f.descriptor, `/pair/v1/tracks/${f.a}`);
  expect(detailResponse.status).toBe(200);
  const detail = JSON.parse(detailResponse.body.toString()).track;
  expect(detail.artworkHash).toBe(digest(png));
  expect(detail.artworkAvailable).toBe(true);
  const route = `/pair/v1/tracks/${f.a}/artwork?hash=${detail.artworkHash}`;
  const image = await get(f.descriptor, route);
  expect(image.status).toBe(200);
  expect(image.headers["content-type"]).toBe("image/png");
  expect(image.body).toEqual(png);
  expect(image.headers["access-control-allow-origin"]).toBeUndefined();
  expect(image.headers["set-cookie"]).toBeUndefined();
  expect(
    (await get(f.descriptor, route, { headers: { origin: "https://example.com" } })).status,
  ).toBe(403);
  expect((await get(f.descriptor, route, { method: "POST" })).status).toBe(405);
  expect((await get(f.descriptor, `/pair/v1/tracks/${f.a}/artwork`)).status).toBe(400);
  expect((await get(f.descriptor, `${route}&path=/etc/passwd`)).body).toEqual(png);
  for (const forbidden of [f.root, f.descriptor.token, "artworkPath", '"path"'])
    expect(detailResponse.body.includes(forbidden)).toBe(false);

  writeFileSync(f.coverPath, jpeg);
  const stale = await get(f.descriptor, route);
  expect(stale.status).toBe(409);
  expect(stale.body.includes(f.root)).toBe(false);
  const updated = JSON.parse(
    (await get(f.descriptor, `/pair/v1/tracks/${f.a}`)).body.toString(),
  ).track;
  expect(updated.artworkHash).toBe(digest(jpeg));
  expect(updated.sourceRevision).toBe(detail.sourceRevision);
  expect(updated.mediaHash).toBe(detail.mediaHash);
  expect(updated.analysis).toEqual(detail.analysis);
  const replacement = await get(
    f.descriptor,
    `/pair/v1/tracks/${f.a}/artwork?hash=${updated.artworkHash}`,
  );
  expect(replacement.status).toBe(200);
  expect(replacement.headers["content-type"]).toBe("image/jpeg");
  expect(replacement.body).toEqual(jpeg);

  const moved = join(f.root, "new-cover.png");
  writeFileSync(moved, png);
  const writer = new MasterDatabase({ path: f.dbPath, readonly: false });
  const setCover = (path: string) =>
    writer
      .connection!.prepare(
        "UPDATE djmdAlbum SET ImagePath = ? WHERE ID = (SELECT AlbumID FROM djmdContent WHERE ID = ?)",
      )
      .run(path, f.a);
  setCover(moved);
  expect(
    (await get(f.descriptor, `/pair/v1/tracks/${f.a}/artwork?hash=${digest(jpeg)}`)).status,
  ).toBe(409);
  const remapped = JSON.parse(
    (await get(f.descriptor, `/pair/v1/tracks/${f.a}`)).body.toString(),
  ).track;
  expect(remapped.artworkHash).toBe(digest(png));
  expect(remapped.sourceRevision).toBe(detail.sourceRevision);
  setCover("cover.data");
  writer.close();

  const atLimit = paddedJpeg(5 * 1024 * 1024);
  writeFileSync(f.coverPath, atLimit);
  const bounded = JSON.parse(
    (await get(f.descriptor, `/pair/v1/tracks/${f.a}`)).body.toString(),
  ).track;
  expect(bounded.artworkHash).toBe(digest(atLimit));
  expect(
    (
      await get(f.descriptor, `/pair/v1/tracks/${f.a}/artwork?hash=${bounded.artworkHash}`)
    ).body.equals(atLimit),
  ).toBe(true);
  for (const bytes of [
    Buffer.from("<svg>not a cover</svg>"),
    png.subarray(0, 40),
    paddedJpeg(5 * 1024 * 1024 + 1),
  ]) {
    writeFileSync(f.coverPath, bytes);
    const unavailable = await get(f.descriptor, `/pair/v1/tracks/${f.a}`);
    expect(unavailable.status).toBe(200);
    expect(JSON.parse(unavailable.body.toString()).track).toMatchObject({
      artworkAvailable: false,
      mediaHash: detail.mediaHash,
    });
    expect(JSON.parse(unavailable.body.toString()).track.artworkHash).toBeUndefined();
    expect((await get(f.descriptor, route)).status).toBe(404);
  }
  rmSync(f.coverPath);
  const other = join(f.root, "other.png");
  writeFileSync(other, png);
  symlinkSync(other, f.coverPath);
  expect((await get(f.descriptor, route)).status).toBe(404);
  rmSync(f.coverPath);
  const missing = JSON.parse(
    (await get(f.descriptor, `/pair/v1/tracks/${f.a}`)).body.toString(),
  ).track;
  expect(missing.artworkHash).toBeUndefined();
  expect(missing.sourceRevision).toBe(detail.sourceRevision);
  expect(
    (await get(f.descriptor, `/pair/v1/tracks/${f.a}/audio?hash=${detail.mediaHash}`)).body,
  ).toEqual(f.audio);
});

it("discovers embedded covers only on demand and keeps missing artwork non-fatal", async () => {
  const f = await fixture("embedded");
  const catalog = JSON.parse((await get(f.descriptor, "/pair/v1/catalog")).body.toString());
  expect(catalog.tracks.find((track: { id: string }) => track.id === f.a).artworkAvailable).toBe(
    false,
  );
  const detail = await get(f.descriptor, `/pair/v1/tracks/${f.a}`);
  expect(detail.status).toBe(200);
  const track = JSON.parse(detail.body.toString()).track;
  expect(track.artworkHash).toBe(digest(jpeg));
  expect(track.artworkAvailable).toBe(true);
  const route = `/pair/v1/tracks/${f.a}/artwork?hash=${track.artworkHash}`;
  const image = await get(f.descriptor, route);
  expect(image.status).toBe(200);
  expect(image.headers["content-type"]).toBe("image/jpeg");
  expect(image.body).toEqual(jpeg);
  // MIME comes from bytes, not the deliberately unchanged JPEG label in this APIC frame.
  writeFileSync(f.audioPath, mp3WithCover(png));
  expect((await get(f.descriptor, route)).status).toBe(409);
  const changed = JSON.parse(
    (await get(f.descriptor, `/pair/v1/tracks/${f.a}`)).body.toString(),
  ).track;
  expect(changed.artworkHash).toBe(digest(png));
  expect(changed.mediaHash).not.toBe(track.mediaHash);
  expect(changed.sourceRevision).not.toBe(track.sourceRevision);
  writeFileSync(f.audioPath, mp3WithCover(paddedJpeg(5 * 1024 * 1024 + 1)));
  const oversized = await get(f.descriptor, `/pair/v1/tracks/${f.a}`);
  expect(oversized.status).toBe(200);
  expect(JSON.parse(oversized.body.toString()).track.artworkHash).toBeUndefined();
  expect((await get(f.descriptor, route)).status).toBe(404);
  const missing = await get(f.descriptor, `/pair/v1/tracks/${f.b}`);
  expect(missing.status).toBe(200);
  expect(JSON.parse(missing.body.toString()).track.artworkHash).toBeUndefined();
  expect(
    (await get(f.descriptor, `/pair/v1/tracks/${f.b}/artwork?hash=${digest(jpeg)}`)).status,
  ).toBe(404);
  rmSync(f.audioPath);
  const alternate = join(f.root, "embedded.mp3");
  writeFileSync(alternate, mp3WithCover(jpeg));
  symlinkSync(alternate, f.audioPath);
  expect((await get(f.descriptor, route)).status).toBe(404);
});

it("revokes live bearers without restart and preserves distinct library identity across restarts", async () => {
  const f = await fixture();
  expect(await rotateLibraryPairing(f.dbPath)).toEqual({ pairingFile: f.pairingFile });
  const rotated = JSON.parse(readFileSync(f.pairingFile, "utf8")) as PairingDescriptor;
  expect(rotated.token === f.descriptor.token).toBe(false);
  expect(rotated.libraryID).toBe(f.descriptor.libraryID);
  expect((await get(f.descriptor, "/pair/v1/catalog")).status).toBe(401);
  expect((await get(rotated, "/pair/v1/catalog")).status).toBe(200);
  await f.server.close();
  servers.splice(servers.indexOf(f.server), 1);
  await expect(get(rotated, "/pair/v1/catalog")).rejects.toThrow();
  const restarted = await f.start();
  expect(restarted.descriptor.libraryID).toBe(rotated.libraryID);
  expect(restarted.descriptor.token === rotated.token).toBe(true);
  expect(restarted.descriptor.certificateSHA256).toBe(rotated.certificateSHA256);
  const otherPath = join(f.root, "other", "master.db");
  MasterDatabase.createManaged(otherPath).close();
  const other = await f.start(otherPath, join(f.root, "other.json"));
  expect(other.descriptor.libraryID).not.toBe(rotated.libraryID);
  expect(
    (await get(other.descriptor, "/pair/v1/catalog", { authorization: `Bearer ${rotated.token}` }))
      .status,
  ).toBe(401);
});

it("refuses unrelated descriptor destinations and wildcard sharing without disturbing the active listener", async () => {
  const f = await fixture();
  const unrelated = join(f.root, "keep.txt");
  writeFileSync(unrelated, "preserve this file");
  await expect(f.start(f.dbPath, unrelated)).rejects.toThrow("Refusing to overwrite");
  expect(readFileSync(unrelated, "utf8")).toBe("preserve this file");
  await expect(
    startLibraryServer({
      dbPath: f.dbPath,
      port: 0,
      shareHost: "0.0.0.0",
      pairingFile: f.pairingFile,
      assistantEnabled: false,
      hosted: false,
      usbMedia: false,
    }),
  ).rejects.toThrow("specific local IPv4");
  expect((await get(f.descriptor, "/pair/v1/catalog")).status).toBe(200);
});
