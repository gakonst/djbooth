import { execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual, X509Certificate } from "node:crypto";
import { constants, lstatSync, realpathSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { createServer } from "node:https";
import type { ServerResponse } from "node:http";
import { isIPv4 } from "node:net";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { Transform, type Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import { parseStream, selectCover } from "music-metadata";

import type { TrackDetail } from "../shared/types.js";
import { RekordboxLibraryService } from "./library.js";

const execFileAsync = promisify(execFile);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const name = "Mac library";
const kinds = { dat: "DAT", ext: "EXT", twoEx: "2EX" } as const;
const hashPattern = /^[a-f0-9]{64}$/u;
const maxJsonBytes = 32 * 1024 * 1024;
const maxArtworkBytes = 5 * 1024 * 1024;
const maxArtworkScanBytes = 32 * 1024 * 1024;

export type PairingDescriptor = {
  version: 1;
  url: string;
  certificateSHA256: string;
  token: string;
  libraryID: string;
  name: string;
};

type Credentials = {
  version: 1;
  databasePath: string;
  libraryID: string;
  token: string;
  certificate: string;
  privateKey: string;
  host: string;
  descriptor?: { path: string; url: string };
};

function credentialPath(databasePath: string): string {
  return join(
    process.env.DJBOOTH_PAIRING_DIR || join(homedir(), ".config", "djbooth", "pairing"),
    hash(databasePath),
    "credentials.json",
  );
}

async function readCredentials(path: string): Promise<Credentials> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size > 32_768)
    throw new Error("Invalid private pairing configuration");
  let value: Credentials;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as Credentials;
  } catch {
    throw new Error("Invalid private pairing configuration");
  }
  if (
    !value ||
    value.version !== 1 ||
    !hashPattern.test(value.token) ||
    !hashPattern.test(value.libraryID) ||
    typeof value.databasePath !== "string" ||
    typeof value.certificate !== "string" ||
    typeof value.privateKey !== "string"
  )
    throw new Error("Invalid private pairing configuration");
  return value;
}

async function privateWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error("Pairing files cannot be symlinks");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function withCredentials<T>(
  databasePath: string,
  action: (path: string) => Promise<T>,
): Promise<T> {
  const path = credentialPath(databasePath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if ((await realpath(dirname(path))) !== resolve(dirname(path)))
    throw new Error("Pairing configuration cannot contain symlinks");
  await chmod(dirname(path), 0o700);
  const lock = `${path}.lock`;
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw new Error("Pairing configuration is busy; retry after the current operation completes");
  }
  try {
    return await action(path);
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

function descriptor(credentials: Credentials, url: string): PairingDescriptor {
  return {
    version: 1,
    url,
    certificateSHA256: hash(new X509Certificate(credentials.certificate).raw),
    token: credentials.token,
    libraryID: credentials.libraryID,
    name,
  };
}

/** Revoke the previous bearer without restarting the library or DJ Link. */
export async function rotateLibraryPairing(
  databasePath: string,
): Promise<{ pairingFile: string | null }> {
  const canonical = await realpath(databasePath);
  return withCredentials(canonical, async (path) => {
    const credentials = await readCredentials(path);
    if (credentials.databasePath !== canonical) throw new Error("Pairing database does not match");
    credentials.token = randomBytes(32).toString("hex");
    // Revoke first: a descriptor-write failure must never leave the old bearer valid.
    await privateWrite(path, credentials);
    if (credentials.descriptor)
      await privateWrite(
        credentials.descriptor.path,
        descriptor(credentials, credentials.descriptor.url),
      );
    return { pairingFile: credentials.descriptor?.path ?? null };
  });
}

async function provision(databasePath: string, host: string): Promise<Credentials> {
  return withCredentials(databasePath, async (path) => {
    let saved: Credentials | undefined;
    try {
      saved = await readCredentials(path);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (saved && saved.databasePath !== databasePath)
      throw new Error("Pairing database does not match");
    if (saved?.host === host) return saved;
    const temporary = await mkdtemp(join(dirname(path), ".certificate-"));
    try {
      await execFileAsync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-sha256",
          "-days",
          "3650",
          "-subj",
          "/CN=DJBooth paired library",
          "-addext",
          `subjectAltName=IP:${host}`,
          "-keyout",
          join(temporary, "key.pem"),
          "-out",
          join(temporary, "cert.pem"),
        ],
        { timeout: 30_000, maxBuffer: 64 * 1024 },
      );
      const credentials: Credentials = {
        version: 1,
        databasePath,
        host,
        libraryID: saved?.libraryID ?? randomBytes(32).toString("hex"),
        token: saved?.token ?? randomBytes(32).toString("hex"),
        certificate: await readFile(join(temporary, "cert.pem"), "utf8"),
        privateKey: await readFile(join(temporary, "key.pem"), "utf8"),
      };
      await privateWrite(path, credentials);
      return credentials;
    } catch {
      throw new Error("Unable to create private pairing credentials");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
}

class PairError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function fileIdentity(path: string | undefined): string | null {
  if (!path) return null;
  try {
    const requested = resolve(path);
    const info = lstatSync(requested, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || realpathSync(requested) !== requested)
      return null;
    return `${requested}:${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch {
    return null;
  }
}

function analysisPaths(
  library: RekordboxLibraryService,
  id: string,
): Partial<Record<"DAT" | "EXT" | "2EX", string>> {
  try {
    return library.getAnalysisPaths(id);
  } catch {
    return {};
  } // Missing analysis is a normal library readiness state.
}

function artworkSource(library: RekordboxLibraryService, id: string) {
  try {
    return library.getArtworkSource(id);
  } catch {
    return undefined;
  }
}

/** Only raster image bytes cross the paired boundary, never a path or declared MIME alone. */
function artworkContentType(data: Buffer): string | undefined {
  if (!data.length || data.length > maxArtworkBytes) return undefined;
  if (
    data.length >= 45 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    data.readUInt32BE(8) === 13 &&
    data.toString("ascii", 12, 16) === "IHDR" &&
    data.readUInt32BE(16) > 0 &&
    data.readUInt32BE(20) > 0 &&
    data.subarray(-12).equals(Buffer.from("0000000049454e44ae426082", "hex"))
  )
    return "image/png";
  if (
    data.length >= 4 &&
    data.readUInt16BE(0) === 0xffd8 &&
    data.readUInt16BE(data.length - 2) === 0xffd9
  ) {
    let offset = 2;
    let frame = false;
    while (offset + 4 <= data.length) {
      if (data[offset++] !== 0xff) return undefined;
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === 0xda) return frame ? "image/jpeg" : undefined;
      if (offset + 2 > data.length) return undefined;
      const size = data.readUInt16BE(offset);
      if (size < 2 || offset + size > data.length) return undefined;
      if (marker !== undefined && [0xc0, 0xc1, 0xc2].includes(marker)) {
        if (size < 8 || !data.readUInt16BE(offset + 3) || !data.readUInt16BE(offset + 5))
          return undefined;
        frame = true;
      }
      offset += size;
    }
  }
  return undefined;
}

function portable(library: RekordboxLibraryService, track: TrackDetail) {
  const paths = analysisPaths(library, track.id);
  const versions = [
    fileIdentity(track.path ?? undefined),
    ...Object.values(kinds).map((kind) => fileIdentity(paths[kind])),
  ];
  const value = {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    genre: track.genre,
    key: track.key,
    bpm: track.bpm,
    durationSeconds: track.durationSeconds,
    artworkAvailable: false,
    fileExists: versions[0] !== null,
    analyzed: versions.slice(1).every((version) => version !== null),
  };
  // Cover changes do not invalidate downloaded audio/ANLZ. Keep the original revision input.
  const sourceRevision = hash(JSON.stringify([value, track.revision, versions]));
  const cover = artworkSource(library, track.id);
  return {
    ...value,
    // Date-added metadata also leaves already-downloaded media valid.
    addedAt: track.addedAt,
    artworkAvailable: cover?.kind === "file" && fileIdentity(cover.path) !== null,
    sourceRevision,
  };
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const data = Buffer.from(JSON.stringify(value));
  if (data.length > maxJsonBytes) throw new PairError(413, "SNAPSHOT_TOO_LARGE");
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": data.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    connection: "close",
  });
  response.end(data);
}

/** Separate authenticated TLS surface sharing the loopback server's library, never its routes. */
export async function startPairedLibrary(
  library: RekordboxLibraryService,
  options: { host: string; port?: number; pairingFile: string },
): Promise<{ pairingFile: string; close(): Promise<void> }> {
  if (
    !isIPv4(options.host) ||
    options.host === "0.0.0.0" ||
    Number(options.host.split(".")[0]) >= 224
  )
    throw new Error("Pair sharing requires a specific local IPv4 address");
  const databasePath = library.getDatabasePath();
  const credentials = await provision(databasePath, options.host);
  const path = credentialPath(databasePath);
  const cache = new Map<string, string>();
  let active = 0;
  let closing = false;
  async function artifact(
    id: string,
    kind: "audio" | keyof typeof kinds,
  ): Promise<{ file: FileHandle; digest: string; size: number; version: string; path: string }> {
    if (closing) throw new PairError(503, "UNAVAILABLE");
    const source =
      kind === "audio" ? library.getAudioPath(id) : analysisPaths(library, id)[kinds[kind]];
    if (
      !source ||
      (kind === "audio" &&
        !/^\.(mp3|mp4|m4a|aac|aif|aiff|wav|flac|ogg|opus)$/iu.test(extname(source)))
    )
      throw new PairError(404, "NOT_FOUND");
    const version = fileIdentity(source);
    if (!version) throw new PairError(404, "NOT_FOUND");
    const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat({ bigint: true });
      const openedVersion = `${resolve(source)}:${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
      if (!info.isFile() || openedVersion !== version) throw new PairError(409, "SOURCE_CHANGED");
      let digest = cache.get(version);
      if (!digest) {
        const hasher = createHash("sha256");
        for await (const chunk of file.createReadStream({ start: 0, autoClose: false }))
          hasher.update(chunk);
        if (fileIdentity(source) !== version) throw new PairError(409, "SOURCE_CHANGED");
        digest = hasher.digest("hex");
        cache.set(version, digest);
        if (cache.size > 512) cache.delete(cache.keys().next().value!);
      }
      return { file, digest, size: Number(info.size), version, path: source };
    } catch (error) {
      await file.close();
      throw error;
    }
  }
  async function artwork(id: string) {
    if (closing) throw new PairError(503, "UNAVAILABLE");
    const source = artworkSource(library, id);
    const version = fileIdentity(source?.path);
    if (!source || !version) return undefined;
    let file: FileHandle | undefined;
    try {
      file = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await file.stat({ bigint: true });
      const openedVersion = `${resolve(source.path)}:${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
      if (!info.isFile() || openedVersion !== version) throw new PairError(409, "SOURCE_CHANGED");
      let data: Buffer;
      if (source.kind === "file") {
        if (info.size > BigInt(maxArtworkBytes)) return undefined;
        const chunks: Buffer[] = [];
        for await (const chunk of file.createReadStream({
          start: 0,
          end: maxArtworkBytes,
          autoClose: false,
        }))
          chunks.push(chunk as Buffer);
        data = Buffer.concat(chunks);
      } else {
        // Do not scan an entire recording just to discover an optional cover.
        const stream = file.createReadStream({
          start: 0,
          end: maxArtworkScanBytes - 1,
          autoClose: false,
        });
        try {
          const metadata = await parseStream(
            stream,
            { path: source.path, size: Number(info.size) },
            { duration: false, skipCovers: false, skipPostHeaders: true },
          );
          const cover = selectCover(metadata.common.picture);
          if (!cover || cover.data.byteLength > maxArtworkBytes) return undefined;
          data = Buffer.from(cover.data);
        } finally {
          stream.destroy();
        }
      }
      if (closing) throw new PairError(503, "UNAVAILABLE");
      const current = library.readSnapshot(() => artworkSource(library, id));
      if (
        current?.kind !== source.kind ||
        current.path !== source.path ||
        fileIdentity(source.path) !== version
      )
        throw new PairError(409, "SOURCE_CHANGED");
      const contentType = artworkContentType(data);
      return contentType ? { data, contentType, digest: hash(data) } : undefined;
    } catch (error) {
      if (error instanceof PairError) throw error;
      // Missing, unreadable or malformed covers must not make music unavailable.
      return undefined;
    } finally {
      await file?.close();
    }
  }
  const server = createServer(
    {
      cert: credentials.certificate,
      key: credentials.privateKey,
      minVersion: "TLSv1.2",
      maxHeaderSize: 8192,
      handshakeTimeout: 10_000,
    },
    async (request, response) => {
      let admitted = false;
      try {
        const authorization = request.headers.authorization ?? "";
        const provided = /^Bearer ([a-f0-9]{64})$/u.exec(authorization)?.[1];
        const current = await readCredentials(path);
        const valid = timingSafeEqual(
          Buffer.from(provided ?? "0".repeat(64), "hex"),
          Buffer.from(current.token, "hex"),
        );
        if (!valid || !provided) throw new PairError(401, "UNAUTHORIZED");
        if (closing) throw new PairError(503, "UNAVAILABLE");
        if (
          request.headers.origin !== undefined ||
          request.headers.referer !== undefined ||
          request.headers.cookie !== undefined ||
          Object.keys(request.headers).some((key) => key.startsWith("sec-fetch-"))
        )
          throw new PairError(403, "BROWSER_ACCESS_DENIED");
        if (request.method !== "GET") throw new PairError(405, "METHOD_NOT_ALLOWED");
        if (
          (request.url?.length ?? 0) > 2048 ||
          request.headers["transfer-encoding"] ||
          (request.headers["content-length"] && request.headers["content-length"] !== "0")
        )
          throw new PairError(413, "REQUEST_TOO_LARGE");
        if (active >= 4) throw new PairError(503, "BUSY");
        active += 1;
        admitted = true;
        const url = new URL(request.url ?? "/", "https://paired.invalid");
        if (url.pathname === "/pair/v1/catalog") {
          const snapshot = library.readSnapshot(() => {
            const tracks: ReturnType<typeof portable>[] = [];
            const ids = (playlistId?: string) => {
              const items: string[] = [];
              while (true) {
                const page = library.getTracks({
                  limit: 10_000,
                  offset: items.length,
                  ...(playlistId ? { playlistId } : {}),
                });
                items.push(...page.items.map((item) => item.id));
                if (items.length > 50_000) throw new PairError(413, "SNAPSHOT_TOO_LARGE");
                if (items.length >= page.count || page.items.length === 0) break;
              }
              return items;
            };
            for (const id of ids()) tracks.push(portable(library, library.getTrack(id)));
            const rows = library.getPlaylists();
            if (rows.length > 10_000) throw new PairError(413, "SNAPSHOT_TOO_LARGE");
            let memberships = 0;
            const playlists = rows.map(({ id, name: title, parentId, type, seq }) => {
              const trackIDs = type === "folder" ? [] : ids(id);
              memberships += trackIDs.length;
              if (memberships > 200_000) throw new PairError(413, "SNAPSHOT_TOO_LARGE");
              return { id, name: title, parentId, type, seq, trackIDs };
            });
            return { libraryID: credentials.libraryID, name, tracks, playlists };
          });
          json(response, 200, snapshot);
          return;
        }
        const match =
          /^\/pair\/v1\/tracks\/([A-Za-z0-9_-]{1,128})(?:\/(audio|artwork|analysis\/(dat|ext|twoEx)))?$/u.exec(
            url.pathname,
          );
        if (!match) throw new PairError(404, "NOT_FOUND");
        const id = match[1]!;
        const track = library.readSnapshot(() => portable(library, library.getTrack(id)));
        if (!match[2]) {
          const audio = await artifact(id, "audio");
          try {
            const detail = {
              ...track,
              mediaHash: audio.digest,
              mediaExtension: extname(audio.path).slice(1).toLowerCase(),
            };
            let analysis:
              | { mediaHash: string; dat: string; ext: string; twoEx: string }
              | undefined;
            if (track.analyzed) {
              const hashes: string[] = [];
              for (const kind of ["dat", "ext", "twoEx"] as const) {
                const value = await artifact(id, kind);
                hashes.push(value.digest);
                await value.file.close();
              }
              analysis = {
                mediaHash: audio.digest,
                dat: hashes[0]!,
                ext: hashes[1]!,
                twoEx: hashes[2]!,
              };
            }
            const cover = await artwork(id);
            // An admitted hash may outlive socket shutdown; never reopen the closed library.
            if (closing) throw new PairError(503, "UNAVAILABLE");
            if (
              library.readSnapshot(() => portable(library, library.getTrack(id))).sourceRevision !==
              track.sourceRevision
            )
              throw new PairError(409, "SOURCE_CHANGED");
            json(response, 200, {
              track: {
                ...detail,
                ...(analysis ? { analysis } : {}),
                artworkAvailable: cover !== undefined,
                ...(cover ? { artworkHash: cover.digest } : {}),
              },
            });
          } finally {
            await audio.file.close();
          }
          return;
        }
        const expected = url.searchParams.get("hash");
        if (!expected || !hashPattern.test(expected)) throw new PairError(400, "HASH_REQUIRED");
        if (match[2] === "artwork") {
          const cover = await artwork(id);
          if (!cover) throw new PairError(404, "NOT_FOUND");
          if (cover.digest !== expected) throw new PairError(409, "SOURCE_CHANGED");
          response.writeHead(200, {
            "content-type": cover.contentType,
            "content-length": cover.data.length,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          });
          response.end(cover.data);
          return;
        }
        const kind = match[2] === "audio" ? "audio" : (match[3] as keyof typeof kinds);
        const expectedMedia = url.searchParams.get("mediaHash");
        if (kind !== "audio" && (!expectedMedia || !hashPattern.test(expectedMedia)))
          throw new PairError(400, "MEDIA_HASH_REQUIRED");
        const audio = kind === "audio" ? undefined : await artifact(id, "audio");
        let value: Awaited<ReturnType<typeof artifact>> | undefined;
        try {
          if (audio && audio.digest !== expectedMedia) throw new PairError(409, "SOURCE_CHANGED");
          value = await artifact(id, kind);
          if (value.digest !== expected || fileIdentity(value.path) !== value.version)
            throw new PairError(409, "SOURCE_CHANGED");
          if (audio && fileIdentity(audio.path) !== audio.version)
            throw new PairError(409, "SOURCE_CHANGED");
          response.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": value.size,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          });
          const source = value;
          const streamedHash = createHash("sha256");
          const verified = new Transform({
            transform(chunk: Buffer, _encoding, done) {
              streamedHash.update(chunk);
              done(null, chunk);
            },
            flush(done) {
              // A change after headers cannot become a 409; abort instead of completing corrupt bytes.
              const unchanged =
                fileIdentity(source.path) === source.version &&
                (!audio || fileIdentity(audio.path) === audio.version);
              done(
                unchanged && streamedHash.digest("hex") === expected
                  ? undefined
                  : new PairError(409, "SOURCE_CHANGED"),
              );
            },
          });
          await pipeline(
            value.file.createReadStream({ start: 0, autoClose: false }),
            verified,
            response,
          );
        } finally {
          await value?.file.close();
          await audio?.file.close();
        }
      } catch (error) {
        if (response.headersSent) response.destroy();
        else {
          const failure =
            error instanceof PairError
              ? error
              : new PairError(
                  error instanceof RangeError ? 404 : 503,
                  error instanceof RangeError ? "NOT_FOUND" : "UNAVAILABLE",
                );
          json(response, failure.status, {
            error: { code: failure.code, message: "Paired library request could not be completed" },
          });
        }
      } finally {
        if (admitted) active -= 1;
      }
    },
  );
  server.maxConnections = 32;
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.setTimeout(120_000, (socket) => socket.destroy());
  const sockets = new Set<Duplex>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const close = () =>
    new Promise<void>((done, reject) => {
      closing = true;
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : done()));
    });
  try {
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 4184, options.host, () => {
        server.off("error", reject);
        done();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Paired listener has no address");
    const pairingFile = resolve(options.pairingFile);
    try {
      const info = await lstat(pairingFile);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 8192)
        throw new Error("Pairing destination is not a descriptor");
      const existing = JSON.parse(
        await readFile(pairingFile, "utf8"),
      ) as Partial<PairingDescriptor>;
      if (
        existing.version !== 1 ||
        existing.libraryID !== credentials.libraryID ||
        !existing.token ||
        !hashPattern.test(existing.token)
      )
        throw new Error("Pairing destination belongs to another file or library");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
        throw new Error("Refusing to overwrite an unrelated pairing destination");
    }
    await withCredentials(databasePath, async (privatePath) => {
      const current = await readCredentials(privatePath);
      current.descriptor = { path: pairingFile, url: `https://${options.host}:${address.port}` };
      await privateWrite(pairingFile, descriptor(current, current.descriptor.url));
      await privateWrite(privatePath, current);
    });
    return { pairingFile, close };
  } catch (error) {
    if (server.listening) await close();
    throw error;
  }
}
