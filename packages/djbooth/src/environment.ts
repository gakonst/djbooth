import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { loadEnvFile } from "node:process";

/** Load the nearest workspace/user configuration once before command implementation imports. */
export function loadDjBoothEnvironment(): void {
  const candidates = [
    process.env.DJBOOTH_ENV_FILE,
    process.env.MUSIC_ENV_FILE,
    ...ancestorEnvironmentFiles(process.cwd()),
    resolve(homedir(), ".config/djbooth/.env"),
    resolve(homedir(), ".config/music-ts/.env"),
    resolve(import.meta.dirname, "../../../.env"),
  ].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path) loadEnvFile(path);
}

function ancestorEnvironmentFiles(start: string): string[] {
  const files: string[] = [];
  let directory = resolve(start);
  while (true) {
    files.push(resolve(directory, ".env"));
    const parent = dirname(directory);
    if (parent === directory) return files;
    directory = parent;
  }
}
