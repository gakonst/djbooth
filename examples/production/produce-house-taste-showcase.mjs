import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const here = import.meta.dirname;
const root = path.resolve(here, "../..");
const renderDirectory = "/Users/gakonst/Library/Caches/djbooth/house-taste-showcase";
const graph = path.join(here, "house-taste-showcase-graph.json");
const clipDirectory = path.join(here, "house-taste-showcase-clips");
const sidechainGraph = path.join(renderDirectory, "kick-sidechain-graph.json");
const sidechainAudio = path.join(renderDirectory, "kick-sidechain.wav");
const premaster = path.join(renderDirectory, "ritual-current-premaster.wav");
const masterGraph = path.join(renderDirectory, "ritual-current-master-graph.json");
const cacheDirectory = path.join(renderDirectory, "ritual-current-v1.cache");
const output = path.resolve(
  process.argv.find((argument) => argument.startsWith("--output="))?.slice(9) ??
    path.join(renderDirectory, "ritual-current.wav"),
);
const profile = output.replace(/\.wav$/i, "-profile.json");
const play = process.argv.includes("--play");
const armBinary = path.join(root, "rust/target/release/djbooth-rs");
const x86Binary = path.join(root, "rust/target/x86_64-apple-darwin/release/djbooth-rs");

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${arguments_.join(" ")} exited with ${result.status}`);
  }
}

const djbooth = (...arguments_) => run("pnpm", ["djbooth", ...arguments_]);
const renderGraph = (manifest, destination) =>
  djbooth(
    "produce",
    "ableton",
    "render-graph",
    manifest,
    destination,
    "--cacheDir",
    cacheDirectory,
    "--binary",
    armBinary,
    "--deviceHost",
    x86Binary,
    "--format",
    "json",
  );

run("node", [path.join(here, "build-house-taste-showcase.mjs")]);

djbooth(
  "produce",
  "ableton",
  "render-graph",
  sidechainGraph,
  sidechainAudio,
  "--binary",
  armBinary,
  "--deviceHost",
  x86Binary,
  "--format",
  "json",
);

for (const filename of readdirSync(clipDirectory)
  .filter((name) => name.endsWith(".json"))
  .sort()) {
  const id = filename.replace(/\.json$/, "");
  djbooth(
    "produce",
    "render",
    path.join(clipDirectory, filename),
    path.join(renderDirectory, `${id}.wav`),
    "--binary",
    x86Binary,
    "--format",
    "json",
  );
}

// The first assembly populates all short post-device caches. Calibration then measures those
// exact real-engine outputs and changes graph gain only; the second assembly is normally seconds.
renderGraph(graph, premaster);
run("node", [path.join(here, "calibrate-house-taste-showcase.mjs"), graph, cacheDirectory, graph]);
renderGraph(graph, premaster);
renderGraph(masterGraph, output);

djbooth(
  "produce",
  "reference-profile",
  output,
  "--binary",
  armBinary,
  "--output",
  profile,
  "--format",
  "json",
  "--filter-output",
  "mix,relationships,bpm,key,phraseLengthHistogram",
);

if (play) run("afplay", [output]);
console.log(
  JSON.stringify({ output, profile, graph, cacheDirectory, customAudioDsp: false }, null, 2),
);
