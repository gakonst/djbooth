import { chmod, copyFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "../..");
const manifest = resolve(workspaceRoot, "rust/Cargo.toml");
const source = resolve(workspaceRoot, "rust/target/release/djbooth-rs");
const destination = resolve(packageRoot, "native-bin/djbooth-rs");

await new Promise((resolveBuild, rejectBuild) => {
  const child = spawn(
    "cargo",
    ["build", "--release", "--manifest-path", manifest, "-p", "djbooth-rs"],
    {
      cwd: packageRoot,
      stdio: "inherit",
    },
  );
  child.once("error", rejectBuild);
  child.once("exit", (code, signal) => {
    if (code === 0) resolveBuild();
    else rejectBuild(new Error(`cargo build failed (${signal ?? `exit ${String(code)}`})`));
  });
});

await mkdir(dirname(destination), { recursive: true });
// Replace the path atomically, leaving an already-running server's executable intact.
const stagedDestination = `${destination}.${process.pid}.tmp`;
try {
  await copyFile(source, stagedDestination);
  await chmod(stagedDestination, 0o755);
  await rename(stagedDestination, destination);
} finally {
  await rm(stagedDestination, { force: true });
}
process.stdout.write(`${destination}\n`);
