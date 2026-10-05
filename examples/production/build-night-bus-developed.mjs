import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const graphOutput = path.resolve(
  process.argv[2] ?? path.join(here, "night-bus-developed-graph.json"),
);
const clipDirectory = path.resolve(
  process.argv[3] ?? path.join(here, "night-bus-developed-clips"),
);
const renderDirectory = path.resolve(
  process.argv[4] ?? "/Users/gakonst/Library/Caches/djbooth/night-bus-developed",
);
const patchRoot = path.resolve(here, "../serum/patches");
const coreLibrary =
  "/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Core Library";
const coreSamples = path.join(coreLibrary, "Samples");
const recipes = JSON.parse(
  await readFile(path.join(here, "ableton-tutorial-recipes.json"), "utf8"),
).recipes;

const bpm = 134.60400251452523;
const bars = 88;
const beatsPerBar = 4;
const beat = (bar, offset = 0) => bar * beatsPerBar + offset;
const note = (at, durationBeats, midi, velocity) => ({
  beat: at,
  durationBeats,
  note: midi,
  velocity,
});
const hit = (at, velocity) => ({ beat: at, velocity });
const sample = (relative) => path.join(coreSamples, relative);
const effects = (recipe) =>
  recipes[recipe].chain.map(({ kind, device, preset }) => ({ kind, device, preset }));
const placements = (...ranges) =>
  ranges.map(([startBar, endBar]) => ({
    startBeat: beat(startBar),
    endBeat: beat(endBar),
  }));

const harmonyA = [
  { root: 36, chord: [60, 63, 67] },
  { root: 34, chord: [58, 62, 65] },
  { root: 29, chord: [60, 65, 68] },
  { root: 27, chord: [58, 63, 67] },
  { root: 36, chord: [63, 67, 72] },
  { root: 34, chord: [62, 65, 70] },
  { root: 32, chord: [60, 63, 68] },
  { root: 31, chord: [59, 62, 67] },
];
const harmonyB = [
  { root: 32, chord: [60, 63, 68] },
  { root: 34, chord: [58, 62, 65] },
  { root: 36, chord: [60, 63, 67] },
  { root: 34, chord: [63, 67, 70] },
  { root: 32, chord: [63, 68, 72] },
  { root: 34, chord: [65, 70, 74] },
  { root: 27, chord: [63, 67, 70] },
  { root: 31, chord: [59, 62, 67] },
];

const padNotes = (harmony) =>
  harmony.flatMap(({ chord }, bar) =>
    chord.map((midi, voice) => note(beat(bar, voice * 0.014), 3.72, midi, 54 + voice * 5)),
  );

const bassNotes = (harmony, variant) => {
  const notes = [];
  for (let bar = 0; bar < harmony.length; bar += 1) {
    const root = harmony[bar].root;
    const next = harmony[(bar + 1) % harmony.length].root;
    if (variant === "A") {
      notes.push(note(beat(bar), 0.72, root, 113));
      notes.push(note(beat(bar, 1.5), 0.38, root + 7, 91));
      notes.push(note(beat(bar, 2.25), 0.56, root + 12, 106));
      notes.push(note(beat(bar, 3.25), 0.42, next > root ? next - 1 : next + 12, 87));
    } else {
      notes.push(note(beat(bar), 0.46, root, 116));
      notes.push(note(beat(bar, 0.75), 0.34, root + 12, 93));
      notes.push(note(beat(bar, 1.5), 0.58, root + 7, 102));
      notes.push(note(beat(bar, 2.5), 0.42, root + 12, 110));
      notes.push(note(beat(bar, 3.0), 0.3, root + 7, 88));
      notes.push(note(beat(bar, 3.5), 0.3, next > root ? next - 1 : next + 1, 94));
    }
  }
  return notes;
};

const pulseNotes = (harmony, variant) => {
  const notes = [];
  for (let bar = 0; bar < harmony.length; bar += 1) {
    const { root, chord } = harmony[bar];
    const tones = variant === "A"
      ? [root + 12, chord[1], root + 24, chord[2], root + 12, chord[1], root + 24, chord[0]]
      : [chord[0], root + 24, chord[2], root + 19, chord[1], root + 24, chord[2] + 12, root + 19];
    tones.forEach((midi, step) => {
      const delayed = variant === "B" && [1, 4, 6].includes(step) ? 0.08 : 0;
      notes.push(
        note(
          beat(bar, step * 0.5 + delayed),
          variant === "A" ? 0.34 : 0.27,
          midi,
          step % 4 === 0 ? 106 : 78 + ((step * 7 + bar * 3) % 18),
        ),
      );
    });
  }
  return notes;
};

const hookA = [
  note(0.5, 0.38, 67, 92), note(1, 0.38, 72, 101), note(1.5, 0.38, 75, 105),
  note(2, 1.22, 79, 112), note(3.5, 0.38, 75, 91),
  note(4.5, 0.62, 77, 105), note(5.25, 0.62, 74, 98), note(6, 1.42, 70, 109),
  note(8.5, 0.38, 68, 91), note(9, 0.38, 72, 99), note(9.5, 0.72, 77, 109),
  note(10.5, 0.38, 75, 96), note(11, 0.78, 72, 103),
  note(12.5, 0.38, 67, 90), note(13, 0.38, 70, 98), note(13.5, 0.72, 75, 108),
  note(14.5, 0.38, 74, 95), note(15, 0.78, 70, 102),
  note(16.5, 0.38, 72, 98), note(17, 0.38, 75, 105), note(17.5, 0.38, 79, 111),
  note(18, 1.22, 84, 116), note(19.5, 0.38, 79, 97),
  note(20.5, 0.62, 82, 109), note(21.25, 0.62, 77, 101), note(22, 1.42, 74, 111),
  note(24.5, 0.38, 72, 94), note(25, 0.38, 77, 102), note(25.5, 0.72, 80, 112),
  note(26.5, 0.38, 79, 100), note(27, 0.78, 77, 106),
  note(28.5, 0.38, 75, 104), note(29, 0.38, 74, 100), note(29.5, 0.38, 72, 97),
  note(30, 0.38, 70, 94), note(30.5, 0.38, 67, 91), note(31, 0.82, 63, 108),
];
const hookB = [
  note(0.25, 0.34, 75, 101), note(0.75, 0.34, 79, 108), note(1.25, 0.34, 84, 114),
  note(1.75, 0.72, 82, 105), note(2.75, 0.34, 79, 97), note(3.25, 0.58, 75, 104),
  note(4.5, 0.42, 77, 99), note(5, 0.42, 79, 106), note(5.5, 0.72, 82, 112),
  note(6.5, 0.34, 79, 100), note(7, 0.84, 74, 108),
  note(8.25, 0.34, 72, 96), note(8.75, 0.34, 75, 102), note(9.25, 0.34, 80, 111),
  note(9.75, 0.72, 79, 103), note(10.75, 0.34, 75, 96), note(11.25, 0.58, 72, 105),
  note(12.5, 0.42, 70, 94), note(13, 0.42, 75, 103), note(13.5, 0.72, 79, 112),
  note(14.5, 0.34, 77, 101), note(15, 0.84, 74, 109),
  note(16.25, 0.34, 75, 101), note(16.75, 0.34, 79, 108), note(17.25, 0.34, 84, 116),
  note(17.75, 1.18, 87, 118), note(19.25, 0.42, 84, 103),
  note(20.25, 0.34, 82, 106), note(20.75, 0.34, 79, 102), note(21.25, 0.72, 77, 110),
  note(22.25, 0.34, 74, 97), note(22.75, 0.9, 70, 108),
  note(24.5, 0.42, 72, 99), note(25, 0.42, 77, 106), note(25.5, 0.72, 80, 114),
  note(26.5, 0.34, 79, 103), note(27, 0.72, 77, 109),
  note(28.25, 0.3, 75, 105), note(28.75, 0.3, 74, 102), note(29.25, 0.3, 72, 99),
  note(29.75, 0.3, 70, 96), note(30.25, 0.3, 67, 93), note(30.75, 1.05, 63, 112),
];
const counterNotes = [
  note(0, 1.78, 75, 80), note(2, 1.7, 74, 76),
  note(4, 1.78, 72, 82), note(6, 1.7, 70, 76),
  note(8, 1.78, 68, 81), note(10, 1.7, 72, 77),
  note(12, 1.78, 70, 82), note(14, 1.7, 67, 78),
  note(16, 1.78, 72, 82), note(18, 1.7, 75, 79),
  note(20, 1.78, 74, 83), note(22, 1.7, 70, 78),
  note(24, 1.78, 68, 81), note(26, 1.7, 67, 77),
  note(28, 0.72, 63, 82), note(29, 0.72, 67, 84), note(30, 1.72, 70, 87),
];

const clips = [
  { id: "bass-a", patch: "maz-focused-bass.json", notes: bassNotes(harmonyA, "A"), gainDb: -2 },
  { id: "bass-b", patch: "maz-focused-bass.json", notes: bassNotes(harmonyB, "B"), gainDb: -2 },
  { id: "pulse-a", patch: "smalltown-pulse-arp.json", notes: pulseNotes(harmonyA, "A"), gainDb: -2 },
  { id: "pulse-b", patch: "smalltown-pulse-arp.json", notes: pulseNotes(harmonyB, "B"), gainDb: -2 },
  { id: "pad-a", patch: "smalltown-shadow-pad.json", notes: padNotes(harmonyA), gainDb: -5, tail: 3 },
  { id: "pad-b", patch: "smalltown-shadow-pad.json", notes: padNotes(harmonyB), gainDb: -5, tail: 3 },
  { id: "hook-a", patch: "smalltown-neon-lead.json", notes: hookA, gainDb: -1, tail: 2 },
  { id: "hook-b", patch: "smalltown-neon-lead.json", notes: hookB, gainDb: -1, tail: 2 },
  { id: "counter", patch: "smalltown-neon-lead.json", notes: counterNotes, gainDb: -4, tail: 2 },
];

await mkdir(clipDirectory, { recursive: true });
await mkdir(renderDirectory, { recursive: true });
for (const clip of clips) {
  const spec = {
    schemaVersion: 1,
    title: `night-bus-${clip.id}`,
    bpm,
    bars: 8,
    beatsPerBar,
    sampleRate: 44100,
    master: { inputGainDb: 0, tailSeconds: clip.tail ?? 0.8 },
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
  await writeFile(path.join(clipDirectory, `${clip.id}.json`), `${JSON.stringify(spec, null, 2)}\n`);
}

const clipTrack = (id, clip, ranges, gainDb, recipe, pan = 0) => ({
  id,
  kind: "sample",
  sample: path.join(renderDirectory, `${clip}.wav`),
  velocityAmount: 0,
  gainDb,
  pan,
  loopBeats: 32,
  placements: placements(...ranges),
  triggers: [hit(0, 127)],
  effects: recipe ? effects(recipe) : [],
});
const drumTrack = (id, source, triggers, loopBars, ranges, gainDb, recipe, options = {}) => ({
  id,
  kind: "sample",
  sample: sample(source),
  velocityAmount: options.velocityAmount ?? 0.42,
  gainDb,
  pan: options.pan ?? 0,
  loopBeats: loopBars * beatsPerBar,
  placements: placements(...ranges),
  triggers,
  effects: recipe ? effects(recipe) : [],
});

const kickFour = [0, 1, 2, 3].map((at, index) => hit(at, index === 0 ? 122 : 112));
const kickDrive = [0, 1, 2, 2.75, 3].map((at, index) => hit(at, index === 3 ? 78 : 116));
const snareBackbeat = [1, 3].map((at, index) => hit(at, index ? 114 : 108));
const hatsEight = Array.from({ length: 8 }, (_, index) => hit(index * 0.5, index % 2 ? 88 : 62));
const hatsSixteen = Array.from({ length: 16 }, (_, index) =>
  hit(index * 0.25, index % 4 === 2 ? 91 : 48 + ((index * 11) % 28)),
);
const openHats = [0.5, 2.5].map((at) => hit(at, 88));
const fillHits = [28.5, 29.5, 30.25, 30.75, 31.25, 31.5, 31.75].map((at, index) =>
  hit(at, 78 + index * 6),
);

const graph = {
  schemaVersion: 1,
  title: "Night Bus Developed — multi-section synth-pop study",
  bpm,
  bars,
  beatsPerBar,
  sampleRate: 44100,
  tailSeconds: 4,
  master: { inputGainDb: 9.75, outputGainDb: 0, effects: [] },
  provenance: {
    tutorialCorpus: path.join(here, "ableton-tutorial-corpus.json"),
    tutorialRecipes: path.join(here, "ableton-tutorial-recipes.json"),
    compositionModel: "two harmony cycles, two bass performances, two hooks, counterline, section-specific drums",
    audioRuntime: "Serum VST2 plus installed Ableton Core Library samples and native effects",
    customAudioDsp: false,
  },
  tracks: [
    clipTrack("bass-a", "bass-a", [[8, 24], [40, 56], [80, 88]], 6, "lowEndAuthority"),
    clipTrack("bass-b", "bass-b", [[24, 40], [56, 80]], 6, "lowEndAuthority"),
    clipTrack("pulse-a", "pulse-a", [[0, 24], [40, 64], [80, 88]], -1, "focusedPulse"),
    clipTrack("pulse-b", "pulse-b", [[24, 40], [64, 80]], -2, "focusedPulse", 0.03),
    clipTrack("pad-a", "pad-a", [[0, 24], [40, 64], [80, 88]], 4, "padDepth", -0.04),
    clipTrack("pad-b", "pad-b", [[24, 40], [64, 80]], 4, "padTapeDepth", 0.04),
    clipTrack("hook-a-foreground", "hook-a", [[16, 40]], 3, null),
    clipTrack("hook-a-depth", "hook-a", [[16, 40]], -5, "leadWideEcho", 0.08),
    clipTrack("hook-b-foreground", "hook-b", [[64, 80]], 3, null),
    clipTrack("hook-b-depth", "hook-b", [[64, 80]], -5, "leadWideEcho", -0.08),
    clipTrack("counterline", "counter", [[72, 80]], -2, "leadPerspective", -0.12),
    drumTrack(
      "kick-main",
      "One Shots/Drums/Kick/Kick DMX.wav",
      kickFour,
      1,
      [[8, 24], [40, 64], [80, 88]],
      -7,
      "kickAuthority",
      { velocityAmount: 0.28 },
    ),
    drumTrack(
      "kick-drive",
      "One Shots/Drums/Kick/Kick DMX.wav",
      kickDrive,
      1,
      [[24, 40], [64, 80]],
      -7,
      "kickAuthority",
      { velocityAmount: 0.32 },
    ),
    drumTrack(
      "snare-main",
      "One Shots/Drums/Snare/Snare LD.aif",
      snareBackbeat,
      1,
      [[8, 40], [48, 88]],
      -8,
      "snareDepth",
      { velocityAmount: 0.32 },
    ),
    drumTrack(
      "clap-lift",
      "One Shots/Drums/Clap/Clap 707.wav",
      snareBackbeat,
      1,
      [[24, 40], [64, 80]],
      -16,
      "clapDimension",
      { pan: 0.05 },
    ),
    drumTrack(
      "hats-eight",
      "One Shots/Drums/Hihat/Hihat Closed DMX.wav",
      hatsEight,
      1,
      [[8, 24], [40, 64], [80, 88]],
      -17,
      "hatAir",
      { velocityAmount: 0.56, pan: -0.1 },
    ),
    drumTrack(
      "hats-sixteen",
      "One Shots/Drums/Hihat/Hihat Closed DMX.wav",
      hatsSixteen,
      1,
      [[24, 40], [64, 80]],
      -19,
      "hatAir",
      { velocityAmount: 0.65, pan: 0.09 },
    ),
    drumTrack(
      "open-hat",
      "One Shots/Drums/Hihat/Hihat Open DMX.wav",
      openHats,
      1,
      [[16, 40], [56, 80]],
      -17,
      null,
      { velocityAmount: 0.38, pan: 0.12 },
    ),
    drumTrack(
      "tom-fills",
      "One Shots/Drums/Tom/Tom DMX Fatso 2.wav",
      fillHits,
      8,
      [[16, 40], [48, 88]],
      -13,
      "percussionElectricity",
      { velocityAmount: 0.48, pan: -0.08 },
    ),
    {
      id: "section-crashes",
      kind: "sample",
      sample: sample("One Shots/Drums/Cymbal/Crash DMX.wav"),
      velocityAmount: 0.25,
      gainDb: -16,
      pan: 0.08,
      triggers: [8, 16, 24, 40, 48, 64, 80].map((bar) => hit(beat(bar), 110)),
    },
    {
      id: "transition-risers",
      kind: "sample",
      sample: sample("One Shots/FX/Riser Whoosh Up.wav"),
      velocityAmount: 0.2,
      gainDb: -18,
      pan: -0.06,
      triggers: [23, 39, 63, 79].map((bar) => hit(beat(bar), 108)),
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
      serumClips: clips.length,
      graphTracks: graph.tracks.length,
      nativeEffects: graph.tracks.reduce((count, track) => count + (track.effects?.length ?? 0), 0),
    },
    null,
    2,
  ),
);
