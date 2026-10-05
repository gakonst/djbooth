import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusPath = path.resolve(
  process.argv[2] ?? path.join(here, "ableton-tutorial-corpus.json"),
);
const output = path.resolve(
  process.argv[3] ?? path.join(here, "ableton-tutorial-recipes.json"),
);
const coreEffects =
  "/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Core Library/Devices/Audio Effects";
const corpus = JSON.parse(await readFile(corpusPath, "utf8"));

const source = (...needles) => {
  const articles = corpus.officialArticles.filter((article) =>
    needles.some((needle) => article.title.toLowerCase().includes(needle.toLowerCase())),
  );
  return articles.map(({ title, url, media }) => ({ title, url, media }));
};
const effect = (device, preset) => ({
  kind: "native",
  device,
  preset: path.join(coreEffects, preset),
});

const recipes = {
  lowEndAuthority: {
    goal: "Keep the fundamental centered, add audible upper harmonics, then control the envelope.",
    principles: [
      "mono compatibility before enhancement",
      "harmonic density makes bass audible without relying only on sub level",
      "compression follows nonlinear color so added harmonics remain controlled",
    ],
    sources: source("Low End Theory", "808 Bass Tutorials", "Get Deep: Make a Sub Bass"),
    chain: [
      effect("Utility", "Utility/Bass Mono.adv"),
      effect("Roar", "Roar/Bass Fattener.adv"),
      effect("GlueCompressor", "Glue Compressor/Bass - Punch.adv"),
    ],
  },
  focusedPulse: {
    goal: "Add subtle ensemble motion while restoring a centered, punchy low register.",
    principles: ["modulation is restrained on low material", "finish with mono-compatible utility"],
    sources: source("Low End Theory", "Synthesis 101"),
    chain: [
      effect("Chorus2", "Chorus-Ensemble/Chorus Bass.adv"),
      effect("GlueCompressor", "Glue Compressor/Bass - Punch.adv"),
      effect("Utility", "Utility/Bass Mono.adv"),
    ],
  },
  kickAuthority: {
    goal: "Separate kick body, nonlinear attack, and transient contour into deliberate stages.",
    principles: ["correct broad tone first", "color second", "transient contour last"],
    sources: source("Enter the Temple of Boom", "Making the Beat", "Kick Drum"),
    chain: [
      effect("Eq8", "EQ Eight/Drums/Kick EQ 3.adv"),
      effect("Roar", "Roar/Kick Me.adv"),
      effect("DrumBuss", "Drum Buss/Transient Shaping Enhance.adv"),
    ],
  },
  snareDepth: {
    goal: "Shape the dry snare before placing it in a dark, bounded room.",
    principles: ["pre-reverb tonal cleanup", "short dark reflections imply depth without washing the groove"],
    sources: source("Reverb Reflections", "Snare", "Temple of Boom"),
    chain: [
      effect("Eq8", "EQ Eight/Drums/Snare EQ 2.adv"),
      effect("HybridReverb", "Hybrid Reverb/Drums/Dark Snare Room.adv"),
    ],
  },
  clapDimension: {
    goal: "Give the clap a distinct hybrid reflection that sits behind the main snare.",
    principles: ["different percussion occupies different depth planes", "ambience remains event-specific"],
    sources: source("Reverb Reflections", "Layering"),
    chain: [effect("HybridReverb", "Hybrid Reverb/Drums/Clap Hybrid.adv")],
  },
  hatAir: {
    goal: "Control brittle hat frequencies, then add restrained high-frequency density.",
    principles: ["remove harshness before enhancement", "top-end color stays off the low-frequency layers"],
    sources: source("noise-based hi-hats", "Drums Noisy", "High-impact"),
    chain: [
      effect("Eq8", "EQ Eight/Drums/Hat EQ 2.adv"),
      effect("Roar", "Roar/Mix High End Sparkler.adv"),
    ],
  },
  padDepth: {
    goal: "Use ensemble motion for width and a dark plate for a stable rear depth plane.",
    principles: ["modulation creates width", "dark reverb separates rear layers from bright foreground"],
    sources: source("Reverb Reflections", "lush pads", "Stacking Layers"),
    chain: [
      effect("Chorus2", "Chorus-Ensemble/Ensemble Deep.adv"),
      effect("HybridReverb", "Hybrid Reverb/Hall/Medium Dark Plate.adv"),
    ],
  },
  padTapeDepth: {
    goal: "Add gentle tape-like density before ensemble width and a dark rear reflection.",
    principles: ["harmonic color precedes spatial processing", "dark tails make a layer feel farther away"],
    sources: source("Roar", "Stacking Layers", "Reverb Reflections"),
    chain: [
      effect("Roar", "Roar/Mix Fat Tape.adv"),
      effect("Chorus2", "Chorus-Ensemble/Warm Ensemble.adv"),
      effect("HybridReverb", "Hybrid Reverb/Hall/Medium Dark Plate.adv"),
    ],
  },
  leadPerspective: {
    goal: "Create rhythmic depth with a tempo-related echo before a compact dark tail.",
    principles: ["delay supplies rhythmic perspective", "reverb glues repeats into one depth plane"],
    sources: source("Beyond the Echo Chamber", "Reverb Reflections", "Everything Echo"),
    chain: [
      effect("Delay", "Delay/Clean Delay/Dotted Eighth Note.adv"),
      effect("HybridReverb", "Hybrid Reverb/Hall/Medium Dark Plate.adv"),
    ],
  },
  leadWideEcho: {
    goal: "Use a wide ping-pong echo on sparse phrases while keeping the main pulse centered.",
    principles: ["width belongs to sparse upper layers", "echo movement contrasts with a stable rhythm section"],
    sources: source("Beyond the Echo Chamber", "Everything Echo"),
    chain: [
      effect("Echo", "Echo/Clean Delay/Ping Pong Wide.adv"),
      effect("Reverb", "Reverb/Special/Short Ambience.adv"),
    ],
  },
  granularEarCandy: {
    goal: "Transform a quiet duplicate into an unstable detail layer, not a new foreground part.",
    principles: ["resample or duplicate selectively", "spectral novelty works best at low level and phrase boundaries"],
    sources: source("Designing Melodic Ear Candy", "Against the Grain", "Feedback Loops"),
    chain: [
      effect("GrainDelay", "Grain Delay/Bubbles.adv"),
      effect("Roar", "Roar/Mix Mid Side Enhance.adv"),
      effect("HybridReverb", "Hybrid Reverb/Space/Filtered Dub Tech.adv"),
    ],
  },
  percussionElectricity: {
    goal: "Turn selected secondary percussion into a short, animated texture layer.",
    principles: ["process supporting percussion more aggressively than anchors", "short ambience contains the result"],
    sources: source("Designing Melodic Ear Candy", "Against the Grain", "Complex Beatmaking"),
    chain: [
      effect("GrainDelay", "Grain Delay/Drum Electrifier.adv"),
      effect("HybridReverb", "Hybrid Reverb/Drums/Short Bliss.adv"),
    ],
  },
  warmDrumColor: {
    goal: "Add cohesive nonlinear color to drums without replacing their individual transient work.",
    principles: ["bus color is subtler than sound-design distortion", "transient detail survives saturation"],
    sources: source("Temple of Boom", "Drum Buss", "Roar"),
    chain: [
      effect("Roar", "Roar/Drum Kit Enhancer.adv"),
      effect("DrumBuss", "Drum Buss/Punchy Driven .adv"),
    ],
  },
};

for (const [name, recipe] of Object.entries(recipes)) {
  if (!recipe.sources.length) throw new Error(`${name} has no matching tutorial provenance`);
  for (const stage of recipe.chain) {
    await access(stage.preset);
  }
}

const document = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  corpus: corpusPath,
  method: {
    synthesis: "Paraphrase repeated tutorial principles into serial device-chain recipes.",
    execution: "Every stage points to an installed Ableton ADV rendered by Ableton's own engine.",
    exclusions: ["no copied tutorial text", "no custom audio DSP", "no guessed third-party effect algorithm"],
  },
  recipes,
};

await writeFile(output, `${JSON.stringify(document, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      output,
      recipes: Object.keys(recipes).length,
      stages: Object.values(recipes).reduce((count, recipe) => count + recipe.chain.length, 0),
      sources: new Set(Object.values(recipes).flatMap((recipe) => recipe.sources.map((item) => item.url))).size,
    },
    null,
    2,
  ),
);
