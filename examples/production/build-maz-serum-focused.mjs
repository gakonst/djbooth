import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const graphOutput = path.resolve(
  process.argv[2] ?? path.join(here, "maz-serum-focused-graph.json"),
);
const clipDirectory = path.resolve(
  process.argv[3] ?? path.join(here, "serum-clips"),
);
const renderDirectory = path.resolve(
  process.argv[4] ?? "/Users/gakonst/Library/Caches/djbooth/maz-serum-focused",
);

const core = "/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Core Library";
const samples = path.join(core, "Samples");
const importedRoot = "/Users/gakonst/Library/Caches/djbooth/maz-ableton-orchestration";
const patchRoot = path.resolve(here, "../serum/patches");
const bpm = 123;
const bars = 96;
const beatsPerBar = 4;
const beat = (bar, offset = 0) => bar * beatsPerBar + offset;
const note = (at, durationBeats, midi, velocity) => ({
  beat: at,
  durationBeats,
  note: midi,
  velocity,
});
const hit = (at, velocity) => ({ beat: at, velocity });
const slug = (value) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const imported = {
  house909: await readJson(path.join(importedRoot, "909-house.json")),
  house808: await readJson(path.join(importedRoot, "808-house.json")),
  spirit: await readJson(path.join(importedRoot, "spirit-percussion.json")),
};

const placeImportedTrack = (clip, sourceId, prefix, ranges, options = {}) => {
  const source = clip.tracks.find((track) => track.id === sourceId);
  if (!source) throw new Error(`Missing ${sourceId} in ${clip.title}`);
  return {
    id: `${prefix}-${slug(source.id)}`,
    kind: "sample",
    sample: source.sample,
    velocityAmount: source.velocityAmount ?? 1,
    gainDb: source.gainDb + (options.gainOffsetDb ?? 0),
    pan: options.pan ?? 0,
    loopBeats: clip.bars * clip.beatsPerBar,
    placements: ranges.map(([startBar, endBar]) => ({
      startBeat: beat(startBar),
      endBeat: beat(endBar),
    })),
    triggers: source.triggers.map((trigger) =>
      hit(
        trigger.beat,
        Math.max(1, Math.min(127, Math.round(trigger.velocity * (options.velocityScale ?? 1)))),
      ),
    ),
  };
};

const progression = [37, 33, 40, 35]; // C#m - A - E - B, two bars per chord.
const bassNotes = [];
for (let bar = 0; bar < 8; bar += 1) {
  const root = progression[Math.floor(bar / 2)];
  const pattern = bar % 2 === 0
    ? [
        [0.52, 0.28, 0, 113],
        [1.76, 0.22, 0, 91],
        [2.72, 0.34, 0, 118],
      ]
    : [
        [0.28, 0.18, 0, 82],
        [1.5, 0.32, 0, 111],
        [3.48, 0.26, bar === 7 ? 7 : 0, 103],
      ];
  for (const [offset, duration, interval, velocity] of pattern) {
    bassNotes.push(note(beat(bar, offset), duration, root + interval, velocity));
  }
}

// A single call-and-response phrase. Empty bars are deliberate breathing room.
const pluckNotes = [
  note(0.76, 0.23, 68, 92),
  note(2.74, 0.32, 71, 80),
  note(6.5, 0.2, 73, 101),
  note(7.26, 0.18, 71, 72),
  note(10.76, 0.34, 68, 88),
  note(14.5, 0.42, 64, 97),
  note(16.76, 0.22, 68, 78),
  note(18.5, 0.28, 71, 91),
  note(22.74, 0.38, 76, 103),
  note(26.5, 0.23, 73, 84),
  note(27.5, 0.17, 71, 69),
  note(30.75, 0.45, 68, 96),
];

const airChords = [
  [56, 63, 68],
  [56, 61, 64],
  [56, 59, 66],
  [54, 59, 64],
];
const airNotes = [];
for (let chord = 0; chord < airChords.length; chord += 1) {
  for (const [voice, midi] of airChords[chord].entries()) {
    airNotes.push(note(beat(chord * 2, voice * 0.025), 7.45, midi, 47 + voice * 4));
  }
}

const serumClips = [
  {
    id: "serum-pulse-bass",
    file: "maz-focused-bass.json",
    patch: "maz-focused-bass.json",
    notes: bassNotes,
    gainDb: 0,
    tailSeconds: 0.8,
    placements: [[16, 32], [48, 88]],
    graphGainDb: 7,
    pan: 0,
  },
  {
    id: "serum-glasswood-hook",
    file: "maz-focused-pluck.json",
    patch: "maz-focused-pluck.json",
    notes: pluckNotes,
    gainDb: -2,
    tailSeconds: 2.2,
    placements: [[24, 32], [40, 48], [56, 80]],
    graphGainDb: 11,
    pan: 0.08,
  },
  {
    id: "serum-air-bed",
    file: "maz-focused-air.json",
    patch: "maz-focused-air.json",
    notes: airNotes,
    gainDb: -4,
    tailSeconds: 4,
    placements: [[0, 16], [32, 48], [80, 96]],
    graphGainDb: 7,
    pan: -0.04,
  },
];

await mkdir(clipDirectory, { recursive: true });
await mkdir(renderDirectory, { recursive: true });
for (const clip of serumClips) {
  const spec = {
    schemaVersion: 1,
    title: clip.id,
    bpm,
    bars: 8,
    beatsPerBar,
    sampleRate: 44100,
    master: { inputGainDb: 0, tailSeconds: clip.tailSeconds },
    tracks: [
      {
        id: clip.id,
        kind: "serum",
        patch: path.join(patchRoot, clip.patch),
        gainDb: clip.gainDb,
        notes: clip.notes,
      },
    ],
  };
  await writeFile(path.join(clipDirectory, clip.file), `${JSON.stringify(spec, null, 2)}\n`);
}

const graph = {
  schemaVersion: 1,
  title: "Canopy Focus — Ableton percussion and Serum identity",
  bpm,
  bars,
  beatsPerBar,
  sampleRate: 44100,
  tailSeconds: 5,
  master: { inputGainDb: -4.5, outputGainDb: 0, effects: [] },
  provenance: {
    arrangement: "Reference-informed original C# minor Afro/Brazilian house arrangement",
    abletonSources: Object.values(imported).map((clip) => clip.title),
    serumPatches: serumClips.map((clip) => path.join(patchRoot, clip.patch)),
    customAudioDsp: false,
  },
  tracks: [
    placeImportedTrack(imported.house909, "36-bass-drum", "core909", [[8, 32], [48, 88]], {
      gainOffsetDb: 3.4,
      velocityScale: 1.16,
    }),
    placeImportedTrack(imported.house909, "39-hand-clap", "core909", [[16, 32], [48, 80]], {
      gainOffsetDb: -1.8,
      velocityScale: 1,
      pan: 0.03,
    }),
    placeImportedTrack(imported.house808, "42-closed-hi-hat", "core808", [[8, 32], [48, 88]], {
      gainOffsetDb: -6.8,
      velocityScale: 0.76,
      pan: -0.13,
    }),
    placeImportedTrack(imported.house808, "44-maracas", "core808", [[12, 32], [48, 80]], {
      gainOffsetDb: -5.6,
      velocityScale: 0.82,
      pan: 0.18,
    }),
    placeImportedTrack(imported.spirit, "36-drum-voice", "spirit-low", [[0, 32], [40, 88]], {
      gainOffsetDb: 1.2,
      velocityScale: 0.91,
      pan: -0.18,
    }),
    placeImportedTrack(imported.spirit, "43-drum-voice", "spirit-high", [[8, 32], [48, 80]], {
      gainOffsetDb: -0.8,
      velocityScale: 0.86,
      pan: 0.21,
    }),
    placeImportedTrack(imported.spirit, "50-drum-voice", "spirit-cabasa", [[0, 32], [40, 88]], {
      gainOffsetDb: -5.2,
      velocityScale: 0.78,
      pan: 0.3,
    }),
    ...serumClips.map((clip) => ({
      id: clip.id,
      kind: "sample",
      sample: path.join(renderDirectory, clip.file.replace(/\.json$/, ".wav")),
      velocityAmount: 0,
      gainDb: clip.graphGainDb,
      pan: clip.pan,
      loopBeats: beat(8),
      placements: clip.placements.map(([startBar, endBar]) => ({
        startBeat: beat(startBar),
        endBeat: beat(endBar),
      })),
      triggers: [hit(0, 127)],
    })),
    {
      id: "ableton-riser",
      kind: "sample",
      sample: path.join(samples, "One Shots/FX/Riser Whoosh Up.wav"),
      velocityAmount: 0.35,
      gainDb: -15,
      pan: 0,
      triggers: [beat(31, 1.1), beat(47, 1.1), beat(79, 1.1)].map((at) => hit(at, 104)),
    },
    {
      id: "ableton-impact",
      kind: "sample",
      sample: path.join(samples, "One Shots/FX/Impact Current.wav"),
      velocityAmount: 0.35,
      gainDb: -15.5,
      pan: -0.05,
      triggers: [32, 48, 80].map((bar) => hit(beat(bar), 108)),
    },
  ],
};

await writeFile(graphOutput, `${JSON.stringify(graph, null, 2)}\n`);
console.log(JSON.stringify({ graph: graphOutput, clipDirectory, renderDirectory }, null, 2));
