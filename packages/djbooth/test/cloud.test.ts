import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TrackSummary } from "@gakonst/djbooth-app";
import { describe, expect, test, vi } from "vitest";

import { cloudEndpoint, cloudWaveform, publishCloudLibrary } from "../src/cloud.js";

const track: TrackSummary = {
  id: "123",
  title: "Real Recording",
  artist: "Artist",
  album: "Album",
  genre: "House",
  key: "Am",
  bpm: 124,
  durationSeconds: 300,
  colorId: null,
  rating: 0,
  playCount: 0,
  analyzed: true,
  artworkAvailable: true,
  fileExists: true,
  path: "/private/workstation/audio.flac",
};
function library(audioPath = track.path!) {
  return {
    getPlaylists: () => [
      {
        id: "playlist",
        name: "DJ Sets I Like",
        parentId: "root",
        seq: 1,
        type: "playlist" as const,
        trackCount: 1,
      },
    ],
    getTracks: () => ({ items: [track], count: 1, offset: 0, limit: 100 }),
    getAudioPath: () => audioPath,
  };
}
type Change = {
  sequence: number;
  operationID: string;
  kind: string;
  entityID: string;
  payload: string | null;
  deleted: boolean;
};
function cloud(initial: Change[] = []) {
  const changes = [...initial];
  const media = new Map<string, Uint8Array>();
  const requests: { path: string; method: string }[] = [];
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-token");
    expect(init?.redirect).toBe("error");
    requests.push({ path: url.pathname, method });
    if (url.pathname === "/v1/sync/changes" && method === "GET")
      return Response.json({ changes, cursor: changes.length, hasMore: false });
    if (url.pathname === "/v1/sync/changes" && method === "POST") {
      const operation = JSON.parse(String(init?.body));
      const current = changes.findLast(
        (change) => change.kind === operation.kind && change.entityID === operation.entityID,
      );
      if (operation.baseVersion !== (current?.sequence ?? 0))
        return Response.json({ current }, { status: 409 });
      const change = { ...operation, sequence: changes.length + 1 };
      changes.push(change);
      return Response.json(change, { status: 201 });
    }
    if (method === "POST" && url.pathname.endsWith("/compose")) {
      const hash = url.pathname.split("/").at(-2)!;
      const { chunks } = JSON.parse(String(init?.body)) as {
        chunks: { hash: string; size: number }[];
      };
      const bytes = Buffer.concat(
        chunks.map((chunk) => {
          const bytes = media.get(chunk.hash)!;
          expect(bytes.byteLength).toBe(chunk.size);
          return bytes;
        }),
      );
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash);
      media.set(hash, bytes);
      return new Response(null, { status: 201 });
    }
    const hash = url.pathname.split("/").at(-1)!;
    if (method === "HEAD") return new Response(null, { status: media.has(hash) ? 200 : 404 });
    if (method === "PUT") {
      const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
      expect(Number(new Headers(init?.headers).get("Content-Length"))).toBe(bytes.byteLength);
      expect(bytes.byteLength).toBeLessThanOrEqual(16 * 1024 * 1024);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash);
      media.set(hash, bytes);
      return new Response(null, { status: 201 });
    }
    throw new Error(`Unexpected request ${method} ${url.pathname}`);
  }) as unknown as typeof fetch;
  return { request, changes, media, requests };
}

describe("cloud publishing", () => {
  test("retains scrolling waveform detail with aligned transient colors and bounded payloads", () => {
    const peaks = Array.from({ length: 16_384 }, (_, index) => (index % 2 ? 1 : 0.25));
    const colors = peaks.map((peak): [number, number, number] =>
      peak === 1 ? [255, 0, 0] : [0, 0, 255],
    );
    const waveform = cloudWaveform({
      peaks,
      colors,
      source: "rekordbox",
      durationSeconds: 300,
      beatGrid: [{ beat: 1, timeSeconds: 0 }],
    });
    expect(waveform.peaks).toEqual(Array(8192).fill(1));
    expect(waveform.colors).toEqual(Array(8192).fill([255, 0, 0]));
    expect(waveform.beatGrid).toEqual({ times: [0], beats: [1] });
    const detailed = cloudWaveform({
      peaks: Array(8192).fill(1 / 3),
      colors: Array(8192).fill([255, 255, 255]),
      source: "rekordbox",
      durationSeconds: 300,
    });
    expect(detailed.peaks[0]).toBe(0.3333);
    expect(Buffer.byteLength(JSON.stringify(detailed))).toBeLessThan(200 * 1024);
  });
  test("preserves real beat timing and downbeats for long sets within the payload budget", () => {
    const beatGrid = Array.from({ length: 20_000 }, (_, index) => ({
      beat: ((index % 4) + 1) as 1 | 2 | 3 | 4,
      timeSeconds: index * 0.487 + 0.013,
    }));
    const waveform = cloudWaveform({
      peaks: Array(16_384).fill(0.3333),
      colors: Array(16_384).fill([255, 255, 255]),
      beatGrid,
      source: "rekordbox",
      durationSeconds: 10_000,
    });
    expect(waveform.beatGrid?.times).toHaveLength(20_000);
    expect(waveform.beatGrid?.beats).toEqual(beatGrid.map((entry) => entry.beat));
    expect(waveform.beatGrid?.times[19_999]).toBeCloseTo(beatGrid[19_999]!.timeSeconds, 3);
    expect(Buffer.byteLength(JSON.stringify(waveform))).toBeLessThanOrEqual(220 * 1024);
  });
  test("publishes real audio and ordered memberships, strips workstation details, then resumes without writes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "djbooth-cloud-test-"));
    try {
      const path = join(directory, "recording.flac");
      await writeFile(path, "recording bytes");
      const server = cloud();
      const options = { endpoint: "https://sync.example.com", token: "test-token" };
      const first = await publishCloudLibrary(library(path), options, server.request);
      expect(first).toMatchObject({
        tracks: 1,
        published: 3,
        uploaded: 1,
        failures: [],
        conflicts: [],
      });
      const metadata = JSON.parse(server.changes[0]!.payload!);
      expect(metadata).toMatchObject({ id: "123", artworkAvailable: false, fileExists: false });
      expect(metadata).not.toHaveProperty("path");
      expect(JSON.stringify(server.changes)).not.toContain("/private/");
      expect(JSON.parse(server.changes[1]!.payload!)).toEqual({
        id: "rekordbox:playlist",
        name: "DJ Sets I Like",
        trackIDs: ["123"],
      });
      expect(JSON.parse(server.changes[2]!.payload!)).toMatchObject({
        mediaExtension: "flac",
        mediaHash: [...server.media.keys()][0],
      });
      const second = await publishCloudLibrary(library(path), options, server.request);
      expect(second).toMatchObject({
        published: 0,
        uploaded: 0,
        reusedMedia: 1,
        failures: [],
        conflicts: [],
      });
      expect(server.changes).toHaveLength(3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("replays the same metadata operation after a lost commit response", async () => {
    const server = cloud();
    let replay: { body: BodyInit | null | undefined; change: unknown } | undefined;
    let interrupted = false;
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (replay) {
        expect(init?.body).toBe(replay.body);
        const response = Response.json(replay.change, { status: 201 });
        replay = undefined;
        return response;
      }
      const response = await server.request(input, init);
      if (init?.method === "POST" && !interrupted) {
        interrupted = true;
        replay = { body: init.body, change: await response.json() };
        throw new TypeError("fetch failed");
      }
      return response;
    }) as unknown as typeof fetch;
    const result = await publishCloudLibrary(
      library(),
      { endpoint: "https://sync.example.com", token: "test-token", metadataOnly: true },
      request,
    );
    expect(result).toMatchObject({ published: 2, failures: [], conflicts: [] });
    expect(server.changes).toHaveLength(2);
    expect(interrupted).toBe(true);
  });

  test.each([16 * 1024 * 1024, 16 * 1024 * 1024 + 1])(
    "bounds request bodies at 16 MiB and resumes verified composition for %i bytes",
    async (size) => {
      const directory = await mkdtemp(join(tmpdir(), "djbooth-cloud-chunks-"));
      try {
        const path = join(directory, "recording.m4a");
        const bytes = Buffer.alloc(size, 0x42);
        await writeFile(path, bytes);
        const hash = createHash("sha256").update(bytes).digest("hex");
        const server = cloud();
        const options = { endpoint: "https://sync.example.com", token: "test-token" };
        const result = await publishCloudLibrary(library(path), options, server.request);
        expect(result).toMatchObject({ uploaded: 1, published: 3, failures: [], conflicts: [] });
        expect(server.requests.filter((request) => request.method === "PUT")).toHaveLength(
          size > 16 * 1024 * 1024 ? 2 : 1,
        );
        expect(server.requests.filter((request) => request.path.endsWith("/compose"))).toHaveLength(
          size > 16 * 1024 * 1024 ? 1 : 0,
        );
        expect(Buffer.from(server.media.get(hash)!).equals(bytes)).toBe(true);
        expect(JSON.parse(server.changes.at(-1)!.payload!).mediaHash).toBe(hash);
        const requestsBeforeResume = server.requests.length;
        expect(await publishCloudLibrary(library(path), options, server.request)).toMatchObject({
          uploaded: 0,
          published: 0,
          reusedMedia: 1,
          failures: [],
          conflicts: [],
        });
        expect(
          server.requests
            .slice(requestsBeforeResume)
            .every((request) => request.method === "GET" || request.method === "HEAD"),
        ).toBe(true);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test("uploads selected playlist audio in playback order instead of global library order", async () => {
    const directory = await mkdtemp(join(tmpdir(), "djbooth-cloud-order-"));
    try {
      const firstPath = join(directory, "first.m4a");
      const secondPath = join(directory, "second.m4a");
      await writeFile(firstPath, "first recording");
      await writeFile(secondPath, "second recording");
      const second = { ...track, id: "456", title: "Second recording" };
      const local = {
        ...library(),
        getTracks: (options: { playlistId?: string } = {}) => ({
          items: options.playlistId ? [second, track] : [track, second],
          count: 2,
          offset: 0,
          limit: 100,
        }),
        getAudioPath: (id: string) => (id === track.id ? firstPath : secondPath),
      };
      const server = cloud();
      await publishCloudLibrary(
        local,
        {
          endpoint: "https://sync.example.com",
          token: "test-token",
          playlist: ["playlist"],
        },
        server.request,
      );
      expect(
        server.requests
          .filter((request) => request.method === "PUT")
          .map((request) => request.path),
      ).toEqual(
        ["second recording", "first recording"].map(
          (bytes) => `/v1/media/${createHash("sha256").update(bytes).digest("hex")}`,
        ),
      );
      const collection = server.changes.find((change) => change.kind === "collection")!;
      expect(JSON.parse(collection.payload!).trackIDs).toEqual(["456", "123"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("caps concurrent files, counts completed uploads, and resumes independent track versions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "djbooth-cloud-concurrency-"));
    try {
      const tracks = Array.from({ length: 5 }, (_, index) => ({
        ...track,
        id: String(index),
        title: `Recording ${index}`,
      }));
      const paths = tracks.map((track) => join(directory, `${track.id}.m4a`));
      const hashes = tracks.map((track) => createHash("sha256").update(track.title).digest("hex"));
      await Promise.all(tracks.map((track, index) => writeFile(paths[index]!, track.title)));
      const started: string[] = [];
      const local = {
        ...library(),
        getTracks: () => ({ items: tracks, count: tracks.length, offset: 0, limit: 100 }),
        getAudioPath: (id: string) => {
          started.push(id);
          return paths[Number(id)]!;
        },
      };
      const server = cloud();
      let markReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        markReady = resolve;
      });
      const releases = new Map<string, () => void>();
      let active = 0;
      let peak = 0;
      const request: typeof fetch = async (input, init) => {
        if (init?.method !== "PUT") return server.request(input, init);
        expect(server.changes.length).toBeGreaterThanOrEqual(6);
        active++;
        peak = Math.max(peak, active);
        try {
          const hash = new URL(String(input)).pathname.split("/").at(-1)!;
          if (hashes.slice(1, 4).includes(hash))
            await new Promise<void>((resolve) => {
              releases.set(hash, resolve);
              if (releases.size === 3) markReady();
            });
          return await server.request(input, init);
        } finally {
          active--;
        }
      };
      const progress: { phase: string; current: number; total: number }[] = [];
      const options = {
        endpoint: "https://sync.example.com",
        token: "test-token",
        playlist: ["playlist"],
        uploadConcurrency: 3,
        onProgress: (value: (typeof progress)[number]) => progress.push(value),
      };
      const publishing = publishCloudLibrary(local, options, request);
      await ready;
      expect(started).toEqual(["0", "1", "2", "3"]);
      expect(peak).toBe(3);
      expect(
        progress.filter((value) => value.phase === "audio").map((value) => value.current),
      ).toEqual([0, 1]);
      for (const release of [...releases.values()].reverse()) release();
      const result = await publishing;
      expect(peak).toBe(3);
      expect(result).toMatchObject({ uploaded: 5, published: 11, conflicts: [], failures: [] });
      expect(
        progress.filter((value) => value.phase === "audio").map((value) => value.current),
      ).toEqual([0, 1, 2, 3, 4, 5]);
      expect(progress.at(-1)).toEqual({ phase: "complete", current: 5, total: 5 });
      for (const [index, track] of tracks.entries()) {
        const latest = server.changes.findLast(
          (change) => change.kind === "track" && change.entityID === track.id,
        )!;
        expect(JSON.parse(latest.payload!).mediaHash).toBe(hashes[index]);
      }
      const resumed = await publishCloudLibrary(local, options, request);
      expect(resumed).toMatchObject({
        uploaded: 0,
        published: 0,
        reusedMedia: 5,
        conflicts: [],
        failures: [],
      });
      expect(server.changes).toHaveLength(11);
      for (const invalid of [0, 4, 1.5, Number.NaN])
        await expect(
          publishCloudLibrary(local, { dryRun: true, uploadConcurrency: invalid }),
        ).rejects.toThrow("Upload concurrency");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each([false, true])(
    "keeps mobile annotations independent from recording updates (deleted: %s)",
    async (deleted) => {
      const directory = await mkdtemp(join(tmpdir(), "djbooth-cloud-annotations-"));
      try {
        const path = join(directory, "recording.m4a");
        await writeFile(path, "recording bytes");
        const server = cloud();
        const options = { endpoint: "https://sync.example.com", token: "test-token" };
        await publishCloudLibrary(library(path), options, server.request);
        const annotation = {
          sequence: server.changes.length + 1,
          operationID: "phone-note-edit",
          kind: "annotation",
          entityID: track.id,
          payload: deleted ? null : JSON.stringify({ note: "Play after midnight", color: "red" }),
          deleted,
        };
        server.changes.push(annotation);
        const local = {
          ...library(path),
          getTracks: () => ({
            items: [{ ...track, title: "Corrected recording title", bpm: 127 }],
            count: 1,
            offset: 0,
            limit: 100,
          }),
        };
        const result = await publishCloudLibrary(local, options, server.request);
        expect(result).toMatchObject({
          published: 1,
          uploaded: 0,
          reusedMedia: 1,
          conflicts: [],
          failures: [],
        });
        expect(server.changes.filter((change) => change.kind === "annotation")).toEqual([
          annotation,
        ]);
        const updated = JSON.parse(server.changes.at(-1)!.payload!);
        expect(updated).toMatchObject({ title: "Corrected recording title", bpm: 127 });
        expect(updated).not.toHaveProperty("note");
        expect(updated).not.toHaveProperty("color");
        expect(await publishCloudLibrary(local, options, server.request)).toMatchObject({
          published: 0,
          uploaded: 0,
          reusedMedia: 1,
          conflicts: [],
          failures: [],
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test("keeps differing mobile edits and does not upload their source audio", async () => {
    const server = cloud([
      {
        sequence: 1,
        operationID: "mobile-edit",
        kind: "track",
        entityID: "123",
        payload: JSON.stringify({ id: "123", title: "My correction" }),
        deleted: false,
      },
    ]);
    const result = await publishCloudLibrary(
      library(),
      { endpoint: "https://sync.example.com", token: "test-token" },
      server.request,
    );
    expect(result.conflicts).toEqual(["track:123"]);
    expect(result.uploaded).toBe(0);
    expect(server.changes[0]!.operationID).toBe("mobile-edit");
  });

  test("dry-run needs no credentials or network, and unknown selection fails closed", async () => {
    const request = vi.fn();
    const result = await publishCloudLibrary(
      library(),
      {
        dryRun: true,
        playlist: ["DJ Sets I Like"],
        onProgress: () => {
          throw new Error("diagnostic failure");
        },
      },
      request,
    );
    expect(result.tracks).toBe(1);
    expect(request).not.toHaveBeenCalled();
    await expect(
      publishCloudLibrary(library(), { dryRun: true, playlist: ["Unknown"] }, request),
    ).rejects.toThrow("was not found");
  });

  test("permits only the exact internal binding origin in container mode", () => {
    const previous = process.env.DJBOOTH_CONTAINER_BINDINGS;
    try {
      delete process.env.DJBOOTH_CONTAINER_BINDINGS;
      expect(() => cloudEndpoint("http://djbooth.internal")).toThrow();
      process.env.DJBOOTH_CONTAINER_BINDINGS = "1";
      expect(cloudEndpoint("http://djbooth.internal").origin).toBe("http://djbooth.internal");
      expect(() => cloudEndpoint("http://djbooth.internal:8080")).toThrow();
      expect(() => cloudEndpoint("http://elsewhere.internal")).toThrow();
    } finally {
      if (previous === undefined) delete process.env.DJBOOTH_CONTAINER_BINDINGS;
      else process.env.DJBOOTH_CONTAINER_BINDINGS = previous;
    }
  });

  test("rejects credential-bearing or insecure origins before attaching a token", () => {
    for (const endpoint of [
      "http://remote.example.com",
      "https://user:secret@example.com",
      "https://example.com/path",
      "https://example.com?token=secret",
    ])
      expect(() => cloudEndpoint(endpoint)).toThrow();
    expect(cloudEndpoint("http://127.0.0.1:8787").origin).toBe("http://127.0.0.1:8787");
  });
});

test("separate playlist databases cannot collide in cloud IDs and retries reuse media", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-namespace-"));
  try {
    const path = join(root, "audio.wav");
    await writeFile(path, "same acquired audio");
    const remote = cloud();
    const namespaces = [
      "cloud:11111111-1111-1111-1111-111111111111",
      "cloud:22222222-2222-2222-2222-222222222222",
    ];
    for (const namespace of namespaces) {
      const options = {
        endpoint: "https://library.test",
        token: "test-token",
        namespace,
        playlist: ["playlist"],
      };
      expect((await publishCloudLibrary(library(path), options, remote.request)).failures).toEqual(
        [],
      );
      const replay = await publishCloudLibrary(library(path), options, remote.request);
      expect(
        vi
          .mocked(remote.request)
          .mock.calls.some(
            ([input, init]) =>
              (!init?.method || init.method === "GET") &&
              new URL(String(input)).searchParams.get("namespace") === namespace,
          ),
      ).toBe(true);
      expect(replay.uploaded).toBe(0);
      expect(replay.conflicts).toEqual([]);
      const collection = remote.changes.findLast(
        (change) => change.entityID === `${namespace}:playlist:playlist`,
      )!;
      expect(JSON.parse(collection.payload!).trackIDs).toEqual([`${namespace}:track:123`]);
      expect(
        remote.changes.findLast((change) => change.entityID === `${namespace}:track:123`),
      ).toBeDefined();
    }
    expect(remote.media.size).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
