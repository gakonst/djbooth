import { Cli } from "incur";
import { describe, expect, it } from "vitest";

import { djlinkCli } from "../src/cli.js";

async function serve(cli: ReturnType<typeof Cli.create>, argv: string[]) {
  let output = "";
  let exitCode: number | undefined;
  await cli.serve(argv, {
    env: {},
    stdout(value) {
      output += value;
    },
    exit(code) {
      exitCode = code;
    },
  });
  return { output, exitCode };
}

describe("DJ Link CLI", () => {
  it("exposes the bounded safe lifecycle", async () => {
    const { output, exitCode } = await serve(djlinkCli, ["--llms-full", "--format", "json"]);
    const manifest = JSON.parse(output) as { commands: Array<{ name: string }> };
    expect(exitCode).toBeUndefined();
    expect(manifest.commands.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "run",
        "link",
        "doctor-rekordbox",
        "doctor",
        "start",
        "status",
        "devices",
        "probe",
        "load",
        "prepare",
        "search",
        "monitor",
        "stop",
      ]),
    );
  });

  it("documents phrase-aware deck preparation", async () => {
    const { output, exitCode } = await serve(djlinkCli, ["prepare", "--help"]);

    expect(exitCode).toBeUndefined();
    expect(output).toContain("djlink prepare <track>");
    expect(output).toContain("first Rekordbox-analyzed chorus");
    expect(output).toContain("--bpm <number>");
    expect(output).toContain("--bars-before <number>");
    expect(output).toContain("start playback");
  });

  it("retains scoped help when mounted under music", async () => {
    const music = Cli.create("music");
    music.command(djlinkCli);
    const { output, exitCode } = await serve(music, ["djlink", "load", "--help"]);

    expect(exitCode).toBeUndefined();
    expect(output).toContain("music djlink load <track>");
    expect(output).toContain("load, and play");
    expect(output).toContain("--player <number>");
  });

  it("advertises the one-shot manifest-to-deck handoff", async () => {
    const { output, exitCode } = await serve(djlinkCli, ["run", "--help"]);

    expect(exitCode).toBeUndefined();
    expect(output).toContain("djlink run <manifest> <track>");
    expect(output).toContain("one-shot manifest-to-deck handoff");
    expect(output).toContain("confirms playback from CDJ status");
  });

  it("advertises direct full-library serving as the default flow", async () => {
    const { output, exitCode } = await serve(djlinkCli, ["link", "--help"]);

    expect(exitCode).toBeUndefined();
    expect(output).toContain("djlink link [track]");
    expect(output).toContain("complete read-only master.db library");
    expect(output).toContain("validate → start/resume → discover");
    expect(output).toContain("folders, playlists, artists, albums, and tracks");
    expect(output).toContain("network CTA");
    expect(output).toContain("default: true");
  });

  it("waits for discovery by default", async () => {
    const { output, exitCode } = await serve(djlinkCli, ["devices", "--help"]);

    expect(exitCode).toBeUndefined();
    expect(output).toContain("--wait-ms <number>");
    expect(output).toContain("default: 2000");
  });

  it("documents the bounded ARP presence probe", async () => {
    const { output, exitCode } = await serve(djlinkCli, ["probe", "--help"]);

    expect(exitCode).toBeUndefined();
    expect(output).toContain("djlink probe <ip>");
    expect(output).toContain("safe ARP request");
    expect(output).toContain("--timeout-ms <number>");
  });

  it("documents the read-only RemoteDB search preflight", async () => {
    const { output, exitCode } = await serve(djlinkCli, ["search", "--help"]);

    expect(exitCode).toBeUndefined();
    expect(output).toContain("djlink search <query>");
    expect(output).toContain("without changing deck or library state");
    expect(output).toContain("--mode <track|artist|album>");
    expect(output).toContain("CDJ Search UI activation");
    expect(output).toContain("0x1500");
    expect(output).toContain("Per-keystroke reconnects mean rejection");
  });
});
