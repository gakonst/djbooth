import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { searchYoutube } from "../../packages/ytdlp-ts/dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(
  process.argv[2] ?? path.join(here, "house-taste-corpus/house-tutorial-corpus.json"),
);
const matchesPath = path.join(path.dirname(output), "spotify-house-tracks.json");
const taste = JSON.parse(await readFile(matchesPath, "utf8"));

const queries = [
  "Adam Ten Mita Gami indie dance production tutorial Ableton",
  "OMRI Rafael indie dance production tutorial Ableton",
  "Echonomist production tutorial track breakdown Ableton",
  "Trikk indie dance production tutorial Ableton",
  "Maz Antdot afro house production tutorial Ableton",
  "Keinemusik afro house start to finish Ableton",
  "indie dance full track start to finish Ableton",
  "indie dance bass sound design Ableton Serum",
  "indie dance percussion groove Ableton tutorial",
  "indie dance synth lead pluck sound design Serum",
  "afro house full track start to finish Ableton",
  "afro house percussion groove polyrhythm Ableton",
  "afro house bassline sound design Ableton Serum",
  "afro house vocal processing Ableton tutorial",
  "afro house organic instruments texture Ableton",
  "melodic house full track start to finish Ableton",
  "melodic house chord voicing harmony Ableton tutorial",
  "melodic house arrangement tension release Ableton",
  "melodic house atmospheric texture sound design Ableton",
  "melodic techno professional track breakdown Ableton",
  "tech house full track start to finish Ableton professional",
  "tech house groove swing bass relationship Ableton",
  "tech house drum processing professional Ableton",
  "tech house bass sound design Serum tutorial",
  "Chris Lake track from scratch production breakdown",
  "Max Styler production tutorial Ableton",
  "house music sample flip disco new wave Ableton",
  "house vocal chop hook processing Ableton",
  "house arrangement transitions ear candy Ableton",
  "house kick bass low end mixing professional Ableton",
  "house parallel processing sends depth Ableton tutorial",
  "house saturation clipping loudness Ableton professional",
  "house stereo depth reverb delay Ableton professional",
  "house percussion humanization groove pool Ableton",
  "house track deconstruction producer masterclass",
  "FaderPro house producer masterclass Ableton",
  "Production Music Live house track from scratch Ableton",
  "Bound to Divide house start to finish Ableton",
  "Dilby house production tutorial Ableton",
  "Audioreakt house production Ableton tutorial",
];

const found = [];
const failures = [];
for (const [index, query] of queries.entries()) {
  try {
    const results = await searchYoutube(query, { limit: 12 });
    found.push(...results.map((result) => ({ ...result, query })));
    process.stderr.write(`[${index + 1}/${queries.length}] ${query}: ${results.length}\n`);
  } catch (error) {
    failures.push({ query, error: error instanceof Error ? error.message : String(error) });
  }
}

const byId = new Map();
for (const result of found) {
  const existing = byId.get(result.id);
  if (existing) {
    existing.queries.push(result.query);
    continue;
  }
  byId.set(result.id, {
    id: result.id,
    title: result.title,
    url: result.url,
    uploader: result.uploader,
    uploaderId: result.uploaderId,
    durationSeconds: result.durationSeconds,
    queries: [result.query],
    categories: categories(`${result.title} ${result.query}`),
    devices: [],
  });
}

const candidates = [...byId.values()]
  .filter((video) => video.durationSeconds >= 240 && video.durationSeconds <= 18_000)
  .map((video) => ({ ...video, priority: priority(video) }))
  .sort((left, right) => right.priority - left.priority || left.title.localeCompare(right.title));
const corpus = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  focus: "house-production",
  tasteAnchors: taste.artists.slice(0, 40).map((artist) => ({
    name: artist.name,
    genres: artist.genres,
    tasteScore: artist.tasteScore,
  })),
  collectionPolicy: {
    retained:
      "public metadata, source links, available captions, timestamped action windows, and sparse UI frames",
    ephemeral: "source video is deleted after frame extraction",
    synthesis:
      "store evidence-addressable paraphrases and production recipes, not copied narration",
  },
  counts: {
    queries: queries.length,
    uniqueResults: byId.size,
    eligibleResults: candidates.length,
    searchFailures: failures.length,
  },
  sources: { youtubeQueries: queries },
  prioritizedOfficial: [],
  youtubeTutorialCandidates: candidates,
  searchFailures: failures,
};
await writeFile(output, `${JSON.stringify(corpus, null, 2)}\n`);
await writeFile(output.replace(/\.json$/u, ".md"), renderMarkdown(corpus));
console.log(JSON.stringify({ output, ...corpus.counts }, null, 2));

function categories(text) {
  const rules = [
    ["style-language", /indie dance|afro house|tech house|melodic house|melodic techno/i],
    ["arrangement", /arrang|tension|transition|start to finish|from scratch/i],
    ["bass", /bass|low end/i],
    ["drums-groove", /drum|groove|swing|percussion|rhythm/i],
    ["fx-mix", /mix|reverb|delay|saturat|clip|parallel|stereo|depth|loud/i],
    ["harmony-melody", /chord|harmon|melod|lead|pluck|hook/i],
    ["sampling-vocals", /sampl|vocal|chop|disco|new wave/i],
    ["sound-design", /sound design|serum|synth|texture/i],
  ];
  return rules.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function priority(video) {
  const text = `${video.title} ${video.uploader ?? ""} ${video.queries.join(" ")}`.toLowerCase();
  const trusted = [
    "ableton",
    "audioreakt",
    "bound to divide",
    "dilby",
    "dj mag",
    "ethan davis",
    "faderpro",
    "production music live",
    "seed to stage",
    "the producer school",
    "underdog",
  ];
  let score = video.queries.length * 8 + video.categories.length * 4;
  if (trusted.some((name) => text.includes(name))) score += 16;
  if (/start to finish|from scratch|masterclass|breakdown|deconstruct/i.test(text)) score += 12;
  if (/adam ten|mita gami|omri|rafael|echonomist|trikk|maz|antdot/i.test(text)) score += 14;
  if (video.durationSeconds >= 900 && video.durationSeconds <= 10_800) score += 6;
  return score;
}

function renderMarkdown(corpus) {
  const lines = [
    "# House production tutorial corpus",
    "",
    `${corpus.counts.eligibleResults} eligible videos found by ${corpus.counts.queries} taste-directed searches.`,
    "",
    "## Highest-priority sources",
    "",
    "| Tutorial | Creator | Minutes | Coverage |",
    "| --- | --- | ---: | --- |",
  ];
  for (const video of corpus.youtubeTutorialCandidates.slice(0, 100)) {
    lines.push(
      `| [${video.title}](${video.url}) | ${video.uploader ?? ""} | ${(video.durationSeconds / 60).toFixed(1)} | ${video.categories.join(", ")} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}
