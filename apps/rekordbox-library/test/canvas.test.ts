import { describe, expect, it } from "vitest";

import {
  alignCanvasStateToPlaylist,
  deriveConnectedOrder,
  playlistMembershipSnapshot,
  type SetCanvasNode,
} from "../src/client/components/SetCanvas.js";
import type { TrackSummary } from "../src/shared/types.js";

const track = (id: string, membershipId?: string): TrackSummary =>
  ({
    id,
    title: id,
    artist: null,
    album: null,
    genre: null,
    colorId: null,
    bpm: null,
    key: null,
    durationSeconds: null,
    path: null,
    fileExists: true,
    analyzed: true,
    artworkAvailable: false,
    playCount: 0,
    rating: 0,
    ...(membershipId ? { playlistMembershipId: membershipId } : {}),
  }) satisfies TrackSummary;

describe("set canvas ordering", () => {
  it("keeps loose candidates out until they are connected", () => {
    const nodes: SetCanvasNode[] = [
      {
        id: "one",
        track: track("1"),
        position: { x: 0, y: 0 },
        kind: "playlist",
        playlistIndex: 0,
      },
      {
        id: "two",
        track: track("2"),
        position: { x: 100, y: 0 },
        kind: "playlist",
        playlistIndex: 1,
      },
      { id: "loose", track: track("3"), position: { x: 50, y: 100 }, kind: "candidate" },
    ];

    expect(deriveConnectedOrder(nodes, [])).toEqual(["one", "two"]);
    expect(
      deriveConnectedOrder(nodes, [
        { id: "one-loose", fromNodeId: "one", toNodeId: "loose" },
        { id: "loose-two", fromNodeId: "loose", toNodeId: "two" },
      ]),
    ).toEqual(["one", "loose", "two"]);
  });

  it("preserves the exact membership snapshot, including duplicates, and allows empty playlists", () => {
    expect(
      playlistMembershipSnapshot([
        track("same", "membership-1"),
        track("same", "membership-2"),
        track("candidate"),
      ]),
    ).toEqual(["membership-1", "membership-2"]);
    expect(playlistMembershipSnapshot([])).toEqual([]);
    expect(deriveConnectedOrder([], [])).toEqual([]);
  });

  it("aligns local nodes to a restored playlist without reapplying the stale graph", () => {
    const one = track("1", "membership-1");
    const two = track("2", "membership-2");
    const candidate = track("3", "membership-3");
    const aligned = alignCanvasStateToPlaylist([candidate, one], {
      nodes: [
        {
          id: "one",
          track: one,
          position: { x: 10, y: 20 },
          kind: "playlist",
          playlistIndex: 0,
        },
        {
          id: "two",
          track: two,
          position: { x: 30, y: 40 },
          kind: "playlist",
          playlistIndex: 1,
        },
        {
          id: "candidate",
          track: candidate,
          position: { x: 50, y: 60 },
          kind: "candidate",
        },
      ],
      connections: [{ id: "stale", fromNodeId: "one", toNodeId: "two" }],
    });

    expect(aligned.nodes.map((node) => [node.id, node.kind, node.playlistIndex])).toEqual([
      ["candidate", "playlist", 0],
      ["one", "playlist", 1],
      ["two", "candidate", undefined],
    ]);
    expect(deriveConnectedOrder(aligned.nodes, aligned.connections)).toEqual(["candidate", "one"]);
    expect(aligned.connections).not.toContainEqual(expect.objectContaining({ id: "stale" }));
  });
});
