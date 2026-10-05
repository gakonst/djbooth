import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "corpus-dir": {
      type: "string",
      default: "/Users/gakonst/Library/Caches/djbooth/ableton-tutorial-videos",
    },
    capabilities: { type: "string", default: "/tmp/ableton-capabilities.json" },
    output: {
      type: "string",
      default: "/Users/gakonst/Library/Caches/djbooth/ableton-tutorial-videos/knowledge.json",
    },
    markdown: {
      type: "string",
      default: "/Users/gakonst/Library/Caches/djbooth/ableton-tutorial-videos/knowledge.md",
    },
  },
  strict: true,
});

const corpusDir = path.resolve(values["corpus-dir"]);
const outputPath = path.resolve(values.output);
const markdownPath = path.resolve(values.markdown);
const capabilities = (await isFile(values.capabilities))
  ? JSON.parse(await readFile(values.capabilities, "utf8"))
  : { families: [] };
const capabilityByFamily = new Map(
  (capabilities.families ?? []).map((family) => [family.family, family]),
);
const analyses = await readAnalyses(path.join(corpusDir, "videos"));
const devices = synthesizeDevices(analyses, capabilityByFamily);
const categories = synthesizeCategories(analyses);
const unrecognizedCapabilityFamilies = (capabilities.families ?? [])
  .filter((family) => !devices.some((device) => device.family === family.family))
  .map((family) => ({
    family: family.family,
    headlessStatus: family.headlessStatus,
    engineStatus: family.engineStatus,
    blocker: family.blocker,
  }));

const knowledge = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  corpusDir,
  method: {
    evidence: "English subtitles, chapters, action-window text, targeted frames, and frame OCR",
    aggregation: "device/action/parameter frequency plus scored timestamped evidence",
    caveat: "This map identifies grounded technique candidates. Exact settings still require visual/LLM review and an audible Ableton render fixture.",
  },
  counts: {
    videos: analyses.length,
    durationHours: round(sum(analyses.map((analysis) => analysis.durationSeconds)) / 3_600, 2),
    withTranscript: analyses.filter((analysis) => analysis.transcript.cueCount > 0).length,
    needsAsr: analyses.filter((analysis) => analysis.transcript.needsAsr).length,
    frames: sum(analyses.map((analysis) => analysis.frames.length)),
    actionWindows: sum(analyses.map((analysis) => analysis.actionWindows.length)),
    deviceFamiliesWithEvidence: devices.length,
    capabilityFamiliesWithoutEvidence: unrecognizedCapabilityFamilies.length,
  },
  qualityQueue: analyses
    .map(videoQuality)
    .sort((left, right) => right.score - left.score)
    .slice(0, 100),
  devices,
  categories,
  capabilityFamiliesWithoutEvidence: unrecognizedCapabilityFamilies,
  synthesisQueue: devices
    .flatMap((device) =>
      device.topEvidence.slice(0, 5).map((evidence) => ({
        family: device.family,
        capabilityStatus: device.capability?.headlessStatus ?? "unmapped",
        ...evidence,
      })),
    )
    .sort((left, right) => right.evidenceScore - left.evidenceScore)
    .slice(0, 250),
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(knowledge, null, 2)}\n`);
await writeFile(markdownPath, renderMarkdown(knowledge));
console.log(JSON.stringify({ output: outputPath, markdown: markdownPath, ...knowledge.counts }, null, 2));

function synthesizeDevices(items, capabilitiesByFamily) {
  const families = new Map();
  for (const analysis of items) {
    const familyNames = new Set([
      ...analysis.devices,
      ...analysis.actionWindows.flatMap((window) => window.devices),
    ]);
    for (const family of familyNames) {
      const entry = families.get(family) ?? {
        family,
        videoIds: new Set(),
        transcriptVideos: new Set(),
        actions: new Map(),
        parameters: new Map(),
        evidence: [],
      };
      entry.videoIds.add(analysis.id);
      if (analysis.transcript.cueCount > 0) entry.transcriptVideos.add(analysis.id);
      for (const window of analysis.actionWindows.filter((window) => window.devices.includes(family))) {
        incrementAll(entry.actions, window.actions);
        incrementAll(entry.parameters, window.parameters);
        entry.evidence.push(evidenceRecord(analysis, window));
      }
      families.set(family, entry);
    }
  }
  return [...families.values()]
    .map((entry) => {
      const capability = capabilitiesByFamily.get(entry.family) ?? null;
      const topEvidence = dedupeEvidence(entry.evidence)
        .filter((item) => item.actions.length > 0 || item.parameters.length > 0)
        .sort((left, right) => right.evidenceScore - left.evidenceScore)
        .slice(0, 20)
        .map((item) => ({ ...item, evidence: compactRepeatedPhrases(item.evidence) }));
      return {
        family: entry.family,
        capability: capability
          ? {
              mechanism: capability.mechanism,
              engineStatus: capability.engineStatus,
              presetStatus: capability.presetStatus,
              headlessStatus: capability.headlessStatus,
              blocker: capability.blocker,
            }
          : null,
        evidenceStatus: evidenceStatus(entry.videoIds.size, entry.evidence.length, entry.parameters.size),
        videos: entry.videoIds.size,
        transcriptVideos: entry.transcriptVideos.size,
        actionWindows: entry.evidence.length,
        commonActions: frequencyList(entry.actions, 20),
        commonParameters: frequencyList(entry.parameters, 30),
        topEvidence,
      };
    })
    .sort((left, right) => right.actionWindows - left.actionWindows || right.videos - left.videos);
}

function synthesizeCategories(items) {
  const categories = new Map();
  for (const analysis of items) {
    for (const category of analysis.categories) {
      const entry = categories.get(category) ?? { videos: new Set(), devices: new Map(), actions: new Map() };
      entry.videos.add(analysis.id);
      incrementAll(entry.devices, analysis.devices);
      incrementAll(entry.actions, analysis.actionWindows.flatMap((window) => window.actions));
      categories.set(category, entry);
    }
  }
  return [...categories.entries()]
    .map(([category, entry]) => ({
      category,
      videos: entry.videos.size,
      commonDevices: frequencyList(entry.devices, 20),
      commonActions: frequencyList(entry.actions, 20),
    }))
    .sort((left, right) => right.videos - left.videos);
}

function evidenceRecord(analysis, window) {
  const frame = analysis.frames.find((candidate) => candidate.file === window.nearestFrame) ?? null;
  return {
    videoId: analysis.id,
    title: analysis.title,
    uploader: analysis.uploader,
    url: analysis.url,
    startSeconds: round(window.startSeconds, 3),
    timestampUrl: `${analysis.url}&t=${Math.floor(window.startSeconds)}s`,
    chapter: window.chapter,
    actions: window.actions,
    parameters: window.parameters,
    evidenceScore:
      window.score +
      (frame?.ocr ? 2 : 0) +
      (window.parameters.length ? 3 : 0) +
      (window.actions.length ? 2 : 0),
    evidence: window.evidence.slice(0, 600),
    frame: frame
      ? {
          path: path.join(corpusDir, "videos", analysis.id, frame.file),
          seconds: frame.seconds,
          ocr: frame.ocr.slice(0, 600),
        }
      : null,
  };
}

function videoQuality(analysis) {
  const transcriptRatio = analysis.durationSeconds > 0
    ? Math.min(1, analysis.transcript.coverageSeconds / analysis.durationSeconds)
    : 0;
  const ocrFrames = analysis.frames.filter((frame) => frame.ocr.length >= 20).length;
  const score =
    (analysis.transcript.cueCount > 0 ? 20 : 0) +
    transcriptRatio * 20 +
    Math.min(20, analysis.actionWindows.length) +
    Math.min(15, analysis.devices.length * 3) +
    Math.min(15, ocrFrames * 2) +
    Math.min(10, analysis.chapters.length);
  return {
    id: analysis.id,
    title: analysis.title,
    uploader: analysis.uploader,
    url: analysis.url,
    score: round(score, 2),
    durationSeconds: analysis.durationSeconds,
    transcriptCues: analysis.transcript.cueCount,
    actionWindows: analysis.actionWindows.length,
    frames: analysis.frames.length,
    ocrFrames,
    devices: analysis.devices,
  };
}

function evidenceStatus(videos, windows, parameters) {
  if (videos >= 5 && windows >= 15 && parameters >= 5) return "evidence-rich";
  if (videos >= 2 && windows >= 5) return "usable";
  return "thin";
}

function dedupeEvidence(evidence) {
  const seen = new Set();
  return evidence.filter((item) => {
    const key = `${item.videoId}:${Math.round(item.startSeconds / 10)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compactRepeatedPhrases(value) {
  let words = value.replace(/\s+/gu, " ").trim().split(" ");
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let size = Math.min(40, Math.floor(words.length / 2)); size >= 3; size -= 1) {
      for (let index = 0; index + size * 2 <= words.length; index += 1) {
        const first = words.slice(index, index + size).join(" ").toLowerCase();
        const second = words.slice(index + size, index + size * 2).join(" ").toLowerCase();
        if (first !== second) continue;
        words = [...words.slice(0, index + size), ...words.slice(index + size * 2)];
        changed = true;
        break outer;
      }
    }
  }
  return words.join(" ");
}

function frequencyList(counts, limit) {
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
    .slice(0, limit);
}

function incrementAll(counts, values) {
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
}

async function readAnalyses(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name, "analysis.json"));
  const existing = [];
  for (const file of files) if (await isFile(file)) existing.push(file);
  return Promise.all(existing.map(async (file) => JSON.parse(await readFile(file, "utf8"))));
}

function renderMarkdown(knowledge) {
  const lines = [
    "# Ableton tutorial video knowledge map",
    "",
    `Generated ${knowledge.generatedAt}.`,
    "",
    "## Corpus",
    "",
    `- Videos: ${knowledge.counts.videos}`,
    `- Duration: ${knowledge.counts.durationHours} hours`,
    `- Videos with transcripts: ${knowledge.counts.withTranscript}`,
    `- Videos requiring local ASR: ${knowledge.counts.needsAsr}`,
    `- Targeted frames: ${knowledge.counts.frames}`,
    `- Action windows: ${knowledge.counts.actionWindows}`,
    `- Device families with evidence: ${knowledge.counts.deviceFamiliesWithEvidence}`,
    `- Capability families without evidence: ${knowledge.counts.capabilityFamiliesWithoutEvidence}`,
    "",
    "## Device evidence",
    "",
    "| Device | Capability | Evidence | Videos | Actions | Common parameters |",
    "|---|---|---|---:|---:|---|",
  ];
  for (const device of knowledge.devices) {
    lines.push(
      `| ${escapeCell(device.family)} | ${escapeCell(device.capability?.headlessStatus ?? "unmapped")} | ${device.evidenceStatus} | ${device.videos} | ${device.actionWindows} | ${escapeCell(device.commonParameters.slice(0, 8).map((item) => item.name).join(", "))} |`,
    );
  }
  lines.push("", "## Missing tutorial evidence", "");
  for (const family of knowledge.capabilityFamiliesWithoutEvidence) {
    lines.push(`- [ ] ${family.family} (${family.headlessStatus}; ${family.engineStatus})`);
  }
  lines.push("", "## Highest-priority grounded examples", "");
  for (const item of knowledge.synthesisQueue.slice(0, 50)) {
    lines.push(
      `- [ ] **${item.family}** — [${item.title}](${item.timestampUrl}) at ${formatTime(item.startSeconds)}; actions: ${item.actions.join(", ") || "unspecified"}; parameters: ${item.parameters.join(", ") || "unspecified"}.`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function isFile(filename) {
  try {
    return (await stat(filename)).isFile();
  } catch {
    return false;
  }
}
