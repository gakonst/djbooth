import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(
  process.argv[2] ?? path.join(here, "maz-brazilian-ableton-graph.json"),
);

const core = "/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Core Library";
const samples = path.join(core, "Samples");
const devices = path.join(core, "Devices");
const atSample = (relative) => path.join(samples, relative);
const atDevice = (relative) => path.join(devices, relative);
const hit = (beat, velocity = 100) => ({ beat, velocity });
const note = (beat, durationBeats, midi, velocity = 100) => ({
  beat,
  durationBeats,
  note: midi,
  velocity,
});
const b = (bar, beat = 0) => bar * 4 + beat;

const inRanges = (ranges, callback) => {
  for (const [start, end] of ranges) {
    for (let bar = start; bar < end; bar += 1) callback(bar);
  }
};

// The timing contour follows measurements from the separated reference drums:
// straight quarter-note anchors, energetic 4e/4a answers, and late swung ghosts.
// Notes and motifs below are original and intentionally do not reproduce the reference vocal.
const kick = [];
inRanges(
  [
    [0, 32],
    [40, 64],
  ],
  (bar) => {
    for (let quarter = 0; quarter < 4; quarter += 1) {
      if (bar < 2 && (quarter === 1 || quarter === 3)) continue;
      if (bar >= 40 && bar < 44 && quarter === 3) continue;
      kick.push(hit(b(bar, quarter), quarter === 0 ? 124 : 117));
    }
  },
);

const rim = [];
inRanges(
  [
    [4, 32],
    [38, 64],
  ],
  (bar) => {
    rim.push(hit(b(bar, 1.01), 94), hit(b(bar, 3.015), 103));
    if (bar % 4 === 3) rim.push(hit(b(bar, 3.73), 62));
  },
);

const shaker = [];
const shakerPattern = [
  [0.02, 102],
  [0.27, 48],
  [0.515, 66],
  [0.78, 93],
  [1.01, 106],
  [1.285, 51],
  [1.53, 87],
  [1.79, 77],
  [2.015, 108],
  [2.29, 49],
  [2.535, 67],
  [2.795, 95],
  [3.01, 109],
  [3.285, 52],
  [3.54, 90],
  [3.805, 79],
];
inRanges(
  [
    [0, 36],
    [38, 64],
  ],
  (bar) => {
    const energy = bar < 8 || (bar >= 32 && bar < 44) ? 0.78 : 1;
    for (const [offset, velocity] of shakerPattern) {
      shaker.push(hit(b(bar, offset), Math.max(1, Math.round(velocity * energy))));
    }
  },
);

const congaLow = [];
const congaHigh = [];
const bongo = [];
inRanges(
  [
    [2, 32],
    [40, 64],
  ],
  (bar) => {
    const turn = bar % 4 === 3;
    for (const [offset, velocity] of [
      [0.77, 92],
      [1.76, 72],
      [2.52, 100],
      [3.78, turn ? 112 : 81],
    ]) {
      congaLow.push(hit(b(bar, offset), velocity));
    }
    for (const [offset, velocity] of [
      [0.515, 65],
      [1.535, 94],
      [2.785, 77],
      [3.535, 102],
    ]) {
      congaHigh.push(hit(b(bar, offset), velocity));
    }
    for (const [offset, velocity] of [
      [0.285, 56],
      [1.285, 75],
      [2.03, 62],
      [3.285, 70],
    ]) {
      if (bar % 2 === 0 || offset > 3) bongo.push(hit(b(bar, offset), velocity));
    }
    if (turn) {
      bongo.push(hit(b(bar, 3.53), 86), hit(b(bar, 3.79), 105));
    }
  },
);

const clave = [];
inRanges(
  [
    [8, 32],
    [44, 64],
  ],
  (bar) => {
    if (bar % 2 === 0) {
      clave.push(hit(b(bar, 0.76), 86), hit(b(bar, 2.51), 72), hit(b(bar, 3.76), 96));
    } else {
      clave.push(hit(b(bar, 1.51), 76), hit(b(bar, 2.76), 91));
    }
  },
);

const agogo = [];
for (const bar of [7, 15, 23, 30, 39, 47, 55, 62]) {
  agogo.push(hit(b(bar, 1.52), 74), hit(b(bar, 2.77), 91), hit(b(bar, 3.52), 64));
}

const openHat = [];
inRanges(
  [
    [16, 32],
    [48, 64],
  ],
  (bar) => {
    openHat.push(hit(b(bar, 1.5), 79), hit(b(bar, 3.5), bar % 4 === 3 ? 101 : 88));
  },
);

const build = [];
for (let step = 0; step < 16; step += 1) {
  build.push(hit(b(47, step * 0.25 + (step > 7 ? 0.015 : 0)), 48 + step * 5));
}

const reverse = [b(15, 3.48), b(31, 3.48), b(47, 3.48), b(63, 3.48)].map((beat) =>
  hit(beat, 102),
);

// F# minor with an original tonic-pedal movement: F#m - E - D - C#m.
const roots = [30, 28, 26, 25];
const bass = [];
inRanges(
  [
    [8, 32],
    [46, 64],
  ],
  (bar) => {
    const root = roots[Math.floor(bar / 2) % roots.length];
    const variation = bar % 4 === 3;
    for (const [offset, duration, interval, velocity] of [
      [0.06, 0.16, 0, 74],
      [0.72, 0.34, 0, 111],
      [1.48, 0.24, 7, 94],
      [2.22, 0.42, 0, 117],
      [3.47, 0.3, variation ? 12 : 0, 103],
    ]) {
      bass.push(note(b(bar, offset), duration, root + interval, velocity));
    }
    if (variation) bass.push(note(b(bar, 3.76), 0.14, root + 7, 76));
  },
);

const guitar = [];
const chordVoicings = [
  [54, 57, 61], // F#m
  [52, 56, 59], // E
  [50, 54, 57], // D
  [49, 52, 56], // C#m
];
inRanges(
  [
    [16, 32],
    [48, 64],
  ],
  (bar) => {
    const chord = chordVoicings[Math.floor(bar / 2) % chordVoicings.length];
    for (const [offset, velocity] of [
      [1.02, 76],
      [2.765, 91],
    ]) {
      for (const midi of chord) guitar.push(note(b(bar, offset), 0.18, midi, velocity));
    }
  },
);

const marimba = [];
const motifA = [66, 69, 73, 76];
const motifB = [73, 71, 69, 64];
inRanges(
  [
    [24, 32],
    [48, 64],
  ],
  (bar) => {
    if (bar % 2 === 1) return;
    const motif = bar % 4 === 0 ? motifA : motifB;
    for (const [index, offset] of [0.78, 1.54, 2.79, 3.55].entries()) {
      marimba.push(note(b(bar, offset), index === 2 ? 0.34 : 0.22, motif[index], 82 + index * 5));
    }
    if (bar % 8 === 6) marimba.push(note(b(bar, 3.8), 0.15, 78, 104));
  },
);

const pad = [];
for (let bar = 32; bar < 40; bar += 2) {
  const chord = chordVoicings[((bar - 32) / 2) % chordVoicings.length];
  for (const midi of chord) pad.push(note(b(bar), 7.55, midi + 12, 65));
}
for (const bar of [56, 60]) {
  for (const midi of chordVoicings[Math.floor(bar / 2) % chordVoicings.length]) {
    pad.push(note(b(bar), 15.5, midi + 12, 48));
  }
}

const sampleTrack = (id, sample, triggers, gainDb, pan = 0, effects = []) => ({
  id,
  kind: "sample",
  sample: atSample(sample),
  velocityAmount: 0.72,
  gainDb,
  pan,
  effects,
  triggers,
});

const object = (text) => ({ kind: "object", object: text });

const graph = {
  schemaVersion: 1,
  title: "Folha Nova — Maz-conditioned Brazilian Afro House",
  bpm: 126,
  bars: 64,
  beatsPerBar: 4,
  sampleRate: 44100,
  tailSeconds: 4,
  master: {
    inputGainDb: -1.5,
    outputGainDb: 0,
    effects: [
      object("abl.device.channeleq~ @lowgain 0.5 @midfreq 420 @midgain -0.7 @highgain 0.8"),
      object("abl.device.limiter~ @maximize 1 @threshold -10 @output -1 @link 1 @autorelease 1 @lookahead 2"),
    ],
  },
  conditioning: {
    reference: "/Users/gakonst/Music/madarae-hd/Luedji Luna - Banho de Folhas (Maz (BR) Remix).wav",
    profile: "/tmp/maz-banho-reference/banho-taste-profile.json",
    intent:
      "Original F#-minor composition conditioned on measured Maz groove, stem balance and phrase grammar; no reference audio is reused",
  },
  tracks: [
    sampleTrack(
      "kick",
      "One Shots/Drums/Kick/Kick 909 Prommer.wav",
      kick,
      0.5,
      0,
      [object("abl.device.channeleq~ @lowgain 1.2 @midfreq 340 @midgain -1.5 @highgain -0.8")],
    ),
    sampleTrack(
      "rim",
      "One Shots/Drums/Rim/Rim Sidestick Gen Purpose.aif",
      rim,
      -6.5,
      0.08,
      [object("abl.device.reverb~ @decay 0.75 @damping 0.62 @predelay 0.012 @mix 0.09")],
    ),
    sampleTrack(
      "shaker",
      "One Shots/Drums/Shaker/Shaker Acoustic.aif",
      shaker,
      -10.5,
      -0.25,
      [object("abl.device.channeleq~ @lowgain -6 @midfreq 1800 @midgain -1 @highgain 1.5")],
    ),
    sampleTrack(
      "conga-low",
      "One Shots/Drums/Conga/Conga Acoustified Low.wav",
      congaLow,
      -6.5,
      -0.18,
      [object("abl.device.roar~ @input_gain 0 @blend 0.1 @shaper_amount_1 0.16 @tone_frequency 800 @tone_amount 0.08")],
    ),
    sampleTrack(
      "conga-high",
      "One Shots/Drums/Conga/Conga Acoustified Hi.wav",
      congaHigh,
      -6,
      0.22,
      [object("abl.device.reverb~ @decay 0.55 @damping 0.7 @predelay 0.008 @mix 0.06")],
    ),
    sampleTrack(
      "bongo",
      "One Shots/Drums/Bongo/Bongo Shy and Dry.aif",
      bongo,
      -6.5,
      0.42,
    ),
    sampleTrack(
      "clave",
      "One Shots/Drums/Wood/Wood Claves.aif",
      clave,
      -9,
      -0.4,
      [object("abl.device.echo~ @feedback 0.18 @mix 0.08 @reverb 0.04 @wobble 0")],
    ),
    sampleTrack(
      "agogo",
      "One Shots/Drums/Bell/Bells Agogo Hi.aif",
      agogo,
      -10.5,
      0.5,
      [object("abl.device.echo~ @feedback 0.26 @mix 0.13 @reverb 0.1 @wobble 0.02")],
    ),
    sampleTrack(
      "open-hat",
      "One Shots/Drums/Hihat/Hihat Open 909.aif",
      openHat,
      -11,
      0.08,
    ),
    sampleTrack(
      "build-shaker",
      "One Shots/Drums/Shaker/Shaker Low Short.wav",
      build,
      -8,
      -0.05,
    ),
    sampleTrack(
      "reverse-cymbal",
      "One Shots/Drums/Cymbal/Cymbal Crash Reverse Gnirob.wav",
      reverse,
      -9,
      0.1,
      [object("abl.device.reverb~ @decay 1.4 @damping 0.55 @predelay 0 @mix 0.18")],
    ),
    {
      id: "analog-bass",
      kind: "native",
      device: "Analog",
      preset: atDevice("Instruments/Analog/Bass/Muted Wow Bass.adv"),
      gainDb: 24,
      pan: 0,
      effects: [
        object("abl.device.utility~ @bass_mono 1 @bass_mono_frequency 180 @mono 0 @gain 0"),
        object("abl.device.roar~ @input_gain 0 @blend 0.07 @shaper_amount_1 0.12 @tone_frequency 500 @tone_amount 0.05"),
      ],
      notes: bass,
    },
    {
      id: "muted-guitar",
      kind: "native",
      device: "Collision",
      preset: atDevice("Instruments/Collision/Guitar & Plucked/Acoustic String.adv"),
      gainDb: 5.5,
      pan: -0.25,
      effects: [
        object("abl.dsp.chorus~ @mix 0.24 @width 0.82 @rate 0.12 @mod 0.2 @feedback 0.06 @gain 1"),
        object("abl.device.reverb~ @decay 0.9 @damping 0.64 @predelay 0.014 @mix 0.11"),
      ],
      notes: guitar,
    },
    {
      id: "marimba",
      kind: "native",
      device: "Collision",
      preset: atDevice("Instruments/Collision/Mallets/Marimba Classic.adv"),
      gainDb: 2.5,
      pan: 0.25,
      effects: [
        object("abl.dsp.chorus~ @mix 0.14 @width 0.7 @rate 0.09 @mod 0.12 @feedback 0.03 @gain 1"),
        object("abl.device.echo~ @feedback 0.31 @mix 0.17 @reverb 0.1 @wobble 0.025"),
      ],
      notes: marimba,
    },
    {
      id: "breakdown-pad",
      kind: "native",
      device: "Collision",
      preset: atDevice("Instruments/Collision/Ambient & Evolving/Noisy Pad.adv"),
      gainDb: 11.5,
      pan: 0,
      effects: [
        object("abl.dsp.chorus~ @mix 0.3 @width 0.9 @rate 0.07 @mod 0.24 @feedback 0.05 @gain 1"),
        object("abl.device.reverb~ @decay 2.2 @damping 0.58 @predelay 0.024 @mix 0.24"),
        object("abl.device.utility~ @bass_mono 1 @bass_mono_frequency 150 @gain 0"),
      ],
      notes: pad,
    },
  ],
};

await writeFile(output, `${JSON.stringify(graph, null, 2)}\n`);
console.log(output);
