import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { downloadMedia, ExtractorRegistry } from "../../packages/ytdlp-ts/dist/index.js";

const { values } = parseArgs({
  options: {
    corpus: { type: "string", default: "examples/production/ableton-tutorial-corpus.json" },
    "output-dir": {
      type: "string",
      default: "/Users/gakonst/Library/Caches/djbooth/ableton-tutorial-videos",
    },
    limit: { type: "string", default: "25" },
    jobs: { type: "string", default: "2" },
    "max-frames": { type: "string", default: "24" },
    "video-height": { type: "string", default: "720" },
    ids: { type: "string" },
    force: { type: "boolean", default: false },
    "keep-video": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
  strict: true,
});

const corpusPath = path.resolve(values.corpus);
const outputDir = path.resolve(values["output-dir"]);
const limit = positiveInteger(values.limit, "limit");
const jobs = positiveInteger(values.jobs, "jobs");
const maxFrames = positiveInteger(values["max-frames"], "max-frames");
const videoHeight = positiveInteger(values["video-height"], "video-height");
const requestedIds = new Set(
  (values.ids ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const nativeExtractor = new ExtractorRegistry();

let hasTesseract = false;

async function main() {
  await requireCommand("yt-dlp");
  await requireCommand("ffmpeg");
  hasTesseract = await commandExists("tesseract");
  const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
  const ranked = rankCandidates(corpus);
  const candidates =
    requestedIds.size > 0
      ? ranked.filter((candidate) => requestedIds.has(candidate.id)).slice(0, limit)
      : diversifyCandidates(ranked, limit);

  if (values["dry-run"]) {
    console.log(
      JSON.stringify(
        {
          corpus: corpusPath,
          outputDir,
          selected: candidates.map(candidateSummary),
        },
        null,
        2,
      ),
    );
    return;
  }

  await mkdir(path.join(outputDir, "videos"), { recursive: true });
  const startedAt = new Date().toISOString();
  const results = await mapConcurrent(candidates, jobs, async (candidate, index) => {
    const prefix = `[${index + 1}/${candidates.length} ${candidate.id}]`;
    try {
      const result = await ingestVideo(candidate, prefix);
      process.stderr.write(`${prefix} ${result.status}\n`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!values["keep-video"]) await cleanupVisual(candidate.id);
      process.stderr.write(`${prefix} failed: ${message}\n`);
      return { id: candidate.id, title: candidate.title, status: "failed", error: message };
    }
  });

  const index = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    startedAt,
    corpus: corpusPath,
    policy: {
      retained: [
        "source metadata and chapters",
        "available English creator or automatic captions",
        "time-addressable action windows",
        "targeted low-resolution UI frames and OCR",
      ],
      ephemeral:
        "low-resolution source video is deleted after frame extraction unless --keep-video is set",
      synthesis:
        "analysis files preserve evidence; tutorial recipes should paraphrase rather than copy source narration",
    },
    settings: { limit, jobs, maxFrames, videoHeight, keepVideo: values["keep-video"] },
    counts: {
      selected: results.length,
      ingested: results.filter((result) => result.status === "ingested").length,
      cached: results.filter((result) => result.status === "cached").length,
      failed: results.filter((result) => result.status === "failed").length,
      withTranscript: results.filter((result) => result.transcript?.cueCount > 0).length,
      needsAsr: results.filter((result) => result.transcript?.needsAsr).length,
      frames: results.reduce((sum, result) => sum + (result.frames ?? 0), 0),
    },
    videos: results,
  };
  await writeJson(path.join(outputDir, "index.json"), index);
  console.log(
    JSON.stringify({ output: path.join(outputDir, "index.json"), ...index.counts }, null, 2),
  );
}

async function ingestVideo(candidate, prefix) {
  const videoDir = path.join(outputDir, "videos", candidate.id);
  const analysisPath = path.join(videoDir, "analysis.json");
  if (!values.force && (await isFile(analysisPath))) {
    const analysis = JSON.parse(await readFile(analysisPath, "utf8"));
    return resultFromAnalysis(analysis, "cached");
  }

  await mkdir(path.join(videoDir, "frames"), { recursive: true });
  process.stderr.write(`${prefix} metadata + captions + visual source\n`);
  const prepared = await prepareTutorialSource(candidate, videoDir);
  const { info, videoPath } = prepared;
  const transcriptPath = await preferredTranscript(videoDir);
  const cues = transcriptPath ? parseVtt(await readFile(transcriptPath, "utf8")) : [];
  const chapters = Array.isArray(info.chapters)
    ? info.chapters.map((chapter, index) => ({
        index,
        title: chapter.title ?? `Chapter ${index + 1}`,
        startSeconds: finiteNumber(chapter.start_time, 0),
        endSeconds: finiteNumber(chapter.end_time, finiteNumber(info.duration, 0)),
      }))
    : [];
  const actionWindows = buildActionWindows(cues, chapters, finiteNumber(info.duration, 0));

  process.stderr.write(`${prefix} frame + OCR pass (${prepared.engine})\n`);
  const frameTargets = chooseFrameTargets(
    actionWindows,
    chapters,
    finiteNumber(info.duration, 0),
    maxFrames,
  );
  const frames = await mapConcurrent(frameTargets, Math.min(4, jobs * 2), async (target, index) => {
    const filename = `frame-${String(index + 1).padStart(3, "0")}-${formatTimestamp(target.seconds)}.jpg`;
    const framePath = path.join(videoDir, "frames", filename);
    await run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      target.seconds.toFixed(3),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-vf",
      "scale=min(1280\\,iw):-2",
      "-q:v",
      "3",
      "-y",
      framePath,
    ]);
    const ocr = hasTesseract
      ? cleanOcr(await runCapture("tesseract", [framePath, "stdout", "--psm", "11"], true))
      : "";
    return { ...target, file: path.relative(videoDir, framePath), ocr };
  });

  const deviceEvidence = inferDevices(
    [
      candidate.title,
      info.description ?? "",
      ...cues.map((cue) => cue.text),
      ...frames.map((frame) => frame.ocr),
    ].join(" "),
  );
  const analysis = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    id: candidate.id,
    url: candidate.url,
    title: info.title ?? candidate.title,
    uploader: info.uploader ?? candidate.uploader ?? null,
    durationSeconds: finiteNumber(info.duration, candidate.durationSeconds ?? 0),
    score: candidate.score,
    extractionEngine: prepared.engine,
    sourceContexts: candidate.sourceContexts,
    categories: [
      ...new Set([
        ...candidate.categories,
        ...inferCategories(cues.map((cue) => cue.text).join(" ")),
      ]),
    ],
    devices: deviceEvidence,
    chapters,
    transcript: {
      file: transcriptPath ? path.relative(videoDir, transcriptPath) : null,
      cueCount: cues.length,
      coverageSeconds: cueCoverage(cues),
      needsAsr: cues.length === 0,
    },
    actionWindows: actionWindows.map((window) => ({
      ...window,
      nearestFrame: nearestFrame(window.startSeconds, frames)?.file ?? null,
    })),
    frames,
    understanding: {
      evidenceReady: cues.length > 0 && frames.length > 0,
      nextStep:
        "Convert action windows plus frame OCR into paraphrased device/parameter/routing recipes, then render dry/wet fixtures.",
    },
  };
  await writeJson(analysisPath, analysis);
  if (!values["keep-video"]) await rm(videoPath, { force: true });
  return resultFromAnalysis(analysis, "ingested");
}

async function prepareTutorialSource(candidate, videoDir) {
  await removeVisualFiles(videoDir);
  try {
    const info = await nativeExtractor.extract(candidate.url);
    const result = await downloadMedia(info, {
      format: `bestvideo[height<=${videoHeight}][ext=mp4]/bestvideo[height<=${videoHeight}]`,
      output: "visual.%(ext)s",
      paths: videoDir,
      retries: 3,
      writeSubtitles: true,
      writeAutoSubtitles: true,
      subtitleLanguages: ["en*"],
      subtitleFormat: "vtt",
      writeThumbnail: true,
      writeInfoJson: true,
    });
    if (info.description)
      await writeFile(path.join(videoDir, "source.description"), info.description);
    const videoPath = result.files.find(isVisualMediaPath);
    if (!videoPath) throw new Error("native downloader did not produce a visual stream");
    return { info, videoPath, engine: "ytdlp-ts-native" };
  } catch (nativeError) {
    await removeVisualFiles(videoDir);
    process.stderr.write(
      `[${candidate.id}] native extractor fallback: ${errorMessage(nativeError).slice(-500)}\n`,
    );
  }

  await run("yt-dlp", [
    "--ignore-config",
    "--no-playlist",
    "--sleep-requests",
    "1",
    "--sleep-subtitles",
    "1",
    "--skip-download",
    "--write-info-json",
    "--write-description",
    "--write-thumbnail",
    "--convert-thumbnails",
    "jpg",
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs",
    "en.*,en",
    "--sub-format",
    "vtt",
    "--retries",
    "3",
    "--output",
    path.join(videoDir, "source.%(ext)s"),
    candidate.url,
  ]);
  const info = JSON.parse(await readFile(path.join(videoDir, "source.info.json"), "utf8"));
  const videoPath = await downloadVisualSource(candidate.url, videoDir);
  return { info, videoPath, engine: "yt-dlp-reference" };
}

async function downloadVisualSource(url, videoDir) {
  const attempts = [
    [],
    ["--extractor-args", "youtube:player_client=android_vr"],
    ["--extractor-args", "youtube:player_client=web_safari"],
  ];
  const failures = [];
  for (const extractorArgs of attempts) {
    await removeVisualFiles(videoDir);
    try {
      await run("yt-dlp", [
        "--ignore-config",
        "--no-playlist",
        "--sleep-requests",
        "1",
        "--sleep-interval",
        "2",
        "--max-sleep-interval",
        "5",
        ...extractorArgs,
        "--format",
        `bv*[height<=${videoHeight}][ext=mp4]/bv*[height<=${videoHeight}]/worstvideo`,
        "--retries",
        "3",
        "--fragment-retries",
        "3",
        "--output",
        path.join(videoDir, "visual.%(ext)s"),
        url,
      ]);
      const files = await readdir(videoDir);
      const visual = files.find((file) => /^visual\.[^.]+$/u.test(file));
      if (visual) return path.join(videoDir, visual);
      failures.push("yt-dlp completed without a visual stream");
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`all visual download strategies failed: ${failures.join(" | ").slice(-4_000)}`);
}

async function cleanupVisual(id) {
  const videoDir = path.join(outputDir, "videos", id);
  try {
    await removeVisualFiles(videoDir);
  } catch {
    // The video directory may not have been created yet.
  }
}

async function removeVisualFiles(videoDir) {
  const files = await readdir(videoDir);
  await Promise.all(
    files
      .filter((file) => isVisualMediaPath(file))
      .map((file) => rm(path.join(videoDir, file), { force: true })),
  );
}

function isVisualMediaPath(filename) {
  return /^visual\.(?:mp4|m4v|mov|mkv|webm|avi|part)(?:\.part)?$/iu.test(path.basename(filename));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function rankCandidates(corpus) {
  const houseProductionCorpus = corpus.focus === "house-production";
  const byId = new Map();
  for (const video of corpus.youtubeTutorialCandidates ?? []) {
    byId.set(video.id, {
      id: video.id,
      url: video.url,
      title: video.title,
      uploader: video.uploader ?? null,
      durationSeconds: video.durationSeconds ?? 0,
      priority: video.priority ?? 0,
      categories: video.categories ?? [],
      devices: (video.devices ?? []).map((device) => device.family),
      queries: video.queries ?? [],
      sourceContexts: [],
    });
  }
  for (const article of corpus.prioritizedOfficial ?? []) {
    for (const media of article.media ?? []) {
      if (media.kind !== "youtube") continue;
      const candidate = byId.get(media.id) ?? {
        id: media.id,
        url: media.url,
        title: article.title,
        uploader: "Ableton-linked",
        durationSeconds: 0,
        priority: 0,
        categories: [],
        devices: [],
        queries: [],
        sourceContexts: [],
      };
      candidate.categories.push(...(article.categories ?? []));
      candidate.devices.push(...(article.devices ?? []).map((device) => device.family));
      candidate.sourceContexts.push({
        kind: "officialAbletonArticle",
        title: article.title,
        url: article.url,
        priority: article.priority ?? 0,
      });
      byId.set(media.id, candidate);
    }
  }
  return [...byId.values()]
    .map((candidate) => ({
      ...candidate,
      categories: [...new Set(candidate.categories)],
      devices: [...new Set(candidate.devices)],
      score: candidateScore(candidate),
    }))
    .filter(
      (candidate) =>
        houseProductionCorpus ||
        !/\bserum\b/iu.test(`${candidate.title} ${candidate.queries.join(" ")}`),
    )
    .filter((candidate) => {
      const text = `${candidate.title} ${candidate.uploader ?? ""} ${candidate.queries.join(" ")}`;
      if (houseProductionCorpus) {
        return /ableton|house|indie dance|melodic|techno|producer|production|track|groove|sound design/iu.test(
          text,
        );
      }
      return (
        candidate.sourceContexts.length > 0 ||
        /ableton|seed to stage|ned rush|underdog|underbelly|mr\.? bill|xnb/iu.test(text)
      );
    })
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

function candidateScore(candidate) {
  const text =
    `${candidate.title} ${candidate.queries.join(" ")} ${candidate.uploader ?? ""}`.toLowerCase();
  const preferredUploaders = [
    "seed to stage",
    "ned rush",
    "ableton",
    "underdog",
    "production music live",
    "ableton tips",
    "mr. bill",
    "xnb",
    "audioreakt",
    "bound to divide",
    "dilby",
    "dj mag",
    "ethan davis",
    "faderpro",
    "the producer school",
  ];
  let score = candidate.priority ?? 0;
  score += Math.max(0, ...candidate.sourceContexts.map((context) => context.priority ?? 0)) * 4;
  score += candidate.sourceContexts.length * 12;
  score += candidate.devices.length * 5;
  score += candidate.categories.length * 2;
  if (text.includes("ableton")) score += 8;
  if (preferredUploaders.some((uploader) => text.includes(uploader))) score += 12;
  if (/tutorial|sound design|from scratch|track|mix|rack|device/iu.test(text)) score += 4;
  if (candidate.durationSeconds >= 300 && candidate.durationSeconds <= 5_400) score += 4;
  return score;
}

function diversifyCandidates(candidates, count) {
  const selected = [];
  const contextCounts = new Map();
  const uploaderCounts = new Map();
  for (const candidate of candidates) {
    const contextKeys = candidate.sourceContexts.map((context) => context.title ?? context.url);
    const uploaderKey = candidate.uploader ?? "unknown";
    const contextSaturated =
      contextKeys.length > 0 && contextKeys.every((key) => (contextCounts.get(key) ?? 0) >= 2);
    const uploaderLimit = uploaderKey === "Ableton-linked" ? 18 : 8;
    if (contextSaturated || (uploaderCounts.get(uploaderKey) ?? 0) >= uploaderLimit) continue;
    selected.push(candidate);
    for (const key of contextKeys) contextCounts.set(key, (contextCounts.get(key) ?? 0) + 1);
    uploaderCounts.set(uploaderKey, (uploaderCounts.get(uploaderKey) ?? 0) + 1);
    if (selected.length >= count) break;
  }
  return selected;
}

function buildActionWindows(cues, chapters, durationSeconds) {
  const scored = cues
    .map((cue) => ({ ...cue, score: actionScore(cue.text) }))
    .filter((cue) => cue.score > 0)
    .sort((left, right) => right.score - left.score);
  const selected = [];
  for (const cue of scored) {
    if (selected.some((other) => Math.abs(other.startSeconds - cue.startSeconds) < 12)) continue;
    const neighboring = cues.filter(
      (other) =>
        other.startSeconds >= cue.startSeconds - 8 && other.startSeconds <= cue.endSeconds + 12,
    );
    const text = neighboring
      .map((other) => other.text)
      .join(" ")
      .replace(/\s+/gu, " ")
      .trim();
    selected.push({
      startSeconds: Math.max(0, cue.startSeconds - 4),
      endSeconds: Math.min(durationSeconds || cue.endSeconds + 12, cue.endSeconds + 12),
      score: cue.score,
      chapter: chapterAt(chapters, cue.startSeconds)?.title ?? null,
      evidence: text,
      devices: inferDevices(text),
      actions: inferActions(text),
      parameters: inferParameters(text),
    });
    if (selected.length >= Math.max(maxFrames * 2, 32)) break;
  }
  return selected.sort((left, right) => left.startSeconds - right.startSeconds);
}

function chooseFrameTargets(actionWindows, chapters, durationSeconds, count) {
  const candidates = [
    ...chapters.map((chapter) => ({
      seconds: chapter.startSeconds + 1,
      reason: "chapter",
      chapter: chapter.title,
    })),
    ...actionWindows
      .toSorted((left, right) => right.score - left.score)
      .map((window) => ({
        seconds: window.startSeconds + Math.min(6, (window.endSeconds - window.startSeconds) / 2),
        reason: "action",
        chapter: window.chapter,
      })),
  ];
  const uniformCount = Math.min(8, count);
  for (let index = 0; index < uniformCount; index += 1) {
    candidates.push({
      seconds: durationSeconds > 0 ? ((index + 0.5) / uniformCount) * durationSeconds : index * 30,
      reason: "coverage",
      chapter: null,
    });
  }
  const selected = [];
  for (const candidate of candidates) {
    const seconds = Math.max(0, Math.min(Math.max(0, durationSeconds - 0.5), candidate.seconds));
    if (selected.some((other) => Math.abs(other.seconds - seconds) < 6)) continue;
    selected.push({ ...candidate, seconds });
    if (selected.length >= count) break;
  }
  return selected.sort((left, right) => left.seconds - right.seconds);
}

function parseVtt(vtt) {
  const cues = [];
  const blocks = vtt.replaceAll("\r\n", "\n").split(/\n{2,}/u);
  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes(" --> "));
    if (timingIndex < 0) continue;
    const [start, endWithSettings] = lines[timingIndex].split(" --> ");
    const text = [...new Set(lines.slice(timingIndex + 1).map(stripVttMarkup))]
      .join(" ")
      .replace(/\s+/gu, " ")
      .trim();
    if (!text) continue;
    cues.push({
      startSeconds: parseTimestamp(start),
      endSeconds: parseTimestamp(endWithSettings.split(/\s+/u)[0]),
      text,
    });
  }
  return dedupeRollingCues(cues);
}

function dedupeRollingCues(cues) {
  const output = [];
  for (const cue of cues) {
    const prior = output.at(-1);
    if (prior && prior.text === cue.text)
      prior.endSeconds = Math.max(prior.endSeconds, cue.endSeconds);
    else output.push(cue);
  }
  return output;
}

function stripVttMarkup(value) {
  return value
    .replace(/<\d\d:\d\d:\d\d\.\d+>/gu, "")
    .replace(/<[^>]+>/gu, "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&nbsp;", " ")
    .trim();
}

function actionScore(text) {
  const normalized = text.toLowerCase();
  return (
    inferDevices(text).length * 4 +
    actionWords.filter((word) => normalized.includes(word)).length * 2 +
    parameterWords.filter((word) => normalized.includes(word)).length * 2 +
    (/\b\d+(?:\.\d+)?\s*(?:hz|khz|db|ms|%|semitone|octave|bar|beat)s?\b/iu.test(text) ? 4 : 0)
  );
}

const deviceAliases = [
  ["auto filter", "AutoFilter"],
  ["auto pan", "AutoPan"],
  ["auto shift", "AutoShift"],
  ["beat repeat", "BeatRepeat"],
  ["channel eq", "ChannelEq"],
  ["chorus", "Chorus2"],
  ["collision", "Collision"],
  ["compressor", "Compressor2"],
  ["corpus", "Corpus"],
  ["drift", "Drift"],
  ["drum buss", "DrumBuss"],
  ["drum rack", "DrumGroupDevice"],
  ["drum sampler", "DrumCell"],
  ["dynamic tube", "Tube"],
  ["echo", "Echo"],
  ["electric", "LoungeLizard"],
  ["eq eight", "Eq8"],
  ["eq8", "Eq8"],
  ["erosion", "Erosion"],
  ["filter delay", "FilterDelay"],
  ["frequency shifter", "FrequencyShifter"],
  ["gate", "Gate"],
  ["glue compressor", "GlueCompressor"],
  ["grain delay", "GrainDelay"],
  ["hybrid reverb", "Hybrid"],
  ["impulse", "InstrumentImpulse"],
  ["limiter", "Limiter"],
  ["looper", "Looper"],
  ["meld", "InstrumentMeld"],
  ["multiband dynamics", "MultibandDynamics"],
  ["operator", "Operator"],
  ["overdrive", "Overdrive"],
  ["pedal", "Pedal"],
  ["phaser", "PhaserNew"],
  ["redux", "Redux2"],
  ["resonator", "Resonator"],
  ["reverb", "Reverb"],
  ["roar", "Roar"],
  ["saturator", "Saturator"],
  ["simpler", "OriginalSimpler"],
  ["sampler", "MultiSampler"],
  ["shifter", "Shifter"],
  ["tension", "StringStudio"],
  ["utility", "StereoGain"],
  ["vinyl distortion", "Vinyl"],
  ["vocoder", "Vocoder"],
  ["wavetable", "InstrumentVector"],
  ["analog", "UltraAnalog"],
  ["audio effect rack", "AudioEffectGroupDevice"],
  ["instrument rack", "InstrumentGroupDevice"],
];

const actionWords = [
  "add",
  "adjust",
  "automate",
  "boost",
  "change",
  "compress",
  "create",
  "cut",
  "duplicate",
  "filter",
  "group",
  "increase",
  "layer",
  "lower",
  "map",
  "modulate",
  "reduce",
  "route",
  "saturate",
  "select",
  "set",
  "sidechain",
  "turn",
  "use",
  "widen",
];
const parameterWords = [
  "attack",
  "decay",
  "release",
  "sustain",
  "cutoff",
  "resonance",
  "drive",
  "feedback",
  "gain",
  "frequency",
  "threshold",
  "ratio",
  "mix",
  "dry wet",
  "width",
  "rate",
  "depth",
  "amount",
  "transpose",
  "detune",
  "velocity",
  "chain",
  "send",
  "return",
  "macro",
  "lfo",
  "envelope",
];

function inferDevices(text) {
  const normalized = ` ${text.toLowerCase().replace(/[^a-z0-9]+/gu, " ")} `;
  return [
    ...new Set(
      deviceAliases
        .filter(([alias]) => normalized.includes(` ${alias} `))
        .map(([, family]) => family),
    ),
  ];
}

function inferActions(text) {
  const normalized = text.toLowerCase();
  return actionWords.filter((word) => normalized.includes(word));
}

function inferParameters(text) {
  const normalized = text.toLowerCase();
  const named = parameterWords.filter((word) => normalized.includes(word));
  const values = [
    ...text.matchAll(/\b\d+(?:\.\d+)?\s*(?:hz|khz|db|ms|%|semitone|octave|bar|beat)s?\b/giu),
  ].map((match) => match[0]);
  return [...new Set([...named, ...values])];
}

function inferCategories(text) {
  const normalized = text.toLowerCase();
  const categories = {
    bass: ["bass", "sub", "808"],
    drums: ["drum", "kick", "snare", "hat", "percussion"],
    dynamics: ["compress", "limiter", "sidechain", "transient"],
    groove: ["groove", "swing", "rhythm", "sequenc"],
    harmony: ["chord", "harmony", "melody", "arp"],
    mixing: ["mix", "eq", "balance", "stereo", "master"],
    routing: ["rack", "route", "send", "return", "parallel", "chain"],
    soundDesign: ["sound design", "synthesis", "oscillator", "timbre", "modulat"],
    spatial: ["reverb", "delay", "space", "ambience", "width"],
  };
  return Object.entries(categories)
    .filter(([, words]) => words.some((word) => normalized.includes(word)))
    .map(([category]) => category);
}

async function preferredTranscript(directory) {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".vtt"));
  const ranked = files.toSorted((left, right) => transcriptRank(left) - transcriptRank(right));
  return ranked.length ? path.join(directory, ranked[0]) : null;
}

function transcriptRank(filename) {
  if (/\.en\.vtt$/u.test(filename)) return 0;
  if (/\.en-[A-Z]{2}\.vtt$/u.test(filename)) return 1;
  if (/\.en-orig\.vtt$/u.test(filename)) return 2;
  if (/\.en[^.]*\.vtt$/u.test(filename)) return 3;
  return 10;
}

function cueCoverage(cues) {
  return cues.reduce((sum, cue) => sum + Math.max(0, cue.endSeconds - cue.startSeconds), 0);
}

function chapterAt(chapters, seconds) {
  return (
    chapters.find((chapter) => seconds >= chapter.startSeconds && seconds < chapter.endSeconds) ??
    null
  );
}

function nearestFrame(seconds, frames) {
  return frames.reduce(
    (nearest, frame) =>
      !nearest || Math.abs(frame.seconds - seconds) < Math.abs(nearest.seconds - seconds)
        ? frame
        : nearest,
    null,
  );
}

function parseTimestamp(value) {
  const parts = value.trim().split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  if (parts.length === 3) return parts[0] * 3_600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] ?? 0;
}

function formatTimestamp(seconds) {
  return String(Math.round(seconds * 10)).padStart(7, "0");
}

function cleanOcr(value) {
  return value.replace(/\s+/gu, " ").trim().slice(0, 4_000);
}

function finiteNumber(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function positiveInteger(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

function candidateSummary(candidate) {
  return {
    id: candidate.id,
    score: candidate.score,
    title: candidate.title,
    uploader: candidate.uploader,
    durationSeconds: candidate.durationSeconds,
    devices: candidate.devices,
    categories: candidate.categories,
    officialContexts: candidate.sourceContexts.length,
    url: candidate.url,
  };
}

function resultFromAnalysis(analysis, status) {
  return {
    id: analysis.id,
    title: analysis.title,
    uploader: analysis.uploader,
    status,
    durationSeconds: analysis.durationSeconds,
    devices: analysis.devices,
    categories: analysis.categories,
    transcript: analysis.transcript,
    actionWindows: analysis.actionWindows.length,
    frames: analysis.frames.length,
    directory: path.join(outputDir, "videos", analysis.id),
  };
}

async function mapConcurrent(items, concurrency, mapper) {
  const output = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        output[index] = await mapper(items[index], index);
      }
    }),
  );
  return output;
}

async function run(command, args) {
  await runCapture(command, args, false);
}

async function runCapture(command, args, allowFailure) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeoutMs = command === "yt-dlp" ? 240_000 : command === "ffmpeg" ? 60_000 : 30_000;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    timeout.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`${command} exceeded ${Math.round(timeoutMs / 1_000)} seconds`));
        return;
      }
      if (code === 0 || allowFailure) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr.trim().slice(-2_000)}`));
    });
  });
}

async function requireCommand(command) {
  if (!(await commandExists(command))) throw new Error(`Required command not found: ${command}`);
}

async function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/env", ["which", command], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function isFile(filename) {
  try {
    return (await stat(filename)).isFile();
  } catch {
    return false;
  }
}

async function writeJson(filename, value) {
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`);
}

await main();
