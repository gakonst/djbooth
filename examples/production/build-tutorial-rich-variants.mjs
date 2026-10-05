import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const basePath = path.resolve(
  process.argv[2] ?? path.join(here, "smalltown-inspired-graph.json"),
);
const recipesPath = path.resolve(
  process.argv[3] ?? path.join(here, "ableton-tutorial-recipes.json"),
);
const outputDirectory = path.resolve(
  process.argv[4] ?? path.join(here, "tutorial-rich-variants"),
);
const base = JSON.parse(await readFile(basePath, "utf8"));
const recipeDocument = JSON.parse(await readFile(recipesPath, "utf8"));
const recipes = recipeDocument.recipes;

const effectChain = (name) =>
  recipes[name].chain.map(({ kind, device, preset }) => ({ kind, device, preset }));
const beat = (bar) => bar * base.beatsPerBar;
const placements = (...ranges) =>
  ranges.map(([startBar, endBar]) => ({ startBeat: beat(startBar), endBeat: beat(endBar) }));

const variants = {
  "01-focused-depth": {
    description: "Centered low end, dark bounded rooms, controlled ensemble width, dotted rhythmic lead depth.",
    masterGainDb: 2.2,
    tracks: {
      "ableton-dmx-kick": "kickAuthority",
      "ableton-linn-snare": "snareDepth",
      "ableton-707-clap": "clapDimension",
      "ableton-dmx-closed-hat": "hatAir",
      "serum-octave-pulse": "focusedPulse",
      "serum-shadow-pad": "padDepth",
      "serum-neon-lead": "leadPerspective",
    },
    earCandy: false,
    percussionTexture: false,
  },
  "02-warm-density": {
    description: "Mono-compatible saturated pulse, tape-thick pad, punchier anchors, restrained granular percussion.",
    masterGainDb: 13.2,
    tracks: {
      "ableton-dmx-kick": "kickAuthority",
      "ableton-linn-snare": "snareDepth",
      "ableton-707-clap": "clapDimension",
      "ableton-dmx-closed-hat": "hatAir",
      "ableton-80s-tambourine": "percussionElectricity",
      "serum-octave-pulse": "lowEndAuthority",
      "serum-shadow-pad": "padTapeDepth",
      "serum-neon-lead": "leadWideEcho",
    },
    earCandy: false,
    percussionTexture: true,
    foregroundHook: true,
  },
  "03-dimensional-detail": {
    description: "Focused rhythm section plus deeper pad, wide sparse lead echoes, and low-level granular phrase details.",
    masterGainDb: 8.7,
    tracks: {
      "ableton-dmx-kick": "kickAuthority",
      "ableton-linn-snare": "snareDepth",
      "ableton-707-clap": "clapDimension",
      "ableton-dmx-closed-hat": "hatAir",
      "ableton-80s-tambourine": "percussionElectricity",
      "serum-octave-pulse": "focusedPulse",
      "serum-shadow-pad": "padTapeDepth",
      "serum-neon-lead": "leadWideEcho",
    },
    earCandy: true,
    percussionTexture: true,
  },
};

await mkdir(outputDirectory, { recursive: true });
const outputs = [];
for (const [name, variant] of Object.entries(variants)) {
  const graph = structuredClone(base);
  graph.title = `Night Bus — tutorial-rich ${name}`;
  graph.master.inputGainDb = variant.masterGainDb;
  graph.provenance = {
    ...graph.provenance,
    tutorialCorpus: path.join(here, "ableton-tutorial-corpus.json"),
    tutorialRecipes: recipesPath,
    tutorialVariant: name,
    tutorialVariantDescription: variant.description,
    customAudioDsp: false,
  };
  graph.tracks = graph.tracks.map((track) => {
    const recipe = variant.tracks[track.id];
    return recipe
      ? {
          ...track,
          effects: effectChain(recipe),
          tutorialRecipe: recipe,
        }
      : track;
  });

  if (variant.earCandy) {
    const lead = graph.tracks.find((track) => track.id === "serum-neon-lead");
    if (!lead) throw new Error("base graph has no Serum lead for ear-candy derivation");
    graph.tracks.push({
      ...structuredClone(lead),
      id: "serum-granular-ear-candy",
      gainDb: -4,
      pan: -0.16,
      placements: placements([38, 40], [70, 72], [86, 88]),
      effects: effectChain("granularEarCandy"),
      tutorialRecipe: "granularEarCandy",
    });
  }

  if (variant.foregroundHook) {
    const lead = graph.tracks.find((track) => track.id === "serum-neon-lead");
    if (!lead) throw new Error("base graph has no Serum lead for foreground-hook derivation");
    lead.gainDb = 8;
    graph.tracks.push({
      ...structuredClone(lead),
      id: "serum-hook-foreground",
      gainDb: 0,
      pan: 0,
      effects: [],
      tutorialRecipe: "foregroundMelody",
    });
  }

  const graphPath = path.join(outputDirectory, `${name}.json`);
  await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`);
  outputs.push({
    name,
    description: variant.description,
    graph: graphPath,
    tracks: graph.tracks.length,
    effects: graph.tracks.reduce((count, track) => count + (track.effects?.length ?? 0), 0),
  });
}

console.log(JSON.stringify({ outputDirectory, variants: outputs }, null, 2));
