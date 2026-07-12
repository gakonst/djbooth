import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  { name: "@gakonst/music", prefix: "gakonst-music-", bins: ["music"] },
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
  return result;
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
              ([name]) => name !== "@gakonst/music",
            ),
          ),
        },
      },
      null,
      2,
    )}\n`,
  );

  run("pnpm", ["install", "--store-dir", join(packDirectory, ".pnpm-store")], {
    cwd: consumer,
  });

  for (const package_ of packages) {
    for (const bin of package_.bins) {
      const executable = join(consumer, "node_modules", ".bin", bin);
      if (!existsSync(executable))
        throw new Error(`Missing packed CLI binary: ${bin}`);
      const result = run(executable, ["--help"], {
        cwd: consumer,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (!result.stdout.trim())
        throw new Error(`Packed CLI returned empty help: ${bin}`);
      process.stdout.write(`✓ ${bin} --help\n`);
    }
  }

  const music = join(consumer, "node_modules", ".bin", "music");
  const skills = run(music, ["skills", "list"], {
    cwd: consumer,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!skills.stdout.includes("1 skill")) {
    throw new Error("Packed music CLI did not expose exactly one skill");
  }
  process.stdout.write("✓ music skills list\n");

  run(music, ["skills", "add", "--no-global"], {
    cwd: consumer,
    stdio: "ignore",
  });
  const installedSkill = join(
    consumer,
    ".agents",
    "skills",
    "music",
    "SKILL.md",
  );
  const packagedSkill = join(
    consumer,
    "node_modules",
    "@gakonst",
    "music",
    "skills",
    "music",
    "SKILL.md",
  );
  if (
    readFileSync(installedSkill, "utf8") !== readFileSync(packagedSkill, "utf8")
  ) {
    throw new Error("Installed music skill differs from its packed source");
  }
  process.stdout.write("✓ music skills add --no-global\n");

  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'await Promise.all(["@gakonst/music", "@gakonst/music/tracks", "@gakonst/music/spots", "@gakonst/music/slsk", "@gakonst/music/ytdlp", "@gakonst/music/rekordbox"].map((specifier) => import(specifier)))',
    ],
    { cwd: consumer, stdio: "ignore" },
  );
  process.stdout.write("✓ @gakonst/music exports\n");

  const mcpInput = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "music-ts-pack-smoke", version: "1.0.0" },
      },
    },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ];
  const mcp = run(music, ["--mcp"], {
    cwd: consumer,
    input: `${mcpInput.map((request) => JSON.stringify(request)).join("\n")}\n`,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const responses = mcp.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const initialize = responses.find((response) => response.id === 1);
  const tools = responses.find((response) => response.id === 2)?.result?.tools;
  if (initialize?.result?.serverInfo?.name !== "music" || tools?.length !== 6) {
    throw new Error("Packed music MCP did not initialize with six tools");
  }
  process.stdout.write("✓ music stdio MCP (6 tools)\n");
} finally {
  if (!suppliedPackDirectory)
    rmSync(packDirectory, { recursive: true, force: true });
}
