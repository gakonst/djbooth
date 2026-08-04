import { describe, expect, it } from "vitest";

import {
  hostedPlaylistsForProvider,
  hostedProviderStatus,
  isHostedPlaylist,
} from "../src/client/hosted-playlists.js";
import type { PlaylistItem } from "../src/shared/types.js";

const items: PlaylistItem[] = [
  {
    id: "local:1",
    name: "Local",
    parentId: "root",
    seq: 0,
    type: "playlist",
    trackCount: 1,
  },
  hostedPlaylist("spotify:late", "Late Spotify", "spotify", 2),
  hostedPlaylist("soundcloud:set", "Club Set", "soundcloud", 0),
  hostedPlaylist("spotify:early", "Early Spotify", "spotify", 1),
];

describe("hosted playlist presentation", () => {
  it("groups, filters, and orders provider playlists without including local playlists", () => {
    expect(hostedPlaylistsForProvider(items, "spotify").map((item) => item.id)).toEqual([
      "spotify:early",
      "spotify:late",
    ]);
    expect(hostedPlaylistsForProvider(items, "spotify", "late").map((item) => item.id)).toEqual([
      "spotify:late",
    ]);
    expect(isHostedPlaylist(items[0]!)).toBe(false);
  });

  it("finds status by provider without relying on response order", () => {
    const statuses = [
      { provider: "soundcloud" as const, connected: true, displayName: "GAK" },
      { provider: "spotify" as const, connected: false, error: "Login required" },
    ];

    expect(hostedProviderStatus(statuses, "spotify")?.error).toBe("Login required");
    expect(hostedProviderStatus(statuses, "soundcloud")?.displayName).toBe("GAK");
  });
});

function hostedPlaylist(
  id: string,
  name: string,
  provider: "spotify" | "soundcloud",
  seq: number,
): PlaylistItem {
  return {
    id,
    name,
    parentId: provider,
    seq,
    type: "playlist",
    trackCount: 12,
    hosted: {
      provider,
      remoteId: id,
      revision: null,
      externalUrl: null,
      owned: true,
      capabilities: { itemsReadable: true, detailsEditable: true, itemsEditable: true },
      downloadEnabled: false,
      syncState: "idle",
    },
  };
}
