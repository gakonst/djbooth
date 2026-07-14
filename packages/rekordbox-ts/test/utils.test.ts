import { describe, expect, it } from "vitest";

import {
  deobfuscate,
  getProcessId,
  getRekordboxProcessState,
  obfuscate,
  prettyXml,
  ProcessNotFoundError,
} from "../src/utils.js";

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
