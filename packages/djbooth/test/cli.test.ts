import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as linkControl from "@gakonst/djlink/control";
import { MasterDatabase } from "@gakonst/rekordbox/masterdb";
import { startLibraryServer, type PairingDescriptor } from "@gakonst/djbooth-app";

import { createDjBoothCli } from "../src/cli.js";
import { canDispatchDirectly } from "../src/dispatch.js";
import { DJBOOTH_RUNTIME_VERSION } from "../src/runtime.js";
import { startDjBoothServer } from "../src/serve.js";

const execFileAsync = promisify(execFile);

async function serve(argv: string[]): Promise<{
  exitCode: number | undefined;
  output: string;
}> {
  let output = "";
  let exitCode: number | undefined;
  await createDjBoothCli().serve(argv, {
    env: {},
    stdout(value) {
      output += value;
    },
    exit(code) {
      exitCode = code;
    },
  });
  return { exitCode, output };
}

describe("djbooth CLI", () => {
  test("uses package-local dispatch for normal commands and full discovery for global modes", () => {
    expect(canDispatchDirectly(["status", "--format", "json"])).toBe(true);
    expect(canDispatchDirectly(["import", "https://example.com/set"])).toBe(true);
    expect(canDispatchDirectly(["playlist", "list"])).toBe(true);
    expect(canDispatchDirectly(["produce", "transcribe", "input.wav", "output.mid"])).toBe(true);
    expect(canDispatchDirectly(["--help"])).toBe(false);
    expect(canDispatchDirectly(["--mcp"])).toBe(false);
    expect(canDispatchDirectly([])).toBe(false);
  });

  test("runs a flat command through the source-resolved workspace entrypoint", async () => {
    const { stdout } = await execFileAsync("pnpm", ["djbooth", "status", "--help"], {
      cwd: new URL("../../..", import.meta.url),
      env: { ...process.env, NO_COLOR: "1" },
    });

    expect(stdout).toContain("djbooth status");
    expect(stdout).toContain("--path <string>");
  });

  test("exposes workflow verbs directly and omits package namespaces", async () => {
    const { output } = await serve(["--llms-full", "--format", "json"]);
    const manifest = JSON.parse(output) as { commands: { name: string }[] };
    const names = manifest.commands.map((command) => command.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "analyze",
        "download",
        "enrich",
        "import",
        "link",
        "playlist create",
        "playlist add",
        "produce setup",
        "produce transcribe",
        "resolve",
        "serve",
        "status",
        "stop",
        "stems",
        "usb",
        "slsk search",
        "soundcloud playlist create",
        "spots playlist create",
        "ytdlp-ts music",
      ]),
    );
    expect(names).not.toEqual(
      expect.arrayContaining([
        "djlink link",
        "library status",
        "rekordbox stems separate",
        "tracks resolve",
        "usb sync",
      ]),
    );
  });

  test("exposes local Rekordbox playlist CRUD at the product root", async () => {
    const create = await serve(["playlist", "create", "--help"]);
    expect(create.exitCode).toBeUndefined();
    expect(create.output).toContain("djbooth playlist create <name>");
    expect(create.output).toContain("--type");

    const addFile = await serve(["playlist", "add", "--help"]);
    expect(addFile.exitCode).toBeUndefined();
    expect(addFile.output).toContain("djbooth playlist add <playlist> <audioPath>");
    expect(addFile.output).toContain("--duration-seconds");
    expect(addFile.output).toContain("--replace-analysis");
  });

  test("retains typed specialist provider groups", async () => {
    const spotify = await serve(["spots", "playlist", "create", "--help"]);
    expect(spotify.exitCode).toBeUndefined();
    expect(spotify.output).toContain("djbooth spots playlist create <name>");
    expect(spotify.output).toContain("--track");
    expect(spotify.output).toContain("--visibility");

    const soundcloud = await serve(["soundcloud", "playlist", "create", "--help"]);
    expect(soundcloud.exitCode).toBeUndefined();
    expect(soundcloud.output).toContain("djbooth soundcloud playlist create <title>");
    expect(soundcloud.output).toContain("--track");
    expect(soundcloud.output).toContain("--sharing");
  });

  test("routes native and Python workflows without redundant action names", async () => {
    const stems = await serve(["stems", "--help"]);
    expect(stems.output).toContain("djbooth stems <track>");
    expect(stems.output).toContain("--python-project-directory");
    expect(stems.output).toContain("--output-directory");

    const usb = await serve(["usb", "--help"]);
    expect(usb.output).toContain("djbooth usb <target>");
    expect(usb.output).toContain("--playlist-folder");

    const server = await serve(["serve", "--help"]);
    expect(server.output).toContain("Pro DJ Link");
    expect(server.output).toContain("managed background");
    expect(server.output).toContain("--assistant");
    expect(server.output).toContain("--sonos <string>");
    expect(server.output).toContain("--share-host <string>");
    expect(server.output).toContain("--share-port");
    expect(server.output).toContain("--pairing-file <string>");
    const pairing = await serve(["pairing", "rotate", "--help"]);
    expect(pairing.output).toContain("djbooth pairing rotate");
    expect(pairing.output).toContain("--path <string>");

    const stop = await serve(["stop", "--help"]);
    expect(stop.output).toContain("Stop the managed djbooth");

    const transcription = await serve(["produce", "transcribe", "--help"]);
    expect(transcription.output).toContain("djbooth produce transcribe <audio> <output>");
    expect(transcription.output).toContain("--instrument");
    expect(transcription.output).toContain("--max-tokens");
  });

  test("preserves the full-library DJ Link one-shot guidance", async () => {
    const { output } = await serve(["link", "--help"]);

    expect(output).toContain("djbooth link [track]");
    expect(output).toContain("validate → start/resume → discover");
    expect(output).toContain("network CTA");
  });
});

describe("djbooth runtime status", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "djbooth-status-"));
    vi.stubEnv("DJBOOTH_RUNTIME_DIR", join(directory, "runtime"));
    vi.stubEnv("DJBOOTH_DJLINK_STATE_DIR", join(directory, "link"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  test("returns only the private descriptor path in readiness/status and rotates active access through the public CLI", async () => {
    const root = await realpath(directory);
    vi.stubEnv("DJBOOTH_PAIRING_DIR", join(root, "private-pairing"));
    const dbPath = join(root, "library", "master.db");
    MasterDatabase.createManaged(dbPath).close();
    const pairingFile = join(root, "phone.json");
    const runtime = await startDjBoothServer(
      {
        databasePath: dbPath,
        port: 0,
        shareHost: "127.0.0.1",
        sharePort: 0,
        pairingFile,
        assistant: false,
        link: false,
      },
      {
        startLibraryServer: (options) =>
          startLibraryServer({ ...options, hosted: false, usbMedia: false }),
        async startRekordboxDjLink() {
          throw new Error("No-link sharing must not start hardware");
        },
        async stopDjLink() {
          throw new Error("No-link sharing must not stop hardware");
        },
        async startSonosBridge() {
          throw new Error("No-link sharing must not start Sonos");
        },
      },
    );
    const web = runtime.web;
    const authStatus = (pair: PairingDescriptor) =>
      new Promise<number>((done, reject) => {
        const req = request(
          new URL("/pair/v1/catalog", pair.url),
          {
            rejectUnauthorized: false,
            agent: false,
            headers: { authorization: `Bearer ${pair.token}` },
          },
          (response) => {
            response.resume();
            response.on("end", () => done(response.statusCode!));
          },
        );
        req.on("error", reject);
        req.end();
      });
    try {
      expect(runtime.link).toBeNull();
      await expect(runtime.reconcileLink()).resolves.toBeNull();
      const pair = JSON.parse(await readFile(pairingFile, "utf8")) as PairingDescriptor;
      await mkdir(join(directory, "runtime"));
      await writeFile(
        join(directory, "runtime", "serve.json"),
        JSON.stringify({
          version: DJBOOTH_RUNTIME_VERSION,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          url: web.url,
          monitorUrl: new URL("/booth", web.url).toString(),
          assistantEnabled: false,
          options: {
            databasePath: dbPath,
            port: 0,
            shareHost: "127.0.0.1",
            sharePort: 0,
            pairingFile,
            assistant: false,
            link: false,
          },
          link: null,
          sonos: null,
          pairingFile,
          logPath: join(directory, "serve.log"),
        }),
      );
      vi.spyOn(linkControl, "statusDjLink").mockResolvedValue({
        running: false,
        staleState: false,
      });
      const ready = await serve([
        "serve",
        "--path",
        dbPath,
        "--port",
        "0",
        "--share-host",
        "127.0.0.1",
        "--share-port",
        "0",
        "--pairing-file",
        pairingFile,
        "--no-link",
        "--no-assistant",
        "--format",
        "json",
      ]);
      expect(ready.exitCode, ready.output).toBeUndefined();
      expect(JSON.parse(ready.output)).toMatchObject({
        action: "resumed",
        pairingFile,
        link: null,
      });
      const status = await serve(["status", "--runtime-only", "--format", "json"]);
      expect(status.exitCode, status.output).toBeUndefined();
      expect(JSON.parse(status.output).serve.pairingFile).toBe(pairingFile);
      for (const result of [ready.output, status.output]) {
        expect(result.includes(pair.token)).toBe(false);
        expect(result.includes("PRIVATE KEY")).toBe(false);
        expect(result).not.toContain('"certificateSHA256"');
      }
      const rotated = await execFileAsync(
        "pnpm",
        ["--silent", "djbooth", "pairing", "rotate", "--path", dbPath, "--format", "json"],
        { cwd: new URL("../../..", import.meta.url), env: { ...process.env, NO_COLOR: "1" } },
      );
      expect(JSON.parse(rotated.stdout)).toEqual({ pairingFile });
      const next = JSON.parse(await readFile(pairingFile, "utf8")) as PairingDescriptor;
      expect(next.token === pair.token).toBe(false);
      expect(await authStatus(pair)).toBe(401);
      expect(await authStatus(next)).toBe(200);
      const resumed = await serve(["status", "--runtime-only", "--format", "json"]);
      expect(JSON.parse(resumed.output).serve.pid).toBe(process.pid);
    } finally {
      await expect(runtime.close()).resolves.toEqual({ linkStopped: false });
    }
  });

  test.each(["configured", "link"])(
    "discovers a nondefault runtime and %s database without opening it",
    async (identity) => {
      const dbPath = join(directory, "owned-library", "master.db");
      const link = {
        running: true as const,
        pid: process.pid,
        sourceKind: "rekordbox" as const,
        sourcePath:
          identity === "configured" ? join(directory, "different-link", "master.db") : dbPath,
        bindIp: "192.0.2.10",
        broadcastIp: "192.0.2.255",
        playerNumber: 17,
        tracks: 23,
        playlists: 4,
        uptimeMs: 50,
        logPath: join(directory, "link.log"),
        socketPath: join(directory, "link.sock"),
        remoteTransportSupported: true,
        remoteDeckPreparationSupported: true as const,
        libraryRefreshSupported: true,
      };
      vi.spyOn(linkControl, "statusDjLink").mockResolvedValue(link);
      const state = {
        version: DJBOOTH_RUNTIME_VERSION,
        pid: process.pid,
        startedAt: "2026-10-17T12:00:00Z",
        url: "http://127.0.0.1:5297/?assistant=0",
        assistantEnabled: false,
        options: identity === "configured" ? { databasePath: dbPath } : {},
        link: { ...link, resumed: true },
        logPath: join(directory, "serve.log"),
        monitorUrl: "http://127.0.0.1:5297/booth",
        sonos: null,
      };
      await mkdir(join(directory, "runtime"));
      const statePath = join(directory, "runtime", "serve.json");
      const stateJson = JSON.stringify(state);
      await writeFile(statePath, stateJson);

      // The database deliberately does not exist yet. Discovery must still succeed.
      const runtime = await serve(["status", "--runtime-only", "--format", "json"]);
      expect(runtime.exitCode, runtime.output).toBeUndefined();
      const result = JSON.parse(runtime.output);
      expect(result).toMatchObject({
        serve: {
          running: true,
          pid: process.pid,
          dbPath,
          url: state.url,
          views: { library: state.url, booth: state.monitorUrl },
        },
        link: {
          running: true,
          sourceKind: "rekordbox",
          sourcePath: link.sourcePath,
          playerNumber: 17,
        },
      });
      expect(result).not.toHaveProperty("stats");
      expect(await readFile(statePath, "utf8")).toBe(stateJson);
      expect(await readdir(directory)).toEqual(["runtime"]);

      // Full status uses that same database rather than discovering another library.
      const database = MasterDatabase.createManaged(dbPath);
      database.createPlaylist("Active source playlist");
      database.commit();
      database.close();
      const full = await serve(["status", "--format", "json"]);
      expect(full.exitCode, full.output).toBeUndefined();
      expect(JSON.parse(full.output)).toMatchObject({
        dbPath,
        dbDirectory: join(directory, "owned-library"),
        stats: { tracks: 0, playlists: 1 },
        imports: { total: 0 },
        serve: { dbPath, url: state.url },
      });

      const otherPath = join(directory, "other-library", "master.db");
      MasterDatabase.createManaged(otherPath).close();
      const explicit = await serve(["status", "--path", otherPath, "--format", "json"]);
      expect(explicit.exitCode, explicit.output).toBeUndefined();
      expect(JSON.parse(explicit.output)).toMatchObject({
        dbPath: otherPath,
        stats: { playlists: 0 },
        serve: { dbPath },
      });
    },
  );

  test("reports no runtime without requiring or creating a library", async () => {
    const result = await serve([
      "status",
      "--runtime-only",
      "--path",
      join(directory, "missing.db"),
      "--format",
      "json",
    ]);
    expect(result.exitCode, result.output).toBeUndefined();
    expect(JSON.parse(result.output)).toEqual({
      serve: {
        running: false,
        staleState: false,
        logPath: join(directory, "runtime", "serve.log"),
      },
      link: { running: false, staleState: false },
    });
    // Exercise the exact development launcher used by DesktopRuntime, not only Incur in-process.
    const launched = await execFileAsync(
      "pnpm",
      ["--silent", "djbooth", "status", "--runtime-only", "--format", "json"],
      {
        cwd: new URL("../../..", import.meta.url),
        env: { ...process.env, NO_COLOR: "1" },
      },
    );
    expect(JSON.parse(launched.stdout)).toEqual(JSON.parse(result.output));
    expect(await readdir(directory)).toEqual([]);
  });
});
