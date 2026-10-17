import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, link, mkdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

import { XMLBuilder, XMLParser } from "fast-xml-parser";

/** Copy removable audio into immutable, content-addressed library storage. */
export async function copyAudioToLibrary(source: string, directory: string): Promise<string> {
  const digest = async (path: string): Promise<string> => {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
  };
  const sourcePath = await realpath(source);
  const hash = await digest(sourcePath);
  const destination = resolve(directory, hash, basename(sourcePath));
  const verifyDestination = async () => {
    if ((await digest(destination)) !== hash)
      throw new Error(`Library copy differs from source; refusing to overwrite: ${destination}`);
    return realpath(destination);
  };
  try {
    return await verifyDestination();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(destination), { recursive: true });
  const temporary = join(dirname(destination), `.${randomUUID()}.tmp`);
  try {
    await copyFile(sourcePath, temporary);
    if ((await digest(temporary)) !== hash)
      throw new Error(`Source changed while copying: ${sourcePath}`);
    try {
      // Publish only a complete copy, without replacing an existing library file.
      await link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return await verifyDestination();
  } finally {
    await rm(temporary, { force: true });
  }
}

const blobKey = Buffer.from("657f48f84c437cc1", "ascii");
const base85Alphabet = Buffer.from(
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~",
  "ascii",
);
const base85Values = new Map([...base85Alphabet].map((value, index) => [value, index]));

/** Error thrown when a requested process is not running. */
export class ProcessNotFoundError extends Error {
  override name = "ProcessNotFoundError";
}

/**
 * Emit a standardized deprecation warning.
 */
export function warnDeprecated(
  name: string,
  options: { newName?: string; hint?: string; removeIn?: string } = {},
): void {
  const { hint, newName, removeIn } = options;
  let message = `'${name}' is deprecated`;
  if (removeIn) message += ` and will be removed in version '${removeIn}'`;
  message += newName ? `, use '${newName}' instead!` : "!";
  if (hint) message += `\n${hint}`;
  process.emitWarning(message, { code: "DEP_REKORDBOX_TS", type: "DeprecationWarning" });
}

function listProcesses(): Array<{ name: string; pid: number }> {
  if (process.platform === "win32") {
    const output = execFileSync("tasklist", ["/fo", "csv", "/nh"], { encoding: "utf8" });
    return output
      .split(/\r?\n/u)
      .map((line) => /^"([^"]+)","(\d+)"/u.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({
        name: basename(match[1]!, extname(match[1]!)),
        pid: Number.parseInt(match[2]!, 10),
      }));
  }

  const output = execFileSync("ps", ["-A", "-o", "pid=,comm="], { encoding: "utf8" });
  return output
    .split(/\r?\n/u)
    .map((line) => /^\s*(\d+)\s+(.+)$/u.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => {
      const executable = basename(match[2]!);
      return {
        name: basename(executable, extname(executable)),
        pid: Number.parseInt(match[1]!, 10),
      };
    });
}

/** Process IDs relevant to safe Rekordbox database writes. */
export type RekordboxProcessState = {
  rekordboxAgentPid: number;
  rekordboxPid: number;
};

/** Return both Rekordbox process IDs from one operating-system process snapshot. */
export function getRekordboxProcessState(): RekordboxProcessState {
  const processes = listProcesses();
  return {
    rekordboxAgentPid: processes.find((candidate) => candidate.name === "rekordboxAgent")?.pid ?? 0,
    rekordboxPid: processes.find((candidate) => candidate.name === "rekordbox")?.pid ?? 0,
  };
}

/**
 * Find a process by executable name, ignoring a Windows `.exe` suffix.
 *
 * @returns The process ID, or zero when no process matches.
 */
export function getProcessId(name: string, options: { throwIfMissing?: boolean } = {}): number {
  const processInfo = listProcesses().find((candidate) => candidate.name === name);
  if (processInfo) return processInfo.pid;
  if (options.throwIfMissing)
    throw new ProcessNotFoundError(`No process with name '${name}' found!`);
  return 0;
}

/** Return the Rekordbox application process ID, or zero when it is not running. */
export function getRekordboxPid(options: { throwIfMissing?: boolean } = {}): number {
  return getProcessId("rekordbox", options);
}

/** Return the Rekordbox Agent process ID, or zero when it is not running. */
export function getRekordboxAgentPid(options: { throwIfMissing?: boolean } = {}): number {
  return getProcessId("rekordboxAgent", options);
}

/**
 * Format an XML document using a caller-selected indentation string.
 */
export function prettyXml(source: string, options: { indent?: string } = {}): string {
  const indent = options.indent ?? "    ";
  const parser = new XMLParser({
    commentPropName: "#comment",
    ignoreAttributes: false,
    preserveOrder: true,
    processEntities: false,
  });
  const builder = new XMLBuilder({
    commentPropName: "#comment",
    format: true,
    ignoreAttributes: false,
    indentBy: indent,
    preserveOrder: true,
    processEntities: false,
  });
  return `${builder.build(parser.parse(source)).trim()}\n`;
}

function encodeBase85(data: Buffer): Buffer {
  const padding = (4 - (data.length % 4)) % 4;
  const padded = padding === 0 ? data : Buffer.concat([data, Buffer.alloc(padding)]);
  const result = Buffer.alloc((padded.length / 4) * 5);

  for (let inputOffset = 0, outputOffset = 0; inputOffset < padded.length; inputOffset += 4) {
    let value = padded.readUInt32BE(inputOffset);
    for (let index = 4; index >= 0; index--) {
      result[outputOffset + index] = base85Alphabet[value % 85]!;
      value = Math.floor(value / 85);
    }
    outputOffset += 5;
  }

  return padding === 0 ? result : result.subarray(0, result.length - padding);
}

function decodeBase85(data: Buffer): Buffer {
  const padding = (5 - (data.length % 5)) % 5;
  const padded = padding === 0 ? data : Buffer.concat([data, Buffer.alloc(padding, 0x7e)]);
  const result = Buffer.alloc((padded.length / 5) * 4);

  for (let inputOffset = 0, outputOffset = 0; inputOffset < padded.length; inputOffset += 5) {
    let value = 0;
    for (let index = 0; index < 5; index++) {
      const digit = base85Values.get(padded[inputOffset + index]!);
      if (digit === undefined)
        throw new TypeError(`Invalid base85 byte at offset ${inputOffset + index}`);
      value = value * 85 + digit;
    }
    if (value > 0xffff_ffff) throw new RangeError("Base85 chunk exceeds 32 bits");
    result.writeUInt32BE(value, outputOffset);
    outputOffset += 4;
  }

  return padding === 0 ? result : result.subarray(0, result.length - padding);
}

function xorBlob(data: Buffer): Buffer {
  return Buffer.from(data.map((byte, index) => byte ^ blobKey[index % blobKey.length]!));
}

/**
 * Obfuscate text using the zlib/XOR/base85 encoding used by pyrekordbox.
 */
export function obfuscate(plaintext: string): Buffer {
  return encodeBase85(xorBlob(deflateSync(Buffer.from(plaintext, "utf8"))));
}

/**
 * Decode text produced by {@link obfuscate} or pyrekordbox's equivalent helper.
 */
export function deobfuscate(blob: Buffer | string): string {
  const encoded = typeof blob === "string" ? Buffer.from(blob, "ascii") : blob;
  return inflateSync(xorBlob(decodeBase85(encoded))).toString("utf8");
}
