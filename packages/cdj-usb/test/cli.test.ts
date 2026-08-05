import { Cli } from "incur";
import { describe, expect, it } from "vitest";

import { cdjUsbCli } from "../src/cli.js";

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

describe("CDJ USB CLI", () => {
  it("exposes SQLite export and the bounded transport lifecycle", async () => {
    const { output, exitCode } = await serve(cdjUsbCli, ["--llms-full", "--format", "json"]);
    const manifest = JSON.parse(output) as { commands: Array<{ name: string }> };

    expect(exitCode).toBeUndefined();
    expect(manifest.commands.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "export",
        "sync",
        "sync-playlist",
        "doctor",
        "status",
        "publish",
        "attach",
        "detach",
        "run",
      ]),
    );
  });

  it("documents the CDJ-3000 legacy conversion without Device Library Plus", async () => {
    const { output, exitCode } = await serve(cdjUsbCli, ["export", "--help"]);

    expect(exitCode).toBeUndefined();
    expect(output).toContain("usb export <target>");
    expect(output).toContain("master.db");
    expect(output).toContain("legacy export.pdb");
    expect(output).toContain("does not create Device Library Plus");
  });

  it("retains the physical eject boundary when mounted under music", async () => {
    const music = Cli.create("music");
    music.command(cdjUsbCli);
    const { output, exitCode } = await serve(music, ["usb", "detach", "--help"]);

    expect(exitCode).toBeUndefined();
    expect(output).toContain("music usb detach");
    expect(output).toContain("--confirm-host-ejected");
    expect(output).toContain("USB STOP/eject");
  });

  it("documents kernel-owned serving after attach", async () => {
    const { output, exitCode } = await serve(cdjUsbCli, ["attach", "--help"]);

    expect(exitCode).toBeUndefined();
    expect(output).toContain("usb attach");
    expect(output).toContain("ordinary USB drive");
    expect(output).toContain("kernel continues serving");
  });

  it("makes one differential round-trip command the normal mounted-media workflow", async () => {
    const { output, exitCode } = await serve(cdjUsbCli, ["sync", "--help"]);

    expect(exitCode).toBeUndefined();
    expect(output).toContain("usb sync <target>");
    expect(output).toContain("unseen CDJ histories");
    expect(output).toContain("DJ Set YYYY-MM-DD");
    expect(output).toContain("play counts advance exactly once");
    expect(output).toContain("unchanged audio is not recopied");
    expect(output).toContain("--playlist-folder");
    expect(output).toContain("Shared tracks copy once");
    expect(output).not.toContain("--write");
  });

  it("exposes fresh and incremental dual-library playlist sync", async () => {
    const { output, exitCode } = await serve(cdjUsbCli, ["sync-playlist", "--help"]);

    expect(exitCode).toBeUndefined();
    expect(output).toContain("usb sync-playlist <target> <playlist>");
    expect(output).toContain("traditional Device Library and OneLibrary");
    expect(output).toContain("--fresh");
    expect(output).toContain("both USB library formats");
    expect(output).not.toContain("--write");
  });
});
