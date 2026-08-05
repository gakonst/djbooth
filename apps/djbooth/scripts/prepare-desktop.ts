#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const packageRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(packageRoot, "../..");
const targetTriple = process.env.TAURI_ENV_TARGET_TRIPLE ?? "aarch64-apple-darwin";
const binariesDirectory = resolve(packageRoot, "src-tauri/binaries");
const resourcesDirectory = resolve(packageRoot, "src-tauri/resources");
const backendDirectory = resolve(resourcesDirectory, "backend");
const toolsDirectory = resolve(resourcesDirectory, "tools");
const stemsProjectDirectory = resolve(workspaceRoot, "python/stems-mlx");
const stemsProjectFiles = ["djbooth_stems_mlx.py", "pyproject.toml", "uv.lock", "README.md"];
const enhancementProjectDirectory = resolve(workspaceRoot, "python/a2sb-mlx");
const enhancementProjectFiles = [
  "a2sb_mlx.py",
  "djbooth_a2sb_mlx.py",
  "NVIDIA-A2SB-LICENSE",
  "pyproject.toml",
  "uv.lock",
  "README.md",
];
const sidecarPath = resolve(binariesDirectory, `djbooth-node-${targetTriple}`);

if (!supportedTarget(targetTriple))
  throw new TypeError(`Unsupported desktop target '${targetTriple}'`);
const nodePath = await commandOutput("node", ["-p", "process.execPath"]);
const nodeVersion = await commandOutput(nodePath, ["-p", "process.versions.node"]);
if (!nodeVersion.startsWith("22."))
  throw new Error(`Desktop packaging requires Node.js 22; found ${nodeVersion}`);

await mkdir(binariesDirectory, { recursive: true });
await rm(backendDirectory, { force: true, recursive: true });
await rm(toolsDirectory, { force: true, recursive: true });
await mkdir(toolsDirectory, { recursive: true });
await copyFile(nodePath, sidecarPath);
await chmod(sidecarPath, 0o755);
if (targetTriple.endsWith("-apple-darwin")) {
  await run("strip", ["-x", sidecarPath]);
  const strippedNodeVersion = await commandOutput(sidecarPath, ["-p", "process.versions.node"]);
  if (strippedNodeVersion !== nodeVersion)
    throw new Error(`Stripped Node.js sidecar failed validation; found ${strippedNodeVersion}`);
}
await run("pnpm", [
  "--filter",
  "@gakonst/djbooth-app",
  "--prod",
  "deploy",
  "--legacy",
  backendDirectory,
]);
const pruned = await pruneRuntimeMetadata(backendDirectory);
process.stdout.write(
  `Pruned ${pruned.files.toLocaleString()} runtime-dead metadata files (${formatBytes(pruned.bytes)})\n`,
);
const buildInputs = await pruneRuntimeBuildInputs(backendDirectory);
process.stdout.write(`Pruned runtime-dead build inputs (${formatBytes(buildInputs)})\n`);

const analyzerSource = resolve(workspaceRoot, "packages/rekordbox-ts/.djbooth-rs/djbooth-rs");
if (!(await isFile(analyzerSource)))
  await run("pnpm", ["--filter", "@gakonst/rekordbox", "build:analyzer"]);
const analyzerDestination = resolve(toolsDirectory, "djbooth-rs");
await copyFile(analyzerSource, analyzerDestination);
await chmod(analyzerDestination, 0o755);

const uvPath = (
  await commandOutput(process.platform === "win32" ? "where" : "which", ["uv"])
).split(/\r?\n/u)[0]!;
const uvDestination = resolve(toolsDirectory, process.platform === "win32" ? "uv.exe" : "uv");
await copyFile(uvPath, uvDestination);
await chmod(uvDestination, 0o755);
const packagedStemsProjectDirectory = resolve(toolsDirectory, "stems-mlx");
await mkdir(packagedStemsProjectDirectory, { recursive: true });
for (const file of stemsProjectFiles)
  await copyFile(
    resolve(stemsProjectDirectory, file),
    resolve(packagedStemsProjectDirectory, file),
  );
const packagedEnhancementProjectDirectory = resolve(toolsDirectory, "a2sb-mlx");
await mkdir(packagedEnhancementProjectDirectory, { recursive: true });
for (const file of enhancementProjectFiles)
  await copyFile(
    resolve(enhancementProjectDirectory, file),
    resolve(packagedEnhancementProjectDirectory, file),
  );

const nodeLicense = resolve(dirname(dirname(nodePath)), "LICENSE");
try {
  await readFile(nodeLicense);
  await mkdir(resolve(resourcesDirectory, "licenses"), { recursive: true });
  await copyFile(nodeLicense, resolve(resourcesDirectory, "licenses/node-LICENSE"));
} catch {
  process.stderr.write(`warning: Node.js license not found at ${nodeLicense}\n`);
}

async function commandOutput(command: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    cwd: workspaceRoot,
  });
  return stdout.trim();
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: workspaceRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} exited with ${code ?? signal ?? "no status"}`));
    });
  });
}

function supportedTarget(target: string): boolean {
  return [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
  ].includes(target);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function pruneRuntimeMetadata(directory: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await pruneRuntimeMetadata(path);
      bytes += nested.bytes;
      files += nested.files;
      continue;
    }
    if (!isRuntimeMetadata(entry.name)) continue;
    bytes += (await stat(path)).size;
    files += 1;
    await rm(path);
  }
  return { bytes, files };
}

function isRuntimeMetadata(name: string): boolean {
  return name.endsWith(".map") || /\.d\.(?:c|m)?ts$/u.test(name);
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

async function pruneRuntimeBuildInputs(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = resolve(directory, entry.name);
    if (isRuntimeBuildInput(path)) {
      bytes += await directorySize(path);
      await rm(path, { force: true, recursive: true });
    } else {
      bytes += await pruneRuntimeBuildInputs(path);
    }
  }
  return bytes;
}

function isRuntimeBuildInput(path: string): boolean {
  const packageName = basename(dirname(path));
  const directoryName = basename(path);
  return (
    (packageName === "better-sqlite3-multiple-ciphers" &&
      (directoryName === "deps" || directoryName === "src")) ||
    (packageName === "youtubei.js" && directoryName === "bundle")
  );
}

async function directorySize(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) bytes += await directorySize(path);
    else if (entry.isFile()) bytes += (await stat(path)).size;
  }
  return bytes;
}
