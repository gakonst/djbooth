import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  LibraryBootstrap,
  LibraryMutation,
  MutationReceipt,
  TrackDetail,
} from "../src/shared/types.js";
import {
  startLibraryServer,
  type LibraryApi,
  type RunningLibraryServer,
} from "../src/server/server.js";

const roots: string[] = [];
const servers: RunningLibraryServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fixture(): { audioPath: string; root: string; staticDirectory: string } {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "rekordbox-library-server-"));
  roots.push(root);
  const staticDirectory = join(root, "client");
  mkdirSync(staticDirectory);
  writeFileSync(join(staticDirectory, "index.html"), "<main>library</main>");
  const audioPath = join(root, "track.m4a");
  writeFileSync(audioPath, "0123456789");
  return { audioPath, root, staticDirectory };
}

function mockApi(
  audioPath: string,
): LibraryApi & { getTracks: ReturnType<typeof vi.fn>; mutate: ReturnType<typeof vi.fn> } {
  const detail: TrackDetail = {
    id: "track-1",
    title: "No Static",
    artist: "Test Artist",
    album: null,
    genre: "House",
    key: "Am",
    bpm: 124,
    durationSeconds: 300,
    rating: 4,
    playCount: 2,
    analyzed: true,
    fileExists: true,
    path: audioPath,
    comment: null,
    isrc: null,
    releaseYear: 2026,
    bitRate: 256,
    sampleRate: 44_100,
    fileSize: 10,
    analysisPath: "/PIONEER/USBANLZ/test/ANLZ0000.DAT",
    playlists: [],
  };
  const mutate = vi.fn(
    async (mutation: LibraryMutation): Promise<MutationReceipt> => ({
      operation: mutation.type,
      changedId: "playlist-1",
      backupDirectory: "/tmp/backup",
      quickCheck: "ok",
      foreignKeyViolationCount: 0,
      finishedAt: "2026-07-12T00:00:00.000Z",
    }),
  );
  const getTracks = vi.fn(() => ({ items: [detail], count: 1, limit: 100, offset: 0 }));
  return {
    getAudioPath: () => audioPath,
    getBootstrap: (csrfToken): LibraryBootstrap => ({
      csrfToken,
      library: {
        dbPath: "/tmp/master.db",
        dbDirectory: "/tmp",
        writeEnabled: true,
        processes: { rekordboxPid: 0, rekordboxAgentPid: 0 },
        stats: {
          tracks: 1,
          playlists: 1,
          folders: 0,
          analyzed: 1,
          missingAnalysis: 0,
          missingBpm: 0,
          missingKey: 0,
        },
      },
    }),
    getPlaylists: () => [
      {
        id: "playlist-1",
        name: "Grooves",
        parentId: "root",
        seq: 1,
        type: "playlist",
        trackCount: 1,
      },
    ],
    getTrack: () => detail,
    getTracks,
    mutate,
  };
}

describe("library server", () => {
  it("serves the workbench and bounded JSON APIs", async () => {
    const files = fixture();
    const api = mockApi(files.audioPath);
    const server = await startLibraryServer({
      api,
      port: 0,
      staticDirectory: files.staticDirectory,
    });
    servers.push(server);

    const page = await fetch(server.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("library");
    expect(page.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("x-frame-options")).toBe("DENY");

    const headPage = await fetch(server.url, { method: "HEAD" });
    expect(headPage.status).toBe(200);
    expect(headPage.headers.get("content-length")).toBe(String("<main>library</main>".length));
    expect(await headPage.text()).toBe("");

    const bootstrap = (await (
      await fetch(new URL("api/bootstrap", server.url))
    ).json()) as LibraryBootstrap;
    expect(bootstrap.library.stats.tracks).toBe(1);
    expect(bootstrap.csrfToken).toBe(server.token);

    const bootstrapHead = await fetch(new URL("api/bootstrap", server.url), { method: "HEAD" });
    expect(bootstrapHead.status).toBe(200);
    expect(Number(bootstrapHead.headers.get("content-length"))).toBeGreaterThan(0);
    expect(await bootstrapHead.text()).toBe("");

    const tracks = await (await fetch(new URL("api/tracks?limit=25", server.url))).json();
    expect(tracks).toMatchObject({ count: 1, items: [{ id: "track-1" }] });
    expect(api.getTracks).toHaveBeenLastCalledWith({ filter: "all", limit: 25, offset: 0 });
  });

  it("rejects non-exact and duplicate pagination integers", async () => {
    const files = fixture();
    const api = mockApi(files.audioPath);
    const server = await startLibraryServer({
      api,
      port: 0,
      staticDirectory: files.staticDirectory,
    });
    servers.push(server);

    for (const query of [
      "limit=1x",
      "limit=1.5",
      "limit=-1",
      "limit=%2B1",
      "limit=",
      "limit=501",
      "limit=1&limit=2",
      "offset=10000001",
    ]) {
      const response = await fetch(new URL(`api/tracks?${query}`, server.url));
      expect(response.status, query).toBe(400);
    }
    expect(api.getTracks).not.toHaveBeenCalled();

    const methodResponse = await fetch(new URL("api/tracks", server.url), { method: "POST" });
    expect(methodResponse.status).toBe(405);
    expect(methodResponse.headers.get("allow")).toBe("GET, HEAD");
  });

  it("requires the per-run token and same origin for writes", async () => {
    const files = fixture();
    const api = mockApi(files.audioPath);
    const server = await startLibraryServer({
      api,
      port: 0,
      staticDirectory: files.staticDirectory,
    });
    servers.push(server);
    const url = new URL("api/mutations", server.url);
    const body = JSON.stringify({
      type: "rename-playlist",
      playlistId: "playlist-1",
      name: "Oldschool",
    });

    expect((await fetch(url, { method: "POST", body })).status).toBe(403);
    expect(
      (
        await fetch(url, {
          method: "POST",
          body,
          headers: {
            "content-type": "application/json",
            origin: "https://attacker.example",
            "x-music-library-token": server.token,
          },
        })
      ).status,
    ).toBe(403);

    const accepted = await fetch(url, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        origin: server.url.slice(0, -1),
        "x-music-library-token": server.token,
      },
    });
    expect(accepted.status).toBe(200);
    expect(api.mutate).toHaveBeenCalledWith({
      type: "rename-playlist",
      playlistId: "playlist-1",
      name: "Oldschool",
    });
  });

  it("streams only service-resolved audio with byte ranges", async () => {
    const files = fixture();
    const server = await startLibraryServer({
      api: mockApi(files.audioPath),
      port: 0,
      staticDirectory: files.staticDirectory,
    });
    servers.push(server);

    const response = await fetch(new URL("api/audio/track-1", server.url), {
      headers: { range: "bytes=2-5" },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(await response.text()).toBe("2345");

    const head = await fetch(new URL("api/audio/track-1", server.url), {
      method: "HEAD",
      headers: { range: "bytes=2-5" },
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("10");
    expect(head.headers.get("content-range")).toBeNull();
    expect(await head.text()).toBe("");

    const unsatisfiable = await fetch(new URL("api/audio/track-1", server.url), {
      headers: { range: "bytes=10-20" },
    });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe("bytes */10");
    expect(await unsatisfiable.json()).toMatchObject({
      error: { code: "RANGE_NOT_SATISFIABLE" },
    });
  });

  it("serves zero-byte audio without constructing an invalid stream", async () => {
    const files = fixture();
    const emptyPath = join(files.root, "empty.flac");
    writeFileSync(emptyPath, "");
    const server = await startLibraryServer({
      api: mockApi(emptyPath),
      port: 0,
      staticDirectory: files.staticDirectory,
    });
    servers.push(server);

    const response = await fetch(new URL("api/audio/track-1", server.url));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("0");
    expect((await response.arrayBuffer()).byteLength).toBe(0);

    const ranged = await fetch(new URL("api/audio/track-1", server.url), {
      headers: { range: "bytes=0-0" },
    });
    expect(ranged.status).toBe(416);
    expect(ranged.headers.get("content-range")).toBe("bytes */0");
  });

  it("rejects unsupported files and symbolic-link audio paths", async () => {
    const files = fixture();
    const unsupportedPath = join(files.root, "notes.txt");
    writeFileSync(unsupportedPath, "not audio");
    const targetPath = join(files.root, "target.mp3");
    const symlinkPath = join(files.root, "alias.mp3");
    writeFileSync(targetPath, "audio");
    symlinkSync(targetPath, symlinkPath);

    const realDirectory = join(files.root, "real-audio");
    const linkedDirectory = join(files.root, "linked-audio");
    mkdirSync(realDirectory);
    writeFileSync(join(realDirectory, "track.wav"), "audio");
    symlinkSync(realDirectory, linkedDirectory);

    for (const [path, expectedStatus] of [
      [unsupportedPath, 415],
      [symlinkPath, 404],
      [join(linkedDirectory, "track.wav"), 404],
    ] as const) {
      const server = await startLibraryServer({
        api: mockApi(path),
        port: 0,
        staticDirectory: files.staticDirectory,
      });
      servers.push(server);
      const response = await fetch(new URL("api/audio/track-1", server.url));
      expect(response.status, path).toBe(expectedStatus);
    }
  });
});
