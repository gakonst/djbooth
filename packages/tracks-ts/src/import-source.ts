import type { SoundCloudClient, SoundCloudPlaylist, SoundCloudTrack } from "@gakonst/soundcloud";

import type { SpotifyRawClient } from "./integrations/spotify-cache.js";
import {
  buildProviderPlaylistManifest,
  type SoundCloudProviderPlaylistTrack,
  type SpotifyProviderPlaylistTrack,
} from "./provider-playlist-manifest.js";
import type { SetManifest } from "./manifest.js";
import { TracksError } from "./errors.js";

export type ImportSourceKind = "dj-set" | "soundcloud-playlist" | "spotify-playlist";

export type PreparedImportSource = {
  kind: Exclude<ImportSourceKind, "dj-set">;
  manifest: SetManifest;
};

type SpotifyPlaylist = {
  id?: string;
  name?: string;
  external_urls?: { spotify?: string };
  owner?: { display_name?: string | null; id?: string };
  items?: SpotifyPlaylistPage;
  tracks?: SpotifyPlaylistPage;
};

type SpotifyPlaylistPage = {
  items?: SpotifyPlaylistItem[];
  next?: string | null;
  offset?: number;
  limit?: number;
  total?: number;
};

type SpotifyPlaylistItem = {
  item?: SpotifyTrack;
  track?: SpotifyTrack;
};

type SpotifyTrack = {
  id?: string;
  uri?: string;
  name?: string;
  type?: string;
  duration_ms?: number;
  explicit?: boolean;
  artists?: Array<{ name?: string }>;
  album?: {
    name?: string;
    release_date?: string;
    artists?: Array<{ name?: string }>;
  };
  external_ids?: { isrc?: string };
  external_urls?: { spotify?: string };
};

export async function prepareHostedImportSource(
  source: string,
  clients: {
    spotify?: SpotifyRawClient;
    soundcloud?: SoundCloudClient;
    createSoundcloud?(): Promise<SoundCloudClient>;
    signal?: AbortSignal;
  },
): Promise<PreparedImportSource | undefined> {
  const spotifyId = spotifyPlaylistId(source);
  if (spotifyId) {
    if (!clients.spotify)
      throw new TracksError(
        "AUTH_REQUIRED",
        "Spotify playlist import requires a Spotify session; run `spots auth login`",
        { exitCode: 2 },
      );
    return prepareSpotifyPlaylist(source, spotifyId, clients.spotify, clients.signal);
  }

  if (!isSoundCloudPlaylistSource(source)) return undefined;
  const soundcloud = clients.soundcloud ?? (await clients.createSoundcloud?.());
  if (!soundcloud) throw new Error("SoundCloud playlist import requires a SoundCloud user client");
  return prepareSoundCloudPlaylist(source, soundcloud, clients.signal);
}

function spotifyPlaylistId(source: string): string | undefined {
  const value = source.trim();
  const uri = /^spotify:playlist:([0-9A-Za-z]+)$/u.exec(value);
  if (uri) return uri[1];
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.hostname !== "open.spotify.com") return undefined;
  const parts = url.pathname.split("/").filter(Boolean);
  const playlistIndex = parts.indexOf("playlist");
  const id = playlistIndex < 0 ? undefined : parts[playlistIndex + 1];
  return id && /^[0-9A-Za-z]+$/u.test(id) ? id : undefined;
}

function isSoundCloudPlaylistSource(source: string): boolean {
  if (/^soundcloud:playlists:[^:]+$/u.test(source.trim())) return true;
  try {
    const url = new URL(source);
    return (
      ["soundcloud.com", "www.soundcloud.com", "on.soundcloud.com"].includes(url.hostname) &&
      url.pathname.split("/").includes("sets")
    );
  } catch {
    return false;
  }
}

async function prepareSpotifyPlaylist(
  requestedSource: string,
  playlistId: string,
  client: SpotifyRawClient,
  signal?: AbortSignal,
): Promise<PreparedImportSource> {
  const playlist = await client.raw<SpotifyPlaylist>(
    "GET",
    `/playlists/${encodeURIComponent(playlistId)}`,
    signal ? { signal } : undefined,
  );
  if (!playlist?.id || !playlist.name) throw new Error("Spotify returned no playlist metadata");
  const canonicalUrl =
    playlist.external_urls?.spotify ?? `https://open.spotify.com/playlist/${playlist.id}`;
  const items = await spotifyPlaylistItems(playlist, client, signal);
  const tracks: SpotifyProviderPlaylistTrack[] = [];
  for (const [index, item] of items.entries()) {
    const track = item.item ?? item.track;
    if (!track?.id || !track.name || track.type === "episode") continue;
    const artists = names(track.artists);
    if (!artists.length) continue;
    tracks.push({
      provider: "spotify",
      order: index + 1,
      id: track.id,
      uri: track.uri ?? `spotify:track:${track.id}`,
      url: track.external_urls?.spotify ?? `https://open.spotify.com/track/${track.id}`,
      title: track.name,
      artists,
      ...(track.album?.name ? { album: track.album.name } : {}),
      ...(names(track.album?.artists).length ? { albumArtists: names(track.album?.artists) } : {}),
      ...(track.album?.release_date ? { releaseDate: track.album.release_date } : {}),
      ...(track.duration_ms ? { durationMs: track.duration_ms } : {}),
      ...(track.external_ids?.isrc ? { isrc: track.external_ids.isrc } : {}),
      ...(track.explicit === undefined ? {} : { explicit: track.explicit }),
    });
  }
  if (!tracks.length) throw new Error(`Spotify playlist '${playlist.name}' contains no tracks`);
  const manifest = buildProviderPlaylistManifest({
    provider: "spotify",
    id: playlist.id,
    title: playlist.name,
    url: canonicalUrl,
    ...(playlist.owner?.display_name || playlist.owner?.id
      ? { owner: playlist.owner.display_name ?? playlist.owner.id! }
      : {}),
    tracks,
  });
  manifest.source.input = requestedSource;
  return { kind: "spotify-playlist", manifest };
}

async function spotifyPlaylistItems(
  playlist: SpotifyPlaylist,
  client: SpotifyRawClient,
  signal?: AbortSignal,
): Promise<SpotifyPlaylistItem[]> {
  const first = playlist.items ?? playlist.tracks;
  const items = [...(first?.items ?? [])];
  let offset = (first?.offset ?? 0) + items.length;
  let total = first?.total ?? (first ? items.length : Number.POSITIVE_INFINITY);
  while (offset < total) {
    signal?.throwIfAborted();
    const page = await client.raw<SpotifyPlaylistPage>(
      "GET",
      `/playlists/${encodeURIComponent(playlist.id!)}/items`,
      { query: { offset, limit: 100 }, ...(signal ? { signal } : {}) },
    );
    const next = page?.items ?? [];
    if (!next.length) break;
    items.push(...next);
    offset += next.length;
    total = page?.total ?? total;
  }
  return items;
}

async function prepareSoundCloudPlaylist(
  requestedSource: string,
  client: SoundCloudClient,
  signal?: AbortSignal,
): Promise<PreparedImportSource> {
  const playlist = await client.getPlaylist(requestedSource, signal ? { signal } : undefined);
  if (!playlist.urn || !playlist.title || !playlist.permalink_url) {
    throw new Error("SoundCloud returned an incomplete playlist");
  }
  const tracks = (playlist.tracks ?? [])
    .map((track, index) => soundCloudTrack(track, index + 1, playlist))
    .filter((track): track is SoundCloudProviderPlaylistTrack => track !== undefined);
  if (!tracks.length) throw new Error(`SoundCloud playlist '${playlist.title}' contains no tracks`);
  const manifest = buildProviderPlaylistManifest({
    provider: "soundcloud",
    id: playlist.urn,
    title: playlist.title,
    url: playlist.permalink_url,
    ...(soundCloudUser(playlist) ? { owner: soundCloudUser(playlist)! } : {}),
    tracks,
  });
  manifest.source.input = requestedSource;
  return { kind: "soundcloud-playlist", manifest };
}

function soundCloudTrack(
  track: SoundCloudTrack,
  order: number,
  playlist: SoundCloudPlaylist,
): SoundCloudProviderPlaylistTrack | undefined {
  if (!track.urn || !track.title || !track.permalink_url) return undefined;
  const artist = track.metadata_artist?.trim() || track.user?.username?.trim();
  if (!artist) return undefined;
  const releaseDate = soundCloudReleaseDate(track);
  return {
    provider: "soundcloud",
    order,
    urn: track.urn,
    permalinkUrl: track.permalink_url,
    title: track.title,
    artists: [artist],
    ...(track.release ? { album: track.release } : {}),
    ...((track.label_name ?? playlist.label_name)
      ? { label: (track.label_name ?? playlist.label_name)! }
      : {}),
    ...((track.genre ?? playlist.genre) ? { genre: (track.genre ?? playlist.genre)! } : {}),
    ...(releaseDate ? { releaseDate } : {}),
    ...(track.duration ? { durationMs: track.duration } : {}),
    ...(track.isrc ? { isrc: track.isrc } : {}),
  };
}

function soundCloudReleaseDate(track: SoundCloudTrack): string | undefined {
  if (!track.release_year) return undefined;
  const month = String(track.release_month ?? 1).padStart(2, "0");
  const day = String(track.release_day ?? 1).padStart(2, "0");
  return `${String(track.release_year)}-${month}-${day}`;
}

function soundCloudUser(playlist: SoundCloudPlaylist): string | undefined {
  return playlist.user?.username?.trim() || playlist.user?.full_name?.trim() || undefined;
}

function names(values: Array<{ name?: string }> | undefined): string[] {
  return (values ?? []).flatMap(({ name }) => (name?.trim() ? [name.trim()] : []));
}
