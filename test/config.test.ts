import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  formatConfig,
  getConfig,
  InvalidApplicationDirnameError,
  readRekordbox6Options,
  readRekordboxSettings,
  updateConfig,
} from "../src/config/index.js";

describe("configuration discovery", () => {
  let root: string;
  let installDir: string;
  let appDir: string;
  let dbDir: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rekordbox-ts-config-"));
    installDir = join(root, "install");
    appDir = join(root, "app");
    dbDir = join(appDir, "rekordbox");

    for (const directory of [
      installDir,
      join(installDir, "rekordbox 5.1.1"),
      join(installDir, "rekordbox 5.10.0"),
      join(installDir, "rekordbox 6.1.1"),
      join(installDir, "rekordbox 6.2.0"),
      join(installDir, "rekordbox 7.1.0"),
      dbDir,
      join(appDir, "rekordbox6"),
      join(appDir, "rekordboxAgent", "storage"),
    ])
      mkdirSync(directory, { recursive: true });

    const settings = `<?xml version="1.0" encoding="UTF-8"?>
<PROPERTIES>
  <VALUE name="masterDbDirectory" val="${dbDir}"/>
  <VALUE name="integer" val="42"/>
  <VALUE name="float" val="1.5"/>
  <VALUE name="vector" val="1,2,3"/>
  <VALUE name="device"><DEVICESETUP entries="4" scale="1.25"/></VALUE>
</PROPERTIES>`;
    writeFileSync(join(dbDir, "rekordbox3.settings"), settings);
    writeFileSync(join(appDir, "rekordbox6", "rekordbox3.settings"), settings);
    writeFileSync(join(dbDir, "datafile.edb"), "");
    writeFileSync(join(dbDir, "master.db"), "");
    writeFileSync(
      join(appDir, "rekordboxAgent", "storage", "options.json"),
      JSON.stringify({ options: [["db-path", join(dbDir, "master.db")]] }),
    );
  });

  afterAll(() => {
    rmSync(root, { force: true, recursive: true });
  });

  it("parses settings and Agent options", () => {
    expect(readRekordboxSettings(dbDir)).toMatchObject({
      device: { entries: 4, scale: 1.25 },
      float: 1.5,
      integer: 42,
      masterDbDirectory: dbDir,
      vector: [1, 2, 3],
    });
    expect(readRekordbox6Options(appDir)).toEqual({ "db-path": join(dbDir, "master.db") });
  });

  it("selects the newest installation for every supported major version", () => {
    const config = updateConfig({
      pioneerAppDir: appDir,
      pioneerInstallDir: installDir,
      platform: "darwin",
    });

    expect(config.rekordbox5?.version).toBe("5.10.0");
    expect(config.rekordbox6?.version).toBe("6.2.0");
    expect(config.rekordbox7?.version).toBe("7.1.0");
    expect(getConfig("rekordbox6", "dbPath")).toBe(join(dbDir, "master.db"));
    expect(formatConfig(config)).toContain("Rekordbox 7:");
  });

  it("honors an explicit application directory", () => {
    const config = updateConfig({
      pioneerAppDir: appDir,
      pioneerInstallDir: installDir,
      platform: "darwin",
      rekordbox5Dirname: "rekordbox 5.1.1",
    });
    expect(config.rekordbox5?.version).toBe("5.1.1");
  });

  it("rejects a nonexistent explicit application directory", () => {
    expect(() =>
      updateConfig({
        pioneerAppDir: appDir,
        pioneerInstallDir: installDir,
        platform: "darwin",
        rekordbox6Dirname: "rekordbox 6.99.0",
      }),
    ).toThrow(InvalidApplicationDirnameError);
  });
});
