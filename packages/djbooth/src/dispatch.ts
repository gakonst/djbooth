import { createDjBoothRoot } from "./root.js";

const directlyRoutableCommands = new Set([
  "analyze",
  "cloud",
  "download",
  "enrich",
  "import",
  "link",
  "pairing",
  "playlist",
  "produce",
  "resolve",
  "serve",
  "slsk",
  "soundcloud",
  "spots",
  "status",
  "stems",
  "stop",
  "usb",
  "ytdlp-ts",
]);

/** Whether one normal command can skip loading the complete discovery/MCP command graph. */
export function canDispatchDirectly(argv: readonly string[]): boolean {
  return argv.length > 0 && directlyRoutableCommands.has(argv[0]!);
}

/** Load only the package that owns the requested command, preserving the normal djbooth root. */
export async function runDirectDjBoothCommand(argv: string[]): Promise<void> {
  const cli = createDjBoothRoot();
  switch (argv[0]) {
    case "cloud":
      cli.command((await import("./cloud.js")).cloudCli);
      break;
    case "analyze":
      cli.command((await import("@gakonst/tracks/cli")).analyzeCli);
      break;
    case "download":
      cli.command((await import("@gakonst/tracks/cli")).downloadCli);
      break;
    case "enrich":
      cli.command((await import("@gakonst/tracks/cli")).enrichCli);
      break;
    case "import":
      cli.command((await import("@gakonst/tracks/cli")).importCli);
      break;
    case "resolve":
      cli.command((await import("@gakonst/tracks/cli")).resolveCli);
      break;
    case "link":
      cli.command((await import("@gakonst/djlink/cli")).linkCli);
      break;
    case "playlist":
      cli.command((await import("./playlist.js")).playlistCli);
      break;
    case "produce":
      cli.command((await import("./produce.js")).produceCli);
      break;
    case "serve":
      cli.command((await import("./serve.js")).serveCli);
      break;
    case "pairing":
      cli.command((await import("./serve.js")).pairingCli);
      break;
    case "status":
      cli.command((await import("./status.js")).statusCli);
      break;
    case "stop":
      cli.command((await import("./stop.js")).stopCli);
      break;
    case "stems":
      cli.command((await import("@gakonst/rekordbox/cli")).stemsCli);
      break;
    case "usb":
      cli.command((await import("@gakonst/cdj-usb/cli")).usbCli);
      break;
    case "slsk":
      cli.command((await import("slsk-ts/cli")).default);
      break;
    case "soundcloud":
      cli.command((await import("@gakonst/soundcloud/cli")).default);
      break;
    case "spots":
      cli.command((await import("@gakonst/spots/cli")).default);
      break;
    case "ytdlp-ts":
      cli.command((await import("@gakonst/ytdlp-ts/cli")).default);
      break;
    default:
      throw new TypeError(`Unsupported direct djbooth command '${argv[0] ?? ""}'`);
  }
  await cli.serve(argv);
}
