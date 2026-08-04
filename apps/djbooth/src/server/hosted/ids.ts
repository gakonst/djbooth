import type { HostedPlaylistProvider } from "../../shared/types.js";

const playlistPrefix = "hosted:";
const trackPrefix = "hosted-track:";

export type HostedPlaylistReference = {
  provider: HostedPlaylistProvider;
  remoteId: string;
};

export function hostedProviderRootId(provider: HostedPlaylistProvider): string {
  return `${playlistPrefix}${provider}`;
}

export function hostedPlaylistId(provider: HostedPlaylistProvider, remoteId: string): string {
  const normalized = requireRemoteId(remoteId);
  return `${playlistPrefix}${provider}:${encodeURIComponent(normalized)}`;
}

export function hostedTrackId(provider: HostedPlaylistProvider, remoteId: string): string {
  const normalized = requireRemoteId(remoteId);
  return `${trackPrefix}${provider}:${encodeURIComponent(normalized)}`;
}

export function hostedPlaylistMembershipId(playlistId: string, position: number): string {
  if (!Number.isSafeInteger(position) || position < 0) {
    throw new TypeError("Hosted playlist position must be a non-negative integer");
  }
  return `${playlistId}:item:${position}`;
}

export function parseHostedPlaylistId(playlistId: string): HostedPlaylistReference {
  if (typeof playlistId !== "string") {
    throw new TypeError("Hosted playlist ID must be a string");
  }
  const match = /^hosted:(spotify|soundcloud):(.+)$/u.exec(playlistId);
  if (!match) throw new TypeError(`Invalid hosted playlist ID: ${playlistId}`);

  let remoteId: string;
  try {
    remoteId = decodeURIComponent(match[2]!);
  } catch (cause) {
    throw new TypeError(`Invalid hosted playlist ID: ${playlistId}`, { cause });
  }
  return {
    provider: match[1] as HostedPlaylistProvider,
    remoteId: requireRemoteId(remoteId),
  };
}

export function parseHostedTrackId(trackId: string): HostedPlaylistReference {
  if (typeof trackId !== "string") throw new TypeError("Hosted track ID must be a string");
  const match = /^hosted-track:(spotify|soundcloud):(.+)$/u.exec(trackId);
  if (!match) throw new TypeError(`Invalid hosted track ID: ${trackId}`);
  let remoteId: string;
  try {
    remoteId = decodeURIComponent(match[2]!);
  } catch (cause) {
    throw new TypeError(`Invalid hosted track ID: ${trackId}`, { cause });
  }
  return {
    provider: match[1] as HostedPlaylistProvider,
    remoteId: requireRemoteId(remoteId),
  };
}

function requireRemoteId(remoteId: string): string {
  if (typeof remoteId !== "string" || remoteId.trim().length === 0) {
    throw new TypeError("Hosted provider remote ID must not be empty");
  }
  return remoteId.trim();
}
