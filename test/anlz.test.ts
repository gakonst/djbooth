import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AnlzFile,
  BeatGridTag,
  getAnlzPaths,
  isAnlzFile,
  MonochromeWaveformTag,
  PathTag,
  PQTZAnlzTag,
  readAnlzFiles,
  TAGS,
  walkAnlzDirectories,
  walkAnlzPaths,
} from "../src/anlz/index.js";

function encodeUtf16Be(value: string): Buffer {
  const data = Buffer.from(value, "utf16le");
  data.swap16();
  return data;
}

function tag(type: string, lenHeader: number, content: Buffer): Buffer {
  const data = Buffer.alloc(12 + content.length);
  data.write(type, 0, "ascii");
  data.writeUInt32BE(lenHeader, 4);
  data.writeUInt32BE(data.length, 8);
  content.copy(data, 12);
  return data;
}

function beatGridTag(): Buffer {
  const content = Buffer.alloc(12 + 3 * 8);
  content.writeUInt32BE(0x80000, 4);
  content.writeUInt32BE(3, 8);
  const entries = [
    { beat: 1, bpm: 128, time: 0.025 },
    { beat: 2, bpm: 128, time: 0.494 },
    { beat: 3, bpm: 127.5, time: 0.965 },
  ];
  for (const [index, entry] of entries.entries()) {
    const offset = 12 + index * 8;
    content.writeUInt16BE(entry.beat, offset);
    content.writeUInt16BE(entry.bpm * 100, offset + 2);
    content.writeUInt32BE(entry.time * 1_000, offset + 4);
  }
  return tag("PQTZ", 24, content);
}

function pathTag(path: string): Buffer {
  const encoded = encodeUtf16Be(path);
  const content = Buffer.alloc(4 + encoded.length + 2);
  content.writeUInt32BE(encoded.length + 2, 0);
  encoded.copy(content, 4);
  return tag("PPTH", 16, content);
}

function waveformTag(): Buffer {
  const entries = Buffer.from([0b001_00001, 0b111_11111, 0b100_01010]);
  const content = Buffer.alloc(8 + entries.length);
  content.writeUInt32BE(entries.length, 0);
  content.writeUInt32BE(0x10000, 4);
  entries.copy(content, 8);
  return tag("PWAV", 20, content);
}

function unknownTag(): Buffer {
  return tag("TEST", 12, Buffer.from("unknown payload"));
}

function anlzData(): Buffer {
  const tags = [beatGridTag(), pathTag("C:/Music/Test.mp3"), waveformTag(), unknownTag()];
  const length = 28 + tags.reduce((sum, value) => sum + value.length, 0);
  const header = Buffer.alloc(28);
  header.write("PMAI", 0, "ascii");
  header.writeUInt32BE(28, 4);
  header.writeUInt32BE(length, 8);
  return Buffer.concat([header, ...tags]);
}

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("ANLZ parsing", () => {
  it("parses tags and rebuilds untouched files byte-for-byte", () => {
    const source = anlzData();
    const file = AnlzFile.parse(source);
    expect(file.fileHeader).toMatchObject({ lenFile: source.length, lenHeader: 28, type: "PMAI" });
    expect(file.tagTypes).toEqual(["PQTZ", "PPTH", "PWAV", "TEST"]);
    expect(file.build()).toEqual(source);
    expect(file.getTag("TEST").get()).toEqual({ bytes: 15 });
  });

  it("parses and mutates beat grids in seconds and BPM", () => {
    const file = AnlzFile.parse(anlzData());
    const grid = file.getTag("beat_grid");
    expect(grid).toBeInstanceOf(BeatGridTag);
    expect(grid).toBeInstanceOf(PQTZAnlzTag);
    expect(TAGS.PQTZ).toBe(PQTZAnlzTag);
    if (!(grid instanceof BeatGridTag)) throw new TypeError("Expected beat grid");
    expect(grid.get()).toEqual([
      { beat: 1, bpm: 128, time: 0.025 },
      { beat: 2, bpm: 128, time: 0.494 },
      { beat: 3, bpm: 127.5, time: 0.965 },
    ]);
    grid.set([1, 1, 1], [120, 120, 120], [0, 0.5, 1]);

    const rebuilt = AnlzFile.parse(file.build()).getTag("PQTZ");
    expect(rebuilt).toBeInstanceOf(BeatGridTag);
    expect((rebuilt as BeatGridTag).getBpms()).toEqual([120, 120, 120]);
    expect((rebuilt as BeatGridTag).getTimes()).toEqual([0, 0.5, 1]);
  });

  it("parses paths and updates variable tag/file lengths", () => {
    const file = AnlzFile.parse(anlzData());
    expect(file.get("path")).toBe("C:/Music/Test.mp3");
    const originalLength = file.fileHeader.lenFile;
    file.setPath("C:\\A much longer path\\New.mp3");
    const rebuilt = file.build();
    expect(rebuilt.length).toBeGreaterThan(originalLength);
    const path = AnlzFile.parse(rebuilt).getTag("PPTH");
    expect(path).toBeInstanceOf(PathTag);
    expect(path.get()).toBe("C:/A much longer path/New.mp3");
  });

  it("decodes packed monochrome waveform height and color", () => {
    const waveform = AnlzFile.parse(anlzData()).getTag("wf_preview");
    expect(waveform).toBeInstanceOf(MonochromeWaveformTag);
    expect(waveform.get()).toEqual({ colors: [1, 7, 4], heights: [1, 31, 10] });
  });
});

describe("ANLZ discovery", () => {
  it("finds and reads supported files recursively", () => {
    const root = mkdtempSync(join(tmpdir(), "rekordbox-ts-anlz-"));
    roots.push(root);
    const directory = join(root, "P001", "00000001");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "ANLZ0000.DAT"), anlzData());
    writeFileSync(join(directory, "ANLZ0000.EXT"), anlzData());

    expect(isAnlzFile(join(directory, "ANLZ0000.DAT"))).toBe(true);
    expect(walkAnlzDirectories(root)).toEqual([directory]);
    expect(walkAnlzPaths(root)[0]?.[0]).toBe(directory);
    expect(getAnlzPaths(directory)).toMatchObject({
      DAT: join(directory, "ANLZ0000.DAT"),
      EXT: join(directory, "ANLZ0000.EXT"),
    });
    expect(readAnlzFiles(directory).size).toBe(2);
  });
});
