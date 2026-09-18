import { expect, test } from "vitest";
import { needs1001Research, retainResolvedRecordings } from "../src/agent-resolution.js";
import { createManifest } from "../src/manifest.js";

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
