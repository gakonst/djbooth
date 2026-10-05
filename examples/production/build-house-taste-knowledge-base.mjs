import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusRoot = path.resolve(process.argv[2] ?? path.join(here, "house-taste-corpus"));
const analysisRoot = path.resolve(
  process.argv[3] ?? "/Users/gakonst/Library/Caches/djbooth/reference-corpora/personal-house-v1",
);
const mazRoot = path.resolve(
  process.argv[4] ?? "/Users/gakonst/Library/Caches/djbooth/reference-corpora/maz-modern",
);
const tutorialRoot = path.resolve(
  process.argv[5] ?? "/Users/gakonst/Library/Caches/djbooth/house-tutorial-videos",
);
const outputRoot = path.join(corpusRoot, "knowledge-base");
const documentsRoot = path.join(outputRoot, "documents");

const [manifest, mazManifest, spotify, tutorialKnowledge] = await Promise.all([
  readJson(path.join(corpusRoot, "house-reference-manifest.json")),
  readJson(path.join(here, "maz-reference-corpus.json")),
  readJson(path.join(corpusRoot, "spotify-house-tracks.json")),
  readJson(path.join(tutorialRoot, "knowledge.json")),
]);
const tutorialAnalyses = await readDirectoryJson(
  path.join(tutorialRoot, "videos"),
  "analysis.json",
);
const personalTracks = await readTrackEvidence(analysisRoot, manifest.tracks);
const mazTracks = await readTrackEvidence(
  mazRoot,
  mazManifest.tracks.map((track) => ({
    ...track,
    artists: inferArtistsFromAudio(track.audio),
    role: "maz-production-language",
    genres: ["afro house", "organic house", "brazilian house"],
    playlists: [],
  })),
);
const allTracks = [...personalTracks, ...mazTracks];

await rm(documentsRoot, { recursive: true, force: true });
for (const directory of ["tracks", "producers", "tutorials", "techniques"]) {
  await mkdir(path.join(documentsRoot, directory), { recursive: true });
}

for (const track of allTracks) {
  await writeFile(path.join(documentsRoot, "tracks", `${track.id}.md`), renderTrack(track));
}

const producerGroups = groupProducers(manifest, spotify, allTracks);
for (const producer of producerGroups) {
  await writeFile(
    path.join(documentsRoot, "producers", `${slug(producer.name)}.md`),
    renderProducer(producer),
  );
}

for (const analysis of tutorialAnalyses) {
  await writeFile(
    path.join(documentsRoot, "tutorials", `${analysis.id}.md`),
    renderTutorial(analysis),
  );
}

for (const device of tutorialKnowledge.devices) {
  await writeFile(
    path.join(documentsRoot, "techniques", `${slug(device.family)}.md`),
    renderTechnique(device),
  );
}

const model = buildTasteModel({ manifest, spotify, personalTracks, mazTracks, tutorialKnowledge });
await writeFile(path.join(documentsRoot, "taste-model.md"), renderTasteModel(model));
await writeFile(path.join(documentsRoot, "workflow.md"), renderWorkflow(model));
await writeFile(path.join(documentsRoot, "production-principles.md"), renderPrinciples(model));
await writeFile(path.join(outputRoot, "taste-model.json"), `${JSON.stringify(model, null, 2)}\n`);
await writeFile(path.join(outputRoot, "README.md"), renderReadme(model));

console.log(
  JSON.stringify(
    {
      output: outputRoot,
      analyzedTracks: allTracks.length,
      personalTracks: personalTracks.length,
      mazTracks: mazTracks.length,
      producerDocuments: producerGroups.length,
      tutorialDocuments: tutorialAnalyses.length,
      techniqueDocuments: tutorialKnowledge.devices.length,
    },
    null,
    2,
  ),
);

async function readTrackEvidence(root, manifestTracks) {
  if (!(await exists(root))) return [];
  const manifestById = new Map(manifestTracks.map((track) => [track.id, track]));
  const entries = await readdir(root, { withFileTypes: true });
  const tracks = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const trackRoot = path.join(root, entry.name);
    const profilePath = path.join(trackRoot, "reference-profile.json");
    if (!(await exists(profilePath))) continue;
    const profile = await readJson(profilePath);
    const events = await readEventFiles(path.join(trackRoot, "transcription"));
    const metadata = manifestById.get(entry.name) ?? {
      id: entry.name,
      title: titleCase(entry.name),
      artists: entry.name === "corpus-summary" ? [] : ["Maz corpus"],
      role: "maz-production-language",
      genres: ["afro house", "organic house"],
      playlists: [],
    };
    tracks.push({
      ...metadata,
      id: entry.name,
      corpus: root === mazRoot ? "maz-modern" : "personal-house-v1",
      profile,
      transcription: summarizeEvents(events),
    });
  }
  return tracks.sort((left, right) => left.id.localeCompare(right.id));
}

async function readEventFiles(root) {
  if (!(await exists(root))) return [];
  const files = (await readdir(root)).filter((filename) => filename.endsWith(".events.json"));
  return Promise.all(files.map((filename) => readJson(path.join(root, filename))));
}

function summarizeEvents(events) {
  const notes = events.flatMap((event) => event.notes.filter((note) => note.trusted !== false));
  const pitched = notes.filter((note) => !note.isDrum);
  const drums = notes.filter((note) => note.isDrum);
  const byInstrument = groupBy(notes, (note) => note.instrument);
  return {
    windows: events.length,
    notes: notes.length,
    instruments: [...byInstrument.entries()]
      .map(([instrument, instrumentNotes]) => ({
        instrument,
        notes: instrumentNotes.length,
        pitchRange: instrumentNotes.some((note) => !note.isDrum)
          ? [
              Math.min(...instrumentNotes.filter((note) => !note.isDrum).map((note) => note.pitch)),
              Math.max(...instrumentNotes.filter((note) => !note.isDrum).map((note) => note.pitch)),
            ]
          : null,
        medianDurationBeats: round(median(instrumentNotes.map((note) => note.durationBeats))),
      }))
      .sort((left, right) => right.notes - left.notes),
    pitchClasses: frequency(
      pitched.map((note) => note.pitch % 12),
      12,
    ),
    drumPitches: frequency(
      drums.map((note) => note.pitch),
      16,
    ),
    sixteenthSlots: frequency(
      notes.map((note) => Math.round((((note.onsetBeats % 1) + 1) % 1) * 4) % 4),
      4,
    ),
    medianPitchedDurationBeats: round(median(pitched.map((note) => note.durationBeats))),
    medianDrumDurationBeats: round(median(drums.map((note) => note.durationBeats))),
    melodicIntervals: intervalFrequency(pitched),
  };
}

function groupProducers(referenceManifest, taste, tracks) {
  const spotifyArtistByName = new Map(
    taste.artists.map((artist) => [normalize(artist.name), artist]),
  );
  const references = new Map();
  for (const track of referenceManifest.tracks) {
    for (const artist of track.artists) {
      const values = references.get(artist) ?? [];
      values.push(track);
      references.set(artist, values);
    }
  }
  const evidenceByTitle = new Map(tracks.map((track) => [track.title, track]));
  return [...references.entries()]
    .map(([name, producerTracks]) => ({
      name,
      spotify: spotifyArtistByName.get(normalize(name)) ?? null,
      references: producerTracks.map((track) => ({
        ...track,
        evidence: evidenceByTitle.get(track.title) ?? null,
      })),
    }))
    .sort(
      (left, right) =>
        (right.spotify?.tasteScore ?? 0) - (left.spotify?.tasteScore ?? 0) ||
        left.name.localeCompare(right.name),
    );
}

function buildTasteModel({
  manifest: referenceManifest,
  spotify: taste,
  personalTracks: personal,
  mazTracks: maz,
  tutorialKnowledge: tutorials,
}) {
  const production = personal.filter((track) => track.role === "production-language");
  const lineage = personal.filter((track) => track.role === "hook-lineage");
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: {
      requestedReferences: referenceManifest.tracks.length,
      analyzedPersonalReferences: personal.length,
      analyzedProductionReferences: production.length,
      analyzedHookLineageReferences: lineage.length,
      analyzedMazReferences: maz.length,
      tutorialVideos: tutorials.counts.videos,
      tutorialHours: tutorials.counts.durationHours,
      tutorialActionWindows: tutorials.counts.actionWindows,
    },
    tasteAnchors: taste.artists.slice(0, 30).map((artist) => ({
      name: artist.name,
      score: artist.tasteScore,
      tracks: artist.tracks,
      genres: artist.genres,
    })),
    vocabulary: {
      primary:
        "Indie dance and melodic house with tech-house rhythmic authority, Afro/organic color, and memorable pop/disco/new-wave hook inheritance.",
      priorities: [
        "A recognizable bass or melodic identity, not merely a functional loop.",
        "Interlocking syncopation between bass, percussion, vocal fragments, and tonal stabs.",
        "Eight- and sixteen-bar phrase development with subtraction, response, fills, and timbral evolution.",
        "A controlled mono low-end foundation surrounded by wider, moving mid/high layers.",
        "Contrast between sparse tension spaces and dense club-payoff sections.",
        "Organic or human source gestures processed into a psychedelic electronic frame.",
      ],
      antiPatterns: [
        "One static four-bar loop copied across the arrangement.",
        "Every layer entering on the same downbeat and sustaining continuously.",
        "A generic root-note bass with no articulation, syncopation, or call-and-response.",
        "Brightness created only by adding hats or boosting highs.",
        "Wide sub-bass, permanent full-spectrum pads, and reverb directly on low-frequency anchors.",
        "Effects added as decoration without automation, routing intent, or section function.",
      ],
    },
    audioTargets: aggregateProfiles(production.length ? production : personal),
    mazTargets: aggregateProfiles(maz),
    hookLineageTargets: aggregateProfiles(lineage),
    transcriptionTargets: aggregateTranscriptions(production.length ? production : personal),
    tutorialCapabilities: tutorials.devices.slice(0, 30).map((device) => ({
      family: device.family,
      evidenceStatus: device.evidenceStatus,
      videos: device.videos,
      windows: device.actionWindows,
      actions: device.commonActions.slice(0, 8),
      parameters: device.commonParameters.slice(0, 8),
      headlessStatus: device.capability?.headlessStatus ?? "unmapped",
    })),
    generationContract: {
      beforeWriting:
        "Retrieve at least three compatible audio references, one producer/style document, and two relevant tutorial technique documents.",
      composition:
        "Derive a new motif grammar from interval, rhythm-slot, articulation, and phrase evidence; do not copy a copyrighted melody or reuse one source as a template.",
      orchestration:
        "Use only render-proven Ableton assets/devices and hosted plugins. Prefer real presets, racks, samples, grooves, and device chains over custom DSP.",
      validation:
        "Render, extract the same reference profile, compare stem balance/contrast/groove/timbre, inspect sparse and payoff sections separately, then revise the largest audible deltas.",
    },
  };
}

function aggregateProfiles(tracks) {
  if (!tracks.length) return null;
  const fields = {
    bpm: (track) => track.profile.bpm,
    phraseCount: (track) => track.profile.phraseCount,
    crestFactorDb: (track) => track.profile.mix.crestFactorDb,
    transientDensityPerSecond: (track) => track.profile.mix.transientDensityPerSecond,
    stereoWidthDb: (track) => track.profile.mix.stereoWidthDb,
    lowBandRatio: (track) => track.profile.mix.lowBandRatio,
    midBandRatio: (track) => track.profile.mix.midBandRatio,
    highBandRatio: (track) => track.profile.mix.highBandRatio,
    syncopationRatio: (track) => track.profile.mix.syncopationRatio,
    sectionContrastDb: (track) => track.profile.relationships.sectionContrastDb,
    bassToDrumsRmsDb: (track) => track.profile.relationships.bassToDrumsRmsDb,
    otherToDrumsRmsDb: (track) => track.profile.relationships.otherToDrumsRmsDb,
    vocalsToDrumsRmsDb: (track) => track.profile.relationships.vocalsToDrumsRmsDb,
  };
  return {
    tracks: tracks.length,
    metrics: Object.fromEntries(
      Object.entries(fields).map(([name, extract]) => [name, distribution(tracks.map(extract))]),
    ),
    phraseLengths: frequency(
      tracks.flatMap((track) =>
        Object.entries(track.profile.phraseLengthHistogram).flatMap(([bars, count]) =>
          Array(Number(count)).fill(Number(bars)),
        ),
      ),
      12,
    ),
  };
}

function aggregateTranscriptions(tracks) {
  const summaries = tracks.map((track) => track.transcription).filter((item) => item.notes > 0);
  if (!summaries.length) return null;
  return {
    tracks: summaries.length,
    windows: summaries.reduce((sum, item) => sum + item.windows, 0),
    notes: summaries.reduce((sum, item) => sum + item.notes, 0),
    instruments: frequency(
      summaries.flatMap((item) =>
        item.instruments.flatMap((instrument) =>
          Array(instrument.notes).fill(instrument.instrument),
        ),
      ),
      30,
    ),
    sixteenthSlots: mergeFrequencies(summaries.map((item) => item.sixteenthSlots)),
    drumPitches: mergeFrequencies(summaries.map((item) => item.drumPitches)).slice(0, 20),
    melodicIntervals: mergeFrequencies(summaries.map((item) => item.melodicIntervals)).slice(0, 20),
  };
}

function renderTrack(track) {
  const profile = track.profile;
  const sections = profile.sections
    .map((section) => {
      const stems = Object.entries(section.stemRmsDb)
        .filter(([, value]) => value > -45)
        .map(([name]) => name)
        .join("+");
      return `| ${section.index} | ${round(section.startSeconds)} | ${section.durationBars} | ${round(section.energyZ)} | ${stems || "sparse"} | ${round(section.distanceFromPrevious)} |`;
    })
    .join("\n");
  return `# ${track.artists?.join(", ") ?? "Unknown"} — ${track.title}\n\n- Corpus: ${track.corpus}\n- Role: ${track.role}\n- Genres: ${(track.genres ?? []).join(", ")}\n- BPM/key: ${round(profile.bpm)} BPM, ${profile.key ?? "unknown"}\n- Duration: ${round(profile.durationSeconds)} seconds\n- Phrase lengths: ${JSON.stringify(profile.phraseLengthHistogram)}\n\n## Mix and groove signature\n\n- Crest factor: ${round(profile.mix.crestFactorDb)} dB\n- Dynamic range: ${round(profile.mix.dynamicRangeDb)} dB\n- Transient density: ${round(profile.mix.transientDensityPerSecond)} / second\n- Syncopation ratio: ${round(profile.mix.syncopationRatio)}\n- Stereo width: ${round(profile.mix.stereoWidthDb)} dB\n- Low/mid/high energy: ${round(profile.mix.lowBandRatio)} / ${round(profile.mix.midBandRatio)} / ${round(profile.mix.highBandRatio)}\n- Section contrast: ${round(profile.relationships.sectionContrastDb)} dB\n- Bass/drums, other/drums, vocals/drums: ${round(profile.relationships.bassToDrumsRmsDb)} / ${round(profile.relationships.otherToDrumsRmsDb)} / ${round(profile.relationships.vocalsToDrumsRmsDb)} dB\n\n## Arrangement map\n\n| Section | Seconds | Bars | Energy Z | Active stems | Change distance |\n| ---: | ---: | ---: | ---: | --- | ---: |\n${sections}\n\n## Transcribed vocabulary\n\n- Windows/notes: ${track.transcription.windows} / ${track.transcription.notes}\n- Instruments: ${track.transcription.instruments.map((item) => `${item.instrument}=${item.notes}`).join(", ") || "none"}\n- Sixteenth-slot onset counts: ${renderFrequency(track.transcription.sixteenthSlots)}\n- Drum pitches: ${renderFrequency(track.transcription.drumPitches)}\n- Melodic intervals: ${renderFrequency(track.transcription.melodicIntervals)}\n- Median pitched/drum duration: ${track.transcription.medianPitchedDurationBeats} / ${track.transcription.medianDrumDurationBeats} beats\n\nThis document is descriptive evidence. Reuse its grammar statistically; do not copy its melody.\n`;
}

function renderProducer(producer) {
  const evidence = producer.references
    .filter((reference) => reference.evidence)
    .map((reference) => {
      const profile = reference.evidence.profile;
      return `- ${reference.title}: ${round(profile.bpm)} BPM, ${profile.key}, syncopation ${round(profile.mix.syncopationRatio)}, contrast ${round(profile.relationships.sectionContrastDb)} dB, phrase histogram ${JSON.stringify(profile.phraseLengthHistogram)}.`;
    })
    .join("\n");
  return `# ${producer.name}\n\n- Spotify taste score: ${round(producer.spotify?.tasteScore ?? 0)}\n- Taste-corpus tracks: ${producer.spotify?.tracks ?? producer.references.length}\n- Genres: ${(producer.spotify?.genres ?? []).join(", ")}\n\n## Selected references\n\n${producer.references.map((reference) => `- ${reference.title} (${reference.role}; ${reference.playlists.slice(0, 4).join(", ")})`).join("\n")}\n\n## Measured evidence\n\n${evidence || "Audio evidence is queued or not locally available."}\n\nTreat this page as a retrieval anchor. Combine it with track and technique evidence before composing.\n`;
}

function renderTutorial(analysis) {
  const windows = analysis.actionWindows
    .filter((window) => window.actions.length || window.devices.length || window.parameters.length)
    .sort((left, right) => right.score - left.score)
    .slice(0, 16)
    .map(
      (window) =>
        `### ${formatTime(window.startSeconds)} — ${(window.chapter ?? "technique window").replaceAll("\n", " ")}\n\n- Devices: ${window.devices.join(", ") || "not named"}\n- Actions: ${window.actions.join(", ") || "not parsed"}\n- Parameters: ${window.parameters.join(", ") || "not parsed"}\n- [Source timestamp](${analysis.url}&t=${Math.floor(window.startSeconds)}s)\n- Evidence: ${compact(window.evidence).slice(0, 700)}`,
    )
    .join("\n\n");
  return `# ${analysis.title}\n\n- Creator: ${analysis.uploader ?? "unknown"}\n- Duration: ${round(analysis.durationSeconds / 60)} minutes\n- Categories: ${analysis.categories.join(", ")}\n- Detected devices: ${analysis.devices.join(", ")}\n- Transcript cues: ${analysis.transcript.cueCount}\n- [Original video](${analysis.url})\n\n## Grounded technique windows\n\n${windows || "No caption-backed action windows were available."}\n\nThe evidence above is noisy automatic transcription and sparse visual OCR. Verify exact settings in the source frame before treating numbers as a preset.\n`;
}

function renderTechnique(device) {
  const evidence = device.topEvidence
    .slice(0, 12)
    .map(
      (item) =>
        `- [${item.title} at ${formatTime(item.startSeconds)}](${item.timestampUrl}) — actions: ${item.actions.join(", ")}; parameters: ${item.parameters.join(", ")}; evidence: ${compact(item.evidence).slice(0, 420)}`,
    )
    .join("\n");
  return `# ${device.family}\n\n- Tutorial evidence: ${device.evidenceStatus}\n- Videos/windows: ${device.videos} / ${device.actionWindows}\n- Headless status: ${device.capability?.headlessStatus ?? "unmapped"}\n- Engine status: ${device.capability?.engineStatus ?? "unmapped"}\n- Common actions: ${device.commonActions
    .slice(0, 12)
    .map((item) => `${item.name}=${item.count}`)
    .join(", ")}\n- Common parameters: ${device.commonParameters
    .slice(0, 16)
    .map((item) => `${item.name}=${item.count}`)
    .join(
      ", ",
    )}\n\n## Timestamped evidence\n\n${evidence || "No high-quality action window yet."}\n\nUse only when the device or preset path is render-proven. Exact values remain candidates until an audible fixture passes.\n`;
}

function renderTasteModel(model) {
  return `# Personal house taste model\n\n${model.vocabulary.primary}\n\n## Evidence status\n\n- Personal references analyzed: ${model.status.analyzedPersonalReferences}/${model.status.requestedReferences}\n- Maz references analyzed: ${model.status.analyzedMazReferences}\n- Focused tutorial evidence: ${model.status.tutorialVideos} videos, ${model.status.tutorialHours} hours, ${model.status.tutorialActionWindows} timestamped windows\n\n## Priorities\n\n${model.vocabulary.priorities.map((item) => `- ${item}`).join("\n")}\n\n## Reject these failure modes\n\n${model.vocabulary.antiPatterns.map((item) => `- ${item}`).join("\n")}\n\n## Main taste anchors\n\n${model.tasteAnchors.map((artist) => `- ${artist.name}: score ${round(artist.score)}; ${artist.genres.join(", ")}`).join("\n")}\n\n## Measured production targets\n\n${renderAggregate(model.audioTargets)}\n\n## Maz/Afro reference targets\n\n${renderAggregate(model.mazTargets)}\n\n## Generation contract\n\n- Before writing: ${model.generationContract.beforeWriting}\n- Composition: ${model.generationContract.composition}\n- Orchestration: ${model.generationContract.orchestration}\n- Validation: ${model.generationContract.validation}\n`;
}

function renderWorkflow(model) {
  return `# Evidence-to-track workflow\n\n1. Query by intended lane, role, energy, and sonic problem; retrieve compatible track, producer, and tutorial documents.\n2. Select a three-to-five track reference panel: groove, bass articulation, hook grammar, arrangement contrast, and spatial/mix depth can come from different references.\n3. Build MIDI grammar from measured onset slots, note lengths, interval tendencies, phrase lengths, and stem-entry maps. Do not trace one copyrighted melody.\n4. Orchestrate only through real Ableton assets/devices and hosted plugins whose headless path is proven. Use real racks, presets, grooves, samples, sends, and automation.\n5. Require evolving parts: motif variation, counterline, percussion answers, fills, ear candy, filtered or resampled variants, and section-specific effect states.\n6. Render and extract the same profile used for references. Compare section contrast, stem ratios, syncopation, spectrum, transient density, width, and MIDI density.\n7. Revise the largest audible deltas, then audition the whole arrangement and focused payoff/breakdown excerpts.\n\nCurrent evidence: ${model.status.analyzedPersonalReferences + model.status.analyzedMazReferences} analyzed tracks and ${model.status.tutorialActionWindows} tutorial windows.\n`;
}

function renderPrinciples(model) {
  return `# Cross-source house production principles\n\nThese are operational conclusions triangulated from focused tutorials and measured reference audio. Source timestamps support the technique; reference profiles supply calibration.\n\n## Identity comes from small moving differences\n\nDo not ask one static preset to sound expensive. Establish a solid main bass or riff, then add one quieter identity layer whose movement differs: acid edge, resonant filter motion, fine-pitch vibrato, random sample start, or a narrow-band distorted duplicate. The Maccabi-house tutorials repeatedly describe subtle modulation and filtering as the difference between a generic patch and the signature.\n\n- [Acid layer plus LFO modulation](https://www.youtube.com/watch?v=ktPQjgMMBP4&t=217s)\n- [Fine-pitch LFO and resonant filtering](https://www.youtube.com/watch?v=ktPQjgMMBP4&t=161s)\n- [Randomized Simpler start creates memorable vocal glitches](https://www.youtube.com/watch?v=BiqQfA26wXQ&t=1354s)\n\n## Repetition belongs in rhythm; variation belongs in pitch, timbre, and response\n\nA recognizable rhythmic cell can repeat while notes, velocity, cutoff, octave, or the answering part changes. This preserves hypnosis without becoming a copied four-bar loop. Semitone tension is useful as a controlled color, not a permanent harmonic pile-up.\n\n- [Repeat the rhythmic cell while changing notes](https://www.youtube.com/watch?v=ktPQjgMMBP4&t=140s)\n- [Semitone motion for dissonant hypnotic tension](https://www.youtube.com/watch?v=ktPQjgMMBP4&t=110s)\n- [Raise octave and vibrato toward the drop](https://www.youtube.com/watch?v=LHY-oarzk-g&t=1287s)\n\n## Groove is an interlock, not a drum loop\n\nKick, bass, toms, congas, shaker, hats, vocal cuts, and tonal stabs should occupy complementary onset slots. Build percussion in context, place toms on offbeats, reinforce body and attack with separate layers, and let live loops introduce microtiming. The track documents expose measured sixteenth-slot distributions.\n\n- [Strategic offbeat tom placement](https://www.youtube.com/watch?v=ktPQjgMMBP4&t=576s)\n- [Layer tom body with a fast attack and add congas/shaker](https://www.youtube.com/watch?v=ktPQjgMMBP4&t=632s)\n- [Acoustic/live hats create groove and disco feel around a soft kick](https://www.youtube.com/watch?v=LHY-oarzk-g&t=129s)\n\n## Add drive with a second rhythmic engine\n\nWhen the bassline is groovy rather than propulsive, a separate sequence, ostinato, or filtered percussion line can supply forward motion. Do not force the bass to perform sub foundation, hook, and constant drive simultaneously.\n\n- [Sequence supplies drive while bass remains groovy](https://www.youtube.com/watch?v=LHY-oarzk-g&t=677s)\n- [Resample, slice, and quantize exploratory material](https://www.youtube.com/watch?v=BLvk4yIbxCw&t=320s)\n\n## Keep transients short, intentional, and layered by function\n\nFor dense indie-dance percussion, shorten clap sustain and release to keep the useful click, layer body separately, saturate for harmonics, and clip peaks while compensating output. This creates apparent size without long tails masking the groove.\n\n- [Tight clap layers by reducing sustain and release](https://www.youtube.com/watch?v=BiqQfA26wXQ&t=273s)\n- [Saturator clipping macro raises drive while lowering output](https://www.youtube.com/watch?v=BiqQfA26wXQ&t=314s)\n- [Low-body layer plus transient layers](https://www.youtube.com/watch?v=BiqQfA26wXQ&t=650s)\n\n## Protect the low-end hierarchy\n\nThe kick is usually the dominant anchor, bass sits just below it, sub remains mono, and other percussive or harmonic layers are filtered and arranged around them. Use frequency-limited sidechain where available instead of making the whole sound disappear. The measured profiles quantify bass-to-drums balance per reference.\n\n- [Mono bass with distortion, chorus, and ping-pong color](https://www.youtube.com/watch?v=ktPQjgMMBP4&t=505s)\n- [Low-cut copied bass layers to avoid collision](https://www.youtube.com/watch?v=ktPQjgMMBP4&t=342s)\n- [Sidechain only below roughly 358 Hz in one layered riff](https://www.youtube.com/watch?v=BiqQfA26wXQ&t=910s)\n- [Kick first, bass below, percussion around the low end](https://www.youtube.com/watch?v=BLvk4yIbxCw&t=959s)\n\n## Depth uses several short and long jobs\n\nUse short slap or 1/16 ping-pong for thickness and motion, short room for cohesion, and long delay/reverb returns for selected transitions and breakdown events. Filter effect returns and duck harsh highs. Avoid one permanent wash across every section.\n\n- [Short ping-pong, modest reverb, and filtered highs](https://www.youtube.com/watch?v=LHY-oarzk-g&t=928s)\n- [Short slap, mid-focused distortion, downsampling, and a little reverb](https://www.youtube.com/watch?v=ktPQjgMMBP4&t=410s)\n- [Automated sends turn one source into crash/sweep transitions](https://www.youtube.com/watch?v=BiqQfA26wXQ&t=1552s)\n\n## Arrange in contrasting eight- and sixteen-bar states\n\nThe strongest references overwhelmingly use eight- and sixteen-bar phrases, but phrase boundaries alone are not arrangement. Each state needs a clear change in active stems, register, motif answer, automation, or space. Build a sparse tension state and a dense payoff state; do not merely mute the kick for four bars.\n\n- [Two eight-bar states differentiated by filter and vocal delay](https://www.youtube.com/watch?v=BLvk4yIbxCw&t=917s)\n- Current production phrase targets: ${model.audioTargets ? renderFrequency(model.audioTargets.phraseLengths) : "analysis pending"}\n- Maz phrase targets: ${model.mazTargets ? renderFrequency(model.mazTargets.phraseLengths) : "analysis pending"}\n\n## Temporary sounds are compositional tools\n\nA vocal, synth take, or texture can help discover the groove and then be replaced. Record uncertain performance, slice useful gestures, resample processing, and retain only what advances the track. This is how programmatic production escapes one-MIDI-pattern-plus-one-preset writing.\n\n- [Record unfamiliar synth exploration, then select fragments](https://www.youtube.com/watch?v=BLvk4yIbxCw&t=110s)\n- [Use a temporary vocal to build the groove, then delete it](https://www.youtube.com/watch?v=BLvk4yIbxCw&t=537s)\n\n## Validate sections, not only whole-track averages\n\nA candidate passes only if sparse and payoff sections separately resemble the selected reference panel in active stems, low-end ratio, transient density, width, and contrast. Whole-track similarity can hide a weak drop or overcrowded breakdown.\n`;
}

function renderReadme(model) {
  return `# House taste knowledge base\n\nA compact, queryable synthesis of personal Spotify selection, local Rekordbox audio, stem-separated reference profiles, MuScriptor MIDI evidence, focused YouTube production tutorials, and the headless Ableton capability map.\n\n## Contents\n\n- [Taste model](documents/taste-model.md)\n- [Cross-source production principles](documents/production-principles.md)\n- [Evidence-to-track workflow](documents/workflow.md)\n- Track evidence: ${model.status.analyzedPersonalReferences + model.status.analyzedMazReferences} documents\n- Producer anchors: generated from the selected reference panel\n- Tutorial evidence: ${model.status.tutorialVideos} documents\n- Technique/device evidence: ${model.tutorialCapabilities.length}+ indexed families\n\nRegenerate with:\n\n\`\`\`sh\nnode examples/production/build-house-taste-knowledge-base.mjs\n\`\`\`\n`;
}

function renderAggregate(target) {
  if (!target) return "No completed evidence yet.";
  return Object.entries(target.metrics)
    .map(
      ([name, values]) => `- ${name}: median ${values.median}, p25–p75 ${values.p25}–${values.p75}`,
    )
    .join("\n");
}

async function readDirectoryJson(root, filename) {
  const entries = await readdir(root, { withFileTypes: true });
  const values = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, filename);
    if (await exists(file)) values.push(await readJson(file));
  }
  return values;
}

function distribution(values) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  return {
    min: round(finite[0]),
    p25: round(quantile(finite, 0.25)),
    median: round(quantile(finite, 0.5)),
    p75: round(quantile(finite, 0.75)),
    max: round(finite.at(-1)),
    mean: round(finite.reduce((sum, value) => sum + value, 0) / finite.length),
  };
}

function quantile(values, proportion) {
  if (!values.length) return null;
  const position = (values.length - 1) * proportion;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return values[lower + 1] === undefined
    ? values[lower]
    : values[lower] + fraction * (values[lower + 1] - values[lower]);
}

function intervalFrequency(notes) {
  const byInstrument = groupBy(notes, (note) => note.instrument);
  const intervals = [];
  for (const instrumentNotes of byInstrument.values()) {
    const ordered = instrumentNotes.toSorted((left, right) => left.onsetBeats - right.onsetBeats);
    for (let index = 1; index < ordered.length; index += 1) {
      const interval = ordered[index].pitch - ordered[index - 1].pitch;
      if (Math.abs(interval) <= 24) intervals.push(interval);
    }
  }
  return frequency(intervals, 20);
}

function frequency(values, limit) {
  const counts = new Map();
  for (const value of values) counts.set(String(value), (counts.get(String(value)) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
    .slice(0, limit);
}

function mergeFrequencies(items) {
  return frequency(
    items.flatMap((item) => item.flatMap(({ value, count }) => Array(count).fill(value))),
    100,
  );
}

function renderFrequency(items) {
  return items.map(({ value, count }) => `${value}=${count}`).join(", ") || "none";
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

function median(values) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  return quantile(finite, 0.5);
}

function compact(value) {
  let words = String(value).replaceAll(/\s+/g, " ").trim().split(" ");
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let size = Math.min(40, Math.floor(words.length / 2)); size >= 3; size -= 1) {
      for (let index = 0; index + size * 2 <= words.length; index += 1) {
        const first = words
          .slice(index, index + size)
          .join(" ")
          .toLowerCase();
        const second = words
          .slice(index + size, index + size * 2)
          .join(" ")
          .toLowerCase();
        if (first !== second) continue;
        words = [...words.slice(0, index + size), ...words.slice(index + size * 2)];
        changed = true;
        break outer;
      }
    }
  }
  return words.join(" ");
}

function normalize(value) {
  return String(value)
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function slug(value) {
  return normalize(value)
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 96);
}

function titleCase(value) {
  return String(value)
    .replaceAll("-", " ")
    .replaceAll(/\b\w/g, (match) => match.toUpperCase());
}

function inferArtistsFromAudio(audio) {
  const basename = path.basename(audio, path.extname(audio));
  const prefix = basename.split(" - ")[0];
  return prefix
    .split(", ")
    .map((artist) => artist.trim())
    .filter(Boolean);
}

function formatTime(seconds) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 1_000) / 1_000 : null;
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

async function exists(filename) {
  try {
    await stat(filename);
    return true;
  } catch {
    return false;
  }
}
