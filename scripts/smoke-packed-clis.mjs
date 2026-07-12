import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const suppliedPackDirectory = process.argv[2];
const packDirectory = suppliedPackDirectory
  ? resolve(suppliedPackDirectory)
  : mkdtempSync(join(tmpdir(), "music-ts-packs-"));

const packages = [
  {
    name: "@gakonst/tracks",
    prefix: "gakonst-tracks-",
    bins: ["tracks", "tracks-ts"],
  },
  { name: "@gakonst/spots", prefix: "gakonst-spots-", bins: ["spots"] },
  { name: "slsk-ts", prefix: "slsk-ts-", bins: ["slsk"] },
  {
    name: "@gakonst/ytdlp-ts",
    prefix: "gakonst-ytdlp-ts-",
    bins: ["ytdlp-ts"],
  },
  {
    name: "@gakonst/rekordbox",
    prefix: "gakonst-rekordbox-",
    bins: ["rekordbox", "rekordbox-ts"],
  },
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
    ...options,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with status ${result.status}`,
    );
  }
}

try {
  mkdirSync(packDirectory, { recursive: true });

  if (!suppliedPackDirectory) {
    for (const package_ of packages) {
      run("pnpm", [
        "--filter",
        package_.name,
        "pack",
        "--pack-destination",
        packDirectory,
      ]);
    }
  }

  const archives = readdirSync(packDirectory).filter((file) =>
    file.endsWith(".tgz"),
  );
  const dependencies = {};

  for (const package_ of packages) {
    const matches = archives.filter((archive) =>
      archive.startsWith(package_.prefix),
    );
    if (matches.length !== 1) {
      throw new Error(
        `Expected one ${package_.name} archive in ${packDirectory}; found ${matches.length}`,
      );
    }
    dependencies[package_.name] = `file:${join(packDirectory, matches[0])}`;
  }

  const consumer = join(packDirectory, ".consumer");
  rmSync(consumer, { recursive: true, force: true });
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify(
      {
        name: "music-ts-pack-smoke",
        private: true,
        dependencies,
        pnpm: {
          onlyBuiltDependencies: ["better-sqlite3-multiple-ciphers"],
          overrides: Object.fromEntries(
            Object.entries(dependencies).filter(
              ([name]) => name !== "@gakonst/tracks",
            ),
          ),
        },
      },
      null,
      2,
    )}\n`,
  );

  run("pnpm", ["install"], { cwd: consumer });

  for (const package_ of packages) {
    for (const bin of package_.bins) {
      const executable = join(consumer, "node_modules", ".bin", bin);
      if (!existsSync(executable))
        throw new Error(`Missing packed CLI binary: ${bin}`);
      run(executable, ["--help"], { cwd: consumer, stdio: "ignore" });
      process.stdout.write(`✓ ${bin} --help\n`);
    }
  }
} finally {
  if (!suppliedPackDirectory)
    rmSync(packDirectory, { recursive: true, force: true });
}
