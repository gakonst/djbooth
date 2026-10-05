import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const here = import.meta.dirname;
const graphPath = path.resolve(
  process.argv[2] ?? path.join(here, "house-taste-showcase-graph.json"),
);
const cacheDirectory = path.resolve(
  process.argv[3] ??
    "/Users/gakonst/Library/Caches/djbooth/house-taste-showcase/ritual-current-v1.cache",
);
const outputPath = path.resolve(process.argv[4] ?? graphPath);
const graph = JSON.parse(await readFile(graphPath, "utf8"));

// Targets are source peaks before the graph's constant-power pan law. Centered material lands
// roughly 3 dB lower in the stereo arrangement. The hierarchy follows the personal reference
// panel: kick anchor, bass about 7 dB beneath it, musical mids behind the anchors, and quiet FX.
const targetPeakDb = {
  "sub-a": -8,
  "sub-b": -8,
  "acid-a": -13,
  "acid-b": -13,
  "drive-sequence": -15,
  "hook-a-dry": -8,
  "hook-a-depth": -17,
  "hook-b-dry": -8,
  "hook-b-depth": -17,
  "air-ghost": -20,
  "analog-rear-pad": -15,
  "electric-syncopated-chords": -13,
  "collision-chord-body": -12,
  "collision-balafon": -13,
  "tension-muted-answer": -15,
  "collision-bell-signals": -19,
  "kick-main": -1,
  "kick-final": -1,
  "kick-click": -14,
  "clap-body": -7,
  "clap-ghost": -16,
  "offbeat-hat": -11,
  "closed-hat-grid": -13,
  "live-shaker": -15,
  "conga-low": -14,
  "conga-high": -16,
  "rim-interlock": -15,
  "tom-phrase-fills": -12,
  "section-crashes": -14,
  "transition-risers": -16,
  "water-transition-detail": -20,
};

function peakDb(audioPath) {
  const result = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-i", audioPath, "-af", "volumedetect", "-f", "null", "-"],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const match = output.match(/max_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB/i);
  if (!match || match[1] === "-inf") {
    throw new Error(`could not measure an audible peak in ${audioPath}`);
  }
  return Number(match[1]);
}

function lastNativeEffectIndex(track) {
  let found = null;
  for (const [index, effect] of (track.effects ?? []).entries()) {
    if (effect.kind === "native") found = index;
  }
  return found;
}

function renderedSources(track) {
  const effectIndex = lastNativeEffectIndex(track);
  if (track.kind === "sample") {
    if (effectIndex === null) return [track.sample];
    return [path.join(cacheDirectory, `${track.id}-sample-native-effect-${effectIndex}.wav`)];
  }
  if (track.kind === "native") {
    return track.clips.map((clip) =>
      path.join(
        cacheDirectory,
        effectIndex === null
          ? `${track.id}-clip-${clip.id}-source.wav`
          : `${track.id}-clip-${clip.id}-native-effect-${effectIndex}.wav`,
      ),
    );
  }
  throw new Error(`unsupported calibration source ${track.kind} on ${track.id}`);
}

const report = [];
for (const track of graph.tracks) {
  const target = targetPeakDb[track.id];
  if (target === undefined) throw new Error(`missing mix target for ${track.id}`);
  const sources = renderedSources(track);
  for (const source of sources) {
    if (!existsSync(source)) throw new Error(`missing cached source for ${track.id}: ${source}`);
  }
  const measured = Math.max(...sources.map(peakDb));
  const previousGainDb = track.gainDb ?? 0;
  track.gainDb = Number((target - measured).toFixed(2));
  report.push({
    id: track.id,
    measuredSourcePeakDb: measured,
    targetSourcePeakDb: target,
    previousGainDb,
    calibratedGainDb: track.gainDb,
  });
}

graph.master.inputGainDb = 0;
graph.provenance = {
  ...graph.provenance,
  mixCalibration: {
    method: "measure post-Ableton-chain source peaks, then alter graph gain only",
    constantPowerCenterPanDb: -3.01,
    targets: targetPeakDb,
    customAudioDsp: false,
  },
};
await writeFile(outputPath, `${JSON.stringify(graph, null, 2)}\n`);
console.log(JSON.stringify({ graph: outputPath, cacheDirectory, tracks: report }, null, 2));
