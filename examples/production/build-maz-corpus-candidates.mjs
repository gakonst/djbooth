import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const corpusRoot = path.resolve(
  process.argv[2] ?? path.join(os.homedir(), "Library/Caches/djbooth/reference-corpora/maz-modern"),
);
const outputRoot = path.resolve(
  process.argv[3] ?? path.join(os.homedir(), "Music/djbooth-candidates/maz-corpus-v1"),
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
const at = (bar, beat = 0) => bar * 4 + beat;
const object = (value) => ({ kind: "object", object: value });

const candidates = [
  {
    id: "01-cobalt-canopy",
    title: "Cobalt Canopy",
    bpm: 123,
    key: "Bm",
    tonic: 35,
    progression: [0, -2, -4, -2],
    bassPreset: "Muted Wow Bass.adv",
    pluckPreset: "Acoustic String.adv",
    malletPreset: "Marimba Classic.adv",
    padPreset: "Noisy Pad.adv",
    hook: [0, 3, 7, 10, 7, 3],
    groove: 0,
    palette: 0,
  },
  {
    id: "02-salt-air",
    title: "Salt Air",
    bpm: 125,
    key: "Cm",
    tonic: 36,
    progression: [0, -5, -3, -2],
    bassPreset: "Saw Pure Muted Bass.adv",
    pluckPreset: "Tube Harp.adv",
    malletPreset: "Balafon Brushed.adv",
    padPreset: "Slow Pad.adv",
    hook: [7, 3, 0, 2, 3, 10],
    groove: 1,
    palette: 1,
  },
  {
    id: "03-amber-current",
    title: "Amber Current",
    bpm: 120,
    key: "Am",
    tonic: 33,
    progression: [0, -2, -5, -4],
    bassPreset: "Square Dual Muted Bass.adv",
    pluckPreset: "Digital String.adv",
    malletPreset: "Vibes Mellow.adv",
    padPreset: "High Pad.adv",
    hook: [0, 7, 10, 12, 10, 7],
    groove: 2,
    palette: 0,
  },
  {
    id: "04-night-bloom",
    title: "Night Bloom",
    bpm: 126,
    key: "F#m",
    tonic: 30,
    progression: [0, -2, -4, -5],
    bassPreset: "Muted Dark Bass.adv",
    pluckPreset: "Resonant Casing.adv",
    malletPreset: "Marimba Glassy.adv",
    padPreset: "Air Of Dread.adv",
    hook: [0, 3, 7, 9, 7, 2],
    groove: 3,
    palette: 0,
  },
  {
    id: "05-clay-horizon",
    title: "Clay Horizon",
    bpm: 120,
    key: "Bbm",
    tonic: 34,
    progression: [0, -4, -2, -5],
    bassPreset: "Square Percussive Bass.adv",
    pluckPreset: "Acoustic String.adv",
    malletPreset: "Xylophone Dark.adv",
    padPreset: "Slow Pad.adv",
    hook: [3, 0, 7, 5, 3, 10],
    groove: 4,
    palette: 1,
  },
  {
    id: "06-glass-river",
    title: "Glass River",
    bpm: 122,
    key: "Ebm",
    tonic: 27,
    progression: [0, -2, -4, 3],
    bassPreset: "Saw Sub Complex Bass.adv",
    pluckPreset: "Tube Harp.adv",
    malletPreset: "Bells Mellow.adv",
    padPreset: "Noisy Pad.adv",
    hook: [0, 10, 7, 3, 5, 7],
    groove: 5,
    palette: 0,
  },
  {
    id: "07-sky-loom",
    title: "Sky Loom",
    bpm: 125,
    key: "Cm",
    tonic: 36,
    progression: [0, -3, -5, -2],
    bassPreset: "Dual OSC Plastic Bass.adv",
    pluckPreset: "Digital String.adv",
    malletPreset: "Bell Airy.adv",
    padPreset: "High Pad.adv",
    hook: [7, 10, 12, 7, 5, 3],
    groove: 6,
    palette: 0,
  },
  {
    id: "08-brisa-nova",
    title: "Brisa Nova",
    bpm: 123,
    key: "Am",
    tonic: 33,
    progression: [0, -5, -2, -4],
    bassPreset: "Smooth SQU Bass.adv",
    pluckPreset: "Acoustic String.adv",
    malletPreset: "Balafon Bright.adv",
    padPreset: "Slow Pad.adv",
    hook: [0, 3, 7, 12, 7, 10],
    groove: 7,
    palette: 1,
  },
  {
    id: "09-body-signal",
    title: "Body Signal",
    bpm: 123,
    key: "Cm",
    tonic: 36,
    progression: [0, -2, 3, -5],
    bassPreset: "Saw Filter Bass.adv",
    pluckPreset: "Resonant Casing.adv",
    malletPreset: "Vibes Modulated.adv",
    padPreset: "Noisy Pad.adv",
    hook: [0, 2, 3, 7, 10, 7],
    groove: 8,
    palette: 0,
  },
  {
    id: "10-run-deep",
    title: "Run Deep",
    bpm: 120,
    key: "Bm",
    tonic: 35,
    progression: [0, -4, -5, -2],
    bassPreset: "Saw Pure Muted Bass.adv",
    pluckPreset: "Tube Harp.adv",
    malletPreset: "Marimba Sustain.adv",
    padPreset: "Air Of Dread.adv",
    hook: [7, 3, 0, 10, 7, 5],
    groove: 9,
    palette: 0,
  },
];

await mkdir(path.join(outputRoot, "specs"), { recursive: true });
const grammar = await deriveGrammar();
await writeFile(
  path.join(outputRoot, "production-grammar.json"),
  `${JSON.stringify(grammar, null, 2)}\n`,
);

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  corpusRoot,
  grammar: path.join(outputRoot, "production-grammar.json"),
  originality:
    "All notes and arrangements are newly generated from aggregate corpus statistics; no source audio, MIDI, melody, or vocal is reused.",
  renderer:
    "Ableton Core Library samples, standalone Ableton native devices, and Ableton abl.*~ DSP hosted headlessly; custom DSP is disabled.",
  candidates: [],
};

for (const config of candidates) {
  const spec = buildCandidate(config);
  const specPath = path.join(outputRoot, "specs", `${config.id}.json`);
  const output = path.join(outputRoot, `${config.id}.wav`);
  await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`);
  manifest.candidates.push({
    id: config.id,
    title: config.title,
    bpm: config.bpm,
    key: config.key,
    spec: specPath,
    output,
    stems: path.join(outputRoot, "stems", config.id),
  });
}

await writeFile(path.join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(
  path.join(outputRoot, "maz-corpus-v1.m3u"),
  `${manifest.candidates.map((candidate) => candidate.output).join("\n")}\n`,
);
console.log(path.join(outputRoot, "manifest.json"));

async function deriveGrammar() {
  const summary = JSON.parse(await readFile(path.join(corpusRoot, "corpus-summary.json"), "utf8"));
  const profiles = [];
  for (const entry of await readdir(corpusRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      profiles.push(
        JSON.parse(
          await readFile(path.join(corpusRoot, entry.name, "reference-profile.json"), "utf8"),
        ),
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const phraseBars = profiles.flatMap((profile) =>
    Object.entries(profile.phraseLengthHistogram ?? {}).flatMap(([bars, count]) =>
      Array.from({ length: count }, () => Number(bars)),
    ),
  );
  const syncopation = (stem) =>
    profiles.map((profile) => profile.stems?.[stem]?.syncopationRatio).filter(Number.isFinite);
  const bandRatios = (stem) =>
    profiles
      .map((profile) => profile.stems?.[stem])
      .filter(Boolean)
      .map(({ lowBandRatio, midBandRatio, highBandRatio }) => ({
        low: lowBandRatio,
        mid: midBandRatio,
        high: highBandRatio,
      }));
  return {
    schemaVersion: 1,
    evidence: {
      references: summary.completedTracks,
      transcriptionWindows: summary.transcription.windows,
      trustedNotes: summary.transcription.notes,
    },
    tempoBpm: distribution(profiles.map((profile) => profile.bpm)),
    keys: countBy(profiles, (profile) => profile.key),
    phraseBars: countBy(phraseBars, String),
    mixTargets: summary.profileMeans,
    onsetSixteenthCounts: summary.transcription.onsetSixteenthCounts,
    instrumentCounts: summary.transcription.instrumentCounts,
    drumPitchCounts: summary.transcription.drumPitchCounts,
    stems: {
      drums: {
        syncopation: distribution(syncopation("drums")),
        bands: meanBands(bandRatios("drums")),
      },
      bass: {
        syncopation: distribution(syncopation("bass")),
        bands: meanBands(bandRatios("bass")),
      },
      other: {
        syncopation: distribution(syncopation("other")),
        bands: meanBands(bandRatios("other")),
      },
    },
    appliedRules: [
      "Four-on-the-floor kick remains the anchor while late sixteenths carry the percussion swing.",
      "Bass is short, mono, low-register, and mostly syncopated around—not on top of—the kick.",
      "Harmonic parts are sparse, syncopated, mid-dominant, and wider than drums or bass.",
      "Eight-bar energy changes are expressed through subtraction and re-entry, not constant layering.",
      "The mix remains dark and low-heavy, with restrained top-end percussion and a controlled ceiling.",
    ],
  };
}

function buildCandidate(config) {
  const kick = [];
  const rim = [];
  const shaker = [];
  const congaLow = [];
  const congaHigh = [];
  const clave = [];
  const openHat = [];
  const reverse = [];
  const bass = [];
  const pluck = [];
  const mallet = [];
  const pad = [];
  const bassPatterns = [
    [
      [0.72, 0],
      [1.48, 7],
      [2.23, 0],
      [3.47, 0],
    ],
    [
      [0.48, 0],
      [1.72, 0],
      [2.47, 7],
      [3.73, 0],
    ],
    [
      [0.73, 0],
      [1.23, 7],
      [2.72, 0],
      [3.48, 3],
    ],
    [
      [0.47, 0],
      [1.48, 7],
      [2.24, 0],
      [3.72, 0],
    ],
    [
      [0.73, 0],
      [1.72, 3],
      [2.48, 0],
      [3.23, 7],
    ],
  ];
  const percussionPatterns = [
    [0.77, 1.76, 2.52, 3.78],
    [0.52, 1.53, 2.78, 3.53],
    [0.28, 1.28, 2.03, 3.28],
  ];
  const active = (bar) => (bar >= 4 && bar < 16) || bar >= 20;

  for (let bar = 0; bar < 24; bar += 1) {
    const full = active(bar);
    const breakdownBuild = bar >= 18 && bar < 20;
    if (bar < 24) {
      for (let step = 0; step < 16; step += 1) {
        if (bar < 2 && step % 2 === 1) continue;
        const late = step % 4 === 3 ? 0.02 + (config.groove % 3) * 0.004 : 0;
        const accent = step % 4 === 0 ? 100 : step % 2 === 0 ? 72 : 47;
        shaker.push(hit(at(bar, step * 0.25 + late), Math.round(accent * (full ? 1 : 0.75))));
      }
    }
    if (full || breakdownBuild) {
      for (let quarter = 0; quarter < 4; quarter += 1) {
        if (bar === 20 && quarter === 3) continue;
        kick.push(
          hit(
            at(bar, quarter),
            Math.round((quarter === 0 ? 124 : 116) * (breakdownBuild ? 0.76 : 1)),
          ),
        );
      }
    }
    if (full) {
      rim.push(hit(at(bar, 1.01), 91), hit(at(bar, 3.015), 100));
      const lowPattern = percussionPatterns[config.groove % percussionPatterns.length];
      const highPattern = percussionPatterns[(config.groove + 1) % percussionPatterns.length];
      lowPattern.forEach((offset, index) =>
        congaLow.push(hit(at(bar, offset), 78 + ((bar + index + config.groove) % 4) * 9)),
      );
      highPattern.forEach((offset, index) =>
        congaHigh.push(hit(at(bar, offset), 68 + ((bar + index) % 3) * 11)),
      );
      if (bar >= 8 && bar % 2 === config.groove % 2) {
        clave.push(hit(at(bar, 0.76), 78), hit(at(bar, 2.51), 69), hit(at(bar, 3.76), 91));
      }
      if (bar >= 12 || bar >= 20) {
        openHat.push(hit(at(bar, 1.5), 76), hit(at(bar, 3.5), bar % 4 === 3 ? 96 : 84));
      }
    }
    if ([7, 15, 19].includes(bar)) reverse.push(hit(at(bar, 3.48), 96));

    if (full || breakdownBuild) {
      const chordIndex = Math.floor(bar / 2) % config.progression.length;
      const root = config.tonic + config.progression[chordIndex];
      const pattern = bassPatterns[config.groove % bassPatterns.length];
      bass.push(note(at(bar, 0.055), 0.14, root, 68));
      pattern.forEach(([offset, interval], index) => {
        const variation = bar % 4 === 3 && index === pattern.length - 1 ? 12 : interval;
        bass.push(
          note(at(bar, offset), index % 2 === 0 ? 0.3 : 0.22, root + variation, 100 + index * 4),
        );
      });
    }

    if ((bar >= 2 && bar < 16) || bar >= 20) {
      const root = config.tonic + 24 + config.progression[Math.floor(bar / 2) % 4];
      const quality = config.progression[Math.floor(bar / 2) % 4] === 0 ? [0, 3, 7] : [0, 4, 7];
      const offsets = config.groove % 2 === 0 ? [1.02, 2.765] : [0.765, 2.515, 3.765];
      for (const offset of offsets) {
        quality.forEach((interval, index) =>
          pluck.push(note(at(bar, offset), 0.16 + index * 0.025, root + interval, 69 + index * 7)),
        );
      }
    }

    if (((bar >= 8 && bar < 16) || bar >= 20) && bar % 2 === 0) {
      const root = config.tonic + 36;
      const offsets = [0.78, 1.54, 2.79, 3.55];
      offsets.forEach((offset, index) => {
        const pitch = root + config.hook[(index + Math.floor(bar / 2)) % config.hook.length];
        mallet.push(note(at(bar, offset), index === 2 ? 0.32 : 0.2, pitch, 76 + index * 7));
      });
    }
  }

  for (let bar = 16; bar < 20; bar += 2) {
    const root = config.tonic + 36 + config.progression[((bar - 16) / 2) % 4];
    const quality = root % 12 === config.tonic % 12 ? [0, 3, 7, 10] : [0, 4, 7, 11];
    quality.forEach((interval) => pad.push(note(at(bar), 7.55, root + interval, 53)));
  }
  for (const bar of [20]) {
    const root = config.tonic + 36;
    [0, 3, 7, 10].forEach((interval) => pad.push(note(at(bar), 15.4, root + interval, 38)));
  }

  const palettes = [
    {
      kick: "One Shots/Drums/Kick/Kick 909 Prommer.wav",
      rim: "One Shots/Drums/Rim/Rim Sidestick Gen Purpose.aif",
      shaker: "One Shots/Drums/Shaker/Shaker Acoustic.aif",
      congaLow: "One Shots/Drums/Conga/Conga Acoustified Low.wav",
      congaHigh: "One Shots/Drums/Conga/Conga Acoustified Hi.wav",
    },
    {
      kick: "One Shots/Drums/Kick/Kick Sub Dirt.aif",
      rim: "One Shots/Drums/Rim/Rim 808.aif",
      shaker: "One Shots/Drums/Shaker/Shaker Low Short.wav",
      congaLow: "One Shots/Drums/Conga/Conga 808 Low.aif",
      congaHigh: "One Shots/Drums/Conga/Conga 808 Hi.aif",
    },
    {
      kick: "One Shots/Drums/Kick/Kick Remo.aif",
      rim: "One Shots/Drums/Rim/Rim Sidestick Soft Dry Session.aif",
      shaker: "One Shots/Drums/Shaker/Shaker Egg.aif",
      congaLow: "One Shots/Drums/Conga/Conga Low 505.aif",
      congaHigh: "One Shots/Drums/Conga/Conga Hi 505.aif",
    },
  ];
  const palette = palettes[config.palette];
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
  return {
    schemaVersion: 1,
    title: `${config.title} — corpus-conditioned candidate`,
    bpm: config.bpm,
    bars: 24,
    beatsPerBar: 4,
    sampleRate: 44100,
    tailSeconds: 3,
    master: {
      inputGainDb: -1,
      outputGainDb: 0,
      effects: [
        object("abl.device.channeleq~ @lowgain 0.4 @midfreq 480 @midgain -0.5 @highgain 0.4"),
        object(
          "abl.device.limiter~ @maximize 1 @threshold -11 @output -1 @link 1 @autorelease 1 @lookahead 2",
        ),
      ],
    },
    conditioning: {
      corpus: corpusRoot,
      key: config.key,
      appliedGrammar: [
        "syncopated mono bass",
        "late percussion",
        "sparse midrange harmony",
        "8-bar energy blocks",
      ],
    },
    tracks: [
      sampleTrack("kick", palette.kick, kick, 0.5, 0, [
        object("abl.device.channeleq~ @lowgain 1 @midfreq 360 @midgain -1.2 @highgain -0.7"),
      ]),
      sampleTrack("rim", palette.rim, rim, -7, 0.08, [
        object("abl.device.reverb~ @decay 0.7 @damping 0.65 @predelay 0.01 @mix 0.08"),
      ]),
      sampleTrack("shaker", palette.shaker, shaker, -13, -0.42, [
        object("abl.device.channeleq~ @lowgain -6 @midfreq 1800 @midgain -1 @highgain 1"),
      ]),
      sampleTrack("conga-low", palette.congaLow, congaLow, -7, -0.28, [
        object(
          "abl.device.roar~ @input_gain 0 @blend 0.08 @shaper_amount_1 0.12 @tone_frequency 800 @tone_amount 0.05",
        ),
      ]),
      sampleTrack("conga-high", palette.congaHigh, congaHigh, -7.5, 0.36, [
        object("abl.device.reverb~ @decay 0.55 @damping 0.7 @predelay 0.008 @mix 0.05"),
      ]),
      sampleTrack("clave", "One Shots/Drums/Wood/Wood Claves.aif", clave, -10, -0.38, [
        object("abl.device.echo~ @feedback 0.16 @mix 0.07 @reverb 0.04 @wobble 0"),
      ]),
      sampleTrack("open-hat", "One Shots/Drums/Hihat/Hihat Open 909.aif", openHat, -12, 0.1),
      sampleTrack(
        "reverse-cymbal",
        "One Shots/Drums/Cymbal/Cymbal Crash Reverse Gnirob.wav",
        reverse,
        -10,
        0.1,
        [object("abl.device.reverb~ @decay 1.3 @damping 0.58 @predelay 0 @mix 0.15")],
      ),
      {
        id: "analog-bass",
        kind: "native",
        device: "Analog",
        // These four presets are validated to restore non-silently through the
        // standalone native-device ABI. Other installed presets remain corpus
        // candidates, but are not promoted until they pass that compatibility test.
        preset: atDevice("Instruments/Analog/Bass/Muted Wow Bass.adv"),
        gainDb: 35.5,
        pan: 0,
        effects: [
          object("abl.device.utility~ @bass_mono 1 @bass_mono_frequency 180 @mono 0 @gain 0"),
          object(
            "abl.device.roar~ @input_gain 0 @blend 0.06 @shaper_amount_1 0.1 @tone_frequency 520 @tone_amount 0.04",
          ),
        ],
        notes: bass,
      },
      {
        id: "plucked-chords",
        kind: "native",
        device: "Collision",
        preset: atDevice("Instruments/Collision/Guitar & Plucked/Acoustic String.adv"),
        gainDb: 4.5,
        pan: -0.42,
        effects: [
          object(
            "abl.dsp.chorus~ @mix 0.32 @width 0.92 @rate 0.11 @mod 0.2 @feedback 0.04 @gain 1",
          ),
          object("abl.device.reverb~ @decay 0.9 @damping 0.64 @predelay 0.014 @mix 0.1"),
        ],
        notes: pluck,
      },
      {
        id: "mallet-hook",
        kind: "native",
        device: "Collision",
        preset: atDevice("Instruments/Collision/Mallets/Marimba Classic.adv"),
        gainDb: 1.5,
        pan: 0.42,
        effects: [
          object(
            "abl.dsp.chorus~ @mix 0.13 @width 0.72 @rate 0.09 @mod 0.12 @feedback 0.03 @gain 1",
          ),
          object("abl.device.echo~ @feedback 0.28 @mix 0.15 @reverb 0.09 @wobble 0.02"),
        ],
        notes: mallet,
      },
      {
        id: "breakdown-pad",
        kind: "native",
        device: "Collision",
        preset: atDevice("Instruments/Collision/Ambient & Evolving/Noisy Pad.adv"),
        gainDb: 9.5,
        pan: 0,
        effects: [
          object(
            "abl.dsp.chorus~ @mix 0.28 @width 0.9 @rate 0.07 @mod 0.22 @feedback 0.05 @gain 1",
          ),
          object("abl.device.reverb~ @decay 2.1 @damping 0.58 @predelay 0.024 @mix 0.22"),
          object("abl.device.utility~ @bass_mono 1 @bass_mono_frequency 150 @gain 0"),
        ],
        notes: pad,
      },
    ],
  };
}

function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  const quantile = (ratio) => sorted[Math.round((sorted.length - 1) * ratio)];
  return {
    count: sorted.length,
    min: sorted[0],
    q25: quantile(0.25),
    median: quantile(0.5),
    q75: quantile(0.75),
    max: sorted.at(-1),
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  };
}

function meanBands(values) {
  return Object.fromEntries(
    ["low", "mid", "high"].map((band) => [
      band,
      values.reduce((sum, value) => sum + value[band], 0) / values.length,
    ]),
  );
}

function countBy(values, key) {
  return Object.fromEntries(
    [
      ...values.reduce((counts, value) => {
        const id = key(value);
        counts.set(id, (counts.get(id) ?? 0) + 1);
        return counts;
      }, new Map()),
    ].sort((left, right) => right[1] - left[1]),
  );
}
