import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { searchYoutube } from "../../packages/ytdlp-ts/dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(
  process.argv[2] ?? path.join(here, "ableton-tutorial-corpus.json"),
);
const capabilitiesPath = path.resolve(process.argv[3] ?? "/tmp/ableton-capabilities.json");
const capabilities = JSON.parse(await readFile(capabilitiesPath, "utf8"));
const familyByName = new Map(
  capabilities.families.map((family) => [normalize(family.family), family]),
);

const deviceAliases = {
  "amp": "Amp",
  "analog": "UltraAnalog",
  "auto filter": "AutoFilter",
  "auto pan": "AutoPan",
  "auto shift": "AutoShift",
  "beat repeat": "BeatRepeat",
  "cabinet": "Cabinet",
  "channel eq": "ChannelEq",
  "chorus": "Chorus2",
  "chorus-ensemble": "Chorus2",
  "collision": "Collision",
  "compressor": "Compressor2",
  "corpus": "Corpus",
  "delay": "Delay",
  "drift": "Drift",
  "drum buss": "DrumBuss",
  "drum sampler": "DrumCell",
  "echo": "Echo",
  "electric": "LoungeLizard",
  "erosion": "Erosion",
  "eq eight": "Eq8",
  "frequency shifter": "FrequencyShifter",
  "gate": "Gate",
  "glue compressor": "GlueCompressor",
  "grain delay": "GrainDelay",
  "hybrid reverb": "Hybrid",
  "limiter": "Limiter",
  "looper": "Looper",
  "meld": "InstrumentMeld",
  "multiband dynamics": "MultibandDynamics",
  "operator": "Operator",
  "redux": "Redux",
  "resonator": "Resonator",
  "reverb": "Reverb",
  "roar": "Roar",
  "saturator": "Saturator",
  "simpler": "OriginalSimpler",
  "spectral resonator": "Spectral",
  "spectral time": "Spectral",
  "tension": "StringStudio",
  "utility": "StereoGain",
  "vinyl distortion": "Vinyl",
  "vocoder": "Vocoder",
  "wavetable": "InstrumentVector",
};

const youtubeQueries = [
  "Serum deep sound design bass tutorial",
  "Serum warm analog bass sound design tutorial",
  "Serum lush pad sound design tutorial",
  "Serum pluck sound design tutorial",
  "Serum kick snare percussion sound design tutorial",
  "Serum texture ambience effects sound design tutorial",
  "Serum wavetable modulation matrix tutorial advanced",
  "Ableton Operator bass sound design tutorial",
  "Ableton Wavetable sound design tutorial advanced",
  "Ableton Drum Buss Glue Compressor drum mixing tutorial",
  "Ableton EQ Eight mixing depth tutorial",
  "Ableton reverb depth send return tutorial Seed to Stage",
  "Ableton parallel processing Audio Effect Rack tutorial",
  "Ableton techno sound design tutorial",
  "Ableton afro house production sound design tutorial",
  "Ableton melodic house track from scratch sound design tutorial",
  "Ableton Live 12 full track from scratch stock devices",
  "Ableton stock plugins professional track production tutorial",
  "Seed To Stage Ableton sound design full track tutorial",
  "Ned Rush Ableton racks routing sound design tutorial",
  "Underdog Ableton arrangement groove mixing tutorial",
  "You Suck at Producing Ableton stock devices tutorial",
  "Mr Bill Ableton resampling rack sound design tutorial",
  "XNB Ableton device tutorial",
  "Ableton Drift sound design tutorial",
  "Ableton Meld sound design tutorial",
  "Ableton Roar advanced tutorial",
  "Ableton Analog sound design tutorial",
  "Ableton Collision Corpus Tension physical modeling tutorial",
  "Ableton Electric instrument sound design tutorial",
  "Ableton Simpler Sampler advanced tutorial",
  "Ableton Drum Sampler sound design tutorial",
  "Ableton Drum Rack advanced routing tutorial",
  "Ableton Instrument Rack macros chain selector tutorial",
  "Ableton MIDI effects generative harmony tutorial",
  "Ableton Auto Filter creative modulation tutorial",
  "Ableton Echo Delay sound design tutorial",
  "Ableton Saturator Roar distortion tutorial",
  "Ableton Drum Buss professional drums tutorial",
  "Ableton Glue Compressor sidechain mixing tutorial",
  "Ableton Hybrid Reverb depth tutorial",
  "Ableton creative resampling workflow tutorial",
  "Ableton arrangement transitions ear candy tutorial",
  "Ableton groove pool swing humanization tutorial",
  "Ableton stock plugins mixing mastering tutorial",
];

const official = [];
const seenOfficial = new Set();
for (let page = 1; page <= 20; page += 1) {
  const pageUrl = `https://www.ableton.com/en/blog/categories/tutorials/?page=${page}`;
  const html = await fetchText(pageUrl);
  for (const article of parseOfficialPage(html, page)) {
    if (seenOfficial.has(article.url)) continue;
    seenOfficial.add(article.url);
    official.push(article);
  }
}

const enrichedOfficial = await mapConcurrent(official, 12, async (article) => {
  try {
    const html = await fetchText(article.url);
    const media = extractMediaUrls(html);
    const text = stripHtml(articleBlock(html) ?? html);
    const devices = deviceMatches(`${article.title} ${article.summary} ${article.tags.join(" ")} ${text}`);
    const categories = techniqueCategories(
      `${article.title} ${article.summary} ${article.tags.join(" ")}`,
    );
    return {
      ...article,
      media,
      devices,
      categories,
      headlessFit: headlessFit(devices),
      priority: priorityScore(article, devices, categories, media),
    };
  } catch (error) {
    return {
      ...article,
      media: [],
      devices: deviceMatches(`${article.title} ${article.summary} ${article.tags.join(" ")}`),
      categories: techniqueCategories(`${article.title} ${article.summary} ${article.tags.join(" ")}`),
      headlessFit: "conceptual",
      priority: 0,
      enrichmentError: error instanceof Error ? error.message : String(error),
    };
  }
});

const searchedVideos = [];
const searchFailures = [];
for (const query of youtubeQueries) {
  try {
    const results = await searchYoutube(query, { limit: 12 });
    searchedVideos.push(...results.map((result) => ({ ...result, query })));
  } catch (error) {
    searchFailures.push({ query, error: error instanceof Error ? error.message : String(error) });
  }
}
const videosById = new Map();
for (const video of searchedVideos) {
  const existing = videosById.get(video.id);
  if (existing) {
    existing.queries.push(video.query);
  } else {
    videosById.set(video.id, {
      id: video.id,
      title: video.title,
      url: video.url,
      uploader: video.uploader,
      uploaderId: video.uploaderId,
      durationSeconds: video.durationSeconds,
      queries: [video.query],
      categories: techniqueCategories(`${video.title} ${video.query}`),
      devices: deviceMatches(`${video.title} ${video.query}`),
    });
  }
}

const prioritizedOfficial = enrichedOfficial
  .filter((article) => article.priority > 0)
  .toSorted((left, right) => right.priority - left.priority)
  .slice(0, 100)
  .map((article) => ({
    title: article.title,
    url: article.url,
    summary: article.summary,
    media: article.media,
    devices: article.devices,
    categories: article.categories,
    headlessFit: article.headlessFit,
    priority: article.priority,
  }));

const corpus = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  collectionPolicy: {
    retained: "public metadata, source links, tags, short publisher summaries, and media IDs",
    omitted: "video files, full transcripts, and full article text",
    synthesisRule: "store paraphrased production principles with source provenance",
  },
  capabilitySnapshot: {
    libraryAssets: capabilities.libraryAssets,
    deviceFamilies: capabilities.deviceFamilies,
    completeFamilies: capabilities.completeFamilies,
    partialFamilies: capabilities.partialFamilies,
    blockedFamilies: capabilities.blockedFamilies,
  },
  counts: {
    officialAbletonArticles: enrichedOfficial.length,
    officialArticlesWithMedia: enrichedOfficial.filter((article) => article.media.length > 0)
      .length,
    youtubeSearchQueries: youtubeQueries.length,
    uniqueYoutubeSearchResults: videosById.size,
    searchFailures: searchFailures.length,
  },
  sources: {
    officialAbletonArchive: "https://www.ableton.com/en/blog/categories/tutorials/",
    officialAbletonPages: 20,
    youtubeQueries,
  },
  prioritizedOfficial,
  officialArticles: enrichedOfficial,
  youtubeTutorialCandidates: [...videosById.values()],
  searchFailures,
};

await writeFile(output, `${JSON.stringify(corpus, null, 2)}\n`);
console.log(JSON.stringify({ output, ...corpus.counts }, null, 2));

function parseOfficialPage(html, page) {
  const articles = [];
  for (const match of html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/g)) {
    const body = match[1];
    const heading = body.match(/<h2\b[^>]*>[\s\S]*?<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/);
    if (!heading) continue;
    const relativeUrl = decodeHtml(heading[1]);
    if (!relativeUrl.includes("/blog/")) continue;
    const summary = body.match(/<p\b[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "";
    const tags = [...body.matchAll(/rel="tag"[^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>/g)].map(
      (tag) => stripHtml(tag[1]),
    );
    articles.push({
      title: stripHtml(heading[2]),
      url: new URL(relativeUrl, "https://www.ableton.com").toString(),
      summary: stripHtml(summary),
      tags: [...new Set(tags)],
      archivePage: page,
    });
  }
  return articles;
}

function extractMediaUrls(html) {
  const normalized = decodeHtml(html.replaceAll("\\u002F", "/").replaceAll("\\/", "/"));
  const youtubeIds = new Set();
  for (const pattern of [
    /youtube(?:-nocookie)?\.com\/embed\/([\w-]{11})/g,
    /youtube\.com\/watch\?v=([\w-]{11})/g,
    /youtu\.be\/([\w-]{11})/g,
  ]) {
    for (const match of normalized.matchAll(pattern)) youtubeIds.add(match[1]);
  }
  const vimeoIds = new Set(
    [...normalized.matchAll(/player\.vimeo\.com\/video\/(\d+)/g)].map((match) => match[1]),
  );
  return [
    ...[...youtubeIds].map((id) => ({
      kind: "youtube",
      id,
      url: `https://www.youtube.com/watch?v=${id}`,
    })),
    ...[...vimeoIds].map((id) => ({ kind: "vimeo", id, url: `https://vimeo.com/${id}` })),
  ];
}

function deviceMatches(text) {
  const normalizedText = normalize(text);
  const paddedText = ` ${normalizedText} `;
  const found = new Map();
  for (const [alias, familyName] of Object.entries(deviceAliases)) {
    if (!paddedText.includes(` ${normalize(alias)} `)) continue;
    const family = familyByName.get(normalize(familyName));
    found.set(familyName, {
      family: familyName,
      matchedAs: alias,
      mechanism: family?.mechanism ?? "unmapped",
      engineStatus: family?.engineStatus ?? "unknown",
      headlessStatus: family?.headlessStatus ?? "unknown",
      blocker: family?.blocker ?? null,
    });
  }
  return [...found.values()];
}

function headlessFit(devices) {
  if (!devices.length) return "conceptual";
  if (devices.every((device) => device.engineStatus.toLowerCase().includes("renderproven"))) {
    return devices.some((device) => device.blocker) ? "serial-chain-ready" : "complete";
  }
  return "translation-required";
}

function techniqueCategories(text) {
  const normalizedText = normalize(text);
  const groups = {
    bass: ["bass", "sub", "808"],
    drums: ["drum", "kick", "snare", "percussion", "beat", "rhythm"],
    dynamics: ["compress", "limiter", "dynamic", "sidechain", "punch", "transient"],
    groove: ["groove", "swing", "rhythm", "beat", "sequenc"],
    harmony: ["chord", "harmony", "harmoniz", "melod", "arp"],
    mixing: ["mix", "eq", "balance", "stereo", "master"],
    resampling: ["resampl", "sampling", "bounce", "freeze", "chop"],
    soundDesign: ["sound design", "synthesis", "synth", "texture", "timbre"],
    spatial: ["reverb", "delay", "space", "ambience", "width"],
  };
  return Object.entries(groups)
    .filter(([, needles]) => needles.some((needle) => normalizedText.includes(needle)))
    .map(([category]) => category);
}

function priorityScore(article, devices, categories, media) {
  let score = 0;
  if (media.length) score += 2;
  score += Math.min(devices.length, 4) * 2;
  score += categories.filter((category) =>
    ["bass", "drums", "dynamics", "mixing", "soundDesign", "spatial"].includes(category),
  ).length;
  if (headlessFit(devices) === "complete") score += 3;
  if (headlessFit(devices) === "serial-chain-ready") score += 2;
  if (article.tags.some((tag) => normalize(tag).includes("sound design"))) score += 2;
  return score;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "djbooth-tutorial-index/1.0 (+source-metadata-only)" },
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}

async function mapConcurrent(values, concurrency, mapper) {
  const output = new Array(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        output[index] = await mapper(values[index], index);
      }
    }),
  );
  return output;
}

function articleBlock(html) {
  return html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/)?.[1];
}

function stripHtml(value) {
  return decodeHtml(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeHtml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function normalize(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
