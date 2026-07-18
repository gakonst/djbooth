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
  HostedTrackStreamUnavailableError,
  assertExpectedRevision,
  isNotFoundError,
} from "./types.js";
import type {
  HostedAdapterListResult,
  HostedPlaylistProviderAdapter,
  HostedTrackStream,
  HostedTrackStreamRequest,
} from "./types.js";

type RawQueryValue = string | number | boolean | readonly (string | number | boolean)[] | undefined;

type RawRequestOptions = {
  body?: Record<string, unknown> | readonly unknown[] | null;
  query?: Record<string, RawQueryValue>;
  signal?: AbortSignal;
};

export interface SoundCloudHostedClient {
  raw<T = unknown>(
    method: string,
    path: string,
    options?: RawRequestOptions,
  ): Promise<T | undefined>;
  getPlaylist(reference: string, options?: { signal?: AbortSignal }): Promise<unknown>;
  updatePlaylist(
    reference: string,
    input: { title?: string; tracks?: readonly string[]; signal?: AbortSignal },
  ): Promise<unknown>;
  deletePlaylist(reference: string, options?: { signal?: AbortSignal }): Promise<unknown>;
  fetch?(request: Request): Promise<Response>;
}

type SoundCloudIdentity = {
  urn: string;
  displayName?: string;
};

type SoundCloudCollection = {
  collection?: unknown[] | null;
  next_href?: string | null;
};

export type SoundCloudHostedPlaylistAdapterOptions = {
  /** Include liked playlists after owned playlists. They remain read-only. Defaults to true. */
  includeLikedPlaylists?: boolean;
  /** Fetch signed SoundCloud CDN manifests. Injectable so tests never request media. */
  fetchMedia?: typeof globalThis.fetch;
};

export class SoundCloudHostedPlaylistAdapter implements HostedPlaylistProviderAdapter {
  readonly provider = "soundcloud" as const;
  readonly #client: SoundCloudHostedClient;
  readonly #includeLikedPlaylists: boolean;
  readonly #fetchMedia: typeof globalThis.fetch;
  readonly #incompletePlaylists = new Set<string>();
  readonly #streamSecrets = new Map<string, string>();
  #identityPromise: Promise<SoundCloudIdentity> | undefined;

  constructor(
    client: SoundCloudHostedClient,
    options: SoundCloudHostedPlaylistAdapterOptions = {},
  ) {
    this.#client = client;
    this.#includeLikedPlaylists = options.includeLikedPlaylists ?? true;
    this.#fetchMedia = options.fetchMedia ?? globalThis.fetch;
  }

  async listPlaylists(): Promise<HostedAdapterListResult> {
    const identity = await this.#identity();
    const owned = await this.#allPlaylistObjects("/me/playlists", {
      limit: 200,
      show_tracks: false,
    });
    const records = new Map<string, { owned: boolean; playlist: Record<string, unknown> }>();
    for (const playlist of owned) {
      const urn = soundCloudPlaylistUrn(playlist);
      if (urn) records.set(urn, { owned: true, playlist });
    }

    if (this.#includeLikedPlaylists) {
      const liked = await this.#allPlaylistObjects("/me/likes/playlists", { limit: 200 }).catch(
        () => [],
      );
      for (const playlist of liked) {
        const urn = soundCloudPlaylistUrn(playlist);
        if (urn && !records.has(urn)) records.set(urn, { owned: false, playlist });
      }
    }

    const items: PlaylistItem[] = [];
    for (const entry of records.values()) {
      const ownerUrn = soundCloudPlaylistOwnerUrn(entry.playlist);
      const ownedByCurrentUser = entry.owned || ownerUrn === identity.urn;
      const item = soundCloudPlaylistItem(entry.playlist, ownedByCurrentUser, items.length + 1);
      if (item) items.push(item);
    }
    return {
      items,
      ...(identity.displayName ? { displayName: identity.displayName } : {}),
    };
  }

  async getTracks(remotePlaylistId: string): Promise<TrackSummary[]> {
    requireSoundCloudPlaylistUrn(remotePlaylistId);
    const playlist = await this.#getPlaylist(remotePlaylistId);
    const playlistId = hostedPlaylistId(this.provider, remotePlaylistId);
    const tracksPath =
      stringField(playlist, "tracks_uri") ?? `/playlists/${remotePlaylistId}/tracks`;
    const rawTracks = await this.#allTrackObjects(tracksPath, { limit: 200 });
    const tracks: TrackSummary[] = [];
    for (const [position, rawTrack] of rawTracks.entries()) {
      const remoteTrackId = soundCloudTrackUrn(rawTrack);
      const secretToken = soundCloudTrackSecretToken(rawTrack);
      if (remoteTrackId && secretToken) this.#streamSecrets.set(remoteTrackId, secretToken);
      const track = soundCloudTrackSummary(rawTrack, playlistId, position);
      if (track) tracks.push(track);
    }
    const expectedCount = finiteInteger(playlist.track_count);
    if (
      tracks.length !== rawTracks.length ||
      (expectedCount !== null && tracks.length !== expectedCount)
    ) {
      this.#incompletePlaylists.add(remotePlaylistId);
    } else {
      this.#incompletePlaylists.delete(remotePlaylistId);
    }
    return tracks;
  }

  async streamTrack(
    remoteTrackId: string,
    request: HostedTrackStreamRequest = {},
  ): Promise<HostedTrackStream> {
    requireSoundCloudTrackUrn(remoteTrackId);
    const secretToken = this.#streamSecrets.get(remoteTrackId);
    const streams = asRecord(
      await this.#client.raw(
        "GET",
        `/tracks/${remoteTrackId}/streams`,
        secretToken ? { query: { secret_token: secretToken } } : {},
      ),
    );
    const stream = soundCloudStream(streams);
    if (!stream) {
      throw new HostedTrackStreamUnavailableError(
        `SoundCloud track ${remoteTrackId} is not streamable`,
      );
    }
    assertSoundCloudMediaUrl(stream.url);
    const headers = new Headers({ accept: "*/*" });
    if (stream.kind === "progressive" && request.range) headers.set("range", request.range);
    const mediaRequest = new Request(stream.url, {
      headers,
      redirect: "follow",
    });
    let response: Response;
    if (new URL(stream.url).hostname === "api.soundcloud.com") {
      if (!this.#client.fetch) throw new Error("Authenticated SoundCloud streaming is unavailable");
      response = await this.#client.fetch(mediaRequest);
    } else {
      response = await this.#fetchMedia(mediaRequest);
    }
    return { kind: stream.kind, response };
  }

  async createPlaylist(name: string): Promise<PlaylistItem> {
    const normalizedName = requireName(name);
    const created = asRecord(
      await this.#client.raw("POST", "/playlists", {
        body: {
          playlist: {
            title: normalizedName,
            sharing: "private",
            tracks: [],
          },
        },
      }),
    );
    const urn = soundCloudPlaylistUrn(created);
    if (!urn) throw new HostedPlaylistVerificationError("SoundCloud created no playlist URN");
    const verified = await this.#getPlaylist(urn);
    if (stringField(verified, "title") !== normalizedName) {
      throw new HostedPlaylistVerificationError("SoundCloud playlist creation verification failed");
    }
    return this.#ownedPlaylistItem(verified);
  }

  async renamePlaylist(
    remotePlaylistId: string,
    name: string,
    expectedRevision: string | null,
  ): Promise<PlaylistItem> {
    const normalizedName = requireName(name);
    const before = await this.#getOwnedPlaylist(remotePlaylistId);
    assertExpectedRevision(
      hostedPlaylistId(this.provider, remotePlaylistId),
      expectedRevision,
      soundCloudPlaylistRevision(before),
    );

    await this.#client.updatePlaylist(remotePlaylistId, { title: normalizedName });
    const verified = await this.#getPlaylist(remotePlaylistId);
    if (stringField(verified, "title") !== normalizedName) {
      throw new HostedPlaylistVerificationError("SoundCloud playlist rename verification failed");
    }
    return this.#ownedPlaylistItem(verified);
  }

  async replacePlaylistTracks(
    remotePlaylistId: string,
    remoteTrackIds: readonly string[],
    expectedRevision: string | null,
  ): Promise<PlaylistItem> {
    const trackUrns = remoteTrackIds.map(normalizeSoundCloudTrackUrn);
    const before = await this.#getOwnedPlaylist(remotePlaylistId);
    assertExpectedRevision(
      hostedPlaylistId(this.provider, remotePlaylistId),
      expectedRevision,
      soundCloudPlaylistRevision(before),
    );
    await this.getTracks(remotePlaylistId);
    if (this.#incompletePlaylists.has(remotePlaylistId)) {
      throw new HostedPlaylistCapabilityError(
        `SoundCloud playlist ${remotePlaylistId} contains unavailable items; refusing a full replacement that could delete them`,
      );
    }
    assertExpectedRevision(
      hostedPlaylistId(this.provider, remotePlaylistId),
      expectedRevision,
      soundCloudPlaylistRevision(await this.#getOwnedPlaylist(remotePlaylistId)),
    );

    await this.#client.updatePlaylist(remotePlaylistId, { tracks: trackUrns });
    const verifiedTracks = await this.getTracks(remotePlaylistId);
    const verifiedUrns = verifiedTracks.map((track) => track.hosted!.remoteId);
    if (!sameOrderedValues(verifiedUrns, trackUrns)) {
      throw new HostedPlaylistVerificationError(
        `SoundCloud playlist item verification failed: expected ${trackUrns.length}, got ${verifiedUrns.length}`,
      );
    }
    return this.#ownedPlaylistItem(await this.#getPlaylist(remotePlaylistId));
  }

  async deletePlaylist(remotePlaylistId: string, expectedRevision: string | null): Promise<void> {
    const before = await this.#getOwnedPlaylist(remotePlaylistId);
    assertExpectedRevision(
      hostedPlaylistId(this.provider, remotePlaylistId),
      expectedRevision,
      soundCloudPlaylistRevision(before),
    );

    await this.#client.deletePlaylist(remotePlaylistId);
    try {
      await this.#getPlaylist(remotePlaylistId);
    } catch (error) {
      if (isNotFoundError(error)) return;
      throw error;
    }
    throw new HostedPlaylistVerificationError(
      "SoundCloud playlist deletion verification failed: the playlist still exists",
    );
  }

  async #identity(): Promise<SoundCloudIdentity> {
    if (!this.#identityPromise) {
      this.#identityPromise = this.#client
        .raw("GET", "/me")
        .then((value) => {
          const profile = asRecord(value);
          const urn = soundCloudUserUrn(profile);
          if (!urn) throw new Error("SoundCloud profile returned no user URN");
          const displayName =
            stringField(profile, "username") ?? stringField(profile, "full_name") ?? undefined;
          return { urn, ...(displayName ? { displayName } : {}) };
        })
        .catch((error: unknown) => {
          this.#identityPromise = undefined;
          throw error;
        });
    }
    return this.#identityPromise;
  }

  async #allPlaylistObjects(
    path: string,
    query: Record<string, RawQueryValue>,
  ): Promise<Record<string, unknown>[]> {
    return this.#allObjects(path, query);
  }

  async #allTrackObjects(
    path: string,
    query: Record<string, RawQueryValue>,
  ): Promise<Record<string, unknown>[]> {
    return this.#allObjects(path, query);
  }

  async #allObjects(
    path: string,
    query: Record<string, RawQueryValue>,
  ): Promise<Record<string, unknown>[]> {
    const values: Record<string, unknown>[] = [];
    let next: string | null = path;
    let first = true;
    const seen = new Set<string>();
    while (next) {
      if (seen.has(next))
        throw new Error(`SoundCloud pagination cycle detected at ${safePath(next)}`);
      seen.add(next);
      const response: SoundCloudCollection | unknown[] | undefined = await this.#client.raw<
        SoundCloudCollection | unknown[]
      >("GET", next, first ? { query: { ...query, linked_partitioning: true } } : undefined);
      if (!response) break;
      const rawItems = Array.isArray(response) ? response : (response.collection ?? []);
      for (const rawItem of rawItems) {
        const item = asRecord(rawItem);
        if (item) values.push(item);
      }
      next =
        !Array.isArray(response) &&
        typeof response.next_href === "string" &&
        response.next_href.length > 0
          ? response.next_href
          : null;
      first = false;
    }
    return values;
  }

  async #getPlaylist(remotePlaylistId: string): Promise<Record<string, unknown>> {
    requireSoundCloudPlaylistUrn(remotePlaylistId);
    const playlist = asRecord(await this.#client.getPlaylist(remotePlaylistId));
    if (!playlist || soundCloudPlaylistUrn(playlist) !== remotePlaylistId) {
      throw new Error(`SoundCloud returned the wrong playlist for ${remotePlaylistId}`);
    }
    return playlist;
  }

  async #getOwnedPlaylist(remotePlaylistId: string): Promise<Record<string, unknown>> {
    const playlist = await this.#getPlaylist(remotePlaylistId);
    const identity = await this.#identity();
    if (soundCloudPlaylistOwnerUrn(playlist) === identity.urn) return playlist;
    throw new HostedPlaylistCapabilityError(
      `SoundCloud playlist ${remotePlaylistId} is not owned by the current user`,
    );
  }

  async #ownedPlaylistItem(playlist: Record<string, unknown>): Promise<PlaylistItem> {
    const identity = await this.#identity();
    const owned = soundCloudPlaylistOwnerUrn(playlist) === identity.urn;
    if (!owned) {
      throw new HostedPlaylistCapabilityError(
        "SoundCloud returned a playlist owned by another user",
      );
    }
    const item = soundCloudPlaylistItem(playlist, true, 1);
    if (!item) throw new Error("SoundCloud returned an invalid playlist");
    return item;
  }
}

function soundCloudPlaylistItem(
  playlist: Record<string, unknown>,
  owned: boolean,
  seq: number,
): PlaylistItem | undefined {
  const remoteId = soundCloudPlaylistUrn(playlist);
  if (!remoteId) return undefined;
  return {
    id: hostedPlaylistId("soundcloud", remoteId),
    name: stringField(playlist, "title") ?? "Untitled SoundCloud playlist",
    parentId: hostedProviderRootId("soundcloud"),
    seq,
    type: "playlist",
    trackCount: finiteInteger(playlist.track_count),
    hosted: {
      provider: "soundcloud",
      remoteId,
      revision: soundCloudPlaylistRevision(playlist),
      externalUrl: stringField(playlist, "permalink_url"),
      owned,
      capabilities: {
        itemsReadable: true,
        detailsEditable: owned,
        itemsEditable: owned,
      },
      downloadEnabled: false,
      syncState: "idle",
    },
  };
}

function soundCloudPlaylistRevision(playlist: Record<string, unknown>): string {
  return hostedRevision("soundcloud", [
    soundCloudPlaylistUrn(playlist),
    stringField(playlist, "last_modified"),
    stringField(playlist, "title"),
    finiteInteger(playlist.track_count),
    stringField(playlist, "sharing"),
  ]);
}

function soundCloudTrackSummary(
  track: Record<string, unknown>,
  playlistId: string,
  position: number,
): TrackSummary | undefined {
  const remoteId = soundCloudTrackUrn(track);
  if (!remoteId) return undefined;
  const user = asRecord(track.user);
  const publisher = asRecord(track.publisher_metadata);
  const album =
    stringField(publisher, "release_title") ??
    stringField(track, "release") ??
    stringField(track, "label_name");
  return {
    id: hostedTrackId("soundcloud", remoteId),
    title: stringField(track, "title") ?? "Unavailable SoundCloud track",
    artist:
      stringField(track, "metadata_artist") ??
      stringField(publisher, "artist") ??
      stringField(user, "username"),
    album,
    genre: stringField(track, "genre"),
    key: stringField(track, "key_signature"),
    colorId: null,
    bpm: finiteNumber(track.bpm),
    durationSeconds: millisecondsToSeconds(track.duration),
    rating: 0,
    playCount: finiteInteger(track.playback_count) ?? 0,
    analyzed: false,
    artworkAvailable: stringField(track, "artwork_url") !== null,
    fileExists: false,
    path: null,
    playlistMembershipId: hostedPlaylistMembershipId(playlistId, position),
    trackNumber: position + 1,
    hosted: {
      provider: "soundcloud",
      remoteId,
      externalUrl: stringField(track, "permalink_url"),
      localContentId: null,
      downloadState: "remote",
      ...(stringField(track, "isrc") ? { isrc: stringField(track, "isrc")! } : {}),
    },
  };
}

function soundCloudPlaylistUrn(playlist: Record<string, unknown> | undefined): string | undefined {
  const urn = stringField(playlist, "urn");
  if (urn && /^soundcloud:playlists:[^:]+$/u.test(urn)) return urn;
  const legacyId = playlist?.id;
  if (typeof legacyId === "number" && Number.isSafeInteger(legacyId) && legacyId > 0) {
    return `soundcloud:playlists:${legacyId}`;
  }
  if (typeof legacyId === "string" && /^[1-9]\d*$/u.test(legacyId)) {
    return `soundcloud:playlists:${legacyId}`;
  }
  return undefined;
}

function soundCloudTrackUrn(track: Record<string, unknown>): string | undefined {
  const urn = stringField(track, "urn");
  if (urn && /^soundcloud:tracks:[^:]+$/u.test(urn)) return urn;
  const legacyId = track.id;
  if (typeof legacyId === "number" && Number.isSafeInteger(legacyId) && legacyId > 0) {
    return `soundcloud:tracks:${legacyId}`;
  }
  if (typeof legacyId === "string" && /^[1-9]\d*$/u.test(legacyId)) {
    return `soundcloud:tracks:${legacyId}`;
  }
  return undefined;
}

function soundCloudTrackSecretToken(track: Record<string, unknown>): string | undefined {
  const token = stringField(track, "secret_token");
  if (token) return token;
  for (const field of ["secret_uri", "permalink_url"] as const) {
    const value = stringField(track, field);
    if (!value) continue;
    try {
      const fromUrl = new URL(value).searchParams.get("secret_token");
      if (fromUrl) return fromUrl;
    } catch {
      // Ignore malformed optional provider URLs.
    }
  }
  return undefined;
}

function soundCloudStream(
  streams: Record<string, unknown> | undefined,
): { kind: HostedTrackStream["kind"]; url: string } | undefined {
  for (const field of ["hls_aac_160_url", "hls_aac_96_url", "hls_mp3_128_url"] as const) {
    const url = stringField(streams, field);
    if (url) return { kind: "hls", url };
  }
  for (const field of ["http_mp3_128_url", "preview_mp3_128_url"] as const) {
    const url = stringField(streams, field);
    if (url) return { kind: "progressive", url };
  }
  return undefined;
}

function assertSoundCloudMediaUrl(value: string): void {
  const url = new URL(value);
  const allowedHost =
    url.hostname === "api.soundcloud.com" ||
    url.hostname === "soundcloud.cloud" ||
    url.hostname.endsWith(".soundcloud.cloud") ||
    url.hostname === "sndcdn.com" ||
    url.hostname.endsWith(".sndcdn.com");
  if (url.protocol !== "https:" || !allowedHost) {
    throw new Error("SoundCloud returned an untrusted media URL");
  }
}

function soundCloudUserUrn(user: Record<string, unknown> | undefined): string | undefined {
  const urn = stringField(user, "urn");
  if (urn && /^soundcloud:users:[^:]+$/u.test(urn)) return urn;
  const legacyId = user?.id;
  if (typeof legacyId === "number" && Number.isSafeInteger(legacyId) && legacyId > 0) {
    return `soundcloud:users:${legacyId}`;
  }
  if (typeof legacyId === "string" && /^[1-9]\d*$/u.test(legacyId)) {
    return `soundcloud:users:${legacyId}`;
  }
  return undefined;
}

function soundCloudPlaylistOwnerUrn(playlist: Record<string, unknown>): string | undefined {
  const userUrn = stringField(playlist, "user_urn");
  return userUrn && /^soundcloud:users:[^:]+$/u.test(userUrn)
    ? userUrn
    : soundCloudUserUrn(asRecord(playlist.user));
}

function normalizeSoundCloudTrackUrn(value: string, index: number): string {
  if (typeof value !== "string") throw new TypeError(`SoundCloud track ${index + 1} is invalid`);
  const normalized = value.trim();
  if (/^[1-9]\d*$/u.test(normalized)) return `soundcloud:tracks:${normalized}`;
  if (/^soundcloud:tracks:[^:]+$/u.test(normalized)) return normalized;
  throw new TypeError(`SoundCloud track ${index + 1} must be a SoundCloud track URN or ID`);
}

function requireSoundCloudPlaylistUrn(value: string): void {
  if (!/^soundcloud:playlists:[^:]+$/u.test(value)) {
    throw new TypeError(`Invalid SoundCloud playlist URN: ${value}`);
  }
}

function requireSoundCloudTrackUrn(value: string): void {
  if (!/^soundcloud:tracks:[^:]+$/u.test(value))
    throw new TypeError(`Invalid SoundCloud track URN: ${value}`);
}

function requireName(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("SoundCloud playlist name must not be empty");
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

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
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
