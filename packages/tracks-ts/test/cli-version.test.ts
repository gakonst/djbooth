import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import { Cli } from "incur";
import { describe, expect, it } from "vitest";

import type { TrackAcquirer } from "../src/acquire-manifest.js";
import {
  createImportSetReferenceAcquirer,
  orderedImportSetAcquirers,
  tracksCli,
} from "../src/cli.js";
import type { YtdlpReferenceClient } from "../src/integrations/ytdlp-library.js";

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

  it("always registers native acquisition and constructs reference acquisition only on opt-in", () => {
    let referenceFactories = 0;
    const soulseek = fakeAcquirer("slsk");
    const native = fakeAcquirer("ytdlp");
    const reference = fakeAcquirer("ytdlp");
    const factories = {
      soulseek: () => soulseek,
      nativeYtdlp: () => native,
      referenceYtdlp: () => {
        referenceFactories += 1;
        return reference;
      },
    };

    expect(orderedImportSetAcquirers(false, factories)).toEqual([soulseek, native]);
    expect(referenceFactories).toBe(0);
    expect(orderedImportSetAcquirers(true, factories)).toEqual([soulseek, native, reference]);
    expect(referenceFactories).toBe(1);
  });

  it("configures the explicitly enabled reference client as a normal fallback", () => {
    const client: YtdlpReferenceClient = {
      inspect: () => Promise.reject(new Error("not used")),
      download: () => Promise.reject(new Error("not used")),
    };

    expect(createImportSetReferenceAcquirer(client, "off").requiresPriorCapabilityFailure).toBe(
      false,
    );
  });
});

function fakeAcquirer(backend: "slsk" | "ytdlp"): TrackAcquirer {
  return {
    backend,
    availability: () => Promise.resolve({ available: true }),
    search: () => Promise.resolve([]),
    download: () => Promise.reject(new Error("not used")),
  };
}
