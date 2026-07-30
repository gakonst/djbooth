#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const packageRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(packageRoot, "../..");
const targetTriple = process.env.TAURI_ENV_TARGET_TRIPLE ?? "aarch64-apple-darwin";
const binariesDirectory = resolve(packageRoot, "src-tauri/binaries");
const resourcesDirectory = resolve(packageRoot, "src-tauri/resources");
const backendDirectory = resolve(resourcesDirectory, "backend");
const toolsDirectory = resolve(resourcesDirectory, "tools");
const sidecarPath = resolve(binariesDirectory, `rekordbox-library-node-${targetTriple}`);

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
await run("pnpm", [
  "--filter",
  "@gakonst/rekordbox-library",
  "--prod",
  "deploy",
  "--legacy",
  backendDirectory,
]);

const analyzerSource = resolve(
  workspaceRoot,
  "native/rekordbox-analyzer-core/target/release/rekordbox-analyzer",
);
if (!(await isFile(analyzerSource)))
  await run("pnpm", ["--filter", "@gakonst/rekordbox", "build:analyzer"]);
const analyzerDestination = resolve(toolsDirectory, "rekordbox-analyzer");
await copyFile(analyzerSource, analyzerDestination);
await chmod(analyzerDestination, 0o755);

const uvPath = (
  await commandOutput(process.platform === "win32" ? "where" : "which", ["uv"])
).split(/\r?\n/u)[0]!;
const uvDestination = resolve(toolsDirectory, process.platform === "win32" ? "uv.exe" : "uv");
await copyFile(uvPath, uvDestination);
await chmod(uvDestination, 0o755);

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
