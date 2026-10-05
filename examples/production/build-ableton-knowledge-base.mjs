import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const DEFAULT_CACHE = "/Users/gakonst/Library/Caches/djbooth/ableton-tutorial-videos";

const { values } = parseArgs({
  options: {
    capabilities: { type: "string", default: "/tmp/ableton-capabilities.json" },
    "video-knowledge": { type: "string", default: path.join(DEFAULT_CACHE, "knowledge.json") },
    "video-dir": { type: "string", default: path.join(DEFAULT_CACHE, "videos") },
    corpus: {
      type: "string",
      default: path.join(import.meta.dirname, "ableton-tutorial-corpus.json"),
    },
    recipes: {
      type: "string",
      default: path.join(import.meta.dirname, "ableton-tutorial-recipes.json"),
    },
    techniques: {
      type: "string",
      default: path.join(import.meta.dirname, "ableton-headless-techniques.json"),
    },
    output: { type: "string", default: path.join(import.meta.dirname, "ableton-knowledge-base") },
  },
  strict: true,
});

let outputDir;
let evidenceByFamily;
let recipes;
let officialArticles;
let videos;
let evidenceWindows;
let videoDirectory;
let devices;
let principles;
let roles;

function buildDevice(capability) {
  const evidence = evidenceByFamily.get(capability.family);
  const taxonomy = classifyDevice(capability.family);
  const familyRecipes = recipes.filter((recipe) => recipe.devices.includes(capability.family));
  const articleMatches = officialArticles
    .filter((article) => article.devices.includes(capability.family))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 12);
  const relatedVideos = videos
    .filter((video) => video.devices.includes(capability.family))
    .sort((a, b) => b.qualityScore - a.qualityScore)
    .slice(0, 15);
  const coOccurrences = frequency(
    relatedVideos.flatMap((video) =>
      video.devices.filter((family) => family !== capability.family),
    ),
    12,
  );
  return {
    family: capability.family,
    slug: slugify(capability.family),
    kind: taxonomy.kind,
    domains: taxonomy.domains,
    purpose: DEVICE_PURPOSE[capability.family] ?? taxonomy.defaultPurpose,
    productionUse: DEVICE_USE[capability.family] ?? taxonomy.defaultUse,
    execution: {
      mechanism: capability.mechanism,
      engineStatus: capability.engineStatus,
      presetStatus: capability.presetStatus,
      headlessStatus: capability.headlessStatus,
      implementation: capability.implementation,
      blocker: capability.blocker,
      customDsp: capability.customDsp,
      safeClaim: executionClaim(capability),
    },
    libraryAssets: capability.libraryAssets,
    tutorialEvidence: {
      status: evidence?.evidenceStatus ?? "none",
      videos: evidence?.videos ?? 0,
      transcriptVideos: evidence?.transcriptVideos ?? 0,
      actionWindows: evidence?.actionWindows ?? 0,
      commonActions: evidence?.commonActions ?? [],
      commonParameters: evidence?.commonParameters ?? [],
      topEvidence: (evidence?.topEvidence ?? []).slice(0, 10),
    },
    relatedDevices: coOccurrences,
    recipes: familyRecipes.map((recipe) => recipe.id),
    officialArticles: articleMatches.map(sourceSummary),
  };
}

function buildPrinciple(definition) {
  const relevantDevices = devicesForNames(definition.devices);
  const evidence = rankEvidence({
    devices: definition.devices,
    categories: definition.categories,
    terms: definition.evidenceTerms ?? [],
    limit: 8,
  });
  return {
    ...definition,
    evidenceLevel: "synthesized",
    executionStatus: aggregateExecution(relevantDevices),
    evidence,
    relatedRecipes: recipes
      .filter((recipe) => intersects(recipe.devices, definition.devices))
      .map((recipe) => recipe.id),
  };
}

function buildRole(definition) {
  const roleDevices = devicesForNames(definition.devices);
  return {
    ...definition,
    devices: roleDevices.map((device) => ({
      family: device.family,
      purpose: device.purpose,
      headlessStatus: device.execution.headlessStatus,
      evidenceVideos: device.tutorialEvidence.videos,
    })),
    principles: principles
      .filter((principle) => principle.roles.includes(definition.id))
      .map((principle) => principle.id),
    recipes: recipes
      .filter((recipe) => recipe.roles.includes(definition.id))
      .map((recipe) => recipe.id),
    evidence: rankEvidence({
      devices: definition.devices,
      categories: definition.categories,
      terms: definition.evidenceTerms ?? [],
      limit: 10,
    }),
  };
}

function rankEvidence({ devices: families, categories, terms, limit }) {
  const candidates = evidenceWindows.flatMap((item) => {
    const familyMatches = families.filter((family) => item.devices.includes(family)).length;
    if (familyMatches === 0) return [];
    const haystack =
      `${item.title} ${item.chapter ?? ""} ${item.actions.join(" ")} ${item.parameters.join(" ")} ${item.evidence}`.toLowerCase();
    const matchedTerms = terms.flatMap((term, index) =>
      haystack.includes(term.toLowerCase()) ? [{ term, index }] : [],
    );
    if (terms.length > 0 && matchedTerms.length === 0) return [];
    const termScore = sum(matchedTerms.map(({ index }) => (index < 2 ? 14 : 7)));
    const categoryMatches = categories.filter((category) =>
      item.categories.includes(category),
    ).length;
    return [
      {
        ...item,
        relevanceScore:
          termScore +
          familyMatches * 6 +
          categoryMatches * 3 +
          Math.min(10, item.evidenceScore / 2),
      },
    ];
  });
  const deduped = new Map();
  for (const item of candidates) {
    const key = `${item.videoId}:${Math.floor(item.startSeconds / 4)}`;
    if (!deduped.has(key) || deduped.get(key).relevanceScore < item.relevanceScore) {
      deduped.set(key, item);
    }
  }
  return [...deduped.values()].sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, limit);
}

function normalizeRecipes(tutorials, techniques) {
  const fromTutorials = Object.entries(tutorials.recipes).map(([id, recipe]) => ({
    id,
    origin: "tutorial-synthesis",
    goal: recipe.goal,
    principles: recipe.principles ?? [],
    roles: inferRecipeRoles(id, recipe.goal),
    devices: recipe.chain.map((stage) => canonicalDevice(stage.device)),
    chain: recipe.chain,
    sources: recipe.sources ?? [],
  }));
  const fromTechniques = Object.entries(techniques.recipes).map(([id, recipe]) => ({
    id,
    origin: "capability-aware-fixture",
    goal: recipe.goal,
    principles: [],
    roles: inferRecipeRoles(id, recipe.goal),
    devices: recipe.chain.map((stage) => canonicalDevice(stage.device)),
    chain: recipe.chain,
    sources: [],
  }));
  return [
    ...fromTutorials,
    ...fromTechniques.filter((recipe) => !fromTutorials.some((item) => item.id === recipe.id)),
  ];
}

function normalizeOfficialArticle(article) {
  return {
    id: `official:${slugify(article.title)}`,
    kind: "official-article",
    title: article.title,
    url: article.url,
    summary: article.summary,
    tags: article.tags ?? [],
    devices: (article.devices ?? []).map((device) =>
      canonicalDevice(typeof device === "string" ? device : device.family),
    ),
    categories: article.categories ?? [],
    headlessFit: article.headlessFit,
    priority: article.priority ?? 0,
    media: article.media ?? [],
  };
}

function normalizeVideo(analysis) {
  return {
    id: analysis.id,
    kind: "video",
    title: analysis.title,
    uploader: analysis.uploader,
    url: analysis.url,
    durationSeconds: analysis.durationSeconds,
    qualityScore: analysis.score,
    categories: analysis.categories,
    devices: analysis.devices,
    chapters: analysis.chapters,
    transcriptCues: analysis.transcript.cueCount,
    needsAsr: analysis.transcript.needsAsr,
    actionWindows: analysis.actionWindows.length,
    frames: analysis.frames.length,
  };
}

function normalizeEvidenceWindows(analysis) {
  return analysis.actionWindows.map((window) => ({
    videoId: analysis.id,
    title: analysis.title,
    uploader: analysis.uploader,
    url: analysis.url,
    startSeconds: round(window.startSeconds, 3),
    timestampUrl: `${analysis.url}&t=${Math.floor(window.startSeconds)}s`,
    chapter: window.chapter,
    actions: window.actions,
    parameters: window.parameters,
    devices: window.devices,
    categories: analysis.categories,
    evidenceScore: window.score + window.actions.length * 2 + window.parameters.length * 3,
    evidence: compact(window.evidence, 600),
    frame: window.nearestFrame ? path.join(videoDirectory, analysis.id, window.nearestFrame) : null,
  }));
}

function buildGaps(allDevices, allVideos) {
  const gaps = [];
  for (const device of allDevices) {
    if (device.tutorialEvidence.videos === 0) {
      gaps.push({
        severity: "knowledge",
        family: device.family,
        problem: "No ingested tutorial currently names this capability family.",
        nextAction:
          "Collect a device-specific official/manual tutorial and one practical sound-design example.",
      });
    }
    if (device.execution.headlessStatus !== "complete") {
      gaps.push({
        severity: "execution",
        family: device.family,
        problem: device.execution.blocker || "Headless behavior is only partially verified.",
        nextAction:
          "Add an audible native-engine fixture for the missing preset, routing, automation, or state behavior.",
      });
    }
  }
  for (const video of allVideos.filter((item) => item.needsAsr)) {
    gaps.push({
      severity: "source",
      sourceId: video.id,
      problem: "No usable English caption track.",
      nextAction: "Run local ASR, then regenerate action windows and evidence rankings.",
    });
  }
  return gaps;
}

function buildSearchIndex({
  principles: learned,
  roles: productionRoles,
  devices: deviceFamilies,
  recipes: productionRecipes,
  officialArticles: articles,
  videos: tutorials,
}) {
  return [
    ...learned.map((item) =>
      searchRecord("principle", item.id, item.title, [
        item.summary,
        ...item.rules,
        ...item.devices,
        ...item.roles,
      ]),
    ),
    ...productionRoles.map((item) =>
      searchRecord("role", item.id, item.title, [
        item.goal,
        ...item.buildOrder,
        ...item.listenFor,
        ...item.devices.map((device) => device.family),
      ]),
    ),
    ...deviceFamilies.map((item) =>
      searchRecord("device", item.family, item.family, [
        item.purpose,
        item.productionUse,
        ...item.domains,
        ...item.tutorialEvidence.commonParameters.map((entry) => entry.name),
      ]),
    ),
    ...productionRecipes.map((item) =>
      searchRecord("recipe", item.id, item.id, [
        item.goal,
        ...item.principles,
        ...item.devices,
        ...item.roles,
      ]),
    ),
    ...articles.map((item) =>
      searchRecord("official", item.id, item.title, [
        item.summary,
        ...item.devices,
        ...item.categories,
      ]),
    ),
    ...tutorials.map((item) =>
      searchRecord("video", item.id, item.title, [
        item.uploader,
        ...item.devices,
        ...item.categories,
      ]),
    ),
  ];
}

function searchRecord(type, id, title, textParts) {
  return { type, id, title, text: textParts.filter(Boolean).join(" ").toLowerCase() };
}

async function writeKnowledgeBase(kb) {
  await Promise.all([
    mkdir(outputDir, { recursive: true }),
    mkdir(path.join(outputDir, "devices"), { recursive: true }),
    mkdir(path.join(outputDir, "roles"), { recursive: true }),
  ]);
  const writes = [
    writeFile(path.join(outputDir, "knowledge-base.json"), `${JSON.stringify(kb, null, 2)}\n`),
    writeFile(
      path.join(outputDir, "evidence-index.json"),
      `${JSON.stringify(evidenceWindows, null, 2)}\n`,
    ),
    writeFile(path.join(outputDir, "README.md"), renderReadme(kb)),
    writeFile(path.join(outputDir, "TECHNIQUES.md"), renderTechniques(kb.learned)),
    writeFile(path.join(outputDir, "SOURCES.md"), renderSources(kb.sources)),
    writeFile(path.join(outputDir, "GAPS.md"), renderGaps(kb.gaps)),
    ...kb.devices.map((device) =>
      writeFile(path.join(outputDir, "devices", `${device.slug}.md`), renderDevice(device)),
    ),
    ...kb.roles.map((role) =>
      writeFile(path.join(outputDir, "roles", `${slugify(role.id)}.md`), renderRole(role)),
    ),
  ];
  await Promise.all(writes);
}

function renderReadme(kb) {
  return `# ${kb.title}\n\nThis is the operational synthesis of ${kb.counts.tutorialHours} hours of tutorial video, ${kb.counts.officialArticles} official articles, ${kb.counts.deviceFamilies} capability families, factory recipes, and the current native-engine audit. It distinguishes tutorial evidence from production synthesis and render-proven execution.\n\n## Coverage\n\n| Material | Count |\n| --- | ---: |\n| Tutorial videos | ${kb.counts.videos} |\n| Tutorial hours | ${kb.counts.tutorialHours} |\n| Videos with transcripts | ${kb.counts.transcriptVideos} |\n| Timestamped action windows | ${kb.counts.actionWindows} |\n| Targeted frames | ${kb.counts.frames} |\n| Official articles | ${kb.counts.officialArticles} |\n| Ableton capability families | ${kb.counts.deviceFamilies} |\n| Families with tutorial evidence | ${kb.counts.familiesWithTutorialEvidence} |\n| Complete headless families | ${kb.counts.completeFamilies} |\n| Partial headless families | ${kb.counts.partialFamilies} |\n| Synthesized production principles | ${kb.counts.principles} |\n| Production roles | ${kb.counts.roles} |\n| Executable recipes | ${kb.counts.recipes} |\n\n## What we learned\n\n${kb.learned.map((item) => `### ${item.title}\n\n${item.summary}\n\n${item.rules.map((rule) => `- ${rule}`).join("\n")}`).join("\n\n")}\n\n## Navigate\n\n- [Technique encyclopedia](TECHNIQUES.md)\n- [Open execution and evidence gaps](GAPS.md)\n- [Source catalog](SOURCES.md)\n- Device encyclopedia: ${kb.devices.map((item) => `[${item.family}](devices/${item.slug}.md)`).join(", ")}\n- Production roles: ${kb.roles.map((item) => `[${item.title}](roles/${slugify(item.id)}.md)`).join(", ")}\n\n## Query it\n\nFrom the repository root:\n\n\`\`\`sh\nnode examples/production/query-ableton-knowledge-base.mjs "wide bass without losing the sub"\nnode examples/production/query-ableton-knowledge-base.mjs --type device "physical modeling percussion"\nnode examples/production/query-ableton-knowledge-base.mjs --type role "build a lead with depth"\n\`\`\`\n\nThe machine-readable source of truth is [knowledge-base.json](knowledge-base.json). Regenerate it with \`node examples/production/build-ableton-knowledge-base.mjs\`.\n`;
}

function renderTechniques(items) {
  return `# Production Technique Encyclopedia\n\n${items.map((item) => `## ${item.title}\n\n${item.summary}\n\n**Applies to:** ${item.roles.join(", ")}  \n**Devices:** ${item.devices.join(", ")}  \n**Headless execution:** ${item.executionStatus}\n\n### Rules\n\n${item.rules.map((rule) => `- ${rule}`).join("\n")}\n\n### Failure modes\n\n${item.failureModes.map((failure) => `- ${failure}`).join("\n")}\n\n### Evidence\n\n${renderEvidence(item.evidence)}`).join("\n\n")}\n`;
}

function renderDevice(device) {
  const execution = device.execution;
  return `# ${device.family}\n\n${device.purpose}\n\n## Production use\n\n${device.productionUse}\n\n- Kind: ${device.kind}\n- Domains: ${device.domains.join(", ")}\n- Headless status: ${execution.headlessStatus}\n- Engine status: ${execution.engineStatus}\n- Preset status: ${execution.presetStatus}\n- Mechanism: ${execution.mechanism}\n- Safe claim: ${execution.safeClaim}\n- Remaining blocker: ${execution.blocker || "none recorded"}\n- Custom DSP: ${String(execution.customDsp)}\n\n## Tutorial knowledge\n\n- Evidence status: ${device.tutorialEvidence.status}\n- Videos: ${device.tutorialEvidence.videos}\n- Action windows: ${device.tutorialEvidence.actionWindows}\n- Common actions: ${renderFrequencies(device.tutorialEvidence.commonActions)}\n- Common parameters: ${renderFrequencies(device.tutorialEvidence.commonParameters)}\n- Commonly co-occurs with: ${renderFrequencies(device.relatedDevices)}\n- Recipes: ${device.recipes.join(", ") || "none yet"}\n\n## Timestamped evidence\n\n${renderEvidence(device.tutorialEvidence.topEvidence)}\n\n## Official reading\n\n${device.officialArticles.length ? device.officialArticles.map((item) => `- [${item.title}](${item.url}) — ${item.summary}`).join("\n") : "No device-specific official article is mapped yet."}\n`;
}

function renderRole(role) {
  return `# ${role.title}\n\n${role.goal}\n\n## Build order\n\n${role.buildOrder.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n\n## Listen for\n\n${role.listenFor.map((item) => `- ${item}`).join("\n")}\n\n## Devices\n\n${role.devices.map((device) => `- **${device.family}** (${device.headlessStatus}; ${device.evidenceVideos} evidence videos): ${device.purpose}`).join("\n")}\n\n## Principles and recipes\n\n- Principles: ${role.principles.join(", ") || "none"}\n- Recipes: ${role.recipes.join(", ") || "none"}\n\n## Evidence\n\n${renderEvidence(role.evidence)}\n`;
}

function renderSources(sources) {
  return `# Source Catalog\n\n## Tutorial videos (${sources.videos.length})\n\n${sources.videos.map((item) => `- [${item.title}](${item.url}) — ${item.uploader}; ${formatDuration(item.durationSeconds)}; ${item.transcriptCues} transcript cues; devices: ${item.devices.join(", ") || "unclassified"}`).join("\n")}\n\n## Official Ableton articles (${sources.officialArticles.length})\n\n${sources.officialArticles.map((item) => `- [${item.title}](${item.url}) — ${item.summary}`).join("\n")}\n`;
}

function renderGaps(gapsList) {
  const grouped = Map.groupBy(gapsList, (item) => item.severity);
  return `# Knowledge and Execution Gaps\n\n${[...grouped.entries()].map(([severity, items]) => `## ${titleCase(severity)} (${items.length})\n\n${items.map((item) => `- **${item.family ?? item.sourceId}:** ${item.problem} Next: ${item.nextAction}`).join("\n")}`).join("\n\n")}\n`;
}

function renderEvidence(items) {
  if (!items.length) return "No timestamped evidence has been ingested yet.";
  return items
    .map(
      (item) =>
        `- [${item.title}](${item.timestampUrl}) — ${item.uploader}, ${formatDuration(item.startSeconds)}. Actions: ${item.actions.join(", ") || "none tagged"}; parameters: ${item.parameters.join(", ") || "none tagged"}. ${compact(item.evidence, 280)}`,
    )
    .join("\n");
}

function sourceSummary(item) {
  return { title: item.title, url: item.url, summary: item.summary, priority: item.priority };
}

function devicesForNames(names) {
  return names.map((name) => devices.find((device) => device.family === name)).filter(Boolean);
}

function aggregateExecution(items) {
  if (!items.length) return "unknown";
  if (items.every((item) => item.execution.headlessStatus === "complete")) return "complete";
  if (items.some((item) => ["complete", "partial"].includes(item.execution.headlessStatus)))
    return "partial";
  return "unknown";
}

function executionClaim(capability) {
  if (capability.headlessStatus === "complete")
    return "The current host can execute this family without replacement DSP.";
  if (capability.engineStatus?.includes("RenderProven"))
    return "Native audio execution is proven; higher-level preset, routing, or automation parity is incomplete.";
  if (capability.engineStatus?.includes("MidiEventRenderProven"))
    return "Native MIDI-event transformation is proven; full state and graph parity is incomplete.";
  if (capability.engineStatus === "exhaustiveParseProven")
    return "Rack structure can be parsed; complete native graph execution is not yet proven.";
  if (capability.engineStatus === "runtimeProven")
    return "The bundled runtime loads; arbitrary device behavior still requires per-device fixtures.";
  return "Construction or asset discovery is proven, but audible execution is not yet proven.";
}

function classifyDevice(family) {
  for (const group of DEVICE_GROUPS) {
    if (group.families.includes(family)) return group;
  }
  return {
    kind: "unclassified",
    domains: ["unknown"],
    defaultPurpose: "An installed Ableton capability family awaiting semantic classification.",
    defaultUse:
      "Collect a focused tutorial and an audible fixture before using this in production generation.",
  };
}

function inferRecipeRoles(id, goal) {
  const text = `${id} ${goal}`.toLowerCase();
  const matches = ROLE_DEFINITIONS.filter((role) =>
    role.evidenceTerms.some((term) => text.includes(term)),
  ).map((role) => role.id);
  return matches.length ? matches : ["mix-bus"];
}

function canonicalDevice(family) {
  return (
    {
      HybridReverb: "Hybrid",
      Utility: "StereoGain",
      Simpler: "OriginalSimpler",
      Sampler: "MultiSampler",
      Wavetable: "InstrumentVector",
      Meld: "InstrumentMeld",
      Tension: "StringStudio",
      Analog: "UltraAnalog",
    }[family] ?? family
  );
}

async function readAnalyses(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name, "analysis.json"));
  const existing = [];
  for (const file of files) if (await isFile(file)) existing.push(file);
  return Promise.all(existing.map(readJson));
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function frequency(valuesList, limit = 20) {
  const counts = new Map();
  for (const value of valuesList) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function renderFrequencies(items) {
  return items.length
    ? items
        .slice(0, 12)
        .map((item) => `${item.name} (${item.count})`)
        .join(", ")
    : "none yet";
}

function intersects(left, right) {
  const rightSet = new Set(right);
  return left.some((item) => rightSet.has(item));
}

function compact(value, length) {
  const normalized = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length <= length ? normalized : `${normalized.slice(0, length - 1)}…`;
}

function slugify(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function titleCase(value) {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sum(valuesList) {
  return valuesList.reduce((total, value) => total + value, 0);
}

const DEVICE_GROUPS = [
  {
    kind: "instrument",
    domains: ["synthesis", "timbre"],
    defaultPurpose: "Generate pitched or percussive sound inside Ableton's native engine.",
    defaultUse:
      "Choose it for its synthesis model, then shape motion with envelopes/modulation and control the result downstream.",
    families: [
      "Collision",
      "Drift",
      "DrumCell",
      "Hybrid",
      "InstrumentImpulse",
      "InstrumentMeld",
      "InstrumentVector",
      "LoungeLizard",
      "MultiSampler",
      "Operator",
      "OriginalSimpler",
      "StringStudio",
      "UltraAnalog",
    ],
  },
  {
    kind: "spectral-and-filter",
    domains: ["tone", "movement", "repair"],
    defaultPurpose: "Reshape frequency content or move it over time.",
    defaultUse:
      "Use static filtering for role separation and modulation/automation for phrase-level motion.",
    families: [
      "AutoFilter",
      "AutoFilter2",
      "AutoShift",
      "ChannelEq",
      "Corpus",
      "Eq8",
      "FilterEQ3",
      "Resonator",
      "Spectral",
      "Transmute",
      "Vocoder",
    ],
  },
  {
    kind: "dynamics",
    domains: ["envelope", "level", "punch"],
    defaultPurpose: "Control or exaggerate the amplitude envelope.",
    defaultUse:
      "Set attack and release from the musical role, level-match before judging, and use sidechain detection deliberately.",
    families: ["Compressor2", "DrumBuss", "Gate", "GlueCompressor", "Limiter", "MultibandDynamics"],
  },
  {
    kind: "distortion-and-color",
    domains: ["harmonics", "density", "texture"],
    defaultPurpose: "Create harmonics, nonlinear movement, or deliberate degradation.",
    defaultUse:
      "Stage input gain, choose the band or layer that needs density, then level-match and control the output.",
    families: [
      "Amp",
      "Cabinet",
      "Erosion",
      "Overdrive",
      "Pedal",
      "Redux",
      "Redux2",
      "Roar",
      "Saturator",
      "Tube",
      "Vinyl",
    ],
  },
  {
    kind: "delay-and-space",
    domains: ["depth", "rhythm", "stereo"],
    defaultPurpose: "Place sound in depth or create time-based rhythmic structure.",
    defaultUse:
      "Filter the wet path, synchronize timing to the role, preserve dry focus, and automate throws rather than flooding every phrase.",
    families: ["BeatRepeat", "Delay", "Echo", "FilterDelay", "GrainDelay", "Looper", "Reverb"],
  },
  {
    kind: "modulation",
    domains: ["movement", "stereo", "animation"],
    defaultPurpose: "Animate pitch, phase, level, or stereo position.",
    defaultUse:
      "Keep rates musically related and depth role-specific; avoid widening low-frequency fundamentals.",
    families: [
      "AutoPan",
      "AutoPan2",
      "Chorus",
      "Chorus2",
      "Flanger",
      "FrequencyShifter",
      "Phaser",
      "PhaserNew",
      "Shifter",
    ],
  },
  {
    kind: "midi-effect",
    domains: ["notes", "harmony", "groove"],
    defaultPurpose: "Transform MIDI notes before they reach an instrument.",
    defaultUse:
      "Constrain generated notes to the musical system first, then use rate, probability, length, and velocity to create controlled variation.",
    families: [
      "MidiArpeggiator",
      "MidiChord",
      "MidiNoteLength",
      "MidiPitcher",
      "MidiRandom",
      "MidiScale",
      "MidiVelocity",
    ],
  },
  {
    kind: "rack-and-routing",
    domains: ["routing", "layering", "macros"],
    defaultPurpose:
      "Represent Ableton's serial, parallel, layered, return, selector, and macro graph structure.",
    defaultUse:
      "Use chains to split dry/wet or frequency roles, selectors for variations, and macros for musically meaningful multi-parameter control.",
    families: [
      "AudioBranchMixerDevice",
      "AudioEffectGroupDevice",
      "DrumGroupDevice",
      "InstrumentGroupDevice",
      "MidiBranchMixerDevice",
      "MidiEffectGroupDevice",
    ],
  },
  {
    kind: "max-for-live",
    domains: ["modulation", "generation", "extension"],
    defaultPurpose: "Run bundled or third-party Max for Live audio, MIDI, or instrument devices.",
    defaultUse:
      "Treat every device as its own program: inspect dependencies, parameter exposure, timing, and state before claiming parity.",
    families: ["MxDeviceAudioEffect", "MxDeviceInstrument", "MxDeviceMidiEffect"],
  },
  {
    kind: "utility-and-analysis",
    domains: ["gain", "stereo", "metering"],
    defaultPurpose:
      "Control channel geometry or measure the signal without inventing a new timbre.",
    defaultUse:
      "Use for gain staging, mono/stereo placement, polarity, and objective checks at explicit points in the graph.",
    families: ["SpectrumAnalyzer", "StereoGain"],
  },
];

const DEVICE_PURPOSE = {
  Amp: "Ableton's amplifier-modeling stage for speaker-like nonlinear color before an optional Cabinet.",
  BeatRepeat:
    "A synchronized buffer repeater for fills, stutters, and controlled rhythmic disruption.",
  Collision:
    "A physical-modeling percussion synthesizer built from mallets, resonators, and material behavior.",
  Corpus:
    "A resonating physical model that imposes pipe, plate, string, membrane, and related resonances on audio.",
  Drift:
    "A subtractive synth designed for organic oscillator instability, per-voice variation, and fast modulation.",
  DrumBuss:
    "An integrated drum color, transient, compression, and low-frequency enhancement processor.",
  DrumCell: "Ableton's native single-voice drum-synthesis engine for tuned electronic drum design.",
  Echo: "A character delay with modulation, filtering, stereo modes, reverb, and feedback-path sound design.",
  GlueCompressor:
    "A bus compressor for cohesive envelope control, punch, and sidechain-driven movement.",
  GrainDelay:
    "A granular delay for pitch-shifted repeats, smears, glitches, and resampled ear candy.",
  Hybrid:
    "Ableton's convolution/algorithmic hybrid reverb for realistic spaces and designed tails.",
  InstrumentMeld:
    "A dual-engine macro-oscillator synth for complex timbral blending and modulation.",
  MultiSampler:
    "Ableton's multisample playback family for velocity, key, and sample-zone instruments.",
  Operator:
    "A four-oscillator FM/additive/subtractive synth suited to precise bass, percussion, keys, and metallic timbres.",
  OriginalSimpler:
    "A focused sample instrument for classic, one-shot, slicing, and warped sample playback.",
  Roar: "A multi-stage distortion and feedback sound-design system with routing, modulation, filtering, compression, and time behavior.",
  Saturator:
    "A focused waveshaping stage for harmonic density, clipping, warmth, and peak control.",
  SpectrumAnalyzer: "A non-coloring spectrum tap for checking frequency balance and resonances.",
  StereoGain:
    "Ableton's utility/gain family for level, width, channel, phase, and low-frequency stereo control.",
  UltraAnalog: "Ableton's analog-modeling subtractive synthesizer family.",
  Vocoder:
    "A carrier/modulator filter-bank processor for voice-like synthesis, rhythmic texture, and spectral layering.",
};

const DEVICE_USE = {
  AutoFilter:
    "Automate cutoff for arrangement motion; use envelope or sidechain modulation for signal-driven movement, and choose slope/drive before resonance.",
  Collision:
    "Start with the exciter and resonator material, constrain decay and brightness, protect output with a limiter, then add a short space only if needed.",
  Compressor2:
    "Use attack to preserve or suppress the transient, release to recover in rhythm, and a filtered sidechain when low energy mis-triggers the detector.",
  Drift:
    "Begin with one stable oscillator, introduce drift and per-voice variation gradually, then map LFO/envelope motion before downstream saturation.",
  DrumBuss:
    "Decide separately whether the drums need drive, transient emphasis, compression, or boom; do not turn every section up by default.",
  Echo: "Use synchronized or offset delay lines, filter and color inside the feedback path, duck or automate the return, and reserve high feedback for throws.",
  Eq8: "Use role-based cuts and broad tonal shaping before narrow repair; automate only when the arrangement actually changes the masking relationship.",
  GlueCompressor:
    "For buses, use slower attack when the transient should survive and release that breathes with the groove; compare at matched loudness.",
  GrainDelay:
    "Print short gestures to audio, tune pitch and spray deliberately, then edit the resample into transitions instead of leaving an uncontrolled insert running.",
  Operator:
    "Use integer oscillator ratios and envelopes to define spectra; separate sub/body/click time scales for kicks and bass, and use feedback sparingly for edge.",
  Reverb:
    "Filter the wet signal, set predelay from foreground separation, decay from section density, and use sends or parallel chains for shared depth.",
  Roar: "Choose serial, parallel, or multiband routing intentionally; drive only the region needing density, use modulation for life, and control output after nonlinear stages.",
  Saturator:
    "Drive into the selected curve, use soft clipping when peak restraint is part of the goal, and judge by level-matched harmonic audibility.",
  StereoGain:
    "Keep the sub centered, establish foreground/background width by role, and place gain controls before and after nonlinear processors for reproducible staging.",
};

const PRINCIPLE_DEFINITIONS = [
  {
    id: "role-before-device",
    title: "Give every sound a job before choosing devices",
    summary:
      "Richness comes from complementary roles—fundamental, body, transient, air, motion, and space—not from placing a large chain on every channel.",
    roles: ["arrangement", "bass", "drums", "lead", "pad", "mix-bus"],
    devices: ["Eq8", "StereoGain", "SpectrumAnalyzer"],
    categories: ["mixing", "harmony", "soundDesign"],
    evidenceTerms: ["layer", "frequency", "width", "arrangement"],
    rules: [
      "Name the spectral, rhythmic, stereo, and depth role of each layer.",
      "Delete or mute a layer that duplicates another role without adding contrast.",
      "Judge processing in the full arrangement, not only in solo.",
    ],
    failureModes: [
      "Every channel is full-range, wide, and reverberant.",
      "More layers increase masking but not perceived detail.",
    ],
  },
  {
    id: "serial-order",
    title: "Serial order is part of the sound",
    summary:
      "Filtering before distortion changes what generates harmonics; filtering after distortion changes what remains. The same principle applies to dynamics, modulation, and space.",
    roles: ["bass", "drums", "lead", "pad", "mix-bus"],
    devices: ["Eq8", "AutoFilter", "Roar", "Saturator", "Compressor2", "Reverb"],
    categories: ["routing", "soundDesign", "mixing"],
    evidenceTerms: ["before", "after", "chain", "filter", "drive"],
    rules: [
      "State the purpose of each stage and why it precedes the next one.",
      "Put corrective filtering before nonlinear stages when unwanted energy should not create harmonics.",
      "Use post-processing to contain level, bandwidth, and stereo consequences.",
    ],
    failureModes: [
      "Copying settings while changing device order.",
      "Driving distortion with uncontrolled sub or resonance.",
    ],
  },
  {
    id: "gain-staging",
    title: "Nonlinear devices are input-level dependent",
    summary:
      "Amp, Saturator, Roar, compression, and many analog-modeled devices produce different texture when their input level changes, so gain staging must be declarative.",
    roles: ["bass", "drums", "lead", "mix-bus"],
    devices: ["StereoGain", "Amp", "Saturator", "Roar", "GlueCompressor", "Limiter"],
    categories: ["dynamics", "mixing", "soundDesign"],
    evidenceTerms: ["gain", "drive", "output", "threshold", "level"],
    rules: [
      "Record pre-device gain and post-device trim as part of the patch.",
      "Level-match bypass comparisons.",
      "Treat louder as a measurement error, not automatic improvement.",
    ],
    failureModes: [
      "Preset behavior changes unpredictably between sources.",
      "Clipping is mistaken for density or punch.",
    ],
  },
  {
    id: "parallel-preserves-identity",
    title: "Parallel chains preserve identity while adding character",
    summary:
      "A dry path can retain transient and pitch definition while a wet path supplies distortion, compression, modulation, or ambience.",
    roles: ["bass", "drums", "lead", "pad", "spatial"],
    devices: ["AudioEffectGroupDevice", "AudioBranchMixerDevice", "Roar", "Compressor2", "Reverb"],
    categories: ["routing", "dynamics", "spatial"],
    evidenceTerms: ["parallel", "dry", "wet", "chain", "group"],
    rules: [
      "Define dry and wet gain independently.",
      "Band-limit or time-limit the wet branch when it competes with the source.",
      "Check phase and latency before interpreting the blend.",
    ],
    failureModes: [
      "Parallel processing becomes simple loudness addition.",
      "A widened wet branch cancels or smears the mono fundamental.",
    ],
  },
  {
    id: "mono-foundation-wide-detail",
    title: "Keep foundations centered and widen selected detail",
    summary:
      "Low-end authority survives translation when the fundamental is centered and stereo movement is concentrated in upper harmonics, ambience, or secondary layers.",
    roles: ["bass", "kick", "mix-bus"],
    devices: ["StereoGain", "Chorus2", "Roar", "Eq8"],
    categories: ["bass", "mixing", "spatial"],
    evidenceTerms: ["mono", "width", "bass", "chorus", "frequency"],
    rules: [
      "Keep the sub/fundamental mono or strongly correlated.",
      "Create width after a crossover, on a parallel harmonic layer, or in a separate octave.",
      "Audit mono compatibility and low-frequency phase.",
    ],
    failureModes: [
      "Chorus on the full bass makes the center weak.",
      "Stereo enhancement hides cancellation until playback on a club or phone.",
    ],
  },
  {
    id: "movement-has-timescale",
    title: "Movement needs a musical timescale",
    summary:
      "Envelope, LFO, random modulation, and automation solve different time scales: note shape, cyclic motion, organic variance, and section-level development.",
    roles: ["bass", "lead", "pad", "arrangement"],
    devices: ["Drift", "InstrumentMeld", "AutoFilter", "AutoPan2", "Roar"],
    categories: ["soundDesign", "harmony", "routing"],
    evidenceTerms: ["lfo", "envelope", "modulate", "automate", "rate"],
    rules: [
      "Use envelopes for note articulation.",
      "Use synchronized or intentionally free LFOs for within-phrase motion.",
      "Use automation for transitions and section contrast; use random modulation at small depth for life.",
    ],
    failureModes: [
      "Every parameter wobbles at the same rate.",
      "A static preset is expected to create an evolving arrangement.",
    ],
  },
  {
    id: "sidechain-as-control-signal",
    title: "Sidechain is a control signal, not only kick ducking",
    summary:
      "An external signal can drive compression, gating, filters, modulation, and wet-return clearance to make parts interlock.",
    roles: ["bass", "drums", "spatial", "mix-bus"],
    devices: ["Compressor2", "GlueCompressor", "Gate", "AutoFilter", "Echo", "Reverb"],
    categories: ["routing", "dynamics", "spatial"],
    evidenceTerms: ["sidechain", "duck", "external", "return", "filter"],
    rules: [
      "Choose a source whose rhythm expresses the desired interaction.",
      "Filter the detector when sub or cymbal energy causes false triggering.",
      "Duck effects returns separately when the dry source should stay stable.",
    ],
    failureModes: [
      "One global pumping curve is used everywhere.",
      "Detector sensitivity changes with arrangement density.",
    ],
  },
  {
    id: "distortion-by-band",
    title: "Distort the band that needs to become audible",
    summary:
      "Bass and drums gain perceived size when selected mids and upper harmonics are generated without destroying the low-frequency anchor or transient.",
    roles: ["bass", "kick", "drums", "lead"],
    devices: ["Roar", "Saturator", "Amp", "Cabinet", "Eq8", "AudioEffectGroupDevice"],
    categories: ["bass", "drums", "soundDesign"],
    evidenceTerms: ["drive", "distortion", "parallel", "frequency", "harmonic"],
    rules: [
      "Split or pre-filter when only one register needs density.",
      "Retain a clean low or transient layer.",
      "Use post-EQ and output trim to contain the added spectrum.",
    ],
    failureModes: [
      "Full-band drive turns sub into uncontrolled headroom use.",
      "Added fizz reads as cheap brightness instead of useful harmonics.",
    ],
  },
  {
    id: "dynamics-follow-groove",
    title: "Dynamics timing must breathe with the groove",
    summary:
      "Attack decides how much transient survives; release decides whether gain recovers musically before the next event.",
    roles: ["kick", "drums", "bass", "mix-bus"],
    devices: ["Compressor2", "GlueCompressor", "DrumBuss", "Gate"],
    categories: ["dynamics", "drums", "groove"],
    evidenceTerms: ["attack", "release", "threshold", "compress", "transient"],
    rules: [
      "Set attack from the transient you want to retain.",
      "Set release while listening to the next rhythmic event.",
      "Use gain reduction as feedback, then judge the groove by ear at matched level.",
    ],
    failureModes: [
      "Fast attack removes all punch.",
      "Slow release pins the compressor down across the phrase.",
    ],
  },
  {
    id: "depth-is-a-system",
    title: "Depth is dry/wet balance, predelay, decay, filtering, and dynamics together",
    summary:
      "Reverb alone does not create a convincing front-to-back mix. Foreground separation and background placement depend on several coordinated cues.",
    roles: ["lead", "pad", "drums", "spatial"],
    devices: ["Reverb", "Hybrid", "Echo", "Eq8", "Compressor2"],
    categories: ["spatial", "mixing", "routing"],
    evidenceTerms: ["reverb", "decay", "dry wet", "predelay", "filter", "duck"],
    rules: [
      "Use predelay to separate a foreground attack from its room.",
      "Darken or band-limit distant wet signals.",
      "Shorten or duck tails when arrangement density increases.",
    ],
    failureModes: [
      "Long bright reverbs flatten the entire mix.",
      "Every source appears equally distant.",
    ],
  },
  {
    id: "delay-is-arrangement",
    title: "Delay can write counter-rhythm and perspective",
    summary:
      "Sparse synchronized repeats, stereo offsets, filtered feedback, and automated throws extend motifs without adding another continuously playing instrument.",
    roles: ["lead", "percussion", "spatial", "arrangement"],
    devices: ["Delay", "Echo", "FilterDelay", "GrainDelay"],
    categories: ["spatial", "groove", "soundDesign"],
    evidenceTerms: ["delay", "feedback", "send", "automate", "ping pong"],
    rules: [
      "Choose repeat timing from the empty spaces around the motif.",
      "Filter feedback so repeats recede.",
      "Automate sends on phrase endings rather than running high feedback continuously.",
    ],
    failureModes: [
      "Repeats collide with the original rhythm.",
      "Unfiltered feedback accumulates harshness and low-end energy.",
    ],
  },
  {
    id: "drums-need-separated-stages",
    title: "Design drum transient, body, tone, and room as separate stages",
    summary:
      "Professional drum weight comes from controlling distinct perceptual components instead of stacking undifferentiated samples and bus processing.",
    roles: ["kick", "snare-clap", "percussion", "drums"],
    devices: ["DrumCell", "Operator", "OriginalSimpler", "DrumBuss", "Eq8", "Reverb"],
    categories: ["drums", "soundDesign", "dynamics"],
    evidenceTerms: ["kick", "snare", "transient", "body", "layer", "room"],
    rules: [
      "Tune and envelope the body before adding color.",
      "Keep the click/noise transient short and spectrally purposeful.",
      "Put room and ambience on controlled layers or sends.",
    ],
    failureModes: [
      "Layering increases peak level without increasing perceived impact.",
      "Long tails smear the groove and steal headroom.",
    ],
  },
  {
    id: "physical-modeling-needs-protection",
    title: "Physical models make organic tone but can produce extreme resonances",
    summary:
      "Collision, Corpus, and String Studio create convincing material behavior, but resonator feedback and excitation can jump in level unpredictably.",
    roles: ["percussion", "lead", "texture"],
    devices: ["Collision", "Corpus", "StringStudio", "Limiter", "Eq8"],
    categories: ["soundDesign", "drums", "dynamics"],
    evidenceTerms: ["physical", "resonator", "material", "limiter", "loud"],
    rules: [
      "Place a safety limiter while designing.",
      "Tune material, decay, and excitation in the target register.",
      "Remove narrow resonances after the physical model, not by flattening all character.",
    ],
    failureModes: [
      "A resonator produces sudden clipping or painful peaks.",
      "Over-damping removes the organic response that justified the model.",
    ],
  },
  {
    id: "resampling-commits-complexity",
    title: "Resampling converts unstable processes into editable composition",
    summary:
      "Granular, feedback, random, and long effect gestures become precise musical material when printed, selected, cut, reversed, and placed.",
    roles: ["texture", "arrangement", "percussion"],
    devices: ["GrainDelay", "BeatRepeat", "Echo", "Looper", "OriginalSimpler"],
    categories: ["resampling", "soundDesign", "groove"],
    evidenceTerms: ["resample", "record", "freeze", "flatten", "reverse"],
    rules: [
      "Generate more material than needed, then curate.",
      "Cut gestures to phrase boundaries and rhythmic gaps.",
      "Preserve the source patch and random seed/state when reproducibility matters.",
    ],
    failureModes: [
      "A chaotic effect remains live and changes the mix every render.",
      "Ear candy plays continuously and loses contrast.",
    ],
  },
  {
    id: "variation-with-constraints",
    title: "Human variation is constrained, not uniformly random",
    summary:
      "Velocity, timing, probability, note length, and timbre should vary by role and phrase while anchors remain stable.",
    roles: ["drums", "percussion", "bass", "arrangement"],
    devices: ["MidiVelocity", "MidiRandom", "MidiNoteLength", "OriginalSimpler", "DrumGroupDevice"],
    categories: ["groove", "drums", "harmony"],
    evidenceTerms: ["velocity", "random", "probability", "groove", "timing"],
    rules: [
      "Protect downbeats and identity notes.",
      "Vary supporting hits within bounded ranges.",
      "Create phrase-level fills and omissions in addition to micro-variation.",
    ],
    failureModes: [
      "Uniform random timing sounds sloppy rather than human.",
      "A perfectly repeated loop has no phrase direction.",
    ],
  },
  {
    id: "racks-are-composition-tools",
    title: "Racks encode orchestration, not merely preset storage",
    summary:
      "Parallel chains, key/velocity zones, chain selectors, nested returns, and macros turn one track into a controlled arrangement system.",
    roles: ["arrangement", "drums", "lead", "pad", "mix-bus"],
    devices: [
      "AudioEffectGroupDevice",
      "InstrumentGroupDevice",
      "DrumGroupDevice",
      "MidiEffectGroupDevice",
      "AudioBranchMixerDevice",
    ],
    categories: ["routing", "soundDesign", "drums"],
    evidenceTerms: ["rack", "chain", "macro", "selector", "map"],
    rules: [
      "Map macros to perceptual outcomes, not arbitrary parameters.",
      "Use selectors for section variants and performance states.",
      "Represent nested routing explicitly in the headless graph.",
    ],
    failureModes: [
      "Flattening a rack to one serial chain changes its sound.",
      "A macro moves unrelated parameters without calibrated ranges.",
    ],
  },
  {
    id: "section-contrast",
    title: "Arrangement development needs orchestration changes",
    summary:
      "A convincing track develops through changes in register, density, rhythm, voicing, foreground, and motif—not only filter sweeps and muted drums.",
    roles: ["arrangement", "bass", "drums", "lead", "pad"],
    devices: ["AutoFilter", "MidiArpeggiator", "MidiChord", "BeatRepeat", "Echo"],
    categories: ["harmony", "groove", "soundDesign"],
    evidenceTerms: ["arrangement", "section", "variation", "automate", "build"],
    rules: [
      "Give each section a distinct active-role set.",
      "Develop motifs through answer phrases, octave/voicing changes, and rhythmic displacement.",
      "Use transitions to prepare structural changes, not substitute for them.",
    ],
    failureModes: [
      "An eight-bar loop is extended by muting one channel at a time.",
      "The same melody, voicing, and bass rhythm run unchanged for the whole track.",
    ],
  },
  {
    id: "factory-presets-as-ground-truth",
    title: "Factory presets are executable design vocabulary",
    summary:
      "Installed ADV/ADG assets capture Ableton's own parameter choices and routings; they are better starting points than approximate custom reimplementations when native execution is available.",
    roles: ["bass", "drums", "lead", "pad", "mix-bus"],
    devices: ["Eq8", "Roar", "Reverb", "GlueCompressor", "Chorus2", "DrumBuss"],
    categories: ["soundDesign", "mixing", "routing"],
    evidenceTerms: ["preset", "rack", "chain", "device"],
    rules: [
      "Resolve and retain exact preset asset paths.",
      "Render through Ableton's native processor when proven.",
      "Treat unsupported rack semantics as blockers, not invitations to substitute homemade DSP.",
    ],
    failureModes: [
      "A preset is parsed but its native algorithm is approximated.",
      "Nested chains or sidechains are silently discarded.",
    ],
  },
  {
    id: "audible-fixtures-close-loop",
    title: "Every extracted technique needs an audible fixture",
    summary:
      "Transcript and OCR extraction produce hypotheses. The learning loop closes only when a minimal render demonstrates the intended change and survives level-matched comparison.",
    roles: ["mix-bus", "arrangement"],
    devices: ["SpectrumAnalyzer", "StereoGain", "Limiter"],
    categories: ["mixing", "soundDesign"],
    evidenceTerms: ["listen", "compare", "output", "gain"],
    rules: [
      "Build one-variable A/B fixtures for parameters and routing.",
      "Store source timestamp, device state, render, and measurement together.",
      "Promote a recipe only after it sounds useful in context.",
    ],
    failureModes: [
      "Caption frequency is mistaken for production quality.",
      "A graph is considered supported because it parses without rendering.",
    ],
  },
];

const ROLE_DEFINITIONS = [
  {
    id: "kick",
    title: "Kick",
    goal: "Create a tuned, short low-frequency anchor with a controlled transient and enough upper information to read on small systems.",
    devices: ["DrumCell", "Operator", "OriginalSimpler", "Eq8", "DrumBuss", "Saturator"],
    categories: ["drums", "bass", "dynamics"],
    evidenceTerms: ["kick"],
    buildOrder: [
      "Choose or synthesize the body in the track key/register.",
      "Set pitch and amplitude envelopes before effects.",
      "Add only the click or harmonics needed for translation.",
      "Control tail length against the bass rhythm.",
      "Check phase, headroom, and mono.",
    ],
    listenFor: [
      "One clear transient",
      "Stable fundamental",
      "No tail collision with bass",
      "Audibility at low playback level",
    ],
  },
  {
    id: "snare-clap",
    title: "Snare and clap",
    goal: "Separate attack, body, noise, width, and room so the backbeat is deep without becoming washy.",
    devices: ["DrumCell", "OriginalSimpler", "Eq8", "DrumBuss", "Reverb", "StereoGain"],
    categories: ["drums", "spatial"],
    evidenceTerms: ["snare", "clap"],
    buildOrder: [
      "Pick a body with the right pitch and decay.",
      "Add a short noise/transient layer only if needed.",
      "Shape harshness before adding air.",
      "Use a short room or controlled send for depth.",
      "Vary support hits while keeping the primary backbeat stable.",
    ],
    listenFor: [
      "Body at mix level",
      "No brittle top",
      "Room ends before the next important event",
      "Centered impact with optional wide tail",
    ],
  },
  {
    id: "percussion",
    title: "Hats and percussion",
    goal: "Provide subdivision, syncopation, and high-frequency motion without constant harsh energy.",
    devices: [
      "Collision",
      "OriginalSimpler",
      "DrumGroupDevice",
      "Eq8",
      "AutoPan2",
      "BeatRepeat",
      "GrainDelay",
    ],
    categories: ["drums", "groove", "resampling"],
    evidenceTerms: ["hat", "percussion", "shaker"],
    buildOrder: [
      "Establish one clear subdivision role.",
      "Vary velocity and articulation within narrow bounds.",
      "Add syncopated answers and occasional omissions.",
      "Control harsh resonances.",
      "Reserve spatial or glitch gestures for phrase punctuation.",
    ],
    listenFor: [
      "Groove at low volume",
      "Air without pain",
      "Different phrase endings",
      "No stereo distraction from the core pulse",
    ],
  },
  {
    id: "drums",
    title: "Drum bus",
    goal: "Turn separate hits into one energetic instrument while preserving transient hierarchy and headroom.",
    devices: ["DrumGroupDevice", "DrumBuss", "GlueCompressor", "Saturator", "Eq8", "Limiter"],
    categories: ["drums", "dynamics", "mixing"],
    evidenceTerms: ["drum", "bus"],
    buildOrder: [
      "Balance individual hits first.",
      "Remove cumulative low/harsh buildup.",
      "Choose one primary bus-color stage.",
      "Set bus dynamics from groove timing.",
      "Parallelize heavy color if the dry transient must survive.",
    ],
    listenFor: [
      "Kick remains dominant",
      "Snare does not collapse",
      "Hats do not trigger excessive gain reduction",
      "Matched-level processing adds cohesion",
    ],
  },
  {
    id: "bass",
    title: "Bass and low end",
    goal: "Create a mono-stable fundamental with rhythmic definition and controlled upper harmonics that survives different playback systems.",
    devices: [
      "Operator",
      "Drift",
      "UltraAnalog",
      "OriginalSimpler",
      "Roar",
      "Saturator",
      "Compressor2",
      "StereoGain",
      "Eq8",
    ],
    categories: ["bass", "soundDesign", "dynamics"],
    evidenceTerms: ["bass", "sub", "low end"],
    buildOrder: [
      "Write the bass rhythm around kick occupancy.",
      "Establish the clean fundamental and note envelope.",
      "Add a separate or band-limited harmonic layer.",
      "Control peaks and sidechain interaction.",
      "Audit mono and small-speaker translation.",
    ],
    listenFor: [
      "Pitch remains readable",
      "Kick and bass alternate or interlock",
      "Sub is centered",
      "Upper harmonics do not buzz continuously",
    ],
  },
  {
    id: "lead",
    title: "Lead, pluck, and hook",
    goal: "Make a memorable foreground voice with intentional articulation, spectral focus, movement, and phrase-aware delay/reverb.",
    devices: [
      "Drift",
      "InstrumentMeld",
      "Operator",
      "UltraAnalog",
      "AutoFilter",
      "Chorus2",
      "Echo",
      "Reverb",
    ],
    categories: ["harmony", "soundDesign", "spatial"],
    evidenceTerms: ["lead", "pluck", "melody"],
    buildOrder: [
      "Write a motif with an answer and a rest pattern.",
      "Set note envelope and filter articulation.",
      "Add one identity-producing modulation route.",
      "Create perspective with filtered delay/reverb.",
      "Automate timbre or throws at phrase boundaries.",
    ],
    listenFor: [
      "Recognizable in dry mono",
      "Clear attack",
      "Space fills gaps rather than obscuring notes",
      "Variation across sections",
    ],
  },
  {
    id: "pad",
    title: "Pads and harmonic beds",
    goal: "Support harmony and depth with evolving tone while leaving room for foreground, bass, and drums.",
    devices: [
      "InstrumentMeld",
      "UltraAnalog",
      "MultiSampler",
      "Chorus2",
      "Hybrid",
      "Reverb",
      "Eq8",
      "StereoGain",
    ],
    categories: ["harmony", "spatial", "soundDesign"],
    evidenceTerms: ["pad", "chord", "ambient"],
    buildOrder: [
      "Choose voicings that avoid the bass register.",
      "Use slow envelope and low-depth modulation for evolution.",
      "Remove masking mids or lows in context.",
      "Spread upper detail while controlling center energy.",
      "Automate density and brightness by section.",
    ],
    listenFor: [
      "Harmony is clear but not foreground",
      "No low-mid fog",
      "Motion is slower than lead articulation",
      "Section transitions change voicing or density",
    ],
  },
  {
    id: "spatial",
    title: "Depth and spatial effects",
    goal: "Build a coherent front-to-back and side-to-side scene using filtered shared spaces, selective delays, and dynamic clearance.",
    devices: ["Reverb", "Hybrid", "Echo", "Delay", "FilterDelay", "StereoGain", "Compressor2"],
    categories: ["spatial", "routing", "mixing"],
    evidenceTerms: ["reverb", "delay", "space", "depth"],
    buildOrder: [
      "Declare foreground and background roles.",
      "Create a small number of shared spaces.",
      "Filter returns and set predelay/decay from density.",
      "Use delays to occupy rhythmic gaps.",
      "Duck or automate wet paths when foreground clarity is needed.",
    ],
    listenFor: [
      "Foreground remains intelligible",
      "Returns share a believable character",
      "Low end stays dry and stable",
      "Tails change with arrangement density",
    ],
  },
  {
    id: "texture",
    title: "Texture and ear candy",
    goal: "Create sparse, curated details that reward attention and mark transitions without becoming a continuous noise layer.",
    devices: [
      "GrainDelay",
      "BeatRepeat",
      "Erosion",
      "Redux2",
      "Vinyl",
      "Corpus",
      "OriginalSimpler",
    ],
    categories: ["resampling", "soundDesign", "spatial"],
    evidenceTerms: ["texture", "ear candy", "resample"],
    buildOrder: [
      "Generate from existing motif or drum material.",
      "Print unstable processing to audio.",
      "Curate the strongest short fragments.",
      "Place them in structural gaps or boundaries.",
      "Filter, pan, and level them behind primary roles.",
    ],
    listenFor: [
      "Details are discoverable, not dominant",
      "Each gesture has a structural reason",
      "Repeated renders stay deterministic",
      "No cumulative high-frequency clutter",
    ],
  },
  {
    id: "arrangement",
    title: "Arrangement and development",
    goal: "Transform loops into sections through role changes, motif development, density, register, and transitions.",
    devices: [
      "MidiArpeggiator",
      "MidiChord",
      "MidiNoteLength",
      "AutoFilter",
      "BeatRepeat",
      "Echo",
      "AudioEffectGroupDevice",
    ],
    categories: ["harmony", "groove", "routing"],
    evidenceTerms: ["arrangement", "section", "build", "variation"],
    buildOrder: [
      "Define the energy and active roles of each section.",
      "Write at least two motif/bass/drum states.",
      "Change orchestration or register before adding transition FX.",
      "Use fills, automation, and resampled gestures to connect states.",
      "Audit the full-song energy curve without soloing.",
    ],
    listenFor: [
      "Every 8–16 bars changes meaningful information",
      "Hooks have answers and absences",
      "Transitions predict the next section",
      "The climax is earned by prior restraint",
    ],
  },
  {
    id: "mix-bus",
    title: "Mix bus and translation",
    goal: "Preserve the composition's hierarchy while adding cohesion, controlling peaks, and verifying spectral/stereo translation.",
    devices: ["GlueCompressor", "Eq8", "Saturator", "Limiter", "SpectrumAnalyzer", "StereoGain"],
    categories: ["mixing", "dynamics"],
    evidenceTerms: ["mix", "master", "bus", "gain"],
    buildOrder: [
      "Fix arrangement and channel balance first.",
      "Gain-stage into the bus chain consistently.",
      "Apply broad tonal or dynamic changes at matched loudness.",
      "Use limiting for peak control, not to invent punch.",
      "Check mono, low playback level, and multiple references.",
    ],
    listenFor: [
      "Lead and kick hierarchy survives",
      "No chronic gain reduction",
      "Low end remains centered",
      "Processing helps at matched loudness",
    ],
  },
];

await main();

async function main() {
  const inputPaths = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, path.resolve(value)]),
  );
  const [capabilities, videoKnowledge, corpus, tutorialRecipes, headlessTechniques, analyses] =
    await Promise.all([
      readJson(inputPaths.capabilities),
      readJson(inputPaths["video-knowledge"]),
      readJson(inputPaths.corpus),
      readJson(inputPaths.recipes),
      readJson(inputPaths.techniques),
      readAnalyses(inputPaths["video-dir"]),
    ]);

  outputDir = inputPaths.output;
  videoDirectory = inputPaths["video-dir"];
  evidenceByFamily = new Map(videoKnowledge.devices.map((item) => [item.family, item]));
  recipes = normalizeRecipes(tutorialRecipes, headlessTechniques);
  officialArticles = corpus.officialArticles.map(normalizeOfficialArticle);
  videos = analyses.map(normalizeVideo).sort((a, b) => b.qualityScore - a.qualityScore);
  evidenceWindows = analyses.flatMap(normalizeEvidenceWindows);
  devices = capabilities.families
    .map((capability) => buildDevice(capability))
    .sort((a, b) => a.family.localeCompare(b.family));
  principles = PRINCIPLE_DEFINITIONS.map(buildPrinciple);
  roles = ROLE_DEFINITIONS.map(buildRole);
  const gaps = buildGaps(devices, videos);
  const sourceIndex = { officialArticles, videos };
  const knowledgeBase = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    title: "Ableton Production and Headless Orchestration Knowledge Base",
    purpose:
      "Convert official documentation, long-form tutorials, visual evidence, factory presets, and native-engine audits into grounded production guidance that can be executed or explicitly tracked as unsupported.",
    method: {
      corpus:
        "Official Ableton articles plus diversified YouTube tutorials, English subtitles, chapters, targeted frames, and OCR.",
      synthesis:
        "Curated production principles are linked to automatically ranked timestamped evidence, device families, roles, recipes, and current native-engine capability records.",
      evidenceLevels: {
        observed: "Directly supported by transcript/frame evidence.",
        synthesized: "A reusable production conclusion assembled from multiple observed examples.",
        executable: "The required device or preset path is currently render-proven headlessly.",
        partial:
          "The device renders, but some routing, automation, preset, or nested-rack semantics remain incomplete.",
        unknown: "No tutorial evidence or engine proof currently exists.",
      },
      warning:
        "Tutorial frequency is not an endorsement. Numeric values extracted from speech/OCR are candidates, not verified presets, until an audible fixture passes.",
    },
    counts: {
      deviceFamilies: devices.length,
      completeFamilies: devices.filter((item) => item.execution.headlessStatus === "complete")
        .length,
      partialFamilies: devices.filter((item) => item.execution.headlessStatus === "partial").length,
      familiesWithTutorialEvidence: devices.filter((item) => item.tutorialEvidence.videos > 0)
        .length,
      principles: principles.length,
      roles: roles.length,
      recipes: recipes.length,
      officialArticles: officialArticles.length,
      videos: videos.length,
      tutorialHours: round(sum(videos.map((item) => item.durationSeconds)) / 3600, 2),
      transcriptVideos: videos.filter((item) => item.transcriptCues > 0).length,
      actionWindows: sum(videos.map((item) => item.actionWindows)),
      frames: sum(videos.map((item) => item.frames)),
    },
    learned: principles,
    roles,
    devices,
    recipes,
    sources: sourceIndex,
    gaps,
    searchIndex: buildSearchIndex({
      principles,
      roles,
      devices,
      recipes,
      officialArticles,
      videos,
    }),
  };

  await writeKnowledgeBase(knowledgeBase);
  console.log(
    JSON.stringify({ output: outputDir, ...knowledgeBase.counts, gaps: gaps.length }, null, 2),
  );
}
