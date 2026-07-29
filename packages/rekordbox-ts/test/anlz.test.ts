import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AnlzFile,
  AnlzLengthError,
  BeatGridTag,
  ExtendedBeatGridTag,
  getAnlzPaths,
  isAnlzFile,
  MonochromeWaveformTag,
  PathTag,
  PQTZAnlzTag,
  PSSIAnlzTag,
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

function extendedBeatGridTag(): Buffer {
  const content = Buffer.alloc(44);
  const anchors = [
    { beat: 1, bpm: 128, time: 0.1 },
    { beat: 2, bpm: 129, time: 0.6 },
  ];
  anchors.forEach((entry, index) => {
    const offset = 12 + index * 8;
    content.writeUInt16BE(entry.beat, offset);
    content.writeUInt16BE(entry.bpm * 100, offset + 2);
    content.writeUInt32BE(entry.time * 1_000, offset + 4);
  });
  content.writeUInt32BE(0, 28);
  return tag("PQT2", 56, content);
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

  it("mutates extended PQT2 anchors and arbitrary raw tag fields", () => {
    const tags = [extendedBeatGridTag(), unknownTag()];
    const header = Buffer.alloc(28);
    header.write("PMAI", 0, "ascii");
    header.writeUInt32BE(28, 4);
    header.writeUInt32BE(28 + tags.reduce((sum, value) => sum + value.length, 0), 8);
    const file = AnlzFile.parse(Buffer.concat([header, ...tags]));
    const grid = file.getTag("PQT2");
    expect(grid).toBeInstanceOf(ExtendedBeatGridTag);
    if (!(grid instanceof ExtendedBeatGridTag)) throw new TypeError("Expected PQT2");
    grid.setBeats([3, 4]);
    grid.setBpms([120, 121.5]);
    grid.setTimes([1, 1.5]);

    const unknown = file.getTag("TEST");
    unknown.editRaw((data) => {
      data[12] = 0x58;
    });
    const rebuilt = AnlzFile.parse(file.build());
    const reparsed = rebuilt.getTag("PQT2") as ExtendedBeatGridTag;
    expect(reparsed.get()).toEqual([
      { beat: 3, bpm: 120, time: 1 },
      { beat: 4, bpm: 121.5, time: 1.5 },
    ]);
    expect(rebuilt.getTag("TEST").rawData[12]).toBe(0x58);
  });

  it("re-obfuscates PSSI after low-level parsed edits", () => {
    const mask = Buffer.from("cbe1eefae5eeadeee9d2e9ebe1e9f3e8e9f4e1", "hex");
    const structure = Buffer.alloc(32);
    structure.write("PSSI", 0, "ascii");
    structure.writeUInt32BE(32, 4);
    structure.writeUInt32BE(32, 8);
    structure.writeUInt16BE(0, 16);
    structure.writeUInt16BE(2, 18);
    const obfuscated = Buffer.from(structure);
    for (let index = 18; index < obfuscated.length; index++)
      obfuscated[index] = obfuscated[index]! ^ mask[(index - 18) % mask.length]!;

    const header = Buffer.alloc(28);
    header.write("PMAI", 0, "ascii");
    header.writeUInt32BE(28, 4);
    header.writeUInt32BE(60, 8);
    const file = AnlzFile.parse(Buffer.concat([header, obfuscated]));
    const pssi = file.getTag("PSSI");
    pssi.editParsed((data) => {
      data[30] = 7;
    });
    const rebuilt = file.build();
    expect(rebuilt.readUInt16BE(28 + 18)).not.toBe(2);
    const reparsed = AnlzFile.parse(rebuilt);
    expect(reparsed.getTag("PSSI").get()).toMatchObject({ bank: 7, mood: 2 });
    expect(reparsed.build()).toEqual(rebuilt);
  });

  it("decodes every known PSSI phrase flag and internal beat", () => {
    const structure = Buffer.alloc(104);
    structure.write("PSSI", 0, "ascii");
    structure.writeUInt32BE(32, 4);
    structure.writeUInt32BE(104, 8);
    structure.writeUInt32BE(24, 12);
    structure.writeUInt16BE(3, 16);
    structure.writeUInt16BE(1, 18);
    structure.writeUInt16BE(65, 26);
    structure[28] = 1;
    structure[29] = 2;
    structure[30] = 7;
    structure.writeUInt16BE(1, 32);
    structure.writeUInt16BE(9, 34);
    structure.writeUInt16BE(2, 36);
    structure[41] = 1;
    structure[43] = 1;
    structure.writeUInt16BE(17, 44);
    structure.writeUInt16BE(21, 46);
    structure.writeUInt16BE(25, 48);
    structure[53] = 1;
    structure.writeUInt16BE(29, 54);
    structure.writeUInt16BE(2, 56);
    structure.writeUInt16BE(33, 58);
    structure.writeUInt16BE(2, 60);
    structure[75] = 1;
    structure.writeUInt16BE(3, 80);
    structure.writeUInt16BE(65, 82);
    structure.writeUInt16BE(6, 84);
    structure[87] = 1;

    const parsed = new PSSIAnlzTag(structure).get();
    expect(parsed).toEqual({
      bank: 7,
      endBeat: 65,
      entries: [
        {
          b: 1,
          beat: 9,
          beat2: 17,
          beat3: 21,
          beat4: 25,
          beatFill: 29,
          fill: 1,
          index: 1,
          k1: 0,
          k2: 1,
          k3: 0,
          kind: 2,
        },
        {
          b: 0,
          beat: 33,
          beat2: 0,
          beat3: 0,
          beat4: 0,
          beatFill: 0,
          fill: 0,
          index: 2,
          k1: 0,
          k2: 0,
          k3: 1,
          kind: 2,
        },
        {
          b: 0,
          beat: 65,
          beat2: 0,
          beat3: 0,
          beat4: 0,
          beatFill: 0,
          fill: 0,
          index: 3,
          k1: 1,
          k2: 0,
          k3: 0,
          kind: 6,
        },
      ],
      mood: 1,
      unknown1: 1,
      unknown2: 2,
    });
  });

  it("turns every known truncated tag boundary into a format error", () => {
    const minimums: Record<string, [number, number]> = {
      PCO2: [20, 20],
      PCOB: [24, 24],
      PPTH: [16, 16],
      PQT2: [56, 56],
      PQTZ: [24, 24],
      PSSI: [32, 32],
      PVBR: [16, 1616],
      PWAV: [20, 20],
      PWV2: [20, 20],
      PWV3: [24, 24],
      PWV4: [24, 24],
      PWV5: [24, 24],
      PWV6: [20, 20],
      PWV7: [24, 24],
      PWVC: [20, 20],
    };
    for (const [type, [headerLength, minimum]] of Object.entries(minimums)) {
      for (const length of new Set([12, Math.max(12, minimum - 1)])) {
        const malformed = Buffer.alloc(length);
        malformed.write(type, 0, "ascii");
        malformed.writeUInt32BE(headerLength, 4);
        malformed.writeUInt32BE(length, 8);
        const header = Buffer.alloc(28);
        header.write("PMAI", 0, "ascii");
        header.writeUInt32BE(28, 4);
        header.writeUInt32BE(28 + length, 8);
        expect(
          () => AnlzFile.parse(Buffer.concat([header, malformed])),
          `${type}/${length}`,
        ).toThrow(AnlzLengthError);
      }
    }
  });

  it("survives deterministic mutation fuzzing without native buffer exceptions", () => {
    const source = anlzData();
    let state = 0x9e37_79b9;
    const random = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return state >>> 0;
    };
    for (let iteration = 0; iteration < 1_000; iteration++) {
      const length = random() % (source.length + 32);
      const candidate = Buffer.alloc(length);
      source.copy(candidate, 0, 0, Math.min(source.length, length));
      for (let mutation = 0; mutation < 1 + (random() % 8); mutation++) {
        if (!candidate.length) break;
        candidate[random() % candidate.length] = random() & 0xff;
      }
      try {
        const parsed = AnlzFile.parse(candidate);
        for (const parsedTag of parsed.tags) {
          parsedTag.summary();
          parsedTag.get();
        }
        expect(AnlzFile.parse(parsed.build()).build()).toEqual(parsed.build());
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as NodeJS.ErrnoException).code).not.toBe("ERR_OUT_OF_RANGE");
      }
    }
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
