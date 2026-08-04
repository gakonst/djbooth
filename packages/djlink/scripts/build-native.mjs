import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageRoot, "../..");
const manifest = resolve(workspaceRoot, "rust/Cargo.toml");
const source = resolve(workspaceRoot, "rust/target/release/music-djlink");
const destination = resolve(packageRoot, "native-bin/music-djlink");

await new Promise((resolveBuild, rejectBuild) => {
  const child = spawn(
    "cargo",
    ["build", "--release", "--manifest-path", manifest, "-p", "music-djlink"],
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
await copyFile(source, destination);
await chmod(destination, 0o755);
process.stdout.write(`${destination}\n`);
