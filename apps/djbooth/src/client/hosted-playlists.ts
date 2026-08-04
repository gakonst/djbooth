import type {
  HostedPlaylist,
  HostedPlaylistProvider,
  HostedProviderStatus,
  PlaylistItem,
} from "../shared/types.js";

export type HostedPlaylistItem = PlaylistItem & { hosted: HostedPlaylist };

export const hostedPlaylistProviders = ["spotify", "soundcloud"] as const;

export function isHostedPlaylist(item: PlaylistItem): item is HostedPlaylistItem {
  return item.type === "playlist" && item.hosted !== undefined;
}

export function hostedPlaylistsForProvider(
  items: PlaylistItem[],
  provider: HostedPlaylistProvider,
  query = "",
): HostedPlaylistItem[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return items
    .filter(
      (item): item is HostedPlaylistItem =>
        isHostedPlaylist(item) &&
        item.hosted.provider === provider &&
        (!normalizedQuery || item.name.toLocaleLowerCase().includes(normalizedQuery)),
    )
    .sort((left, right) => left.seq - right.seq || left.name.localeCompare(right.name));
}

export function hostedProviderStatus(
  statuses: HostedProviderStatus[],
  provider: HostedPlaylistProvider,
): HostedProviderStatus | undefined {
  return statuses.find((status) => status.provider === provider);
}

export function hostedProviderLabel(provider: HostedPlaylistProvider): string {
  return provider === "spotify" ? "Spotify" : "SoundCloud";
}
