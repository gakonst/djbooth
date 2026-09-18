import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getConfig, MasterDatabase } from "@gakonst/rekordbox";
import { Cli } from "incur";
import { afterEach, describe, expect, it, vi } from "vitest";

import { importCli, resolveCli } from "../src/cli.js";
import {
  prepareWorkflowDatabase,
  RekordboxPipelineStore,
  resolveRekordboxPipelineLocation,
} from "../src/pipeline-state.js";
import { runSetToRekordbox } from "../src/workflow.js";

vi.mock("@gakonst/rekordbox", async (original) => ({
  ...(await original<typeof import("@gakonst/rekordbox")>()),
  getConfig: vi.fn(),
}));

vi.mock("../src/workflow.js", async (original) => ({
  ...(await original<typeof import("../src/workflow.js")>()),
  runSetToRekordbox: vi.fn(async () => {
    throw new Error("offline workflow boundary reached");
  }),
}));

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "djbooth-fresh-"));
  roots.push(root);
  return { root, dbPath: join(root, "library", "master.db") };
}
const source = "https://soundcloud.com/fixture/set";
const tracklist = JSON.stringify({
  source,
  provider: "agent",
  url: "https://www.1001tracklists.com/tracklist/fixture.html",
  title: "Offline fixture",
  complete: true,
  tracks: [{ order: 1, startSeconds: 0, endSeconds: 20, artist: "Fixture", title: "Pulse" }],
});
afterEach(() => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function run(command: "resolve" | "import", root: string, dbPath: string) {
  let output = "";
  const cli = Cli.create("djbooth").command(importCli).command(resolveCli);
  await cli.serve(
    [
      command,
      source,
      "--db-path",
      dbPath,
      "--output-directory",
      root,
      "--agent-result-json",
      tracklist,
      "--format",
      "json",
      ...(command === "import" ? ["--progress", "never"] : []),
    ],
    {
      env: {},
      stdout: (value) => {
        output += value;
      },
      exit: () => {},
    },
  );
  return output;
}

describe("explicit workflow database bootstrap", () => {
  it("resolves into a fresh nested managed library and preserves rows on rerun", async () => {
    const { root, dbPath } = fixture();
    expect(await run("resolve", root, dbPath)).toContain("Pulse");
    const store = new RekordboxPipelineStore({ source, outputDirectory: root, dbPath });
    expect((await store.load())?.entries[0]?.identity.title).toBe("Pulse");
    prepareWorkflowDatabase(dbPath);
    expect((await store.load())?.entries).toHaveLength(1);
    const database = new MasterDatabase({ path: dbPath, readonly: true });
    try {
      expect(database.hasTable("djmdContent")).toBe(true);
    } finally {
      database.close();
    }
  });

  it("imports into a fresh database before reaching the offline workflow boundary", async () => {
    const { root, dbPath } = fixture();
    const output = await run("import", root, dbPath);
    expect(output).toContain("offline workflow boundary reached");
    expect(runSetToRekordbox).toHaveBeenCalledOnce();
    const store = new RekordboxPipelineStore({ source, outputDirectory: root, dbPath });
    expect((await store.load())?.entries[0]?.identity.title).toBe("Pulse");
  });

  it("never replaces an invalid existing file or a dangling symlink", () => {
    const { root } = fixture();
    const invalid = join(root, "invalid.db");
    writeFileSync(invalid, "not a database");
    prepareWorkflowDatabase(invalid);
    expect(readFileSync(invalid, "utf8")).toBe("not a database");
    const link = join(root, "link.db");
    symlinkSync(invalid + ".missing", link);
    prepareWorkflowDatabase(link);
    expect(() => readFileSync(link)).toThrow();
  });

  it("keeps an explicit library separate from a discovered desktop database directory", () => {
    const { root, dbPath } = fixture();
    vi.mocked(getConfig).mockReturnValueOnce({
      dbPath: "/desktop/master.db",
      dbDir: "/desktop",
    } as unknown as NonNullable<ReturnType<typeof getConfig>>);
    expect(resolveRekordboxPipelineLocation({ dbPath }).dbDirectory).toBe(join(root, "library"));
  });

  it("does not discover or create a default database", () => {
    expect(() => prepareWorkflowDatabase(undefined)).not.toThrow();
  });
});
