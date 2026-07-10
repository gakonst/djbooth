import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  computeChecksum,
  DjmMySettingFile,
  getMySettingPaths,
  MySetting2File,
  MySettingFile,
  readMySettingFile,
} from "../src/mysettings/index.js";

const fixtures = {
  "DEVSETTING.DAT":
    "YAAAAFBJT05FRVIgREoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcmVrb3JkYm94AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2LjYuMgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAB4VjQSAQAAAAEBAQEBAQAAAAAAAAAAAAAAAAAAAAAAABbQAAA=",
  "DJMMYSETTING.DAT":
    "YAAAAFBpb25lZXJESgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcmVrb3JkYm94AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAxLjAwMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADQAAAB4VjQSAQAAACAAAACBgoCAgYGAgYCAhYKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOGwAAA==",
  "MYSETTING.DAT":
    "YAAAAFBJT05FRVIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcmVrb3JkYm94AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwLjAwMQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACgAAAB4VjQSAgAAAIGDgYiBAYKBgQEBAYKAgIGAgYAAAIEAAIGBgYCBgAAASHoAAA==",
  "MYSETTING2.DAT":
    "YAAAAFBJT05FRVIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcmVrb3JkYm94AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwLjAwMQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACgAAACBgIODgQAAAAAAgIGFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQLsAAA==",
} as const;

const variants = {
  djmSteepBottom:
    "YAAAAFBpb25lZXJESgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcmVrb3JkYm94AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAxLjAwMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADQAAAB4VjQSAQAAACAAAACCgoCAgYGAgYCAhYKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA9U8AAA==",
  myQuantizeOff:
    "YAAAAFBJT05FRVIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcmVrb3JkYm94AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwLjAwMQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACgAAAB4VjQSAgAAAIGDgIiBAYKBgQEBAYKAgIGAgYAAAIEAAIGBgYCBgAAAV3MAAA==",
  my2Release:
    "YAAAAFBJT05FRVIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcmVrb3JkYm94AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwLjAwMQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACgAAACCgIODgQAAAAAAgIGFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAjZgAAA==",
} as const;

describe("My Settings binary formats", () => {
  it("parses and losslessly rebuilds all four upstream default fixtures", () => {
    const classes = {
      "DJMMYSETTING.DAT": DjmMySettingFile,
      "MYSETTING.DAT": MySettingFile,
      "MYSETTING2.DAT": MySetting2File,
    } as const;

    for (const [name, File] of Object.entries(classes)) {
      const source = Buffer.from(fixtures[name as keyof typeof fixtures], "base64");
      const file = File.parse(source);
      expect(file.checksumValid).toBe(true);
      expect(file.build()).toEqual(source);
    }
  });

  it("builds new files byte-for-byte like pyrekordbox defaults", () => {
    expect(new MySettingFile().build()).toEqual(Buffer.from(fixtures["MYSETTING.DAT"], "base64"));
    expect(new MySetting2File().build()).toEqual(Buffer.from(fixtures["MYSETTING2.DAT"], "base64"));
    expect(new DjmMySettingFile().build()).toEqual(
      Buffer.from(fixtures["DJMMYSETTING.DAT"], "base64"),
    );
  });

  it("parses typed enum names", () => {
    const my = MySettingFile.parse(Buffer.from(fixtures["MYSETTING.DAT"], "base64"));
    expect(my.get("language")).toBe("english");
    expect(my.get("quantize")).toBe("on");
    expect(my.get("tempo_range")).toBe("ten");

    const my2 = MySetting2File.parse(Buffer.from(fixtures["MYSETTING2.DAT"], "base64"));
    expect(my2.get("vinyl_speed_adjust")).toBe("touch");
    expect(my2.get("beat_jump_beat_value")).toBe("sixteen");
  });

  it("matches upstream binaries after mutations", () => {
    const my = MySettingFile.parse(Buffer.from(fixtures["MYSETTING.DAT"], "base64"));
    my.set("quantize", "off");
    expect(my.build()).toEqual(Buffer.from(variants.myQuantizeOff, "base64"));

    const my2 = MySetting2File.parse(Buffer.from(fixtures["MYSETTING2.DAT"], "base64"));
    my2.set("vinyl_speed_adjust", "release");
    expect(my2.build()).toEqual(Buffer.from(variants.my2Release, "base64"));

    const djm = DjmMySettingFile.parse(Buffer.from(fixtures["DJMMYSETTING.DAT"], "base64"));
    djm.set("channel_fader_curve", "steep_bottom");
    expect(djm.build()).toEqual(Buffer.from(variants.djmSteepBottom, "base64"));
  });

  it("keeps checksum state valid and repeated builds stable after mutation", () => {
    const file = MySettingFile.parse(Buffer.from(fixtures["MYSETTING.DAT"], "base64"));
    file.set("quantize", "off");
    const first = file.build();
    expect(file.checksumValid).toBe(true);
    expect(file.build()).toEqual(first);
  });

  it("rejects invalid setting keys and values", () => {
    const file = new MySettingFile();
    expect(() => file.set("invalid", "on")).toThrow(RangeError);
    expect(() => file.set("quantize", "maybe")).toThrow(RangeError);
  });

  it("computes the stored CRC-16/XMODEM checksum", () => {
    const source = Buffer.from(fixtures["MYSETTING.DAT"], "base64");
    expect(computeChecksum(source)).toBe(source.readUInt16LE(source.length - 4));
    const djm = Buffer.from(fixtures["DJMMYSETTING.DAT"], "base64");
    expect(computeChecksum(djm, true)).toBe(djm.readUInt16LE(djm.length - 4));
  });
});

describe("My Settings file discovery", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rekordbox-ts-settings-"));
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "MYSETTING.DAT"), Buffer.from(fixtures["MYSETTING.DAT"], "base64"));
    writeFileSync(
      join(root, "nested", "DJMMYSETTING.DAT"),
      Buffer.from(fixtures["DJMMYSETTING.DAT"], "base64"),
    );
  });

  afterAll(() => {
    rmSync(root, { force: true, recursive: true });
  });

  it("dispatches by filename and supports recursive discovery", () => {
    expect(readMySettingFile(join(root, "MYSETTING.DAT"))).toBeInstanceOf(MySettingFile);
    expect(getMySettingPaths(root)).toHaveLength(1);
    expect(getMySettingPaths(root, true)).toHaveLength(2);
  });
});
