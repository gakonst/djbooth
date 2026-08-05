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
  : mkdtempSync(join(tmpdir(), "djbooth-ts-packs-"));

const packages = [
  { name: "@gakonst/djbooth", prefix: "gakonst-djbooth-", bins: ["djbooth", "music"] },
  {
    name: "@gakonst/djlink",
    prefix: "gakonst-djlink-",
    bins: ["djlink", "djbooth-rs"],
  },
  {
    name: "@gakonst/cdj-usb",
    prefix: "gakonst-cdj-usb-",
    bins: ["cdj-usb"],
  },
  {
    name: "@gakonst/djbooth-app",
    prefix: "gakonst-djbooth-app-",
    bins: ["djbooth-app"],
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
        'content-1', '/djbooth.ai/Packed.flac', 'Packed Track', 'artist-1', 12801, 'key-1', 165, 5, 105
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
        name: "djbooth-ts-pack-smoke",
        private: true,
        dependencies,
        pnpm: {
          onlyBuiltDependencies: ["better-sqlite3-multiple-ciphers"],
          overrides: Object.fromEntries(
            Object.entries(dependencies).filter(([name]) => name !== "@gakonst/djbooth"),
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

  const djbooth = join(consumer, "node_modules", ".bin", "djbooth");
  const statusHelp = run(djbooth, ["status", "--help"], {
    cwd: consumer,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!statusHelp.stdout.includes("djbooth status") || !statusHelp.stdout.includes("--path")) {
    throw new Error("Packed djbooth CLI did not expose direct library status");
  }
  const serveHelp = run(djbooth, ["serve", "--help"], {
    cwd: consumer,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!serveHelp.stdout.includes("Pro DJ Link") || !serveHelp.stdout.includes("--assistant")) {
    throw new Error("Packed djbooth CLI did not expose the combined workbench runtime");
  }
  process.stdout.write("✓ djbooth status/serve direct commands\n");

  const djlinkHelp = run(djbooth, ["link", "--help"], {
    cwd: consumer,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (
    !djlinkHelp.stdout.includes("djbooth link [track]") ||
    !djlinkHelp.stdout.includes("start/resume") ||
    !djlinkHelp.stdout.includes("--player")
  ) {
    throw new Error("Packed djbooth CLI did not expose direct DJ Link serving");
  }
  process.stdout.write("✓ djbooth link direct command\n");

  const usbHelp = run(djbooth, ["usb", "--help"], {
    cwd: consumer,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (
    !usbHelp.stdout.includes("djbooth usb <target>") ||
    !usbHelp.stdout.includes("--database") ||
    !usbHelp.stdout.includes("--playlist-folder")
  ) {
    throw new Error("Packed djbooth CLI did not expose direct CDJ USB synchronization");
  }
  process.stdout.write("✓ djbooth usb direct command\n");

  const stemsHelp = run(djbooth, ["stems", "--help"], {
    cwd: consumer,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (
    !stemsHelp.stdout.includes("djbooth stems <track>") ||
    !stemsHelp.stdout.includes("--layout") ||
    !stemsHelp.stdout.includes("--output-directory")
  ) {
    throw new Error("Packed djbooth CLI did not expose library-resolved stem separation");
  }
  process.stdout.write("✓ djbooth stems library command\n");

  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'await Promise.all(["@gakonst/djbooth", "@gakonst/djbooth/djlink", "@gakonst/djbooth/usb", "@gakonst/djbooth/library", "@gakonst/djbooth/mcp", "@gakonst/djbooth/tracks", "@gakonst/djbooth/spots", "@gakonst/djbooth/soundcloud", "@gakonst/djbooth/slsk", "@gakonst/djbooth/ytdlp", "@gakonst/djbooth/rekordbox", "@gakonst/djlink", "@gakonst/djlink/cli", "@gakonst/cdj-usb", "@gakonst/cdj-usb/cli", "@gakonst/djbooth-app", "@gakonst/djbooth-app/cli", "@gakonst/tracks/cli", "@gakonst/spots/cli", "@gakonst/soundcloud/cli", "slsk-ts/cli", "@gakonst/ytdlp-ts/cli", "@gakonst/rekordbox/cli", "@gakonst/rekordbox/devicelib"].map((specifier) => import(specifier)))',
    ],
    { cwd: consumer, stdio: "ignore" },
  );
  process.stdout.write("✓ @gakonst/djbooth exports\n");

  const installedRekordbox = join(consumer, "node_modules", "@gakonst", "rekordbox");
  const rekordbox = join(consumer, "node_modules", ".bin", "rekordbox");
  const installedRekordboxManifest = JSON.parse(
    readFileSync(join(installedRekordbox, "package.json"), "utf8"),
  );
  const forbiddenRekordboxPayloads = [
    join(installedRekordbox, "vendor"),
    join(consumer, "node_modules", ".bin", "djbooth-analyzer"),
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
    rekordbox,
    ["db", "playlist", "list", "--path", playlistFixture, "--plain"],
    { cwd: consumer, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (
    !playlistListTable.stdout.includes("| path") ||
    !playlistListTable.stdout.includes("Packed Sets › Packed Festival Set")
  ) {
    throw new Error("Packed Rekordbox CLI did not render the fixture playlist hierarchy table");
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
    rekordbox,
    ["db", "playlist", "show", "Packed Festival Set", "--path", playlistFixture, "--plain"],
    { cwd: consumer, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (
    !playlistTable.stdout.includes("| position | artist") ||
    !playlistTable.stdout.includes("Packed Track")
  ) {
    throw new Error("Packed Rekordbox CLI did not render the fixture playlist table");
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
        clientInfo: { name: "djbooth-ts-pack-smoke", version: "1.0.0" },
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
        name: "ytdlp-ts_engines",
        arguments: {},
      },
    },
  ];
  const mcp = run(djbooth, ["--mcp"], {
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
    "analyze",
    "download",
    "enrich",
    "import",
    "link",
    "resolve",
    "soundcloud_playlist_create",
    "soundcloud_playlist_delete",
    "soundcloud_playlist_get",
    "soundcloud_playlist_update",
    "spots_playlist_create",
    "spots_playlist_delete",
    "spots_playlist_get",
    "spots_playlist_update",
    "status",
    "stems",
    "usb",
    "ytdlp-ts_engines",
  ];
  const toolNames = new Set(tools?.map((tool) => tool.name));
  const resolveTool = tools?.find((tool) => tool.name === "resolve");
  const usbTool = tools?.find((tool) => tool.name === "usb");
  const enginesCall = responses.find((response) => response.id === 3)?.result;
  const enginesResult = JSON.parse(enginesCall?.content?.[0]?.text ?? "null");
  if (
    initialize?.result?.serverInfo?.name !== "djbooth" ||
    !tools ||
    tools?.length < 30 ||
    !tools.some((tool) => tool.name === "slsk_download") ||
    requiredTools.some((name) => !toolNames.has(name)) ||
    resolveTool?.inputSchema?.properties?.source?.type !== "string" ||
    !resolveTool?.inputSchema?.required?.includes("source") ||
    usbTool?.inputSchema?.properties?.target?.type !== "string" ||
    !usbTool?.inputSchema?.required?.includes("target") ||
    enginesCall?.isError ||
    enginesResult?.native?.available !== true
  ) {
    throw new Error("Packed djbooth MCP did not initialize with the composable tool surface");
  }
  process.stdout.write(`✓ djbooth stdio MCP (${tools.length} composable tools)\n`);

  const codeMcp = run(djbooth, ["--codemode-mcp"], {
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
            code: 'async () => codemode["ytdlp-ts_engines"]({})',
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
    codeResult?.native?.available !== true
  ) {
    throw new Error("Packed djbooth CodeMode MCP did not execute in the local sandbox");
  }
  process.stdout.write("✓ djbooth local CodeMode MCP (1 sandboxed tool)\n");
} finally {
  if (!suppliedPackDirectory) rmSync(packDirectory, { recursive: true, force: true });
}
