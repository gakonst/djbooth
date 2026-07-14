import { describe, expect, it } from "vitest";

import { playlistDropTrackNumber } from "../src/client/components/playlist-order.js";

describe("playlist drag ordering", () => {
  it("accounts for the source row being removed before a later target", () => {
    expect(playlistDropTrackNumber(1, 3, "before", 4)).toBe(2);
    expect(playlistDropTrackNumber(1, 3, "after", 4)).toBe(3);
  });

  it("places an upward drag on the requested side of its target", () => {
    expect(playlistDropTrackNumber(4, 2, "before", 4)).toBe(2);
    expect(playlistDropTrackNumber(4, 2, "after", 4)).toBe(3);
  });

  it("clamps drops to playlist bounds", () => {
    expect(playlistDropTrackNumber(4, 1, "before", 4)).toBe(1);
    expect(playlistDropTrackNumber(1, 4, "after", 4)).toBe(4);
  });
});
