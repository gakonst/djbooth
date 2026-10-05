import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const here = import.meta.dirname;
const graphOutput = path.resolve(process.argv[2] ?? path.join(here, "glass-current-graph.json"));
const clipDirectory = path.resolve(process.argv[3] ?? path.join(here, "glass-current-clips"));
const renderDirectory = path.resolve(
  process.argv[4] ?? "/Users/gakonst/Library/Caches/djbooth/glass-current",
);
const coreLibrary = "/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Core Library";
const coreSamples = path.join(coreLibrary, "Samples");
const patchRoot = path.resolve(here, "../serum/patches");
const recipes = JSON.parse(
  await readFile(path.join(here, "ableton-tutorial-recipes.json"), "utf8"),
).recipes;

const bpm = 124;
const bars = 72;
const beatsPerBar = 4;
const beat = (bar, offset = 0) => bar * beatsPerBar + offset;
const note = (at, durationBeats, midi, velocity) => ({
  beat: at,
  durationBeats,
  note: midi,
  velocity,
});
const hit = (at, velocity) => ({ beat: at, velocity });
const placements = (...ranges) =>
  ranges.map(([startBar, endBar]) => ({
    startBeat: beat(startBar),
    endBeat: beat(endBar),
  }));
const sample = (relative) => path.join(coreSamples, relative);
const effects = (id) =>
  recipes[id].chain.map(({ kind, device, preset }) => ({ kind, device, preset }));

// F# minor: two bars each of F#m(add9), Dmaj7, A(add9), and E6.
const harmonyA = [
  { root: 30, chord: [54, 57, 61, 68] },
  { root: 30, chord: [54, 57, 61, 64] },
  { root: 26, chord: [50, 54, 57, 61] },
  { root: 26, chord: [54, 57, 61, 64] },
  { root: 33, chord: [57, 61, 64, 71] },
  { root: 33, chord: [57, 61, 64, 68] },
  { root: 28, chord: [52, 56, 59, 61] },
  { root: 28, chord: [56, 59, 61, 66] },
];

// The second state opens on Bm7, creating a real harmonic lift instead of a mute-only variation.
const harmonyB = [
  { root: 35, chord: [59, 62, 66, 69] },
  { root: 35, chord: [54, 59, 62, 66] },
  { root: 26, chord: [50, 54, 57, 61] },
  { root: 26, chord: [54, 57, 61, 64] },
  { root: 30, chord: [54, 57, 61, 68] },
  { root: 30, chord: [57, 61, 64, 69] },
  { root: 28, chord: [52, 56, 59, 61] },
  { root: 28, chord: [56, 59, 61, 66] },
];

function bassPattern(harmony, state) {
  return harmony.flatMap(({ root }, bar) => {
    const nextRoot = harmony[(bar + 1) % harmony.length].root;
    const common = [
      note(beat(bar, 0.5), 0.42, root, 116),
      note(beat(bar, 1.5), 0.3, root + 12, 92),
      note(beat(bar, 2.25), 0.46, root, 110),
      note(beat(bar, 3.25), 0.3, root + 7, 88),
    ];
    if (state === "B" && bar % 2 === 1) {
      common.push(note(beat(bar, 3.72), 0.18, nextRoot, 78));
    }
    return common;
  });
}

const leadA = [
  note(0.5, 0.28, 69, 93),
  note(1, 0.28, 73, 102),
  note(1.5, 0.48, 76, 108),
  note(2.25, 1.08, 78, 115),
  note(3.62, 0.28, 76, 94),
  note(4.5, 0.38, 73, 101),
  note(5.12, 0.38, 69, 94),
  note(5.75, 0.62, 68, 106),
  note(6.75, 0.78, 66, 110),
  note(8.5, 0.28, 69, 92),
  note(9, 0.28, 73, 101),
  note(9.5, 0.46, 76, 108),
  note(10.25, 0.72, 81, 116),
  note(11.25, 0.42, 78, 102),
  note(12.5, 0.34, 76, 99),
  note(13, 0.34, 73, 96),
  note(13.5, 0.62, 71, 109),
  note(14.5, 0.3, 69, 98),
  note(15, 0.78, 68, 111),
  note(16.5, 0.28, 73, 98),
  note(17, 0.28, 76, 105),
  note(17.5, 0.46, 81, 113),
  note(18.25, 1.08, 85, 119),
  note(19.62, 0.28, 81, 98),
  note(20.5, 0.38, 80, 104),
  note(21.12, 0.38, 76, 98),
  note(21.75, 0.62, 73, 109),
  note(22.75, 0.78, 71, 112),
  note(24.5, 0.28, 73, 94),
  note(25, 0.28, 76, 102),
  note(25.5, 0.46, 80, 111),
  note(26.25, 0.72, 78, 106),
  note(27.25, 0.38, 76, 99),
  note(28.5, 0.28, 73, 104),
  note(29, 0.28, 71, 101),
  note(29.5, 0.28, 69, 98),
  note(30, 0.28, 68, 96),
  note(30.5, 0.28, 66, 93),
  note(31, 0.82, 61, 111),
];

const leadB = leadA.map((event, index) => ({
  ...event,
  beat: event.beat + (index % 6 === 0 ? -0.12 : 0),
  note: event.note + (event.beat < 8 ? 2 : event.beat >= 16 && event.beat < 24 ? 0 : 2),
  velocity: Math.min(121, event.velocity + (index % 5 === 0 ? 5 : 0)),
}));

const serumClips = [
  {
    id: "bass-a",
    patch: "maz-focused-bass.json",
    notes: bassPattern(harmonyA, "A"),
    gainDb: -2,
    tailSeconds: 0.4,
  },
  {
    id: "bass-b",
    patch: "maz-focused-bass.json",
    notes: bassPattern(harmonyB, "B"),
    gainDb: -2,
    tailSeconds: 0.4,
  },
  {
    id: "lead-a",
    patch: "smalltown-neon-lead.json",
    notes: leadA,
    gainDb: -2,
    tailSeconds: 2,
  },
  {
    id: "lead-b",
    patch: "smalltown-neon-lead.json",
    notes: leadB,
    gainDb: -2,
    tailSeconds: 2,
  },
];

await mkdir(clipDirectory, { recursive: true });
await mkdir(renderDirectory, { recursive: true });
for (const clip of serumClips) {
  const specification = {
    schemaVersion: 1,
    title: `glass-current-${clip.id}`,
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
  await writeFile(
    path.join(clipDirectory, `${clip.id}.json`),
    `${JSON.stringify(specification, null, 2)}\n`,
  );
}

const clipTrack = (id, source, ranges, gainDb, recipe, pan = 0) => ({
  id,
  kind: "sample",
  sample: path.join(renderDirectory, `${source}.wav`),
  gainDb,
  pan,
  velocityAmount: 0,
  loopBeats: 32,
  placements: placements(...ranges),
  triggers: [hit(0, 127)],
  effects: recipe ? effects(recipe) : [],
});

const drumTrack = (id, source, triggers, loopBars, ranges, gainDb, recipe, options = {}) => ({
  id,
  kind: "sample",
  sample: sample(source),
  gainDb,
  pan: options.pan ?? 0,
  velocityAmount: options.velocityAmount ?? 0.45,
  loopBeats: loopBars * beatsPerBar,
  placements: placements(...ranges),
  triggers,
  effects: recipe ? effects(recipe) : [],
});

function chordStabs(harmony, startBar, endBar, denser = false) {
  const notes = [];
  for (let bar = startBar; bar < endBar; bar += 1) {
    const chord = harmony[bar % 8].chord;
    const offsets = denser ? [0.75, 2.75, 3.5] : [0.75, 2.75];
    for (const [hitIndex, offset] of offsets.entries()) {
      chord.forEach((midi, voice) => {
        notes.push(
          note(
            beat(bar, offset + voice * 0.007),
            hitIndex === offsets.length - 1 ? 0.26 : 0.34,
            midi + 12,
            68 + hitIndex * 7 - voice * 3 + ((bar * 5) % 7),
          ),
        );
      });
    }
  }
  return notes;
}

function marimbaResponses(harmony, ranges, lifted = false) {
  const notes = [];
  for (const [startBar, endBar] of ranges) {
    for (let bar = startBar; bar < endBar; bar += 2) {
      const chord = harmony[bar % 8].chord;
      const tones = lifted
        ? [chord[1] + 24, chord[3] + 24, chord[2] + 24, chord[0] + 24]
        : [chord[1] + 12, chord[3] + 12, chord[2] + 12, chord[0] + 12];
      [0.78, 1.54, 2.29, 3.55].forEach((offset, index) => {
        notes.push(note(beat(bar, offset), index === 2 ? 0.32 : 0.2, tones[index], 72 + index * 5));
      });
    }
  }
  return notes;
}

function padChords() {
  const notes = [];
  for (const [startBar, endBar, harmony, octave] of [
    [0, 8, harmonyA, 12],
    [32, 40, harmonyB, 12],
    [56, 64, harmonyA, 24],
  ]) {
    for (let bar = startBar; bar < endBar; bar += 2) {
      harmony[bar % 8].chord.forEach((midi, voice) => {
        notes.push(note(beat(bar), 7.45, midi + octave, 38 + voice * 3));
      });
    }
  }
  return notes;
}

const kick = [0, 1, 2, 3].map((at, index) => hit(at, index === 0 ? 122 : 113));
const kickPeak = [0, 1, 2, 2.75, 3].map((at, index) => hit(at, index === 3 ? 76 : 116));
const clap = [1, 3].map((at, index) => hit(at, index ? 113 : 108));
const hats = Array.from({ length: 8 }, (_, index) =>
  hit(index * 0.5, index % 2 ? 91 : 55 + ((index * 7) % 16)),
);
const shaker = Array.from({ length: 16 }, (_, index) =>
  hit(
    index * 0.25 + (index % 4 === 3 ? 0.035 : 0),
    index % 4 === 2 ? 92 : 48 + ((index * 13) % 30),
  ),
);
const openHat = [0.5, 2.5].map((at) => hit(at, 86));
const rim = [0.75, 1.75, 2.75, 3.5].map((at, index) => hit(at, 65 + index * 6));
const fill = [28.5, 29.5, 30.5, 31, 31.25, 31.5, 31.75].map((at, index) => hit(at, 70 + index * 7));

const graph = {
  schemaVersion: 1,
  title: "Glass Current — melodic house study",
  bpm,
  bars,
  beatsPerBar,
  sampleRate: 44100,
  tailSeconds: 4,
  master: {
    inputGainDb: 7,
    outputGainDb: 0,
    effects: [
      {
        kind: "object",
        object: "abl.device.channeleq~ @lowgain 0.15 @midfreq 520 @midgain -0.3 @highgain 0.55",
      },
      {
        kind: "object",
        object:
          "abl.device.limiter~ @maximize 1 @threshold -10 @output -1 @link 1 @autorelease 1 @lookahead 2",
      },
    ],
  },
  provenance: {
    knowledgeBase: path.join(here, "ableton-knowledge-base/knowledge-base.json"),
    principles: [
      "role-before-device",
      "parallel-preserves-identity",
      "mono-foundation-wide-detail",
      "dynamics-follow-groove",
      "delay-is-arrangement",
      "section-contrast",
    ],
    composition:
      "two harmonic states, two bass performances, two hook states, Collision call-and-response, seven orchestration sections",
    audioRuntime:
      "Serum VST2 plus installed Ableton Collision, Core Library samples, native processors, and factory presets",
    customAudioDsp: false,
  },
  tracks: [
    clipTrack(
      "bass-a",
      "bass-a",
      [
        [8, 32],
        [56, 72],
      ],
      4.5,
      "lowEndAuthority",
    ),
    clipTrack("bass-b", "bass-b", [[40, 56]], 4.5, "lowEndAuthority"),
    clipTrack(
      "lead-a-dry",
      "lead-a",
      [
        [16, 32],
        [64, 72],
      ],
      4,
      null,
    ),
    clipTrack(
      "lead-a-depth",
      "lead-a",
      [
        [16, 32],
        [64, 72],
      ],
      -4,
      "leadWideEcho",
      0.09,
    ),
    clipTrack(
      "lead-b-dry",
      "lead-b",
      [
        [40, 48],
        [48, 56],
      ],
      4,
      null,
    ),
    clipTrack(
      "lead-b-depth",
      "lead-b",
      [
        [40, 48],
        [48, 56],
      ],
      -4.5,
      "leadPerspective",
      -0.09,
    ),
    {
      id: "collision-chord-stabs",
      kind: "native",
      device: "Collision",
      preset: path.join(
        coreLibrary,
        "Devices/Instruments/Collision/Guitar & Plucked/Acoustic String.adv",
      ),
      gainDb: 1.8,
      pan: -0.1,
      effects: [
        {
          kind: "object",
          object:
            "abl.dsp.chorus~ @mix 0.22 @width 0.88 @rate 0.1 @mod 0.18 @feedback 0.04 @gain 1",
        },
        {
          kind: "object",
          object: "abl.device.reverb~ @decay 0.95 @damping 0.64 @predelay 0.016 @mix 0.11",
        },
      ],
      notes: [
        ...chordStabs(harmonyA, 0, 16, false),
        ...chordStabs(harmonyA, 16, 32, true),
        ...chordStabs(harmonyB, 32, 40, false),
        ...chordStabs(harmonyB, 40, 56, true),
        ...chordStabs(harmonyA, 56, 72, true),
      ],
    },
    {
      id: "collision-marimba-response",
      kind: "native",
      device: "Collision",
      preset: path.join(coreLibrary, "Devices/Instruments/Collision/Mallets/Marimba Classic.adv"),
      gainDb: 0.8,
      pan: 0.27,
      effects: [
        {
          kind: "object",
          object:
            "abl.dsp.chorus~ @mix 0.14 @width 0.76 @rate 0.085 @mod 0.12 @feedback 0.03 @gain 1",
        },
        {
          kind: "object",
          object: "abl.device.echo~ @feedback 0.31 @mix 0.17 @reverb 0.1 @wobble 0.018",
        },
      ],
      notes: [
        ...marimbaResponses(harmonyA, [[24, 32]], false),
        ...marimbaResponses(harmonyB, [[48, 56]], false),
        ...marimbaResponses(harmonyA, [[64, 72]], true),
      ],
    },
    {
      id: "collision-air-pad",
      kind: "native",
      device: "Collision",
      preset: path.join(
        coreLibrary,
        "Devices/Instruments/Collision/Ambient & Evolving/Noisy Pad.adv",
      ),
      gainDb: 7.5,
      pan: 0,
      effects: [
        {
          kind: "object",
          object:
            "abl.dsp.chorus~ @mix 0.26 @width 0.92 @rate 0.06 @mod 0.2 @feedback 0.04 @gain 1",
        },
        {
          kind: "object",
          object: "abl.device.reverb~ @decay 2.15 @damping 0.6 @predelay 0.026 @mix 0.22",
        },
        {
          kind: "object",
          object: "abl.device.utility~ @bass_mono 1 @bass_mono_frequency 160 @gain 0",
        },
      ],
      notes: padChords(),
    },
    drumTrack(
      "kick-main",
      "One Shots/Drums/Kick/Kick DMX.wav",
      kick,
      1,
      [
        [8, 32],
        [36, 48],
        [60, 64],
      ],
      -7,
      "kickAuthority",
      { velocityAmount: 0.25 },
    ),
    drumTrack(
      "kick-peak",
      "One Shots/Drums/Kick/Kick DMX.wav",
      kickPeak,
      1,
      [
        [48, 56],
        [64, 72],
      ],
      -11,
      "kickAuthority",
      { velocityAmount: 0.28 },
    ),
    drumTrack(
      "clap",
      "One Shots/Drums/Clap/Clap 707.wav",
      clap,
      1,
      [
        [12, 32],
        [40, 56],
        [60, 72],
      ],
      -11,
      "clapDimension",
      { velocityAmount: 0.32, pan: 0.04 },
    ),
    drumTrack(
      "closed-hats",
      "One Shots/Drums/Hihat/Hihat Closed DMX.wav",
      hats,
      1,
      [
        [8, 32],
        [36, 56],
        [60, 72],
      ],
      -15,
      "hatAir",
      { velocityAmount: 0.58, pan: -0.08 },
    ),
    drumTrack(
      "shaker",
      "One Shots/Drums/Shaker/Shaker GrooveShadow.wav",
      shaker,
      1,
      [
        [4, 16],
        [20, 32],
        [36, 56],
        [60, 72],
      ],
      -17,
      "hatAir",
      { velocityAmount: 0.68, pan: 0.11 },
    ),
    drumTrack(
      "open-hat",
      "One Shots/Drums/Hihat/Hihat Open DMX.wav",
      openHat,
      1,
      [
        [16, 32],
        [40, 56],
        [64, 72],
      ],
      -15,
      null,
      { velocityAmount: 0.35, pan: 0.13 },
    ),
    drumTrack(
      "rim-syncopation",
      "One Shots/Drums/Rim/Rim GR.wav",
      rim,
      1,
      [
        [0, 8],
        [12, 32],
        [32, 40],
        [44, 72],
      ],
      -15,
      "percussionElectricity",
      { velocityAmount: 0.5, pan: -0.16 },
    ),
    drumTrack(
      "tom-fills",
      "One Shots/Drums/Tom/Tom DMX Fatso 2.wav",
      fill,
      8,
      [
        [8, 32],
        [40, 72],
      ],
      -15,
      "percussionElectricity",
      { velocityAmount: 0.52, pan: -0.07 },
    ),
    {
      id: "section-crashes",
      kind: "sample",
      sample: sample("One Shots/Drums/Cymbal/Crash DMX.wav"),
      gainDb: -17,
      pan: 0.09,
      velocityAmount: 0.2,
      triggers: [8, 16, 32, 40, 48, 56, 64].map((bar) => hit(beat(bar), 108)),
    },
    {
      id: "transition-risers",
      kind: "sample",
      sample: sample("One Shots/FX/Riser Whoosh Up.wav"),
      gainDb: -19,
      pan: -0.08,
      velocityAmount: 0.2,
      triggers: [15, 31, 39, 55, 63].map((bar) => hit(beat(bar), 106)),
      effects: effects("leadPerspective"),
    },
  ],
};

await writeFile(graphOutput, `${JSON.stringify(graph, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      graph: graphOutput,
      clipDirectory,
      renderDirectory,
      serumClips: serumClips.length,
      tracks: graph.tracks.length,
      nativeInstrumentTracks: graph.tracks.filter((track) => track.kind === "native").length,
      nativeEffectStages:
        graph.master.effects.length +
        graph.tracks.reduce((total, track) => total + (track.effects?.length ?? 0), 0),
    },
    null,
    2,
  ),
);
