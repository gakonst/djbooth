import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

import { createDjBoothCli } from "../src/cli.js";
import { canDispatchDirectly } from "../src/dispatch.js";

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
