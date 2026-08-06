import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

import { createDjBoothCli } from "../src/cli.js";

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
  test("runs library help through the source-resolved workspace command", async () => {
    const { stdout } = await execFileAsync("pnpm", ["djbooth", "library", "status", "--help"], {
      cwd: new URL("../../..", import.meta.url),
      env: { ...process.env, NO_COLOR: "1" },
    });

    expect(stdout).toContain("djbooth library status");
    expect(stdout).toContain("--path <string>");
  });

  test("composes every package-owned command tree", async () => {
    const { output } = await serve(["--llms-full", "--format", "json"]);
    const manifest = JSON.parse(output) as { commands: { name: string }[] };
    const names = manifest.commands.map((command) => command.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "usb attach",
        "usb doctor",
        "usb export",
        "usb publish",
        "usb sync",
        "usb status",
        "djlink devices",
        "djlink load",
        "djlink search",
        "djlink start",
        "rekordbox analyze track",
        "rekordbox stems doctor",
        "rekordbox stems separate",
        "rekordbox db playlist create",
        "rekordbox db playlist list",
        "rekordbox status",
        "library status",
        "produce ableton import-drum-clip",
        "produce ableton import-midi-clip",
        "produce ableton audit-device-graphs",
        "produce ableton audit-presets",
        "produce ableton inspect-asset",
        "produce ableton inspect-clip",
        "produce ableton inspect-groove",
        "produce ableton inspect-instrument",
        "produce ableton inspect-device-graph",
        "produce ableton inspect-rack",
        "produce ableton library",
        "produce ableton probe-engine",
        "produce profile-compare",
        "produce reference-profile",
        "produce render",
        "produce transcribe",
        "slsk download",
        "slsk search",
        "soundcloud api get-me",
        "soundcloud playlist create",
        "soundcloud playlist delete",
        "soundcloud playlist get",
        "soundcloud playlist update",
        "spots api get-current-users-profile",
        "spots playlist create",
        "spots playlist delete",
        "spots playlist get",
        "spots playlist update",
        "tracks resolve",
        "ytdlp-ts engines",
        "ytdlp-ts music",
      ]),
    );
    expect(names).not.toContain("spots session");
    expect(names.length).toBeGreaterThan(250);
  });

  test("exposes native Ableton MIDI render controls", async () => {
    const { output, exitCode } = await serve(["produce", "ableton", "probe-engine", "--help"]);
    expect(exitCode).toBeUndefined();
    expect(output).toContain("--note <number>");
    expect(output).toContain("--sequence <string>");
    expect(output).toContain("--sample <string>");
    expect(output).toContain("--preset <string>");
    expect(output).toContain("--preset-device-offset <number>");
    expect(output).toContain("--velocity <number>");
    expect(output).toContain("--gate-seconds <number>");
    expect(output).toContain("--render-frames <number>");
  });

  test("exposes exhaustive Ableton device graph inspection", async () => {
    const { output, exitCode } = await serve([
      "produce",
      "ableton",
      "inspect-device-graph",
      "--help",
    ]);
    expect(exitCode).toBeUndefined();
    expect(output).toContain("djbooth produce ableton inspect-device-graph <asset>");
    expect(output).toContain("nested racks");
    expect(output).toContain("chain zones");
  });

  test("exposes crash-isolated Ableton engine rendering audit", async () => {
    const { output, exitCode } = await serve(["produce", "ableton", "audit-engine", "--help"]);
    expect(exitCode).toBeUndefined();
    expect(output).toContain("--render");
    expect(output).toContain("audio input/output topology");
  });

  test("exposes exhaustive installed Ableton preset auditing", async () => {
    const { output, exitCode } = await serve(["produce", "ableton", "audit-presets", "--help"]);
    expect(exitCode).toBeUndefined();
    expect(output).toContain("--all");
    expect(output).toContain("every eligible installed ADV preset");
  });

  test("retains package command schemas after mounting", async () => {
    const spotify = await serve(["spots", "playlist", "create", "--help"]);
    expect(spotify.exitCode).toBeUndefined();
    expect(spotify.output).toContain("djbooth spots playlist create <name>");
    expect(spotify.output).toContain("--track");
    expect(spotify.output).toContain("--input-file");
    expect(spotify.output).toContain("--visibility");

    const soundcloud = await serve(["soundcloud", "playlist", "create", "--help"]);
    expect(soundcloud.exitCode).toBeUndefined();
    expect(soundcloud.output).toContain("djbooth soundcloud playlist create <title>");
    expect(soundcloud.output).toContain("--track");
    expect(soundcloud.output).toContain("--input-file");
    expect(soundcloud.output).toContain("--sharing");
  });

  test("mounts every specialist CLI as a top-level group", async () => {
    const { output } = await serve(["--help"]);

    for (const command of [
      "library",
      "produce",
      "usb",
      "djlink",
      "rekordbox",
      "slsk",
      "soundcloud",
      "spots",
      "tracks",
      "ytdlp-ts",
    ]) {
      expect(output).toMatch(new RegExp(`^  ${command}\\s{2,}`, "m"));
    }
  });

  test("routes native and Python helpers through the umbrella Incur tree", async () => {
    const analyzer = await serve(["rekordbox", "analyze", "track", "--help"]);
    expect(analyzer.output).toContain("djbooth rekordbox analyze track <audioPath>");
    expect(analyzer.output).toContain("--analyzer-binary");

    const stems = await serve(["rekordbox", "stems", "separate", "--help"]);
    expect(stems.output).toContain(
      "djbooth rekordbox stems separate <audioPath> <outputDirectory>",
    );
    expect(stems.output).toContain("--python-project-directory");

    const transcription = await serve(["produce", "transcribe", "--help"]);
    expect(transcription.output).toContain("djbooth produce transcribe <audio> <output>");
    expect(transcription.output).toContain("--python-project-directory");
    expect(transcription.output).toContain("--instrument");

    const djlink = await serve(["djlink", "doctor", "--help"]);
    expect(djlink.output).toContain("--binary");

    const usb = await serve(["usb", "doctor", "--help"]);
    expect(usb.output).toContain("--binary");
  });

  test("preserves the full-library DJ Link one-shot guidance", async () => {
    const { output } = await serve(["djlink", "rekordbox", "--help"]);

    expect(output).toContain("djbooth djlink rekordbox [track]");
    expect(output).toContain("validate → start/resume → discover");
    expect(output).toContain("network CTA");
  });

  test("preserves the read-only DJ Link Search preflight", async () => {
    const { output } = await serve(["djlink", "search", "--help"]);

    expect(output).toContain("djbooth djlink search <query>");
    expect(output).toContain("without changing deck or library state");
    expect(output).toContain("CDJ Search UI activation");
    expect(output).toContain("0x1500");
    expect(output).toContain("Per-keystroke reconnects mean rejection");
  });

  test("lists the workflow skill alongside typed command-group skills", async () => {
    const { output } = await serve(["skills", "list"]);
    expect(output).toContain("djbooth ");
    expect(output).toContain("djbooth-djlink");
    expect(output).toContain("djbooth-library");
    expect(output).toContain("djbooth-produce");
    expect(output).toContain("djbooth-rekordbox");
    expect(output).toContain("djbooth-usb");
    expect(output).toContain("djbooth-ytdlp-ts");
    expect(output).toContain("11 skills");
  });
});
