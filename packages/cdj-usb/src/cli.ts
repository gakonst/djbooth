import { readFileSync } from "node:fs";

import { Cli } from "incur";
import { z } from "zod";

import {
  exportLegacyDeviceLibrary,
  syncLegacyDeviceLibrary,
  syncLegacyDevicePlaylist,
} from "@gakonst/rekordbox/devicelib";

import {
  attachCdjUsb,
  CdjUsbError,
  detachCdjUsb,
  doctorCdjUsb,
  publishCdjUsbImage,
  runCdjUsb,
  statusCdjUsb,
} from "./runtime.js";

export const CDJ_USB_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

const activeImageOutput = z.object({
  schemaVersion: z.literal(1),
  generation: z.string(),
  path: z.string(),
  sha256: z.string(),
  bytes: z.number().int().positive(),
  publishedAtUnixMs: z.number().int().nonnegative(),
  hasBootSignature: z.boolean(),
});

const statusOutput = z.object({
  schemaVersion: z.literal(1),
  gadgetName: z.string(),
  configured: z.boolean(),
  attached: z.boolean(),
  safeToPublish: z.boolean(),
  udc: z.string().nullable(),
  hostState: z.string().nullable(),
  backingFile: z.string().nullable(),
  readOnly: z.boolean().nullable(),
  activeImage: activeImageOutput.nullable(),
});

const doctorOutput = z.object({
  ok: z.boolean(),
  checks: z.array(
    z.object({
      name: z.string(),
      ok: z.boolean(),
      required: z.boolean(),
      detail: z.string(),
    }),
  ),
  status: statusOutput,
});

const publishOutput = z.object({
  published: z.literal(true),
  reused: z.boolean(),
  activeImage: activeImageOutput,
});

const attachOutput = z.object({
  attached: z.literal(true),
  status: statusOutput,
});

const detachOutput = z.object({
  detached: z.boolean(),
  status: statusOutput,
});

const runOutput = z.object({
  publish: publishOutput,
  attach: attachOutput,
});

const exportOutput = z.object({
  schemaVersion: z.literal(1),
  format: z.literal("legacy-device-library"),
  databasePath: z.string(),
  targetDirectory: z.string(),
  pdbPath: z.string(),
  tracks: z.number().int().nonnegative(),
  playlists: z.number().int().nonnegative(),
  analysisFiles: z.number().int().nonnegative(),
  bytesCopied: z.number().int().nonnegative(),
  generatedAt: z.string(),
  changed: z.boolean(),
  tracksCopied: z.number().int().nonnegative(),
  tracksReused: z.number().int().nonnegative(),
  filesRemoved: z.number().int().nonnegative(),
});

const syncOutput = z.object({
  schemaVersion: z.literal(1),
  format: z.literal("legacy-device-library-sync"),
  databasePath: z.string(),
  targetDirectory: z.string(),
  historiesFound: z.number().int().nonnegative(),
  historiesImported: z.number().int().nonnegative(),
  historiesAlreadyImported: z.number().int().nonnegative(),
  playlistsCreated: z.array(
    z.object({
      historyId: z.number().int().nonnegative(),
      historyName: z.string(),
      playlistId: z.string(),
      playlistName: z.string(),
      tracks: z.number().int().nonnegative(),
    }),
  ),
  playCountIncrements: z.number().int().nonnegative(),
  backupDirectory: z.string().nullable(),
  export: exportOutput,
});

const playlistSyncOutput = z.object({
  schemaVersion: z.literal(1),
  format: z.literal("legacy-device-playlist-sync"),
  databasePath: z.string(),
  targetDirectory: z.string(),
  playlistId: z.string(),
  playlistName: z.string(),
  folderName: z.string(),
  usbFolderId: z.number().int().positive(),
  usbPlaylistId: z.number().int().positive(),
  tracks: z.number().int().positive(),
  audioFiles: z.number().int().nonnegative(),
  analysisFiles: z.number().int().nonnegative(),
  bytesCopied: z.number().int().nonnegative(),
  backupPath: z.string().nullable(),
  changed: z.boolean(),
});

const runtimeOptions = {
  binary: z.string().optional().describe("Native music-cdj-usb helper override"),
  configfsRoot: z
    .string()
    .optional()
    .describe("Linux configfs usb_gadget root; defaults to /sys/kernel/config/usb_gadget"),
  gadgetName: z.string().optional().describe("configfs gadget directory name"),
  stateDir: z
    .string()
    .optional()
    .describe("Immutable generation state; defaults to /var/lib/music-cdj-usb"),
  udcRoot: z
    .string()
    .optional()
    .describe("Linux USB device-controller sysfs root; defaults to /sys/class/udc"),
};

const identityOptions = {
  manufacturer: z.string().optional().describe("USB manufacturer string"),
  product: z.string().optional().describe("USB product string shown to the host"),
  serial: z.string().optional().describe("Stable USB serial; defaults to the board machine ID"),
  udc: z.string().optional().describe("Explicit USB device controller when multiple are present"),
};

export const cdjUsbCli = Cli.create("usb", {
  version: CDJ_USB_VERSION,
  description:
    "Keep CDJ-3000 front-USB media synchronized with Rekordbox and expose it through a Linux USB gadget.",
  hint: "Use sync for the normal round trip: import new CDJ histories as dated DJ Set playlists, update play counts once, then differentially reconcile tracks, playlists, audio, ANLZ, and export.pdb.",
  mcp: {
    instructions:
      "Use sync for mounted CDJ-3000 legacy Device Library media. It imports every unseen CDJ history into one dated normal playlist, increments play counts idempotently, then differentially makes the exporter-owned USB match master.db. It never uses Device Library Plus. Never sync media while a deck or USB gadget owns it.",
  },
  sync: {
    suggestions: [
      "sync my CDJ USB and import last night's set",
      "make my mounted CDJ USB match my Rekordbox library",
      "check whether this Linux board can act as a USB drive",
      "show the active CDJ USB image and deck connection",
      "attach the active image to the deck",
      "detach the USB image after I eject it on the deck",
    ],
  },
});

cdjUsbCli.command("export", {
  description:
    "Compile master.db into CDJ-3000 legacy export.pdb, copy audio, and rewrite ANLZ paths.",
  hint: "The target must be a mounted FAT/exFAT volume or staging directory. SQLite remains the source of truth. This command does not create Device Library Plus exportLibrary.db.",
  args: z.object({
    target: z.string().min(1).describe("Mounted CDJ media root or staging directory"),
  }),
  options: z.object({
    database: z
      .string()
      .optional()
      .describe("Rekordbox master.db; defaults to the configured Rekordbox library"),
    databaseKey: z.string().optional().describe("Optional SQLCipher key override"),
    plain: z.boolean().default(false).describe("Open an explicitly plain SQLite database"),
    replace: z
      .boolean()
      .default(false)
      .describe("Replace only a prior export carrying the music-ts ownership marker"),
    copyConcurrency: z
      .number()
      .int()
      .min(1)
      .max(32)
      .default(4)
      .describe("Parallel audio-copy workers"),
  }),
  output: exportOutput,
  async run(c) {
    try {
      return await exportLegacyDeviceLibrary({
        targetDirectory: c.args.target,
        databasePath: c.options.database,
        databaseKey: c.options.databaseKey,
        databaseUnlock: !c.options.plain,
        replace: c.options.replace,
        copyConcurrency: c.options.copyConcurrency,
      });
    } catch (error) {
      return failExport(c, error);
    }
  },
});

cdjUsbCli.command("sync", {
  description:
    "Import unseen CDJ histories, then differentially make mounted USB media match master.db.",
  hint: "This is the normal plug-in-and-go workflow. Each unseen history becomes DJ Set YYYY-MM-DD (with a suffix when needed), ordered duplicates are preserved, play counts advance exactly once, removed library tracks are removed from exporter-owned media, and unchanged audio is not recopied. Rekordbox must be closed.",
  args: z.object({
    target: z.string().min(1).describe("Mounted CDJ media root"),
  }),
  options: z.object({
    database: z
      .string()
      .optional()
      .describe("Rekordbox master.db; defaults to the configured Rekordbox library"),
    databaseKey: z.string().optional().describe("Optional SQLCipher key override"),
    plain: z.boolean().default(false).describe("Open an explicitly plain SQLite database"),
    backupRoot: z.string().optional().describe("Checksummed pre-write backup directory"),
    copyConcurrency: z
      .number()
      .int()
      .min(1)
      .max(32)
      .default(4)
      .describe("Parallel changed-media copy workers"),
    write: z
      .boolean()
      .default(false)
      .describe("Required acknowledgement for USB and master.db mutation"),
  }),
  output: syncOutput,
  async run(c) {
    try {
      return await syncLegacyDeviceLibrary({
        approved: c.options.write,
        targetDirectory: c.args.target,
        databasePath: c.options.database,
        databaseKey: c.options.databaseKey,
        databaseUnlock: !c.options.plain,
        backupRoot: c.options.backupRoot,
        copyConcurrency: c.options.copyConcurrency,
      });
    } catch (error) {
      return failSync(c, error);
    }
  },
});

cdjUsbCli.command("sync-playlist", {
  description: "Append one analyzed Rekordbox playlist to an existing mounted legacy USB export.",
  hint: "Use this for a Rekordbox-created stick that must retain its current library. Existing PDB rows remain intact; new audio and rewritten ANLZ are staged first, the old PDB is backed up, and the validated PDB is published last. Device Library Plus is not modified.",
  args: z.object({
    target: z.string().min(1).describe("Mounted CDJ media root"),
    playlist: z.string().min(1).describe("Exact normal Rekordbox playlist ID"),
  }),
  options: z.object({
    database: z
      .string()
      .optional()
      .describe("Rekordbox master.db; defaults to the configured Rekordbox library"),
    databaseKey: z.string().optional().describe("Optional SQLCipher key override"),
    plain: z.boolean().default(false).describe("Open an explicitly plain SQLite database"),
    write: z.boolean().default(false).describe("Required acknowledgement for USB mutation"),
  }),
  output: playlistSyncOutput,
  async run(c) {
    try {
      return await syncLegacyDevicePlaylist({
        approved: c.options.write,
        targetDirectory: c.args.target,
        playlistId: c.args.playlist,
        databasePath: c.options.database,
        databaseKey: c.options.databaseKey,
        databaseUnlock: !c.options.plain,
      });
    } catch (error) {
      return failSync(c, error);
    }
  },
});

cdjUsbCli.command("doctor", {
  description:
    "Inspect Linux, configfs, USB device controllers, image shape, and read-only gadget state.",
  args: z.object({
    image: z
      .string()
      .optional()
      .describe("Candidate block image; defaults to the active generation"),
  }),
  options: z.object(runtimeOptions),
  output: doctorOutput,
  async run(c) {
    try {
      return await doctorCdjUsb({
        ...toRuntimeOptions(c.options),
        imagePath: c.args.image,
      });
    } catch (error) {
      return fail(c, error);
    }
  },
});

cdjUsbCli.command("status", {
  description: "Show the immutable active generation and live Linux USB gadget state.",
  options: z.object(runtimeOptions),
  output: statusOutput,
  async run(c) {
    try {
      return await statusCdjUsb(toRuntimeOptions(c.options));
    } catch (error) {
      return fail(c, error);
    }
  },
});

cdjUsbCli.command("publish", {
  description:
    "Copy one 512-byte-aligned image into immutable storage and atomically activate it while detached.",
  hint: "This refuses to run while any gadget configuration still holds a backing file.",
  args: z.object({
    image: z.string().min(1).describe("Prepared CDJ-compatible disk image"),
  }),
  options: z.object(runtimeOptions),
  output: publishOutput,
  async run(c) {
    try {
      return await publishCdjUsbImage({
        ...toRuntimeOptions(c.options),
        imagePath: c.args.image,
      });
    } catch (error) {
      return fail(c, error);
    }
  },
});

cdjUsbCli.command("attach", {
  description:
    "Bind the immutable active generation read-only through the Linux mass-storage gadget.",
  hint: "The CDJ sees an ordinary USB drive. The Rust controller exits after binding; the Linux kernel continues serving it.",
  options: z.object({ ...runtimeOptions, ...identityOptions }),
  output: attachOutput,
  async run(c) {
    try {
      return await attachCdjUsb({
        ...toRuntimeOptions(c.options),
        manufacturer: c.options.manufacturer,
        product: c.options.product,
        serial: c.options.serial,
        udc: c.options.udc,
      });
    } catch (error) {
      return fail(c, error);
    }
  },
});

cdjUsbCli.command("detach", {
  description: "Unbind the gadget and release its backing image after the deck ejects it.",
  hint: "When a host is configured, this refuses unless --confirm-host-ejected records the physical USB STOP/eject step.",
  options: z.object({
    ...runtimeOptions,
    confirmHostEjected: z
      .boolean()
      .default(false)
      .describe("Confirm USB STOP/eject happened on the physical deck"),
  }),
  output: detachOutput,
  async run(c) {
    try {
      return await detachCdjUsb({
        ...toRuntimeOptions(c.options),
        confirmHostEjected: c.options.confirmHostEjected,
      });
    } catch (error) {
      return fail(c, error);
    }
  },
});

cdjUsbCli.command("run", {
  description:
    "Publish one prepared image and bind it read-only under one exclusive lifecycle lock.",
  hint: "Use this for first boot or a known-detached appliance. Later generations still require explicit detach → publish → attach.",
  args: z.object({
    image: z.string().min(1).describe("Prepared CDJ-compatible disk image"),
  }),
  options: z.object({ ...runtimeOptions, ...identityOptions }),
  output: runOutput,
  async run(c) {
    try {
      return await runCdjUsb({
        ...toRuntimeOptions(c.options),
        imagePath: c.args.image,
        manufacturer: c.options.manufacturer,
        product: c.options.product,
        serial: c.options.serial,
        udc: c.options.udc,
      });
    } catch (error) {
      return fail(c, error);
    }
  },
});

export async function runCdjUsbCli(argv = process.argv.slice(2)): Promise<void> {
  await cdjUsbCli.serve(argv);
}

function toRuntimeOptions(options: {
  binary?: string;
  configfsRoot?: string;
  gadgetName?: string;
  stateDir?: string;
  udcRoot?: string;
}) {
  return {
    binaryPath: options.binary,
    configfsRoot: options.configfsRoot,
    gadgetName: options.gadgetName,
    stateDir: options.stateDir,
    udcRoot: options.udcRoot,
  };
}

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
): never {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof CdjUsbError ? `CDJ_USB_${error.code}` : "CDJ_USB_ERROR";
  const commands: Array<string | { command: string; description?: string }> = [];
  if (error instanceof CdjUsbError && error.code === "NATIVE_MISSING") {
    commands.push({
      command: scopedCommand(context.displayName, "--help"),
      description:
        "inspect the package; source checkouts build the helper with pnpm --filter @gakonst/cdj-usb native:build",
    });
  } else if (message.includes("confirm-host-ejected")) {
    commands.push({
      command: scopedCommand(context.displayName, "detach --confirm-host-ejected"),
      description: "run only after USB STOP/eject on the physical deck",
    });
  } else if (message.includes("detach it before publishing")) {
    commands.push(
      scopedCommand(context.displayName, "status"),
      scopedCommand(context.displayName, "detach --help"),
    );
  } else if (message.includes("no active image")) {
    commands.push(scopedCommand(context.displayName, "publish --help"));
  } else {
    commands.push(scopedCommand(context.displayName, "doctor"));
  }
  return context.error({
    code,
    message,
    exitCode: 1,
    retryable: false,
    cta: {
      description: "Inspect the appliance state before changing the USB attachment:",
      commands,
    },
  });
}

function failExport(
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
): never {
  const message = error instanceof Error ? error.message : String(error);
  return context.error({
    code: "CDJ_USB_EXPORT_ERROR",
    message,
    exitCode: 1,
    retryable: false,
    cta: {
      description:
        "Check the read-only Rekordbox source, local audio/ANLZ files, and detached target media:",
      commands: [scopedCommand(context.displayName, "export --help")],
    },
  });
}

function failSync(
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
): never {
  const message = error instanceof Error ? error.message : String(error);
  return context.error({
    code: "CDJ_USB_SYNC_ERROR",
    message,
    exitCode: 1,
    retryable: false,
    cta: {
      description:
        "Close Rekordbox, ensure the deck has ejected the mounted media, and inspect the sync contract:",
      commands: [scopedCommand(context.displayName, "sync --help")],
    },
  });
}

function scopedCommand(displayName: string, command: string): string {
  const binary = displayName.trim().split(/[/\\]/u).at(-1);
  return binary === "usb" ? command : `usb ${command}`;
}

export default cdjUsbCli;
