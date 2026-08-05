#!/usr/bin/env node

import { lstat, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = join(repoRoot, "plugins", "djbooth");
const checkOnly = process.argv.slice(2).includes("--check");
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--check");

if (unknownArguments.length) throw new TypeError(`Unknown argument: ${unknownArguments.join(" ")}`);

const packageManifest = await readJson(join(repoRoot, "packages", "djbooth", "package.json"));
const version = packageManifest.version;
assert(typeof version === "string" && version.length > 0, "@gakonst/djbooth version is missing");

if (!checkOnly) await synchronizeVersion(version);
await validateMetadata(version);
await assertMissing(join(repoRoot, "packages", "djbooth", "skills"), "package skill duplication");
await assertMissing(join(pluginRoot, "skills"), "plugin skill duplication");

process.stdout.write(`djbooth.ai MCP plugin is ${checkOnly ? "current" : "synchronized"}.\n`);

async function synchronizeVersion(nextVersion) {
  await writeFile(join(pluginRoot, "VERSION"), `${nextVersion}\n`);
  for (const provider of ["codex", "claude"]) {
    const manifestPath = join(pluginRoot, `.${provider}-plugin`, "plugin.json");
    const manifest = await readJson(manifestPath);
    manifest.version = nextVersion;
    await writeJson(manifestPath, manifest);
  }
  const marketplacePath = join(repoRoot, ".claude-plugin", "marketplace.json");
  const marketplace = await readJson(marketplacePath);
  marketplace.version = nextVersion;
  uniquePlugin(marketplace, "Claude").version = nextVersion;
  await writeJson(marketplacePath, marketplace);
}

async function validateMetadata(expectedVersion) {
  const bundledVersion = (await readFile(join(pluginRoot, "VERSION"), "utf8")).trim();
  assert(bundledVersion === expectedVersion, "plugin VERSION must match @gakonst/djbooth");

  for (const provider of ["codex", "claude"]) {
    const manifest = await readJson(join(pluginRoot, `.${provider}-plugin`, "plugin.json"));
    assert(manifest.name === "djbooth", `${provider} plugin name must be djbooth`);
    assert(manifest.version === expectedVersion, `${provider} plugin version is stale`);
    assert(!("skills" in manifest), `${provider} plugin must not bundle skills`);
    const server = manifest.mcpServers?.djbooth;
    assert(server?.command === "djbooth", `${provider} plugin MCP command is stale`);
    assert(
      JSON.stringify(server?.args) === JSON.stringify(["--mcp"]),
      `${provider} plugin MCP arguments are stale`,
    );
  }

  const codexMarketplace = await readJson(join(repoRoot, ".codex-plugin", "marketplace.json"));
  assert(codexMarketplace.name === "djbooth-ai", "Codex marketplace name is stale");
  const codexEntry = uniquePlugin(codexMarketplace, "Codex");
  assert(
    codexEntry.source?.source === "local" && codexEntry.source?.path === "./plugins/djbooth",
    "Codex marketplace source is stale",
  );

  const claudeMarketplace = await readJson(join(repoRoot, ".claude-plugin", "marketplace.json"));
  assert(claudeMarketplace.name === "djbooth-ai", "Claude marketplace name is stale");
  assert(claudeMarketplace.version === expectedVersion, "Claude marketplace version is stale");
  const claudeEntry = uniquePlugin(claudeMarketplace, "Claude");
  assert(claudeEntry.source === "./plugins/djbooth", "Claude marketplace source is stale");
  assert(claudeEntry.version === expectedVersion, "Claude marketplace plugin version is stale");
}

function uniquePlugin(marketplace, provider) {
  assert(Array.isArray(marketplace.plugins), `${provider} marketplace plugins must be an array`);
  const entries = marketplace.plugins.filter((entry) => entry?.name === "djbooth");
  assert(entries.length === 1, `${provider} marketplace must contain one djbooth plugin`);
  return entries[0];
}

async function assertMissing(target, label) {
  try {
    await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new TypeError(`${label} must not exist: ${target}`);
}

async function readJson(target) {
  return JSON.parse(await readFile(target, "utf8"));
}

async function writeJson(target, value) {
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
}

function assert(condition, message) {
  if (!condition) throw new TypeError(message);
}
