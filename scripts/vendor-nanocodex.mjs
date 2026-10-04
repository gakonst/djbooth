// Build upstream first, then vendor its public npm artifacts and native packages. Never writes upstream.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const usage = "Usage: pnpm vendor:nanocodex <nanocodex-checkout> [--allow-dirty]";
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    usage +
      "\nBuild upstream first. --allow-dirty is for local checks only; release pins require a committed checkout.",
  );
  process.exit(0);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = process.argv[2] && resolve(process.argv[2]);
if (!source) throw new Error(usage);
const packages = ["nanocodex-react", "nanocodex-terminal", "nanocodex-connect-embed"];
const nativePackages = ["NanocodexConnectEmbed", "NanocodexUI", "NanocodexRemote", "InboxCore"];
const inputPaths = [
  ...packages.map((name) => `js/${name}`),
  ...nativePackages.map((name) => `apple/${name}`),
  "Package.swift",
  "LICENSE-APACHE",
  "LICENSE-MIT",
  "apple/MOBILE_DEPENDENCY_NOTICES.md",
];
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
const revision = run("git", ["rev-parse", "HEAD"], source);
const dirty = Boolean(run("git", ["status", "--porcelain", "--", ...inputPaths], source));
if (dirty && !process.argv.includes("--allow-dirty"))
  throw new Error(
    "Commit the upstream SDK first; use --allow-dirty only for local integration checks.",
  );
const manifests = new Map(
  await Promise.all(
    packages.map(async (name) => [
      name,
      JSON.parse(await readFile(join(source, "js", name, "package.json"), "utf8")),
    ]),
  ),
);
const destination = join(root, "vendor", "nanocodex");
await mkdir(destination, { recursive: true });
const artifacts = [];
for (const name of packages) {
  const staging = await mkdtemp(join(tmpdir(), "djbooth-nanocodex-"));
  try {
    const manifest = structuredClone(manifests.get(name));
    for (const group of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const [dependency, version] of Object.entries(manifest[group] ?? {})) {
        if (version.startsWith("workspace:")) {
          const target = manifests.get(dependency);
          if (!target) throw new Error(`Unvendored workspace dependency ${dependency}`);
          manifest[group][dependency] = `^${target.version}`;
        }
      }
    }
    delete manifest.devDependencies;
    delete manifest.scripts;
    const upstream = join(source, "js", name);
    // npm's own packlist picks the package's public files, including CSS and declarations.
    const listing = JSON.parse(
      run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], upstream),
    )[0];
    const publishedFiles = new Set(listing.files.map(({ path }) => path));
    function checkExports(value) {
      if (
        typeof value === "string" &&
        value.startsWith("./") &&
        !publishedFiles.has(value.slice(2))
      ) {
        throw new Error(
          `${name} is missing public export ${value}; build upstream before vendoring.`,
        );
      }
      if (value && typeof value === "object")
        for (const target of Object.values(value)) checkExports(target);
    }
    checkExports(manifest.exports);
    for (const { path } of listing.files) {
      if (path === "package.json") continue;
      await mkdir(dirname(join(staging, path)), { recursive: true });
      await cp(join(upstream, path), join(staging, path));
    }
    await writeFile(join(staging, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    const packed = JSON.parse(
      run(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
        staging,
      ),
    )[0];
    const bytes = await readFile(join(destination, packed.filename));
    artifacts.push({
      name,
      version: manifest.version,
      file: packed.filename,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
// Preserve relative Swift package dependencies and their test/resource declarations.
// git's public source list excludes local build products, caches and credentials.
const nativeFiles = [];
for (const name of nativePackages) {
  const prefix = `apple/${name}/`;
  const files = run(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", `apple/${name}`],
    source,
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  if (!files.includes(`${prefix}Package.swift`)) throw new Error(`Missing native package ${name}`);
  await rm(join(destination, "apple", name), { recursive: true, force: true });
  for (const file of files) {
    if (!file.startsWith(prefix)) throw new Error(`Unexpected native source path: ${file}`);
    const bytes = await readFile(join(source, file));
    await mkdir(dirname(join(destination, file)), { recursive: true });
    await writeFile(join(destination, file), bytes);
    nativeFiles.push({ file, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
}
for (const file of ["Package.swift", "LICENSE-APACHE", "LICENSE-MIT", "apple/MOBILE_DEPENDENCY_NOTICES.md"]) {
  const bytes = await readFile(join(source, file));
  await writeFile(join(destination, file), bytes);
  nativeFiles.push({ file, sha256: createHash("sha256").update(bytes).digest("hex") });
}
await writeFile(
  join(destination, "manifest.json"),
  JSON.stringify(
    { repository: "https://github.com/gakonst/nanocodex", revision, dirty, artifacts, nativeFiles },
    null,
    2,
  ) + "\n",
);
console.log(
  `Vendored ${artifacts.length} npm packages and ${nativePackages.length} Swift packages from ${revision}${dirty ? " (UNCOMMITTED DEVELOPMENT SNAPSHOT)" : ""}`,
);
