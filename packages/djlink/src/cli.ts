import { readFileSync } from "node:fs";

import { Cli } from "incur";
import { z } from "zod";

import {
  browseRekordboxDjLink,
  DjLinkError,
  doctorDjLink,
  doctorRekordboxDjLink,
  listDjLinkDevices,
  loadDjLinkTrack,
  monitorDjLink,
  prepareDjLinkTrack,
  probeDjLinkDevice,
  runDjLink,
  runRekordboxDjLink,
  searchDjLink,
  startDjLink,
  statusDjLink,
  stopDjLink,
} from "./runtime.js";

export const DJLINK_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

const omittedEntryOutput = z.object({
  order: z.number().int().positive(),
  reason: z.string(),
});

const rekordboxReportOutput = z.object({
  databasePath: z.string(),
  databaseTracks: z.number().int().nonnegative(),
  servedTracks: z.number().int().nonnegative(),
  playlists: z.number().int().nonnegative(),
  folders: z.number().int().nonnegative(),
  omittedMissingAudio: z.object({
    count: z.number().int().nonnegative(),
    sample: z.array(z.string()),
  }),
  omittedInvalidTrackIds: z.number().int().nonnegative(),
});

const doctorOutput = z.object({
  ok: z.boolean(),
  binaryPath: z.string(),
  sourceKind: z.enum(["manifest", "rekordbox"]),
  sourcePath: z.string(),
  tracks: z.number().int().nonnegative(),
  playlists: z.number().int().nonnegative(),
  analysis: z.object({
    dat: z.number().int().nonnegative(),
    ext: z.number().int().nonnegative(),
    twoEx: z.number().int().nonnegative(),
  }),
  missingAudio: z.array(z.string()),
  missingAnalysis: z.array(z.string()),
  omittedEntries: z.array(omittedEntryOutput),
  rekordbox: rekordboxReportOutput.optional(),
});

const runningOutput = z.object({
  running: z.literal(true),
  pid: z.number().int().positive(),
  sourceKind: z.enum(["manifest", "rekordbox"]),
  sourcePath: z.string(),
  snapshotPath: z.string().optional(),
  socketPath: z.string(),
  logPath: z.string(),
  bindIp: z.string(),
  broadcastIp: z.string(),
  playerNumber: z.number().int().min(1).max(19),
  tracks: z.number().int().nonnegative(),
  playlists: z.number().int().nonnegative(),
  uptimeMs: z.number().nonnegative(),
  remoteTransportSupported: z.literal(false),
  remoteDeckPreparationSupported: z.boolean(),
});

const statusOutput = z.union([
  runningOutput,
  z.object({ running: z.literal(false), staleState: z.boolean() }),
]);

const deviceOutput = z.object({
  playerNumber: z.number().int().min(1).max(19),
  ip: z.string(),
  mac: z.string(),
  model: z.string(),
  lastSeenMsAgo: z.number().nonnegative(),
});

const loadOutput = z.object({
  player: z.number().int(),
  trackId: z.number().int().positive(),
  order: z.number().int().positive(),
  title: z.string(),
  artist: z.string(),
  packetsSent: z.number().int().positive(),
  loaded: z.literal(true),
  playing: z.literal(false),
  transportNote: z.string(),
});

const prepareOutput = loadOutput.extend({
  cue: z.object({
    kind: z.literal("before-chorus"),
    phraseBeat: z.number().int().positive(),
    cueBeat: z.number().int().positive(),
    cueMs: z.number().int().nonnegative(),
    barsBefore: z.number().int().nonnegative(),
  }),
  tempoBpm: z.number().min(40).max(300),
  tempoSyncRequested: z.literal(true),
  tempoConfirmed: z.boolean(),
});

const searchOutput = z.object({
  query: z.string(),
  mode: z.enum(["track", "artist", "album"]),
  normalizedQuery: z.string(),
  resultCount: z.number().int().nonnegative(),
  elapsedUs: z.number().nonnegative(),
  items: z.array(
    z.object({
      entryId: z.number().int().nonnegative(),
      entryType: z.number().int().nonnegative(),
      label: z.string(),
    }),
  ),
  truncated: z.boolean(),
});

const browseOutput = z.object({
  doctor: doctorOutput,
  server: runningOutput.extend({ resumed: z.boolean() }),
  devices: z.array(deviceOutput),
});

export const djlinkCli = Cli.create("djlink", {
  version: DJLINK_VERSION,
  description:
    "Serve compatible master.db content or acquired djbooth recordings to CDJs over Pro DJ Link.",
  hint: "Start the full browsable library: music djlink rekordbox. Add a track selector to validate, start, discover, and cue it in one shot. PLAY stays physical.",
  mcp: {
    instructions:
      "Use rekordbox with no positional track to expose the complete auto-discovered master.db hierarchy directly and read-only. Use rekordbox <track> for a one-shot database-to-deck cue. Use run <manifest> <track> for newly acquired ad-hoc recordings not yet imported. Use search <query> to verify the exact prewarmed RemoteDB matcher and row builder independently from CDJ Search UI activation. After a passing preflight, inspect TCP/1051: CDJ-3000 keyboard edits emit incremental 0x1500; legacy players may emit 0x1300. A reconnect after every keystroke means the server rejected Search; no request means the deck never activated it. The native daemon prewarms metadata and playlist membership, serves local audio plus ANLZ, and never streams Spotify audio. If an active interface yields no announcements, probe a known deck IP before changing protocol code. Loading does not start transport because CDJ-3000 remote play/pause is not a confirmed safe DJ Link command.",
  },
  sync: {
    suggestions: [
      "serve my complete Rekordbox library to the connected CDJs",
      "start the full library and cue one existing Rekordbox track",
      "serve my completed DJ set manifest to the connected CDJs",
      "validate, serve, discover, and cue one local track in one run",
      "show the CDJs on my Pro DJ Link network",
      "check whether a known deck IP is physically present",
      "load track 4 from this manifest onto player 3",
      "verify that the running CDJ source can search for a track",
      "show live telemetry for CDJ player 3",
      "stop the music DJ Link source",
    ],
  },
});

djlinkCli.command("rekordbox", {
  description:
    "Validate and serve the complete read-only master.db library; verify discovery and optionally cue one track.",
  hint: "No track argument performs validate → start/resume → discover and exposes folders, playlists, artists, albums, and tracks. A track adds resolve → cue. One command either returns visible decks or a network CTA.",
  args: z.object({
    track: z
      .string()
      .min(1)
      .optional()
      .describe("Optional Rekordbox content ID, exact title, artist-title, or unique substring"),
  }),
  options: z.object({
    allowMissingAnalysis: z
      .boolean()
      .default(true)
      .describe("Permit served tracks without complete Rekordbox analysis"),
    binary: z.string().optional().describe("Native djbooth-rs helper override"),
    bindIp: z.string().optional().describe("DJ Link interface IPv4 address; auto-detected"),
    broadcastIp: z.string().optional().describe("DJ Link broadcast IPv4 address; auto-derived"),
    intervalMs: z.number().int().min(10).max(5_000).default(250),
    name: z.string().min(1).default("music").describe("Source name shown on the CDJ"),
    path: z.string().optional().describe("master.db path; defaults to auto-discovery"),
    player: z.number().int().min(1).max(6).default(3).describe("Target CDJ player number"),
    playerNumber: z
      .number()
      .int()
      .min(1)
      .max(19)
      .default(17)
      .describe("Virtual Rekordbox player number"),
    repeat: z
      .number()
      .int()
      .min(1)
      .max(5)
      .default(3)
      .describe("Bounded load phases: default packet, target context, then one context retry"),
    waitMs: z
      .number()
      .int()
      .min(0)
      .max(30_000)
      .default(5_000)
      .describe("Wait this long for device announcements"),
  }),
  output: z.union([
    browseOutput,
    z.object({
      ...browseOutput.shape,
      load: loadOutput,
    }),
  ]),
  async run(c) {
    try {
      const common = {
        databasePath: c.options.path,
        allowMissingAnalysis: c.options.allowMissingAnalysis,
        binaryPath: c.options.binary,
        bindIp: c.options.bindIp,
        broadcastIp: c.options.broadcastIp,
        name: c.options.name,
        playerNumber: c.options.playerNumber,
      };
      if (!c.args.track) {
        return await browseRekordboxDjLink({
          ...common,
          waitMs: c.options.waitMs,
        });
      }
      return await runRekordboxDjLink({
        ...common,
        selector: c.args.track,
        player: c.options.player,
        waitMs: c.options.waitMs,
        repeat: c.options.repeat,
        intervalMs: c.options.intervalMs,
      });
    } catch (error) {
      return fail(c, error);
    }
  },
});

djlinkCli.command("doctor-rekordbox", {
  description:
    "Validate direct read-only master.db ingestion, local audio, playlists, and Rekordbox analysis.",
  options: z.object({
    allowMissingAnalysis: z.boolean().default(false),
    binary: z.string().optional().describe("Native djbooth-rs helper override"),
    path: z.string().optional().describe("master.db path; defaults to auto-discovery"),
  }),
  output: doctorOutput,
  async run(c) {
    try {
      return await doctorRekordboxDjLink({
        databasePath: c.options.path,
        allowMissingAnalysis: c.options.allowMissingAnalysis,
        binaryPath: c.options.binary,
      });
    } catch (error) {
      return fail(c, error);
    }
  },
});

djlinkCli.command("run", {
  description:
    "Validate a completed manifest, start or resume its source, discover one CDJ, then load and cue a track.",
  hint: "This is the one-shot manifest-to-deck handoff. It never streams Spotify audio and never presses PLAY.",
  args: z.object({
    manifest: z.string().min(1).describe("Completed music tracks manifest"),
    track: z
      .string()
      .min(1)
      .describe("Manifest order, native track ID, Spotify ID, title, or artist-title"),
  }),
  options: z.object({
    allowMissingAnalysis: z
      .boolean()
      .default(false)
      .describe("Permit tracks without complete Rekordbox analysis"),
    binary: z.string().optional().describe("Native djbooth-rs helper override"),
    bindIp: z.string().optional().describe("DJ Link interface IPv4 address; auto-detected"),
    broadcastIp: z.string().optional().describe("DJ Link broadcast IPv4 address; auto-derived"),
    intervalMs: z.number().int().min(10).max(5_000).default(250),
    name: z.string().min(1).default("music").describe("Source name shown on the CDJ"),
    player: z.number().int().min(1).max(6).default(3).describe("Target CDJ player number"),
    playerNumber: z
      .number()
      .int()
      .min(1)
      .max(19)
      .default(17)
      .describe("Virtual Rekordbox player number"),
    repeat: z
      .number()
      .int()
      .min(1)
      .max(5)
      .default(3)
      .describe("Bounded load phases: default packet, target context, then one context retry"),
    waitMs: z
      .number()
      .int()
      .min(0)
      .max(30_000)
      .default(5_000)
      .describe("Wait this long for device announcements"),
  }),
  output: z.object({
    doctor: doctorOutput,
    server: runningOutput.extend({ resumed: z.boolean() }),
    devices: z.array(deviceOutput),
    load: loadOutput,
  }),
  async run(c) {
    try {
      return await runDjLink({
        manifestPath: c.args.manifest,
        selector: c.args.track,
        player: c.options.player,
        waitMs: c.options.waitMs,
        repeat: c.options.repeat,
        intervalMs: c.options.intervalMs,
        allowMissingAnalysis: c.options.allowMissingAnalysis,
        binaryPath: c.options.binary,
        bindIp: c.options.bindIp,
        broadcastIp: c.options.broadcastIp,
        name: c.options.name,
        playerNumber: c.options.playerNumber,
      });
    } catch (error) {
      return fail(c, error, c.args.manifest);
    }
  },
});

djlinkCli.command("doctor", {
  description:
    "Validate the native runtime plus every local audio/ANLZ path projected from a tracks manifest.",
  args: z.object({
    manifest: z.string().min(1).describe("Completed music tracks manifest"),
  }),
  options: z.object({
    allowMissingAnalysis: z
      .boolean()
      .default(false)
      .describe("Permit tracks without complete Rekordbox analysis"),
    binary: z.string().optional().describe("Native djbooth-rs helper override"),
  }),
  output: doctorOutput,
  async run(c) {
    try {
      return await doctorDjLink({
        manifestPath: c.args.manifest,
        allowMissingAnalysis: c.options.allowMissingAnalysis,
        binaryPath: c.options.binary,
      });
    } catch (error) {
      return fail(c, error, c.args.manifest);
    }
  },
});

djlinkCli.command("start", {
  description: "Start one detached manifest-backed RemoteDB/NFS source for connected CDJs.",
  args: z.object({
    manifest: z.string().min(1).describe("Completed music tracks manifest"),
  }),
  options: z.object({
    allowMissingAnalysis: z
      .boolean()
      .default(false)
      .describe("Permit tracks without complete Rekordbox analysis"),
    binary: z.string().optional().describe("Native djbooth-rs helper override"),
    bindIp: z.string().optional().describe("DJ Link interface IPv4 address; auto-detected"),
    broadcastIp: z.string().optional().describe("DJ Link broadcast IPv4 address; auto-derived"),
    name: z.string().min(1).default("music").describe("Source name shown on the CDJ"),
    playerNumber: z
      .number()
      .int()
      .min(1)
      .max(19)
      .default(17)
      .describe("Virtual Rekordbox player number"),
  }),
  output: runningOutput.extend({ resumed: z.boolean() }),
  async run(c) {
    try {
      return await startDjLink({
        manifestPath: c.args.manifest,
        allowMissingAnalysis: c.options.allowMissingAnalysis,
        binaryPath: c.options.binary,
        bindIp: c.options.bindIp,
        broadcastIp: c.options.broadcastIp,
        name: c.options.name,
        playerNumber: c.options.playerNumber,
      });
    } catch (error) {
      return fail(c, error, c.args.manifest);
    }
  },
});

djlinkCli.command("status", {
  description: "Show whether the managed DJ Link source is running and what it serves.",
  output: statusOutput,
  async run() {
    return statusDjLink();
  },
});

djlinkCli.command("devices", {
  description: "Wait briefly, then list CDJs discovered by the running DJ Link source.",
  options: z.object({
    waitMs: z
      .number()
      .int()
      .min(0)
      .max(30_000)
      .default(2_000)
      .describe("Wait this long for the first device announcement"),
  }),
  output: z.object({ devices: z.array(deviceOutput) }),
  async run(c) {
    try {
      return await listDjLinkDevices({ waitMs: c.options.waitMs });
    } catch (error) {
      return fail(c, error);
    }
  },
});

djlinkCli.command("probe", {
  description:
    "Send one safe ARP request on the selected DJ Link interface to test a known deck address.",
  args: z.object({
    ip: z.string().min(7).describe("Known deck IPv4 address"),
  }),
  options: z.object({
    timeoutMs: z.number().int().min(50).max(3_000).default(750).describe("ARP reply timeout"),
  }),
  output: z.object({
    ip: z.string(),
    present: z.boolean(),
    mac: z.string().nullable(),
    timeoutMs: z.number().int(),
  }),
  async run(c) {
    try {
      return await probeDjLinkDevice({
        ip: c.args.ip,
        timeoutMs: c.options.timeoutMs,
      });
    } catch (error) {
      return fail(c, error);
    }
  },
});

djlinkCli.command("load", {
  description:
    "Resolve, load, and cue one track from the running Rekordbox or manifest source; deck PLAY remains physical.",
  args: z.object({
    track: z
      .string()
      .min(1)
      .describe("Content/track ID, manifest order, Spotify ID, title, or artist-title"),
  }),
  options: z.object({
    intervalMs: z.number().int().min(10).max(5_000).default(250),
    player: z.number().int().min(1).max(6).default(3).describe("Target CDJ player number"),
    repeat: z
      .number()
      .int()
      .min(1)
      .max(5)
      .default(3)
      .describe("Bounded load phases: default packet, target context, then one context retry"),
  }),
  output: loadOutput,
  async run(c) {
    try {
      return await loadDjLinkTrack({
        selector: c.args.track,
        player: c.options.player,
        repeat: c.options.repeat,
        intervalMs: c.options.intervalMs,
      });
    } catch (error) {
      return fail(c, error);
    }
  },
});

djlinkCli.command("prepare", {
  description:
    "Load a track, cue before its first Rekordbox-analyzed chorus, and set deck tempo with DJ Link Sync; PLAY remains physical.",
  args: z.object({
    track: z
      .string()
      .min(1)
      .describe("Content/track ID, manifest order, Spotify ID, title, or artist-title"),
  }),
  options: z.object({
    barsBefore: z
      .number()
      .int()
      .min(0)
      .max(32)
      .default(1)
      .describe("Beat-grid bars before the first chorus"),
    bpm: z.number().min(40).max(300).describe("Target deck BPM"),
    intervalMs: z.number().int().min(10).max(5_000).default(250),
    player: z.number().int().min(1).max(6).default(3).describe("Target CDJ player number"),
    repeat: z.number().int().min(1).max(5).default(3),
  }),
  output: prepareOutput,
  async run(c) {
    try {
      return await prepareDjLinkTrack({
        selector: c.args.track,
        player: c.options.player,
        bpm: c.options.bpm,
        barsBefore: c.options.barsBefore,
        repeat: c.options.repeat,
        intervalMs: c.options.intervalMs,
      });
    } catch (error) {
      return fail(c, error);
    }
  },
});

djlinkCli.command("search", {
  description:
    "Search the running source's prewarmed RemoteDB library without changing deck or library state.",
  hint: "Preflight first, then inspect TCP/1051: CDJ-3000 keyboard edits use 0x1500; legacy Search uses 0x1300. Per-keystroke reconnects mean rejection; neither request means CDJ Search UI activation failed.",
  args: z.object({
    query: z.string().min(1).describe("Track, artist, or album text"),
  }),
  options: z.object({
    limit: z.number().int().min(1).max(100).default(20).describe("Maximum returned rows"),
    mode: z.enum(["track", "artist", "album"]).default("track").describe("CDJ search category"),
  }),
  output: searchOutput,
  async run(c) {
    try {
      return await searchDjLink({
        query: c.args.query,
        mode: c.options.mode,
        limit: c.options.limit,
      });
    } catch (error) {
      return fail(c, error);
    }
  },
});

djlinkCli.command("monitor", {
  description: "Read the latest compact status, beat, and position telemetry for one CDJ.",
  options: z.object({
    player: z.number().int().min(1).max(6).default(3),
  }),
  output: z.object({
    player: z.number().int(),
    status: z.string().nullable(),
    beat: z.string().nullable(),
    position: z.string().nullable(),
  }),
  async run(c) {
    try {
      return await monitorDjLink(c.options.player);
    } catch (error) {
      return fail(c, error);
    }
  },
});

djlinkCli.command("stop", {
  description: "Stop the exact managed DJ Link runtime and release its network ports.",
  output: z.object({
    stopped: z.boolean(),
    wasRunning: z.boolean(),
    pid: z.number().int().positive().optional(),
  }),
  async run(c) {
    try {
      return await stopDjLink();
    } catch (error) {
      return fail(c, error);
    }
  },
});

function fail(
  context: {
    displayName: string;
    error(options: {
      code: string;
      exitCode?: number;
      message: string;
      retryable?: boolean;
      cta?: {
        description?: string;
        commands: Array<string | { command: string; description?: string }>;
      };
    }): never;
  },
  error: unknown,
  manifest?: string,
): never {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof DjLinkError ? `DJLINK_${error.code}` : "DJLINK_ERROR";
  const commands: Array<string | { command: string; description?: string }> = [];
  if (error instanceof DjLinkError && error.code === "NATIVE_MISSING") {
    commands.push({
      command: scopedCommand(context.displayName, "--help"),
      description:
        "inspect DJ Link; source checkouts build the helper with pnpm --filter @gakonst/djlink native:build",
    });
  } else if (error instanceof DjLinkError && error.code === "NOT_RUNNING") {
    commands.push(
      scopedCommand(context.displayName, manifest ? `start '${manifest}'` : "rekordbox"),
    );
  } else if (error instanceof DjLinkError && error.code === "ALREADY_RUNNING") {
    commands.push(
      {
        command: scopedCommand(context.displayName, "status"),
        description: "inspect the exact source and interface already running",
      },
      {
        command: scopedCommand(context.displayName, "stop"),
        description: "stop that source before switching libraries",
      },
    );
  } else if (error instanceof DjLinkError && error.code === "DEVICE_NOT_FOUND") {
    commands.push(
      {
        command: scopedCommand(context.displayName, "devices --wait-ms 5000"),
        description: "wait again for DJ Link announcements",
      },
      {
        command: scopedCommand(context.displayName, "probe --help"),
        description: "test a known deck IP with one safe ARP request",
      },
    );
  } else if (error instanceof DjLinkError && error.code === "CONTROL_FAILED") {
    commands.push(
      scopedCommand(context.displayName, "status"),
      scopedCommand(context.displayName, "devices --wait-ms 5000"),
    );
  } else {
    commands.push(
      scopedCommand(context.displayName, manifest ? `doctor '${manifest}'` : "doctor-rekordbox"),
    );
  }
  return context.error({
    code,
    message,
    retryable:
      error instanceof DjLinkError &&
      (error.code === "DEVICE_NOT_FOUND" ||
        error.code === "CONTROL_FAILED" ||
        error.code === "START_FAILED"),
    exitCode: 1,
    cta: {
      description:
        "Inspect the DJ Link runtime, direct library source, and network before retrying:",
      commands,
    },
  });
}

function scopedCommand(displayName: string, command: string): string {
  const binary = displayName.trim().split(/[/\\]/u).at(-1);
  return binary === "djlink" ? command : `djlink ${command}`;
}

export default djlinkCli;
