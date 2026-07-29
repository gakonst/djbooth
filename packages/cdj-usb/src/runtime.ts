import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import type {
  CdjUsbAttachResult,
  CdjUsbDetachResult,
  CdjUsbDoctorResult,
  CdjUsbPublishResult,
  CdjUsbRunResult,
  CdjUsbStatus,
} from "./types.js";

const MAX_NATIVE_OUTPUT_BYTES = 1_048_576;

const activeImageSchema = z.object({
  schemaVersion: z.literal(1),
  generation: z.string().min(1),
  path: z.string().min(1),
  sha256: z.string().regex(/^[\da-f]{64}$/u),
  bytes: z.number().int().positive(),
  publishedAtUnixMs: z.number().int().nonnegative(),
  hasBootSignature: z.boolean(),
});

const statusSchema = z.object({
  schemaVersion: z.literal(1),
  gadgetName: z.string().min(1),
  configured: z.boolean(),
  attached: z.boolean(),
  safeToPublish: z.boolean(),
  udc: z.string().nullable(),
  hostState: z.string().nullable(),
  backingFile: z.string().nullable(),
  readOnly: z.boolean().nullable(),
  activeImage: activeImageSchema.nullable(),
});

const doctorSchema = z.object({
  ok: z.boolean(),
  checks: z.array(
    z.object({
      name: z.string().min(1),
      ok: z.boolean(),
      required: z.boolean(),
      detail: z.string(),
    }),
  ),
  status: statusSchema,
});

const publishSchema = z.object({
  published: z.literal(true),
  reused: z.boolean(),
  activeImage: activeImageSchema,
});

const attachSchema = z.object({
  attached: z.literal(true),
  status: statusSchema,
});

const detachSchema = z.object({
  detached: z.boolean(),
  status: statusSchema,
});

const runSchema = z.object({
  publish: publishSchema,
  attach: attachSchema,
});

export type CdjUsbRuntimeOptions = {
  binaryPath?: string;
  stateDir?: string;
  configfsRoot?: string;
  udcRoot?: string;
  gadgetName?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

export type AttachCdjUsbOptions = CdjUsbRuntimeOptions & {
  udc?: string;
  serial?: string;
  manufacturer?: string;
  product?: string;
};

export type DetachCdjUsbOptions = CdjUsbRuntimeOptions & {
  confirmHostEjected?: boolean;
};

export type DoctorCdjUsbOptions = CdjUsbRuntimeOptions & {
  imagePath?: string;
};

export type PublishCdjUsbOptions = CdjUsbRuntimeOptions & {
  imagePath: string;
};

export type RunCdjUsbOptions = AttachCdjUsbOptions & {
  imagePath: string;
};

/** Typed native appliance failure. */
export class CdjUsbError extends Error {
  constructor(
    readonly code: "NATIVE_MISSING" | "NATIVE_FAILED" | "INVALID_OUTPUT" | "CANCELLED",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CdjUsbError";
  }
}

/** Inspect Linux/configfs, the active generation, and USB attachment without mutating them. */
export async function doctorCdjUsb(options: DoctorCdjUsbOptions = {}): Promise<CdjUsbDoctorResult> {
  const args = ["doctor", ...commonArgs(options)];
  if (options.imagePath) args.push("--image", resolve(options.imagePath));
  return doctorSchema.parse(await runNative(args, options)) as CdjUsbDoctorResult;
}

/** Read the active image and USB gadget state. */
export async function statusCdjUsb(options: CdjUsbRuntimeOptions = {}): Promise<CdjUsbStatus> {
  return statusSchema.parse(
    await runNative(["status", ...commonArgs(options)], options),
  ) as CdjUsbStatus;
}

/** Copy a block image into immutable appliance storage and atomically make it active. */
export async function publishCdjUsbImage(
  options: PublishCdjUsbOptions,
): Promise<CdjUsbPublishResult> {
  return publishSchema.parse(
    await runNative(["publish", resolve(options.imagePath), ...commonArgs(options)], options),
  ) as CdjUsbPublishResult;
}

/** Bind the active image read-only through the Linux mass-storage gadget. */
export async function attachCdjUsb(options: AttachCdjUsbOptions = {}): Promise<CdjUsbAttachResult> {
  return attachSchema.parse(
    await runNative(["attach", ...commonArgs(options), ...identityArgs(options)], options),
  ) as CdjUsbAttachResult;
}

/** Unbind the Linux mass-storage gadget after the host has ejected it. */
export async function detachCdjUsb(options: DetachCdjUsbOptions = {}): Promise<CdjUsbDetachResult> {
  return detachSchema.parse(
    await runNative(
      [
        "detach",
        ...commonArgs(options),
        ...(options.confirmHostEjected ? ["--confirm-host-ejected"] : []),
      ],
      options,
    ),
  ) as CdjUsbDetachResult;
}

/** Atomically publish an image and bind it read-only in one locked native operation. */
export async function runCdjUsb(options: RunCdjUsbOptions): Promise<CdjUsbRunResult> {
  return runSchema.parse(
    await runNative(
      ["run", resolve(options.imagePath), ...commonArgs(options), ...identityArgs(options)],
      options,
    ),
  ) as CdjUsbRunResult;
}

/** Resolve an explicit, environment-selected, packaged, or locally built native helper. */
export async function resolveCdjUsbBinary(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const candidates = [
    explicit,
    env.MUSIC_CDJ_USB_BINARY,
    fileURLToPath(new URL("../native-bin/music-cdj-usb", import.meta.url)),
    fileURLToPath(new URL("../native/target/release/music-cdj-usb", import.meta.url)),
    fileURLToPath(new URL("../native/target/debug/music-cdj-usb", import.meta.url)),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const path = resolve(candidate);
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      // Continue through deterministic fallbacks.
    }
  }
  throw new CdjUsbError(
    "NATIVE_MISSING",
    "music-cdj-usb native helper is missing; build it with pnpm --filter @gakonst/cdj-usb native:build",
  );
}

function commonArgs(options: CdjUsbRuntimeOptions): string[] {
  return [
    ...(options.stateDir ? ["--state-dir", resolve(options.stateDir)] : []),
    ...(options.configfsRoot ? ["--configfs-root", resolve(options.configfsRoot)] : []),
    ...(options.udcRoot ? ["--udc-root", resolve(options.udcRoot)] : []),
    ...(options.gadgetName ? ["--gadget-name", options.gadgetName] : []),
  ];
}

function identityArgs(options: AttachCdjUsbOptions): string[] {
  return [
    ...(options.udc ? ["--udc", options.udc] : []),
    ...(options.serial ? ["--serial", options.serial] : []),
    ...(options.manufacturer ? ["--manufacturer", options.manufacturer] : []),
    ...(options.product ? ["--product", options.product] : []),
  ];
}

async function runNative(args: string[], options: CdjUsbRuntimeOptions): Promise<unknown> {
  const binary = await resolveCdjUsbBinary(options.binaryPath, options.env ?? process.env);
  const { stdout, stderr, exitCode } = await spawnBounded(binary, args, options);
  if (exitCode !== 0) {
    throw new CdjUsbError(
      "NATIVE_FAILED",
      stderr.trim() || `music-cdj-usb exited with status ${String(exitCode)}`,
    );
  }
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new CdjUsbError(
      "INVALID_OUTPUT",
      `music-cdj-usb returned invalid JSON: ${stdout.slice(0, 240)}`,
      { cause: error },
    );
  }
}

async function spawnBounded(
  binary: string,
  args: string[],
  options: CdjUsbRuntimeOptions,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  if (options.signal?.aborted)
    throw new CdjUsbError("CANCELLED", "CDJ USB operation was cancelled");

  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(binary, args, {
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    const abort = () => child.kill("SIGTERM");
    options.signal?.addEventListener("abort", abort, { once: true });

    const append = (kind: "stdout" | "stderr", chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_NATIVE_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        rejectProcess(
          new CdjUsbError(
            "NATIVE_FAILED",
            `music-cdj-usb exceeded ${String(MAX_NATIVE_OUTPUT_BYTES)} output bytes`,
          ),
        );
        return;
      }
      if (kind === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", (error) => {
      options.signal?.removeEventListener("abort", abort);
      rejectProcess(
        new CdjUsbError("NATIVE_FAILED", "failed to start music-cdj-usb", { cause: error }),
      );
    });
    child.once("close", (exitCode) => {
      options.signal?.removeEventListener("abort", abort);
      if (options.signal?.aborted) {
        rejectProcess(new CdjUsbError("CANCELLED", "CDJ USB operation was cancelled"));
        return;
      }
      resolveProcess({ stdout, stderr, exitCode });
    });
  });
}
