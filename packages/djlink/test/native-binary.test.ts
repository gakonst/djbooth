import { chmod, mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, expect, it } from "vitest";

import { canResumeNativeBinary, selectNativeBinary } from "../src/native-binary.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function builds() {
  const root = await mkdtemp(resolve(tmpdir(), "djlink-binaries-"));
  roots.push(root);
  const paths = ["packaged", "release", "debug"].map((name) => resolve(root, name));
  for (const [index, path] of paths.entries()) {
    await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await utimes(path, 100 + index, 100 + index);
  }
  return { root, paths };
}

it("uses fresh shared Rust fixes even when an older packaged helper exists", async () => {
  const { paths } = await builds();
  expect(await selectNativeBinary([], paths)).toBe(paths[2]);
  await utimes(paths[0]!, 200, 200);
  expect(await selectNativeBinary([], paths)).toBe(paths[0]);
});

it("preserves explicit override precedence over newer default builds", async () => {
  const { paths } = await builds();
  expect(await selectNativeBinary([undefined, paths[0], paths[1]], paths)).toBe(paths[0]);
});

it("skips missing files, directories, and non-executable builds", async () => {
  const { root, paths } = await builds();
  await chmod(paths[2]!, 0o644);
  const directory = resolve(root, "directory");
  await mkdir(directory);
  expect(await selectNativeBinary([resolve(root, "missing"), directory], paths)).toBe(paths[1]);
  expect(await selectNativeBinary([], [directory, paths[2]!])).toBeUndefined();
});

it("restarts a running helper rebuilt at the same path", async () => {
  const { paths } = await builds();
  const binaryPath = paths[0]!;
  const running = { binaryPath, startedAt: new Date(150_000).toISOString() };
  expect(await canResumeNativeBinary(binaryPath, running)).toBe(true);
  await utimes(binaryPath, 200, 200);
  expect(await canResumeNativeBinary(binaryPath, running)).toBe(false);
});

it("restarts when a different helper is selected or launch metadata is unavailable", async () => {
  const { paths } = await builds();
  const binaryPath = paths[0]!;
  const running = { binaryPath, startedAt: new Date(150_000).toISOString() };
  expect(await canResumeNativeBinary(paths[1]!, running)).toBe(false);
  expect(await canResumeNativeBinary(binaryPath, undefined)).toBe(false);
  expect(await canResumeNativeBinary(binaryPath, { ...running, startedAt: "invalid" })).toBe(false);
});
