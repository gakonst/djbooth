import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(process.argv[2] ?? path.join(here, "ableton-core-track.json"));
const pianoSource = JSON.parse(
  await readFile(path.join(here, "ableton-grand-piano-house.json"), "utf8"),
);

const coreSamples =
  "/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Core Library/Samples";

const sample = (relativePath) => path.join(coreSamples, relativePath);
const hit = (beat, velocity = 100, durationBeats = 0.125) => ({
  beat,
  durationBeats,
  velocity,
});
const note = (beat, durationBeats, midi, velocity = 100) => ({
  beat,
  durationBeats,
  note: midi,
  velocity,
});
const barBeat = (bar, beat = 0) => bar * 4 + beat;

const kickTriggers = [];
for (const [startBar, endBar] of [
  [2, 16],
  [19, 32],
]) {
  for (let bar = startBar; bar < endBar; bar += 1) {
    for (let beat = 0; beat < 4; beat += 1) {
      kickTriggers.push(hit(barBeat(bar, beat), beat === 0 ? 118 : 108, 0.2));
    }
  }
}

const clapTriggers = [];
for (const [startBar, endBar] of [
  [4, 16],
  [20, 31],
]) {
  for (let bar = startBar; bar < endBar; bar += 1) {
    clapTriggers.push(hit(barBeat(bar, 1), 104, 0.2));
    clapTriggers.push(hit(barBeat(bar, 3), 111, 0.2));
  }
}

const closedHatTriggers = [];
for (const [startBar, endBar] of [
  [4, 16],
  [18, 32],
]) {
  for (let bar = startBar; bar < endBar; bar += 1) {
    for (let step = 0; step < 8; step += 1) {
      const swung = step % 2 === 1 ? 0.055 : 0;
      const velocity = step % 2 === 0 ? 90 : 68;
      closedHatTriggers.push(hit(barBeat(bar, step * 0.5 + swung), velocity, 0.08));
    }
  }
}

const openHatTriggers = [];
for (const [startBar, endBar] of [
  [8, 16],
  [20, 30],
]) {
  for (let bar = startBar; bar < endBar; bar += 1) {
    for (let beat = 0.5; beat < 4; beat += 1) {
      openHatTriggers.push(hit(barBeat(bar, beat + 0.055), beat === 2.5 ? 98 : 85, 0.2));
    }
  }
}

const maracaTriggers = [];
for (const [startBar, endBar] of [
  [12, 16],
  [20, 28],
]) {
  for (let bar = startBar; bar < endBar; bar += 1) {
    for (const [offset, velocity] of [
      [0.75, 68],
      [1.5, 76],
      [2.75, 72],
      [3.5, 82],
    ]) {
      maracaTriggers.push(hit(barBeat(bar, offset + 0.035), velocity, 0.08));
    }
  }
}

const cowbellTriggers = [];
for (let bar = 24; bar < 28; bar += 1) {
  cowbellTriggers.push(hit(barBeat(bar, 1.5), 72, 0.16));
  cowbellTriggers.push(hit(barBeat(bar, 3.25), 66, 0.16));
}

const tomTriggers = [];
for (const bar of [15, 19, 27]) {
  for (const [offset, velocity] of [
    [2.5, 74],
    [3, 82],
    [3.25, 90],
    [3.5, 101],
    [3.75, 116],
  ]) {
    tomTriggers.push(hit(barBeat(bar, offset), velocity, 0.16));
  }
}

const chordProgression = [
  [48, 51, 55], // Cm
  [44, 48, 51], // Ab
  [51, 55, 58], // Eb
  [46, 50, 53], // Bb
];

const pianoNotes = [];
for (let bar = 0; bar < 4; bar += 1) {
  const chord = chordProgression[bar % 4];
  for (const midi of chord) {
    pianoNotes.push(note(barBeat(bar, 0.1), 1.55, midi, 70 + (midi % 3) * 5));
    pianoNotes.push(note(barBeat(bar, 2.1), 1.25, midi, 62 + (midi % 3) * 5));
  }
}
for (const [startBar, endBar] of [
  [4, 16],
  [20, 30],
]) {
  for (let bar = startBar; bar < endBar; bar += 1) {
    const chord = chordProgression[bar % 4];
    for (const offset of [0.55, 1.55, 2.55, 3.55]) {
      for (const midi of chord) {
        const velocity = offset === 0.55 ? 108 : offset === 2.55 ? 96 : 84;
        pianoNotes.push(note(barBeat(bar, offset), 0.32, midi, velocity));
      }
    }
  }
}
for (let bar = 30; bar < 32; bar += 1) {
  const chord = chordProgression[bar % 4];
  for (const offset of [0.55, 2.55]) {
    for (const midi of chord) {
      pianoNotes.push(note(barBeat(bar, offset), 0.5, midi, 76));
    }
  }
}

const bassNotes = [];
const bassRoots = [36, 32, 39, 34];
for (const [startBar, endBar] of [
  [8, 16],
  [20, 30],
]) {
  for (let bar = startBar; bar < endBar; bar += 1) {
    const root = bassRoots[bar % 4];
    for (const [offset, duration, interval, velocity] of [
      [0.5, 0.38, 0, 112],
      [1.25, 0.22, 12, 82],
      [1.75, 0.38, 0, 101],
      [2.5, 0.32, 7, 91],
      [3.25, 0.22, 0, 86],
      [3.75, 0.2, 12, 98],
    ]) {
      bassNotes.push(note(barBeat(bar, offset), duration, root + interval, velocity));
    }
  }
}

const stringNotes = [];
for (let bar = 16; bar < 20; bar += 1) {
  for (const midi of chordProgression[bar % 4]) {
    stringNotes.push(note(barBeat(bar, 0), 3.55, midi + 12, 78));
  }
}

const fluteNotes = [];
const fluteHook = [
  [0.5, 0.45, 67, 92],
  [1.25, 0.45, 70, 84],
  [2, 0.9, 72, 105],
  [3.5, 0.3, 67, 76],
  [4.25, 0.45, 75, 96],
  [5, 0.45, 72, 86],
  [5.75, 0.65, 70, 91],
  [6.75, 0.7, 67, 82],
  [8.5, 0.4, 68, 88],
  [9.25, 0.4, 67, 82],
  [10, 0.55, 63, 94],
  [11, 0.7, 60, 80],
  [12.25, 0.55, 70, 87],
  [13.25, 0.45, 67, 81],
  [14, 0.5, 63, 90],
  [15, 0.8, 72, 103],
];
for (const startBar of [20, 24]) {
  for (const [offset, duration, midi, velocity] of fluteHook) {
    fluteNotes.push(note(barBeat(startBar, offset), duration, midi, velocity));
  }
}
fluteNotes.push(note(barBeat(18, 2), 1.2, 67, 72));
fluteNotes.push(note(barBeat(19, 2.5), 0.9, 70, 84));

const bassZone = {
  sample: sample("One Shots/Instrument/Bass/Bass Electric Raw C2.aif"),
  keyMin: 0,
  keyMax: 127,
  velocityMin: 1,
  velocityMax: 127,
  rootKey: 60,
  detuneCents: 0,
  gainDb: -15.5,
  pan: 0,
  sampleStartFrame: 0,
  sampleEndFrame: 352799,
  sourceSampleRate: 44100,
  attackSeconds: 0.0001,
  decaySeconds: 5.68,
  sustainLevel: 0.5188,
  releaseSeconds: 0.487,
  velocityAmount: 0.35,
};

const stringZone = {
  sample: sample("One Shots/Instrument/Strings/Strings Orch C4.wav"),
  keyMin: 0,
  keyMax: 127,
  velocityMin: 1,
  velocityMax: 127,
  rootKey: 60,
  detuneCents: 0,
  gainDb: -10.5,
  pan: 0,
  sampleStartFrame: 0,
  sampleEndFrame: 281866,
  sourceSampleRate: 48000,
  attackSeconds: 0.0001,
  decaySeconds: 60,
  sustainLevel: 0.000316,
  releaseSeconds: 1.1,
  velocityAmount: 0.35,
};

const fluteZone = {
  sample: sample("One Shots/Instrument/Winds/Clay Flute C4.aif"),
  keyMin: 0,
  keyMax: 127,
  velocityMin: 1,
  velocityMax: 127,
  rootKey: 60,
  detuneCents: 0,
  gainDb: -17,
  pan: 0,
  sampleStartFrame: 0,
  sampleEndFrame: 147527,
  sourceSampleRate: 44100,
  attackSeconds: 0.0001,
  decaySeconds: 10.4644,
  sustainLevel: 0.1114,
  releaseSeconds: 0.6,
  velocityAmount: 0.35,
};

const song = {
  schemaVersion: 1,
  title: "Core Library After Midnight",
  bpm: 128,
  bars: 32,
  beatsPerBar: 4,
  sampleRate: 44100,
  master: {
    inputGainDb: -1.5,
    softClipDrive: 1.08,
    ceilingDb: -1,
    tailSeconds: 1.5,
  },
  tracks: [
    {
      id: "tape-floor",
      kind: "sample",
      sample: sample("Loops/Texture/Noise Tape Floor.wav"),
      oneShot: false,
      velocityAmount: 0,
      fadeOutSeconds: 0.8,
      gainDb: -25,
      highPassHz: 250,
      lowPassHz: 9000,
      triggers: [0, 32, 64, 96].map((beat) => hit(beat, 100, 32)),
    },
    {
      id: "kick-808",
      kind: "sample",
      sample: sample("Multisamples/Drum Machines/808/Kick 808 Tone1 k.wav"),
      oneShot: true,
      velocityAmount: 0.45,
      fadeOutSeconds: 0.008,
      gainDb: -5.5,
      lowPassHz: 9000,
      triggers: kickTriggers,
    },
    {
      id: "clap-808",
      kind: "sample",
      sample: sample("One Shots/Drums/Clap/Clap 808.aif"),
      oneShot: true,
      velocityAmount: 0.45,
      fadeOutSeconds: 0.008,
      gainDb: -9,
      highPassHz: 180,
      triggers: clapTriggers,
    },
    {
      id: "closed-hat-808",
      kind: "sample",
      sample: sample("One Shots/Drums/Hihat/Hihat Closed 808.aif"),
      oneShot: true,
      velocityAmount: 0.7,
      fadeOutSeconds: 0.004,
      gainDb: -12,
      pan: -0.08,
      highPassHz: 450,
      chokeGroup: 1,
      triggers: closedHatTriggers,
    },
    {
      id: "open-hat-808",
      kind: "sample",
      sample: sample("One Shots/Drums/Hihat/Hihat Open 808.aif"),
      oneShot: true,
      velocityAmount: 0.55,
      fadeOutSeconds: 0.015,
      gainDb: -13,
      pan: 0.08,
      highPassHz: 500,
      chokeGroup: 1,
      triggers: openHatTriggers,
    },
    {
      id: "maracas-808",
      kind: "sample",
      sample: sample("One Shots/Drums/Shaker/Maracas 808.wav"),
      oneShot: true,
      velocityAmount: 0.7,
      fadeOutSeconds: 0.004,
      gainDb: -14,
      pan: 0.14,
      highPassHz: 600,
      triggers: maracaTriggers,
    },
    {
      id: "cowbell-808",
      kind: "sample",
      sample: sample("One Shots/Drums/Bell/Cowbell 808.aif"),
      oneShot: true,
      velocityAmount: 0.6,
      fadeOutSeconds: 0.008,
      gainDb: -16,
      pan: -0.2,
      highPassHz: 350,
      triggers: cowbellTriggers,
    },
    {
      id: "tom-fill-808",
      kind: "sample",
      sample: sample("One Shots/Drums/Tom/Tom 808 Hi.aif"),
      oneShot: true,
      velocityAmount: 0.65,
      fadeOutSeconds: 0.008,
      gainDb: -10,
      pan: 0.1,
      highPassHz: 120,
      triggers: tomTriggers,
    },
    {
      id: "crash-808",
      kind: "sample",
      sample: sample("Multisamples/Drum Machines/808/Cymbal 808 Tone1 k.wav"),
      oneShot: true,
      velocityAmount: 0.45,
      fadeOutSeconds: 0.05,
      gainDb: -13,
      highPassHz: 300,
      triggers: [0, 32, 64, 80, 112].map((beat) => hit(beat, 105, 1)),
    },
    {
      id: "electric-bass-raw",
      kind: "sampler",
      zones: [bassZone],
      notes: bassNotes,
      gainDb: 4,
      lowPassHz: 3200,
      sidechain: {
        everyBeats: 1,
        holdBeats: 0.04,
        releaseBeats: 0.38,
        depthDb: -12,
        curve: 0.72,
      },
    },
    {
      id: "grand-piano",
      kind: "sampler",
      zones: pianoSource.tracks[0].zones,
      notes: pianoNotes,
      gainDb: -2,
      pan: -0.04,
      highPassHz: 125,
      lowPassHz: 11000,
      sidechain: {
        everyBeats: 1,
        holdBeats: 0.025,
        releaseBeats: 0.3,
        depthDb: -5,
        curve: 0.8,
      },
    },
    {
      id: "orchestral-strings",
      kind: "sampler",
      zones: [stringZone],
      notes: stringNotes,
      gainDb: -6,
      pan: 0.05,
      highPassHz: 180,
      lowPassHz: 7500,
      sidechain: {
        everyBeats: 1,
        holdBeats: 0.03,
        releaseBeats: 0.4,
        depthDb: -4,
        curve: 0.8,
      },
    },
    {
      id: "clay-flute",
      kind: "sampler",
      zones: [fluteZone],
      notes: fluteNotes,
      gainDb: 2,
      pan: 0.1,
      highPassHz: 280,
      lowPassHz: 12000,
    },
  ],
};

await writeFile(output, `${JSON.stringify(song, null, 2)}\n`);
console.log(output);
