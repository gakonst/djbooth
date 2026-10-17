import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  copyAudioToLibrary,
  deobfuscate,
  getProcessId,
  getRekordboxProcessState,
  obfuscate,
  prettyXml,
  ProcessNotFoundError,
} from "../src/utils.js";

describe("library audio copies", () => {
  it("preserves removable sources, resumes copies, and refuses conflicting library bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "djbooth-audio-copy-"));
    try {
      const usb = join(root, "usb");
      const library = join(root, "library");
      await mkdir(join(usb, "other"), { recursive: true });
      const first = join(usb, "track.mp3");
      const second = join(usb, "other", "track.mp3");
      await writeFile(first, "first");
      await writeFile(second, "other");
      const [copied, concurrent] = await Promise.all([
        copyAudioToLibrary(first, library),
        copyAudioToLibrary(first, library),
      ]);
      expect(concurrent).toBe(copied);
      expect(await copyAudioToLibrary(first, library)).toBe(copied);
      expect(await readFile(first, "utf8")).toBe("first");
      expect(await readFile(copied, "utf8")).toBe("first");
      const otherCopy = await copyAudioToLibrary(second, library);
      expect(otherCopy).not.toBe(copied);
      expect(await readFile(otherCopy, "utf8")).toBe("other");

      await writeFile(otherCopy, "wrong");
      await expect(copyAudioToLibrary(second, library)).rejects.toThrow("refusing to overwrite");
      expect(await readFile(otherCopy, "utf8")).toBe("wrong");
      expect(await readFile(second, "utf8")).toBe("other");

      await writeFile(first, "newer");
      expect(await readFile(copied, "utf8")).toBe("first");
      const changedCopy = await copyAudioToLibrary(first, library);
      expect(changedCopy).not.toBe(copied);
      await rm(usb, { recursive: true });
      expect(await readFile(changedCopy, "utf8")).toBe("newer");
      expect(await readFile(copied, "utf8")).toBe("first");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("obfuscation", () => {
  const fixtures = [
    ["", "PN_6zG&p8C"],
    ["rekordbox", "PN^I$`SwY2eW{x>H*jMz=K"],
    ["hello, 世界", "PO1DZ`SGvsWgCW2?U2e0HXZO_uK"],
    ["657f48f84c437cc1", "PN@V{0e4l2e9#1X0a8_dcmp$L7dK)D"],
  ] as const;

  it.each(fixtures)("matches pyrekordbox for %j", (plaintext, encoded) => {
    expect(obfuscate(plaintext).toString("ascii")).toBe(encoded);
    expect(deobfuscate(encoded)).toBe(plaintext);
  });
});

describe("process discovery", () => {
  it("returns zero or throws when a process is absent", () => {
    const name = `rekordbox-ts-definitely-missing-${process.pid}`;
    expect(getProcessId(name)).toBe(0);
    expect(() => getProcessId(name, { throwIfMissing: true })).toThrow(ProcessNotFoundError);
  });

  it("returns both Rekordbox process IDs from one snapshot", () => {
    const state = getRekordboxProcessState();
    expect(state.rekordboxPid).toBeTypeOf("number");
    expect(state.rekordboxAgentPid).toBeTypeOf("number");
  });
});

describe("prettyXml", () => {
  it("formats nested elements", () => {
    expect(prettyXml('<ROOT><CHILD value="1"/></ROOT>', { indent: "  " })).toContain(
      '\n  <CHILD value="1">',
    );
  });
});
