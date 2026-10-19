import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MasterDatabase } from "@gakonst/rekordbox";
import { expect, test, vi } from "vitest";
import { createManifest } from "../src/manifest.js";
import {
  inspectImportDetails,
  RekordboxPipelineStore,
  resolveRekordboxPipelineLocation,
} from "../src/pipeline-state.js";

vi.mock("@gakonst/rekordbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@gakonst/rekordbox")>()),
  getConfig: () => ({
    dbPath: join(tmpdir(), "configured", "master.db"),
    dbDir: join(tmpdir(), "configured", "assets"),
  }),
}));

test("an explicit database keeps analysis beside that database, not the configured library", () => {
  const portable = join(tmpdir(), "portable");
  const explicit = join(tmpdir(), "explicit");
  expect(resolveRekordboxPipelineLocation({ dbPath: join(portable, "master.db") })).toEqual({
    dbPath: join(portable, "master.db"),
    dbDirectory: portable,
  });
  expect(
    resolveRekordboxPipelineLocation({
      dbPath: join(portable, "master.db"),
      dbDirectory: explicit,
    }).dbDirectory,
  ).toBe(explicit);
  expect(resolveRekordboxPipelineLocation({})).toEqual({
    dbPath: join(tmpdir(), "configured", "master.db"),
    dbDirectory: join(tmpdir(), "configured", "assets"),
  });
});

test("reports persisted identities, extracts and errors without exposing filesystem paths or signed URLs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "import-report-"));
  const path = join(directory, "master.db"),
    source = "https://youtu.be/set";
  MasterDatabase.createManaged(path).close();
  const store = new RekordboxPipelineStore({ source, dbPath: path, outputDirectory: directory });
  try {
    const state = createManifest({
      source,
      provider: "agent",
      url: "https://www.1001tracklists.com/tracklist/set.html",
      complete: false,
      tracks: [
        { order: 1, artist: "Artist", title: "Recording", startSeconds: 0, endSeconds: 60 },
        { order: 2, title: "ID", isId: true },
      ],
    });
    state.entries[0]!.acquisition = {
      status: "downloaded",
      download: {
        backend: "ytdlp",
        kind: "source-set-clip",
        source,
        mediaPath: "/private/clip.m4a",
        files: ["/private/clip.m4a"],
        clip: {
          sourceSetUrl: source,
          startSeconds: 0,
          endSeconds: 60,
          containsTransitions: true,
          qualityNote: "Set extract",
        },
      },
    };
    state.entries[0]!.warnings.push(
      "Recording failed: https://cdn.example/audio?token=private-secret",
    );
    await store.save(state);
    const db = new MasterDatabase({ path, readonly: true, playlistXml: false });
    try {
      const report = inspectImportDetails(db, source)!;
      expect(report.tracklist.url).toContain("1001tracklists");
      expect(report.tracks[0]).toMatchObject({
        kind: "source-set-clip",
        acquisition: "downloaded",
        analyzed: false,
      });
      expect(report.tracks[1]).toMatchObject({ identity: "unidentified" });
      expect(JSON.stringify(report)).not.toContain("private-secret");
      expect(JSON.stringify(report)).not.toContain("/private/");
      expect(inspectImportDetails(db, "https://youtu.be/different")).toBeNull();
    } finally {
      db.close();
    }
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
