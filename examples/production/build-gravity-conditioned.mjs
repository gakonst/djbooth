import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(process.argv[2] ?? path.join(here, "gravity-conditioned.json"));
const samples =
  "/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Core Library/Samples";
const at = (relative) => path.join(samples, relative);
const serumPatch = (name) => path.resolve(here, "../serum/patches", name);
const hit = (beat, velocity = 100, durationBeats = 0.1) => ({ beat, durationBeats, velocity });
const note = (beat, durationBeats, midi, velocity = 100) => ({
  beat,
  durationBeats,
  note: midi,
  velocity,
});
const b = (bar, beat = 0) => bar * 4 + beat;

const inRanges = (ranges, callback) => {
  for (const [start, end] of ranges) for (let bar = start; bar < end; bar += 1) callback(bar);
};

const kick = [];
inRanges(
  [
    [0, 24],
    [32, 48],
  ],
  (bar) => {
    for (let beat = 0; beat < 4; beat += 1) kick.push(hit(b(bar, beat), beat ? 117 : 124, 0.3));
  },
);

const clap = [];
inRanges(
  [
    [4, 24],
    [32, 48],
  ],
  (bar) => {
    clap.push(hit(b(bar, 1), 108, 0.2), hit(b(bar, 3), 114, 0.2));
  },
);

const hat = [];
inRanges(
  [
    [0, 24],
    [30, 48],
  ],
  (bar) => {
    for (let beat = 0; beat < 4; beat += 1) {
      hat.push(hit(b(bar, beat + 0.25), 52, 0.06));
      hat.push(hit(b(bar, beat + 0.75), beat === 3 ? 104 : 91, 0.07));
    }
  },
);

const openHat = [];
inRanges(
  [
    [8, 24],
    [32, 48],
  ],
  (bar) => {
    for (let beat = 0; beat < 4; beat += 1) {
      openHat.push(hit(b(bar, beat + 0.5), beat === 2 ? 102 : 91, 0.3));
    }
  },
);

const latePerc = [];
inRanges(
  [
    [4, 24],
    [32, 48],
  ],
  (bar) => {
    for (let beat = 0; beat < 4; beat += 1) {
      latePerc.push(hit(b(bar, beat + 0.75), beat === 3 ? 95 : 72, 0.08));
    }
  },
);

const bass = [];
const roots = [41, 41, 44, 39]; // F, F, Ab, Eb: an original F-minor cycle.
inRanges(
  [
    [0, 24],
    [32, 48],
  ],
  (bar) => {
    const root = roots[bar % roots.length];
    for (const [offset, duration, interval, velocity] of [
      [0.5, 0.28, 0, 116],
      [1.5, 0.24, 0, 106],
      [2.5, 0.3, bar % 4 === 3 ? 7 : 0, 112],
      [3.5, 0.22, bar % 8 === 7 ? 12 : 0, 102],
    ]) {
      bass.push(note(b(bar, offset), duration, root + interval, velocity));
    }
    if (bar % 4 === 3) bass.push(note(b(bar, 3.75), 0.12, root + 7, 81));
  },
);
const bassRight = bass.map((event) => ({ ...event, beat: event.beat + 0.012 }));

const pluck = [];
const motif = [65, 68, 63, 60, 68, 67, 63];
inRanges(
  [
    [8, 24],
    [32, 48],
  ],
  (bar) => {
    if (bar % 4 === 1 || bar % 4 === 3) return;
    const index = (bar * 2) % motif.length;
    pluck.push(note(b(bar, 0.75), 0.22, motif[index], 96));
    pluck.push(note(b(bar, 2.75), 0.2, motif[(index + 1) % motif.length], 84));
    if (bar % 8 === 6) pluck.push(note(b(bar, 3.5), 0.16, motif[(index + 3) % motif.length], 105));
  },
);

const atmosphere = [];
const breakdownChords = [
  [53, 56, 60],
  [51, 55, 58],
];
for (let bar = 24; bar < 32; bar += 2) {
  for (const midi of breakdownChords[(bar - 24) / 2 % 2]) {
    atmosphere.push(note(b(bar, 0), 7.5, midi, 76));
  }
}
for (const bar of [40, 44]) {
  atmosphere.push(note(b(bar), 7.5, 65, 54));
  atmosphere.push(note(b(bar), 7.5, 68, 50));
}

const buildHits = [];
for (let step = 0; step < 16; step += 1) {
  buildHits.push(hit(b(31, step * 0.25), 48 + step * 5, 0.06));
}

// First two bars of Ableton's "Rhumba Shaker-135bpm" groove. The timing and
// velocity contour come from the installed AGR; the pattern is repeated only
// in high-energy phrases so it remains detail rather than constant clutter.
const shakerGroove = [
  [0.016667, 120],
  [0.48125, 53],
  [0.7625, 85],
  [1, 123],
  [1.5, 56],
  [1.764583, 91],
  [1.985417, 125],
  [2.489583, 53],
  [2.745833, 87],
  [3.008333, 125],
  [3.495833, 52],
  [3.766667, 88],
  [4.0125, 121],
  [4.510417, 58],
  [4.75, 89],
  [5.014583, 122],
  [5.508333, 55],
  [5.747917, 86],
  [5.99375, 123],
  [6.485417, 54],
  [6.74375, 93],
  [6.989583, 124],
  [7.491667, 54],
  [7.75, 93],
];
const shaker = [];
for (const [startBar, endBar] of [
  [8, 24],
  [34, 48],
]) {
  for (let startBeat = b(startBar); startBeat < b(endBar); startBeat += 8) {
    for (const [offset, velocity] of shakerGroove) {
      if (startBeat + offset < b(endBar) - 0.2) {
        shaker.push(hit(startBeat + offset, velocity, 0.08));
      }
    }
  }
}

const rimAnswers = [];
for (const bar of [10, 14, 18, 22, 35, 38, 42, 46]) {
  rimAnswers.push(hit(b(bar, 2.72), bar % 4 === 2 ? 101 : 87, 0.1));
  if (bar === 22 || bar === 46) rimAnswers.push(hit(b(bar, 3.47), 72, 0.08));
}

const reverseCymbals = [b(6, 0.46), b(22, 0.46), b(30, 0.46), b(46, 0.46)].map((beat) =>
  hit(beat, 104, 0.1),
);

const tapeFloor = [];
for (let beat = 0; beat < b(48); beat += 12.45) tapeFloor.push(hit(beat, 100, 0.1));

const song = {
  schemaVersion: 1,
  title: "Reference Gravity — F Minor",
  bpm: 125,
  bars: 48,
  beatsPerBar: 4,
  sampleRate: 44100,
  master: { inputGainDb: 4, softClipDrive: 1.32, ceilingDb: -1, tailSeconds: 3 },
  tracks: [
    {
      id: "kick-body",
      kind: "sample",
      sample: at("One Shots/Drums/Kick/Kick 909 Prommer.wav"),
      oneShot: true,
      velocityAmount: 0.28,
      fadeOutSeconds: 0.008,
      gainDb: -2,
      lowPassHz: 10500,
      triggers: kick,
    },
    {
      id: "kick-click",
      kind: "sample",
      sample: at("One Shots/Drums/Kick/Kick 909 Click Layer.wav"),
      oneShot: true,
      velocityAmount: 0.32,
      fadeOutSeconds: 0.004,
      gainDb: -10,
      highPassHz: 1200,
      triggers: kick,
    },
    {
      id: "clap-909",
      kind: "sample",
      sample: at("One Shots/Drums/Clap/Clap 909 Reviv.wav"),
      oneShot: true,
      velocityAmount: 0.42,
      fadeOutSeconds: 0.01,
      gainDb: -7.5,
      highPassHz: 180,
      triggers: clap,
    },
    {
      id: "closed-hat-909",
      kind: "sample",
      sample: at("One Shots/Drums/Hihat/Hihat Closed 909.aif"),
      oneShot: true,
      velocityAmount: 0.72,
      fadeOutSeconds: 0.004,
      gainDb: -12,
      pan: -0.05,
      highPassHz: 700,
      chokeGroup: 1,
      triggers: [...hat, ...buildHits],
    },
    {
      id: "open-hat-909",
      kind: "sample",
      sample: at("One Shots/Drums/Hihat/Hihat Open 909.aif"),
      oneShot: true,
      velocityAmount: 0.52,
      fadeOutSeconds: 0.018,
      gainDb: -12.5,
      pan: 0.05,
      highPassHz: 620,
      chokeGroup: 1,
      triggers: openHat,
    },
    {
      id: "late-metal-perc",
      kind: "sample",
      sample: at("One Shots/Drums/Misc Percussion/Perc Metallic Clatter.aif"),
      oneShot: true,
      velocityAmount: 0.72,
      fadeOutSeconds: 0.006,
      gainDb: 0,
      pan: 0.08,
      highPassHz: 650,
      triggers: latePerc,
    },
    {
      id: "ride-909",
      kind: "sample",
      sample: at("One Shots/Drums/Ride/Ride 909.aif"),
      oneShot: true,
      velocityAmount: 0.35,
      fadeOutSeconds: 0.08,
      gainDb: -16,
      highPassHz: 500,
      triggers: [0, 32, 128, 160].map((beat) => hit(beat, 105, 1)),
    },
    {
      id: "ableton-rhumba-shaker",
      kind: "sample",
      sample: at("One Shots/Drums/Shaker/Shaker Transient.aif"),
      oneShot: true,
      velocityAmount: 0.78,
      fadeOutSeconds: 0.008,
      gainDb: -17,
      pan: -0.14,
      highPassHz: 2800,
      effects: [
        {
          kind: "saturator",
          driveDb: 6.1875,
          outputDb: -1.5,
          mix: 0.619,
          softClip: true,
        },
      ],
      triggers: shaker,
    },
    {
      id: "ableton-rim-answers",
      kind: "sample",
      sample: at("One Shots/Drums/Rim/Rim 3k Sharp.wav"),
      oneShot: true,
      velocityAmount: 0.65,
      fadeOutSeconds: 0.012,
      gainDb: -11.5,
      pan: 0.28,
      highPassHz: 850,
      effects: [
        {
          kind: "delay",
          leftBeats: 0.25,
          rightBeats: 0.5,
          feedback: 0.38,
          mix: 0.18,
          pingPong: true,
        },
      ],
      triggers: rimAnswers,
    },
    {
      id: "offbeat-serum-bass",
      kind: "serum",
      patch: serumPatch("tech-house-bass.json"),
      notes: bass,
      gainDb: 8.2,
      highPassHz: 24,
      lowPassHz: 5000,
      sidechain: {
        everyBeats: 1,
        holdBeats: 0.055,
        releaseBeats: 0.36,
        depthDb: -16,
        curve: 0.72,
      },
    },
    {
      id: "offbeat-serum-midbass-left",
      kind: "serum",
      patch: serumPatch("gravity-conditioned-midbass.json"),
      notes: bass,
      gainDb: -0.5,
      pan: -0.7,
      highPassHz: 155,
      lowPassHz: 4200,
      sidechain: {
        everyBeats: 1,
        holdBeats: 0.055,
        releaseBeats: 0.36,
        depthDb: -16,
        curve: 0.72,
      },
    },
    {
      id: "offbeat-serum-midbass-right",
      kind: "serum",
      patch: serumPatch("gravity-conditioned-midbass.json"),
      notes: bassRight,
      gainDb: -0.5,
      pan: 0.7,
      highPassHz: 155,
      lowPassHz: 4200,
      sidechain: {
        everyBeats: 1,
        holdBeats: 0.055,
        releaseBeats: 0.36,
        depthDb: -16,
        curve: 0.72,
      },
    },
    {
      id: "metallic-pluck",
      kind: "serum",
      patch: serumPatch("gravity-conditioned-pluck.json"),
      notes: pluck,
      gainDb: 9,
      highPassHz: 190,
      lowPassHz: 12000,
      effects: [
        {
          kind: "autoFilter",
          filterType: "lowPass",
          cutoffHz: 1400,
          resonance: 0.16,
          driveDb: 2,
          cutoffAutomation: [
            { beat: 0, cutoffHz: 900, curve: 1 },
            { beat: 32, cutoffHz: 1500, curve: 0.8 },
            { beat: 64, cutoffHz: 7200, curve: 1.4 },
            { beat: 95.9, cutoffHz: 11000, curve: 1.2 },
            { beat: 96, cutoffHz: 1800, curve: 1 },
            { beat: 128, cutoffHz: 2200, curve: 1 },
            { beat: 159.9, cutoffHz: 7800, curve: 1.3 },
            { beat: 160, cutoffHz: 1500, curve: 1 },
            { beat: 191.9, cutoffHz: 10500, curve: 1.25 },
          ],
        },
        {
          kind: "delay",
          leftBeats: 0.25,
          rightBeats: 0.5,
          feedback: 0.42,
          mix: 0.16,
          pingPong: true,
        },
      ],
      sidechain: {
        everyBeats: 1,
        holdBeats: 0.03,
        releaseBeats: 0.3,
        depthDb: -5,
        curve: 0.82,
      },
    },
    {
      id: "wide-atmosphere",
      kind: "serum",
      patch: serumPatch("gravity-conditioned-atmosphere.json"),
      notes: atmosphere,
      gainDb: 2.8,
      highPassHz: 220,
      lowPassHz: 10000,
      effects: [
        {
          kind: "autoFilter",
          filterType: "lowPass",
          cutoffHz: 900,
          resonance: 0.12,
          driveDb: 1.5,
          cutoffAutomation: [
            { beat: 0, cutoffHz: 700, curve: 1 },
            { beat: 96, cutoffHz: 650, curve: 1 },
            { beat: 124, cutoffHz: 5200, curve: 1.35 },
            { beat: 127.9, cutoffHz: 11000, curve: 0.8 },
            { beat: 128, cutoffHz: 2600, curve: 1 },
            { beat: 160, cutoffHz: 1800, curve: 1 },
            { beat: 175.9, cutoffHz: 7600, curve: 1.2 },
            { beat: 176, cutoffHz: 2300, curve: 1 },
            { beat: 191.9, cutoffHz: 8500, curve: 1.2 },
          ],
        },
      ],
      sidechain: {
        everyBeats: 1,
        holdBeats: 0.035,
        releaseBeats: 0.4,
        depthDb: -4,
        curve: 0.8,
      },
    },
    {
      id: "ableton-reverse-cymbal",
      kind: "sample",
      sample: at("One Shots/Drums/Cymbal/Cymbal Crash Reverse Gnirob.wav"),
      oneShot: true,
      velocityAmount: 0.25,
      fadeOutSeconds: 0.02,
      gainDb: -10.5,
      pan: 0.1,
      highPassHz: 420,
      lowPassHz: 12500,
      triggers: reverseCymbals,
    },
    {
      id: "ableton-tape-floor",
      kind: "sample",
      sample: at("Loops/Texture/Noise Tape Floor.wav"),
      oneShot: true,
      velocityAmount: 0,
      fadeOutSeconds: 0.08,
      gainDb: -30,
      pan: -0.06,
      highPassHz: 180,
      lowPassHz: 9000,
      triggers: tapeFloor,
    },
  ],
};

await writeFile(output, `${JSON.stringify(song, null, 2)}\n`);
console.log(output);
