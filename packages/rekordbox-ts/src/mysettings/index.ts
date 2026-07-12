import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

type EnumField = {
  kind: "enum";
  offset: number;
  values: Record<string, number>;
};

type BytesField = {
  kind: "bytes";
  length: number;
  offset: number;
};

type SettingField = BytesField | EnumField;

type SettingsDefinition = {
  bodyLength: number;
  bodyTemplate: Buffer;
  brand: string;
  checksumFromStart: boolean;
  defaults: Record<string, string>;
  fields: Record<string, SettingField>;
  filename: MySettingFilename;
  software: string;
  version: string;
};

/** Supported Rekordbox My Settings filename. */
export type MySettingFilename =
  | "DEVSETTING.DAT"
  | "DJMMYSETTING.DAT"
  | "MYSETTING.DAT"
  | "MYSETTING2.DAT";

/** Parsed fixed header from a My Settings file. */
export type SettingsHeader = {
  bodyLength: number;
  brand: string;
  checksum: number;
  software: string;
  version: string;
};

const enumField = (offset: number, values: Record<string, number>): EnumField => ({
  kind: "enum",
  offset,
  values,
});

const toggle = { off: 0x80, on: 0x81 };
const unlockLock = { lock: 0x81, unlock: 0x80 };
const oneToFive = { five: 0x85, four: 0x84, one: 0x81, three: 0x83, two: 0x82 };

const mySettingFields: Record<string, SettingField> = {
  auto_cue: enumField(34, toggle),
  auto_cue_level: enumField(11, {
    memory: 0x88,
    minus_36db: 0x80,
    minus_42db: 0x81,
    minus_48db: 0x82,
    minus_54db: 0x83,
    minus_60db: 0x84,
    minus_66db: 0x85,
    minus_72db: 0x86,
    minus_78db: 0x87,
  }),
  disc_slot_illumination: enumField(20, { bright: 0x82, dark: 0x81, off: 0x80 }),
  eject_lock: enumField(21, unlockLock),
  hotcue_autoload: enumField(25, { off: 0x80, on: 0x81, rekordbox: 0x82 }),
  hotcue_color: enumField(26, toggle),
  jog_mode: enumField(33, { cdj: 0x80, vinyl: 0x81 }),
  jog_ring_brightness: enumField(14, { bright: 0x82, dark: 0x81, off: 0x80 }),
  jog_ring_indicator: enumField(15, toggle),
  language: enumField(12, {
    chinese_simplified: 0x89,
    chinese_traditional: 0x8a,
    czech: 0x8e,
    danish: 0x90,
    dutch: 0x85,
    english: 0x81,
    french: 0x82,
    german: 0x83,
    greek: 0x91,
    hungarian: 0x8f,
    italian: 0x84,
    japanese: 0x8b,
    korean: 0x88,
    portuguese: 0x8c,
    russian: 0x87,
    spanish: 0x86,
    swedish: 0x8d,
    turkish: 0x92,
  }),
  lcd_brightness: enumField(9, oneToFive),
  master_tempo: enumField(35, toggle),
  needle_lock: enumField(29, unlockLock),
  on_air_display: enumField(8, toggle),
  phase_meter: enumField(37, { type1: 0x80, type2: 0x81 }),
  play_mode: enumField(23, { continue_: 0x80, single: 0x81 }),
  quantize: enumField(10, toggle),
  quantize_beat_value: enumField(24, { eighth: 0x83, half: 0x81, one: 0x80, quarter: 0x82 }),
  slip_flashing: enumField(16, toggle),
  sync: enumField(22, toggle),
  tempo_range: enumField(36, { six: 0x80, sixteen: 0x82, ten: 0x81, wide: 0x83 }),
  time_mode: enumField(32, { elapsed: 0x80, remain: 0x81 }),
};

const mySetting2Fields: Record<string, SettingField> = {
  beat_jump_beat_value: enumField(12, {
    eight: 0x84,
    four: 0x83,
    half: 0x80,
    one: 0x81,
    sixtyfour: 0x87,
    sixteen: 0x85,
    thirtytwo: 0x86,
    two: 0x82,
  }),
  jog_display_mode: enumField(1, { artwork: 0x83, auto: 0x80, info: 0x81, simple: 0x82 }),
  jog_lcd_brightness: enumField(3, oneToFive),
  pad_button_brightness: enumField(2, { four: 0x84, one: 0x81, three: 0x83, two: 0x82 }),
  vinyl_speed_adjust: enumField(0, { release: 0x82, touch: 0x81, touch_release: 0x80 }),
  waveform: enumField(10, { phase_meter: 0x81, waveform: 0x80 }),
  waveform_divisions: enumField(4, { phrase: 0x81, time_scale: 0x80 }),
};

const djmMySettingFields: Record<string, SettingField> = {
  beat_fx_quantize: enumField(16, toggle),
  channel_fader_curve: enumField(12, { linear: 0x81, steep_bottom: 0x82, steep_top: 0x80 }),
  channel_fader_curve_long: enumField(24, { exponential: 0x80, linear: 0x82, smooth: 0x81 }),
  cross_fader_curve: enumField(13, { constant: 0x80, fast_cut: 0x82, slow_cut: 0x81 }),
  display_brightness: enumField(22, { ...oneToFive, white: 0x80 }),
  headphones_mono_split: enumField(15, { mono_split: 0x81, stereo: 0x80 }),
  headphones_pre_eq: enumField(14, { post_eq: 0x80, pre_eq: 0x81 }),
  indicator_brightness: enumField(23, { one: 0x80, three: 0x82, two: 0x81 }),
  mic_low_cut: enumField(17, toggle),
  midi_button_type: enumField(21, { toggle: 0x80, trigger: 0x81 }),
  midi_channel: enumField(20, {
    eight: 0x87,
    eleven: 0x8a,
    fifteen: 0x8e,
    five: 0x84,
    four: 0x83,
    fourteen: 0x8d,
    nine: 0x88,
    one: 0x80,
    seven: 0x86,
    six: 0x85,
    sixteen: 0x8f,
    ten: 0x89,
    thirteen: 0x8c,
    three: 0x82,
    twelve: 0x8b,
    two: 0x81,
  }),
  talk_over_level: enumField(19, {
    minus_12db: 0x82,
    minus_18db: 0x81,
    minus_24db: 0x80,
    minus_6db: 0x83,
  }),
  talk_over_mode: enumField(18, { advanced: 0x80, normal: 0x81 }),
};

function mySettingTemplate(): Buffer {
  const body = Buffer.alloc(40);
  Buffer.from("7856341202000000", "hex").copy(body, 0);
  body[13] = 0x01;
  body.fill(0x01, 17, 20);
  return body;
}

function mySetting2Template(): Buffer {
  const body = Buffer.alloc(40);
  body[11] = 0x81;
  return body;
}

function djmMySettingTemplate(): Buffer {
  const body = Buffer.alloc(52);
  Buffer.from("785634120100000020000000", "hex").copy(body, 0);
  return body;
}

function devSettingTemplate(): Buffer {
  const body = Buffer.alloc(32);
  Buffer.from("7856341202000000", "hex").copy(body, 0);
  return body;
}

const definitions: Record<MySettingFilename, SettingsDefinition> = {
  "DEVSETTING.DAT": {
    bodyLength: 32,
    bodyTemplate: devSettingTemplate(),
    brand: "PIONEER DJ",
    checksumFromStart: false,
    defaults: { entries: "" },
    fields: { entries: { kind: "bytes", length: 24, offset: 8 } },
    filename: "DEVSETTING.DAT",
    software: "rekordbox",
    version: "",
  },
  "DJMMYSETTING.DAT": {
    bodyLength: 52,
    bodyTemplate: djmMySettingTemplate(),
    brand: "PioneerDJ",
    checksumFromStart: true,
    defaults: {
      beat_fx_quantize: "on",
      channel_fader_curve: "linear",
      channel_fader_curve_long: "exponential",
      cross_fader_curve: "fast_cut",
      display_brightness: "five",
      headphones_mono_split: "stereo",
      headphones_pre_eq: "post_eq",
      indicator_brightness: "three",
      mic_low_cut: "on",
      midi_button_type: "toggle",
      midi_channel: "one",
      talk_over_level: "minus_18db",
      talk_over_mode: "advanced",
    },
    fields: djmMySettingFields,
    filename: "DJMMYSETTING.DAT",
    software: "rekordbox",
    version: "1.000",
  },
  "MYSETTING.DAT": {
    bodyLength: 40,
    bodyTemplate: mySettingTemplate(),
    brand: "PIONEER",
    checksumFromStart: false,
    defaults: {
      auto_cue: "on",
      auto_cue_level: "memory",
      disc_slot_illumination: "bright",
      eject_lock: "unlock",
      hotcue_autoload: "on",
      hotcue_color: "off",
      jog_mode: "vinyl",
      jog_ring_brightness: "bright",
      jog_ring_indicator: "on",
      language: "english",
      lcd_brightness: "three",
      master_tempo: "off",
      needle_lock: "lock",
      on_air_display: "on",
      phase_meter: "type1",
      play_mode: "single",
      quantize: "on",
      quantize_beat_value: "one",
      slip_flashing: "on",
      sync: "off",
      tempo_range: "ten",
      time_mode: "remain",
    },
    fields: mySettingFields,
    filename: "MYSETTING.DAT",
    software: "rekordbox",
    version: "0.001",
  },
  "MYSETTING2.DAT": {
    bodyLength: 40,
    bodyTemplate: mySetting2Template(),
    brand: "PIONEER",
    checksumFromStart: false,
    defaults: {
      beat_jump_beat_value: "sixteen",
      jog_display_mode: "auto",
      jog_lcd_brightness: "three",
      pad_button_brightness: "three",
      vinyl_speed_adjust: "touch",
      waveform: "waveform",
      waveform_divisions: "phrase",
    },
    fields: mySetting2Fields,
    filename: "MYSETTING2.DAT",
    software: "rekordbox",
    version: "0.001",
  },
};

function decodePaddedAscii(data: Buffer, offset: number, length: number): string {
  const zero = data.indexOf(0, offset);
  const end = zero === -1 || zero > offset + length ? offset + length : zero;
  return data.toString("ascii", offset, end);
}

function writePaddedAscii(data: Buffer, value: string, offset: number, length: number): void {
  const encoded = Buffer.from(value, "ascii");
  if (encoded.length > length) throw new RangeError(`'${value}' exceeds ${length} ASCII bytes`);
  data.fill(0, offset, offset + length);
  encoded.copy(data, offset);
}

function enumName(field: EnumField, byte: number): string {
  return Object.entries(field.values).find(([, value]) => value === byte)?.[0] ?? String(byte);
}

/** Compute the CRC-16/XMODEM checksum used by Rekordbox My Settings files. */
export function computeChecksum(data: Buffer, checksumFromStart = false): number {
  const start = checksumFromStart ? 0 : 104;
  let crc = 0;
  for (const byte of data.subarray(start, data.length - 4)) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** Base class for Rekordbox My Settings binary files. */
export abstract class SettingsFile {
  protected static definition: SettingsDefinition;

  private source: Buffer | undefined;
  private items = new Map<string, string>();

  /** Fixed file header, updated after parse/build. */
  header: SettingsHeader;
  /** Version string used when creating a DEVSETTING file. */
  version: string;

  protected constructor() {
    const definition = this.getDefinition();
    this.version = definition.version;
    this.header = {
      bodyLength: definition.bodyLength,
      brand: definition.brand,
      checksum: 0,
      software: definition.software,
      version: definition.version,
    };
  }

  private getDefinition(): SettingsDefinition {
    return (this.constructor as typeof SettingsFile).definition;
  }

  /** Parse an in-memory settings file. */
  static parse<file extends SettingsFile>(this: new () => file, data: Buffer): file {
    const file = new this();
    file.parseData(data);
    return file;
  }

  /** Read and parse a settings file. */
  static parseFile<file extends SettingsFile>(this: new () => file, path: string): file {
    const file = new this();
    file.parseData(readFileSync(path));
    return file;
  }

  private parseData(input: Buffer): void {
    const definition = this.getDefinition();
    const expectedLength = 104 + definition.bodyLength + 4;
    if (input.length !== expectedLength)
      throw new RangeError(
        `Expected ${expectedLength} bytes for ${definition.filename}, got ${input.length}`,
      );
    if (input.readUInt32LE(0) !== 0x60)
      throw new TypeError("Invalid My Settings string header length");
    if (input.readUInt32LE(100) !== definition.bodyLength)
      throw new TypeError(`Invalid ${definition.filename} body length`);

    const body = input.subarray(104, 104 + definition.bodyLength);
    this.source = Buffer.from(input);
    this.version = decodePaddedAscii(input, 68, 32);
    this.header = {
      bodyLength: definition.bodyLength,
      brand: decodePaddedAscii(input, 4, 32),
      checksum: input.readUInt16LE(input.length - 4),
      software: decodePaddedAscii(input, 36, 32),
      version: this.version,
    };

    for (const [key, field] of Object.entries(definition.fields)) {
      const value =
        field.kind === "enum"
          ? enumName(field, body[field.offset]!)
          : body.subarray(field.offset, field.offset + field.length).toString("hex");
      this.items.set(key, value);
    }
  }

  /** File format represented by this object. */
  get filename(): MySettingFilename {
    return this.getDefinition().filename;
  }

  /** Number of supported settings. */
  get size(): number {
    return Object.keys(this.getDefinition().defaults).length;
  }

  /** Return one setting, falling back to the format default. */
  get(key: string, defaultValue?: string): string | undefined {
    return this.items.get(key) ?? this.getDefinition().defaults[key] ?? defaultValue;
  }

  /** Update one supported setting. */
  set(key: string, value: string): void {
    const field = this.getDefinition().fields[key];
    if (!field) throw new RangeError(`Key '${key}' is not valid for ${this.constructor.name}`);
    if (field.kind === "enum" && field.values[value] === undefined)
      throw new RangeError(
        `Value '${value}' is not valid for '${key}'; expected one of ${Object.keys(field.values).join(", ")}`,
      );
    if (field.kind === "bytes" && value !== "" && !/^(?:[\da-f]{2})+$/iu.test(value))
      throw new TypeError(`Byte setting '${key}' must be an even-length hexadecimal string`);
    this.items.set(key, value);
  }

  /** Remove an override so subsequent reads/builds use the format default. */
  reset(key: string): void {
    const definition = this.getDefinition();
    if (!(key in definition.defaults))
      throw new RangeError(`Key '${key}' is not valid for ${this.constructor.name}`);
    this.items.delete(key);
  }

  /** Reset one setting to its class default. */
  delete(key: string): void {
    this.reset(key);
  }

  /** Return all supported setting names. */
  keys(): Array<string> {
    return Object.keys(this.getDefinition().defaults);
  }

  /** Return the accepted symbolic values for an enum setting. */
  allowedValues(key: string): Array<string> | undefined {
    const field = this.getDefinition().fields[key];
    if (!field) throw new RangeError(`Key '${key}' is not valid for ${this.constructor.name}`);
    return field.kind === "enum" ? Object.keys(field.values) : undefined;
  }

  /** Return all supported settings. */
  entries(): Array<[string, string]> {
    return this.keys().map((key) => [key, this.get(key)!]);
  }

  /** Whether the parsed source checksum is valid. */
  get checksumValid(): boolean {
    if (!this.source) return true;
    return (
      this.header.checksum === computeChecksum(this.source, this.getDefinition().checksumFromStart)
    );
  }

  /** Build a binary settings file with an updated CRC-16/XMODEM checksum. */
  build(): Buffer {
    const definition = this.getDefinition();
    const length = 104 + definition.bodyLength + 4;
    const data = this.source ? Buffer.from(this.source) : Buffer.alloc(length);
    if (!this.source) {
      data.writeUInt32LE(0x60, 0);
      writePaddedAscii(data, definition.brand, 4, 32);
      writePaddedAscii(data, definition.software, 36, 32);
      writePaddedAscii(data, this.version || definition.version, 68, 32);
      data.writeUInt32LE(definition.bodyLength, 100);
      definition.bodyTemplate.copy(data, 104);
      data.writeUInt16LE(0, length - 2);
    } else if (definition.filename === "DEVSETTING.DAT" && this.version !== this.header.version) {
      writePaddedAscii(data, this.version, 68, 32);
    }

    const body = data.subarray(104, 104 + definition.bodyLength);
    for (const [key, field] of Object.entries(definition.fields)) {
      const value = this.get(key)!;
      if (field.kind === "enum") body[field.offset] = field.values[value]!;
      else if (value) {
        const bytes = Buffer.from(value, "hex");
        if (bytes.length !== field.length)
          throw new RangeError(`Setting '${key}' must contain exactly ${field.length} bytes`);
        bytes.copy(body, field.offset);
      }
    }

    const checksum = computeChecksum(data, definition.checksumFromStart);
    data.writeUInt16LE(checksum, data.length - 4);
    this.header = { ...this.header, checksum, version: this.version };
    this.source = Buffer.from(data);
    return data;
  }

  /** Save the built settings file. */
  save(path: string): void {
    writeFileSync(path, this.build());
  }

  /** Convert header and settings to structured data. */
  toJSON(): Record<string, unknown> {
    return {
      checksumValid: this.checksumValid,
      filename: this.filename,
      header: this.header,
      settings: Object.fromEntries(this.entries()),
    };
  }
}

/** `MYSETTING.DAT` handler. */
export class MySettingFile extends SettingsFile {
  protected static override definition = definitions["MYSETTING.DAT"];

  constructor() {
    super();
  }
}

/** `MYSETTING2.DAT` handler. */
export class MySetting2File extends SettingsFile {
  protected static override definition = definitions["MYSETTING2.DAT"];

  constructor() {
    super();
  }
}

/** `DJMMYSETTING.DAT` handler. */
export class DjmMySettingFile extends SettingsFile {
  protected static override definition = definitions["DJMMYSETTING.DAT"];

  constructor() {
    super();
  }
}

/** `DEVSETTING.DAT` handler. Its opaque 24-byte entry region is exposed as hexadecimal. */
export class DevSettingFile extends SettingsFile {
  protected static override definition = definitions["DEVSETTING.DAT"];

  constructor() {
    super();
  }
}

const fileTypes = {
  "DEVSETTING.DAT": DevSettingFile,
  "DJMMYSETTING.DAT": DjmMySettingFile,
  "MYSETTING.DAT": MySettingFile,
  "MYSETTING2.DAT": MySetting2File,
};

/** Recursively or directly find My Settings files below a directory. */
export function getMySettingPaths(root: string, deep = false): Array<string> {
  const matches: Array<string> = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && deep) matches.push(...getMySettingPaths(path, true));
    else if (entry.isFile() && /.*SETTING\d?\.DAT$/u.test(entry.name)) matches.push(path);
  }
  return matches.sort();
}

/** Dispatch to the appropriate settings class based on the file's basename. */
export function readMySettingFile(path: string): SettingsFile {
  if (!statSync(path).isFile()) throw new TypeError(`'${path}' is not a file`);
  const name = basename(path) as MySettingFilename;
  const File = fileTypes[name];
  if (!File) throw new TypeError(`Unsupported My Settings filename '${name}'`);
  return File.parseFile(path);
}

/** Create an empty settings object for one supported filename. */
export function createMySettingFile(filename: MySettingFilename): SettingsFile {
  const File = fileTypes[filename];
  return new File();
}
