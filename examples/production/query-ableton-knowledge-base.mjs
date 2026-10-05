import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  options: {
    base: {
      type: "string",
      default: path.join(import.meta.dirname, "ableton-knowledge-base", "knowledge-base.json"),
    },
    type: { type: "string" },
    limit: { type: "string", default: "10" },
    json: { type: "boolean", default: false },
  },
  allowPositionals: true,
  strict: true,
});

const query = positionals.join(" ").trim();
if (!query) throw new Error("Provide a query, for example: wide bass without losing the sub");
const limit = Number.parseInt(values.limit, 10);
if (!Number.isInteger(limit) || limit < 1 || limit > 100)
  throw new Error("--limit must be between 1 and 100");

const basePath = path.resolve(values.base);
const knowledge = JSON.parse(await readFile(basePath, "utf8"));
const evidenceWindows = JSON.parse(
  await readFile(path.join(path.dirname(basePath), "evidence-index.json"), "utf8"),
);
const queryTerms = tokenize(query);
const evidenceSearchIndex = evidenceWindows.map((item) => ({
  type: "evidence",
  id: `${item.videoId}:${item.startSeconds}`,
  title: item.title,
  text: `${item.devices.join(" ")} ${item.categories.join(" ")} ${item.actions.join(" ")} ${item.parameters.join(" ")} ${item.evidence}`.toLowerCase(),
  value: item,
}));
const matches = [...knowledge.searchIndex, ...evidenceSearchIndex]
  .filter((item) => !values.type || item.type === values.type)
  .map((item) => ({ ...item, score: score(item, queryTerms) }))
  .filter((item) => item.score > 0)
  .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
  .slice(0, limit)
  .map((item) => expand(item, knowledge));

if (values.json) {
  console.log(JSON.stringify({ query, matches }, null, 2));
} else {
  console.log(`# Ableton knowledge: ${query}\n`);
  if (!matches.length)
    console.log(
      "No indexed result matched. Try a device, role, sound-design goal, or parameter name.",
    );
  for (const [index, match] of matches.entries()) {
    console.log(`${index + 1}. [${match.type}] ${match.title} (score ${match.score})`);
    console.log(`   ${match.summary}`);
    if (match.execution) console.log(`   Execution: ${match.execution}`);
    if (match.link) console.log(`   ${match.link}`);
    if (match.evidence?.length)
      console.log(
        `   Evidence: ${match.evidence
          .slice(0, 2)
          .map((item) => item.timestampUrl)
          .join(" | ")}`,
      );
    console.log();
  }
}

function score(item, terms) {
  const title = item.title.toLowerCase();
  const id = item.id.toLowerCase();
  const haystack = `${title} ${id} ${item.text}`;
  let result = 0;
  for (const term of terms) {
    if (title.includes(term)) result += 8;
    if (id.includes(term)) result += 5;
    const occurrences = haystack.split(term).length - 1;
    result += Math.min(5, occurrences);
  }
  if (terms.every((term) => haystack.includes(term))) result += 12;
  return result;
}

function expand(item, knowledge) {
  if (item.type === "evidence") {
    return {
      ...item,
      summary: item.value.evidence,
      execution: `Devices: ${item.value.devices.join(", ") || "unclassified"}; parameters: ${item.value.parameters.join(", ") || "none tagged"}.`,
      evidence: [item.value],
      link: item.value.timestampUrl,
      value: undefined,
    };
  }
  if (item.type === "principle") {
    const value = knowledge.learned.find((entry) => entry.id === item.id);
    return {
      ...item,
      summary: value.summary,
      execution: value.executionStatus,
      evidence: value.evidence,
      link: `TECHNIQUES.md#${anchor(value.title)}`,
    };
  }
  if (item.type === "role") {
    const value = knowledge.roles.find((entry) => entry.id === item.id);
    return {
      ...item,
      summary: value.goal,
      execution: summarizeExecution(value.devices),
      evidence: value.evidence,
      link: `roles/${slugify(value.id)}.md`,
    };
  }
  if (item.type === "device") {
    const value = knowledge.devices.find((entry) => entry.family === item.id);
    return {
      ...item,
      summary: `${value.purpose} ${value.productionUse}`,
      execution: value.execution.safeClaim,
      evidence: value.tutorialEvidence.topEvidence,
      link: `devices/${value.slug}.md`,
    };
  }
  if (item.type === "recipe") {
    const value = knowledge.recipes.find((entry) => entry.id === item.id);
    return {
      ...item,
      summary: `${value.goal} Chain: ${value.devices.join(" → ")}.`,
      execution: value.origin,
      evidence: [],
    };
  }
  const sources =
    item.type === "official" ? knowledge.sources.officialArticles : knowledge.sources.videos;
  const value = sources.find((entry) => entry.id === item.id);
  return {
    ...item,
    summary:
      value.summary ??
      `${value.uploader}; ${Math.round(value.durationSeconds / 60)} minutes; devices: ${value.devices.join(", ")}.`,
    link: value.url,
    evidence: [],
  };
}

function summarizeExecution(devices) {
  const complete = devices.filter((item) => item.headlessStatus === "complete").length;
  return `${complete}/${devices.length} named families complete; remaining families have partial native or graph support.`;
}

function tokenize(value) {
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "without",
    "into",
    "from",
    "that",
    "this",
    "how",
    "make",
    "build",
    "using",
  ]);
  const aliases = {
    wide: ["stereo", "width", "chorus"],
    punch: ["transient", "attack", "compression"],
    warm: ["saturation", "harmonics", "drive"],
    space: ["reverb", "delay", "depth"],
    human: ["velocity", "timing", "variation"],
    evolve: ["modulation", "automation", "lfo"],
  };
  const base = value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return [
    ...new Set(
      base
        .flatMap((term) => [term, ...(aliases[term] ?? [])])
        .filter((term) => term.length > 2 && !stopWords.has(term)),
    ),
  ];
}

function slugify(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function anchor(value) {
  return slugify(value);
}
