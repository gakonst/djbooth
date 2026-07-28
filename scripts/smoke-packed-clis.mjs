import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
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
    name: "@gakonst/djlink",
    prefix: "gakonst-djlink-",
    bins: ["djlink", "music-djlink-native"],
  },
  {
    name: "@gakonst/rekordbox-library",
    prefix: "gakonst-rekordbox-library-",
    bins: ["rekordbox-library"],
  },
  {
    name: "@gakonst/tracks",
    prefix: "gakonst-tracks-",
    bins: ["tracks", "tracks-ts"],
  },
  { name: "@gakonst/spots", prefix: "gakonst-spots-", bins: ["spots"] },
  {
    name: "@gakonst/soundcloud",
    prefix: "gakonst-soundcloud-",
    bins: ["soundcloud"],
  },
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
      `${command} ${args.join(" ")} exited with status ${result.status}\nstdout: ${result.stdout ?? ""}\nstderr: ${result.stderr ?? ""}`,
    );
  }
  return result;
}

function createPlaylistFixture(path, packageRoot) {
  const require = createRequire(join(realpathSync(packageRoot), "package.json"));
  const Database = require("better-sqlite3-multiple-ciphers");
  const database = new Database(path);
  try {
    database.exec(`
      CREATE TABLE djmdPlaylist (
        ID TEXT PRIMARY KEY, Name TEXT, Attribute INTEGER, ParentID TEXT, Seq INTEGER, SmartList TEXT
      );
      CREATE TABLE djmdSongPlaylist (
        ID TEXT PRIMARY KEY, PlaylistID TEXT, ContentID TEXT, TrackNo INTEGER
      );
      CREATE TABLE djmdArtist (ID TEXT PRIMARY KEY, Name TEXT);
      CREATE TABLE djmdKey (ID TEXT PRIMARY KEY, ScaleName TEXT);
      CREATE TABLE djmdContent (
        ID TEXT PRIMARY KEY, FolderPath TEXT, Title TEXT, ArtistID TEXT, BPM INTEGER, KeyID TEXT,
        Length INTEGER, FileType INTEGER, Analysed INTEGER
      );

      INSERT INTO djmdPlaylist VALUES ('folder-1', 'Packed Sets', 1, 'root', 1, NULL);
      INSERT INTO djmdPlaylist VALUES (
        'playlist-1', 'Packed Festival Set', 0, 'folder-1', 1, NULL
      );
      INSERT INTO djmdArtist VALUES ('artist-1', 'Packed Artist');
      INSERT INTO djmdKey VALUES ('key-1', '10A');
      INSERT INTO djmdContent VALUES (
        'content-1', '/Music/Packed.flac', 'Packed Track', 'artist-1', 12801, 'key-1', 165, 5, 105
      );
      INSERT INTO djmdSongPlaylist VALUES ('membership-1', 'playlist-1', 'content-1', 1);
    `);
  } finally {
    database.close();
  }
}

try {
  mkdirSync(packDirectory, { recursive: true });

  if (!suppliedPackDirectory) {
    run("pnpm", ["build"]);
    for (const package_ of packages) {
      run("pnpm", ["--filter", package_.name, "pack", "--pack-destination", packDirectory]);
    }
  }

  const archives = readdirSync(packDirectory).filter((file) => file.endsWith(".tgz"));
  const dependencies = {};

  for (const package_ of packages) {
    const matches = archives.filter(
      (archive) =>
        archive.startsWith(package_.prefix) && /^\d/u.test(archive.slice(package_.prefix.length)),
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
            Object.entries(dependencies).filter(([name]) => name !== "@gakonst/music"),
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
      if (!existsSync(executable)) throw new Error(`Missing packed CLI binary: ${bin}`);
      const result = run(executable, ["--help"], {
        cwd: consumer,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (!result.stdout.trim()) throw new Error(`Packed CLI returned empty help: ${bin}`);
      process.stdout.write(`✓ ${bin} --help\n`);
    }
  }

  const music = join(consumer, "node_modules", ".bin", "music");
  const libraryHelp = run(music, ["library", "--help"], {
    cwd: consumer,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (
    !libraryHelp.stdout.includes("music library") ||
    !libraryHelp.stdout.includes("status") ||
    !libraryHelp.stdout.includes("serve")
  ) {
    throw new Error("Packed music CLI did not compose the Rekordbox library workbench");
  }
  process.stdout.write("✓ music library composed CLI\n");

  const djlinkHelp = run(music, ["djlink", "--help"], {
    cwd: consumer,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (
    !djlinkHelp.stdout.includes("music djlink") ||
    !djlinkHelp.stdout.includes("devices") ||
    !djlinkHelp.stdout.includes("load") ||
    !djlinkHelp.stdout.includes("search")
  ) {
    throw new Error("Packed music CLI did not compose the DJ Link workflow");
  }
  process.stdout.write("✓ music djlink composed CLI\n");

  const skills = run(music, ["skills", "list"], {
    cwd: consumer,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (
    !skills.stdout.includes("9 skills") ||
    !skills.stdout.includes("music-djlink") ||
    !skills.stdout.includes("music-library") ||
    !skills.stdout.includes("music-rekordbox")
  ) {
    throw new Error("Packed music CLI did not expose its workflow and typed command-group skills");
  }
  process.stdout.write("✓ music skills list\n");

  run(music, ["skills", "add", "--no-global"], {
    cwd: consumer,
    stdio: "ignore",
  });
  const installedSkill = join(consumer, ".agents", "skills", "music", "SKILL.md");
  const installedSkillSource = readFileSync(installedSkill, "utf8");
  const workflowContracts = [
    "## ytdlp engine contract",
    "## Local library workbench",
    "--engine native",
    "shared cross-process database lock",
    "offline bulk workflows",
    "reference helper nor Rekordbox/JUCE/runtime bytes may enter a release artifact",
    "## 8. Serve and load connected CDJs",
    "Spotify streaming tracks cannot be LINK EXPORTed",
    "music djlink search <query>",
  ];
  if (workflowContracts.some((contract) => !installedSkillSource.includes(contract))) {
    throw new Error("Installed Music workflow skill is missing a safety contract");
  }
  const generatedSkills = [
    ["music-djlink", ["# music djlink doctor", "# music djlink load", "# music djlink search"]],
    ["music-library", ["# music library serve"]],
    ["music-tracks", ["# music tracks resolve"]],
    ["music-spots", ["# music spots api search"]],
    ["music-soundcloud", ["# music soundcloud resolve"]],
    ["music-slsk", ["# music slsk download"]],
    ["music-ytdlp-ts", ["# music ytdlp-ts download"]],
    [
      "music-rekordbox",
      [
        "# music rekordbox db playlist create",
        "# music rekordbox db playlist list",
        "# music rekordbox db playlist show",
      ],
    ],
  ];
  for (const [skill, commands] of generatedSkills) {
    const source = readFileSync(join(consumer, ".agents", "skills", skill, "SKILL.md"), "utf8");
    if (
      !source.includes("requires_bin: music") ||
      commands.some((command) => !source.includes(command))
    )
      throw new Error(`Installed ${skill} skill is missing generated Incur command metadata`);
  }
  process.stdout.write("✓ music skills add --no-global\n");

  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'await Promise.all(["@gakonst/music", "@gakonst/music/djlink", "@gakonst/music/library", "@gakonst/music/mcp", "@gakonst/music/tracks", "@gakonst/music/spots", "@gakonst/music/soundcloud", "@gakonst/music/slsk", "@gakonst/music/ytdlp", "@gakonst/music/rekordbox", "@gakonst/djlink", "@gakonst/djlink/cli", "@gakonst/rekordbox-library", "@gakonst/rekordbox-library/cli", "@gakonst/tracks/cli", "@gakonst/spots/cli", "@gakonst/soundcloud/cli", "slsk-ts/cli", "@gakonst/ytdlp-ts/cli", "@gakonst/rekordbox/cli"].map((specifier) => import(specifier)))',
    ],
    { cwd: consumer, stdio: "ignore" },
  );
  process.stdout.write("✓ @gakonst/music exports\n");

  const installedRekordbox = join(consumer, "node_modules", "@gakonst", "rekordbox");
  const rekordbox = join(consumer, "node_modules", ".bin", "rekordbox");
  const installedRekordboxManifest = JSON.parse(
    readFileSync(join(installedRekordbox, "package.json"), "utf8"),
  );
  const forbiddenRekordboxPayloads = [
    join(installedRekordbox, "vendor"),
    join(consumer, "node_modules", ".bin", "rekordbox-analyzer"),
  ];
  if (
    installedRekordboxManifest.bin?.["rekordbox-analyzer"] ||
    forbiddenRekordboxPayloads.some((path) => existsSync(path))
  ) {
    throw new Error("Packed Rekordbox package exposed a private analyzer helper or vendor runtime");
  }
  process.stdout.write("✓ packed Rekordbox excludes private analyzer payloads\n");

  const playlistFixture = join(consumer, "playlist.db");
  createPlaylistFixture(playlistFixture, installedRekordbox);
  const playlistListJson = run(
    rekordbox,
    ["db", "playlist", "list", "--path", playlistFixture, "--plain", "--json"],
    { cwd: consumer, stdio: ["ignore", "pipe", "pipe"] },
  );
  const playlistListResult = JSON.parse(playlistListJson.stdout);
  if (
    playlistListResult?.summary?.total !== 2 ||
    playlistListResult?.entries?.length !== 2 ||
    playlistListResult.entries[1]?.id !== "playlist-1" ||
    playlistListResult.entries[1]?.path !== "Packed Sets › Packed Festival Set" ||
    playlistListResult.entries[1]?.trackCount !== 1
  ) {
    throw new Error("Packed Rekordbox CLI did not list the fixture playlist hierarchy as JSON");
  }
  const playlistListTable = run(
    music,
    ["rekordbox", "db", "playlist", "list", "--path", playlistFixture, "--plain"],
    { cwd: consumer, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (
    !playlistListTable.stdout.includes("| path") ||
    !playlistListTable.stdout.includes("Packed Sets › Packed Festival Set")
  ) {
    throw new Error("Packed music CLI did not render the fixture playlist hierarchy table");
  }
  const playlistJson = run(
    rekordbox,
    [
      "db",
      "playlist",
      "show",
      "Packed Festival Set",
      "--path",
      playlistFixture,
      "--plain",
      "--json",
    ],
    { cwd: consumer, stdio: ["ignore", "pipe", "pipe"] },
  );
  const playlistResult = JSON.parse(playlistJson.stdout);
  if (
    playlistResult?.playlist?.id !== "playlist-1" ||
    playlistResult?.tracks?.length !== 1 ||
    playlistResult.tracks[0]?.title !== "Packed Track"
  ) {
    throw new Error("Packed Rekordbox CLI did not return the fixture playlist as JSON");
  }
  const playlistTable = run(
    music,
    [
      "rekordbox",
      "db",
      "playlist",
      "show",
      "Packed Festival Set",
      "--path",
      playlistFixture,
      "--plain",
    ],
    { cwd: consumer, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (
    !playlistTable.stdout.includes("| position | artist") ||
    !playlistTable.stdout.includes("Packed Track")
  ) {
    throw new Error("Packed music CLI did not render the fixture playlist table");
  }
  process.stdout.write("✓ packed Rekordbox playlist JSON and table\n");

  const mcpDiscoveryInput = [
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
  const mcpInput = [
    ...mcpDiscoveryInput,
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "rekordbox_db_playlist_show",
        arguments: {
          name: "Packed Festival Set",
          path: playlistFixture,
          plain: true,
        },
      },
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "rekordbox_db_playlist_list",
        arguments: {
          path: playlistFixture,
          plain: true,
        },
      },
    },
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
  const requiredTools = [
    "djlink_devices",
    "djlink_doctor",
    "djlink_load",
    "djlink_monitor",
    "djlink_search",
    "djlink_start",
    "djlink_status",
    "djlink_stop",
    "library_status",
    "soundcloud_playlist_create",
    "soundcloud_playlist_delete",
    "soundcloud_playlist_get",
    "soundcloud_playlist_update",
    "spots_playlist_create",
    "spots_playlist_delete",
    "spots_playlist_get",
    "spots_playlist_update",
    "rekordbox_db_playlist_list",
    "rekordbox_db_playlist_show",
  ];
  const toolNames = new Set(tools?.map((tool) => tool.name));
  const playlistListTool = tools?.find((tool) => tool.name === "rekordbox_db_playlist_list");
  const playlistShowTool = tools?.find((tool) => tool.name === "rekordbox_db_playlist_show");
  const playlistListCall = responses.find((response) => response.id === 4)?.result;
  const playlistShowCall = responses.find((response) => response.id === 3)?.result;
  if (
    initialize?.result?.serverInfo?.name !== "music" ||
    !tools ||
    tools?.length < 50 ||
    !tools.some((tool) => tool.name === "slsk_download") ||
    !tools.some((tool) => tool.name === "rekordbox_db_playlist_create") ||
    requiredTools.some((name) => !toolNames.has(name)) ||
    playlistListTool?.inputSchema?.properties?.path?.type !== "string" ||
    playlistListTool?.outputSchema?.properties?.summary?.type !== "object" ||
    playlistListTool?.outputSchema?.properties?.entries?.type !== "array" ||
    playlistShowTool?.inputSchema?.properties?.name?.type !== "string" ||
    !playlistShowTool?.inputSchema?.required?.includes("name") ||
    playlistShowTool?.outputSchema?.properties?.playlist?.type !== "object" ||
    playlistShowTool?.outputSchema?.properties?.tracks?.type !== "array" ||
    playlistShowCall?.isError ||
    playlistShowCall?.structuredContent?.playlist?.id !== "playlist-1" ||
    playlistShowCall?.structuredContent?.tracks?.[0]?.title !== "Packed Track" ||
    playlistListCall?.isError ||
    playlistListCall?.structuredContent?.summary?.total !== 2 ||
    playlistListCall?.structuredContent?.entries?.[1]?.id !== "playlist-1" ||
    playlistListCall?.structuredContent?.entries?.[1]?.trackCount !== 1
  ) {
    throw new Error("Packed music MCP did not initialize with the composable tool surface");
  }
  process.stdout.write(`✓ music stdio MCP (${tools.length} composable tools)\n`);

  const codeMcp = run(music, ["--codemode-mcp"], {
    cwd: consumer,
    input: `${[
      ...mcpDiscoveryInput,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "code",
          arguments: {
            code: "async () => codemode.rekordbox_status({})",
          },
        },
      },
    ]
      .map((request) => JSON.stringify(request))
      .join("\n")}\n`,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const codeResponses = codeMcp.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const codeTools = codeResponses.find((response) => response.id === 2)?.result?.tools;
  const codeCall = codeResponses.find((response) => response.id === 3)?.result;
  const codeResult = JSON.parse(codeCall?.content?.[0]?.text ?? "null");
  if (
    codeTools?.length !== 1 ||
    codeTools[0]?.name !== "code" ||
    typeof codeResult?.runtime !== "string"
  ) {
    throw new Error("Packed music CodeMode MCP did not execute in the local sandbox");
  }
  process.stdout.write("✓ music local CodeMode MCP (1 sandboxed tool)\n");
} finally {
  if (!suppliedPackDirectory) rmSync(packDirectory, { recursive: true, force: true });
}
