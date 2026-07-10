import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

const xorMask = Buffer.from("cbe1eefae5eeadeee9d2e9ebe1e9f3e8e9f4e1", "hex");
const anlzPattern = /^ANLZ\d{4}\.(?:DAT|EXT|2EX)$/u;

/** Header shared by an ANLZ file and its tag records. */
export type AnlzHeader = {
  lenFile: number;
  lenHeader: number;
  type: string;
};

/** One beat-grid tick. */
export type BeatGridEntry = {
  beat: number;
  bpm: number;
  time: number;
};

/** Parsed waveform height and color-index arrays. */
export type MonochromeWaveform = {
  colors: Array<number>;
  heights: Array<number>;
};

/** Error thrown when declared ANLZ lengths are inconsistent. */
export class AnlzLengthError extends Error {
  override name = "AnlzLengthError";
}

/** Upstream-compatible file-length error name. */
export { AnlzLengthError as BuildFileLengthError, AnlzLengthError as BuildTagLengthError };

function assertRange(data: Buffer, offset: number, length: number, context: string): void {
  if (offset < 0 || length < 0 || offset + length > data.length)
    throw new AnlzLengthError(`${context} exceeds the ${data.length}-byte buffer`);
}

function decodeUtf16Be(data: Buffer): string {
  if (data.length % 2 !== 0) throw new TypeError("UTF-16BE data has an odd byte length");
  const swapped = Buffer.from(data);
  swapped.swap16();
  let value = swapped.toString("utf16le");
  while (value.endsWith(String.fromCharCode(0))) value = value.slice(0, -1);
  return value;
}

function encodeUtf16Be(value: string): Buffer {
  const encoded = Buffer.from(value, "utf16le");
  encoded.swap16();
  return encoded;
}

function deobfuscatePssi(data: Buffer): Buffer {
  const mood = data.readUInt16BE(18);
  if (mood >= 1 && mood <= 3) return Buffer.from(data);
  const count = data.readUInt16BE(16);
  const result = Buffer.from(data);
  for (let index = 18; index < result.length; index++)
    result[index] = result[index]! ^ ((xorMask[(index - 18) % xorMask.length]! + count) & 0xff);
  return result;
}

function parseTagHeader(data: Buffer): AnlzHeader {
  assertRange(data, 0, 12, "ANLZ tag header");
  return {
    lenFile: data.readUInt32BE(8),
    lenHeader: data.readUInt32BE(4),
    type: data.toString("ascii", 0, 4),
  };
}

/** Base class for one typed ANLZ tag. */
export class AbstractAnlzTag {
  /** Four-character ANLZ tag type. */
  type: string;
  /** Stable semantic lookup name. */
  name: string;
  /** Declared tag-header length. */
  lenHeader: number;
  /** Declared total tag length. */
  lenTag: number;

  protected data: Buffer;
  protected original: Buffer;
  protected dirty = false;

  constructor(data: Buffer, name?: string) {
    const header = parseTagHeader(data);
    if (header.lenFile < 12 || header.lenFile > data.length)
      throw new AnlzLengthError(`Invalid ${header.type} tag length ${header.lenFile}`);
    this.type = header.type;
    this.name = name ?? header.type;
    this.lenHeader = header.lenHeader;
    this.lenTag = header.lenFile;
    this.original = Buffer.from(data.subarray(0, this.lenTag));
    this.data = this.type === "PSSI" ? deobfuscatePssi(this.original) : Buffer.from(this.original);
  }

  /** Return parsed tag content. Unknown tags return raw payload metadata. */
  get(): unknown {
    return { bytes: this.lenTag - 12 };
  }

  /** Rebuild this tag, preserving untouched original bytes. */
  build(): Buffer {
    return Buffer.from(this.dirty ? this.data : this.original);
  }

  /** Return a bounded metadata representation without expanding large waveform arrays. */
  summary(): Record<string, unknown> {
    return { lenHeader: this.lenHeader, lenTag: this.lenTag, name: this.name, type: this.type };
  }

  /** Convert the complete parsed value to structured data. */
  toJSON(): Record<string, unknown> {
    return { ...this.summary(), value: this.get() };
  }
}

/** Standard beat-grid (`PQTZ`) tag. */
export class BeatGridTag extends AbstractAnlzTag {
  constructor(data: Buffer) {
    super(data, "beat_grid");
    if (this.lenHeader !== 24)
      throw new AnlzLengthError(`Unexpected PQTZ header ${this.lenHeader}`);
    const count = this.data.readUInt32BE(20);
    assertRange(this.data, 24, count * 8, "PQTZ entries");
  }

  /** Number of beat-grid entries. */
  get count(): number {
    return this.data.readUInt32BE(20);
  }

  get beats(): Array<number> {
    return this.getBeats();
  }
  get bpms(): Array<number> {
    return this.getBpms();
  }
  get times(): Array<number> {
    return this.getTimes();
  }
  get bpmsAverage(): number {
    return this.averageBpm;
  }
  get bpmsUnique(): Array<number> {
    return [...new Set(this.getBpms())];
  }

  /** Parse all beat-grid entries, with BPM and time in user-facing units. */
  override get(): Array<BeatGridEntry> {
    return Array.from({ length: this.count }, (_, index) => {
      const offset = 24 + index * 8;
      return {
        beat: this.data.readUInt16BE(offset),
        bpm: this.data.readUInt16BE(offset + 2) / 100,
        time: this.data.readUInt32BE(offset + 4) / 1_000,
      };
    });
  }

  /** Beat numbers in file order. */
  getBeats(): Array<number> {
    return this.get().map((entry) => entry.beat);
  }

  /** BPM values in file order. */
  getBpms(): Array<number> {
    return this.get().map((entry) => entry.bpm);
  }

  /** Beat times in seconds. */
  getTimes(): Array<number> {
    return this.get().map((entry) => entry.time);
  }

  /** Arithmetic mean BPM, or zero for an empty grid. */
  get averageBpm(): number {
    const bpms = this.getBpms();
    return bpms.length ? bpms.reduce((sum, bpm) => sum + bpm, 0) / bpms.length : 0;
  }

  /** Replace every existing beat-grid value without changing entry count. */
  set(beats: Array<number>, bpms: Array<number>, times: Array<number>): void {
    if (beats.length !== this.count || bpms.length !== this.count || times.length !== this.count)
      throw new RangeError(`Expected ${this.count} beats, BPMs, and times`);
    for (let index = 0; index < this.count; index++) {
      const offset = 24 + index * 8;
      this.data.writeUInt16BE(beats[index]!, offset);
      this.data.writeUInt16BE(Math.trunc(bpms[index]! * 100), offset + 2);
      this.data.writeUInt32BE(Math.trunc(times[index]! * 1_000), offset + 4);
    }
    this.dirty = true;
  }

  /** Replace beat numbers only. */
  setBeats(beats: Array<number>): void {
    this.set(beats, this.getBpms(), this.getTimes());
  }

  /** Replace BPM values only. */
  setBpms(bpms: Array<number>): void {
    this.set(this.getBeats(), bpms, this.getTimes());
  }

  /** Replace beat times only. */
  setTimes(times: Array<number>): void {
    this.set(this.getBeats(), this.getBpms(), times);
  }

  override summary(): Record<string, unknown> {
    return { ...super.summary(), averageBpm: this.averageBpm, count: this.count };
  }
}

/** Extended beat-grid (`PQT2`) tag. */
export class ExtendedBeatGridTag extends AbstractAnlzTag {
  constructor(data: Buffer) {
    super(data, "beat_grid2");
    if (this.lenHeader !== 56)
      throw new AnlzLengthError(`Unexpected PQT2 header ${this.lenHeader}`);
  }

  /** Two tempo anchors stored in the extended tag. */
  override get(): Array<BeatGridEntry> {
    return [0, 1].map((index) => {
      const offset = 24 + index * 8;
      return {
        beat: this.data.readUInt16BE(offset),
        bpm: this.data.readUInt16BE(offset + 2) / 100,
        time: this.data.readUInt32BE(offset + 4) / 1_000,
      };
    });
  }

  /** Fine-grained two-byte beat entries. */
  getBeatGrid(): Array<{ beat: number; unknown: number }> {
    const count = this.data.readUInt32BE(40);
    assertRange(this.data, 56, count * 2, "PQT2 entries");
    return Array.from({ length: count }, (_, index) => ({
      beat: this.data[56 + index * 2]!,
      unknown: this.data[57 + index * 2]!,
    }));
  }

  override summary(): Record<string, unknown> {
    return { ...super.summary(), beatGridCount: this.data.readUInt32BE(40) };
  }
}

/** Track-path (`PPTH`) tag. */
export class PathTag extends AbstractAnlzTag {
  constructor(data: Buffer) {
    super(data, "path");
  }

  /** Decoded path with Rekordbox's forward-slash convention. */
  override get(): string {
    const length = this.data.readUInt32BE(12);
    if (length < 2) return "";
    assertRange(this.data, 16, length, "PPTH path");
    return decodeUtf16Be(this.data.subarray(16, 16 + length - 2));
  }

  /** Replace the path and update both tag length fields. */
  set(path: string): void {
    const normalized = path.replaceAll("\\", "/");
    const encoded = encodeUtf16Be(normalized);
    const pathLength = encoded.length + 2;
    const data = Buffer.alloc(this.lenHeader + pathLength);
    this.data.copy(data, 0, 0, Math.min(this.lenHeader, this.data.length));
    data.writeUInt32BE(data.length, 8);
    data.writeUInt32BE(pathLength, 12);
    encoded.copy(data, 16);
    this.data = data;
    this.lenTag = data.length;
    this.dirty = true;
  }

  override summary(): Record<string, unknown> {
    return { ...super.summary(), path: this.get() };
  }
}

/** Variable-bit-rate seek index (`PVBR`) tag. */
export class VbrTag extends AbstractAnlzTag {
  constructor(data: Buffer) {
    super(data, "vbr");
  }

  override get(): Array<number> {
    assertRange(this.data, 16, 400 * 4, "PVBR index");
    return Array.from({ length: 400 }, (_, index) => this.data.readUInt32BE(16 + index * 4));
  }
}

function parseMonochrome(entries: Buffer): MonochromeWaveform {
  return {
    colors: [...entries].map((value) => value >> 5),
    heights: [...entries].map((value) => value & 0x1f),
  };
}

/** Monochrome preview/detail waveform tag (`PWAV`, `PWV2`, or `PWV3`). */
export class MonochromeWaveformTag extends AbstractAnlzTag {
  constructor(data: Buffer, name: string) {
    super(data, name);
  }

  override get(): MonochromeWaveform {
    const offset = this.type === "PWV3" ? 24 : 20;
    const count = this.data.readUInt32BE(this.type === "PWV3" ? 16 : 12);
    assertRange(this.data, offset, count, `${this.type} entries`);
    return parseMonochrome(this.data.subarray(offset, offset + count));
  }

  override summary(): Record<string, unknown> {
    const count = this.data.readUInt32BE(this.type === "PWV3" ? 16 : 12);
    return { ...super.summary(), count };
  }
}

/** Color-preview waveform (`PWV4`) tag. */
export class ColorPreviewWaveformTag extends AbstractAnlzTag {
  constructor(data: Buffer) {
    super(data, "wf_color");
  }

  override get(): {
    blueColors: Array<[Array<number>, Array<number>]>;
    colors: Array<[Array<number>, Array<number>]>;
    heights: Array<[number, number]>;
  } {
    const count = this.data.readUInt32BE(16);
    assertRange(this.data, 24, count * 6, "PWV4 entries");
    const heights: Array<[number, number]> = [];
    const colors: Array<[Array<number>, Array<number>]> = [];
    const blueColors: Array<[Array<number>, Array<number>]> = [];
    for (let index = 0; index < count; index++) {
      const offset = 24 + index * 6;
      const boost = this.data[offset + 1]!;
      const inverseBlue = this.data[offset + 2]! & 0x7f;
      const red = this.data[offset + 3]! & 0x7f;
      const green = this.data[offset + 4]! & 0x7f;
      const blue = this.data[offset + 5]! & 0x7f;
      const backHeight = Math.max(inverseBlue, red, green);
      heights.push([blue, backHeight]);
      const color = [red, green, blue].map((value) => Math.trunc(value * (boost / 127)));
      colors.push([color, color.map((value) => value + 32)]);
      const blueColor = [1, 0.5, 0.25].map((factor) => Math.trunc(95 - inverseBlue * factor));
      blueColors.push([blueColor, blueColor.map((value) => value + 32)]);
    }
    return { blueColors, colors, heights };
  }

  override summary(): Record<string, unknown> {
    return { ...super.summary(), count: this.data.readUInt32BE(16) };
  }
}

/** Color-detail waveform (`PWV5`) tag. */
export class ColorDetailWaveformTag extends AbstractAnlzTag {
  constructor(data: Buffer) {
    super(data, "wf_color_detail");
  }

  override get(): { colors: Array<[number, number, number]>; heights: Array<number> } {
    const count = this.data.readUInt32BE(16);
    assertRange(this.data, 24, count * 2, "PWV5 entries");
    const heights: Array<number> = [];
    const colors: Array<[number, number, number]> = [];
    for (let index = 0; index < count; index++) {
      const value = this.data.readUInt16BE(24 + index * 2);
      colors.push([(value & 0xe000) >> 13, (value & 0x1c00) >> 10, (value & 0x0380) >> 7]);
      heights.push(((value & 0x007c) >> 2) / 31);
    }
    return { colors, heights };
  }

  override summary(): Record<string, unknown> {
    return { ...super.summary(), count: this.data.readUInt32BE(16) };
  }
}

/** Generic three-byte waveform (`PWV6` or `PWV7`) tag. */
export class ThreeByteWaveformTag extends AbstractAnlzTag {
  constructor(data: Buffer) {
    super(data, parseTagHeader(data).type);
  }

  override get(): Array<[number, number, number]> {
    const count = this.data.readUInt32BE(16);
    const offset = this.type === "PWV7" ? 24 : 20;
    assertRange(this.data, offset, count * 3, `${this.type} entries`);
    return Array.from({ length: count }, (_, index) => [
      this.data[offset + index * 3]!,
      this.data[offset + index * 3 + 1]!,
      this.data[offset + index * 3 + 2]!,
    ]);
  }

  override summary(): Record<string, unknown> {
    return { ...super.summary(), count: this.data.readUInt32BE(16) };
  }
}

/** Song-structure (`PSSI`) tag, transparently deobfuscated on read. */
export class SongStructureTag extends AbstractAnlzTag {
  constructor(data: Buffer) {
    super(data, "structure");
  }

  override get(): Record<string, unknown> {
    const count = this.data.readUInt16BE(16);
    assertRange(this.data, 32, count * 24, "PSSI entries");
    return {
      bank: this.data[30],
      endBeat: this.data.readUInt16BE(26),
      entries: Array.from({ length: count }, (_, index) => {
        const offset = 32 + index * 24;
        return {
          b: this.data[offset + 11],
          beat: this.data.readUInt16BE(offset + 2),
          beat2: this.data.readUInt16BE(offset + 12),
          beat3: this.data.readUInt16BE(offset + 14),
          beat4: this.data.readUInt16BE(offset + 16),
          beatFill: this.data.readUInt16BE(offset + 22),
          fill: this.data[offset + 21],
          index: this.data.readUInt16BE(offset),
          kind: this.data.readUInt16BE(offset + 4),
        };
      }),
      mood: this.data.readUInt16BE(18),
    };
  }

  override summary(): Record<string, unknown> {
    return {
      ...super.summary(),
      bank: this.data[30],
      count: this.data.readUInt16BE(16),
      mood: this.data.readUInt16BE(18),
    };
  }
}

function parsePcob(data: Buffer): Record<string, unknown> {
  const count = data.readUInt16BE(18);
  let offset = 24;
  const entries: Array<Record<string, unknown>> = [];
  for (let index = 0; index < count; index++) {
    assertRange(data, offset, 40, "PCOB cue entry");
    const length = data.readUInt32BE(offset + 8);
    assertRange(data, offset, length, "PCOB cue entry");
    entries.push({
      hotCue: data.readUInt32BE(offset + 12),
      loopTime: data.readUInt32BE(offset + 36),
      orderFirst: data.readUInt16BE(offset + 24),
      orderLast: data.readUInt16BE(offset + 26),
      status: data.readUInt32BE(offset + 16) === 4 ? "enabled" : "disabled",
      time: data.readUInt32BE(offset + 32),
      type: data[offset + 28] === 2 ? "loop" : "single",
    });
    offset += length;
  }
  return {
    count,
    cueType: data.readUInt32BE(12) === 1 ? "hotcue" : "memory",
    entries,
    memoryCount: data.readInt32BE(20),
  };
}

function parsePco2(data: Buffer): Record<string, unknown> {
  const count = data.readUInt16BE(16);
  let offset = 20;
  const entries: Array<Record<string, unknown>> = [];
  for (let index = 0; index < count; index++) {
    assertRange(data, offset, 48, "PCO2 cue entry");
    const length = data.readUInt32BE(offset + 8);
    const commentLength = data.readUInt32BE(offset + 40);
    assertRange(data, offset, length, "PCO2 cue entry");
    const colorOffset = offset + 44 + commentLength;
    assertRange(data, colorOffset, 4, "PCO2 color");
    entries.push({
      color: {
        blue: data[colorOffset + 3],
        code: data[colorOffset],
        green: data[colorOffset + 2],
        id: data[offset + 28],
        red: data[colorOffset + 1],
      },
      comment: decodeUtf16Be(data.subarray(offset + 44, colorOffset)),
      hotCue: data.readUInt32BE(offset + 12),
      loopDenominator: data.readUInt16BE(offset + 38),
      loopEnumerator: data.readUInt16BE(offset + 36),
      loopTime: data.readUInt32BE(offset + 24),
      time: data.readUInt32BE(offset + 20),
      type: data[offset + 16],
    });
    offset += length;
  }
  return { count, cueType: data.readUInt32BE(12) === 1 ? "hotcue" : "memory", entries };
}

/** Cue-list (`PCOB` or `PCO2`) tag. */
export class CueListTag extends AbstractAnlzTag {
  constructor(data: Buffer, name: string) {
    super(data, name);
  }

  override get(): Record<string, unknown> {
    return this.type === "PCOB" ? parsePcob(this.data) : parsePco2(this.data);
  }

  override summary(): Record<string, unknown> {
    const count = this.type === "PCOB" ? this.data.readUInt16BE(18) : this.data.readUInt16BE(16);
    return { ...super.summary(), count };
  }
}

/** Small fixed `PWVC` tag. */
export class WaveformColorConfigTag extends AbstractAnlzTag {
  constructor(data: Buffer) {
    super(data, "PWVC");
  }

  override get(): { data: Array<number>; unknown: number } {
    return {
      data: [0, 1, 2].map((index) => this.data.readUInt16BE(14 + index * 2)),
      unknown: this.data.readUInt16BE(12),
    };
  }
}

// Upstream tag-class names retained for direct migrations from pyrekordbox.
export class PQTZAnlzTag extends BeatGridTag {}
export class PQT2AnlzTag extends ExtendedBeatGridTag {}
export class PCOBAnlzTag extends CueListTag {
  constructor(data: Buffer) {
    super(data, "cue_list");
  }
}
export class PCO2AnlzTag extends CueListTag {
  constructor(data: Buffer) {
    super(data, "cue_list2");
  }
}
export class PPTHAnlzTag extends PathTag {}
export class PVBRAnlzTag extends VbrTag {}
export class PSSIAnlzTag extends SongStructureTag {}
export class PWAVAnlzTag extends MonochromeWaveformTag {
  constructor(data: Buffer) {
    super(data, "wf_preview");
  }
}
export class PWV2AnlzTag extends MonochromeWaveformTag {
  constructor(data: Buffer) {
    super(data, "wf_tiny_preview");
  }
}
export class PWV3AnlzTag extends MonochromeWaveformTag {
  constructor(data: Buffer) {
    super(data, "wf_detail");
  }
}
export class PWV4AnlzTag extends ColorPreviewWaveformTag {}
export class PWV5AnlzTag extends ColorDetailWaveformTag {}
export class PWV6AnlzTag extends ThreeByteWaveformTag {}
export class PWV7AnlzTag extends ThreeByteWaveformTag {}
export class PWVCAnlzTag extends WaveformColorConfigTag {}

/** Tag handlers keyed by the four-character names used by pyrekordbox. */
export const TAGS = {
  PCO2: PCO2AnlzTag,
  PCOB: PCOBAnlzTag,
  PPTH: PPTHAnlzTag,
  PQT2: PQT2AnlzTag,
  PQTZ: PQTZAnlzTag,
  PSSI: PSSIAnlzTag,
  PVBR: PVBRAnlzTag,
  PWAV: PWAVAnlzTag,
  PWV2: PWV2AnlzTag,
  PWV3: PWV3AnlzTag,
  PWV4: PWV4AnlzTag,
  PWV5: PWV5AnlzTag,
  PWV6: PWV6AnlzTag,
  PWV7: PWV7AnlzTag,
  PWVC: PWVCAnlzTag,
} as const;

function createTag(data: Buffer): AbstractAnlzTag {
  const type = data.toString("ascii", 0, 4);
  switch (type) {
    case "PQTZ":
      return new PQTZAnlzTag(data);
    case "PQT2":
      return new PQT2AnlzTag(data);
    case "PCOB":
      return new PCOBAnlzTag(data);
    case "PCO2":
      return new PCO2AnlzTag(data);
    case "PPTH":
      return new PPTHAnlzTag(data);
    case "PVBR":
      return new PVBRAnlzTag(data);
    case "PSSI":
      return new PSSIAnlzTag(data);
    case "PWAV":
      return new PWAVAnlzTag(data);
    case "PWV2":
      return new PWV2AnlzTag(data);
    case "PWV3":
      return new PWV3AnlzTag(data);
    case "PWV4":
      return new PWV4AnlzTag(data);
    case "PWV5":
      return new PWV5AnlzTag(data);
    case "PWV6":
      return new PWV6AnlzTag(data);
    case "PWV7":
      return new PWV7AnlzTag(data);
    case "PWVC":
      return new PWVCAnlzTag(data);
    default:
      return new AbstractAnlzTag(data);
  }
}

/** Rekordbox `ANLZnnnn.DAT`, `.EXT`, or `.2EX` binary file. */
export class AnlzFile {
  /** Parsed file header. */
  fileHeader: AnlzHeader;
  /** Tags in original file order, including unknown tags. */
  tags: Array<AbstractAnlzTag>;
  /** Source path when parsed from disk. */
  path = "";

  private headerData: Buffer;

  private constructor(headerData: Buffer, fileHeader: AnlzHeader, tags: Array<AbstractAnlzTag>) {
    this.headerData = headerData;
    this.fileHeader = fileHeader;
    this.tags = tags;
  }

  /** Parse an in-memory ANLZ file. */
  static parse(data: Buffer): AnlzFile {
    assertRange(data, 0, 28, "ANLZ file header");
    const fileHeader: AnlzHeader = {
      lenFile: data.readUInt32BE(8),
      lenHeader: data.readUInt32BE(4),
      type: data.toString("ascii", 0, 4),
    };
    if (fileHeader.type !== "PMAI")
      throw new TypeError(`Invalid ANLZ file type '${fileHeader.type}'`);
    if (fileHeader.lenHeader < 28 || fileHeader.lenFile > data.length)
      throw new AnlzLengthError("Invalid ANLZ file header lengths");

    const tags: Array<AbstractAnlzTag> = [];
    let offset = fileHeader.lenHeader;
    while (offset < fileHeader.lenFile) {
      assertRange(data, offset, 12, "ANLZ tag");
      const length = data.readUInt32BE(offset + 8);
      if (length < 12) throw new AnlzLengthError(`Invalid tag length ${length} at ${offset}`);
      assertRange(data, offset, length, "ANLZ tag");
      tags.push(createTag(data.subarray(offset, offset + length)));
      offset += length;
    }
    if (offset !== fileHeader.lenFile)
      throw new AnlzLengthError(`Tag data ends at ${offset}, expected ${fileHeader.lenFile}`);
    return new AnlzFile(Buffer.from(data.subarray(0, fileHeader.lenHeader)), fileHeader, tags);
  }

  /** Read and parse a supported ANLZ file. */
  static parseFile(path: string): AnlzFile {
    const extension = extname(path).toUpperCase();
    if (![".DAT", ".EXT", ".2EX"].includes(extension))
      throw new TypeError(`File type '${extension}' not supported!`);
    const file = AnlzFile.parse(readFileSync(path));
    file.path = path;
    return file;
  }

  /** Number of tags. */
  get numTags(): number {
    return this.tags.length;
  }

  /** Four-character tag types in file order. */
  get tagTypes(): Array<string> {
    return this.tags.map((tag) => tag.type);
  }

  /** Unique tag types. */
  keys(): Array<string> {
    return [...new Set(this.tagTypes)];
  }

  /** Return all tags matching a four-character type or semantic name. */
  getAllTags(key: string): Array<AbstractAnlzTag> {
    const byType = key.length === 4 && key === key.toUpperCase();
    return this.tags.filter((tag) => (byType ? tag.type === key : tag.name === key));
  }

  /** Return the first tag matching a type or name. */
  getTag(key: string): AbstractAnlzTag {
    const tag = this.getAllTags(key)[0];
    if (!tag) throw new Error(`ANLZ tag '${key}' not found`);
    return tag;
  }

  /** Return the parsed value of the first matching tag. */
  get(key: string): unknown {
    return this.getTag(key).get();
  }

  /** Return parsed values for all matching tags. */
  getAll(key: string): Array<unknown> {
    return this.getAllTags(key).map((tag) => tag.get());
  }

  /** Whether a matching tag exists. */
  has(key: string): boolean {
    return this.getAllTags(key).length > 0;
  }

  /** Replace the path in the file's `PPTH` tag. */
  setPath(path: string): void {
    const tag = this.getTag("PPTH");
    if (!(tag instanceof PathTag)) throw new TypeError("PPTH tag has an unexpected handler");
    tag.set(path);
  }

  /** Rebuild the complete file and update the declared file length. */
  build(): Buffer {
    const tags = this.tags.map((tag) => tag.build());
    const lenFile = this.fileHeader.lenHeader + tags.reduce((total, tag) => total + tag.length, 0);
    const header = Buffer.from(this.headerData);
    header.writeUInt32BE(lenFile, 8);
    this.fileHeader.lenFile = lenFile;
    return Buffer.concat([header, ...tags]);
  }

  /** Save the rebuilt file, defaulting to the parsed source path. */
  save(path = this.path): void {
    if (!path) throw new TypeError("A destination path is required for in-memory ANLZ data");
    writeFileSync(path, this.build());
    this.path = path;
  }

  /** Return bounded file and tag metadata. */
  summary(): Record<string, unknown> {
    return {
      fileHeader: this.fileHeader,
      numTags: this.numTags,
      path: this.path,
      tagTypes: this.tagTypes,
      tags: this.tags.map((tag) => tag.summary()),
    };
  }
}

/** Whether a path points to a correctly named ANLZ file. */
export function isAnlzFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile() && anlzPattern.test(basename(path));
}

/** Find DAT, EXT, and 2EX files in one directory. */
export function getAnlzPaths(root: string): Record<"2EX" | "DAT" | "EXT", string | undefined> {
  const paths: Record<"2EX" | "DAT" | "EXT", string | undefined> = {
    "2EX": undefined,
    DAT: undefined,
    EXT: undefined,
  };
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !anlzPattern.test(entry.name)) continue;
    paths[extname(entry.name).slice(1).toUpperCase() as "2EX" | "DAT" | "EXT"] = join(
      root,
      entry.name,
    );
  }
  return paths;
}

/** Find directories containing ANLZ files recursively. */
export function walkAnlzDirectories(root: string): Array<string> {
  const directories: Array<string> = [];
  const visit = (directory: string) => {
    const entries = readdirSync(directory, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && anlzPattern.test(entry.name)))
      directories.push(directory);
    for (const entry of entries) if (entry.isDirectory()) visit(join(directory, entry.name));
  };
  visit(root);
  return directories;
}

/** Find ANLZ directories together with their DAT/EXT/2EX files. */
export function walkAnlzPaths(
  root: string,
): Array<[string, Record<"2EX" | "DAT" | "EXT", string | undefined>]> {
  return walkAnlzDirectories(root).map((directory) => [directory, getAnlzPaths(directory)]);
}

/** Open every ANLZ file directly inside a directory. */
export function readAnlzFiles(root: string): Map<string, AnlzFile> {
  return new Map(
    Object.values(getAnlzPaths(root))
      .filter((path): path is string => path !== undefined)
      .map((path) => [path, AnlzFile.parseFile(path)]),
  );
}
