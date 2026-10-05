import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(
  process.argv[2] ?? path.join(here, "cobalt-canopy-developed-ableton-graph.json"),
);
const core = "/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Core Library";
const samples = path.join(core, "Samples");
const devices = path.join(core, "Devices");
const sample = (relative) => path.join(samples, relative);
const device = (relative) => path.join(devices, relative);
const at = (bar, beat = 0) => bar * 4 + beat;
const hit = (beat, velocity = 100) => ({ beat, velocity });
const note = (beat, durationBeats, midi, velocity = 100) => ({
  beat,
  durationBeats,
  note: midi,
  velocity,
});

const bars = 104;
const bpm = 123;
const kick = [];
const rim = [];
const shaker = [];
const congaLow = [];
const congaHigh = [];
const bongo = [];
const clave = [];
const agogo = [];
const openHat = [];
const reverseCymbal = [];
const bass = [];
const plucks = [];
const hook = [];
const response = [];
const pad = [];

const sectionAt = (bar) => {
  if (bar < 8) return "intro";
  if (bar < 16) return "groove";
  if (bar < 32) return "drop-a";
  if (bar < 40) return "turn";
  if (bar < 56) return "drop-b";
  if (bar < 64) return "bridge";
  if (bar < 72) return "breakdown";
  if (bar < 80) return "build";
  if (bar < 96) return "final-drop";
  return "outro";
};

const denseShakerPatterns = [
  [
    [0.02, 105],
    [0.27, 43],
    [0.515, 68],
    [0.78, 92],
    [1.01, 109],
    [1.285, 48],
    [1.53, 84],
    [1.79, 72],
    [2.015, 107],
    [2.29, 45],
    [2.535, 65],
    [2.795, 96],
    [3.01, 111],
    [3.285, 51],
    [3.54, 88],
    [3.805, 77],
  ],
  [
    [0.015, 106],
    [0.29, 39],
    [0.54, 74],
    [0.805, 83],
    [1.015, 104],
    [1.3, 54],
    [1.555, 78],
    [1.825, 94],
    [2.015, 110],
    [2.3, 42],
    [2.555, 70],
    [2.825, 81],
    [3.015, 106],
    [3.3, 56],
    [3.555, 86],
    [3.825, 98],
  ],
  [
    [0.02, 108],
    [0.265, 47],
    [0.52, 63],
    [0.775, 99],
    [1.02, 103],
    [1.265, 58],
    [1.52, 73],
    [1.775, 88],
    [2.02, 112],
    [2.265, 45],
    [2.52, 67],
    [2.775, 101],
    [3.02, 105],
    [3.265, 49],
    [3.52, 82],
    [3.775, 91],
  ],
  [
    [0.01, 112],
    [0.28, 50],
    [0.535, 77],
    [0.8, 89],
    [1.01, 108],
    [1.28, 45],
    [1.535, 69],
    [1.8, 98],
    [2.01, 105],
    [2.28, 52],
    [2.535, 81],
    [2.8, 87],
    [3.01, 114],
    [3.28, 57],
    [3.535, 74],
    [3.8, 104],
  ],
];

const congaLowPatterns = [
  [
    [0.77, 91],
    [1.76, 68],
    [2.52, 102],
    [3.78, 80],
  ],
  [
    [0.52, 72],
    [1.77, 98],
    [2.77, 75],
    [3.52, 106],
  ],
  [
    [0.77, 88],
    [1.52, 64],
    [2.27, 96],
    [3.77, 109],
  ],
  [
    [0.52, 67],
    [1.27, 86],
    [2.52, 103],
    [3.27, 73],
    [3.78, 111],
  ],
];

const congaHighPatterns = [
  [
    [0.515, 64],
    [1.535, 95],
    [2.785, 76],
    [3.535, 101],
  ],
  [
    [0.285, 58],
    [1.285, 78],
    [2.035, 65],
    [3.285, 91],
  ],
  [
    [0.535, 71],
    [1.785, 98],
    [2.535, 62],
    [3.785, 106],
  ],
  [
    [0.285, 61],
    [1.535, 89],
    [2.285, 73],
    [3.535, 99],
  ],
];

for (let bar = 0; bar < bars; bar += 1) {
  const section = sectionAt(bar);
  const phraseBar = bar % 8;
  const fullDrop = ["drop-a", "drop-b", "final-drop"].includes(section);

  // Kick scenes evolve from a sparse pulse to full drops, then deliberately
  // leave holes at phrase boundaries so transitions have somewhere to land.
  if (section === "intro" && bar >= 4) {
    kick.push(hit(at(bar, 0), 105), hit(at(bar, 2), 98));
  } else if (section === "groove" || fullDrop || section === "bridge") {
    for (let quarter = 0; quarter < 4; quarter += 1) {
      if (phraseBar === 7 && quarter === 3) continue;
      if (section === "outro" && bar >= 100 && quarter % 2 === 1) continue;
      kick.push(hit(at(bar, quarter), quarter === 0 ? 124 : 116));
    }
  } else if (section === "turn") {
    kick.push(hit(at(bar, 0), 112), hit(at(bar, 2), 106));
  } else if (section === "build") {
    if (bar < 76) {
      kick.push(hit(at(bar, 0), 88), hit(at(bar, 2), 82));
    } else {
      for (let quarter = 0; quarter < 4; quarter += 1) {
        kick.push(hit(at(bar, quarter), 91 + (bar - 76) * 7 + (quarter === 0 ? 5 : 0)));
      }
    }
  } else if (section === "outro") {
    for (let quarter = 0; quarter < (bar < 100 ? 4 : 2); quarter += 1) {
      kick.push(hit(at(bar, quarter), quarter === 0 ? 114 : 105));
    }
  }

  if (["groove", "drop-a", "drop-b", "bridge", "final-drop", "outro"].includes(section)) {
    rim.push(hit(at(bar, 1.01), 87), hit(at(bar, 3.015), 99));
    if (phraseBar === 3) rim.push(hit(at(bar, 3.73), 54));
    if (phraseBar === 7) {
      rim.push(hit(at(bar, 3.48), 51), hit(at(bar, 3.73), 72));
    }
  } else if (section === "build" && bar >= 76) {
    rim.push(hit(at(bar, 1.01), 73 + (bar - 76) * 5), hit(at(bar, 3.015), 81 + (bar - 76) * 5));
  }

  if (section === "breakdown") {
    for (const [offset, velocity] of [
      [0.03, 66],
      [1.03, 72],
      [2.03, 69],
      [3.03, 76],
    ]) {
      shaker.push(hit(at(bar, offset), velocity));
    }
  } else if (section === "intro" && bar < 4) {
    for (const [offset, velocity] of [
      [0.03, 74],
      [0.78, 52],
      [1.53, 68],
      [2.03, 77],
      [2.78, 55],
      [3.53, 71],
    ]) {
      shaker.push(hit(at(bar, offset), velocity));
    }
  } else {
    const pattern = denseShakerPatterns[(bar + (section === "drop-b" ? 1 : 0)) % 4];
    const scale =
      section === "intro" ? 0.72 : section === "turn" ? 0.78 : section === "build" ? 0.82 : 1;
    for (const [offset, velocity] of pattern) {
      if (section === "outro" && bar >= 100 && Math.round(offset * 4) % 2 === 1) continue;
      shaker.push(hit(at(bar, offset), Math.round(velocity * scale)));
    }
  }

  if (fullDrop || section === "bridge" || (section === "groove" && bar >= 12)) {
    const lowPattern = congaLowPatterns[(bar + (section === "drop-b" ? 2 : 0)) % 4];
    const highPattern = congaHighPatterns[(bar + (section === "final-drop" ? 1 : 0)) % 4];
    for (const [offset, velocity] of lowPattern) congaLow.push(hit(at(bar, offset), velocity));
    for (const [offset, velocity] of highPattern) congaHigh.push(hit(at(bar, offset), velocity));
    if (phraseBar === 7) {
      bongo.push(
        hit(at(bar, 2.78), 61),
        hit(at(bar, 3.03), 70),
        hit(at(bar, 3.28), 81),
        hit(at(bar, 3.53), 94),
        hit(at(bar, 3.78), 109),
      );
    } else if (bar % 2 === 0) {
      bongo.push(hit(at(bar, 0.285), 55), hit(at(bar, 1.285), 72), hit(at(bar, 3.285), 68));
    }
  }

  if (fullDrop || section === "bridge") {
    if (bar % 2 === 0) {
      clave.push(hit(at(bar, 0.76), 82), hit(at(bar, 2.51), 68), hit(at(bar, 3.76), 94));
    } else {
      clave.push(hit(at(bar, 1.51), 72), hit(at(bar, 2.76), 88));
    }
  }

  if ((fullDrop && bar >= 24) || section === "bridge") {
    openHat.push(hit(at(bar, 1.5), 72), hit(at(bar, 3.5), phraseBar === 7 ? 97 : 83));
  }

  if ([23, 47, 59, 87, 91].includes(bar)) {
    agogo.push(hit(at(bar, 1.52), 68), hit(at(bar, 2.77), 86), hit(at(bar, 3.52), 59));
  }

  if (section === "build" && bar >= 78) {
    const divisions = bar === 79 ? 32 : 16;
    for (let step = 0; step < divisions; step += 1) {
      const offset = (step * 4) / divisions;
      shaker.push(hit(at(bar, offset + 0.01), 47 + Math.round((step / divisions) * 75)));
    }
  }
}

for (const bar of [7, 15, 31, 39, 55, 63, 71, 79, 95]) {
  reverseCymbal.push(hit(at(bar, 3.48), bar === 79 ? 118 : 101));
}

// Two related harmonic cycles provide continuity without repeating one loop.
const cycleA = [
  { bass: 35, chord: [59, 62, 66, 69, 73] }, // Bm9
  { bass: 31, chord: [55, 59, 62, 66, 69] }, // Gmaj9
  { bass: 38, chord: [57, 62, 66, 69, 76] }, // D/A add9
  { bass: 33, chord: [57, 61, 64, 66, 71] }, // A6/9
];
const cycleB = [
  { bass: 35, chord: [59, 62, 66, 69, 73] }, // Bm9
  { bass: 38, chord: [57, 62, 66, 69, 74] }, // D/A
  { bass: 28, chord: [52, 55, 59, 62, 66] }, // Em9
  { bass: 31, chord: [55, 59, 62, 66, 71] }, // Gmaj7/B
];
const harmonyFor = (bar, section) => {
  const cycle = ["drop-b", "bridge"].includes(section) ? cycleB : cycleA;
  return cycle[Math.floor(bar / 2) % cycle.length];
};

const bassPatterns = {
  groove: [
    [
      [0.72, 0.31, 0, 108],
      [1.48, 0.21, 7, 87],
      [2.72, 0.36, 0, 113],
      [3.47, 0.26, 0, 99],
    ],
    [
      [0.48, 0.2, 0, 92],
      [1.72, 0.35, 0, 111],
      [2.47, 0.22, 7, 89],
      [3.72, 0.24, 0, 105],
    ],
  ],
  "drop-a": [
    [
      [0.06, 0.14, 0, 69],
      [0.72, 0.32, 0, 113],
      [1.48, 0.22, 7, 91],
      [2.23, 0.39, 0, 118],
      [3.47, 0.27, 0, 103],
    ],
    [
      [0.48, 0.18, 0, 84],
      [1.23, 0.22, 7, 96],
      [1.72, 0.34, 0, 115],
      [2.72, 0.25, 0, 108],
      [3.48, 0.2, 3, 87],
      [3.76, 0.13, 7, 73],
    ],
    [
      [0.72, 0.36, 0, 116],
      [1.72, 0.22, 12, 93],
      [2.48, 0.4, 0, 119],
      [3.72, 0.18, 7, 82],
    ],
    [
      [0.47, 0.19, 0, 88],
      [1.47, 0.31, 0, 109],
      [2.23, 0.21, 7, 96],
      [2.97, 0.34, 0, 114],
      [3.72, 0.15, 12, 78],
    ],
  ],
  "drop-b": [
    [
      [0.73, 0.38, 0, 116],
      [1.73, 0.2, 3, 88],
      [2.48, 0.28, 7, 99],
      [3.23, 0.42, 0, 112],
    ],
    [
      [0.48, 0.24, 0, 91],
      [1.48, 0.33, 0, 115],
      [2.73, 0.24, 7, 96],
      [3.73, 0.17, 12, 79],
    ],
    [
      [0.72, 0.28, 0, 109],
      [1.22, 0.17, 7, 84],
      [2.22, 0.38, 0, 117],
      [3.47, 0.29, 3, 101],
    ],
    [
      [0.47, 0.19, 0, 86],
      [1.72, 0.38, 0, 118],
      [2.47, 0.23, 7, 94],
      [3.47, 0.31, 0, 107],
      [3.78, 0.12, 12, 70],
    ],
  ],
};

for (let bar = 8; bar < 104; bar += 1) {
  const section = sectionAt(bar);
  if (!["groove", "drop-a", "drop-b", "bridge", "build", "final-drop", "outro"].includes(section)) {
    continue;
  }
  if (section === "build" && bar < 76) continue;
  if (section === "outro" && bar >= 100) continue;
  const harmony = harmonyFor(bar, section);
  const patternName = section === "final-drop" ? (bar % 4 < 2 ? "drop-a" : "drop-b") : section;
  const patterns = bassPatterns[patternName] ?? bassPatterns.groove;
  const pattern = patterns[bar % patterns.length];
  const energy = section === "build" ? 0.76 + (bar - 76) * 0.07 : section === "outro" ? 0.82 : 1;
  for (const [offset, duration, interval, velocity] of pattern) {
    bass.push(
      note(at(bar, offset), duration, harmony.bass + interval, Math.round(velocity * energy)),
    );
  }
  if (bar % 8 === 7 && section !== "outro") {
    bass.push(note(at(bar, 3.76), 0.13, harmony.bass + 12, 78));
  }
}

const addChord = (bar, offset, duration, chord, velocity, inversion = 0) => {
  chord.forEach((pitch, index) => {
    const voiced = index < inversion ? pitch + 12 : pitch;
    plucks.push(
      note(at(bar, offset + index * 0.006), duration + index * 0.012, voiced, velocity - index * 3),
    );
  });
};

for (let bar = 8; bar < 100; bar += 1) {
  const section = sectionAt(bar);
  if (["turn", "breakdown"].includes(section)) continue;
  const harmony = harmonyFor(bar, section);
  if (section === "groove") {
    addChord(bar, bar % 2 === 0 ? 1.02 : 2.765, 0.18, harmony.chord, 71, bar % 4 === 3 ? 1 : 0);
  } else if (section === "drop-a") {
    const offsets = bar % 4 === 3 ? [0.765, 2.515, 3.765] : [1.02, 2.765];
    offsets.forEach((offset, index) =>
      addChord(
        bar,
        offset,
        index === offsets.length - 1 ? 0.24 : 0.16,
        harmony.chord,
        77 + index * 5,
        bar % 8 === 7 ? 1 : 0,
      ),
    );
  } else if (["drop-b", "bridge"].includes(section)) {
    const offsets = bar % 2 === 0 ? [0.765, 2.265, 3.515] : [1.515, 2.765];
    offsets.forEach((offset, index) =>
      addChord(bar, offset, 0.17 + index * 0.025, harmony.chord, 73 + index * 7, (bar + index) % 2),
    );
  } else if (section === "build") {
    if (bar >= 76) addChord(bar, 2.765, 0.2, harmony.chord, 59 + (bar - 76) * 7, 1);
  } else if (section === "final-drop") {
    const offsets = bar % 4 === 2 ? [0.515, 1.765, 2.765, 3.515] : [0.765, 2.515, 3.765];
    offsets.forEach((offset, index) =>
      addChord(bar, offset, 0.14 + index * 0.018, harmony.chord, 76 + index * 5, (bar + index) % 2),
    );
  } else if (section === "outro") {
    addChord(bar, 1.02, 0.19, harmony.chord, 66, 0);
  }
}

// The hook is introduced as fragments, answered in drop B, stretched during
// the breakdown, then recombined with octave displacement in the final drop.
const motifA = [
  [0.78, 74, 0.22, 83],
  [1.54, 78, 0.2, 89],
  [2.29, 81, 0.31, 96],
  [3.55, 78, 0.2, 86],
];
const motifAAnswer = [
  [0.78, 76, 0.21, 79],
  [1.54, 74, 0.2, 84],
  [2.79, 71, 0.32, 92],
  [3.55, 69, 0.19, 82],
];
const motifB = [
  [0.53, 78, 0.18, 84],
  [1.28, 81, 0.25, 92],
  [2.03, 83, 0.18, 87],
  [2.78, 81, 0.28, 95],
  [3.53, 86, 0.19, 101],
];

const addMotif = (target, bar, motif, transpose = 0, velocityScale = 1) => {
  motif.forEach(([offset, pitch, duration, velocity]) => {
    target.push(
      note(at(bar, offset), duration, pitch + transpose, Math.round(velocity * velocityScale)),
    );
  });
};

for (const bar of [24, 28]) addMotif(hook, bar, motifA, 0, 0.88);
for (const bar of [26, 30]) addMotif(hook, bar, motifAAnswer, 0, 0.84);
for (const bar of [40, 44, 48, 52]) addMotif(hook, bar, motifB, bar % 8 === 4 ? -2 : 0, 0.94);
for (const bar of [42, 46, 50, 54])
  addMotif(response, bar, motifAAnswer, bar % 8 === 6 ? 2 : 0, 0.78);
for (const bar of [56, 60]) {
  addMotif(hook, bar, motifA.slice(0, 3), -12, 0.8);
  addMotif(response, bar + 1, motifAAnswer.slice(1), 0, 0.72);
}
for (const bar of [80, 84, 88, 92]) {
  addMotif(hook, bar, motifA, bar % 8 === 4 ? 12 : 0, 1);
  addMotif(hook, bar + 1, motifB, bar % 8 === 4 ? -2 : 0, 0.91);
  addMotif(response, bar + 2, motifAAnswer, bar >= 88 ? 12 : 0, 0.84);
  response.push(note(at(bar + 3, 3.28), 0.18, bar >= 88 ? 86 : 83, 79));
  response.push(note(at(bar + 3, 3.55), 0.18, bar >= 88 ? 88 : 85, 87));
  response.push(note(at(bar + 3, 3.8), 0.14, bar >= 88 ? 90 : 86, 96));
}

for (let bar = 64; bar < 72; bar += 2) {
  const harmony = cycleA[((bar - 64) / 2) % cycleA.length];
  harmony.chord.forEach((pitch, index) => {
    pad.push(note(at(bar), 7.55, pitch + (index > 2 ? 12 : 0), 49 + index * 2));
  });
}
// Long-form breakdown melody, with silence between phrases.
for (const [bar, offset, pitch, duration, velocity] of [
  [64, 1.5, 74, 1.2, 68],
  [65, 3.0, 78, 0.72, 72],
  [66, 1.0, 81, 1.7, 77],
  [68, 0.75, 78, 0.62, 69],
  [68, 2.5, 76, 0.82, 72],
  [69, 3.25, 74, 0.55, 75],
  [70, 1.5, 71, 1.8, 79],
]) {
  hook.push(note(at(bar, offset), duration, pitch, velocity));
}
for (let bar = 72; bar < 80; bar += 2) {
  const harmony = cycleA[((bar - 72) / 2) % cycleA.length];
  harmony.chord.forEach((pitch, index) => {
    pad.push(note(at(bar), 7.5, pitch + 12, 38 + (bar - 72) * 2 + index));
  });
}
for (const bar of [80, 88]) {
  cycleA[0].chord.forEach((pitch, index) => pad.push(note(at(bar), 31.2, pitch + 12, 31 + index)));
}

const sampleTrack = (id, relative, triggers, gainDb, pan = 0) => ({
  id,
  kind: "sample",
  sample: sample(relative),
  velocityAmount: 0.72,
  gainDb,
  pan,
  effects: [],
  triggers,
});

const graph = {
  schemaVersion: 1,
  title: "Cobalt Canopy — Ableton Rack Revision (dry sources)",
  bpm,
  bars,
  beatsPerBar: 4,
  sampleRate: 44100,
  tailSeconds: 5,
  master: {
    inputGainDb: 0,
    outputGainDb: 0,
    effects: [],
  },
  composition: {
    form: [
      "intro 8",
      "groove 8",
      "drop A 16",
      "turn 8",
      "drop B 16",
      "bridge 8",
      "breakdown 8",
      "build 8",
      "final drop 16",
      "outro 8",
    ],
    originality:
      "New notes and arrangement derived from aggregate corpus grammar; no source melody or audio reused",
  },
  tracks: [
    sampleTrack("kick", "One Shots/Drums/Kick/Kick 909 Prommer.wav", kick, 0.5),
    sampleTrack("rim", "One Shots/Drums/Rim/Rim Sidestick Gen Purpose.aif", rim, -7, 0.1),
    sampleTrack("shaker", "One Shots/Drums/Shaker/Shaker Acoustic.aif", shaker, -13, -0.42),
    sampleTrack(
      "conga-low",
      "One Shots/Drums/Conga/Conga Acoustified Low.wav",
      congaLow,
      -7,
      -0.28,
    ),
    sampleTrack(
      "conga-high",
      "One Shots/Drums/Conga/Conga Acoustified Hi.wav",
      congaHigh,
      -7.5,
      0.36,
    ),
    sampleTrack("bongo", "One Shots/Drums/Bongo/Bongo Shy and Dry.aif", bongo, -8.2, 0.5),
    sampleTrack("clave", "One Shots/Drums/Wood/Wood Claves.aif", clave, -10, -0.38),
    sampleTrack("agogo", "One Shots/Drums/Bell/Bells Agogo Hi.aif", agogo, -11, 0.48),
    sampleTrack("open-hat", "One Shots/Drums/Hihat/Hihat Open 909.aif", openHat, -12, 0.12),
    sampleTrack(
      "reverse-cymbal",
      "One Shots/Drums/Cymbal/Cymbal Crash Reverse Gnirob.wav",
      reverseCymbal,
      -9.5,
      0.08,
    ),
    {
      id: "analog-bass",
      kind: "native",
      device: "Analog",
      preset: device("Instruments/Analog/Bass/Muted Wow Bass.adv"),
      gainDb: 35.5,
      pan: 0,
      effects: [],
      notes: bass,
    },
    {
      id: "plucked-chords",
      kind: "native",
      device: "Collision",
      preset: device("Instruments/Collision/Guitar & Plucked/Acoustic String.adv"),
      gainDb: 4.2,
      pan: -0.4,
      effects: [],
      notes: plucks,
    },
    {
      id: "marimba-hook",
      kind: "native",
      device: "Collision",
      preset: device("Instruments/Collision/Mallets/Marimba Classic.adv"),
      gainDb: 1.7,
      pan: 0.38,
      effects: [],
      notes: hook,
    },
    {
      id: "marimba-response",
      kind: "native",
      device: "Collision",
      preset: device("Instruments/Collision/Mallets/Marimba Classic.adv"),
      gainDb: -0.8,
      pan: -0.34,
      effects: [],
      notes: response,
    },
    {
      id: "atmospheric-pad",
      kind: "native",
      device: "Collision",
      preset: device("Instruments/Collision/Ambient & Evolving/Noisy Pad.adv"),
      gainDb: 9.2,
      pan: 0,
      effects: [],
      notes: pad,
    },
  ],
};

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(graph, null, 2)}\n`);
console.log(output);
