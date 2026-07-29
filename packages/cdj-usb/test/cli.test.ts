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
      expect.arrayContaining(["export", "doctor", "status", "publish", "attach", "detach", "run"]),
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
});
