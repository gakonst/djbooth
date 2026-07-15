import { describe, expect, it } from "vitest";

import {
  activeTrackIndex,
  hostedRemoteTrackIds,
  moveHostedPlaylistTrack,
  removeHostedPlaylistTrack,
  resolveHostedPlaylistTracks,
} from "../src/client/hosted-playlist-edits.js";
import { spotifyEmbedTrackUri } from "../src/client/components/SpotifyEmbedPlayer.js";
import type { HostedPlaylistProvider, TrackSummary } from "../src/shared/types.js";

describe("hosted playlist edits", () => {
  it("normalizes provider IDs for the Spotify iframe API", () => {
    expect(spotifyEmbedTrackUri("4uLU6hMCjMI75M1A2tKUQC")).toBe(
      "spotify:track:4uLU6hMCjMI75M1A2tKUQC",
    );
    expect(spotifyEmbedTrackUri("spotify:track:4uLU6hMCjMI75M1A2tKUQC")).toBe(
      "spotify:track:4uLU6hMCjMI75M1A2tKUQC",
    );
  });

  it("preserves duplicates while resolving same-provider drops", () => {
    const spotify = track("spotify", "a");
    const soundcloud = track("soundcloud", "b");
    const result = resolveHostedPlaylistTracks(
      [spotify.id, spotify.id, soundcloud.id, "missing"],
      [spotify, soundcloud],
      "spotify",
      "hosted:spotify:list",
    );

    expect(result.items.map((item) => item.hosted?.remoteId)).toEqual(["a", "a"]);
    expect(result.items.map((item) => item.playlistMembershipId)).toEqual([
      "hosted:spotify:list:item:0",
      "hosted:spotify:list:item:1",
    ]);
    expect(result.rejectedTrackIds).toEqual([soundcloud.id, "missing"]);
  });

  it("moves and removes the exact duplicate membership", () => {
    const items = [
      track("spotify", "same", 0),
      track("spotify", "same", 1),
      track("spotify", "c", 2),
    ];
    const moved = moveHostedPlaylistTrack(
      items,
      "hosted:spotify:list:item:1",
      1,
      "hosted:spotify:list",
    );
    expect(moved?.map((item) => item.hosted?.remoteId)).toEqual(["same", "same", "c"]);
    expect(moved?.[0]).toMatchObject({ trackNumber: 1 });

    const removed = removeHostedPlaylistTrack(
      moved ?? [],
      "hosted:spotify:list:item:0",
      "hosted:spotify:list",
    );
    expect(hostedRemoteTrackIds(removed ?? [], "spotify")).toEqual(["same", "c"]);
  });

  it("matches a downloaded provider row to its active local player ID", () => {
    const remote = track("spotify", "remote");
    remote.hosted!.localContentId = "local-content";
    expect(activeTrackIndex([track("spotify", "other"), remote], "local-content")).toBe(1);
  });
});

function track(provider: HostedPlaylistProvider, remoteId: string, position = 0): TrackSummary {
  const playlistId = `hosted:${provider}:list`;
  return {
    id: `hosted-track:${provider}:${remoteId}`,
    title: remoteId,
    artist: null,
    album: null,
    genre: null,
    key: null,
    colorId: null,
    bpm: null,
    durationSeconds: 120,
    rating: 0,
    playCount: 0,
    analyzed: false,
    artworkAvailable: false,
    fileExists: false,
    path: null,
    playlistMembershipId: `${playlistId}:item:${String(position)}`,
    trackNumber: position + 1,
    hosted: {
      provider,
      remoteId,
      externalUrl: null,
      localContentId: null,
      downloadState: "remote",
    },
  };
}
