import { readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(
  process.argv[2] ?? path.join(os.homedir(), "Music/djbooth-candidates/maz-corpus-v1"),
);
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const ranked = [];

for (const candidate of manifest.candidates) {
  const analysisRoot = path.join(root, "analysis", candidate.id);
  const profile = JSON.parse(
    await readFile(path.join(analysisRoot, "reference-profile.json"), "utf8"),
  );
  const comparisonRoot = path.join(analysisRoot, "comparisons");
  const comparisons = await Promise.all(
    (await readdir(comparisonRoot))
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => ({
        id: path.basename(name, ".json"),
        value: JSON.parse(await readFile(path.join(comparisonRoot, name), "utf8")),
      })),
  );
  const categoryNames = Object.keys(comparisons[0].value.categories);
  const categories = Object.fromEntries(
    categoryNames.map((name) => [
      name,
      mean(comparisons.map(({ value }) => value.categories[name])),
    ]),
  );
  const balance = (left, right) => profile.stems[left].rmsDb - profile.stems[right].rmsDb;
  ranked.push({
    ...candidate,
    averageCorpusScore: mean(comparisons.map(({ value }) => value.overallScore)),
    categories,
    nearestReferences: comparisons
      .map(({ id, value }) => ({ id, score: value.overallScore }))
      .sort((left, right) => right.score - left.score)
      .slice(0, 3),
    renderedAudio: {
      durationSeconds: profile.durationSeconds,
      detectedBpm: profile.bpm,
      peakDb: profile.mix.peakDb,
      rmsDb: profile.mix.rmsDb,
      crestFactorDb: profile.mix.crestFactorDb,
      transientDensityPerSecond: profile.mix.transientDensityPerSecond,
      stereoWidthDb: profile.mix.stereoWidthDb,
      sectionContrastDb:
        Math.max(...profile.mix.sectionRmsDb) - Math.min(...profile.mix.sectionRmsDb),
      lowBandRatio: profile.mix.lowBandRatio,
      midBandRatio: profile.mix.midBandRatio,
      highBandRatio: profile.mix.highBandRatio,
      bassToDrumsDb: balance("bass", "drums"),
      otherToDrumsDb: balance("other", "drums"),
      bassSyncopation: profile.stems.bass.syncopationRatio,
    },
  });
}

ranked.sort((left, right) => right.averageCorpusScore - left.averageCorpusScore);
ranked.forEach((candidate, index) => {
  candidate.rank = index + 1;
});

const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  method:
    "Each candidate is acoustically profiled from its rendered mix and grouped stems, compared with all 17 corpus profiles, then ranked by mean overall profile score.",
  candidates: ranked,
};
await writeFile(path.join(root, "ranking.json"), `${JSON.stringify(result, null, 2)}\n`);

const lines = [
  "# Maz-corpus candidate listening set",
  "",
  "Ten original 24-bar sketches generated from aggregate evidence across 17 references. No reference audio, MIDI, melody, or vocal is reused.",
  "",
  "| Rank | Candidate | BPM / key | Corpus fit | Groove | Balance | Timbre |",
  "| ---: | --- | --- | ---: | ---: | ---: | ---: |",
  ...ranked.map(
    (candidate) =>
      `| ${candidate.rank} | [${candidate.title}](./${path.basename(candidate.output)}) | ${candidate.bpm} / ${candidate.key} | ${candidate.averageCorpusScore.toFixed(1)} | ${candidate.categories.groove.toFixed(1)} | ${candidate.categories.balance.toFixed(1)} | ${candidate.categories.timbre.toFixed(1)} |`,
  ),
  "",
  "The fit score is a diagnostic ranking, not an aesthetic verdict. It measures rendered tempo, macro-dynamics, groove shape, stem balance, stereo image, and broad timbre against every reference profile.",
  "",
];
await writeFile(path.join(root, "README.md"), `${lines.join("\n")}\n`);
await writeFile(
  path.join(root, "ranked.m3u"),
  `${ranked.map((candidate) => candidate.output).join("\n")}\n`,
);
console.log(path.join(root, "ranking.json"));

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
