import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { XMLParser } from "fast-xml-parser";

/** Scalar or vector value parsed from a Rekordbox settings file. */
export type RekordboxSettingValue =
  | string
  | number
  | Array<number>
  | Record<string, string | number | Array<number>>;

/** Configuration shared by all detected Rekordbox versions. */
export type PioneerConfiguration = {
  appDir?: string;
  installDir?: string;
};

/** Configuration for one detected Rekordbox major version. */
export type RekordboxConfiguration = {
  appDir: string;
  dbDir: string;
  dbPath: string;
  installDir: string;
  version: string;
};

/** Complete discovered Rekordbox configuration. */
export type Configuration = {
  pioneer: PioneerConfiguration;
  rekordbox5?: RekordboxConfiguration;
  rekordbox6?: RekordboxConfiguration;
  rekordbox7?: RekordboxConfiguration;
};

/** Options controlling installation discovery. */
export type UpdateConfigOptions = {
  pioneerAppDir?: string;
  pioneerInstallDir?: string;
  rekordbox5Dirname?: string;
  rekordbox6Dirname?: string;
  rekordbox7Dirname?: string;
  platform?: NodeJS.Platform;
};

/** Error thrown when an explicitly selected Rekordbox installation does not exist. */
export class InvalidApplicationDirnameError extends Error {
  override name = "InvalidApplicationDirnameError";
}

/** Upstream-compatible error name. */
export { InvalidApplicationDirnameError as InvalidApplicationDirname };

/** Error thrown when automatic discovery is unavailable on the current platform. */
export class UnsupportedPlatformError extends Error {
  override name = "UnsupportedPlatformError";
}

class ConfigurationPathError extends Error {
  override name = "ConfigurationPathError";
}

let configuration: Configuration = { pioneer: {} };

function requirePath(path: string, description: string): string {
  const absolutePath = resolve(path);
  if (!existsSync(absolutePath))
    throw new ConfigurationPathError(`The ${description} '${absolutePath}' does not exist!`);
  return absolutePath;
}

/**
 * Resolve and validate the Pioneer/Rekordbox installation root.
 */
export function getPioneerInstallDir(
  path?: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (path) return requirePath(path, "Pioneer install directory");
  if (platform === "win32") {
    const programFiles = process.env.ProgramFiles?.replace("(x86)", "").trim();
    if (!programFiles) throw new ConfigurationPathError("ProgramFiles is not defined");
    return requirePath(programFiles, "Pioneer install directory");
  }
  if (platform === "darwin") return requirePath("/Applications", "Pioneer install directory");
  throw new UnsupportedPlatformError(`OS '${platform}' is not supported`);
}

/**
 * Resolve and validate the Pioneer application-data root.
 */
export function getPioneerAppDir(
  path?: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (path) return requirePath(path, "Pioneer app directory");
  if (platform === "win32") {
    if (!process.env.AppData) throw new ConfigurationPathError("AppData is not defined");
    return requirePath(join(process.env.AppData, "Pioneer"), "Pioneer app directory");
  }
  if (platform === "darwin")
    return requirePath(
      join(homedir(), "Library", "Application Support", "Pioneer"),
      "Pioneer app directory",
    );
  throw new UnsupportedPlatformError(`OS '${platform}' is not supported`);
}

function convertType(value: string): string | number | Array<number> {
  const parts = value.split(",");
  const isInteger = (part: string) => /^[+-]?\d+$/u.test(part);
  if (parts.length === 1 && isInteger(value)) return Number.parseInt(value, 10);
  if (parts.length > 1 && parts.every(isInteger))
    return parts.map((part) => Number.parseInt(part, 10));

  const numbers = parts.map((part) => (part.trim() === "" ? Number.NaN : Number(part)));
  if (parts.length === 1 && Number.isFinite(numbers[0])) return numbers[0]!;
  if (parts.length > 1 && numbers.every(Number.isFinite)) return numbers;
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/**
 * Parse `rekordbox3.settings` from a Rekordbox application-data directory.
 */
export function readRekordboxSettings(
  rekordboxAppDir: string,
): Record<string, RekordboxSettingValue> {
  const source = readFileSync(join(rekordboxAppDir, "rekordbox3.settings"), "utf8");
  const parser = new XMLParser({
    attributeNamePrefix: "",
    ignoreAttributes: false,
    parseAttributeValue: false,
    processEntities: false,
  });
  const document = asRecord(parser.parse(source));
  const properties = asRecord(document.PROPERTIES);
  const rawValues = properties.VALUE;
  const values = Array.isArray(rawValues) ? rawValues : rawValues ? [rawValues] : [];
  const settings: Record<string, RekordboxSettingValue> = {};

  for (const rawValue of values) {
    const value = asRecord(rawValue);
    if (typeof value.name !== "string") continue;
    if (typeof value.val === "string") {
      settings[value.name] = convertType(value.val);
      continue;
    }

    const deviceSetup = asRecord(value.DEVICESETUP);
    settings[value.name] = Object.fromEntries(
      Object.entries(deviceSetup)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([key, setting]) => [key, convertType(setting)]),
    );
  }

  return settings;
}

/**
 * Parse Rekordbox Agent's `options.json` into a keyed object.
 */
export function readRekordbox6Options(pioneerAppDir: string): Record<string, unknown> {
  const path = join(pioneerAppDir, "rekordboxAgent", "storage", "options.json");
  const data = JSON.parse(readFileSync(path, "utf8")) as { options?: unknown };
  if (!Array.isArray(data.options)) throw new TypeError(`Invalid Rekordbox options file '${path}'`);

  const options: Record<string, unknown> = {};
  for (const entry of data.options) {
    if (!Array.isArray(entry) || entry.length < 2 || typeof entry[0] !== "string") continue;
    options[entry[0]] = entry[1];
  }
  return options;
}

function extractVersion(name: string, majorVersion: number): string {
  const version = name
    .replace(/\.app$/u, "")
    .replace("rekordbox", "")
    .trim();
  return version || String(majorVersion);
}

function compareVersions(left: string, right: string): number {
  const tokenize = (version: string) =>
    version.split(/[.-]/u).map((part) => (/^\d+$/u.test(part) ? Number(part) : part));
  const leftParts = tokenize(left);
  const rightParts = tokenize(right);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index++) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart === rightPart) continue;
    if (typeof leftPart === "number" && typeof rightPart === "number") return leftPart - rightPart;
    return String(leftPart).localeCompare(String(rightPart));
  }
  return 0;
}

function getRekordboxConfiguration(
  pioneerInstallDir: string,
  pioneerAppDir: string,
  majorVersion: 5 | 6 | 7,
  applicationDirname: string | undefined,
  platform: NodeJS.Platform,
): RekordboxConfiguration {
  const installRoot =
    platform === "win32"
      ? join(pioneerInstallDir, majorVersion >= 7 ? "rekordbox" : "Pioneer")
      : pioneerInstallDir;

  let installDir: string;
  let version: string;
  if (applicationDirname) {
    installDir = join(installRoot, applicationDirname);
    if (!existsSync(installDir))
      throw new InvalidApplicationDirnameError(
        `The supplied application dirname '${applicationDirname}' does not exist in '${installRoot}'`,
      );
    version = extractVersion(applicationDirname, majorVersion);
  } else {
    const installations = readdirSync(installRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("rekordbox"))
      .map((entry) => ({ name: entry.name, version: extractVersion(entry.name, majorVersion) }))
      .filter((entry) => entry.version.startsWith(String(majorVersion)))
      .sort((left, right) => compareVersions(left.version, right.version));
    const installation = installations.at(-1);
    if (!installation)
      throw new ConfigurationPathError(
        `No Rekordbox ${majorVersion} folder found in installation directory '${installRoot}'`,
      );
    installDir = join(installRoot, installation.name);
    version = installation.version;
  }

  const appDir = join(pioneerAppDir, majorVersion >= 6 ? "rekordbox6" : "rekordbox");
  requirePath(appDir, `Rekordbox ${majorVersion} app directory`);
  const settings = readRekordboxSettings(appDir);
  const masterDbDirectory = settings.masterDbDirectory;
  if (typeof masterDbDirectory !== "string")
    throw new TypeError(`Missing masterDbDirectory in '${join(appDir, "rekordbox3.settings")}'`);
  const dbDir = resolve(masterDbDirectory);
  const dbPath = join(dbDir, majorVersion >= 6 ? "master.db" : "datafile.edb");
  requirePath(dbPath, `Rekordbox ${majorVersion} database`);

  if (majorVersion >= 6) {
    const options = readRekordbox6Options(pioneerAppDir);
    if (typeof options["db-path"] !== "string")
      throw new TypeError("Missing 'db-path' in Rekordbox Agent options");
    const optionDbPath = resolve(options["db-path"]);
    if (optionDbPath !== resolve(dbPath) || dirname(optionDbPath) !== resolve(dbDir))
      throw new Error(`Rekordbox settings and Agent options disagree about '${dbPath}'`);
  }

  return { appDir, dbDir, dbPath, installDir, version };
}

function isDiscoveryMiss(error: unknown): boolean {
  if (error instanceof ConfigurationPathError || error instanceof UnsupportedPlatformError)
    return true;
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function cloneConfiguration(value: Configuration): Configuration {
  return structuredClone(value);
}

/**
 * Discover installed Rekordbox versions and update the module configuration.
 * Missing major versions are skipped independently.
 */
export function updateConfig(options: UpdateConfigOptions = {}): Configuration {
  const platform = options.platform ?? process.platform;
  let pioneerInstallDir: string;
  let pioneerAppDir: string;
  try {
    pioneerInstallDir = getPioneerInstallDir(options.pioneerInstallDir, platform);
    pioneerAppDir = getPioneerAppDir(options.pioneerAppDir, platform);
  } catch (error) {
    if (isDiscoveryMiss(error)) return cloneConfiguration(configuration);
    throw error;
  }

  configuration.pioneer = { appDir: pioneerAppDir, installDir: pioneerInstallDir };
  const versions = [
    [5, "rekordbox5", options.rekordbox5Dirname],
    [6, "rekordbox6", options.rekordbox6Dirname],
    [7, "rekordbox7", options.rekordbox7Dirname],
  ] as const;

  for (const [version, section, dirname] of versions) {
    try {
      configuration[section] = getRekordboxConfiguration(
        pioneerInstallDir,
        pioneerAppDir,
        version,
        dirname,
        platform,
      );
    } catch (error) {
      if (!isDiscoveryMiss(error)) throw error;
    }
  }

  return cloneConfiguration(configuration);
}

/** Return a snapshot of all currently discovered configuration. */
export function getConfig(): Configuration;
/** Return one section of the currently discovered configuration. */
export function getConfig<const section extends keyof Configuration>(
  section: section,
): Configuration[section];
/** Return one value from a section of the currently discovered configuration. */
export function getConfig<
  const section extends keyof Configuration,
  const key extends keyof NonNullable<Configuration[section]>,
>(section: section, key: key): NonNullable<Configuration[section]>[key] | undefined;
export function getConfig(
  section?: keyof Configuration,
  key?: string,
): Configuration | Configuration[keyof Configuration] | unknown {
  if (!configuration.pioneer.installDir) updateConfig();
  const snapshot = cloneConfiguration(configuration);
  if (!section) return snapshot;
  const selected = snapshot[section];
  if (!key || !selected) return selected;
  return (selected as unknown as Record<string, unknown>)[key];
}

/** Format discovered configuration for human-readable display. */
export function formatConfig(value: Configuration = getConfig()): string {
  const sections: Array<[string, PioneerConfiguration | RekordboxConfiguration | undefined]> = [
    ["Pioneer", value.pioneer],
    ["Rekordbox 5", value.rekordbox5],
    ["Rekordbox 6", value.rekordbox6],
    ["Rekordbox 7", value.rekordbox7],
  ];
  const lines: Array<string> = [];
  for (const [name, section] of sections) {
    lines.push(`${name}:`);
    if (!section) continue;
    for (const [key, setting] of Object.entries(section).sort(([left], [right]) =>
      left.localeCompare(right),
    ))
      lines.push(`   ${(key + " =").padEnd(14)} ${setting}`);
  }
  return lines.join("\n");
}

/** Upstream-compatible alias for {@link formatConfig}. */
export const pformatConfig = formatConfig;

/** Print the discovered Rekordbox configuration and return its formatted value. */
export function showConfig(value: Configuration = getConfig()): string {
  const formatted = formatConfig(value);
  console.log(formatted);
  return formatted;
}
