import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { HostedPlaylistConflictError } from "../src/server/hosted/types.js";
import {
  absolutizeHlsManifest,
  startLibraryServer,
  type HostedPlaylistApi,
  type LibraryApi,
  type RunningLibraryServer,
} from "../src/server/server.js";
import type { HostedPlaylistMutation, PlaylistItem, TrackSummary } from "../src/shared/types.js";

const roots: string[] = [];
const servers: RunningLibraryServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function staticDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "hosted-server-"));
  roots.push(root);
  mkdirSync(join(root, "client"));
  writeFileSync(join(root, "client", "index.html"), "<main>library</main>");
  return join(root, "client");
}

function localApi(): LibraryApi {
  return {
    getAudioPath: () => "/missing",
    getArtwork: async () => ({
      kind: "embedded",
      contentType: "image/png",
      data: new Uint8Array(),
    }),
    getBootstrap: (csrfToken) => ({
      csrfToken,
      library: {
        dbPath: "/tmp/master.db",
        dbDirectory: "/tmp",
        writeEnabled: true,
        processes: { rekordboxPid: 0, rekordboxAgentPid: 0 },
        stats: {
          tracks: 0,
          playlists: 0,
          folders: 0,
          analyzed: 0,
          missingAnalysis: 0,
          missingBpm: 0,
          missingKey: 0,
        },
      },
    }),
    getPlaylists: () => [],
    getTrack: () => {
      throw new RangeError("missing");
    },
    getWaveform: () => ({ durationSeconds: null, peaks: [], source: "placeholder" }),
    getTracks: () => ({ items: [], count: 0, limit: 100, offset: 0 }),
    mutate: async (mutation) => ({
      operation: mutation.type,
      changedId: "local",
      finishedAt: new Date().toISOString(),
    }),
  };
}

function playlist(): PlaylistItem {
  return {
    id: "hosted:spotify:cGxheWxpc3Q",
    name: "Remote",
    parentId: "hosted:spotify",
    seq: 1,
    type: "playlist",
    trackCount: 2,
    hosted: {
      provider: "spotify",
      remoteId: "playlist",
      revision: "spotify:one",
      externalUrl: "https://open.spotify.com/playlist/playlist",
      owned: true,
      capabilities: { itemsReadable: true, detailsEditable: true, itemsEditable: true },
      downloadEnabled: false,
      syncState: "idle",
    },
  };
}

function track(id: string, title: string, position: number): TrackSummary {
  return {
    id,
    title,
    artist: "Artist",
    album: null,
    genre: null,
    key: null,
    colorId: null,
    bpm: null,
    durationSeconds: 180,
    rating: 0,
    playCount: 0,
    analyzed: false,
    artworkAvailable: false,
    fileExists: false,
    path: null,
    trackNumber: position,
    hosted: {
      provider: "spotify",
      remoteId: `spotify:track:${id}`,
      externalUrl: null,
      localContentId: null,
      downloadState: "remote",
    },
  };
}

function hostedApi(): HostedPlaylistApi & { mutate: ReturnType<typeof vi.fn> } {
  const mutate = vi.fn(async (mutation: HostedPlaylistMutation) => ({
    operation: mutation.type,
    playlistId: "playlistId" in mutation ? mutation.playlistId : "hosted:spotify:new",
    revision: "spotify:two",
    queuedAt: "2026-07-14T00:00:00.000Z",
  }));
  return {
    listPlaylists: async () => ({
      items: [playlist()],
      providers: [
        { provider: "spotify", connected: true, displayName: "tester" },
        { provider: "soundcloud", connected: false },
      ],
    }),
    getTracks: async () => [track("one", "Alpha", 1), track("two", "Zulu", 2)],
    mutate,
  };
}

describe("hosted playlist HTTP routes", () => {
  it("resolves relative SoundCloud HLS resources against the signed upstream manifest", () => {
    expect(
      absolutizeHlsManifest(
        '#EXTM3U\n#EXT-X-MAP:URI="init.mp4?token=x"\nsegment.m4s?token=x\n',
        "https://playback.media-streaming.soundcloud.cloud/track/playlist.m3u8?token=x",
      ),
    ).toBe(
      '#EXTM3U\n#EXT-X-MAP:URI="https://playback.media-streaming.soundcloud.cloud/track/init.mp4?token=x"\nhttps://playback.media-streaming.soundcloud.cloud/track/segment.m4s?token=x\n',
    );
  });

  it("lists provider playlists and pages sorted hosted tracks", async () => {
    const hosted = hostedApi();
    const server = await startLibraryServer({
      api: localApi(),
      hosted,
      staticDirectory: staticDirectory(),
      port: 0,
    });
    servers.push(server);

    const catalog = await fetch(`${server.url}api/hosted-playlists`).then((response) =>
      response.json(),
    );
    expect(catalog).toMatchObject({
      items: [{ name: "Remote" }],
      providers: [
        { provider: "spotify", connected: true },
        { provider: "soundcloud", connected: false },
      ],
    });

    const tracks = await fetch(
      `${server.url}api/tracks?playlistId=hosted%3Aspotify%3AcGxheWxpc3Q&sort=title&direction=desc&limit=1`,
    ).then((response) => response.json());
    expect(tracks).toMatchObject({ count: 2, limit: 1, items: [{ title: "Zulu" }] });
  });

  it("protects hosted writes with the session token", async () => {
    const hosted = hostedApi();
    const server = await startLibraryServer({
      api: localApi(),
      hosted,
      staticDirectory: staticDirectory(),
      port: 0,
    });
    servers.push(server);
    const mutation: HostedPlaylistMutation = {
      type: "set-hosted-playlist-download",
      playlistId: playlist().id,
      enabled: true,
    };

    const forbidden = await fetch(`${server.url}api/hosted-mutations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mutation),
    });
    expect(forbidden.status).toBe(403);

    const committed = await fetch(`${server.url}api/hosted-mutations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-music-library-token": server.token,
      },
      body: JSON.stringify(mutation),
    });
    expect(committed.status).toBe(200);
    expect(hosted.mutate).toHaveBeenCalledWith(mutation);
  });

  it("hands committed local playlist edits to the hosted background mirror", async () => {
    const local = localApi();
    const hosted = hostedApi();
    hosted.mirrorLocalMutation = vi.fn();
    const server = await startLibraryServer({
      api: local,
      hosted,
      staticDirectory: staticDirectory(),
      port: 0,
    });
    servers.push(server);
    const mutation = {
      type: "rename-playlist" as const,
      playlistId: "local-playlist",
      name: "Renamed locally",
    };

    const response = await fetch(`${server.url}api/mutations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-music-library-token": server.token,
      },
      body: JSON.stringify(mutation),
    });

    expect(response.status).toBe(200);
    expect(hosted.mirrorLocalMutation).toHaveBeenCalledWith(mutation, local);
    expect(hosted.mutate).not.toHaveBeenCalled();
  });

  it("proxies only local-page hosted manifests and rewrites relative HLS URLs", async () => {
    const hosted = hostedApi();
    hosted.streamTrack = vi.fn(async () => {
      const manifest = new Response('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\npart.m4s\n', {
        headers: { "content-type": "application/vnd.apple.mpegurl" },
      });
      Object.defineProperty(manifest, "url", {
        value: "https://playback.media-streaming.soundcloud.cloud/audio/playlist.m3u8",
      });
      return manifest;
    });
    const server = await startLibraryServer({
      api: localApi(),
      hosted,
      staticDirectory: staticDirectory(),
      port: 0,
    });
    servers.push(server);
    const id = encodeURIComponent("hosted-track:soundcloud:soundcloud%3Atracks%3A1");

    const rejected = await fetch(`${server.url}api/hosted-audio/${id}`, {
      headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    });
    expect(rejected.status).toBe(403);
    expect(hosted.streamTrack).not.toHaveBeenCalled();

    const response = await fetch(`${server.url}api/hosted-audio/${id}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(
      "https://playback.media-streaming.soundcloud.cloud/audio/part.m4s",
    );
  });

  it("publishes hosted acquisition changes and releases the runtime subscription", async () => {
    const hosted = hostedApi();
    let jobListener: ((event: { playlistId: string }) => void) | undefined;
    const unsubscribe = vi.fn();
    hosted.onJobChanged = vi.fn((listener) => {
      jobListener = listener;
      return unsubscribe;
    });
    const server = await startLibraryServer({
      api: localApi(),
      hosted,
      staticDirectory: staticDirectory(),
      port: 0,
    });
    servers.push(server);

    const events = await fetch(`${server.url}api/events`);
    const reader = events.body!.getReader();
    const decoder = new TextDecoder();
    const connected = await reader.read();
    expect(decoder.decode(connected.value)).toContain('"type":"connected"');

    jobListener?.({ playlistId: playlist().id });
    const changed = await reader.read();
    const payload = decoder.decode(changed.value);
    expect(payload).toContain('"type":"hosted-job"');
    expect(payload).toContain(`"changedId":"${playlist().id}"`);

    await reader.cancel();
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("returns a conflict without leaking provider internals", async () => {
    const hosted = hostedApi();
    hosted.mutate.mockRejectedValueOnce(
      new HostedPlaylistConflictError({
        playlistId: playlist().id,
        expectedRevision: "spotify:old",
        actualRevision: "spotify:new",
      }),
    );
    const server = await startLibraryServer({
      api: localApi(),
      hosted,
      staticDirectory: staticDirectory(),
      port: 0,
    });
    servers.push(server);
    const response = await fetch(`${server.url}api/hosted-mutations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-music-library-token": server.token,
      },
      body: JSON.stringify({
        type: "rename-hosted-playlist",
        playlistId: playlist().id,
        name: "Changed",
        expectedRevision: "spotify:old",
      }),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "HOSTED_PLAYLIST_CONFLICT" },
    });
  });
});
