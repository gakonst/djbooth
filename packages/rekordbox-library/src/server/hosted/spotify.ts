import type { PlaylistItem, TrackSummary } from "../../shared/types.js";
import {
  hostedPlaylistId,
  hostedPlaylistMembershipId,
  hostedProviderRootId,
  hostedTrackId,
} from "./ids.js";
import { hostedRevision } from "./revision.js";
import {
  HostedPlaylistCapabilityError,
  HostedPlaylistVerificationError,
  assertExpectedRevision,
} from "./types.js";
import type { HostedAdapterListResult, HostedPlaylistProviderAdapter } from "./types.js";

type RawRequestOptions = {
  body?: Record<string, unknown> | readonly unknown[] | null;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
};

export interface SpotifyHostedClient {
  raw<T = unknown>(
    method: string,
    path: string,
    options?: RawRequestOptions,
  ): Promise<T | undefined>;
  getPlaylist(reference: string, options?: { signal?: AbortSignal }): Promise<unknown>;
  updatePlaylist(
    reference: string,
    options: { name?: string; tracks?: readonly string[]; signal?: AbortSignal },
  ): Promise<unknown>;
  deletePlaylist(reference: string, options?: { signal?: AbortSignal }): Promise<unknown>;
}

type SpotifyIdentity = {
  id: string;
  displayName?: string;
};

type SpotifyPage = {
  items?: unknown[] | null;
  next?: string | null;
};

export class SpotifyHostedPlaylistAdapter implements HostedPlaylistProviderAdapter {
  readonly provider = "spotify" as const;
  readonly #client: SpotifyHostedClient;
  #identityPromise: Promise<SpotifyIdentity> | undefined;

  constructor(client: SpotifyHostedClient) {
    this.#client = client;
  }

  async listPlaylists(): Promise<HostedAdapterListResult> {
    const identity = await this.#identity();
    const playlists = await this.#allPlaylistObjects();
    const items: PlaylistItem[] = [];
    for (const playlist of playlists) {
      const item = spotifyPlaylistItem(playlist, identity.id, items.length + 1);
      if (item) items.push(item);
    }
    return {
      items,
      ...(identity.displayName ? { displayName: identity.displayName } : {}),
    };
  }

  async getTracks(remotePlaylistId: string): Promise<TrackSummary[]> {
    await this.#getPlaylist(remotePlaylistId);

    const playlistId = hostedPlaylistId(this.provider, remotePlaylistId);
    const tracks: TrackSummary[] = [];
    let next: string | null = `/playlists/${encodeURIComponent(remotePlaylistId)}/items`;
    let first = true;
    let position = 0;
    const seen = new Set<string>();
    while (next) {
      if (seen.has(next)) throw new Error(`Spotify pagination cycle detected at ${safePath(next)}`);
      seen.add(next);
      const page: SpotifyPage | undefined = await this.#client.raw<SpotifyPage>(
        "GET",
        next,
        first ? { query: { limit: 100, offset: 0 } } : undefined,
      );
      if (!page) break;
      for (const rawItem of page.items ?? []) {
        const track = spotifyTrackSummary(rawItem, playlistId, position);
        position += 1;
        if (track) tracks.push(track);
      }
      next = typeof page.next === "string" && page.next.length > 0 ? page.next : null;
      first = false;
    }
    return tracks;
  }

  async createPlaylist(name: string): Promise<PlaylistItem> {
    const normalizedName = requireName(name, "Spotify");
    const created = asRecord(
      await this.#client.raw("POST", "/me/playlists", {
        body: { name: normalizedName, public: false, collaborative: false },
      }),
    );
    const remoteId = stringField(created, "id");
    if (!remoteId) throw new HostedPlaylistVerificationError("Spotify created no playlist ID");
    const verified = await this.#getPlaylist(remoteId);
    if (stringField(verified, "name") !== normalizedName) {
      throw new HostedPlaylistVerificationError("Spotify playlist creation verification failed");
    }
    return this.#editablePlaylistItem(verified);
  }

  async renamePlaylist(
    remotePlaylistId: string,
    name: string,
    expectedRevision: string | null,
  ): Promise<PlaylistItem> {
    const normalizedName = requireName(name, "Spotify");
    const before = await this.#getPlaylist(remotePlaylistId);
    await this.#assertEditable(before, remotePlaylistId, "details");
    assertExpectedRevision(
      hostedPlaylistId(this.provider, remotePlaylistId),
      expectedRevision,
      spotifyPlaylistRevision(before),
    );

    await this.#client.updatePlaylist(remotePlaylistId, { name: normalizedName });
    const verified = await this.#getPlaylist(remotePlaylistId);
    if (stringField(verified, "name") !== normalizedName) {
      throw new HostedPlaylistVerificationError("Spotify playlist rename verification failed");
    }
    return this.#editablePlaylistItem(verified);
  }

  async replacePlaylistTracks(
    remotePlaylistId: string,
    remoteTrackIds: readonly string[],
    expectedRevision: string | null,
  ): Promise<PlaylistItem> {
    const trackUris = remoteTrackIds.map(normalizeSpotifyTrackUri);
    const before = await this.#getPlaylist(remotePlaylistId);
    await this.#assertEditable(before, remotePlaylistId, "items");
    assertExpectedRevision(
      hostedPlaylistId(this.provider, remotePlaylistId),
      expectedRevision,
      spotifyPlaylistRevision(before),
    );

    await this.#client.updatePlaylist(remotePlaylistId, { tracks: trackUris });
    const verifiedTracks = await this.getTracks(remotePlaylistId);
    const verifiedUris = verifiedTracks.map((track) => track.hosted!.remoteId);
    if (!sameOrderedValues(verifiedUris, trackUris)) {
      throw new HostedPlaylistVerificationError(
        `Spotify playlist item verification failed: expected ${trackUris.length}, got ${verifiedUris.length}`,
      );
    }
    return this.#editablePlaylistItem(await this.#getPlaylist(remotePlaylistId));
  }

  async deletePlaylist(remotePlaylistId: string, expectedRevision: string | null): Promise<void> {
    const before = await this.#getPlaylist(remotePlaylistId);
    await this.#assertEditable(before, remotePlaylistId, "details");
    assertExpectedRevision(
      hostedPlaylistId(this.provider, remotePlaylistId),
      expectedRevision,
      spotifyPlaylistRevision(before),
    );

    await this.#client.deletePlaylist(remotePlaylistId);
    const remainsInLibrary = (await this.#allPlaylistObjects()).some(
      (playlist) => stringField(playlist, "id") === remotePlaylistId,
    );
    if (remainsInLibrary) {
      throw new HostedPlaylistVerificationError(
        "Spotify playlist removal verification failed: it remains in the user's library",
      );
    }
  }

  async #identity(): Promise<SpotifyIdentity> {
    if (!this.#identityPromise) {
      this.#identityPromise = this.#client
        .raw("GET", "/me")
        .then((value) => {
          const profile = asRecord(value);
          const id = stringField(profile, "id");
          if (!id) throw new Error("Spotify profile returned no user ID");
          const displayName = stringField(profile, "display_name");
          return { id, ...(displayName ? { displayName } : {}) };
        })
        .catch((error: unknown) => {
          this.#identityPromise = undefined;
          throw error;
        });
    }
    return this.#identityPromise;
  }

  async #allPlaylistObjects(): Promise<Record<string, unknown>[]> {
    const playlists: Record<string, unknown>[] = [];
    let next: string | null = "/me/playlists";
    let first = true;
    const seen = new Set<string>();
    while (next) {
      if (seen.has(next)) throw new Error(`Spotify pagination cycle detected at ${safePath(next)}`);
      seen.add(next);
      const page: SpotifyPage | undefined = await this.#client.raw<SpotifyPage>(
        "GET",
        next,
        first ? { query: { limit: 50, offset: 0 } } : undefined,
      );
      if (!page) break;
      for (const item of page.items ?? []) {
        const playlist = asRecord(item);
        if (playlist) playlists.push(playlist);
      }
      next = typeof page.next === "string" && page.next.length > 0 ? page.next : null;
      first = false;
    }
    return playlists;
  }

  async #getPlaylist(remotePlaylistId: string): Promise<Record<string, unknown>> {
    requireSpotifyPlaylistId(remotePlaylistId);
    const playlist = asRecord(await this.#client.getPlaylist(remotePlaylistId));
    if (!playlist || stringField(playlist, "id") !== remotePlaylistId) {
      throw new Error(`Spotify returned the wrong playlist for ${remotePlaylistId}`);
    }
    return playlist;
  }

  async #assertEditable(
    playlist: Record<string, unknown>,
    remotePlaylistId: string,
    capability: "details" | "items",
  ): Promise<void> {
    const capabilities = spotifyCapabilities(playlist, (await this.#identity()).id);
    if (capability === "details" ? capabilities.detailsEditable : capabilities.itemsEditable)
      return;
    throw new HostedPlaylistCapabilityError(
      capability === "details"
        ? `Spotify playlist ${remotePlaylistId} is not owned by the current user`
        : `Spotify playlist ${remotePlaylistId} is not owned by or collaborative with the current user`,
    );
  }

  async #editablePlaylistItem(playlist: Record<string, unknown>): Promise<PlaylistItem> {
    const item = spotifyPlaylistItem(playlist, (await this.#identity()).id, 1);
    if (!item) throw new Error("Spotify returned an invalid playlist");
    return item;
  }
}

function spotifyPlaylistItem(
  playlist: Record<string, unknown>,
  currentUserId: string,
  seq: number,
): PlaylistItem | undefined {
  const remoteId = stringField(playlist, "id");
  if (!remoteId) return undefined;
  const capabilities = spotifyCapabilities(playlist, currentUserId);
  const owner = asRecord(playlist.owner);
  const owned = stringField(owner, "id") === currentUserId;
  const items = asRecord(playlist.items) ?? asRecord(playlist.tracks);
  const trackCount = finiteInteger(items?.total);
  return {
    id: hostedPlaylistId("spotify", remoteId),
    name: stringField(playlist, "name") ?? "Untitled Spotify playlist",
    parentId: hostedProviderRootId("spotify"),
    seq,
    type: "playlist",
    trackCount,
    hosted: {
      provider: "spotify",
      remoteId,
      revision: spotifyPlaylistRevision(playlist),
      externalUrl: stringField(asRecord(playlist.external_urls), "spotify"),
      owned,
      capabilities,
      downloadEnabled: false,
      syncState: "idle",
    },
  };
}

function spotifyCapabilities(playlist: Record<string, unknown>, currentUserId: string) {
  const owned = stringField(asRecord(playlist.owner), "id") === currentUserId;
  const itemsEditable = owned || playlist.collaborative === true;
  return {
    itemsReadable: true,
    detailsEditable: owned,
    itemsEditable,
  };
}

function spotifyPlaylistRevision(playlist: Record<string, unknown>): string {
  return hostedRevision("spotify", [
    stringField(playlist, "id"),
    stringField(playlist, "snapshot_id"),
    stringField(playlist, "name"),
    playlist.public === true ? true : playlist.public === false ? false : null,
    playlist.collaborative === true,
  ]);
}

function spotifyTrackSummary(
  rawItem: unknown,
  playlistId: string,
  position: number,
): TrackSummary | undefined {
  const item = asRecord(rawItem);
  const track = asRecord(item?.item) ?? asRecord(item?.track);
  if (!track) return undefined;
  const remoteId = stringField(track, "uri");
  if (!remoteId || !/^spotify:track:[0-9A-Za-z]+$/u.test(remoteId)) return undefined;
  if (track.type !== undefined && track.type !== "track") return undefined;

  const artists = Array.isArray(track.artists)
    ? track.artists
        .map((artist) => stringField(asRecord(artist), "name"))
        .filter((name): name is string => Boolean(name))
    : [];
  const album = asRecord(track.album);
  const albumArtists = Array.isArray(album?.artists)
    ? album.artists
        .map((artist) => stringField(asRecord(artist), "name"))
        .filter((name): name is string => Boolean(name))
    : [];
  const images = Array.isArray(album?.images) ? album.images : [];
  return {
    id: hostedTrackId("spotify", remoteId),
    title: stringField(track, "name") ?? "Unavailable Spotify track",
    artist: artists.length > 0 ? artists.join(", ") : null,
    album: stringField(album, "name"),
    genre: null,
    key: null,
    colorId: null,
    bpm: null,
    durationSeconds: millisecondsToSeconds(track.duration_ms),
    rating: 0,
    playCount: 0,
    analyzed: false,
    artworkAvailable: images.length > 0,
    fileExists: false,
    path: null,
    playlistMembershipId: hostedPlaylistMembershipId(playlistId, position),
    trackNumber: position + 1,
    hosted: {
      provider: "spotify",
      remoteId,
      externalUrl: stringField(asRecord(track.external_urls), "spotify"),
      localContentId: null,
      downloadState: "remote",
      ...(stringField(asRecord(track.external_ids), "isrc")
        ? { isrc: stringField(asRecord(track.external_ids), "isrc")! }
        : {}),
      ...(stringField(album, "release_date")
        ? { releaseDate: stringField(album, "release_date")! }
        : {}),
      ...(albumArtists.length ? { albumArtists } : {}),
      ...(typeof track.explicit === "boolean" ? { explicit: track.explicit } : {}),
    },
  };
}

function normalizeSpotifyTrackUri(value: string, index: number): string {
  if (typeof value !== "string") throw new TypeError(`Spotify track ${index + 1} is invalid`);
  const normalized = value.trim();
  if (/^[0-9A-Za-z]+$/u.test(normalized)) return `spotify:track:${normalized}`;
  if (/^spotify:track:[0-9A-Za-z]+$/u.test(normalized)) return normalized;
  throw new TypeError(`Spotify track ${index + 1} must be a Spotify track URI or ID`);
}

function requireSpotifyPlaylistId(value: string): void {
  if (!/^[0-9A-Za-z]+$/u.test(value)) throw new TypeError(`Invalid Spotify playlist ID: ${value}`);
}

function requireName(value: string, provider: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${provider} playlist name must not be empty`);
  }
  return value.trim();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | null {
  const field = value?.[key];
  return typeof field === "string" && field.length > 0 ? field : null;
}

function finiteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function millisecondsToSeconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value / 1_000 : null;
}

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function safePath(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.split("?")[0]!;
  }
}
