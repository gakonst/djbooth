import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, describe, expect, it } from "vitest";

import {
  ContentCue as ContentCueRow,
  DjmdContent,
  DjmdCue,
  MasterDatabase,
  type ContentCueInput,
} from "../src/masterdb/index.js";

const roots: Array<string> = [];
const now = "2026-07-13 12:00:00.000 +00:00";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "rekordbox-ts-cues-"));
  roots.push(root);
  const path = join(root, "master.db");
  const database = new Database(path);
  database.exec(`
    CREATE TABLE agentRegistry (
      registry_id TEXT PRIMARY KEY, int_1 INTEGER, created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    );
    CREATE TABLE djmdContent (
      ID TEXT PRIMARY KEY, UUID TEXT, Length INTEGER, CueUpdated TEXT,
      rb_local_deleted INTEGER DEFAULT 0, rb_local_usn INTEGER,
      created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL
    );
    CREATE TABLE djmdCue (
      ID TEXT PRIMARY KEY, ContentID TEXT, InMsec INTEGER, InFrame INTEGER,
      InMpegFrame INTEGER, InMpegAbs INTEGER, OutMsec INTEGER, OutFrame INTEGER,
      OutMpegFrame INTEGER, OutMpegAbs INTEGER, Kind INTEGER, Color INTEGER,
      ColorTableIndex INTEGER, ActiveLoop INTEGER, Comment TEXT, BeatLoopSize INTEGER,
      CueMicrosec INTEGER, InPointSeekInfo TEXT, OutPointSeekInfo TEXT, ContentUUID TEXT,
      UUID TEXT, rb_data_status INTEGER DEFAULT 0, rb_local_data_status INTEGER DEFAULT 0,
      rb_local_deleted INTEGER DEFAULT 0, rb_local_synced INTEGER DEFAULT 0, usn INTEGER,
      rb_local_usn INTEGER, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL
    );
    CREATE TABLE contentCue (
      ID TEXT PRIMARY KEY, ContentID TEXT, Cues TEXT, rb_cue_count INTEGER, UUID TEXT,
      rb_data_status INTEGER DEFAULT 0, rb_local_data_status INTEGER DEFAULT 0,
      rb_local_deleted INTEGER DEFAULT 0, rb_local_synced INTEGER DEFAULT 0, usn INTEGER,
      rb_local_usn INTEGER, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL
    );
    INSERT INTO agentRegistry VALUES ('localUpdateCount', 100, '${now}', '${now}');
    INSERT INTO djmdContent VALUES ('track-1', 'content-uuid-1', 300, NULL, 0, 1, '${now}', '${now}');
    INSERT INTO djmdContent VALUES ('track-2', 'content-uuid-2', 180, NULL, 0, 2, '${now}', '${now}');
  `);
  database.close();
  return path;
}

function insertCue(
  path: string,
  values: { id: string; kind: number; start: number; end?: number },
): void {
  const database = new Database(path);
  const end = values.end ?? -1;
  database
    .prepare(
      `INSERT INTO djmdCue (
        ID, ContentID, InMsec, InFrame, InMpegFrame, InMpegAbs, OutMsec, OutFrame,
        OutMpegFrame, OutMpegAbs, Kind, Color, ColorTableIndex, ActiveLoop, Comment,
        BeatLoopSize, CueMicrosec, InPointSeekInfo, OutPointSeekInfo, ContentUUID, UUID,
        rb_local_deleted, rb_local_usn, created_at, updated_at
      ) VALUES (?, 'track-1', ?, ?, 0, 0, ?, ?, 0, 0, ?, -1, 0, 0, '', 0, 0,
        NULL, NULL, 'content-uuid-1', ?, 0, 1, ?, ?)`,
    )
    .run(
      values.id,
      values.start,
      Math.floor((values.start * 3) / 20),
      end,
      end < 0 ? 0 : Math.floor((end * 3) / 20),
      values.kind,
      `cue-uuid-${values.id}`,
      now,
      now,
    );
  database.close();
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("MasterDatabase content cues", () => {
  it("reads memory cues chronologically and Hot Cues by slot", () => {
    const path = fixture();
    insertCue(path, { id: "memory-late", kind: 0, start: 90_000 });
    insertCue(path, { id: "hot-b", kind: 2, start: 20_000 });
    insertCue(path, { id: "memory-early", kind: 0, start: 10_000 });
    insertCue(path, { end: 18_000, id: "hot-a", kind: 1, start: 12_000 });

    const db = new MasterDatabase({ path, readonly: true, unlock: false });
    expect(db.getContentCues("track-1")).toEqual([
      expect.objectContaining({ id: "memory-early", kind: "memory", startSeconds: 10 }),
      expect.objectContaining({ id: "memory-late", kind: "memory", startSeconds: 90 }),
      expect.objectContaining({
        endSeconds: 18,
        id: "hot-a",
        kind: "hot",
        slot: 1,
        type: "loop",
      }),
      expect.objectContaining({ id: "hot-b", kind: "hot", slot: 2, type: "cue" }),
    ]);
    const [memory, hot] = [
      db.query(DjmdCue).where({ ID: "memory-early" }).one(),
      db.query(DjmdCue).where({ ID: "hot-a" }).one(),
    ];
    expect([memory.isMemoryCue, memory.isHotCue]).toEqual([true, false]);
    expect([hot.isMemoryCue, hot.isHotCue]).toEqual([false, true]);
    db.close();
  });

  it("creates, updates, and deletes cue rows with exact database fields", () => {
    const path = fixture();
    const db = new MasterDatabase({ path, readonly: false, unlock: false });
    const memory = db.upsertContentCue("track-1", {
      kind: "memory",
      startSeconds: 12.3454,
      type: "cue",
    });
    expect(memory).toMatchObject({
      endSeconds: null,
      kind: "memory",
      slot: null,
      startSeconds: 12.345,
      type: "cue",
    });
    const hot = db.upsertContentCue("track-1", {
      activeLoop: true,
      color: 255,
      colorTableIndex: 36,
      comment: "Drop",
      endSeconds: 24.5,
      kind: "hot",
      slot: 16,
      startSeconds: 20,
      type: "loop",
    });
    expect(hot).toMatchObject({ activeLoop: true, endSeconds: 24.5, slot: 16 });
    const sameHot = db.upsertContentCue("track-1", {
      kind: "hot",
      slot: 16,
      startSeconds: 21,
      type: "cue",
    });
    expect(sameHot.id).toBe(hot.id);
    db.commit();

    expect(
      db.executeSql(
        `SELECT ContentID, ContentUUID, InMsec, InFrame, InMpegFrame, InMpegAbs,
          OutMsec, OutFrame, OutMpegFrame, OutMpegAbs, Kind, ActiveLoop, CueMicrosec
          FROM djmdCue WHERE ID = ?`,
        [memory.id],
      ),
    ).toEqual([
      {
        ActiveLoop: 0,
        ContentID: "track-1",
        ContentUUID: "content-uuid-1",
        CueMicrosec: 0,
        InFrame: 1_851,
        InMpegAbs: 0,
        InMpegFrame: 0,
        InMsec: 12_345,
        Kind: 0,
        OutFrame: 0,
        OutMpegAbs: 0,
        OutMpegFrame: 0,
        OutMsec: -1,
      },
    ]);
    expect(db.getContentCues("track-1")).toHaveLength(2);
    expect(db.query(DjmdContent).where({ ID: "track-1" }).one().CueUpdated).toBe("3");
    const mirror = db.query(ContentCueRow).where({ ContentID: "track-1" }).one();
    expect(mirror.ID).toBe("content-uuid-1");
    expect(JSON.parse(String(mirror.Cues))).toEqual([
      expect.objectContaining({ ID: memory.id, InMsec: 12_345, Kind: 0 }),
      expect.objectContaining({ ID: sameHot.id, InMsec: 21_000, Kind: 16, OutMsec: -1 }),
    ]);

    db.deleteContentCue("track-1", memory.id);
    expect(() => db.deleteContentCue("track-2", sameHot.id)).toThrow(/does not belong/u);
    db.commit();
    expect(db.getContentCues("track-1").map((cue) => cue.id)).toEqual([sameHot.id]);
    const updatedMirror = db.query(ContentCueRow).where({ ContentID: "track-1" }).one();
    expect(JSON.parse(String(updatedMirror.Cues))).toEqual([
      expect.objectContaining({ ID: sameHot.id }),
    ]);
    db.close();
  });

  it("preserves native seek metadata when an edit does not move the cue", () => {
    const path = fixture();
    insertCue(path, { end: 14_000, id: "native-loop", kind: 1, start: 10_000 });
    const sqlite = new Database(path);
    sqlite
      .prepare(
        `UPDATE djmdCue SET BeatLoopSize = 16, ColorTableIndex = NULL, CueMicrosec = 321,
          InMpegFrame = 111, InMpegAbs = 222, InPointSeekInfo = 'in-native',
          OutFrame = OutFrame - 1, OutMpegFrame = 333, OutMpegAbs = 444,
          OutPointSeekInfo = 'out-native'
         WHERE ID = 'native-loop'`,
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO contentCue (
          ID, ContentID, Cues, UUID, rb_local_deleted, created_at, updated_at
        ) VALUES ('content-uuid-1', 'track-1', ?, 'mirror-uuid', 0, ?, ?)`,
      )
      .run(
        JSON.stringify([
          {
            ID: "native-loop",
            Kind: 1,
            VendorField: { keep: true },
          },
        ]),
        now,
        now,
      );
    sqlite.close();

    const db = new MasterDatabase({ path, readonly: false, unlock: false });
    db.upsertContentCue("track-1", {
      comment: "Native metadata stays",
      endSeconds: 14,
      id: "native-loop",
      kind: "hot",
      slot: 1,
      startSeconds: 10,
      type: "loop",
    });
    expect(
      db.executeSql(
        `SELECT BeatLoopSize, ColorTableIndex, CueMicrosec, InFrame, InMpegFrame, InMpegAbs, InPointSeekInfo,
          OutFrame, OutMpegFrame, OutMpegAbs, OutPointSeekInfo
         FROM djmdCue WHERE ID = 'native-loop'`,
      ),
    ).toEqual([
      {
        BeatLoopSize: 16,
        ColorTableIndex: null,
        CueMicrosec: 321,
        InFrame: 1_500,
        InMpegAbs: 222,
        InMpegFrame: 111,
        InPointSeekInfo: "in-native",
        OutMpegAbs: 444,
        OutMpegFrame: 333,
        OutFrame: 2_099,
        OutPointSeekInfo: "out-native",
      },
    ]);
    expect(
      JSON.parse(String(db.query(ContentCueRow).where({ ContentID: "track-1" }).one().Cues)),
    ).toEqual([expect.objectContaining({ ID: "native-loop", VendorField: { keep: true } })]);

    db.upsertContentCue("track-1", {
      endSeconds: 15,
      id: "native-loop",
      kind: "hot",
      slot: 1,
      startSeconds: 11,
      type: "loop",
    });
    expect(
      db.executeSql(
        `SELECT BeatLoopSize, CueMicrosec, InFrame, InMpegFrame, InMpegAbs, InPointSeekInfo,
          OutFrame, OutMpegFrame, OutMpegAbs, OutPointSeekInfo
         FROM djmdCue WHERE ID = 'native-loop'`,
      ),
    ).toEqual([
      {
        BeatLoopSize: 0,
        CueMicrosec: 0,
        InFrame: 1_650,
        InMpegAbs: 0,
        InMpegFrame: 0,
        InPointSeekInfo: null,
        OutMpegAbs: 0,
        OutMpegFrame: 0,
        OutFrame: 2_250,
        OutPointSeekInfo: null,
      },
    ]);
    db.close();
  });

  it("validates cue time, type, slot, color, ownership, and limits before staging", () => {
    const path = fixture();
    insertCue(path, { id: "foreign", kind: 1, start: 1_000 });
    const database = new Database(path);
    database
      .prepare("UPDATE djmdCue SET ContentID = 'track-2', ContentUUID = 'content-uuid-2'")
      .run();
    database.prepare("UPDATE djmdContent SET Length = 0 WHERE ID = 'track-2'").run();
    database.close();
    const db = new MasterDatabase({ path, readonly: false, unlock: false });
    const valid = {
      kind: "memory" as const,
      startSeconds: 10,
      type: "cue" as const,
    };
    expect(db.upsertContentCue("track-2", { ...valid, startSeconds: 60 })).toMatchObject({
      startSeconds: 60,
    });
    expect(() => db.upsertContentCue("track-1", { ...valid, startSeconds: -1 })).toThrow(
      /non-negative/u,
    );
    expect(() => db.upsertContentCue("track-1", { ...valid, startSeconds: 301 })).toThrow(
      /duration/u,
    );
    expect(() =>
      db.upsertContentCue("track-1", {
        endSeconds: 10,
        kind: "memory",
        startSeconds: 10,
        type: "loop",
      }),
    ).toThrow(/must follow/u);
    expect(() =>
      db.upsertContentCue("track-1", { ...valid, endSeconds: 20 } as ContentCueInput),
    ).toThrow(/cannot have endSeconds/u);
    expect(() => db.upsertContentCue("track-1", { ...valid, type: "bogus" as "cue" })).toThrow(
      /type/u,
    );
    expect(() =>
      db.upsertContentCue("track-1", {
        kind: "hot",
        slot: 17 as 16,
        startSeconds: 10,
        type: "cue",
      }),
    ).toThrow(/1 through 16/u);
    expect(() => db.upsertContentCue("track-1", { ...valid, color: 256 })).toThrow(
      /Rekordbox color ID/u,
    );
    expect(() => db.upsertContentCue("track-1", { ...valid, colorTableIndex: 63 })).toThrow(
      /0 through 62/u,
    );
    expect(() => db.upsertContentCue("track-1", { ...valid, id: "foreign" })).toThrow(
      /does not belong/u,
    );
    expect(() =>
      db.setContentCues(
        "track-1",
        Array.from({ length: 11 }, () => valid),
      ),
    ).toThrow(/10 memory/u);
    expect(db.getContentCues("track-1")).toEqual([]);
    db.close();
  });

  it("replaces cue state atomically while preserving IDs and enforcing canonical order", () => {
    const path = fixture();
    insertCue(path, { id: "keep-memory", kind: 0, start: 10_000 });
    insertCue(path, { id: "remove-memory", kind: 0, start: 20_000 });
    insertCue(path, { id: "keep-hot", kind: 2, start: 30_000 });
    const db = new MasterDatabase({ path, readonly: false, unlock: false });

    expect(() =>
      db.setContentCues("track-1", [
        { kind: "hot", slot: 1, startSeconds: 10, type: "cue" },
        { kind: "memory", startSeconds: 20, type: "cue" },
      ]),
    ).toThrow(/must precede/u);
    expect(() =>
      db.setContentCues("track-1", [
        { kind: "memory", startSeconds: 20, type: "cue" },
        { kind: "memory", startSeconds: 10, type: "cue" },
      ]),
    ).toThrow(/chronologically/u);
    expect(() =>
      db.setContentCues("track-1", [
        { kind: "hot", slot: 2, startSeconds: 20, type: "cue" },
        { kind: "hot", slot: 1, startSeconds: 10, type: "cue" },
      ]),
    ).toThrow(/slot/u);

    const cues = db.setContentCues("track-1", [
      {
        id: "keep-memory",
        kind: "memory",
        startSeconds: 12,
        type: "cue",
      },
      { kind: "hot", slot: 1, startSeconds: 25, type: "cue" },
      { kind: "hot", slot: 2, startSeconds: 35, type: "cue" },
    ]);
    expect(cues.map(({ id, slot, startSeconds }) => [id, slot, startSeconds])).toEqual([
      ["keep-memory", null, 12],
      [expect.any(String), 1, 25],
      ["keep-hot", 2, 35],
    ]);
    db.commit();
    expect(db.getContentCues("track-1")).toEqual(cues);
    expect(db.query(DjmdCue).where({ ID: "remove-memory" }).count()).toBe(0);
    db.close();
  });
});
