import { describe, expect, test, vi } from "vitest";
import { ReferenceClient } from "@gakonst/ytdlp-ts";

import {
  createDefaultMusicDependencies,
  createMusicCli,
  type MusicCliDependencies,
} from "../src/cli.js";

async function serve(
  dependencies: Partial<MusicCliDependencies>,
  argv: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ exitCode: number | undefined; output: string }> {
  let output = "";
  let exitCode: number | undefined;
  await createMusicCli(dependencies).serve(argv, {
    env,
    stdout: (value) => {
      output += value;
    },
    exit: (code) => {
      exitCode = code;
    },
  });
  return { exitCode, output };
}

describe("music CLI", () => {
  test("resolves descriptions through the ytdlp library instead of its package CLI", async () => {
    const inspect = vi.spyOn(ReferenceClient.prototype, "inspect").mockResolvedValue({
      id: "set-id",
      title: "Library Set",
      description: "00:00 Artist - Track\n03:00 Artist - Next",
      duration: 360,
      webpage_url: "https://youtu.be/library",
    });

    const manifest = await createDefaultMusicDependencies().resolveTracks(
      "https://youtu.be/library",
      { provider: "description", cacheMode: "off", env: {} },
    );

    expect(manifest).toMatchObject({
      source: { id: "set-id", title: "Library Set" },
      entries: [
        { cue: { startSeconds: 0 }, identity: { artist: "Artist", title: "Track" } },
        { cue: { startSeconds: 180 }, identity: { artist: "Artist", title: "Next" } },
      ],
    });
    expect(inspect).toHaveBeenCalledOnce();
    inspect.mockRestore();
  });

  test("publishes the complete specialist command groups in its agent manifest", async () => {
    const { output } = await serve({}, ["--llms-full", "--format", "json"]);
    const manifest = JSON.parse(output) as { commands: { name: string }[] };
    const commands = manifest.commands.map((command) => command.name);
    expect(commands.length).toBeGreaterThan(250);
    expect(commands).toEqual(
      expect.arrayContaining([
        "rekordbox analyze track",
        "rekordbox db playlist create",
        "slsk download",
        "soundcloud resolve",
        "spots api search",
        "tracks resolve",
        "ytdlp download",
      ]),
    );
  });

  test("lists one aggregate music skill", async () => {
    const { output } = await serve({}, ["skills", "list"]);
    expect(output).toContain("music");
    expect(output).toContain("1 skill (0 installed)");
  });

  test("routes track, Spotify, ytdlp, and Rekordbox work through injected library calls", async () => {
    const resolveTracks = vi.fn(async (source: string) => ({ source, resolved: true }));
    const spotifySession = vi.fn(async () => ({ loggedIn: false }));
    const ytdlpEngines = vi.fn(async () => ({ native: { available: true } }));
    const inspectYtdlp = vi.fn(async (url: string) => ({ url, engine: "reference" }));
    const rekordboxStatus = vi.fn(() => ({ version: "test", rekordboxPid: 0 }));
    const dependencies = {
      resolveTracks,
      spotifySession,
      ytdlpEngines,
      inspectYtdlp,
      rekordboxStatus,
    };

    expect(
      JSON.parse(
        (await serve(dependencies, ["tracks", "resolve", "set-url", "--format", "json"])).output,
      ),
    ).toMatchObject({ source: "set-url", resolved: true });
    expect(
      JSON.parse((await serve(dependencies, ["spots", "session", "--format", "json"])).output),
    ).toEqual({ loggedIn: false });
    expect(
      JSON.parse((await serve(dependencies, ["ytdlp", "engines", "--format", "json"])).output),
    ).toMatchObject({ native: { available: true } });
    expect(
      JSON.parse(
        (
          await serve(dependencies, [
            "ytdlp",
            "inspect",
            "https://youtu.be/example",
            "--format",
            "json",
          ])
        ).output,
      ),
    ).toMatchObject({ engine: "reference" });
    expect(
      JSON.parse((await serve(dependencies, ["rekordbox", "status", "--format", "json"])).output),
    ).toMatchObject({ version: "test", rekordboxPid: 0 });

    expect(resolveTracks).toHaveBeenCalledOnce();
    expect(spotifySession).toHaveBeenCalledOnce();
    expect(ytdlpEngines).toHaveBeenCalledOnce();
    expect(inspectYtdlp).toHaveBeenCalledOnce();
    expect(rekordboxStatus).toHaveBeenCalledOnce();
  });

  test("routes bounded Soulseek search options and credentials without spawning its CLI", async () => {
    const searchSoulseek = vi.fn(async () => [{ username: "peer", files: [] }]);
    const result = await serve(
      { searchSoulseek },
      [
        "slsk",
        "search",
        "artist track",
        "--timeout",
        "2",
        "--max-results",
        "3",
        "--format",
        "json",
      ],
      { SLSK_USERNAME: "user", SLSK_PASSWORD: "pass" },
    );

    expect(result.exitCode).toBeUndefined();
    expect(JSON.parse(result.output)).toEqual([{ username: "peer", files: [] }]);
    expect(searchSoulseek).toHaveBeenCalledWith("artist track", {
      username: "user",
      password: "pass",
      server: "server.slsknet.org:2242",
      listenPort: 0,
      timeoutMs: 2_000,
      maxResults: 3,
    });
  });
});
