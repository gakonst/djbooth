import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CdjUsbError, statusCdjUsb } from "../src/runtime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fakeNative(stdout: string): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "music-cdj-usb-test-"));
  roots.push(root);
  const path = resolve(root, "music-cdj-usb");
  await writeFile(path, `#!/bin/sh\nprintf '%s' '${stdout.replaceAll("'", "'\\''")}'\n`);
  await chmod(path, 0o755);
  return path;
}

describe("CDJ USB native bridge", () => {
  it("validates bounded native JSON before returning public state", async () => {
    const binaryPath = await fakeNative(
      JSON.stringify({
        schemaVersion: 1,
        gadgetName: "music",
        configured: false,
        attached: false,
        safeToPublish: true,
        udc: null,
        hostState: null,
        backingFile: null,
        readOnly: null,
        activeImage: null,
      }),
    );

    await expect(statusCdjUsb({ binaryPath, env: {} })).resolves.toMatchObject({
      configured: false,
      safeToPublish: true,
    });
  });

  it("rejects malformed native output", async () => {
    const binaryPath = await fakeNative("not-json");

    await expect(statusCdjUsb({ binaryPath, env: {} })).rejects.toMatchObject({
      code: "INVALID_OUTPUT",
    } satisfies Partial<CdjUsbError>);
  });
});
