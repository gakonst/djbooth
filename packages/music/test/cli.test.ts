import { describe, expect, test } from "vitest";

import { createMusicCli } from "../src/cli.js";

async function serve(argv: string[]): Promise<{
  exitCode: number | undefined;
  output: string;
}> {
  let output = "";
  let exitCode: number | undefined;
  await createMusicCli().serve(argv, {
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

describe("music CLI", () => {
  test("composes every package-owned command tree", async () => {
    const { output } = await serve(["--llms-full", "--format", "json"]);
    const manifest = JSON.parse(output) as { commands: { name: string }[] };
    const names = manifest.commands.map((command) => command.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "rekordbox analyze track",
        "rekordbox db playlist create",
        "rekordbox db playlist list",
        "rekordbox status",
        "library status",
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

  test("retains package command schemas after mounting", async () => {
    const spotify = await serve(["spots", "playlist", "create", "--help"]);
    expect(spotify.exitCode).toBeUndefined();
    expect(spotify.output).toContain("music spots playlist create <name>");
    expect(spotify.output).toContain("--track");
    expect(spotify.output).toContain("--input-file");
    expect(spotify.output).toContain("--visibility");

    const soundcloud = await serve(["soundcloud", "playlist", "create", "--help"]);
    expect(soundcloud.exitCode).toBeUndefined();
    expect(soundcloud.output).toContain("music soundcloud playlist create <title>");
    expect(soundcloud.output).toContain("--track");
    expect(soundcloud.output).toContain("--input-file");
    expect(soundcloud.output).toContain("--sharing");
  });

  test("mounts every specialist CLI as a top-level group", async () => {
    const { output } = await serve(["--help"]);

    for (const command of [
      "library",
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

  test("lists the workflow skill alongside typed command-group skills", async () => {
    const { output } = await serve(["skills", "list"]);
    expect(output).toContain("music ");
    expect(output).toContain("music-library");
    expect(output).toContain("music-rekordbox");
    expect(output).toContain("music-ytdlp-ts");
    expect(output).toContain("8 skills");
  });
});
