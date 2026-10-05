import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDirectory = path.resolve(
  process.argv[2] ?? "/Users/gakonst/Library/Caches/djbooth/tutorial-rich",
);
const output = path.resolve(
  process.argv[3] ?? path.join(here, "tutorial-rich-variants", "ranking.json"),
);
const names = ["01-focused-depth", "02-warm-density", "03-dimensional-detail"];
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

const candidates = [];
for (const name of names) {
  const profile = await readJson(path.join(cacheDirectory, `${name}-profile.json`));
  const comparison = await readJson(path.join(cacheDirectory, `${name}-comparison.json`));
  candidates.push({
    name,
    audio: profile.source,
    overallScore: comparison.overallScore,
    categories: comparison.categories,
    peakDb: profile.mix.peakDb,
    rmsDb: profile.mix.rmsDb,
    crestFactorDb: profile.mix.crestFactorDb,
    transientDensityPerSecond: profile.mix.transientDensityPerSecond,
    stereoCorrelation: profile.mix.stereoCorrelation,
    stereoWidthDb: profile.mix.stereoWidthDb,
    lowBandRatio: profile.mix.lowBandRatio,
    midBandRatio: profile.mix.midBandRatio,
    highBandRatio: profile.mix.highBandRatio,
    syncopationRatio: profile.mix.syncopationRatio,
  });
}
candidates.sort((left, right) => right.overallScore - left.overallScore);
const winner = candidates[0];

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  reference: "/Users/gakonst/Music/old/Bronski Beat - Smalltown Boy.mp3",
  winner: winner.name,
  winnerAudio: winner.audio,
  candidates,
  learnedConstraints: [
    {
      finding: "Centered nonlinear bass outperformed chorus-heavy low-end width.",
      evidence: "warm-density stereo correlation remained close to the reference while preserving high timbre similarity",
      nextAction: "Keep sub and bass-center recipes mono-compatible; create width above the bass layer.",
    },
    {
      finding: "Dark bounded ambience added depth more reliably than maximum width.",
      evidence: "focused-depth and dimensional-detail achieved strong timbre but lost substantial stereo-fit score",
      nextAction: "Use dark rooms and plates on selected layers; reserve wide echoes for sparse phrases.",
    },
    {
      finding: "More processing stages did not imply a better result.",
      evidence: "the 18-stage warm-density variant beat the 21-stage dimensional-detail variant",
      nextAction: "Promote recipes by measured A/B outcome, not chain length.",
    },
    {
      finding: "Factory mastering presets must demonstrate a dynamics improvement before retention.",
      evidence: "Glue Make It Loud changed level by only 0.25 dB and left crest factor effectively unchanged",
      nextAction: "Reject no-op mastering stages and solve loudness with a separately tested real Ableton chain.",
    },
  ],
};

await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output, winner: report.winner, candidates }, null, 2));
