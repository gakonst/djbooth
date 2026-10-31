import type { TrackSummary, TrackWaveform } from "../shared/types.js";

type PublishedTrack = Partial<TrackSummary> & {
  id: string;
  mediaHash?: string;
  waveform?: Omit<TrackWaveform, "beatGrid"> & {
    beatGrid?: { times: number[]; beats: number[] };
  };
};
type Collection = {
  id: string;
  name: string;
  trackIDs: string[];
  folders?: { id: string; name: string }[];
};
type Snapshot = { tracks: Map<string, PublishedTrack>; collections: Map<string, Collection> };
let snapshot: Promise<Snapshot> | undefined;
let loadedAt = 0;
const media = new Map<string, string>();
let editorToken: string | undefined;
let editorPrompt: Promise<string> | undefined;

function requestEditorToken(): Promise<string> {
  if (editorToken) return Promise.resolve(editorToken);
  if (editorPrompt) return editorPrompt;
  editorPrompt = new Promise<string>((resolve, reject) => {
    const dialog = document.createElement("dialog");
    dialog.setAttribute("aria-label", "Edit shared playlists");
    dialog.innerHTML =
      '<form method="dialog"><h2>Edit shared playlists</h2><p>Enter the private publishing token to edit this library. It stays in memory for this tab.</p><label>Publishing token <input name="token" type="password" autocomplete="off" required /></label><p><button value="save">Continue</button> <button value="cancel" formnovalidate>Cancel</button></p></form>';
    dialog.style.cssText =
      "max-width:420px;padding:24px;background:#17191e;color:#eee;border:1px solid #555;border-radius:12px";
    dialog.addEventListener(
      "close",
      () => {
        const input = dialog.querySelector("input")!;
        const token = input.value.trim();
        input.value = "";
        dialog.remove();
        if (dialog.returnValue === "save" && token) {
          editorToken = token;
          resolve(token);
        } else reject(new Error("Playlist edit canceled."));
      },
      { once: true },
    );
    document.body.append(dialog);
    dialog.showModal();
  }).finally(() => {
    editorPrompt = undefined;
  });
  return editorPrompt;
}

/** Operator edits use the same versioned sync protocol as native clients. */
export async function cloudAppendPlaylistTracks(
  playlistId: string,
  trackIds: string[],
): Promise<void> {
  const token = await requestEditorToken();
  const library = await load();
  if (!trackIds.length || trackIds.some((id) => !library.tracks.has(id)))
    throw new Error("Only tracks in the shared library can be added.");
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await fetch(`/v1/library?collection=${encodeURIComponent(playlistId)}`);
    if (!current.ok) throw new Error(`Playlist unavailable (${current.status}).`);
    const { collection, version } = (await current.json()) as {
      collection: Collection | null;
      version: number;
    };
    if (!collection) throw new Error("Playlist is no longer available.");
    const additions = [...new Set(trackIds)].filter((id) => !collection.trackIDs.includes(id));
    if (!additions.length) return;
    const response = await fetch("/v1/sync/changes", {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        operationID: crypto.randomUUID(),
        kind: "collection",
        entityID: playlistId,
        baseVersion: version,
        payload: JSON.stringify({
          ...collection,
          trackIDs: [...collection.trackIDs, ...additions],
        }),
        deleted: false,
      }),
    });
    if (response.status === 401) editorToken = undefined;
    if (response.status === 409) continue;
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? "Publishing token was not accepted. Try the drop again."
          : `Playlist edit failed (${response.status}).`,
      );
    snapshot = undefined;
    return;
  }
  throw new Error("Playlist changed during the edit. Please try again.");
}

export function isCloudWorkstation(): boolean {
  return window.location.pathname.startsWith("/workstation/");
}

export function cloudAudioUrl(id: string): string | undefined {
  const hash = media.get(id);
  return hash ? `/v1/media/${encodeURIComponent(hash)}` : undefined;
}

async function load(): Promise<Snapshot> {
  if (snapshot && Date.now() - loadedAt < 30_000) return snapshot;
  loadedAt = Date.now();
  snapshot = (async () => {
    const tracks = new Map<string, PublishedTrack>();
    const collections = new Map<string, Collection>();
    let after = 0;
    let compact = true;
    for (;;) {
      const response = await fetch(
        compact
          ? `/v1/library?after=${after}`
          : `/v1/sync/changes?after=${after}&kinds=track,collection`,
      );
      if (compact && response.status === 404) {
        compact = false;
        continue;
      }
      if (!response.ok) throw new Error(`Shared library unavailable (${response.status})`);
      const page = (await response.json()) as {
        items?: ({ kind: string } & (PublishedTrack | Collection))[];
        changes?: { kind: string; entityID: string; payload: string | null; deleted: boolean }[];
        cursor: number;
        hasMore: boolean;
      };
      for (const item of page.items ?? []) {
        if (item.kind === "track") tracks.set(item.id, item as PublishedTrack);
        else collections.set(item.id, item as Collection);
      }
      for (const change of page.changes ?? []) {
        if (change.deleted) {
          (change.kind === "track" ? tracks : collections).delete(change.entityID);
        } else if (change.payload) {
          const value = { ...JSON.parse(change.payload), id: change.entityID };
          if (change.kind === "track") tracks.set(change.entityID, value);
          else collections.set(change.entityID, value);
        }
      }
      if (!page.hasMore) break;
      if (page.cursor <= after) throw new Error("Shared library sync did not advance");
      after = page.cursor;
    }
    media.clear();
    for (const track of tracks.values()) if (track.mediaHash) media.set(track.id, track.mediaHash);
    return { tracks, collections };
  })().catch((error: unknown) => {
    snapshot = undefined;
    throw error;
  });
  return snapshot;
}

function summary(track: PublishedTrack): TrackSummary {
  return {
    id: track.id,
    title: track.title ?? "Untitled",
    artist: track.artist ?? null,
    album: track.album ?? null,
    genre: track.genre ?? null,
    key: track.key ?? null,
    colorId: track.colorId ?? null,
    bpm: track.bpm ?? null,
    durationSeconds: track.durationSeconds ?? null,
    rating: track.rating ?? 0,
    playCount: track.playCount ?? 0,
    analyzed: track.analyzed ?? false,
    artworkAvailable: false,
    fileExists: !!track.mediaHash,
    path: null,
  };
}

/** Adapt the published sync contract to the existing workstation's read model. */
export async function cloudLibraryRequest<T>(path: string, init: RequestInit): Promise<T> {
  if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (init.method && init.method !== "GET") {
    throw new Error(
      "Shared library is read-only. Connect the local workstation to edit or process tracks.",
    );
  }
  const url = new URL(path, location.origin);
  if (url.pathname === "/api/assistant/auth")
    return {
      mode: "unavailable",
      message: "Connect your local workstation to use your private assistant and music accounts.",
    } as T;
  if (url.pathname === "/api/hosted-playlists") return { providers: [], items: [] } as T;
  if (url.pathname === "/api/usb-media") return { devices: [], playlists: [] } as T;
  if (url.pathname === "/api/processing/jobs") return { items: [] } as T;
  const { tracks, collections } = await load();
  const all = [...tracks.values()].map(summary);
  if (url.pathname === "/api/bootstrap")
    return {
      csrfToken: "",
      library: {
        dbPath: "Shared cloud library",
        dbDirectory: "",
        writeEnabled: false,
        stats: {
          tracks: all.length,
          playlists: collections.size,
          folders: 0,
          analyzed: all.filter((t) => t.analyzed).length,
          missingAnalysis: all.filter((t) => !t.analyzed).length,
          missingBpm: all.filter((t) => !t.bpm).length,
          missingKey: all.filter((t) => !t.key).length,
        },
      },
    } as T;
  if (url.pathname === "/api/playlists") {
    const folders = new Map<
      string,
      { id: string; name: string; parentId: string; seq: number; type: string; trackCount: number }
    >();
    for (const collection of collections.values()) {
      let parentId = "root";
      for (const folder of collection.folders ?? []) {
        folders.set(folder.id, {
          ...folder,
          parentId,
          seq: folders.size,
          type: "folder",
          trackCount: 0,
        });
        parentId = folder.id;
      }
    }
    return {
      items: [
        ...folders.values(),
        ...[...collections.values()].map((c, seq) => ({
          id: c.id,
          name: c.name,
          parentId: c.folders?.at(-1)?.id ?? "root",
          seq,
          type: "playlist",
          trackCount: c.trackIDs.length,
        })),
      ],
    } as T;
  }
  if (url.pathname === "/api/tracks") {
    const playlist = url.searchParams.get("playlistId");
    let items = playlist
      ? (collections.get(playlist)?.trackIDs ?? []).flatMap((id, index) => {
          const track = tracks.get(id);
          return track
            ? [
                {
                  ...summary(track),
                  trackNumber: index + 1,
                  playlistMembershipId: `${playlist}:${index}`,
                },
              ]
            : [];
        })
      : all;
    const query = url.searchParams.get("q")?.toLocaleLowerCase();
    if (query)
      items = items.filter((t) =>
        `${t.title} ${t.artist} ${t.album} ${t.genre}`.toLocaleLowerCase().includes(query),
      );
    const filter = url.searchParams.get("filter");
    if (filter === "analyzed") items = items.filter((t) => t.analyzed);
    if (filter === "attention") items = items.filter((t) => !t.analyzed || !t.bpm || !t.key);
    const sort = url.searchParams.get("sort");
    if (sort && sort !== "position") {
      const field = ({ plays: "playCount", duration: "durationSeconds", status: "analyzed" }[
        sort
      ] ?? sort) as keyof TrackSummary;
      const direction = url.searchParams.get("direction") === "desc" ? -1 : 1;
      items.sort((a, b) => {
        const av = a[field],
          bv = b[field];
        return (
          direction *
          (typeof av === "number" && typeof bv === "number"
            ? av - bv
            : String(av ?? "").localeCompare(String(bv ?? "")))
        );
      });
    }
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const limit = Math.min(10_000, Math.max(1, Number(url.searchParams.get("limit")) || 100));
    return { items: items.slice(offset, offset + limit), count: items.length, offset, limit } as T;
  }
  const match = /^\/api\/(tracks|waveforms)\/([^/]+)$/.exec(url.pathname);
  if (match) {
    const id = decodeURIComponent(match[2]!);
    const track = tracks.get(id);
    if (!track) throw new Error("Track is no longer in the shared library");
    if (match[1] === "waveforms") {
      if (!track.waveform) {
        const response = await fetch(`/v1/library?track=${encodeURIComponent(id)}`, {
          signal: init.signal,
        });
        if (response.ok) {
          const detail = (await response.json()) as { track: PublishedTrack | null };
          if (detail.track?.waveform) track.waveform = detail.track.waveform;
        } else if (response.status !== 404) {
          throw new Error(`Published waveform unavailable (${response.status})`);
        }
      }
      const wave = track.waveform;
      return {
        waveform: wave
          ? {
              ...wave,
              beatGrid: wave.beatGrid?.times.map((timeSeconds, i) => ({
                timeSeconds,
                beat: wave.beatGrid!.beats[i],
              })),
            }
          : {
              durationSeconds: track.durationSeconds ?? null,
              peaks: [],
              source: "placeholder",
            },
      } as T;
    }
    return {
      track: {
        ...summary(track),
        revision: "published",
        comment: null,
        isrc: null,
        releaseYear: null,
        bitRate: null,
        sampleRate: null,
        fileSize: null,
        analysisPath: null,
        cues: [],
        playlists: [...collections.values()]
          .filter((c) => c.trackIDs.includes(id))
          .map((c) => ({
            id: c.id,
            name: c.name,
            membershipId: `${c.id}:${c.trackIDs.indexOf(id)}`,
            trackNumber: c.trackIDs.indexOf(id) + 1,
          })),
      },
    } as T;
  }
  throw new Error(`This feature requires the local workstation (${url.pathname})`);
}
