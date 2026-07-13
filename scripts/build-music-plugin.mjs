#!/usr/bin/env node

import { cp, lstat, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceSkill = join(repoRoot, "packages", "music", "skills", "music");
const pluginRoot = join(repoRoot, "plugins", "music");
const bundledSkillsRoot = join(pluginRoot, "skills");
const bundledSkill = join(bundledSkillsRoot, "music");
const checkOnly = process.argv.slice(2).includes("--check");
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--check");

if (unknownArguments.length > 0) {
  throw new TypeError(`Unknown argument: ${unknownArguments.join(" ")}`);
}

await requireDirectory(sourceSkill, "canonical Music skill");

const packageManifest = await readJson(join(repoRoot, "packages", "music", "package.json"));

if (checkOnly) {
  await requireDirectory(bundledSkill, "bundled Music skill");
  await assertTreesEqual(sourceSkill, bundledSkill);
} else {
  await bundleSkill();
  await synchronizeVersion(packageManifest.version);
}

await assertNoSymlinks(bundledSkillsRoot);
await validateMetadata();

process.stdout.write(
  checkOnly
    ? "Music plugin bundle is current and valid.\n"
    : "Bundled packages/music/skills/music into plugins/music/skills/music.\n",
);

async function bundleSkill() {
  const stagingRoot = await mkdtemp(join(pluginRoot, ".skills-"));
  const stagedSkill = join(stagingRoot, "music");
  try {
    await cp(sourceSkill, stagedSkill, {
      recursive: true,
      dereference: true,
      filter(source) {
        return ![".DS_Store", "node_modules", "__pycache__"].includes(basename(source));
      },
    });
    await assertNoSymlinks(stagedSkill);
    await rm(bundledSkillsRoot, { recursive: true, force: true });
    await rename(stagingRoot, bundledSkillsRoot);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

async function validateMetadata() {
  const version = (await readFile(join(pluginRoot, "VERSION"), "utf8")).trim();
  assert(version === packageManifest.version, "plugin VERSION must match @gakonst/music");

  const codexManifestPath = join(pluginRoot, ".codex-plugin", "plugin.json");
  const claudeManifestPath = join(pluginRoot, ".claude-plugin", "plugin.json");
  const codexManifest = await readJson(codexManifestPath);
  const claudeManifest = await readJson(claudeManifestPath);

  for (const [provider, manifest] of [
    ["Codex", codexManifest],
    ["Claude", claudeManifest],
  ]) {
    assert(manifest.name === "music", `${provider} plugin name must be music`);
    assert(manifest.version === version, `${provider} plugin version is stale`);
    assert(manifest.skills === "./skills/", `${provider} plugin skills path is stale`);
    assert(!("mcpServers" in manifest), `${provider} plugin must remain skill-only`);
  }

  const codexMarketplace = await readJson(join(repoRoot, ".codex-plugin", "marketplace.json"));
  assert(codexMarketplace.name === "music-ts", "Codex marketplace name is stale");
  const codexEntry = uniquePlugin(codexMarketplace, "Codex");
  assert(
    codexEntry.source?.source === "local" && codexEntry.source?.path === "./plugins/music",
    "Codex marketplace source is stale",
  );

  const claudeMarketplace = await readJson(join(repoRoot, ".claude-plugin", "marketplace.json"));
  assert(claudeMarketplace.name === "music-ts", "Claude marketplace name is stale");
  assert(claudeMarketplace.version === version, "Claude marketplace version is stale");
  const claudeEntry = uniquePlugin(claudeMarketplace, "Claude");
  assert(claudeEntry.source === "./plugins/music", "Claude marketplace source is stale");
  assert(claudeEntry.version === version, "Claude marketplace plugin version is stale");

  await assertMissing(join(pluginRoot, ".mcp.json"), "plugin must remain skill-only");
}

async function synchronizeVersion(version) {
  assert(typeof version === "string" && version.length > 0, "@gakonst/music version is missing");
  await writeFile(join(pluginRoot, "VERSION"), `${version}\n`);

  for (const provider of ["codex", "claude"]) {
    const path = join(pluginRoot, `.${provider}-plugin`, "plugin.json");
    const manifest = await readJson(path);
    manifest.version = version;
    await writeJson(path, manifest);
  }

  const marketplacePath = join(repoRoot, ".claude-plugin", "marketplace.json");
  const marketplace = await readJson(marketplacePath);
  marketplace.version = version;
  const entry = uniquePlugin(marketplace, "Claude");
  entry.version = version;
  await writeJson(marketplacePath, marketplace);
}

function uniquePlugin(marketplace, provider) {
  assert(Array.isArray(marketplace.plugins), `${provider} marketplace plugins must be an array`);
  const entries = marketplace.plugins.filter((entry) => entry?.name === "music");
  assert(entries.length === 1, `${provider} marketplace must contain one music plugin`);
  return entries[0];
}

async function assertTreesEqual(expectedRoot, actualRoot) {
  const expectedFiles = await listFiles(expectedRoot);
  const actualFiles = await listFiles(actualRoot);
  assert(
    JSON.stringify(actualFiles) === JSON.stringify(expectedFiles),
    "plugin skill file list is stale; run node scripts/build-music-plugin.mjs",
  );

  for (const path of expectedFiles) {
    const [expected, actual] = await Promise.all([
      readFile(join(expectedRoot, path)),
      readFile(join(actualRoot, path)),
    ]);
    assert(
      expected.equals(actual),
      `plugin skill file is stale: ${path}; run node scripts/build-music-plugin.mjs`,
    );
  }
}

async function listFiles(root) {
  const files = [];
  await visit(root);
  return files.sort();

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new TypeError(`Symlink is not allowed: ${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(relative(root, path));
    }
  }
}

async function assertNoSymlinks(root) {
  await visit(root);

  async function visit(path) {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) throw new TypeError(`Symlink is not allowed: ${path}`);
    if (!stats.isDirectory()) return;
    for (const entry of await readdir(path)) await visit(join(path, entry));
  }
}

async function requireDirectory(path, label) {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    throw new TypeError(`Missing ${label}: ${path}`);
  }
  assert(stats.isDirectory(), `${label} must be a directory: ${path}`);
}

async function assertMissing(path, message) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new TypeError(`${message}: ${path}`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function assert(condition, message) {
  if (!condition) throw new TypeError(message);
}
