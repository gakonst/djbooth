import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const graphOutput = path.resolve(
  process.argv[2] ?? path.join(here, "smalltown-inspired-graph.json"),
);
const clipDirectory = path.resolve(
  process.argv[3] ?? path.join(here, "serum-clips"),
);
const renderDirectory = path.resolve(
  process.argv[4] ?? "/Users/gakonst/Library/Caches/djbooth/smalltown-inspired",
);
const referenceRoot =
  "/Users/gakonst/Library/Caches/djbooth/reference-corpora/smalltown-boy";
const patchRoot = path.resolve(here, "../serum/patches");
const coreLibrary =
  "/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Core Library";
const coreSamples =
  path.join(coreLibrary, "Samples");

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const profile = await readJson(path.join(referenceRoot, "reference-profile.json"));
const techniques = await readJson(path.join(here, "ableton-headless-techniques.json"));
const tonalTranscription = await readJson(
  path.join(referenceRoot, "transcription/other-intro.events.json"),
);
const drumTranscription = await readJson(
  path.join(referenceRoot, "transcription/drums-groove.events.json"),
);

const bpm = profile.bpm;
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
const sample = (relative) => path.join(coreSamples, relative);
const nativeEffects = (recipe) =>
  techniques.recipes[recipe].chain.map((effect) => ({
    kind: effect.kind,
    device: effect.device,
    preset: path.join(coreLibrary, "Devices/Audio Effects", effect.preset),
  }));
const placements = (ranges) =>
  ranges.map(([startBar, endBar]) => ({
    startBeat: beat(startBar),
    endBeat: beat(endBar),
  }));

// The first four voicings are the clean consensus in the transcription. The
// second half changes one harmony, keeping the production grammar while making
// the composition independent.
const harmony = [
  { root: 36, chord: [60, 63, 67] },
  { root: 34, chord: [58, 62, 65] },
  { root: 29, chord: [60, 65, 68] },
  { root: 27, chord: [58, 63, 67] },
  { root: 36, chord: [60, 63, 67] },
  { root: 34, chord: [58, 62, 65] },
  { root: 32, chord: [56, 60, 63] },
  { root: 27, chord: [58, 63, 67] },
];

const pulseNotes = [];
for (let bar = 0; bar < 8; bar += 1) {
  const { root } = harmony[bar];
  for (let step = 0; step < 8; step += 1) {
    const octave = step % 2 === 0 ? 0 : 12;
    const turnaround = bar === 7 && step === 7 ? 7 : 0;
    pulseNotes.push(
      note(
        beat(bar, step * 0.5),
        0.39,
        root + 12 + octave + turnaround,
        step % 4 === 0 ? 112 : 94,
      ),
    );
  }
}

const padNotes = [];
for (let bar = 0; bar < harmony.length; bar += 1) {
  harmony[bar].chord.forEach((midi, voice) => {
    padNotes.push(note(beat(bar, voice * 0.012), 3.7, midi, 55 + voice * 4));
  });
}

// Eight-bar foreground hook. The first four bars state one memorable contour
// over Cm-Bb-Fm-Eb; the second four answer it an octave-brighter before a clear
// descending turnaround. Short gaps remain between phrases, not between every
// isolated note, so this reads as a melody rather than atmospheric punctuation.
const leadNotes = [
  note(beat(0, 0.5), 0.38, 67, 92),
  note(beat(0, 1.0), 0.38, 72, 101),
  note(beat(0, 1.5), 0.38, 75, 105),
  note(beat(0, 2.0), 1.22, 79, 112),
  note(beat(0, 3.5), 0.38, 75, 91),
  note(beat(1, 0.5), 0.62, 77, 105),
  note(beat(1, 1.25), 0.62, 74, 98),
  note(beat(1, 2.0), 1.42, 70, 109),
  note(beat(2, 0.5), 0.38, 68, 91),
  note(beat(2, 1.0), 0.38, 72, 99),
  note(beat(2, 1.5), 0.72, 77, 109),
  note(beat(2, 2.5), 0.38, 75, 96),
  note(beat(2, 3.0), 0.78, 72, 103),
  note(beat(3, 0.5), 0.38, 67, 90),
  note(beat(3, 1.0), 0.38, 70, 98),
  note(beat(3, 1.5), 0.72, 75, 108),
  note(beat(3, 2.5), 0.38, 74, 95),
  note(beat(3, 3.0), 0.78, 70, 102),
  note(beat(4, 0.5), 0.38, 72, 98),
  note(beat(4, 1.0), 0.38, 75, 105),
  note(beat(4, 1.5), 0.38, 79, 111),
  note(beat(4, 2.0), 1.22, 84, 116),
  note(beat(4, 3.5), 0.38, 79, 97),
  note(beat(5, 0.5), 0.62, 82, 109),
  note(beat(5, 1.25), 0.62, 77, 101),
  note(beat(5, 2.0), 1.42, 74, 111),
  note(beat(6, 0.5), 0.38, 72, 94),
  note(beat(6, 1.0), 0.38, 77, 102),
  note(beat(6, 1.5), 0.72, 80, 112),
  note(beat(6, 2.5), 0.38, 79, 100),
  note(beat(6, 3.0), 0.78, 77, 106),
  note(beat(7, 0.5), 0.38, 75, 104),
  note(beat(7, 1.0), 0.38, 74, 100),
  note(beat(7, 1.5), 0.38, 72, 97),
  note(beat(7, 2.0), 0.38, 70, 94),
  note(beat(7, 2.5), 0.38, 67, 91),
  note(beat(7, 3.0), 0.82, 63, 108),
];

const serumClips = [
  {
    id: "serum-octave-pulse",
    file: "smalltown-pulse-arp.json",
    patch: "smalltown-pulse-arp.json",
    notes: pulseNotes,
    tailSeconds: 0.7,
    specGainDb: 0,
    graphGainDb: 2,
    pan: 0,
    ranges: [[0, 96]],
    recipe: "pulseDefinition",
  },
  {
    id: "serum-shadow-pad",
    file: "smalltown-shadow-pad.json",
    patch: "smalltown-shadow-pad.json",
    notes: padNotes,
    tailSeconds: 3,
    specGainDb: -3,
    graphGainDb: 12,
    pan: -0.03,
    ranges: [[0, 16], [24, 40], [40, 56], [64, 80], [88, 96]],
    recipe: "shadowPadSpace",
  },
  {
    id: "serum-neon-lead",
    file: "smalltown-neon-lead.json",
    patch: "smalltown-neon-lead.json",
    notes: leadNotes,
    tailSeconds: 2,
    specGainDb: -1,
    graphGainDb: 12,
    pan: 0.04,
    ranges: [[8, 16], [24, 40], [48, 72], [80, 96]],
    recipe: "neonLeadSpace",
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
        gainDb: clip.specGainDb,
        notes: clip.notes,
      },
    ],
  };
  await writeFile(path.join(clipDirectory, clip.file), `${JSON.stringify(spec, null, 2)}\n`);
}

const loopTrack = (id, source, triggers, ranges, gainDb, options = {}) => ({
  id,
  kind: "sample",
  sample: source,
  velocityAmount: options.velocityAmount ?? 0.45,
  gainDb,
  pan: options.pan ?? 0,
  loopBeats: 8,
  placements: placements(ranges),
  triggers,
  effects: options.recipe ? nativeEffects(options.recipe) : [],
});

const kick = Array.from({ length: 8 }, (_, index) => hit(index, index % 4 === 0 ? 122 : 111));
const snare = [1, 3, 5, 7].map((at, index) => hit(at, index % 2 ? 113 : 106));
const hats = Array.from({ length: 16 }, (_, index) => hit(index * 0.5, index % 2 ? 86 : 61));
const openHats = [0.5, 2.5, 4.5, 6.5].map((at) => hit(at, 84));
const tambourine = Array.from({ length: 8 }, (_, index) => hit(index, index % 4 === 0 ? 100 : 72));

const graph = {
  schemaVersion: 1,
  title: "Night Bus — 1980s synth-pop production study",
  bpm,
  bars,
  beatsPerBar,
  sampleRate: 44100,
  tailSeconds: 4,
  master: { inputGainDb: 3.4, outputGainDb: 0, effects: [] },
  provenance: {
    referenceProfile: path.join(referenceRoot, "reference-profile.json"),
    headlessTechniques: path.join(here, "ableton-headless-techniques.json"),
    tonalTranscription: tonalTranscription.source,
    drumTranscription: drumTranscription.source,
    observedGrammar: {
      tempoBpm: bpm,
      pulseMedianInterOnsetSeconds: tonalTranscription.tracks.find((track) => track.name === "electric_bass")?.interOnsetMedianSeconds,
      drumTransientDensityPerSecond: profile.stems.drums.transientDensityPerSecond,
      referenceStereoCorrelation: profile.mix.stereoCorrelation,
      dominantPhraseBars: 8,
    },
    audioRuntime: "Serum VST2 plus installed Ableton Core Library samples",
    customAudioDsp: false,
  },
  tracks: [
    loopTrack(
      "ableton-dmx-kick",
      sample("One Shots/Drums/Kick/Kick DMX.wav"),
      kick,
      [[12, 40], [48, 88]],
      -5,
      { velocityAmount: 0.3, recipe: "kickFocus" },
    ),
    loopTrack(
      "ableton-linn-snare",
      sample("One Shots/Drums/Snare/Snare LD.aif"),
      snare,
      [[12, 40], [48, 88]],
      -6,
      { velocityAmount: 0.34, recipe: "snareRoom" },
    ),
    loopTrack(
      "ableton-707-clap",
      sample("One Shots/Drums/Clap/Clap 707.wav"),
      snare,
      [[32, 40], [56, 64], [72, 88]],
      -15,
      { pan: 0.04, recipe: "clapAmbience" },
    ),
    loopTrack(
      "ableton-dmx-closed-hat",
      sample("One Shots/Drums/Hihat/Hihat Closed DMX.wav"),
      hats,
      [[8, 40], [48, 92]],
      -15,
      { velocityAmount: 0.58, pan: -0.08, recipe: "hatFocus" },
    ),
    loopTrack(
      "ableton-dmx-open-hat",
      sample("One Shots/Drums/Hihat/Hihat Open DMX.wav"),
      openHats,
      [[16, 40], [52, 88]],
      -17,
      { velocityAmount: 0.42, pan: 0.09 },
    ),
    loopTrack(
      "ableton-80s-tambourine",
      sample("One Shots/Drums/Tambourine/Tamb 80s Space Craft.wav"),
      tambourine,
      [[32, 40], [56, 64], [72, 88]],
      -18,
      { velocityAmount: 0.5, pan: 0.12 },
    ),
    ...serumClips.map((clip) => ({
      id: clip.id,
      kind: "sample",
      sample: path.join(renderDirectory, clip.file.replace(/\.json$/, ".wav")),
      velocityAmount: 0,
      gainDb: clip.graphGainDb,
      pan: clip.pan,
      loopBeats: beat(8),
      placements: placements(clip.ranges),
      triggers: [hit(0, 127)],
      effects: nativeEffects(clip.recipe),
    })),
    {
      id: "ableton-section-crash",
      kind: "sample",
      sample: sample("One Shots/Drums/Cymbal/Crash DMX.wav"),
      velocityAmount: 0.3,
      gainDb: -16,
      pan: 0.06,
      triggers: [12, 40, 48, 72, 88].map((bar) => hit(beat(bar), 110)),
    },
  ],
};

await writeFile(graphOutput, `${JSON.stringify(graph, null, 2)}\n`);
console.log(JSON.stringify({ graph: graphOutput, clipDirectory, renderDirectory }, null, 2));
