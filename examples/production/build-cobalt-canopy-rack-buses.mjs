import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const [stemsArgument, outputArgument] = process.argv.slice(2);
if (!stemsArgument || !outputArgument) {
  throw new Error("usage: node build-cobalt-canopy-rack-buses.mjs <dry-stems-dir> <output-dir>");
}

const stems = path.resolve(stemsArgument);
const output = path.resolve(outputArgument);
const bpm = 123;
const bars = 104;

// Full-length stereo stems are already panned. Keep the graph's center-pan
// attenuation as bus headroom instead of compensating back to 0 dBFS.
const fullLengthTrack = (id, samplePath, gainDb = 0) => ({
  id,
  kind: "sample",
  sample: samplePath,
  velocityAmount: 0,
  gainDb,
  pan: 0,
  effects: [],
  triggers: [{ beat: 0, velocity: 127 }],
});

const graph = (title, tracks, inputGainDb = 0) => ({
  schemaVersion: 1,
  title,
  bpm,
  bars,
  beatsPerBar: 4,
  sampleRate: 44100,
  tailSeconds: 5,
  master: { inputGainDb, outputGainDb: 0, effects: [] },
  tracks,
});

const drumIds = [
  "kick",
  "rim",
  "shaker",
  "conga-low",
  "conga-high",
  "bongo",
  "clave",
  "agogo",
  "open-hat",
  "reverse-cymbal",
];
const musicIds = ["plucked-chords", "marimba-hook", "marimba-response", "atmospheric-pad"];

const manifests = {
  "cobalt-drums-dry.json": graph(
    "Cobalt Canopy — dry drum bus",
    drumIds.map((id) => fullLengthTrack(id, path.join(stems, `${id}.wav`))),
  ),
  "cobalt-music-dry.json": graph(
    "Cobalt Canopy — dry harmonic bus",
    musicIds.map((id) => fullLengthTrack(id, path.join(stems, `${id}.wav`))),
  ),
  "cobalt-rack-mix.json": graph(
    "Cobalt Canopy — real Ableton rack mix",
    [
      fullLengthTrack("grand-drum-buss", path.join(output, "drums-grand-buss.wav"), 7.5),
      fullLengthTrack("roar-low-end", path.join(output, "bass-roar-low-end.wav"), 11),
      fullLengthTrack("crossover-phaser", path.join(output, "music-crossover-phaser.wav"), 4.5),
    ],
    -4,
  ),
};

await mkdir(output, { recursive: true });
for (const [name, manifest] of Object.entries(manifests)) {
  await writeFile(path.join(output, name), `${JSON.stringify(manifest, null, 2)}\n`);
}

console.log(
  JSON.stringify(
    {
      output,
      manifests: Object.keys(manifests).map((name) => path.join(output, name)),
      customDsp: false,
    },
    null,
    2,
  ),
);
