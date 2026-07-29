import { readFileSync } from "node:fs";

import { Cli } from "incur";
import { z } from "zod";

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
    "Publish an immutable CDJ-compatible disk image through a battery-powered Linux USB gadget.",
  hint: "Use doctor first. Publish is only allowed while detached; attach always exposes the active image read-only. The kernel serves blocks after the command exits.",
  mcp: {
    instructions:
      "Treat the front-deck USB boundary as read-only block storage, not DJ Link. Never publish while configured. Before detach, require the user to eject or press USB STOP on the physical deck and pass --confirm-host-ejected. A successful attach means only that Linux bound the mass-storage gadget; validate enumeration and browsing on the target deck separately.",
  },
  sync: {
    suggestions: [
      "check whether this Linux board can act as a USB drive",
      "show the active CDJ USB image and deck connection",
      "publish a prepared Rekordbox USB image",
      "attach the active image to the deck",
      "detach the USB image after I eject it on the deck",
    ],
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

function scopedCommand(displayName: string, command: string): string {
  const binary = displayName.trim().split(/[/\\]/u).at(-1);
  return binary === "usb" ? command : `usb ${command}`;
}

export default cdjUsbCli;
