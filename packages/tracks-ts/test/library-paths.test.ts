import { join, resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { canonicalTrackPath, defaultTrackLibraryRoot } from "../src/library-paths.js";

describe("canonical library paths", () => {
  test("defaults to the djskills-compatible shared track root", () => {
    expect(defaultTrackLibraryRoot({}, "/Users/dj")).toBe("/Users/dj/.djtools/tracks");
    expect(defaultTrackLibraryRoot({ MUSIC_LIBRARY_ROOT: "~/Music/DJ" }, "/Users/dj")).toBe(
      "/Users/dj/Music/DJ",
    );
    expect(defaultTrackLibraryRoot({ MUSIC_LIBRARY_ROOT: "./library" }, "/Users/dj")).toBe(
      resolve("./library"),
    );
  });

  test("organizes one recording by artist and album with a stable identity suffix", () => {
    expect(
      canonicalTrackPath("/music", {
        artists: ["JØRD", "Guest/Artist"],
        album: "Night:Music?",
        title: "Don’t Stop*",
        qualifier: "spotify-123",
        extension: "FLAC",
      }),
    ).toBe(join("/music", "JORD, Guest Artist", "Night Music", "Don't Stop [spotify-123].flac"));
  });

  test("uses Singles and rejects paths outside an absolute library root", () => {
    expect(
      canonicalTrackPath("/music", {
        artists: ["Artist"],
        title: "Track",
        extension: ".m4a",
      }),
    ).toBe("/music/Artist/Singles/Track.m4a");
    expect(() =>
      canonicalTrackPath("relative", {
        artists: ["Artist"],
        title: "Track",
        extension: ".m4a",
      }),
    ).toThrow("libraryRoot must be absolute");
  });
});
