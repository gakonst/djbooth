import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const input = path.resolve(process.argv[2] ?? path.join(here, "gravity-conditioned.json"));
const output = path.resolve(process.argv[3] ?? path.join(here, "gravity-ableton-graph.json"));
const source = JSON.parse(await readFile(input, "utf8"));

const core =
  "/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Core Library/Devices";
const max =
  "/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Max/Max.app/Contents/Resources/C74/packages/Max for Live/patchers";
const analog = (name) => path.join(core, "Instruments/Analog/Bass", name);
const collision = (group, name) => path.join(core, "Instruments/Collision", group, name);
const amp = (name) => path.join(core, "Audio Effects/Amp", name);
const maxEffect = (folder, name) => path.join(max, "Max Audio Effect", folder, name);

const native = {
  "offbeat-serum-bass": {
    device: "Analog",
    preset: analog("Muted Wow Bass.adv"),
    gainDb: 28,
    pan: 0,
    effects: [],
  },
  "offbeat-serum-midbass-left": {
    device: "Analog",
    preset: analog("Muted Wow Bass.adv"),
    gainDb: -15,
    pan: -0.68,
    effects: [{ kind: "native", device: "Amp", preset: amp("Clean.adv") }],
  },
  "offbeat-serum-midbass-right": {
    device: "Analog",
    preset: analog("Muted Wow Bass.adv"),
    gainDb: -15,
    pan: 0.68,
    effects: [{ kind: "native", device: "Amp", preset: amp("Clean.adv") }],
  },
  "metallic-pluck": {
    device: "Collision",
    preset: collision("Mallets", "Bells Attack.adv"),
    gainDb: -2,
    pan: 0.12,
    effects: [
      {
        kind: "max",
        amxd: maxEffect("Max AutoFilter", "Max AutoFilter.amxd"),
      },
    ],
  },
  "wide-atmosphere": {
    device: "Collision",
    preset: collision("Ambient & Evolving", "Noisy Pad.adv"),
    gainDb: -6,
    pan: -0.08,
    effects: [
      {
        kind: "max",
        amxd: maxEffect("Chorus x2", "Chorus x2.amxd"),
      },
    ],
  },
};

const tracks = source.tracks.map((track) => {
  if (track.kind === "sample") {
    return {
      id: track.id,
      kind: "sample",
      sample: track.sample,
      gainDb: track.gainDb ?? 0,
      pan: track.pan ?? 0,
      velocityAmount: track.velocityAmount ?? 1,
      effects:
        track.id === "ableton-rim-answers"
          ? [
              {
                kind: "max",
                amxd: maxEffect("Tapped Delay", "Tapped Delay.amxd"),
              },
            ]
          : [],
      triggers: track.triggers.map(({ beat, velocity }) => ({ beat, velocity })),
    };
  }
  const replacement = native[track.id];
  if (!replacement) throw new Error(`No Ableton-native migration for ${track.id}`);
  return {
    id: track.id,
    kind: "native",
    device: replacement.device,
    preset: replacement.preset,
    gainDb: replacement.gainDb,
    pan: replacement.pan,
    effects: replacement.effects,
    notes: track.notes,
  };
});

const graph = {
  schemaVersion: 1,
  title: `${source.title} — Ableton Native Graph`,
  bpm: source.bpm,
  bars: source.bars,
  beatsPerBar: source.beatsPerBar,
  sampleRate: source.sampleRate,
  tailSeconds: source.master?.tailSeconds ?? 3,
  master: {
    inputGainDb: 0,
    outputGainDb: 0,
    effects: [
      {
        kind: "object",
        object:
          "abl.device.limiter~ @maximize 1 @threshold -11 @output -1 @link 1 @autorelease 1 @lookahead 2",
      },
    ],
  },
  conditioning: {
    reference: "/Users/gakonst/Music/boris/Boris Brejcha, Laura Korinth - Gravity.mp3",
    profile: "/tmp/boris-brejcha-gravity-reference/gravity-taste-profile.json",
    arrangementSource: input,
    intent: "Original F-minor composition conditioned on Gravity's measured arrangement and mix profile",
  },
  tracks,
};

await writeFile(output, `${JSON.stringify(graph, null, 2)}\n`);
console.log(output);
