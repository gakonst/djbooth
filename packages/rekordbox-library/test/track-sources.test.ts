import { describe, expect, it } from "vitest";

import { trackSourcesFromComment } from "../src/client/track-sources.js";

describe("track source metadata", () => {
  it("returns the download platform first and keeps Spotify as a reference", () => {
    expect(
      trackSourcesFromComment(
        [
          "[tracks-ts]",
          "Media source: https://youtu.be/abcdefghijk?t=1",
          "Spotify ID: 2up3OPMp9Tb4dAKM2erWXQ",
          "Spotify URL: https://open.spotify.com/track/2up3OPMp9Tb4dAKM2erWXQ",
        ].join("\n"),
      ),
    ).toEqual([
      {
        provider: "youtube",
        kind: "download",
        url: "https://youtu.be/abcdefghijk?t=1",
      },
      {
        provider: "spotify",
        kind: "reference",
        url: "https://open.spotify.com/track/2up3OPMp9Tb4dAKM2erWXQ",
      },
    ]);
  });

  it("links SoundCloud set extracts and leaves Soulseek non-clickable", () => {
    expect(
      trackSourcesFromComment("Source URL: http://soundcloud.com/artist/set\nSpotify ID: abc123"),
    ).toEqual([
      {
        provider: "soundcloud",
        kind: "download",
        url: "https://soundcloud.com/artist/set",
      },
      {
        provider: "spotify",
        kind: "reference",
        url: "https://open.spotify.com/track/abc123",
      },
    ]);
    expect(
      trackSourcesFromComment(
        "Downloaded from Soulseek: slsk://download?username=some-peer&filename=Music%5CTrack.flac",
      ),
    ).toEqual([{ provider: "soulseek", kind: "download", peer: "some-peer" }]);
  });

  it("supports legacy Spotify-enriched comments", () => {
    expect(
      trackSourcesFromComment(
        "[Spotify Enriched]\nSpotify: https://open.spotify.com/track/2up3OPMp9Tb4dAKM2erWXQ",
      ),
    ).toEqual([
      {
        provider: "spotify",
        kind: "reference",
        url: "https://open.spotify.com/track/2up3OPMp9Tb4dAKM2erWXQ",
      },
    ]);
  });

  it("ignores arbitrary and executable comment URLs", () => {
    expect(
      trackSourcesFromComment(
        "Media source: javascript:alert(1)\nSpotify URL: https://spotify.example/track/fake",
      ),
    ).toEqual([]);
  });
});
