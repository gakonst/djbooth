import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DeferredLibraryEventRefresh,
  invalidateAuthoritativeTrackQueries,
  invalidateCanonicalPlaylistQueries,
  invalidateHostedPlaylistQueries,
  playlistTracksKey,
  playlistTracksQueryOptions,
  trackWaveformQueryOptions,
} from "../src/client/library-queries.js";
import type {
  LibraryEvent,
  TrackDetail,
  TrackSummary,
  TracksResponse,
} from "../src/shared/types.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("library query cache", () => {
  it("uses one canonical full-playlist key for every consumer", () => {
    expect(playlistTracksQueryOptions("playlist").queryKey).toEqual(playlistTracksKey("playlist"));
  });

  it("deduplicates concurrent player and preview waveform reads", async () => {
    let finish!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fetchMock = vi.fn(() => response);
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient();
    const options = trackWaveformQueryOptions("track-1");

    const preview = queryClient.fetchQuery(options);
    const player = queryClient.ensureQueryData(options);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish(
      new Response(
        JSON.stringify({
          waveform: { durationSeconds: 180, peaks: [0.2, 1], source: "rekordbox" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(Promise.all([preview, player])).resolves.toHaveLength(2);
    await queryClient.fetchQuery(options);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("routes USB previews through the universal analysis endpoint", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            waveform: { durationSeconds: 180, peaks: [0.2, 1], source: "rekordbox" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient();

    await queryClient.fetchQuery(trackWaveformQueryOptions("usb:device:track:42"));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/waveforms/usb%3Adevice%3Atrack%3A42",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("retries active placeholder waveforms but keeps Rekordbox peaks indefinitely", () => {
    const options = trackWaveformQueryOptions("track-1");
    const placeholder = { state: { data: { source: "placeholder" } } } as never;
    const rekordbox = { state: { data: { source: "rekordbox" } } } as never;

    expect(typeof options.staleTime).toBe("function");
    expect(typeof options.refetchInterval).toBe("function");
    expect((options.staleTime as (query: never) => number)(placeholder)).toBe(5_000);
    expect((options.refetchInterval as (query: never) => number | false)(placeholder)).toBe(5_000);
    expect((options.staleTime as (query: never) => number)(rekordbox)).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect((options.refetchInterval as (query: never) => number | false)(rekordbox)).toBe(false);
  });

  it("invalidates only authoritative caches affected by committed optimistic writes", async () => {
    const queryClient = new QueryClient();
    const one = track("one");
    const two = track("two");
    queryClient.setQueryData<TrackDetail>(["track", one.id], detail(one));
    queryClient.setQueryData<TrackDetail>(["track", two.id], detail(two));
    queryClient.setQueryData<TracksResponse>(["playlist-tracks", "one"], response([one]));
    queryClient.setQueryData<TracksResponse>(["playlist-tracks", "two"], response([two]));

    await invalidateAuthoritativeTrackQueries(queryClient, new Set([one.id]));
    expect(queryClient.getQueryState(["track", one.id])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["playlist-tracks", "one"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["track", two.id])?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(["playlist-tracks", "two"])?.isInvalidated).toBe(false);

    await invalidateCanonicalPlaylistQueries(queryClient, new Set(["two"]));
    expect(queryClient.getQueryState(["playlist-tracks", "two"])?.isInvalidated).toBe(true);
  });

  it("invalidates only the hosted playlist affected by job progress", async () => {
    const queryClient = new QueryClient();
    const one = response([track("one")]);
    const two = response([track("two")]);
    queryClient.setQueryData(["hosted-playlists"], { items: [], providers: [] });
    queryClient.setQueryData(["playlist-tracks", "hosted:spotify:one"], one);
    queryClient.setQueryData(["playlist-tracks", "hosted:spotify:two"], two);
    queryClient.setQueryData(["tracks", { playlistId: "hosted:spotify:one" }], one);
    queryClient.setQueryData(["tracks", { playlistId: "hosted:spotify:two" }], two);
    queryClient.setQueryData(["tracks", { playlistId: "local-playlist" }], two);

    await invalidateHostedPlaylistQueries(queryClient, "hosted:spotify:one");

    expect(queryClient.getQueryState(["hosted-playlists"])?.isInvalidated).toBe(true);
    expect(
      queryClient.getQueryState(["playlist-tracks", "hosted:spotify:one"])?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(["tracks", { playlistId: "hosted:spotify:one" }])?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(["playlist-tracks", "hosted:spotify:two"])?.isInvalidated,
    ).toBe(false);
    expect(
      queryClient.getQueryState(["tracks", { playlistId: "hosted:spotify:two" }])?.isInvalidated,
    ).toBe(false);
    expect(
      queryClient.getQueryState(["tracks", { playlistId: "local-playlist" }])?.isInvalidated,
    ).toBe(false);
  });

  it("flushes a suppressed mutation once after the local-write window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let blocked = true;
    let notBefore = 1_500;
    const flush = vi.fn();
    const refresh = new DeferredLibraryEventRefresh({
      flush,
      isBlocked: () => blocked,
      notBefore: () => notBefore,
    });

    refresh.defer(mutationEvent(1, "rename-playlist", "playlist-1"));
    await vi.advanceTimersByTimeAsync(250);
    expect(flush).not.toHaveBeenCalled();

    notBefore = 2_000;
    blocked = false;
    refresh.stateChanged();
    await vi.advanceTimersByTimeAsync(749);
    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith([
      expect.objectContaining({ type: "mutation", changedId: "playlist-1" }),
    ]);
  });

  it("coalesces suppressed events and lets a filesystem change dominate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const flush = vi.fn();
    const refresh = new DeferredLibraryEventRefresh({
      flush,
      isBlocked: () => false,
      notBefore: () => 1_100,
    });

    refresh.defer(mutationEvent(1, "rename-playlist", "playlist-1"));
    refresh.defer(mutationEvent(2, "rename-playlist", "playlist-1"));
    refresh.defer({ id: 3, type: "external-change", emittedAt: new Date().toISOString() });
    await vi.advanceTimersByTimeAsync(100);

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith([expect.objectContaining({ type: "external-change" })]);
  });
});

function mutationEvent(
  id: number,
  mutation: NonNullable<LibraryEvent["mutation"]>,
  changedId: string,
): LibraryEvent & { type: "mutation" } {
  return { id, type: "mutation", mutation, changedId, emittedAt: new Date().toISOString() };
}

function track(id: string): TrackSummary {
  return {
    id,
    title: id,
    artist: null,
    album: null,
    genre: null,
    colorId: null,
    key: null,
    bpm: null,
    durationSeconds: null,
    rating: 0,
    playCount: 0,
    analyzed: false,
    artworkAvailable: false,
    fileExists: true,
    path: `/music/${id}.mp3`,
  };
}

function detail(summary: TrackSummary): TrackDetail {
  return {
    ...summary,
    revision: "2026-07-12 12:00:00.000 +00:00",
    comment: null,
    isrc: null,
    releaseYear: null,
    bitRate: null,
    sampleRate: null,
    fileSize: null,
    analysisPath: null,
    cues: [],
    playlists: [],
  };
}

function response(items: TrackSummary[]): TracksResponse {
  return { items, count: items.length, limit: 10_000, offset: 0 };
}
