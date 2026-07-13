import { describe, expect, it } from "vitest";

import { planLibraryPrompt } from "../src/server/prompt.js";
import type { PlaylistItem, PromptContext } from "../src/shared/types.js";

const playlists: PlaylistItem[] = [
  {
    id: "grooves",
    name: "Grooves",
    parentId: "root",
    seq: 1,
    type: "playlist",
    trackCount: 17,
  },
  {
    id: "grooves-radio",
    name: "Grooves radio",
    parentId: "root",
    seq: 2,
    type: "playlist",
    trackCount: 48,
  },
  {
    id: "oldschool",
    name: "Oldschool",
    parentId: "root",
    seq: 3,
    type: "playlist",
    trackCount: 47,
  },
  {
    id: "warmup-folder",
    name: "Warmup folder",
    parentId: "root",
    seq: 4,
    type: "folder",
    trackCount: 0,
  },
];

const context: PromptContext = {
  playlistId: "grooves",
  trackId: "track-42",
  playheadSeconds: 83.25,
};

describe("planLibraryPrompt", () => {
  it("creates and renames playlists", () => {
    expect(
      planLibraryPrompt('create a playlist called "No Static"', context, playlists),
    ).toMatchObject({
      summary: "Create playlist “No Static”",
      actions: [
        {
          type: "mutate",
          mutation: { type: "create-playlist", name: "No Static" },
        },
      ],
    });
    expect(
      planLibraryPrompt("rename current playlist to Late Night", context, playlists),
    ).toMatchObject({
      actions: [
        {
          type: "mutate",
          mutation: {
            type: "rename-playlist",
            playlistId: "grooves",
            name: "Late Night",
          },
        },
      ],
    });
  });

  it("resolves exact, normalized, contained, and typo playlist names", () => {
    expect(planLibraryPrompt("open playlist grooves", context, playlists).actions[0]).toMatchObject(
      {
        type: "open-playlist",
        playlistId: "grooves",
      },
    );
    expect(planLibraryPrompt("open old school", context, playlists).actions[0]).toMatchObject({
      type: "open-playlist",
      playlistId: "oldschool",
    });
    expect(planLibraryPrompt("open grooves radi", context, playlists).actions[0]).toMatchObject({
      type: "open-playlist",
      playlistId: "grooves-radio",
    });
    expect(planLibraryPrompt("open oldscool", context, playlists).actions[0]).toMatchObject({
      type: "open-playlist",
      playlistId: "oldschool",
    });
  });

  it("rejects ambiguous and missing playlists", () => {
    const duplicateNames: PlaylistItem[] = [
      ...playlists,
      { ...playlists[0]!, id: "grooves-duplicate" },
    ];
    expect(() => planLibraryPrompt("open grooves", context, duplicateNames)).toThrowError(
      /ambiguous.*Grooves/i,
    );
    expect(() => planLibraryPrompt("open underwater", context, playlists)).toThrowError(
      "No playlist matches “underwater”.",
    );
  });

  it("searches tracks and opens the canvas", () => {
    expect(planLibraryPrompt("search tracks for funky house", context, playlists)).toMatchObject({
      actions: [{ type: "search-tracks", query: "funky house" }],
    });
    expect(planLibraryPrompt("show set canvas", context, playlists)).toMatchObject({
      actions: [{ type: "show-canvas" }],
    });
  });

  it("adds the selected track to the current or a named writable playlist", () => {
    expect(planLibraryPrompt("add current track", context, playlists).actions[0]).toMatchObject({
      type: "mutate",
      mutation: { type: "add-track", playlistId: "grooves", contentId: "track-42" },
    });
    expect(
      planLibraryPrompt("add this track to playlist Oldschool", context, playlists).actions[0],
    ).toMatchObject({
      type: "mutate",
      mutation: { type: "add-track", playlistId: "oldschool", contentId: "track-42" },
    });
    expect(() =>
      planLibraryPrompt("add this track to Warmup folder", context, playlists),
    ).toThrowError("No playlist matches “Warmup folder”.");
  });

  it("plans memory and A-P hot cues from explicit times or the playhead", () => {
    expect(
      planLibraryPrompt("set memory cue at 1:23.5", context, playlists).actions[0],
    ).toMatchObject({
      type: "mutate",
      mutation: {
        type: "upsert-cue",
        contentId: "track-42",
        cue: { kind: "memory", startSeconds: 83.5 },
      },
    });
    expect(planLibraryPrompt("set hot cue P here", context, playlists).actions[0]).toMatchObject({
      type: "mutate",
      mutation: {
        type: "upsert-cue",
        contentId: "track-42",
        cue: { kind: "hot", slot: 16, startSeconds: 83.25 },
      },
    });
    expect(planLibraryPrompt("set hotcue A at 1m 2s", context, playlists).actions[0]).toMatchObject(
      {
        type: "mutate",
        mutation: { type: "upsert-cue", cue: { slot: 1, startSeconds: 62 } },
      },
    );
  });

  it("reports missing context, invalid cue times, and membership-only removal", () => {
    const empty: PromptContext = { playlistId: null, trackId: null, playheadSeconds: null };
    expect(() => planLibraryPrompt("rename playlist to New", empty, playlists)).toThrowError(
      "Open a playlist first",
    );
    expect(() => planLibraryPrompt("add current track", empty, playlists)).toThrowError(
      "Select a track first",
    );
    expect(() => planLibraryPrompt("set memory cue", context, playlists)).not.toThrow();
    expect(() => planLibraryPrompt("set memory cue", empty, playlists)).toThrowError(
      "Select a track first",
    );
    expect(() => planLibraryPrompt("set memory cue at tomorrow", context, playlists)).toThrowError(
      "Invalid cue time “tomorrow”",
    );
    expect(() =>
      planLibraryPrompt("remove current track from current playlist", context, playlists),
    ).toThrowError(/membership ID.*context menu/i);
  });

  it("returns deterministic IDs and rejects unsupported free-form requests", () => {
    const first = planLibraryPrompt("search for disco", context, playlists);
    const second = planLibraryPrompt("search for disco", context, playlists);
    expect(first.id).toBe(second.id);
    expect(first.id).toMatch(/^prompt-[a-f0-9]{8}$/);
    expect(() => planLibraryPrompt("build me a transcendent set", context, playlists)).toThrowError(
      /Command not understood/,
    );
    expect(() => planLibraryPrompt("   ", context, playlists)).toThrowError(
      "Enter a library command.",
    );
  });
});
