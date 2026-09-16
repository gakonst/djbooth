import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const extra = process.argv.slice(2).filter(arg => arg !== "--");
if (extra.includes("--help")) {
  console.log("pnpm native:test:usb [--simulator <uuid>] [--prepare-only]\nCreates a fake master.db and simulated USB folders with the normal djbooth CLI, then tests the iOS USB browser. Artifacts are retained in a new temporary directory. --prepare-only skips the simulator.");
  process.exit(0);
}
const root = mkdtempSync(join(tmpdir(), "djbooth-usb-integration-"));
const source = join(root, "source");
const database = join(source, "master.db");
const usb = join(root, "UpdatedUSB");
const run = (args, env = process.env) => {
  const result = spawnSync("pnpm", args, { cwd: repository, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm ${args.join(" ")} failed (${result.status})`);
};
const cli = (...args) => run(["djbooth", ...args, "--format", "json"]);
const hashes = directory => {
  const result = {};
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    result[path.slice(directory.length + 1)] = createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  return result;
};

console.log(`USB integration artifacts: ${root}`);
run(["--filter", "@gakonst/cdj-usb...", "build"]);
run(["--filter", "@gakonst/rekordbox", "exec", "tsx", "../../apps/apple/scripts/usb-fixture.ts", source]);
mkdirSync(usb);
cli("playlist", "show", "Tonight", "--path", database, "--plain");
cli("usb", usb, "--database", database, "--plain", "--progress", "always");
cpSync(usb, join(root, "InitialUSB"), { recursive: true });

// Exercise the real mutation and resumption commands against the fake master.db.
cli("playlist", "rename", "Tonight", "Afterhours", "--path", database, "--plain");
cli("playlist", "move-track", "Afterhours", "membership-2", "1", "--path", database, "--plain");
cli("usb", usb, "--database", database, "--plain", "--progress", "always");
cli("playlist", "show", "Afterhours", "--path", database, "--plain");

const dualUSB = join(root, "DualUSB");
mkdirSync(dualUSB);
cli("usb", dualUSB, "--database", database, "--plain", "--playlist-folder", "Gigs", "--fresh", "--progress", "always");

// Simulate a deck appending history, then use the normal bidirectional CLI twice.
const historyUSB = join(root, "HistoryUSB");
cpSync(usb, historyUSB, { recursive: true });
const historyFixture = mode => run(["--filter", "@gakonst/rekordbox", "exec", "tsx",
  "test/helpers/usb-history-cli-fixture.ts", mode, historyUSB, database]);
historyFixture("play");
cpSync(historyUSB, join(root, "PlayedUSB"), { recursive: true });
cli("usb", historyUSB, "--database", database, "--plain", "--progress", "always");
historyFixture("verify");
cli("usb", historyUSB, "--database", database, "--plain", "--progress", "always");
historyFixture("verify");
for (const name of ["MissingUSB", "CorruptUSB", "OneLibraryUSB"]) {
  mkdirSync(join(root, name, "PIONEER", "rekordbox"), { recursive: true });
}
writeFileSync(join(root, "CorruptUSB/PIONEER/rekordbox/export.pdb"), Buffer.from("truncated"));
cpSync(join(dualUSB, "PIONEER/rekordbox/exportLibrary.db"), join(root, "OneLibraryUSB/PIONEER/rekordbox/exportLibrary.db"));

const playbackSource = join(root, "playback-source");
run(["--filter", "@gakonst/rekordbox", "exec", "tsx", "test/helpers/usb-playback-fixture.ts", playbackSource]);
const playbackUSB = join(root, "PlaybackUSB");
mkdirSync(playbackUSB);
cli("usb", playbackUSB, "--database", join(playbackSource, "master.db"), "--plain", "--progress", "always");

const before = hashes(root);
writeFileSync(join(root, "before.json"), JSON.stringify(before, null, 2));
if (!extra.includes("--prepare-only")) {
  run(["native:test:ui", ...extra, "--only-testing", "DJBoothUITests-iOS/USBLibraryUITests"], {
    ...process.env,
    TEST_RUNNER_DJBOOTH_TEST_USB_ROOT: root,
  });
  const after = hashes(root);
  delete after["before.json"];
  assert.deepEqual(after, before, "Browsing a simulated USB must not write to any source or USB file");
  console.log("USB browser integration passed; all source and USB hashes unchanged.");
}
console.log(`Retained fake master.db and simulated USB sticks: ${root}`);
