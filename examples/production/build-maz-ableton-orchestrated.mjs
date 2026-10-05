import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const graphOutput = path.resolve(
  process.argv[2] ?? path.join(here, "maz-canopy-ableton-graph.json"),
);
const planOutput = path.resolve(
  process.argv[3] ?? path.join(here, "maz-canopy-ableton-plan.json"),
);

const core = "/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Core Library";
const devices = path.join(core, "Devices");
const racks = path.join(core, "Racks");
const samples = path.join(core, "Samples");
const importedRoot = "/Users/gakonst/Library/Caches/djbooth/maz-ableton-orchestration";
const transcriptionRoot =
  "/Users/gakonst/Library/Caches/djbooth/reference-corpora/maz-modern";

const atDevice = (relative) => path.join(devices, relative);
const atRack = (relative) => path.join(racks, relative);
const beat = (bar, offset = 0) => bar * 4 + offset;
const hit = (at, velocity) => ({ beat: at, velocity });
const note = (at, durationBeats, midi, velocity) => ({
  beat: at,
  durationBeats,
  note: midi,
  velocity,
});
const slug = (value) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const imported = {
  house909: await readJson(path.join(importedRoot, "909-house.json")),
  house808: await readJson(path.join(importedRoot, "808-house.json")),
  spirit: await readJson(path.join(importedRoot, "spirit-percussion.json")),
  shakerClave: await readJson(path.join(importedRoot, "shaker-clave.json")),
  acoustic: await readJson(path.join(importedRoot, "acoustic-percussion.json")),
};

// These are the upstream MuScriptor artifacts used as musical references. The
// production graph does not analyze audio or reproduce their notes: it uses the
// observed syncopated timing vocabulary to author a new C#-minor arrangement.
const transcriptionSources = [
  path.join(
    transcriptionRoot,
    "brisa/transcription/bass-78.541.events.json",
  ),
  path.join(
    transcriptionRoot,
    "ninguem/transcription/bass-195.486.events.json",
  ),
  path.join(
    transcriptionRoot,
    "todo-homem/transcription/bass-218.710.events.json",
  ),
];
await Promise.all(transcriptionSources.map(readJson));

const rangesContain = (ranges, bar) =>
  ranges.some(([start, end]) => bar >= start && bar < end);

const placeImportedClipTrack = (clip, sourceTrack, prefix, ranges, options = {}) => {
  const clipBeats = clip.bars * clip.beatsPerBar;
  return {
    id: `${prefix}-${slug(sourceTrack.id)}`,
    kind: "sample",
    sample: sourceTrack.sample,
    velocityAmount: sourceTrack.velocityAmount ?? 1,
    gainDb: sourceTrack.gainDb + (options.gainOffsetDb ?? 0),
    pan: options.pan ?? 0,
    loopBeats: clipBeats,
    placements: ranges.map(([startBar, endBar]) => ({
      startBeat: beat(startBar),
      endBeat: beat(endBar),
    })),
    triggers: sourceTrack.triggers.map((trigger) =>
      hit(
        trigger.beat,
        Math.max(
          1,
          Math.min(
            127,
            Math.round(trigger.velocity * (options.velocityScale ?? 1)),
          ),
        ),
      ),
    ),
  };
};

const importedTracks = (clip, prefix, ranges, options = {}) =>
  clip.tracks
    .filter((track) => !options.ids || options.ids.includes(track.id))
    .map((track, index) =>
      placeImportedClipTrack(clip, track, prefix, ranges, {
        gainOffsetDb: options.gainOffsetDb,
        velocityScale: options.velocityScale,
        pan: options.pans?.[index] ?? 0,
      }),
    );

const midiClip = (id, sourceNotes, anchorBar, loopBars, ranges) => {
  const start = beat(anchorBar);
  const loopBeats = beat(loopBars);
  return {
    id,
    loopBeats,
    placements: ranges.map(([startBar, endBar]) => ({
      startBeat: beat(startBar),
      endBeat: beat(endBar),
    })),
    notes: sourceNotes
      .filter((event) => event.beat >= start && event.beat < start + loopBeats)
      .map((event) => ({ ...event, beat: event.beat - start })),
  };
};

const kickRanges = [
  [8, 48],
  [76, 112],
  [120, 140],
];
const backbeatRanges = [
  [12, 48],
  [80, 112],
  [120, 136],
];
const hatRanges = [
  [8, 48],
  [72, 112],
  [120, 140],
];
const spiritRanges = [
  [0, 48],
  [56, 112],
  [120, 144],
];
const shakerClaveRanges = [
  [16, 48],
  [80, 104],
  [120, 136],
];
const fillRanges = [
  [30, 32],
  [46, 48],
  [70, 72],
  [78, 80],
  [102, 104],
  [110, 112],
  [134, 136],
];

const drums = [
  ...importedTracks(imported.house909, "core909", kickRanges, {
    ids: ["36-bass-drum"],
    gainOffsetDb: 4.0,
    velocityScale: 1.2,
  }),
  ...importedTracks(imported.house909, "core909", backbeatRanges, {
    ids: ["39-hand-clap"],
    gainOffsetDb: -1.5,
    velocityScale: 1.03,
    pans: [0.04],
  }),
  ...importedTracks(imported.house808, "core808", hatRanges, {
    ids: ["42-closed-hi-hat", "44-maracas"],
    gainOffsetDb: -5.5,
    velocityScale: 0.82,
    pans: [-0.18, 0.22],
  }),
  ...importedTracks(imported.spirit, "spirit", spiritRanges, {
    gainOffsetDb: 2.0,
    velocityScale: 0.94,
    pans: [-0.22, 0.2, -0.1, 0.27, -0.3, 0.3, 0.08],
  }),
  ...importedTracks(imported.shakerClave, "core-perc", shakerClaveRanges, {
    gainOffsetDb: -4.0,
    velocityScale: 0.9,
    pans: [-0.34, 0.28],
  }),
  ...importedTracks(imported.acoustic, "fill-perc", fillRanges, {
    gainOffsetDb: -3.0,
    velocityScale: 0.96,
    pans: [-0.25, 0.3, -0.12, 0.18, -0.34, 0.27, -0.05, 0.35],
  }),
];

// Original harmony: C#m9 - Amaj7 - Eadd9 - Bsus4, with two bars per chord.
const harmony = [
  { bass: 37, chord: [52, 56, 59, 63], upper: [64, 68, 71, 75] },
  { bass: 33, chord: [52, 56, 57, 61], upper: [61, 64, 68, 71] },
  { bass: 40, chord: [52, 56, 59, 66], upper: [64, 68, 71, 78] },
  { bass: 35, chord: [47, 52, 54, 59], upper: [59, 64, 66, 71] },
];
const harmonyAt = (bar) => harmony[Math.floor(bar / 2) % harmony.length];

const bassRanges = [
  [16, 48],
  [80, 104],
  [120, 136],
];
const bassNotes = [];
for (let bar = 0; bar < 144; bar += 1) {
  if (!rangesContain(bassRanges, bar)) continue;
  const root = harmonyAt(bar).bass;
  const pattern =
    bar % 2 === 0
      ? [
          [0.49, 0.24, 0, 106],
          [1.75, 0.2, 0, 91],
          [2.74, 0.31, 0, 114],
          [3.75, 0.16, bar % 8 === 6 ? 12 : 0, 83],
        ]
      : [
          [0.25, 0.17, 0, 80],
          [1.49, 0.3, 0, 110],
          [2.25, 0.18, 7, 86],
          [3.5, 0.28, 0, 116],
        ];
  for (const [offset, duration, interval, velocity] of pattern) {
    if (bar % 8 === 7 && offset === 2.25) continue;
    bassNotes.push(note(beat(bar, offset), duration, root + interval, velocity));
  }
}

const guitarRanges = [
  [12, 48],
  [56, 72],
  [80, 104],
  [112, 136],
];
const guitarNotes = [];
for (let bar = 0; bar < 144; bar += 1) {
  if (!rangesContain(guitarRanges, bar)) continue;
  const chord = harmonyAt(bar).chord.slice(1);
  const breakdown = bar >= 56 && bar < 72;
  const offsets = breakdown
    ? [0.75, 1.5, 2.75, 3.5]
    : bar % 2 === 0
      ? [0.76, 2.76]
      : [1.51, 3.26];
  offsets.forEach((offset, eventIndex) => {
    if (breakdown) {
      const midi = chord[(eventIndex + bar) % chord.length] + 12;
      guitarNotes.push(note(beat(bar, offset), 0.28, midi, 72 + eventIndex * 5));
      return;
    }
    chord.forEach((midi, voice) => {
      guitarNotes.push(
        note(
          beat(bar, offset + voice * 0.012),
          0.17 + voice * 0.018,
          midi + 12,
          72 + eventIndex * 9 - voice * 3,
        ),
      );
    });
  });
}

const pianoRanges = [
  [32, 48],
  [48, 72],
  [88, 104],
  [112, 136],
];
const pianoNotes = [];
for (let bar = 0; bar < 144; bar += 1) {
  if (!rangesContain(pianoRanges, bar)) continue;
  const chord = harmonyAt(bar).upper;
  const breakdown = bar >= 48 && bar < 72;
  if (breakdown) {
    const order = bar % 2 === 0 ? [0, 2, 1, 3] : [2, 1, 3, 0];
    order.forEach((voice, index) => {
      pianoNotes.push(
        note(beat(bar, 0.5 + index * 0.75), 0.48, chord[voice], 58 + index * 6),
      );
    });
  } else if (bar % 2 === 0) {
    chord.forEach((midi, voice) => {
      pianoNotes.push(note(beat(bar, 0.04 + voice * 0.008), 0.82, midi, 66 - voice * 2));
    });
    if (bar % 8 === 6) {
      pianoNotes.push(note(beat(bar, 3.5), 0.34, chord[2] + 12, 78));
    }
  }
}

const malletRanges = [
  [32, 48],
  [88, 104],
  [120, 136],
];
const malletNotes = [];
const malletMotifs = [
  [68, 71, 73, 75, 71],
  [64, 68, 71, 68, 63],
];
for (let bar = 0; bar < 144; bar += 1) {
  if (!rangesContain(malletRanges, bar) || bar % 2 === 1) continue;
  const motif = malletMotifs[Math.floor(bar / 4) % malletMotifs.length];
  [0.75, 1.5, 2.76, 3.5, 3.76].forEach((offset, index) => {
    malletNotes.push(
      note(beat(bar, offset), index === 4 ? 0.12 : 0.22, motif[index], 68 + index * 5),
    );
  });
}

const padRanges = [
  [0, 12],
  [48, 80],
  [104, 120],
  [136, 144],
];
const padNotes = [];
for (let bar = 0; bar < 144; bar += 2) {
  if (!rangesContain(padRanges, bar)) continue;
  harmonyAt(bar).upper.slice(0, 3).forEach((midi, voice) => {
    padNotes.push(note(beat(bar), 7.7, midi - 12, 48 + voice * 4));
  });
}

const hookRanges = [
  [40, 48],
  [96, 104],
  [128, 136],
];
const hookNotes = [];
const hook = [
  [0.76, 68, 0.34, 78],
  [1.5, 71, 0.22, 72],
  [2.75, 73, 0.44, 84],
  [3.5, 71, 0.2, 70],
  [4.5, 68, 0.3, 76],
  [5.76, 64, 0.48, 82],
  [7.25, 63, 0.24, 68],
  [7.75, 68, 0.18, 79],
];
for (const [startBar, endBar] of hookRanges) {
  for (let cycleBar = startBar; cycleBar < endBar; cycleBar += 4) {
    for (const [offset, midi, duration, velocity] of hook) {
      hookNotes.push(note(beat(cycleBar) + offset, duration, midi, velocity));
    }
  }
}

const majorTransitions = [48, 80, 104, 120, 136];
const longRisers = majorTransitions.map((bar) => hit(beat(bar) - 21.15, 88));
const transitionImpacts = [16, 32, ...majorTransitions].map((bar) => hit(beat(bar), 82));

const graph = {
  schemaVersion: 1,
  title: "Canopy Current — Ableton-orchestrated Brazilian Afro House",
  bpm: 123,
  bars: 144,
  beatsPerBar: 4,
  sampleRate: 44100,
  tailSeconds: 6,
  master: {
    inputGainDb: -7.5,
    outputGainDb: 0,
    effects: [],
  },
  provenance: {
    analysis: "djbooth MLX stems + MuScriptor transcription only",
    abletonClipImports: Object.values(imported).map((clip) => clip.title),
    transcriptionSources,
    audioRuntime: "Ableton native instruments, Core Library samples and factory effects",
    customAudioDsp: false,
  },
  tracks: [
    ...drums,
    {
      id: "analog-bass",
      kind: "native",
      device: "Analog",
      preset: atDevice("Instruments/Analog/Bass/Muted Wow Bass.adv"),
      gainDb: 17.5,
      pan: 0,
      effects: [],
      notes: bassNotes,
    },
    {
      id: "nylon-guitar",
      kind: "native",
      device: "Collision",
      preset: atDevice("Instruments/Collision/Guitar & Plucked/Acoustic String.adv"),
      gainDb: 1.5,
      pan: -0.18,
      effects: [],
      notes: guitarNotes,
    },
    {
      id: "electric-piano",
      kind: "native",
      device: "Electric",
      preset: atDevice("Instruments/Electric/Piano & Keys/E-Piano MKI Mellow.adv"),
      gainDb: 4.5,
      pan: 0.14,
      effects: [],
      clips: [
        midiClip("normal", pianoNotes, 32, 8, [
          [32, 48],
          [88, 104],
          [112, 136],
        ]),
        midiClip("breakdown", pianoNotes, 48, 8, [[48, 72]]),
      ],
    },
    {
      id: "marimba-answer",
      kind: "native",
      device: "Electric",
      preset: atDevice(
        "Instruments/Electric/Piano & Keys/Wurli Marimba Piano.adv",
      ),
      gainDb: 1.0,
      pan: 0.24,
      effects: [],
      clips: [midiClip("answer", malletNotes, 32, 8, malletRanges)],
    },
    {
      id: "analog-pad",
      kind: "native",
      device: "Collision",
      preset: atDevice("Instruments/Collision/Ambient & Evolving/Noisy Pad.adv"),
      gainDb: 8.5,
      pan: 0,
      effects: [],
      notes: padNotes,
    },
    {
      id: "harp-hook",
      kind: "native",
      device: "Collision",
      preset: atDevice("Instruments/Collision/Guitar & Plucked/Tube Harp.adv"),
      gainDb: -1.0,
      pan: 0.18,
      effects: [],
      notes: hookNotes,
    },
    {
      id: "transition-riser",
      kind: "sample",
      sample: path.join(samples, "One Shots/FX/Riser Whoosh Up.wav"),
      velocityAmount: 0.65,
      gainDb: -11.0,
      pan: 0,
      effects: [],
      triggers: longRisers,
    },
    {
      id: "transition-impact",
      kind: "sample",
      sample: path.join(samples, "One Shots/FX/Impact Layered Reversed.wav"),
      velocityAmount: 0.65,
      gainDb: -13.0,
      pan: -0.08,
      effects: [],
      triggers: transitionImpacts,
    },
  ],
};

const fx = (relative) => atDevice(`Audio Effects/${relative}`);
const plan = {
  schemaVersion: 1,
  title: graph.title,
  graph: graphOutput,
  postProcess: {
    "analog-bass": [
      fx("Glue Compressor/Bass - Punch.adv"),
      fx("Roar/Bass Fattener.adv"),
    ],
    "nylon-guitar": [
      fx("Glue Compressor/Guitar - Controlled Dynamics.adv"),
      fx("Chorus-Ensemble/Chorus Subtle Funk.adv"),
      fx("Reverb/Room/Guitar Room.adv"),
    ],
    "electric-piano": [
      fx("Chorus-Ensemble/Chorus Subtle Funk.adv"),
      fx("Reverb/Room/Ambience.adv"),
    ],
    "marimba-answer": [
      fx("Echo/Clean Delay/Digital Edge Ping Pong.adv"),
      fx("Reverb/Special/Short Ambience.adv"),
    ],
    "analog-pad": [
      fx("Chorus-Ensemble/Chorus Subtle Funk.adv"),
      fx("Reverb/Special/Wide Ambience.adv"),
    ],
    "harp-hook": [
      fx("Echo/Vintage Delay/Analog Triplet Dub.adv"),
      fx("Reverb/Room/Ambience Medium.adv"),
    ],
    "transition-riser": [
      fx("Reverb/Special/Bright Long Verb.adv"),
    ],
    "core909-39-hand-clap": [
      fx("Reverb/Special/Short Ambience.adv"),
    ],
    "core-perc-37-drum-voice": [
      fx("Echo/Clean Delay/Fake Dub Room.adv"),
    ],
  },
  master: [
    atRack("Audio Effect Racks/Mixing & Mastering/Master Punchy Dance.adg"),
  ],
  render: {
    dryStemsDirectory: "/Users/gakonst/Music/djbooth-candidates/maz-canopy-ableton/stems-dry",
    processedStemsDirectory:
      "/Users/gakonst/Music/djbooth-candidates/maz-canopy-ableton/stems-processed",
    finalMix: "/Users/gakonst/Music/djbooth-candidates/maz-canopy-ableton/canopy-current-master.wav",
  },
};

await writeFile(graphOutput, `${JSON.stringify(graph, null, 2)}\n`);
await writeFile(planOutput, `${JSON.stringify(plan, null, 2)}\n`);
console.log(JSON.stringify({ graph: graphOutput, plan: planOutput }, null, 2));
