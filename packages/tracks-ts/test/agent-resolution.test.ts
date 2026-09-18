import { expect, test } from "vitest";
import { needs1001Research, retainResolvedRecordings } from "../src/agent-resolution.js";
import { createManifest, parseManifest } from "../src/manifest.js";

const make = () =>
  createManifest({
    source: "https://youtu.be/set",
    provider: "description",
    complete: true,
    tracks: [
      { order: 1, artist: "Artist", title: "First" },
      { order: 2, artist: "Artist", title: "Second" },
    ],
  });

test("description checkpoints require 1001 research; verified or explicitly unavailable results resume", () => {
  const state = make();
  expect(needs1001Research(state)).toBe(true);
  state.tracklist.url = "https://www.1001tracklists.com/tracklist/test.html";
  expect(needs1001Research(state)).toBe(false);
  delete state.tracklist.url;
  state.warnings.push(
    "1001Tracklists was searched but no matching tracklist could be verified; using the cited secondary source.",
  );
  expect(needs1001Research(state)).toBe(false);
});

test("replacement identities preserve standalone downloads across ordering changes, never inherit clips", () => {
  const old = make(),
    next = make();
  old.entries[0]!.acquisition = {
    status: "downloaded",
    download: {
      backend: "slsk",
      kind: "individual",
      mediaPath: "/tracks/first.flac",
      files: ["/tracks/first.flac"],
    },
  };
  old.entries[1]!.acquisition = {
    status: "downloaded",
    download: {
      backend: "local",
      kind: "source-set-clip",
      source: "https://youtu.be/set",
      mediaPath: "/tracks/extract.m4a",
      files: ["/tracks/extract.m4a"],
    },
  };
  next.entries.reverse();
  retainResolvedRecordings(old, next);
  expect(next.entries[0]!.acquisition.status).toBe("pending");
  expect(next.entries[1]!.acquisition).toMatchObject({
    status: "downloaded",
    download: { kind: "individual", mediaPath: "/tracks/first.flac" },
  });
});

test.each([
  [undefined, "Edit"],
  ["Armand Van Helden Remix", "Correct Edit"],
])("does not retain downloads when mix changes from %s to %s", (oldMix, newMix) => {
  const old = make(),
    next = make();
  if (oldMix !== undefined) old.entries[0]!.identity.mix = oldMix;
  next.entries[0]!.identity.mix = newMix;
  old.entries[0]!.acquisition = {
    status: "downloaded",
    download: {
      backend: "slsk",
      kind: "individual",
      mediaPath: "/tracks/wrong.flac",
      files: ["/tracks/wrong.flac"],
    },
  };
  retainResolvedRecordings(old, next);
  expect(next.entries[0]!.acquisition.status).toBe("pending");
  expect(next.entries[0]!.rekordbox).toEqual(make().entries[0]!.rekordbox);
});

test.each([false, true])(
  "refreshed analyzed recordings remain valid when identities change: %s",
  (changed) => {
    const old = make();
    const next = make();
    const paths = ["/tracks/first.flac", "/tracks/second.flac"];
    for (const [index, entry] of old.entries.entries()) {
      const mediaPath = paths[index]!;
      entry.acquisition = {
        status: "downloaded",
        download: { backend: "slsk", kind: "individual", mediaPath, files: [mediaPath] },
      };
      entry.rekordbox = {
        status: "imported",
        target: "rekordbox-db",
        artifact: "/tracks/master.db",
        dbContentId: String(index + 1),
        playlistMembershipId: String(index + 1),
      };
    }
    const first = old.entries[0]!.acquisition;
    if (first.status !== "downloaded") throw new Error("fixture must be downloaded");
    first.alternatives = [
      {
        backend: "slsk",
        kind: "individual",
        mediaPath: "/tracks/alternate.flac",
        files: ["/tracks/alternate.flac"],
      },
      {
        backend: "local",
        kind: "source-set-clip",
        source: "https://youtu.be/set",
        clip: {
          sourceSetUrl: "https://youtu.be/set",
          startSeconds: 0,
          endSeconds: 120,
          containsTransitions: true,
          qualityNote: "Set extract",
        },
        mediaPath: "/tracks/clip.m4a",
        files: ["/tracks/clip.m4a"],
      },
    ];
    old.artifacts.analysis = [...paths, "/tracks/alternate.flac", "/tracks/clip.m4a"].map(
      (mediaPath) => ({
        mediaPath,
        summaryPath: mediaPath + ".json",
        backend: "rekordbox-dlopen-rehost",
        tempoBpm: 128,
        key: "Bm",
        keySource: "rekordbox-notify-complete",
        sourceMtimeMs: 1,
        sourceSize: 1,
      }),
    );
    old.artifacts.rekordbox = {
      target: "rekordbox-db",
      dbPath: "/tracks/master.db",
      folderName: "Sets",
      folderId: "1",
      playlistName: "Set",
      playlistId: "2",
    };
    expect(() => parseManifest(old)).not.toThrow();
    const prior = structuredClone(old);
    if (changed) {
      next.entries[1]!.identity.title = "Corrected title";
      next.entries[1]!.identity.searchQuery = "Artist - Corrected title";
    }
    retainResolvedRecordings(old, next);
    expect(() => parseManifest(JSON.parse(JSON.stringify(next)))).not.toThrow();
    expect(next.artifacts.analysis?.map((artifact) => artifact.mediaPath)).toEqual(
      changed ? [paths[0], "/tracks/alternate.flac"] : [...paths, "/tracks/alternate.flac"],
    );
    expect(next.entries[0]!.acquisition).toMatchObject({
      status: "downloaded",
      alternatives: [{ mediaPath: "/tracks/alternate.flac" }],
    });
    expect(next.entries[1]!.acquisition.status).toBe(changed ? "pending" : "downloaded");
    expect(next.artifacts.rekordbox).toEqual(changed ? undefined : prior.artifacts.rekordbox);
    expect(old).toEqual(prior);
  },
);
