import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const here = import.meta.dirname;
const graphOutput = path.resolve(
  process.argv[2] ?? path.join(here, "house-taste-showcase-graph.json"),
);
const clipDirectory = path.resolve(
  process.argv[3] ?? path.join(here, "house-taste-showcase-clips"),
);
const renderDirectory = path.resolve(
  process.argv[4] ?? "/Users/gakonst/Library/Caches/djbooth/house-taste-showcase",
);
const sidechainGraphOutput = path.join(renderDirectory, "kick-sidechain-graph.json");
const sidechainAudio = path.join(renderDirectory, "kick-sidechain.wav");
const premasterAudio = path.join(renderDirectory, "ritual-current-premaster.wav");
const masterGraphOutput = path.join(renderDirectory, "ritual-current-master-graph.json");
const coreLibrary = "/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Core Library";
const coreSamples = path.join(coreLibrary, "Samples");
const patchRoot = path.resolve(here, "../serum/patches");
const recipes = JSON.parse(
  await readFile(path.join(here, "ableton-tutorial-recipes.json"), "utf8"),
).recipes;
const productionBrief = path.join(here, "house-taste-corpus/production-brief.json");
const knowledgeBase = path.join(here, "house-taste-corpus/knowledge-base/taste-model.json");

const bpm = 126;
const bars = 112;
const beatsPerBar = 4;
const clipBars = 8;
const clipBeats = clipBars * beatsPerBar;
const beat = (bar, offset = 0) => bar * beatsPerBar + offset;
const note = (at, durationBeats, midi, velocity) => ({
  beat: Number(at.toFixed(6)),
  durationBeats: Number(durationBeats.toFixed(6)),
  note: midi,
  velocity: Math.max(1, Math.min(127, Math.round(velocity))),
});
const hit = (at, velocity) => ({
  beat: Number(at.toFixed(6)),
  velocity: Math.max(1, Math.min(127, Math.round(velocity))),
});
const placements = (...ranges) =>
  ranges.map(([startBar, endBar]) => ({
    startBeat: beat(startBar),
    endBeat: beat(endBar),
  }));
const sample = (relative) => path.join(coreSamples, relative);
const effectChain = (id) =>
  recipes[id].chain.map(({ kind, device, preset }) => ({ kind, device, preset }));

// Imported from Ableton's Swing 16ths 57.agr. Odd sixteenths land at .285 rather than .25.
const abletonGroove = {
  source: path.join(coreLibrary, "Grooves/Swing/Basic/Swing 16ths 57.agr"),
  oddSixteenthDelayBeats: 0.03499989593739594,
};
const deterministicJitter = (bar, step, amount = 0.006) => {
  const hash = Math.sin((bar + 1) * 91.17 + (step + 3) * 47.73) * 43758.5453;
  return ((hash - Math.floor(hash)) * 2 - 1) * amount;
};
const grooved = (bar, offset, amount = 1, jitter = 0) => {
  const step = Math.round(offset * 4);
  const delay = step % 2 === 1 ? abletonGroove.oddSixteenthDelayBeats * amount : 0;
  return beat(bar, offset + delay + deterministicJitter(bar, step, jitter));
};

// A minor with a controlled semitone-color state. Harmonic motion happens every two bars;
// rhythmic identity is allowed to repeat while pitch, octave, and response notes change.
const harmonyA = [
  { root: 33, chord: [57, 60, 64, 71] }, // Am(add9)
  { root: 29, chord: [53, 57, 60, 66] }, // Fmaj7(#11)
  { root: 36, chord: [55, 60, 64, 69] }, // C6/9
  { root: 31, chord: [55, 57, 62, 64] }, // G6sus2
];
const harmonyB = [
  { root: 38, chord: [57, 62, 65, 72] }, // Dm9
  { root: 33, chord: [53, 57, 60, 64] }, // Fmaj7/A
  { root: 34, chord: [58, 62, 65, 69] }, // Bbmaj7, semitone lift
  { root: 40, chord: [56, 59, 62, 69] }, // E7sus4(b9 color)
];

function foundationBass(harmony, variant) {
  const notes = [];
  for (let bar = 0; bar < clipBars; bar += 1) {
    const root = harmony[Math.floor(bar / 2) % harmony.length].root;
    const next = harmony[Math.floor((bar + 2) / 2) % harmony.length].root;
    const pattern = variant === "A" ? [0.5, 1.5, 2.5, 3.5] : [0.5, 1.5, 2.25, 3.5];
    for (const [index, offset] of pattern.entries()) {
      const approach = variant === "B" && bar % 2 === 1 && index === pattern.length - 1;
      notes.push(
        note(
          grooved(bar, offset, 0.72),
          index === 2 ? 0.31 : 0.38,
          approach ? next - 1 : root,
          112 - index * 4 + ((bar * 7 + index * 3) % 9),
        ),
      );
    }
  }
  return notes;
}

function acidIdentity(harmony, variant) {
  const notes = [];
  const cell = [0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.25, 3.75];
  for (let bar = 0; bar < clipBars; bar += 1) {
    const { root, chord } = harmony[Math.floor(bar / 2) % harmony.length];
    const next = harmony[Math.floor((bar + 2) / 2) % harmony.length].root;
    const pitchCell =
      variant === "A"
        ? [root + 12, root + 12, chord[1], root + 12, chord[2], root + 12, chord[1], root + 19]
        : [root + 12, chord[2], root + 13, chord[1], root + 12, chord[3], next + 11, next + 12];
    cell.forEach((offset, index) => {
      if ((bar + index) % 11 === 7) return;
      notes.push(
        note(
          grooved(bar, offset, 1, 0.004),
          index % 3 === 2 ? 0.34 : 0.18,
          pitchCell[index],
          74 + ((bar * 13 + index * 9) % 36),
        ),
      );
    });
  }
  return notes;
}

function driveSequence() {
  const notes = [];
  for (let bar = 0; bar < clipBars; bar += 1) {
    const { root, chord } = harmonyA[Math.floor(bar / 2) % harmonyA.length];
    const tones = [chord[0] + 12, chord[2] + 12, root + 24, chord[1] + 12];
    [0.75, 1.75, 2.75, 3.25].forEach((offset, index) => {
      notes.push(
        note(
          grooved(bar, offset, 0.92, 0.003),
          0.2,
          tones[(bar + index) % tones.length],
          65 + index * 7,
        ),
      );
    });
  }
  return notes;
}

const hookCellA = [
  [0.5, 0.28, 69, 94],
  [1.0, 0.24, 72, 103],
  [1.5, 0.62, 76, 112],
  [2.5, 0.28, 72, 91],
  [3.0, 0.74, 71, 106],
];
const hookCellB = [
  [0.25, 0.25, 72, 96],
  [0.75, 0.25, 76, 105],
  [1.25, 0.58, 81, 116],
  [2.25, 0.3, 77, 98],
  [2.75, 0.25, 76, 101],
  [3.25, 0.66, 74, 109],
];
function hookPhrase(variant) {
  const notes = [];
  const cell = variant === "A" ? hookCellA : hookCellB;
  const transpositions = variant === "A" ? [0, -4, 3, -2, 0, 5, 3, -2] : [0, 1, -4, 3, 0, 5, 7, -2];
  for (let bar = 0; bar < clipBars; bar += 1) {
    for (const [index, [offset, duration, midi, velocity]] of cell.entries()) {
      const octaveLift = bar >= 6 && index === 2 ? 12 : 0;
      notes.push(
        note(
          grooved(bar, offset, 0.34, 0.003),
          duration,
          midi + transpositions[bar] + octaveLift,
          velocity + ((bar * 5 + index * 3) % 7) - 3,
        ),
      );
    }
  }
  return notes;
}

function airGhostNotes() {
  return hookPhrase("B")
    .filter((_, index) => index % 3 === 1)
    .map((event, index) => ({
      ...event,
      beat: Number((event.beat + (index % 2 ? 0.5 : 0)).toFixed(6)),
      durationBeats: Math.min(1.4, event.durationBeats + 0.48),
      note: event.note + 12,
      velocity: Math.max(42, event.velocity - 38),
    }))
    .filter((event) => event.beat < clipBeats);
}

const serumClips = [
  {
    id: "sub-a",
    patch: "taste-house-sub-foundation.json",
    notes: foundationBass(harmonyA, "A"),
    gainDb: -3,
    tailSeconds: 0.5,
  },
  {
    id: "sub-b",
    patch: "taste-house-sub-foundation.json",
    notes: foundationBass(harmonyB, "B"),
    gainDb: -3,
    tailSeconds: 0.5,
  },
  {
    id: "acid-a",
    patch: "taste-house-acid-identity.json",
    notes: acidIdentity(harmonyA, "A"),
    gainDb: -5,
    tailSeconds: 0.6,
  },
  {
    id: "acid-b",
    patch: "taste-house-acid-identity.json",
    notes: acidIdentity(harmonyB, "B"),
    gainDb: -5,
    tailSeconds: 0.6,
  },
  {
    id: "drive",
    patch: "taste-house-acid-identity.json",
    notes: driveSequence(),
    gainDb: -8,
    tailSeconds: 0.6,
  },
  {
    id: "hook-a",
    patch: "taste-house-ritual-hook.json",
    notes: hookPhrase("A"),
    gainDb: -4,
    tailSeconds: 2.5,
  },
  {
    id: "hook-b",
    patch: "taste-house-ritual-hook.json",
    notes: hookPhrase("B"),
    gainDb: -4,
    tailSeconds: 2.5,
  },
  {
    id: "air-ghost",
    patch: "taste-house-air-ghost.json",
    notes: airGhostNotes(),
    gainDb: -8,
    tailSeconds: 3.5,
  },
];

await mkdir(clipDirectory, { recursive: true });
await mkdir(renderDirectory, { recursive: true });
await mkdir(path.join(renderDirectory, "presets"), { recursive: true });
for (const clip of serumClips) {
  const specification = {
    schemaVersion: 1,
    title: `house-taste-${clip.id}`,
    bpm,
    bars: clipBars,
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
  await writeFile(
    path.join(clipDirectory, `${clip.id}.json`),
    `${JSON.stringify(specification, null, 2)}\n`,
  );
}

// Derive a preset by changing parameters in Ableton's own Compressor ADV. The DSP remains
// Compressor2 from Live Engine; this file only stores a sidechain-oriented factory-preset state.
const compressorSource = path.join(
  coreLibrary,
  "Devices/Audio Effects/Compressor/Kick Reducer.adv",
);
const sidechainCompressor = path.join(renderDirectory, "presets/Taste Sidechain Pump.adv");
let compressorXml = gunzipSync(await readFile(compressorSource)).toString("utf8");
compressorXml = compressorXml
  .replace(/(<SideChain>\s*<OnOff>[\s\S]*?<Manual Value=")false(" \/>)/, "$1true$2")
  .replace(
    /(<Ratio>[\s\S]*?<Manual Value=")[^"]+(" \/>)/,
    (_, before, after) => `${before}4${after}`,
  )
  .replace(
    /(<Attack>[\s\S]*?<Manual Value=")[^"]+(" \/>)/,
    (_, before, after) => `${before}1.5${after}`,
  )
  .replace(
    /(<Release>[\s\S]*?<Manual Value=")[^"]+(" \/>)/,
    (_, before, after) => `${before}180${after}`,
  )
  .replace(
    /(<Threshold>[\s\S]*?<Manual Value=")[^"]+(" \/>)/,
    (_, before, after) => `${before}0.16${after}`,
  );
await writeFile(sidechainCompressor, gzipSync(compressorXml));

const masterGlueSource = path.join(
  coreLibrary,
  "Devices/Audio Effects/Glue Compressor/Mastering - Make It Loud.adv",
);
const masterGlue = path.join(renderDirectory, "presets/Taste Master Glue.adv");
let masterGlueXml = gunzipSync(await readFile(masterGlueSource)).toString("utf8");
masterGlueXml = masterGlueXml.replace(
  /(<Makeup>[\s\S]*?<Manual Value=")[^"]+(" \/>)/,
  (_, before, after) => `${before}9${after}`,
);
await writeFile(masterGlue, gzipSync(masterGlueXml));

const masterInputSource = path.join(coreLibrary, "Devices/Audio Effects/Utility/Narrow Stereo.adv");
const masterInput = path.join(renderDirectory, "presets/Taste Master Input.adv");
let masterInputXml = gunzipSync(await readFile(masterInputSource)).toString("utf8");
masterInputXml = masterInputXml
  .replace(
    /(<StereoWidth>[\s\S]*?<Manual Value=")[^"]+(" \/>)/,
    (_, before, after) => `${before}0.75${after}`,
  )
  .replace(
    /(<Gain>[\s\S]*?<Manual Value=")[^"]+(" \/>)/,
    (_, before, after) => `${before}1.995262${after}`,
  );
await writeFile(masterInput, gzipSync(masterInputXml));

const kickFour = [0, 1, 2, 3].map((offset, index) => hit(offset, index === 0 ? 124 : 116));
const sidechainGraph = {
  schemaVersion: 1,
  title: "House taste eight-bar kick sidechain",
  bpm,
  bars: clipBars,
  beatsPerBar,
  sampleRate: 44100,
  tailSeconds: 4,
  master: { inputGainDb: 0, outputGainDb: 0, effects: [] },
  tracks: [
    {
      id: "sidechain-kick",
      kind: "sample",
      sample: sample("One Shots/Drums/Kick/Kick 909 DMX 2.wav"),
      gainDb: 0,
      pan: 0,
      velocityAmount: 0.2,
      loopBeats: 4,
      placements: placements([0, 8]),
      triggers: kickFour,
    },
  ],
};
await writeFile(sidechainGraphOutput, `${JSON.stringify(sidechainGraph, null, 2)}\n`);

const nativeEffect = (device, preset, sidechain = null) => ({
  kind: "native",
  device,
  preset,
  ...(sidechain ? { sidechain } : {}),
});
const sidechainEffect = () => nativeEffect("Compressor2", sidechainCompressor, sidechainAudio);
const nativeClip = (id, notes, ranges) => ({
  id,
  loopBeats: clipBeats,
  placements: placements(...ranges),
  notes,
});
const nativeTrack = (id, device, preset, clips, gainDb, pan, effects = []) => ({
  id,
  kind: "native",
  device,
  preset: path.join(coreLibrary, "Devices/Instruments", preset),
  gainDb,
  pan,
  clips,
  effects,
});
const serumTrack = (id, clip, ranges, gainDb, recipe = null, pan = 0) => ({
  id,
  kind: "sample",
  sample: path.join(renderDirectory, `${clip}.wav`),
  gainDb,
  pan,
  velocityAmount: 0,
  loopBeats: clipBeats,
  placements: placements(...ranges),
  triggers: [hit(0, 127)],
  effects: recipe ? effectChain(recipe) : [],
});
const drumTrack = (id, source, triggers, loopBars, ranges, gainDb, recipe, options = {}) => ({
  id,
  kind: "sample",
  sample: sample(source),
  gainDb,
  pan: options.pan ?? 0,
  velocityAmount: options.velocityAmount ?? 0.48,
  loopBeats: loopBars * beatsPerBar,
  placements: placements(...ranges),
  triggers,
  effects: recipe ? effectChain(recipe) : [],
});

function chordStabs(harmony, dense = false) {
  const notes = [];
  for (let bar = 0; bar < clipBars; bar += 1) {
    const { chord } = harmony[Math.floor(bar / 2) % harmony.length];
    const offsets = dense ? [0.75, 2.75, 3.5] : [0.75, 2.75];
    offsets.forEach((offset, hitIndex) => {
      chord.forEach((midi, voice) => {
        notes.push(
          note(
            grooved(bar, offset + voice * 0.006, 0.78),
            hitIndex === offsets.length - 1 ? 0.22 : 0.31,
            midi + 12,
            57 + hitIndex * 8 - voice * 2 + ((bar * 5) % 8),
          ),
        );
      });
    });
  }
  return notes;
}

function balafonResponses(harmony, variant) {
  const notes = [];
  for (let bar = 0; bar < clipBars; bar += 1) {
    const { chord } = harmony[Math.floor(bar / 2) % harmony.length];
    const offsets = variant === "A" ? [0.75, 1.5, 2.75] : [0.5, 1.75, 2.5, 3.75];
    offsets.forEach((offset, index) => {
      notes.push(
        note(
          grooved(bar, offset, 0.9, 0.005),
          offset >= 3.7 ? 0.15 : index % 2 ? 0.25 : 0.18,
          chord[(bar + index) % chord.length] + (variant === "B" ? 24 : 12),
          62 + ((bar * 11 + index * 8) % 29),
        ),
      );
    });
  }
  return notes;
}

function mutedGuitarAnswers() {
  const notes = [];
  const pitchSets = [
    [69, 72, 76],
    [65, 69, 72],
    [67, 72, 76],
    [67, 71, 74],
  ];
  for (let bar = 0; bar < clipBars; bar += 2) {
    [1.75, 3.25, 5.5, 7.75].forEach((offset, index) => {
      notes.push(
        note(
          grooved(bar + Math.floor(offset / 4), offset % 4, 0.82, 0.004),
          0.21,
          pitchSets[Math.floor(bar / 2)][index % 3],
          61 + index * 7,
        ),
      );
    });
  }
  return notes;
}

function padChords(harmony) {
  const notes = [];
  for (let bar = 0; bar < clipBars; bar += 2) {
    harmony[Math.floor(bar / 2) % harmony.length].chord.forEach((midi, voice) => {
      notes.push(note(beat(bar, voice * 0.012), 7.35, midi, 37 + voice * 4));
    });
  }
  return notes;
}

function electricPianoSyncopation(harmony) {
  const notes = [];
  for (let bar = 0; bar < clipBars; bar += 1) {
    const chord = harmony[Math.floor(bar / 2) % harmony.length].chord;
    [1.5, 3.25].forEach((offset, index) => {
      [chord[0], chord[1], chord[3]].forEach((midi, voice) => {
        notes.push(
          note(
            grooved(bar, offset + voice * 0.008, 0.68),
            0.34,
            midi + 12,
            48 + index * 10 + voice * 3,
          ),
        );
      });
    });
  }
  return notes;
}

const kickDrop = [0, 1, 2, 3, 3.75].map((offset, index) => hit(offset, index === 4 ? 67 : 118));
const clap = [1, 3].map((offset, index) => hit(offset, index ? 112 : 107));
const clapGhost = [0.75, 1, 2.75, 3].map((offset, index) => hit(offset, index % 2 ? 108 : 43));
const offbeatHat = [0.5, 1.5, 2.5, 3.5].map((offset, index) => hit(offset, 82 + index * 3));
const closedHat = Array.from({ length: 16 }, (_, step) =>
  hit(grooved(0, step * 0.25, 1, 0.004), step % 4 === 2 ? 92 : 43 + ((step * 13) % 31)),
);
const liveShaker = Array.from({ length: 16 }, (_, step) =>
  hit(grooved(0, step * 0.25, 0.88, 0.008), step % 4 === 3 ? 89 : 46 + ((step * 17) % 35)),
);
const congaLow = [0.75, 1.75, 2.5, 3.75].map((offset, index) =>
  hit(grooved(0, offset, 0.94, 0.006), 68 + index * 6),
);
const congaHigh = [0.25, 1.25, 2.75, 3.25].map((offset, index) =>
  hit(grooved(0, offset, 1, 0.005), 59 + ((index * 11) % 25)),
);
const rim = [0.75, 1.75, 2.75, 3.5].map((offset, index) =>
  hit(grooved(0, offset, 0.86, 0.004), 58 + index * 8),
);
const tomFill = [29.5, 30.25, 30.75, 31.25, 31.5, 31.75].map((offset, index) =>
  hit(offset, 69 + index * 8),
);

const graph = {
  schemaVersion: 1,
  title: "Ritual Current — personal house taste model v1",
  bpm,
  bars,
  beatsPerBar,
  sampleRate: 44100,
  tailSeconds: 4,
  master: {
    inputGainDb: 5.25,
    outputGainDb: 0,
    effects: [],
  },
  provenance: {
    productionBrief,
    knowledgeBase,
    groove: abletonGroove,
    referenceRoles: {
      groove: "Ugo Banchi — Chase The 80's",
      arrangementContrast: "Adam Ten, Maori — Spring Girl",
      spatialDepth: "Adam Ten, J.Views — Rivers and Homes Retake",
      lowEndHierarchy: "Echonomist — Secret Places",
      melodicVocabulary: "personal Spotify/Rekordbox corpus plus Maz corpus",
    },
    serumLanguage: serumClips.map((clip) => clip.patch),
    audioRuntime:
      "Serum VST2, Ableton Live Engine instruments/effects, shipped abl.*~ master processors, and Core Library samples",
    customAudioDsp: false,
  },
  tracks: [
    serumTrack(
      "sub-a",
      "sub-a",
      [
        [8, 40],
        [48, 64],
        [88, 112],
      ],
      5.5,
      "lowEndAuthority",
    ),
    serumTrack("sub-b", "sub-b", [[72, 88]], 5.5, "lowEndAuthority"),
    serumTrack(
      "acid-a",
      "acid-a",
      [
        [16, 40],
        [48, 64],
        [88, 104],
      ],
      -0.5,
      "focusedPulse",
    ),
    serumTrack(
      "acid-b",
      "acid-b",
      [
        [72, 88],
        [96, 112],
      ],
      -1,
      "focusedPulse",
    ),
    serumTrack(
      "drive-sequence",
      "drive",
      [
        [24, 40],
        [56, 64],
        [80, 88],
        [96, 104],
      ],
      3,
      "leadPerspective",
      -0.04,
    ),
    serumTrack(
      "hook-a-dry",
      "hook-a",
      [
        [28, 40],
        [52, 64],
        [92, 104],
      ],
      2.5,
      null,
    ),
    serumTrack(
      "hook-a-depth",
      "hook-a",
      [
        [28, 40],
        [52, 64],
        [92, 104],
      ],
      -5.5,
      "leadWideEcho",
      0.1,
    ),
    serumTrack(
      "hook-b-dry",
      "hook-b",
      [
        [76, 88],
        [100, 108],
      ],
      2.2,
      null,
    ),
    serumTrack(
      "hook-b-depth",
      "hook-b",
      [
        [76, 88],
        [100, 108],
      ],
      -5.8,
      "leadPerspective",
      -0.1,
    ),
    serumTrack(
      "air-ghost",
      "air-ghost",
      [
        [36, 40],
        [60, 64],
        [84, 88],
        [108, 112],
      ],
      19,
      "granularEarCandy",
      0.17,
    ),
    nativeTrack(
      "analog-rear-pad",
      "Analog",
      "Analog/Synth Pad/Thick Chord Pad.adv",
      [
        nativeClip("pad-a", padChords(harmonyA), [
          [0, 8],
          [40, 48],
          [64, 72],
        ]),
        nativeClip("pad-b", padChords(harmonyB), [
          [80, 88],
          [104, 112],
        ]),
      ],
      -7,
      -0.04,
      [nativeEffect("HybridReverb", recipes.padDepth.chain[1].preset), sidechainEffect()],
    ),
    nativeTrack(
      "electric-syncopated-chords",
      "Electric",
      "Electric/Piano & Keys/E-Piano MKI Dirty.adv",
      [
        nativeClip("ep-a", electricPianoSyncopation(harmonyA), [
          [8, 24],
          [48, 56],
          [88, 96],
        ]),
        nativeClip("ep-b", electricPianoSyncopation(harmonyB), [
          [72, 80],
          [104, 112],
        ]),
      ],
      -2.5,
      0.08,
      [nativeEffect("Roar", recipes.padTapeDepth.chain[0].preset), sidechainEffect()],
    ),
    nativeTrack(
      "collision-chord-body",
      "Collision",
      "Collision/Guitar & Plucked/Acoustic String.adv",
      [
        nativeClip("stab-a", chordStabs(harmonyA, false), [
          [16, 32],
          [48, 64],
          [88, 104],
        ]),
        nativeClip("stab-b", chordStabs(harmonyB, true), [
          [72, 88],
          [96, 112],
        ]),
      ],
      -1.5,
      -0.12,
      [nativeEffect("GlueCompressor", recipes.focusedPulse.chain[1].preset), sidechainEffect()],
    ),
    nativeTrack(
      "collision-balafon",
      "Collision",
      "Collision/Mallets/Balafon Brushed.adv",
      [
        nativeClip("balafon-a", balafonResponses(harmonyA, "A"), [
          [8, 24],
          [48, 56],
          [88, 96],
        ]),
        nativeClip("balafon-b", balafonResponses(harmonyB, "B"), [
          [72, 88],
          [96, 104],
        ]),
      ],
      0.5,
      0.21,
      [nativeEffect("Delay", recipes.leadPerspective.chain[0].preset)],
    ),
    nativeTrack(
      "tension-muted-answer",
      "Tension",
      "Tension/Guitar & Plucked/Strat Muted Guitar.adv",
      [
        nativeClip("muted-answer", mutedGuitarAnswers(), [
          [24, 40],
          [56, 64],
          [80, 88],
          [96, 112],
        ]),
      ],
      -1,
      -0.22,
      [nativeEffect("Amp", path.join(coreLibrary, "Devices/Audio Effects/Amp/Clean.adv"))],
    ),
    nativeTrack(
      "collision-bell-signals",
      "Collision",
      "Collision/Mallets/Bells Random.adv",
      [
        nativeClip(
          "bell-signal",
          [
            note(3.75, 1.6, 81, 52),
            note(11.5, 1.4, 84, 46),
            note(19.75, 1.8, 79, 49),
            note(27.5, 2.1, 86, 55),
          ],
          [
            [32, 40],
            [40, 48],
            [64, 72],
            [80, 88],
            [104, 112],
          ],
        ),
      ],
      -7,
      0.28,
      [nativeEffect("HybridReverb", recipes.padDepth.chain[1].preset)],
    ),
    drumTrack(
      "kick-main",
      "One Shots/Drums/Kick/Kick 909 DMX 2.wav",
      kickFour,
      1,
      [
        [8, 40],
        [48, 64],
        [72, 88],
        [104, 112],
      ],
      -8,
      "kickAuthority",
      { velocityAmount: 0.24 },
    ),
    drumTrack(
      "kick-final",
      "One Shots/Drums/Kick/Kick 909 DMX 2.wav",
      kickDrop,
      1,
      [[88, 104]],
      -8.5,
      "kickAuthority",
      { velocityAmount: 0.27 },
    ),
    drumTrack(
      "kick-click",
      "One Shots/Drums/Kick/Kick 909 Click Layer.wav",
      kickFour,
      1,
      [
        [24, 40],
        [52, 64],
        [80, 112],
      ],
      -19,
      null,
      { velocityAmount: 0.2 },
    ),
    drumTrack(
      "clap-body",
      "One Shots/Drums/Clap/Clap 707.wav",
      clap,
      1,
      [
        [16, 40],
        [48, 64],
        [72, 112],
      ],
      -12,
      "clapDimension",
      { velocityAmount: 0.31, pan: 0.03 },
    ),
    drumTrack(
      "clap-ghost",
      "One Shots/Drums/Rim/Rim Clap ER.wav",
      clapGhost,
      1,
      [
        [24, 40],
        [56, 64],
        [80, 112],
      ],
      -19,
      "snareDepth",
      { velocityAmount: 0.52, pan: -0.07 },
    ),
    drumTrack(
      "offbeat-hat",
      "One Shots/Drums/Hihat/Hihat Open Vinyl DLG.wav",
      offbeatHat,
      1,
      [
        [16, 40],
        [48, 64],
        [72, 112],
      ],
      -16,
      "hatAir",
      { velocityAmount: 0.42, pan: 0.11 },
    ),
    drumTrack(
      "closed-hat-grid",
      "One Shots/Drums/Hihat/Hihat Closed Acoustic Fast.aif",
      closedHat,
      1,
      [
        [8, 40],
        [48, 64],
        [72, 112],
      ],
      -17,
      "hatAir",
      { velocityAmount: 0.72, pan: -0.09 },
    ),
    drumTrack(
      "live-shaker",
      "One Shots/Drums/Shaker/Shaker Live Vinyl.wav",
      liveShaker,
      1,
      [
        [0, 40],
        [40, 64],
        [68, 112],
      ],
      -17.5,
      "warmDrumColor",
      { velocityAmount: 0.78, pan: 0.16 },
    ),
    drumTrack(
      "conga-low",
      "One Shots/Drums/Tom/Tom Floor Dry Funk 1.wav",
      congaLow,
      1,
      [
        [8, 40],
        [48, 64],
        [72, 112],
      ],
      -17,
      "percussionElectricity",
      { velocityAmount: 0.56, pan: -0.18 },
    ),
    drumTrack(
      "conga-high",
      "One Shots/Drums/Tom/Tom Hi Taka School.wav",
      congaHigh,
      1,
      [
        [16, 40],
        [52, 64],
        [76, 112],
      ],
      -19,
      "percussionElectricity",
      { velocityAmount: 0.64, pan: 0.19 },
    ),
    drumTrack(
      "rim-interlock",
      "One Shots/Drums/Rim/Rim Taka Natural 1.wav",
      rim,
      1,
      [
        [0, 24],
        [32, 48],
        [56, 80],
        [88, 112],
      ],
      -17,
      "percussionElectricity",
      { velocityAmount: 0.61, pan: -0.23 },
    ),
    drumTrack(
      "tom-phrase-fills",
      "One Shots/Drums/Tom/Tom DMX Fatso 2.wav",
      tomFill,
      8,
      [
        [8, 40],
        [48, 64],
        [72, 112],
      ],
      -16,
      "warmDrumColor",
      { velocityAmount: 0.52, pan: -0.06 },
    ),
    {
      id: "section-crashes",
      kind: "sample",
      sample: sample("One Shots/Drums/Cymbal/Crash DMX.wav"),
      gainDb: -18,
      pan: 0.08,
      velocityAmount: 0.2,
      triggers: [8, 16, 24, 40, 48, 64, 72, 80, 88, 104].map((bar) =>
        hit(beat(bar), 101 + (bar % 3) * 5),
      ),
      effects: effectChain("leadPerspective"),
    },
    {
      id: "transition-risers",
      kind: "sample",
      sample: sample("One Shots/FX/Riser Whoosh Up.wav"),
      gainDb: -20,
      pan: -0.1,
      velocityAmount: 0.2,
      triggers: [15, 23, 39, 47, 63, 71, 79, 87, 103].map((bar) => hit(beat(bar), 108)),
      effects: effectChain("leadPerspective"),
    },
    {
      id: "water-transition-detail",
      kind: "sample",
      sample: sample("One Shots/FX/Blip Water.wav"),
      gainDb: -22,
      pan: 0.24,
      velocityAmount: 0.35,
      triggers: [35, 43, 59, 67, 83, 99, 107].map((bar, index) =>
        hit(beat(bar, index % 2 ? 2.75 : 3.5), 76 + index * 4),
      ),
      effects: effectChain("granularEarCandy"),
    },
  ],
};

await writeFile(graphOutput, `${JSON.stringify(graph, null, 2)}\n`);
const masterGraph = {
  schemaVersion: 1,
  title: "Ritual Current — Ableton master pass",
  bpm,
  bars,
  beatsPerBar,
  sampleRate: 44100,
  tailSeconds: 4,
  master: {
    inputGainDb: 0,
    outputGainDb: 0,
    effects: [],
  },
  tracks: [
    {
      id: "premaster",
      kind: "sample",
      sample: premasterAudio,
      gainDb: 2,
      pan: 0,
      velocityAmount: 0,
      triggers: [hit(0, 127)],
      effects: [
        nativeEffect("Utility", masterInput),
        nativeEffect(
          "Eq8",
          path.join(coreLibrary, "Devices/Audio Effects/EQ Eight/Filter/Dance Master.adv"),
        ),
        nativeEffect("GlueCompressor", masterGlue),
      ],
    },
  ],
};
await writeFile(masterGraphOutput, `${JSON.stringify(masterGraph, null, 2)}\n`);
const plan =
  `# Ritual Current\n\n` +
  `A 112-bar original production generated from the personal house taste corpus.\n\n` +
  `- Groove: Ugo Banchi reference profile plus Ableton Swing 16ths 57\n` +
  `- Form: nine contrasting states across 8- and 16-bar phrases\n` +
  `- Serum: mono foundation, acid identity, independent drive, foreground hook, air ghost\n` +
  `- Ableton: Analog, Electric, Collision, Tension, Compressor2 sidechain, factory preset chains, Core Library percussion\n` +
  `- DSP: only Serum and Ableton-shipped engines; no custom audio effects\n`;
await writeFile(path.join(renderDirectory, "production-plan.md"), plan);

console.log(
  JSON.stringify(
    {
      graph: graphOutput,
      premasterAudio,
      masterGraph: masterGraphOutput,
      sidechainGraph: sidechainGraphOutput,
      sidechainAudio,
      clipDirectory,
      renderDirectory,
      serumClips: serumClips.length,
      tracks: graph.tracks.length,
      nativeInstrumentTracks: graph.tracks.filter((track) => track.kind === "native").length,
      sampleTracks: graph.tracks.filter((track) => track.kind === "sample").length,
      nativeEffectStages: graph.tracks.reduce(
        (total, track) =>
          total + (track.effects?.filter((effect) => effect.kind === "native").length ?? 0),
        0,
      ),
      arrangement: [
        "ritual-intro",
        "groove-reveal",
        "motif-statement",
        "vacuum-break",
        "drop-one",
        "interlude",
        "tension-state",
        "final-payoff",
        "deconstruction",
      ],
    },
    null,
    2,
  ),
);
