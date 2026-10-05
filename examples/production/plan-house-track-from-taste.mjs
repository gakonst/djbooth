import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    lane: { type: "string", default: "indie dance afro house" },
    bpm: { type: "string", default: "125" },
    references: { type: "string", default: "5" },
    corpus: {
      type: "string",
      default: path.join(import.meta.dirname, "house-taste-corpus"),
    },
    analysis: {
      type: "string",
      default: "/Users/gakonst/Library/Caches/djbooth/reference-corpora/personal-house-v1",
    },
    tutorials: {
      type: "string",
      default: "/Users/gakonst/Library/Caches/djbooth/house-tutorial-videos",
    },
    output: {
      type: "string",
      default: path.join(import.meta.dirname, "house-taste-corpus/production-brief.json"),
    },
    markdown: {
      type: "string",
      default: path.join(import.meta.dirname, "house-taste-corpus/production-brief.md"),
    },
  },
  strict: true,
});

const corpusRoot = path.resolve(values.corpus);
const analysisRoot = path.resolve(values.analysis);
const tutorialRoot = path.resolve(values.tutorials);
const targetBpm = Number(values.bpm);
const referenceCount = Number(values.references);
const laneTokens = tokens(values.lane);

const [manifest, tasteModel, tutorialKnowledge, tutorialIndex] = await Promise.all([
  readJson(path.join(corpusRoot, "house-reference-manifest.json")),
  readJson(path.join(corpusRoot, "knowledge-base/taste-model.json")),
  readJson(path.join(tutorialRoot, "knowledge.json")),
  readJson(path.join(tutorialRoot, "index.json")),
]);

const available = [];
for (const track of manifest.tracks) {
  const root = path.join(analysisRoot, track.id);
  if (!(await exists(path.join(root, "reference-profile.json")))) continue;
  const profile = await readJson(path.join(root, "reference-profile.json"));
  const events = await readEvents(path.join(root, "transcription"), track.id);
  available.push({ ...track, profile, events, selectionFit: fit(track, profile) });
}

const panel = balancedPanel(available, referenceCount);
if (!panel.length) throw new Error("No analyzed references currently match the requested lane");
const techniques = selectTutorials(tutorialIndex.videos, values.lane, 10);
const devices = selectDevices(tutorialKnowledge.devices, 18);
const brief = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  request: { lane: values.lane, bpm: targetBpm, references: referenceCount },
  evidenceStatus: {
    analyzedReferencesAvailable: available.length,
    selectedReferences: panel.length,
    tutorialVideos: tutorialKnowledge.counts.videos,
    tutorialHours: tutorialKnowledge.counts.durationHours,
    tutorialActionWindows: tutorialKnowledge.counts.actionWindows,
  },
  referencePanel: panel.map(referenceSummary),
  roleReferences: assignRoles(panel),
  targets: panelTargets(panel),
  midiGrammar: midiGrammar(panel),
  arrangementGrammar: arrangementGrammar(panel),
  corpusGrammar: {
    midi: midiGrammar(available),
    arrangement: arrangementGrammar(available, { includeReferenceMaps: false }),
  },
  tutorialPanel: techniques,
  deviceVocabulary: devices,
  compositionRules: tasteModel.vocabulary.priorities,
  rejectionRules: tasteModel.vocabulary.antiPatterns,
  generationContract: tasteModel.generationContract,
};

await writeFile(path.resolve(values.output), `${JSON.stringify(brief, null, 2)}\n`);
await writeFile(path.resolve(values.markdown), renderMarkdown(brief));
console.log(
  JSON.stringify(
    {
      output: path.resolve(values.output),
      markdown: path.resolve(values.markdown),
      available: available.length,
      selected: panel.map((track) => `${track.artists.join(", ")} — ${track.title}`),
    },
    null,
    2,
  ),
);

function fit(track, profile) {
  const genreTokens = tokens(`${track.genres.join(" ")} ${track.artists.join(" ")}`);
  const overlap = [...laneTokens].filter((token) => genreTokens.has(token)).length;
  const bpmFit = Math.max(0, 1 - Math.abs(profile.bpm - targetBpm) / 10);
  return (
    overlap * 20 +
    bpmFit * 20 +
    Math.min(20, track.tasteScore ?? 0) +
    (track.role === "production-language" ? 8 : 0)
  );
}

function balancedPanel(candidates, count) {
  const selected = [];
  const primaryCounts = new Map();
  for (const candidate of candidates.toSorted(
    (left, right) => right.selectionFit - left.selectionFit,
  )) {
    const primary = candidate.artists[0] ?? "unknown";
    if ((primaryCounts.get(primary) ?? 0) >= 2) continue;
    selected.push(candidate);
    primaryCounts.set(primary, (primaryCounts.get(primary) ?? 0) + 1);
    if (selected.length >= count) break;
  }
  return selected;
}

function assignRoles(tracks) {
  const role = (name, score) => {
    const track = tracks.toSorted((left, right) => score(right) - score(left))[0];
    return [name, referenceSummary(track)];
  };
  return Object.fromEntries([
    role("groove", (track) => track.profile.mix.syncopationRatio),
    role("arrangementContrast", (track) => track.profile.relationships.sectionContrastDb),
    role("spatialDepth", (track) => track.profile.mix.stereoWidthDb),
    role("lowEndHierarchy", (track) => -Math.abs(track.profile.relationships.bassToDrumsRmsDb + 5)),
    role("melodicVocabulary", (track) => track.events.filter((note) => !note.isDrum).length),
  ]);
}

function panelTargets(tracks) {
  const metrics = {
    bpm: (track) => track.profile.bpm,
    crestFactorDb: (track) => track.profile.mix.crestFactorDb,
    transientDensityPerSecond: (track) => track.profile.mix.transientDensityPerSecond,
    syncopationRatio: (track) => track.profile.mix.syncopationRatio,
    stereoWidthDb: (track) => track.profile.mix.stereoWidthDb,
    lowBandRatio: (track) => track.profile.mix.lowBandRatio,
    midBandRatio: (track) => track.profile.mix.midBandRatio,
    highBandRatio: (track) => track.profile.mix.highBandRatio,
    sectionContrastDb: (track) => track.profile.relationships.sectionContrastDb,
    bassToDrumsRmsDb: (track) => track.profile.relationships.bassToDrumsRmsDb,
    otherToDrumsRmsDb: (track) => track.profile.relationships.otherToDrumsRmsDb,
    vocalsToDrumsRmsDb: (track) => track.profile.relationships.vocalsToDrumsRmsDb,
  };
  return Object.fromEntries(
    Object.entries(metrics).map(([name, extract]) => [name, distribution(tracks.map(extract))]),
  );
}

function midiGrammar(tracks) {
  const notes = mergeFragments(tracks.flatMap((track) => track.events));
  const pitched = notes.filter((note) => !note.isDrum);
  const drums = notes.filter((note) => note.isDrum);
  const stemRoles = Object.fromEntries(
    ["drums", "bass", "other", "vocals"].map((stem) => {
      const stemNotes = notes.filter((note) => note.sourceStem === stem);
      return [stem, roleGrammar(stemNotes)];
    }),
  );
  return {
    trustedNotes: notes.length,
    instruments: frequency(
      notes.map((note) => note.instrument),
      30,
    ),
    onsetSixteenthSlots: frequency(
      notes.map((note) => Math.round((((note.onsetBeats % 1) + 1) % 1) * 4) % 4),
      4,
    ),
    pitchedDurationBeats: distribution(pitched.map((note) => note.durationBeats)),
    drumDurationBeats: distribution(drums.map((note) => note.durationBeats)),
    drumPitches: frequency(
      drums.map((note) => note.pitch),
      20,
    ),
    pitchClasses: frequency(
      pitched.map((note) => note.pitch % 12),
      12,
    ),
    melodicMotion: melodicMotion(pitched),
    stemRoles,
    instruction:
      "Sample original parts from the cross-track rhythm cells, articulation, register, and melodic-motion distributions. Never trace one reference melody.",
  };
}

function arrangementGrammar(tracks, { includeReferenceMaps = true } = {}) {
  const transitions = [];
  const activeStemCombinations = [];
  for (const track of tracks) {
    const states = track.profile.sections.map(sectionState);
    activeStemCombinations.push(...states.map((state) => state.activeStems.join("+")));
    for (let index = 1; index < states.length; index += 1) {
      transitions.push(`${states[index - 1].energy}->${states[index].energy}`);
    }
  }
  return {
    phraseLengths: frequency(
      tracks.flatMap((track) =>
        Object.entries(track.profile.phraseLengthHistogram).flatMap(([bars, count]) =>
          Array(Number(count)).fill(Number(bars)),
        ),
      ),
      16,
    ),
    energyTransitions: frequency(transitions, 16),
    activeStemCombinations: frequency(activeStemCombinations, 16),
    referenceStateMaps: includeReferenceMaps
      ? tracks.map((track) => ({
          id: track.id,
          states: track.profile.sections.map(sectionState),
        }))
      : [],
    instruction:
      "Create an original state sequence with comparable contrast and phrase scale, not the section order of any one reference.",
  };
}

function sectionState(section) {
  return {
    bars: section.durationBars,
    energy: section.energyZ < -0.5 ? "sparse" : section.energyZ > 0.4 ? "payoff" : "bridge",
    activeStems: Object.entries(section.stemRmsDb)
      .filter(([, rms]) => rms > -45)
      .map(([stem]) => stem),
    changeDistance: round(section.distanceFromPrevious),
  };
}

function roleGrammar(notes) {
  const pitched = notes.filter((note) => !note.isDrum);
  const cells = new Map();
  const observedCells = [];
  const bySource = groupBy(notes, (note) => note.sourceFile);
  for (const sourceNotes of bySource.values()) {
    const bars = groupBy(sourceNotes, (note) => Math.floor(note.onsetBeats / 4));
    for (const barNotes of bars.values()) {
      const slots = [
        ...new Set(
          barNotes.map((note) => Math.round(mod(note.onsetBeats, 4) * 4) % 16),
        ),
      ].sort((left, right) => left - right);
      if (!slots.length) continue;
      observedCells.push(slots);
      const signature = slots.join(".");
      const tracks = cells.get(signature) ?? new Set();
      for (const note of barNotes) tracks.add(note.trackId);
      cells.set(signature, tracks);
    }
  }
  const rhythmCells = [...cells.entries()]
    .map(([signature, trackIds]) => ({
      slots: signature.split(".").map(Number),
      tracks: trackIds.size,
    }))
    .filter((cell) => cell.tracks >= Math.min(2, new Set(notes.map((note) => note.trackId)).size))
    .sort(
      (left, right) =>
        right.tracks - left.tracks ||
        Math.abs(left.slots.length - 4) - Math.abs(right.slots.length - 4),
    )
    .slice(0, 24);
  return {
    notes: notes.length,
    instruments: frequency(notes.map((note) => note.instrument), 16),
    rhythmCells,
    slotProbabilities: Array.from({ length: 16 }, (_, slot) => ({
      slot,
      probability: round(
        observedCells.length
          ? observedCells.filter((cell) => cell.includes(slot)).length / observedCells.length
          : 0,
      ),
    })),
    densityPerBar: distribution(observedCells.map((cell) => cell.length)),
    durationBeats: distribution(notes.map((note) => note.durationBeats)),
    register: pitched.length ? distribution(pitched.map((note) => note.pitch)) : null,
    melodicMotion: melodicMotion(pitched),
    polyphony: polyphony(pitched),
  };
}

function melodicMotion(notes) {
  const intervals = [];
  const contours = [];
  const byVoice = groupBy(notes, (note) => `${note.trackId}:${note.sourceFile}:${note.instrument}`);
  for (const voice of byVoice.values()) {
    const onsetGroups = [...groupBy(voice, (note) => Math.round(note.onsetBeats * 8)).values()]
      .map((group) => ({
        onset: Math.min(...group.map((note) => note.onsetBeats)),
        pitch: median(group.map((note) => note.pitch)),
      }))
      .sort((left, right) => left.onset - right.onset);
    const contour = [];
    for (let index = 1; index < onsetGroups.length; index += 1) {
      const interval = Math.round(onsetGroups[index].pitch - onsetGroups[index - 1].pitch);
      if (Math.abs(interval) > 24) continue;
      intervals.push(interval);
      contour.push(Math.sign(interval));
    }
    if (contour.length >= 3) contours.push(contour.slice(0, 8).join(","));
  }
  return {
    intervals: frequency(intervals, 24),
    contours: frequency(contours, 16),
  };
}

function polyphony(notes) {
  if (!notes.length) return { median: 0, p75: 0, max: 0 };
  const groups = [...groupBy(notes, (note) => Math.round(note.onsetBeats * 8)).values()];
  const values = groups.map((group) => new Set(group.map((note) => note.pitch)).size);
  const result = distribution(values);
  return { median: result.median, p75: result.p75, max: result.max };
}

function mergeFragments(notes) {
  const merged = [];
  const groups = groupBy(
    notes,
    (note) => `${note.trackId}:${note.sourceFile}:${note.instrument}:${note.pitch}`,
  );
  for (const fragments of groups.values()) {
    const ordered = fragments.toSorted((left, right) => left.onsetBeats - right.onsetBeats);
    for (const fragment of ordered) {
      const previous = merged.at(-1);
      const previousEnd = previous ? previous.onsetBeats + previous.durationBeats : -Infinity;
      const gap = fragment.onsetBeats - previousEnd;
      if (
        previous &&
        previous.trackId === fragment.trackId &&
        previous.sourceFile === fragment.sourceFile &&
        previous.instrument === fragment.instrument &&
        previous.pitch === fragment.pitch &&
        (gap < -0.03 ||
          (gap <= 0.04 && previous.durationBeats > 0.4 && fragment.durationBeats > 0.4))
      ) {
        previous.durationBeats = Math.max(
          previous.durationBeats,
          fragment.onsetBeats + fragment.durationBeats - previous.onsetBeats,
        );
      } else {
        merged.push({ ...fragment });
      }
    }
  }
  return merged;
}

function selectTutorials(videos, lane, count) {
  const requested = tokens(lane);
  return videos
    .map((video) => {
      const material = tokens(
        `${video.title} ${video.categories.join(" ")} ${video.devices.join(" ")}`,
      );
      const overlap = [...requested].filter((token) => material.has(token)).length;
      return {
        ...video,
        fit: overlap * 10 + video.actionWindows / 10 + video.transcript.cueCount / 200,
      };
    })
    .sort((left, right) => right.fit - left.fit)
    .slice(0, count)
    .map((video) => ({
      id: video.id,
      title: video.title,
      uploader: video.uploader,
      url: video.url ?? `https://www.youtube.com/watch?v=${video.id}`,
      categories: video.categories,
      devices: video.devices,
      actionWindows: video.actionWindows,
    }));
}

function selectDevices(devices, count) {
  return devices
    .filter((device) => device.capability?.headlessStatus !== "blocked")
    .sort((left, right) => right.actionWindows - left.actionWindows)
    .slice(0, count)
    .map((device) => ({
      family: device.family,
      headlessStatus: device.capability?.headlessStatus ?? "unmapped",
      evidenceStatus: device.evidenceStatus,
      videos: device.videos,
      windows: device.actionWindows,
      actions: device.commonActions.slice(0, 8),
      parameters: device.commonParameters.slice(0, 8),
    }));
}

function referenceSummary(track) {
  return {
    id: track.id,
    title: track.title,
    artists: track.artists,
    genres: track.genres,
    bpm: round(track.profile.bpm),
    key: track.profile.key,
    tasteScore: round(track.tasteScore),
    fit: round(track.selectionFit),
  };
}

function renderMarkdown(brief) {
  return `# Production brief: ${brief.request.lane}\n\n- BPM: ${brief.request.bpm}\n- Evidence: ${brief.evidenceStatus.analyzedReferencesAvailable} analyzed personal references; ${brief.evidenceStatus.tutorialHours} tutorial hours\n\n## Reference panel\n\n${brief.referencePanel.map((track) => `- ${track.artists.join(", ")} — ${track.title}: ${track.bpm} BPM, ${track.key}; ${track.genres.join(", ")}`).join("\n")}\n\n## Role references\n\n${Object.entries(
    brief.roleReferences,
  )
    .map(([role, track]) => `- ${role}: ${track.artists.join(", ")} — ${track.title}`)
    .join("\n")}\n\n## Core targets\n\n${Object.entries(brief.targets)
    .map(
      ([name, target]) => `- ${name}: median ${target.median}; p25–p75 ${target.p25}–${target.p75}`,
    )
    .join(
      "\n",
    )}\n\n## MIDI grammar\n\n- Instruments: ${renderFrequency(brief.midiGrammar.instruments)}\n- Sixteenth slots: ${renderFrequency(brief.midiGrammar.onsetSixteenthSlots)}\n- Drum pitches: ${renderFrequency(brief.midiGrammar.drumPitches)}\n- Pitch classes: ${renderFrequency(brief.midiGrammar.pitchClasses)}\n\n## Tutorial panel\n\n${brief.tutorialPanel.map((video) => `- [${video.title}](${video.url}) — ${video.uploader}; ${video.categories.join(", ")}`).join("\n")}\n\n## Reject\n\n${brief.rejectionRules.map((rule) => `- ${rule}`).join("\n")}\n`;
}

async function readEvents(root, trackId) {
  if (!(await exists(root))) return [];
  const files = (await readdir(root)).filter((filename) => filename.endsWith(".events.json"));
  const events = await Promise.all(
    files.map(async (filename) => ({ filename, event: await readJson(path.join(root, filename)) })),
  );
  return events.flatMap(({ filename, event }) =>
    event.notes
      .filter((note) => note.trusted !== false)
      .map((note) => ({
        ...note,
        trackId,
        sourceFile: filename,
        sourceStem: filename.split("-")[0],
      })),
  );
}

function distribution(values) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!finite.length) return { min: null, p25: null, median: null, p75: null, max: null };
  return {
    min: round(finite[0]),
    p25: round(quantile(finite, 0.25)),
    median: round(quantile(finite, 0.5)),
    p75: round(quantile(finite, 0.75)),
    max: round(finite.at(-1)),
  };
}

function quantile(values, proportion) {
  const position = (values.length - 1) * proportion;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return values[lower + 1] === undefined
    ? values[lower]
    : values[lower] + fraction * (values[lower + 1] - values[lower]);
}

function median(values) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  return finite.length ? quantile(finite, 0.5) : 0;
}

function groupBy(values, key) {
  const groups = new Map();
  for (const value of values) {
    const identifier = key(value);
    const group = groups.get(identifier) ?? [];
    group.push(value);
    groups.set(identifier, group);
  }
  return groups;
}

function mod(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function frequency(values, limit) {
  const counts = new Map();
  for (const value of values) counts.set(String(value), (counts.get(String(value)) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
    .slice(0, limit);
}

function renderFrequency(items) {
  return items.map(({ value, count }) => `${value}=${count}`).join(", ");
}

function tokens(value) {
  return new Set(
    String(value)
      .normalize("NFKD")
      .replaceAll(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 1 && !["and", "the", "house"].includes(token)),
  );
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 1_000) / 1_000 : null;
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

async function exists(filename) {
  try {
    const metadata = await stat(filename);
    return metadata.isFile() || metadata.isDirectory();
  } catch {
    return false;
  }
}
