import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import { Cli } from "incur";
import { describe, expect, it } from "vitest";

import { tracksCli } from "../src/cli.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

describe("CLI version", () => {
  it("matches the package manifest", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--version"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(version);
  });

  it("exports an import-safe CLI that composes as a child command", async () => {
    let output = "";
    let exitCode: number | undefined;
    const parent = Cli.create("music");
    parent.command(tracksCli);

    await parent.serve(["tracks", "providers", "--format", "json"], {
      env: {},
      stdout(value) {
        output += value;
      },
      exit(code) {
        exitCode = code;
      },
    });

    expect(tracksCli.name).toBe("tracks");
    expect(exitCode).toBeUndefined();
    expect(JSON.parse(output)).toMatchObject({ description: { configured: true } });
  });
});
