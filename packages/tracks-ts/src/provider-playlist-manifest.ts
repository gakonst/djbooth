import {
  createManifest,
  parseManifest,
  type AcquisitionCandidate,
  type SetManifest,
} from "./manifest.js";
import type { TracklistEntry } from "./types.js";

export type ProviderPlaylistProvider = "spotify" | "soundcloud";

type ProviderPlaylistTrackBase = {
  /** One-based provider playlist position. Repeated recording identities remain separate rows. */
  order: number;
  title: string;
  artists: readonly string[];
  album?: string;
  label?: string;
  genre?: string;
  releaseDate?: string;
  durationMs?: number;
  isrc?: string;
};

export type SpotifyProviderPlaylistTrack = ProviderPlaylistTrackBase & {
  provider: "spotify";
  id: string;
  uri: string;
  url: string;
  albumArtists?: readonly string[];
  explicit?: boolean;
};

export type SoundCloudProviderPlaylistTrack = ProviderPlaylistTrackBase & {
  provider: "soundcloud";
  /** Immutable modern SoundCloud track URN, retained verbatim. */
  urn: string;
  /** Exact public track permalink, retained verbatim and preferred for acquisition. */
  permalinkUrl: string;
};

export type ProviderPlaylistTrack = SpotifyProviderPlaylistTrack | SoundCloudProviderPlaylistTrack;

type ProviderPlaylistManifestBase = {
  /** Immutable provider playlist ID or URN, retained verbatim. */
  id: string;
  title: string;
  /** Exact public provider playlist URL. */
  url: string;
  owner?: string;
};

export type ProviderPlaylistManifestInput = ProviderPlaylistManifestBase &
  (
    | { provider: "spotify"; tracks: readonly SpotifyProviderPlaylistTrack[] }
    | { provider: "soundcloud"; tracks: readonly SoundCloudProviderPlaylistTrack[] }
  );

/**
 * Build a strict, checkpoint-ready manifest from one complete hosted playlist snapshot.
 *
 * Spotify is identity metadata only: its track URL is never installed as an acquisition source.
 * SoundCloud's exact public permalink is an explicit yt-dlp preference, with its URN as the
 * candidate ID. The input's order values determine manifest order; recording identities are never
 * deduplicated.
 */
export function buildProviderPlaylistManifest(
  playlist: ProviderPlaylistManifestInput,
): SetManifest {
  validatePlaylist(playlist);
  const tracks = playlist.tracks.toSorted((left, right) => left.order - right.order);
  const manifest = createManifest({
    source: playlist.url,
    sourceId: playlist.id,
    provider: "description",
    title: playlist.title,
    url: playlist.url,
    ...(playlist.owner === undefined ? {} : { uploader: playlist.owner }),
    complete: true,
    tracks: tracks.map(tracklistEntry),
  });

  tracks.forEach((track, index) => {
    const entry = manifest.entries[index]!;
    const query =
      entry.identity.status === "identified"
        ? entry.identity.searchQuery
        : `${track.artists.join(", ")} - ${track.title}`;
    if (track.provider === "spotify") {
      entry.spotify = {
        status: "matched",
        query,
        score: 1,
        id: track.id,
        uri: track.uri,
        url: track.url,
        name: track.title,
        artists: [...track.artists],
        ...(track.album === undefined ? {} : { album: track.album }),
        ...(track.albumArtists === undefined ? {} : { albumArtists: [...track.albumArtists] }),
        ...(track.releaseDate === undefined ? {} : { releaseDate: track.releaseDate }),
        ...(track.durationMs === undefined ? {} : { durationMs: track.durationMs }),
        ...(track.explicit === undefined ? {} : { explicit: track.explicit }),
        ...(track.isrc === undefined ? {} : { isrc: track.isrc }),
      };
      return;
    }

    const candidate: AcquisitionCandidate = {
      backend: "ytdlp",
      id: track.urn,
      source: track.permalinkUrl,
      title: track.title,
      artist: track.artists.join(", "),
      ...(track.durationMs === undefined ? {} : { durationSeconds: track.durationMs / 1000 }),
      score: 1,
    };
    entry.acquisition = {
      status: "selected",
      query,
      candidates: [candidate],
      selected: candidate,
    };
  });

  return parseManifest(manifest);
}

function tracklistEntry(track: ProviderPlaylistTrack): TracklistEntry {
  return {
    order: track.order,
    artist: track.artists.join(", "),
    title: track.title,
    ...(track.album === undefined ? {} : { album: track.album }),
    ...(track.label === undefined ? {} : { label: track.label }),
    ...(track.genre === undefined ? {} : { genre: track.genre }),
    ...(track.releaseDate === undefined ? {} : { releaseDate: track.releaseDate }),
    ...(track.isrc === undefined ? {} : { isrc: track.isrc }),
    songLink: track.provider === "spotify" ? track.url : track.permalinkUrl,
    ...(track.provider === "soundcloud"
      ? {
          mediaLinks: [
            {
              platform: "soundcloud",
              sourceId: track.urn,
              url: track.permalinkUrl,
              ...(track.durationMs === undefined
                ? {}
                : { durationSeconds: Math.max(1, Math.round(track.durationMs / 1000)) }),
            },
          ],
        }
      : {}),
  };
}

function validatePlaylist(playlist: ProviderPlaylistManifestInput): void {
  requireString(playlist.id, "playlist.id");
  requireString(playlist.title, "playlist.title");
  requireUrl(playlist.url, "playlist.url");
  if (playlist.owner !== undefined) requireString(playlist.owner, "playlist.owner");

  const orders = new Set<number>();
  playlist.tracks.forEach((track, index) => {
    const path = `playlist.tracks[${String(index)}]`;
    if (track.provider !== playlist.provider) {
      throw new TypeError(
        `${path}.provider must equal playlist.provider (${JSON.stringify(playlist.provider)})`,
      );
    }
    if (!Number.isSafeInteger(track.order) || track.order <= 0) {
      throw new RangeError(`${path}.order must be a positive safe integer`);
    }
    if (orders.has(track.order)) {
      throw new RangeError(`${path}.order must be unique (${String(track.order)} is repeated)`);
    }
    orders.add(track.order);
    requireString(track.title, `${path}.title`);
    if (!track.artists.length) throw new TypeError(`${path}.artists must not be empty`);
    track.artists.forEach((artist, artistIndex) =>
      requireString(artist, `${path}.artists[${String(artistIndex)}]`),
    );
    for (const [key, value] of [
      ["album", track.album],
      ["label", track.label],
      ["genre", track.genre],
      ["releaseDate", track.releaseDate],
      ["isrc", track.isrc],
    ] as const) {
      if (value !== undefined) requireString(value, `${path}.${key}`);
    }
    if (
      track.durationMs !== undefined &&
      (!Number.isSafeInteger(track.durationMs) || track.durationMs <= 0)
    ) {
      throw new RangeError(`${path}.durationMs must be a positive safe integer`);
    }

    if (track.provider === "spotify") {
      requireString(track.id, `${path}.id`);
      requireString(track.uri, `${path}.uri`);
      requireUrl(track.url, `${path}.url`);
      if (track.albumArtists !== undefined) {
        if (!track.albumArtists.length) {
          throw new TypeError(`${path}.albumArtists must not be empty when provided`);
        }
        track.albumArtists.forEach((artist, artistIndex) =>
          requireString(artist, `${path}.albumArtists[${String(artistIndex)}]`),
        );
      }
      if (track.explicit !== undefined && typeof track.explicit !== "boolean") {
        throw new TypeError(`${path}.explicit must be a boolean`);
      }
    } else {
      requireString(track.urn, `${path}.urn`);
      requireUrl(track.permalinkUrl, `${path}.permalinkUrl`);
    }
  });
}

function requireString(value: string, path: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${path} must be a non-empty string`);
  }
}

function requireUrl(value: string, path: string): void {
  requireString(value, path);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${path} must be an absolute HTTP(S) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`${path} must be an absolute HTTP(S) URL`);
  }
}
