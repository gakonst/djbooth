#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Cli, z } from "incur";

import {
  AnlzFile,
  analyzeTrackAsync,
  analyzeTracks,
  BeatGridTag,
  compareBeatGrids,
  compareWaveforms,
  DEFAULT_ANALYZER_CONCURRENCY,
  DEFAULT_ANALYZER_TRACK_THREADS,
  DEFAULT_ANALYZER_THREAD_BUDGET,
  ExtendedBeatGridTag,
  extractPhraseFeatures,
  createMySettingFile,
  diagnoseAnalyzer,
  diagnoseEnhancement,
  getAnlzPaths,
  getMySettingPaths,
  LogicalOperator,
  MasterDatabase,
  modelByTable,
  DjmdContent,
  DjmdPlaylist,
  DjmdSongPlaylist,
  diagnoseStems,
  enhanceAudio,
  readMySettingFile,
  RekordboxXml,
  separateStems,
  separateStemsBatch,
  setupStems,
  setupEnhancement,
  SmartList,
  updateConfig,
  version,
  walkAnlzDirectories,
} from "./index.js";
import type {
  ConditionInput,
  DatabaseValue,
  HotCueSlot,
  MySettingFilename,
  NodeKeyType,
  PlaylistSummary,
  TrackAttributes,
  TrackSelector,
} from "./index.js";
import {
  Content as DeviceContent,
  DeviceLibraryPlus,
  modelByTable as deviceModelByTable,
  Playlist as DevicePlaylist,
  PlaylistContent as DevicePlaylistContent,
} from "./devicelib-plus/index.js";
import { type ContentCuePatch, performGuardedCueMutation } from "./masterdb/safe-cue-write.js";

export const rekordboxCli = Cli.create("rekordbox", {
  version,
  description: "Query and modify Rekordbox databases, libraries, and export formats.",
});

rekordboxCli.command("status", {
  description: "Show implementation and runtime status.",
  output: z.object({
    name: z.string(),
    version: z.string(),
    runtime: z.string(),
    phase: z.string(),
  }),
  run() {
    return {
      name: "@gakonst/rekordbox",
      version,
      runtime: process.version,
      phase: "complete-port",
    };
  },
});

const analyzeCli = Cli.create("analyze", {
  description: "Produce DAT/EXT/2EX beat grids, key, waveforms, seek tables, and song structure.",
  hint: "The clean engine is releasable and default. Use Auto when rhythm mode is unknown, Dynamic for live/rubato tempo, and Normal for a deliberate static grid. Reference parity requires the same explicit Normal or Dynamic mode on both sides.",
});

analyzeCli.command("track", {
  description: "Create complete CDJ-loadable analysis for one local recording.",
  hint: "Low-level default is Normal. Select Auto for conservative mode detection. Output includes non-empty PSSI song structure; reference Auto is unsupported.",
  args: z.object({ audioPath: z.string().describe("Existing audio file") }),
  options: z.object({
    analyzerBinary: z.string().optional().describe("Selected analyzer executable override"),
    engine: z
      .enum(["clean", "reference"])
      .default("clean")
      .describe("Clean-room DSP, or an explicit local proprietary parity oracle"),
    force: z.boolean().default(false).describe("Replace existing analysis artifacts"),
    outputDirectory: z.string().optional().describe("Artifact directory; defaults beside audio"),
    rekordboxApp: z.string().optional().describe("Reference-engine Rekordbox.app override"),
    rekordboxCache: z.string().optional().describe("Reference-engine cache directory"),
    rhythmMode: z
      .enum(["normal", "dynamic", "auto"])
      .default("normal")
      .describe(
        "Beat grid: Normal for steady tempo, Dynamic for changes, Auto for clean engine only",
      ),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .default(300_000)
      .describe("Analyzer timeout in milliseconds"),
    threads: z
      .number()
      .int()
      .min(1)
      .max(64)
      .optional()
      .describe(
        `Pipelined native CPU workers; defaults to the profiled single-track sweet spot (${String(DEFAULT_ANALYZER_TRACK_THREADS)} here)`,
      ),
  }),
  async run(c) {
    const controller = new AbortController();
    const abort = () => controller.abort(new DOMException("Interrupted", "AbortError"));
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      return await analyzeTrackAsync(c.args.audioPath, {
        ...c.options,
        signal: controller.signal,
      });
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
  },
});

analyzeCli.command("tracks", {
  description: "Create complete CDJ-loadable analysis for local recordings in parallel.",
  hint: "One total scheduling budget is divided across workers. The profiled default keeps two Rayon slots per Apple Silicon core and never adds more than one analyzer process per core. Select one shared rhythm mode; use the Tracks workflow when you also need resumable acquisition and Rekordbox playlist import.",
  options: z.object({
    analyzerBinary: z.string().optional().describe("Selected analyzer executable override"),
    audioPath: z.array(z.string()).describe("Existing audio file; repeat for multiple tracks"),
    concurrency: z
      .number()
      .int()
      .min(1)
      .max(64)
      .optional()
      .describe(
        `Parallel analyzer processes; profiled CPU-adaptive default ${String(DEFAULT_ANALYZER_CONCURRENCY)} here (max 64)`,
      ),
    engine: z
      .enum(["clean", "reference"])
      .default("clean")
      .describe("Clean-room DSP, or an explicit local proprietary parity oracle"),
    force: z.boolean().default(false).describe("Replace existing analysis artifacts"),
    rekordboxApp: z.string().optional().describe("Reference-engine Rekordbox.app override"),
    rekordboxCache: z.string().optional().describe("Reference-engine cache directory"),
    rhythmMode: z
      .enum(["normal", "dynamic", "auto"])
      .default("normal")
      .describe(
        "Beat grid: Normal for steady tempo, Dynamic for changes, Auto for clean engine only",
      ),
    progress: z.enum(["auto", "always", "never"]).default("auto").describe("Progress on stderr"),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .default(300_000)
      .describe("Per-track analyzer timeout in milliseconds"),
    threads: z
      .number()
      .int()
      .min(1)
      .max(64)
      .optional()
      .describe(
        `Total native scheduling slots shared across analyzer processes; profiled default ${String(DEFAULT_ANALYZER_THREAD_BUDGET)} here`,
      ),
  }),
  async run(c) {
    const controller = new AbortController();
    const abort = () => controller.abort(new DOMException("Interrupted", "AbortError"));
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    const showProgress =
      c.options.progress === "always" ||
      (c.options.progress === "auto" && (c.agent || !c.formatExplicit));
    try {
      return await analyzeTracks(c.options.audioPath, {
        analyzerBinary: c.options.analyzerBinary,
        concurrency: c.options.concurrency,
        engine: c.options.engine,
        force: c.options.force,
        rekordboxApp: c.options.rekordboxApp,
        rekordboxCache: c.options.rekordboxCache,
        rhythmMode: c.options.rhythmMode,
        signal: controller.signal,
        threads: c.options.threads,
        timeoutMs: c.options.timeoutMs,
        ...(showProgress
          ? {
              onProgress(progress) {
                process.stderr.write(
                  `[analyze] ${String(progress.completed)}/${String(progress.total)} ${progress.phase} ${basename(progress.audioPath)}\n`,
                );
              },
            }
          : {}),
      });
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
  },
});

analyzeCli.command("doctor", {
  description: "Inspect the clean-room analyzer or an explicit local reference oracle.",
  options: z.object({
    analyzerBinary: z.string().optional().describe("Selected analyzer executable override"),
    engine: z.enum(["clean", "reference"]).default("clean").describe("Analyzer backend to inspect"),
    rekordboxApp: z.string().optional().describe("Reference-engine Rekordbox.app override"),
    rekordboxCache: z.string().optional().describe("Reference-engine cache directory"),
  }),
  run(c) {
    return diagnoseAnalyzer(c.options);
  },
});

analyzeCli.command("beat-grid-diff", {
  description:
    "Compare reference and candidate PQTZ/PQT2 grids with sub-millisecond timing and downbeat metrics.",
  args: z.object({
    referenceDirectory: z.string().describe("Reference DAT/EXT/2EX analysis directory"),
    candidateDirectory: z.string().describe("Candidate DAT/EXT/2EX analysis directory"),
  }),
  options: z.object({
    analyzerBinary: z.string().optional().describe("Clean-room analyzer executable override"),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .default(30_000)
      .describe("Comparison timeout in milliseconds"),
  }),
  run(c) {
    return compareBeatGrids(c.args.referenceDirectory, c.args.candidateDirectory, c.options);
  },
});

analyzeCli.command("waveform-diff", {
  description:
    "Compare decoded PWAV/PWV2/PWV3/PWV4/PWV5/PWV6/PWV7 components with correlation and error metrics.",
  args: z.object({
    referenceDirectory: z.string().describe("Reference DAT/EXT/2EX analysis directory"),
    candidateDirectory: z.string().describe("Candidate DAT/EXT/2EX analysis directory"),
  }),
  options: z.object({
    analyzerBinary: z.string().optional().describe("Clean-room analyzer executable override"),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .default(30_000)
      .describe("Comparison timeout in milliseconds"),
  }),
  run(c) {
    return compareWaveforms(c.args.referenceDirectory, c.args.candidateDirectory, c.options);
  },
});

analyzeCli.command("phrase-features", {
  description:
    "Page recovered native-shaped low, middle, high, quarter-beat, and eighth-beat phrase features.",
  hint: "Use a native or frozen DAT grid as the timing reference. This diagnostic does not mutate the library or alter production phrase labels.",
  args: z.object({
    audioPath: z.string().describe("Existing audio file"),
    referenceDat: z.string().describe("Reference ANLZ0000.DAT beat grid"),
  }),
  options: z.object({
    analyzerBinary: z.string().optional().describe("Clean-room analyzer executable override"),
    limit: z.number().int().min(1).max(4_096).default(128).describe("Beat records to return"),
    offset: z.number().int().min(0).default(0).describe("Beat records to skip"),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .default(300_000)
      .describe("Extraction timeout in milliseconds"),
  }),
  run(c) {
    return extractPhraseFeatures(c.args.audioPath, c.args.referenceDat, c.options);
  },
});

rekordboxCli.command(analyzeCli);

const stemsGroupCli = Cli.create("stems", {
  description: "Separate local audio with MLX-native Mel-Band-RoFormer on Apple Silicon.",
  hint: "The pinned Apache-2.0 four-source model downloads once (3.76 GB), converts to reusable safetensors, and runs inference on the Apple GPU. Rekordbox layout emits instrumental, vocals, and residual drums; four-stem emits drums, bass, other, and vocals.",
});

const stemsRuntimeOptions = z.object({
  cacheDirectory: z.string().optional().describe("Persistent model cache override"),
  pythonProjectDirectory: z.string().optional().describe("Standalone stems-mlx uv project"),
  uvBinary: z.string().optional().describe("uv executable override"),
});
const stemName = z.enum(["instrumental", "vocals", "drums", "bass", "other"]);

stemsGroupCli.command("doctor", {
  description: "Inspect Apple Silicon, MLX, and local model readiness.",
  options: stemsRuntimeOptions,
  async run(c) {
    return await diagnoseStems({
      cacheDirectory: c.options.cacheDirectory,
      pythonProjectDirectory: c.options.pythonProjectDirectory,
      uvBinary: c.options.uvBinary,
    });
  },
});

stemsGroupCli.command("setup", {
  description: "Download, authenticate, and convert the pinned four-stem model.",
  options: stemsRuntimeOptions,
  async run(c) {
    return await setupStems({
      cacheDirectory: c.options.cacheDirectory,
      onLog(message) {
        process.stderr.write(message);
      },
      pythonProjectDirectory: c.options.pythonProjectDirectory,
      uvBinary: c.options.uvBinary,
    });
  },
});

function createStemSeparationCli<const Name extends string>(name: Name) {
  return Cli.create(name, {
    description: "Create three Rekordbox-compatible stems or four native model stems.",
    args: z.object({
      audioPath: z.string().describe("Existing audio file"),
      outputDirectory: z.string().describe("Stem WAV destination"),
    }),
    options: stemsRuntimeOptions.extend({
      force: z.boolean().default(false).describe("Replace existing named stem WAV files"),
      layout: z
        .enum(["rekordbox", "four-stem"])
        .default("rekordbox")
        .describe("Rekordbox three-source contract, or model-native four sources"),
      stem: z.array(stemName).optional().describe("Only write this source; repeat for several"),
    }),
    async run(c) {
      return await separateStems(c.args.audioPath, c.args.outputDirectory, {
        cacheDirectory: c.options.cacheDirectory,
        force: c.options.force,
        layout: c.options.layout,
        onLog(message) {
          process.stderr.write(message);
        },
        pythonProjectDirectory: c.options.pythonProjectDirectory,
        stems: c.options.stem,
        uvBinary: c.options.uvBinary,
      });
    },
  });
}

/** Root workflow command: separate one recording without a redundant `separate` layer. */
export const stemsCli = createStemSeparationCli("stems");

stemsGroupCli.command(createStemSeparationCli("separate"));

stemsGroupCli.command("playlist", {
  description: "Separate every local track in a Rekordbox playlist with one model load.",
  hint: "The database is opened read-only. Duplicate playlist memberships are separated once, and each content ID gets its own output directory.",
  args: z.object({
    playlistId: z.string().describe("Regular or smart playlist ID"),
    outputRoot: z.string().describe("Root directory for per-track stem directories"),
  }),
  options: stemsRuntimeOptions.extend({
    force: z.boolean().default(false).describe("Replace existing selected stem WAV files"),
    layout: z
      .enum(["rekordbox", "four-stem"])
      .default("rekordbox")
      .describe("Rekordbox three-source contract, or model-native four sources"),
    limit: z.number().int().min(1).max(100_000).optional().describe("Maximum tracks to separate"),
    offset: z.number().int().min(0).default(0).describe("Playlist tracks to skip"),
    path: z.string().optional().describe("master.db path; defaults to auto-discovery"),
    plain: z.boolean().default(false).describe("Open an unencrypted SQLite database"),
    stem: z.array(stemName).optional().describe("Only write this source; repeat for several"),
  }),
  async run(c) {
    const db = openDatabase(c.options);
    let playlistTracks;
    let playlistTrackCount;
    try {
      playlistTrackCount = db.countPlaylistTracks(c.args.playlistId);
      playlistTracks = db.getPlaylistTracks(c.args.playlistId, {
        limit: c.options.limit,
        offset: c.options.offset,
      });
    } finally {
      db.close();
    }

    const uniqueTracks = new Map(
      playlistTracks.map((track) => [track.contentId, track] as const),
    ).values();
    const outputRoot = resolve(c.args.outputRoot);
    const jobs = [...uniqueTracks].map((track) => {
      if (!track.path) throw new TypeError(`Content '${track.contentId}' has no local audio path`);
      const fileStem = basename(track.path, extname(track.path));
      return {
        audioPath: track.path,
        outputDirectory: join(outputRoot, `${track.contentId} - ${fileStem}`),
      };
    });
    const result = await separateStemsBatch(jobs, {
      cacheDirectory: c.options.cacheDirectory,
      force: c.options.force,
      layout: c.options.layout,
      onLog(message) {
        process.stderr.write(message);
      },
      pythonProjectDirectory: c.options.pythonProjectDirectory,
      stems: c.options.stem,
      uvBinary: c.options.uvBinary,
    });
    return {
      outputRoot,
      limit: c.options.limit ?? null,
      offset: c.options.offset,
      playlistId: c.args.playlistId,
      playlistTrackCount,
      selectedTrackCount: playlistTracks.length,
      skippedDuplicateCount: playlistTracks.length - jobs.length,
      ...result,
    };
  },
});

rekordboxCli.command(stemsGroupCli);

const enhancementRuntimeOptions = z.object({
  cacheDirectory: z.string().optional().describe("Persistent A2SB model cache override"),
  pythonProjectDirectory: z.string().optional().describe("Standalone a2sb-mlx uv project"),
  uvBinary: z.string().optional().describe("uv executable override"),
});

export const enhancementGroupCli = Cli.create("enhancement", {
  description: "Restore bandwidth in low-quality music with NVIDIA A2SB on Apple Silicon.",
  hint: "A2SB is licensed only for noncommercial research or evaluation. One-split is the local AAC benchmark winner; two-split retains NVIDIA's official time-partitioned ensemble for comparison.",
});

enhancementGroupCli.command("doctor", {
  description: "Inspect MLX and local A2SB checkpoint readiness.",
  options: enhancementRuntimeOptions,
  async run(c) {
    return await diagnoseEnhancement(c.options);
  },
});

enhancementGroupCli.command("setup", {
  description:
    "Download, authenticate, and convert pinned A2SB checkpoints to float16 MLX weights.",
  options: enhancementRuntimeOptions.extend({
    force: z.boolean().default(false).describe("Reconvert existing authenticated checkpoints"),
    profile: z
      .enum(["one-split", "two-split", "all"])
      .default("one-split")
      .describe("Benchmark-default single model, official two-model ensemble, or both"),
  }),
  async run(c) {
    return await setupEnhancement({
      ...c.options,
      onLog(message) {
        process.stderr.write(message);
      },
    });
  },
});

function createEnhanceCli<const Name extends string>(name: Name) {
  return Cli.create(name, {
    description: "Restore lossy high-frequency content with noncommercial A2SB MLX inference.",
    hint: "Writes a new 44.1 kHz float WAV (or 24-bit FLAC) and never replaces the source. Start with a short --max-seconds trial before a full track.",
    args: z.object({
      audioPath: z.string().describe("Existing local audio file"),
      outputPath: z.string().describe("New .wav or .flac destination"),
    }),
    options: enhancementRuntimeOptions.extend({
      batchSize: z
        .number()
        .int()
        .min(1)
        .max(2)
        .default(1)
        .describe("MLX window batch size; 1 avoids unified-memory pressure on a 32 GB M2 Max"),
      channelMode: z
        .enum(["mid-side", "independent"])
        .default("mid-side")
        .describe("Stereo representation presented to the mono-trained model"),
      cutoffHz: z
        .number()
        .int()
        .min(2_000)
        .max(21_500)
        .optional()
        .describe("Explicit cutoff; defaults to codec-edge detection, then 99% spectral rolloff"),
      force: z.boolean().default(false).describe("Replace an existing destination file"),
      maxSeconds: z.number().positive().optional().describe("Process only an initial test excerpt"),
      ode: z.boolean().default(false).describe("Deterministic ODE sampling instead of release SDE"),
      overlap: z
        .boolean()
        .default(true)
        .describe("Use 50% MultiDiffusion overlap to suppress seams"),
      profile: z
        .enum(["one-split", "two-split"])
        .default("one-split")
        .describe("Benchmark-default one-model restoration or official two-model ensemble"),
      seed: z.number().int().default(0).describe("Reproducible bridge noise seed"),
      startSeconds: z
        .number()
        .nonnegative()
        .default(0)
        .describe("Start time for a bounded excerpt"),
      steps: z.number().int().min(2).max(100).default(50).describe("Bridge sampling steps"),
    }),
    async run(c) {
      return await enhanceAudio(c.args.audioPath, c.args.outputPath, {
        ...c.options,
        onLog(message) {
          process.stderr.write(message);
        },
      });
    },
  });
}

/** Root workflow route for one local audio restoration. */
export const enhanceCli = createEnhanceCli("enhance");
enhancementGroupCli.command(createEnhanceCli("run"));
rekordboxCli.command(enhancementGroupCli);

const configCli = Cli.create("config", {
  description: "Discover Rekordbox installations and library paths.",
}).command("show", {
  description: "Show detected Rekordbox paths and versions.",
  options: z.object({
    appDir: z.string().optional().describe("Pioneer application-data directory"),
    installDir: z.string().optional().describe("Pioneer/Rekordbox installation root"),
    rekordbox5Dirname: z.string().optional().describe("Exact Rekordbox 5 directory name"),
    rekordbox6Dirname: z.string().optional().describe("Exact Rekordbox 6 directory name"),
    rekordbox7Dirname: z.string().optional().describe("Exact Rekordbox 7 directory name"),
  }),
  examples: [{ description: "Auto-detect Rekordbox installations" }],
  run(c) {
    return updateConfig({
      pioneerAppDir: c.options.appDir,
      pioneerInstallDir: c.options.installDir,
      rekordbox5Dirname: c.options.rekordbox5Dirname,
      rekordbox6Dirname: c.options.rekordbox6Dirname,
      rekordbox7Dirname: c.options.rekordbox7Dirname,
    });
  },
});

rekordboxCli.command(configCli);

const settingsCli = Cli.create("settings", {
  description: "Read and write Rekordbox My Settings binary files.",
});

settingsCli.command("list", {
  description: "Find My Settings files below a directory.",
  args: z.object({ root: z.string().describe("Directory to scan") }),
  options: z.object({ deep: z.boolean().default(false).describe("Scan recursively") }),
  run(c) {
    const paths = getMySettingPaths(c.args.root, c.options.deep);
    return { count: paths.length, paths };
  },
});

settingsCli.command("show", {
  description: "Parse and show a My Settings file.",
  args: z.object({ path: z.string().describe("Settings file") }),
  run(c) {
    const file = readMySettingFile(c.args.path);
    return {
      ...file.toJSON(),
      allowedValues: Object.fromEntries(file.keys().map((key) => [key, file.allowedValues(key)])),
    };
  },
});

settingsCli.command("set", {
  description: "Update one setting and write a checksummed binary.",
  args: z.object({
    path: z.string().describe("Settings file"),
    key: z.string().describe("Setting name"),
    value: z.string().describe("Symbolic setting value"),
  }),
  options: z.object({
    output: z.string().optional().describe("Destination; defaults to the source file"),
  }),
  run(c) {
    const file = readMySettingFile(c.args.path);
    file.set(c.args.key, c.args.value);
    const output = c.options.output ?? c.args.path;
    file.save(output);
    return { output, ...file.toJSON() };
  },
});

settingsCli.command("reset", {
  description: "Reset one setting to its format default and write the binary.",
  args: z.object({
    path: z.string().describe("Settings file"),
    key: z.string().describe("Setting name"),
  }),
  options: z.object({
    output: z.string().optional().describe("Destination; defaults to the source file"),
  }),
  run(c) {
    const file = readMySettingFile(c.args.path);
    file.reset(c.args.key);
    const output = c.options.output ?? c.args.path;
    file.save(output);
    return { output, ...file.toJSON() };
  },
});

settingsCli.command("create", {
  description: "Create a default My Settings binary.",
  args: z.object({
    filename: z
      .enum(["MYSETTING.DAT", "MYSETTING2.DAT", "DJMMYSETTING.DAT", "DEVSETTING.DAT"])
      .describe("Settings format"),
    output: z.string().describe("Destination file"),
  }),
  options: z.object({
    version: z.string().optional().describe("DEVSETTING Rekordbox version"),
  }),
  run(c) {
    const file = createMySettingFile(c.args.filename as MySettingFilename);
    if (c.options.version !== undefined) file.version = c.options.version;
    file.save(c.args.output);
    return { output: c.args.output, ...file.toJSON() };
  },
});

rekordboxCli.command(settingsCli);

function paginateTagValue(value: unknown, offset: number, limit: number): unknown {
  if (Array.isArray(value))
    return { count: value.length, items: value.slice(offset, offset + limit), limit, offset };
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        Array.isArray(item) ? item.slice(offset, offset + limit) : item,
      ]),
    );
  return value;
}

function numberList(value: string): Array<number> {
  const values = value.split(",").map((item) => Number(item.trim()));
  if (values.some((item) => !Number.isFinite(item)))
    throw new TypeError(`Invalid comma-separated number list '${value}'`);
  return values;
}

function parseJsonObject(value: string, label: string): Record<string, DatabaseValue> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new TypeError(`${label} must be a JSON object`);
  for (const [key, item] of Object.entries(parsed))
    if (item !== null && typeof item !== "string" && typeof item !== "number")
      throw new TypeError(`${label}.${key} must be a string, number, or null`);
  return parsed as Record<string, DatabaseValue>;
}

function parseJsonArray(value: string, label: string): Array<unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new TypeError(`${label} must be a JSON array`);
  return parsed;
}

const anlzCli = Cli.create("anlz", {
  description: "Read and write Rekordbox ANLZ analysis files.",
});

anlzCli.command("scan", {
  description: "Find directories and DAT/EXT/2EX files recursively.",
  args: z.object({ root: z.string().describe("USBANLZ root directory") }),
  run(c) {
    const directories = walkAnlzDirectories(c.args.root).map((directory) => ({
      directory,
      files: getAnlzPaths(directory),
    }));
    return { count: directories.length, directories };
  },
});

anlzCli.command("info", {
  description: "Show bounded ANLZ file and tag metadata.",
  args: z.object({ path: z.string().describe("ANLZ DAT, EXT, or 2EX file") }),
  run(c) {
    return AnlzFile.parseFile(c.args.path).summary();
  },
});

anlzCli.command("tag", {
  description: "Parse one tag by four-character type or semantic name.",
  args: z.object({
    path: z.string().describe("ANLZ DAT, EXT, or 2EX file"),
    key: z.string().describe("Tag type such as PQTZ or name such as beat_grid"),
  }),
  options: z.object({
    limit: z.number().int().min(1).max(100_000).default(1_000).describe("Array items to return"),
    offset: z.number().int().min(0).default(0).describe("Array items to skip"),
  }),
  run(c) {
    const tag = AnlzFile.parseFile(c.args.path).getTag(c.args.key);
    return {
      ...tag.summary(),
      value: paginateTagValue(tag.get(), c.options.offset, c.options.limit),
    };
  },
});

anlzCli.command("set-path", {
  description: "Replace the PPTH audio path and save the rebuilt ANLZ file.",
  args: z.object({
    path: z.string().describe("ANLZ DAT, EXT, or 2EX file"),
    audioPath: z.string().describe("New audio path"),
  }),
  options: z.object({
    output: z.string().optional().describe("Destination; defaults to the source file"),
  }),
  run(c) {
    const file = AnlzFile.parseFile(c.args.path);
    file.setPath(c.args.audioPath);
    const output = c.options.output ?? c.args.path;
    file.save(output);
    return { output, path: file.get("path") };
  },
});

anlzCli.command("set-beat-grid", {
  description: "Replace every existing PQTZ beat, BPM, and time value.",
  args: z.object({ path: z.string().describe("ANLZ DAT file") }),
  options: z.object({
    beats: z.string().describe("Comma-separated beat numbers"),
    bpms: z.string().describe("Comma-separated BPM values"),
    output: z.string().optional().describe("Destination; defaults to the source file"),
    times: z.string().describe("Comma-separated times in seconds"),
  }),
  run(c) {
    const file = AnlzFile.parseFile(c.args.path);
    const tag = file.getTag("PQTZ");
    if (!(tag instanceof BeatGridTag)) throw new TypeError("PQTZ tag has an unexpected handler");
    tag.set(numberList(c.options.beats), numberList(c.options.bpms), numberList(c.options.times));
    const output = c.options.output ?? c.args.path;
    file.save(output);
    return { beatGrid: tag.get(), output };
  },
});

anlzCli.command("set-beat-grid2", {
  description: "Replace the two PQT2 beat, BPM, and time anchors.",
  args: z.object({ path: z.string().describe("ANLZ EXT/2EX file") }),
  options: z.object({
    beats: z.string().describe("Two comma-separated beat numbers"),
    bpms: z.string().describe("Two comma-separated BPM values"),
    output: z.string().optional().describe("Destination; defaults to the source file"),
    times: z.string().describe("Two comma-separated times in seconds"),
  }),
  run(c) {
    const file = AnlzFile.parseFile(c.args.path);
    const tag = file.getTag("PQT2");
    if (!(tag instanceof ExtendedBeatGridTag))
      throw new TypeError("PQT2 tag has an unexpected handler");
    tag.setBeats(numberList(c.options.beats));
    tag.setBpms(numberList(c.options.bpms));
    tag.setTimes(numberList(c.options.times));
    const output = c.options.output ?? c.args.path;
    file.save(output);
    return { beatGrid: tag.get(), output };
  },
});

anlzCli.command("patch-bytes", {
  description: "Patch arbitrary on-disk bytes inside one ANLZ tag.",
  args: z.object({
    path: z.string().describe("ANLZ DAT, EXT, or 2EX file"),
    key: z.string().describe("Tag type or semantic name"),
    offset: z.number().int().min(0).describe("Byte offset from the tag header"),
    hex: z.string().describe("Replacement bytes as hexadecimal"),
  }),
  options: z.object({
    output: z.string().optional().describe("Destination; defaults to the source file"),
    parsed: z.boolean().default(false).describe("Patch parsed/deobfuscated tag bytes"),
  }),
  run(c) {
    if (!/^(?:[0-9a-fA-F]{2})+$/u.test(c.args.hex))
      throw new TypeError("hex must contain a non-empty even number of hexadecimal digits");
    const file = AnlzFile.parseFile(c.args.path);
    const tag = file.getTag(c.args.key);
    const replacement = Buffer.from(c.args.hex, "hex");
    const edit = (data: Buffer) => {
      if (c.args.offset + replacement.length > data.length)
        throw new RangeError("Patch exceeds the tag boundary");
      replacement.copy(data, c.args.offset);
    };
    if (c.options.parsed) tag.editParsed(edit);
    else tag.editRaw(edit);
    const output = c.options.output ?? c.args.path;
    file.save(output);
    return { bytes: replacement.length, offset: c.args.offset, output, tag: tag.summary() };
  },
});

rekordboxCli.command(anlzCli);

const smartlistCli = Cli.create("smartlist", {
  description: "Parse, build, and compile Rekordbox smart playlists.",
});

smartlistCli.command("parse", {
  description: "Parse smart-playlist XML.",
  args: z.object({ xml: z.string().describe("Smart-playlist NODE XML") }),
  run(c) {
    const smartList = SmartList.fromXml(c.args.xml);
    return { ...smartList.toJSON(), sql: smartList.compileSql() };
  },
});

smartlistCli.command("build", {
  description: "Build smart-playlist XML from JSON conditions.",
  args: z.object({ playlistId: z.number().int().describe("Unsigned playlist ID") }),
  options: z.object({
    autoUpdate: z.number().int().min(0).max(1).default(0).describe("Automatic update flag"),
    conditions: z
      .string()
      .default("[]")
      .describe("JSON array of {property,operator,valueLeft,valueRight?,unit?}"),
    logical: z.enum(["all", "any"]).default("all").describe("Condition combination mode"),
  }),
  run(c) {
    const parsed = parseJsonArray(c.options.conditions, "conditions") as Array<{
      operator: number;
      property: string;
      unit?: string;
      valueLeft: string | number;
      valueRight?: string | number;
    }>;
    if (!Array.isArray(parsed)) throw new TypeError("--conditions must be a JSON array");
    const smartList = new SmartList(
      c.options.logical === "all" ? LogicalOperator.ALL : LogicalOperator.ANY,
      c.options.autoUpdate,
    );
    smartList.playlistId = c.args.playlistId;
    for (const condition of parsed) smartList.addCondition(condition as ConditionInput);
    return { smartList: smartList.toJSON(), xml: smartList.toXml() };
  },
});

smartlistCli.command("sql", {
  description: "Compile smart-playlist XML to parameterized SQLite SQL.",
  args: z.object({ xml: z.string().describe("Smart-playlist NODE XML") }),
  options: z.object({
    tableAlias: z.string().optional().describe("Optional content-table alias"),
  }),
  run(c) {
    return SmartList.fromXml(c.args.xml).compileSql({ tableAlias: c.options.tableAlias });
  },
});

rekordboxCli.command(smartlistCli);

const dbOpenOptions = z.object({
  path: z.string().optional().describe("master.db path; defaults to auto-discovery"),
  plain: z.boolean().default(false).describe("Open an unencrypted SQLite database"),
});
const dbWriteOptions = dbOpenOptions;
const guardedCueWriteOptions = dbOpenOptions;

function openDatabase(options: { path?: string; plain: boolean }, write = false): MasterDatabase {
  return new MasterDatabase({
    key: process.env.REKORDBOX_DB_KEY,
    path: options.path,
    readonly: !write,
    unlock: !options.plain,
  });
}

function resolveDatabasePath(options: { path?: string; plain: boolean }): string {
  const database = openDatabase(options);
  try {
    return database.path;
  } finally {
    database.close();
  }
}

const databaseCli = Cli.create("db", {
  description: "Query and mutate Rekordbox 6/7 master databases.",
});

databaseCli.command("info", {
  description: "Show database paths, tables, and high-level counts.",
  options: dbOpenOptions,
  run(c) {
    const db = openDatabase(c.options);
    try {
      return {
        contentCount: db.hasTable("djmdContent") ? db.query(DjmdContent).count() : 0,
        dbDirectory: db.dbDirectory,
        path: db.path,
        playlistCount: db.hasTable("djmdPlaylist") ? db.query(DjmdPlaylist).count() : 0,
        readonly: db.readonly,
        shareDirectory: db.shareDirectory,
        tables: db.tableNames,
      };
    } finally {
      db.close();
    }
  },
});

databaseCli.command("table", {
  description: "List rows from any physical table.",
  args: z.object({ table: z.string().describe("Physical table name") }),
  options: dbOpenOptions.extend({
    filters: z.string().default("{}").describe("JSON object of equality filters"),
    limit: z.number().int().min(1).max(100_000).default(100).describe("Maximum rows"),
    offset: z.number().int().min(0).default(0).describe("Rows to skip"),
    orderBy: z.string().optional().describe("Physical column to order by"),
    descending: z.boolean().default(false).describe("Use descending order"),
  }),
  run(c) {
    const db = openDatabase(c.options);
    try {
      const model = modelByTable[c.args.table];
      let query = model ? db.query(model) : db.query(c.args.table);
      const filters = parseJsonObject(c.options.filters, "filters") as Record<
        string,
        string | number | null
      >;
      query = query.where(filters);
      if (c.options.orderBy)
        query = query.orderBy(c.options.orderBy, c.options.descending ? "desc" : "asc");
      const count = query.count();
      const rows = query.offset(c.options.offset).limit(c.options.limit).all();
      return { count, limit: c.options.limit, offset: c.options.offset, rows, table: c.args.table };
    } finally {
      db.close();
    }
  },
});

databaseCli.command("search", {
  description: "Search tracks and joined artist/album/genre/key metadata.",
  args: z.object({ text: z.string().describe("Case-insensitive search text") }),
  options: dbOpenOptions.extend({
    limit: z.number().int().min(1).max(100_000).default(100),
    offset: z.number().int().min(0).default(0),
  }),
  run(c) {
    const db = openDatabase(c.options);
    try {
      const rows = db.searchContent(c.args.text);
      return {
        count: rows.length,
        rows: rows.slice(c.options.offset, c.options.offset + c.options.limit),
      };
    } finally {
      db.close();
    }
  },
});

databaseCli.command("sql", {
  description: "Execute parameterized SQL against the master database.",
  args: z.object({ sql: z.string().describe("SQLite statement") }),
  options: dbWriteOptions.extend({
    parameters: z.string().default("[]").describe("JSON array of bind parameters"),
    limit: z.number().int().min(1).max(100_000).default(1_000),
    offset: z.number().int().min(0).default(0),
  }),
  run(c) {
    const db = openDatabase(c.options, true);
    try {
      const result = db.executeSql(c.args.sql, parseJsonArray(c.options.parameters, "parameters"));
      if (Array.isArray(result))
        return {
          count: result.length,
          limit: c.options.limit,
          offset: c.options.offset,
          rows: result.slice(c.options.offset, c.options.offset + c.options.limit),
        };
      return { changes: result.changes, lastInsertRowid: String(result.lastInsertRowid) };
    } finally {
      db.close();
    }
  },
});

databaseCli.command("copy-unlocked", {
  description: "Copy a decrypted logical database into a new plain SQLite file.",
  args: z.object({ output: z.string().describe("New destination database") }),
  options: dbOpenOptions,
  async run(c) {
    const db = openDatabase(c.options);
    try {
      await db.copyUnlocked(c.args.output);
      return { output: c.args.output, source: db.path, tables: db.tableNames.length };
    } finally {
      db.close();
    }
  },
});

const databaseRowCli = Cli.create("row", { description: "Generic mapped-row mutations." });

databaseRowCli.command("create", {
  description: "Insert a row using a JSON object of physical columns.",
  args: z.object({
    table: z.string().describe("Physical table name"),
    values: z.string().describe("JSON object of physical column values"),
  }),
  options: dbWriteOptions,
  run(c) {
    const db = openDatabase(c.options, true);
    try {
      const model = modelByTable[c.args.table];
      if (!model) throw new TypeError(`No mapped model for table '${c.args.table}'`);
      const row = db.create(
        model,
        parseJsonObject(c.args.values, "values") as Record<string, DatabaseValue>,
      );
      db.commit();
      return { row, table: c.args.table };
    } finally {
      db.close();
    }
  },
});

databaseRowCli.command("update", {
  description: "Update a row selected by primary-key column and value.",
  args: z.object({
    table: z.string().describe("Physical table name"),
    id: z.string().describe("Primary-key value"),
    values: z.string().describe("JSON object of physical column updates"),
  }),
  options: dbWriteOptions.extend({
    keyColumn: z.string().default("ID").describe("Primary-key column"),
  }),
  run(c) {
    const db = openDatabase(c.options, true);
    try {
      const model = modelByTable[c.args.table];
      if (!model) throw new TypeError(`No mapped model for table '${c.args.table}'`);
      const row = db
        .query(model)
        .where({ [c.options.keyColumn]: c.args.id })
        .one();
      for (const [key, value] of Object.entries(parseJsonObject(c.args.values, "values")))
        row.set(key, value as DatabaseValue);
      db.commit();
      return { row, table: c.args.table };
    } finally {
      db.close();
    }
  },
});

databaseRowCli.command("delete", {
  description: "Delete a row selected by primary-key column and value.",
  args: z.object({
    table: z.string().describe("Physical table name"),
    id: z.string().describe("Primary-key value"),
  }),
  options: dbWriteOptions.extend({
    keyColumn: z.string().default("ID").describe("Primary-key column"),
  }),
  run(c) {
    const db = openDatabase(c.options, true);
    try {
      const model = modelByTable[c.args.table];
      if (!model) throw new TypeError(`No mapped model for table '${c.args.table}'`);
      const row = db
        .query(model)
        .where({ [c.options.keyColumn]: c.args.id })
        .one();
      const deleted = row.toJSON();
      db.delete(row);
      db.commit();
      return { deleted, table: c.args.table };
    } finally {
      db.close();
    }
  },
});

const databasePlaylistCli = Cli.create("playlist", {
  description: "Query and mutate master-database playlists.",
});

const databaseContentCli = Cli.create("content", {
  description: "Create tracks and coordinate database, ANLZ, and cue data.",
});

const hotCueSlotNames = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
  "M",
  "N",
  "O",
  "P",
] as const;

type HotCueSlotName = (typeof hotCueSlotNames)[number];

function hotCueSlotNumber(slot: HotCueSlotName): HotCueSlot {
  return (hotCueSlotNames.indexOf(slot) + 1) as HotCueSlot;
}

const databaseMetadataCli = Cli.create("metadata", {
  description: "Create common master-library metadata rows.",
});

databaseMetadataCli.command("add", {
  description: "Add an artist, genre, label, or album with generated IDs and timestamps.",
  args: z.object({
    type: z.enum(["artist", "genre", "label", "album"]),
    name: z.string().describe("Metadata name"),
  }),
  options: dbWriteOptions.extend({
    artistId: z.string().optional().describe("Album artist ID"),
    compilation: z.boolean().default(false).describe("Mark an album as a compilation"),
    imagePath: z.string().optional().describe("Album image path"),
    searchString: z.string().optional().describe("Optional search string"),
  }),
  run(c) {
    const db = openDatabase(c.options, true);
    try {
      const row =
        c.args.type === "artist"
          ? db.addArtist(c.args.name, c.options.searchString)
          : c.args.type === "genre"
            ? db.addGenre(c.args.name)
            : c.args.type === "label"
              ? db.addLabel(c.args.name)
              : db.addAlbum(c.args.name, {
                  artist: c.options.artistId,
                  compilation: c.options.compilation,
                  imagePath: c.options.imagePath,
                  searchString: c.options.searchString,
                });
      db.commit();
      return row;
    } finally {
      db.close();
    }
  },
});

databaseContentCli.command("add", {
  description: "Add an existing audio file as a content row.",
  args: z.object({ audioPath: z.string().describe("Existing audio file") }),
  options: dbWriteOptions.extend({
    albumId: z.string().optional(),
    artistId: z.string().optional(),
    genreId: z.string().optional(),
    title: z.string().optional(),
  }),
  run(c) {
    const db = openDatabase(c.options, true);
    try {
      const row = db.addContent(c.args.audioPath, {
        AlbumID: c.options.albumId ?? null,
        ArtistID: c.options.artistId ?? null,
        GenreID: c.options.genreId ?? null,
        Title: c.options.title ?? null,
      });
      db.commit();
      return row;
    } finally {
      db.close();
    }
  },
});

databaseContentCli.command("set-path", {
  description: "Update a content path and matching ANLZ PPTH tags.",
  args: z.object({
    contentId: z.string().describe("Content ID"),
    audioPath: z.string().describe("New audio path"),
  }),
  options: dbWriteOptions.extend({
    checkPath: z.boolean().default(true).describe("Require the new audio path to exist"),
    saveAnlz: z.boolean().default(true).describe("Write updated analysis files"),
  }),
  run(c) {
    const db = openDatabase(c.options, true);
    try {
      db.updateContentPath(c.args.contentId, c.args.audioPath, {
        checkPath: c.options.checkPath,
        commit: false,
        saveAnlz: c.options.saveAnlz,
      });
      db.commit();
      return db.query(DjmdContent).where({ ID: c.args.contentId }).one();
    } finally {
      db.close();
    }
  },
});

databaseContentCli.command("set-filename", {
  description: "Rename a content file path and matching ANLZ PPTH tags.",
  args: z.object({
    contentId: z.string().describe("Content ID"),
    filename: z.string().describe("New basename; the original extension is retained"),
  }),
  options: dbWriteOptions.extend({
    checkPath: z.boolean().default(true).describe("Require the renamed audio path to exist"),
    saveAnlz: z.boolean().default(true).describe("Write updated analysis files"),
  }),
  run(c) {
    const db = openDatabase(c.options, true);
    try {
      db.updateContentFilename(c.args.contentId, c.args.filename, {
        checkPath: c.options.checkPath,
        commit: false,
        saveAnlz: c.options.saveAnlz,
      });
      db.commit();
      return db.query(DjmdContent).where({ ID: c.args.contentId }).one();
    } finally {
      db.close();
    }
  },
});

databaseContentCli.command("install-analysis", {
  description: "Install DAT/EXT/2EX files plus validated analyzer BPM/key metadata.",
  args: z.object({
    contentId: z.string().describe("Content ID"),
    analysisDirectory: z
      .string()
      .describe("Directory containing analysis.json and ANLZ0000.DAT/EXT/2EX"),
  }),
  options: dbWriteOptions.extend({
    replace: z.boolean().default(false).describe("Replace existing analysis files"),
  }),
  run(c) {
    const db = openDatabase(c.options, true);
    try {
      return db.installContentAnalysis(c.args.contentId, c.args.analysisDirectory, {
        commit: true,
        replace: c.options.replace,
      });
    } finally {
      db.close();
    }
  },
});

databaseContentCli.command("sync-analysis-metadata", {
  description: "Sync BPM/key from analysis.json without recopying installed ANLZ files.",
  args: z.object({
    contentId: z.string().describe("Content ID"),
    analysisDirectory: z.string().describe("Directory containing validated analysis.json"),
  }),
  options: dbWriteOptions,
  run(c) {
    const db = openDatabase(c.options, true);
    try {
      return db.syncContentAnalysisMetadata(c.args.contentId, c.args.analysisDirectory, {
        commit: true,
      });
    } finally {
      db.close();
    }
  },
});

type PlaylistTreeEntry = PlaylistSummary & {
  childCount: number;
  depth: number;
  idPath: Array<string>;
  path: string;
  pathSegments: Array<string>;
};

function comparePlaylistSummaries(left: PlaylistSummary, right: PlaylistSummary): number {
  if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  const nameOrder = left.name
    .toLocaleLowerCase("en-US")
    .localeCompare(right.name.toLocaleLowerCase("en-US"), "en-US");
  if (nameOrder) return nameOrder;
  if (/^\d+$/u.test(left.id) && /^\d+$/u.test(right.id)) {
    const leftId = BigInt(left.id);
    const rightId = BigInt(right.id);
    if (leftId !== rightId) return leftId < rightId ? -1 : 1;
  }
  return left.id.localeCompare(right.id);
}

function buildPlaylistTree(playlists: Array<PlaylistSummary>): {
  entries: Array<PlaylistTreeEntry>;
  warnings: Array<string>;
} {
  const byId = new Map(playlists.map((playlist) => [playlist.id, playlist]));
  const children = new Map<string, Array<PlaylistSummary>>();
  for (const playlist of playlists) {
    const siblings = children.get(playlist.parentId) ?? [];
    siblings.push(playlist);
    children.set(playlist.parentId, siblings);
  }
  for (const siblings of children.values()) siblings.sort(comparePlaylistSummaries);

  const entries: Array<PlaylistTreeEntry> = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const warnings = new Set<string>();
  const visit = (
    playlist: PlaylistSummary,
    pathSegments: Array<string>,
    idPath: Array<string>,
  ): void => {
    if (visiting.has(playlist.id)) {
      warnings.add(`Playlist hierarchy cycle reaches '${playlist.name}' (${playlist.id})`);
      return;
    }
    if (visited.has(playlist.id)) return;
    visiting.add(playlist.id);
    visited.add(playlist.id);
    const nextPathSegments = [...pathSegments, playlist.name];
    const nextIdPath = [...idPath, playlist.id];
    entries.push({
      ...playlist,
      childCount: children.get(playlist.id)?.length ?? 0,
      depth: pathSegments.length,
      idPath: nextIdPath,
      path: nextPathSegments.join(" › "),
      pathSegments: nextPathSegments,
    });
    for (const child of children.get(playlist.id) ?? []) visit(child, nextPathSegments, nextIdPath);
    visiting.delete(playlist.id);
  };

  for (const playlist of children.get("root") ?? []) visit(playlist, [], []);
  for (const playlist of [...playlists].sort(comparePlaylistSummaries)) {
    if (visited.has(playlist.id)) continue;
    if (!byId.has(playlist.parentId))
      warnings.add(
        `Playlist '${playlist.name}' (${playlist.id}) references missing parent '${playlist.parentId}'`,
      );
    else warnings.add(`Playlist '${playlist.name}' (${playlist.id}) is in a disconnected cycle`);
    visit(playlist, [], []);
  }
  return { entries, warnings: [...warnings] };
}

const playlistListOutput = z.object({
  summary: z.object({
    total: z.number().int().nonnegative(),
    playlists: z.number().int().nonnegative(),
    smartPlaylists: z.number().int().nonnegative(),
    folders: z.number().int().nonnegative(),
  }),
  filter: z.object({ type: z.enum(["all", "playable", "playlist", "smart", "folder"]) }),
  page: z.object({
    total: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive().nullable(),
    returned: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  }),
  entries: z.array(
    z.object({
      path: z.string(),
      type: z.enum(["folder", "playlist", "smart"]),
      trackCount: z.number().int().nonnegative().nullable(),
      childCount: z.number().int().nonnegative(),
      id: z.string(),
      name: z.string().optional(),
      parentId: z.string().optional(),
      sequence: z.number().int().optional(),
      depth: z.number().int().nonnegative().optional(),
      pathSegments: z.array(z.string()).optional(),
      idPath: z.array(z.string()).optional(),
      countError: z.string().optional(),
    }),
  ),
  warnings: z.array(z.string()).optional(),
});

databasePlaylistCli.command("list", {
  description: "List the complete active Rekordbox playlist hierarchy as a table or JSON.",
  options: dbOpenOptions.extend({
    type: z
      .enum(["all", "playable", "playlist", "smart", "folder"])
      .default("all")
      .describe("Entry type; playable includes regular and smart playlists"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100_000)
      .optional()
      .describe("Maximum entries to return; omitted returns the complete hierarchy"),
    offset: z.number().int().min(0).default(0).describe("Entries to skip in tree order"),
  }),
  output: playlistListOutput,
  format: "md",
  examples: [{ description: "List every playlist and folder in Rekordbox tree order" }],
  run(c) {
    const db = openDatabase(c.options);
    try {
      const playlists = db.listPlaylists();
      const tree = buildPlaylistTree(playlists);
      const filtered = tree.entries.filter((entry) => {
        if (c.options.type === "all") return true;
        if (c.options.type === "playable") return entry.type !== "folder";
        return entry.type === c.options.type;
      });
      const entries = filtered.slice(
        c.options.offset,
        c.options.limit === undefined ? undefined : c.options.offset + c.options.limit,
      );
      const machineOutput = c.format !== "md";
      return {
        summary: {
          total: playlists.length,
          playlists: playlists.filter((playlist) => playlist.type === "playlist").length,
          smartPlaylists: playlists.filter((playlist) => playlist.type === "smart").length,
          folders: playlists.filter((playlist) => playlist.type === "folder").length,
        },
        filter: { type: c.options.type },
        page: {
          total: filtered.length,
          offset: c.options.offset,
          limit: c.options.limit ?? null,
          returned: entries.length,
          hasMore: c.options.offset + entries.length < filtered.length,
        },
        entries: entries.map((entry) => ({
          path: entry.path,
          type: entry.type,
          trackCount: entry.trackCount,
          childCount: entry.childCount,
          id: entry.id,
          ...(machineOutput
            ? {
                name: entry.name,
                parentId: entry.parentId,
                sequence: entry.sequence,
                depth: entry.depth,
                pathSegments: entry.pathSegments,
                idPath: entry.idPath,
                ...(entry.countError === undefined ? {} : { countError: entry.countError }),
              }
            : {}),
        })),
        ...(tree.warnings.length ? { warnings: tree.warnings } : {}),
      };
    } finally {
      db.close();
    }
  },
});

databaseContentCli.command("cues", {
  description: "List normalized memory cues and Hot Cues for one content row.",
  args: z.object({ contentId: z.string().describe("Content ID") }),
  options: dbOpenOptions.extend({
    limit: z.number().int().min(1).max(100).default(100).describe("Maximum cues to return"),
    offset: z.number().int().min(0).default(0).describe("Cues to skip"),
  }),
  examples: [
    {
      args: { contentId: "123456789" },
      description: "List memory cues chronologically, then Hot Cues A through P",
    },
  ],
  run(c) {
    const db = openDatabase(c.options);
    try {
      const cues = db.getContentCues(c.args.contentId);
      return {
        contentId: c.args.contentId,
        count: cues.length,
        limit: c.options.limit,
        offset: c.options.offset,
        rows: cues.slice(c.options.offset, c.options.offset + c.options.limit),
      };
    } finally {
      db.close();
    }
  },
});

databaseContentCli.command("set-cue", {
  description: "Create a cue or patch one by ID without resetting omitted fields.",
  args: z.object({
    contentId: z.string().describe("Content ID"),
    startSeconds: z.coerce.number().min(0).describe("Cue or loop start in seconds"),
  }),
  options: guardedCueWriteOptions.extend({
    activeLoop: z.boolean().optional().describe("Set active loop; pass --no-active-loop to clear"),
    clearColor: z.boolean().default(false).describe("Clear the existing cue color byte"),
    clearColorTableIndex: z
      .boolean()
      .default(false)
      .describe("Clear the existing Rekordbox color-table index"),
    clearComment: z.boolean().default(false).describe("Clear the existing cue comment"),
    color: z.number().int().min(0).max(255).optional().describe("Rekordbox cue color byte"),
    colorTableIndex: z
      .number()
      .int()
      .min(0)
      .max(62)
      .optional()
      .describe("Rekordbox color-table index from 0 through 62"),
    comment: z.string().max(255).optional().describe("Cue comment"),
    endSeconds: z.number().min(0).optional().describe("Loop end in seconds"),
    id: z.string().min(1).optional().describe("Existing cue ID to update"),
    kind: z
      .enum(["memory", "hot"])
      .optional()
      .describe("Cue collection; new cues default to memory"),
    slot: z.enum(hotCueSlotNames).optional().describe("Hot Cue slot A through P"),
    type: z
      .enum(["cue", "loop"])
      .optional()
      .describe("Point cue or loop range; new cues default to cue"),
  }),
  examples: [
    {
      args: { contentId: "123456789", startSeconds: 32 },
      description: "Create a memory cue at 32 seconds",
    },
    {
      args: { contentId: "123456789", startSeconds: 64 },
      options: {
        activeLoop: true,
        comment: "Drop loop",
        endSeconds: 72,
        kind: "hot",
        slot: "A",
        type: "loop",
      },
      description: "Set Hot Cue A to an active loop",
    },
  ],
  async run(c) {
    if (c.options.clearColor && c.options.color !== undefined)
      throw new TypeError("Pass either --color or --clear-color, not both");
    if (c.options.clearColorTableIndex && c.options.colorTableIndex !== undefined)
      throw new TypeError("Pass either --color-table-index or --clear-color-table-index, not both");
    if (c.options.clearComment && c.options.comment !== undefined)
      throw new TypeError("Pass either --comment or --clear-comment, not both");

    const input: ContentCuePatch = {
      ...(c.options.activeLoop === undefined ? {} : { activeLoop: c.options.activeLoop }),
      ...(c.options.clearColor
        ? { color: null }
        : c.options.color === undefined
          ? {}
          : { color: c.options.color }),
      ...(c.options.clearColorTableIndex
        ? { colorTableIndex: null }
        : c.options.colorTableIndex === undefined
          ? {}
          : { colorTableIndex: c.options.colorTableIndex }),
      ...(c.options.clearComment
        ? { comment: "" }
        : c.options.comment === undefined
          ? {}
          : { comment: c.options.comment }),
      ...(c.options.endSeconds === undefined ? {} : { endSeconds: c.options.endSeconds }),
      ...(c.options.id === undefined ? {} : { id: c.options.id }),
      ...(c.options.kind === undefined ? {} : { kind: c.options.kind }),
      ...(c.options.slot === undefined ? {} : { slot: hotCueSlotNumber(c.options.slot) }),
      startSeconds: c.args.startSeconds,
      ...(c.options.type === undefined ? {} : { type: c.options.type }),
    };
    const dbPath = resolveDatabasePath(c.options);
    return performGuardedCueMutation(
      {
        dbPath,
        key: process.env.REKORDBOX_DB_KEY,
        unlock: !c.options.plain,
      },
      { type: "set-cue", contentId: c.args.contentId, cue: input },
    );
  },
});

databaseContentCli.command("delete-cue", {
  description: "Delete one memory cue or Hot Cue owned by a content row.",
  args: z.object({
    contentId: z.string().describe("Content ID"),
    cueId: z.string().describe("Cue ID"),
  }),
  options: guardedCueWriteOptions,
  examples: [{ args: { contentId: "123456789", cueId: "987654321" } }],
  async run(c) {
    const dbPath = resolveDatabasePath(c.options);
    return performGuardedCueMutation(
      {
        dbPath,
        key: process.env.REKORDBOX_DB_KEY,
        unlock: !c.options.plain,
      },
      { type: "delete-cue", contentId: c.args.contentId, cueId: c.args.cueId },
    );
  },
});

databasePlaylistCli.command("contents", {
  description: "List tracks selected by a regular or smart playlist.",
  args: z.object({ id: z.string().describe("Playlist ID") }),
  options: dbOpenOptions.extend({
    limit: z.number().int().min(1).max(100_000).default(100),
    offset: z.number().int().min(0).default(0),
  }),
  run(c) {
    const db = openDatabase(c.options);
    try {
      const query = db.getPlaylistContents(c.args.id);
      return {
        count: query.count(),
        rows: query.offset(c.options.offset).limit(c.options.limit).all(),
      };
    } finally {
      db.close();
    }
  },
});

const playlistShowOutput = z.object({
  playlist: z.object({
    id: z.string(),
    name: z.string(),
    parentId: z.string(),
    type: z.enum(["playlist", "smart"]),
    count: z.number().int().nonnegative(),
  }),
  page: z.object({
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive().nullable(),
    returned: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  }),
  tracks: z.array(
    z.object({
      position: z.number().int().positive(),
      artist: z.string().nullable(),
      title: z.string().nullable(),
      bpm: z.number().nullable(),
      key: z.string().nullable(),
      duration: z.string().nullable(),
      format: z.string().nullable(),
      analyzed: z.number().nullable().optional(),
      contentId: z.string().optional(),
      durationSeconds: z.number().nullable().optional(),
      fileType: z.number().nullable().optional(),
      membershipId: z.string().nullable().optional(),
      path: z.string().nullable().optional(),
    }),
  ),
});

databasePlaylistCli.command("show", {
  description: "Show an exact-name playlist as an ordered metadata table or JSON.",
  args: z.object({ name: z.string().min(1).describe("Exact playlist name") }),
  options: dbOpenOptions.extend({
    id: z.string().optional().describe("Playlist ID used to disambiguate duplicate names"),
    parentId: z.string().optional().describe("Parent folder ID used to disambiguate the name"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100_000)
      .optional()
      .describe("Maximum tracks to return; omitted returns the complete playlist"),
    offset: z.number().int().min(0).default(0).describe("Tracks to skip before returning results"),
  }),
  output: playlistShowOutput,
  format: "md",
  examples: [
    {
      description: "Show an ordered playlist as a table",
      args: { name: "'Adam Ten — Burning Man 2025 [music-ts E2E]'" },
    },
  ],
  run(c) {
    const db = openDatabase(c.options);
    try {
      const matches = db
        .query(DjmdPlaylist)
        .where({
          Name: c.args.name,
          ...(c.options.parentId === undefined ? {} : { ParentID: c.options.parentId }),
        })
        .all()
        .filter(
          (playlist) =>
            !playlist.isFolder && (c.options.id === undefined || playlist.ID === c.options.id),
        );
      if (!matches.length)
        throw new Error(
          `No playlist named '${c.args.name}'${c.options.parentId ? ` under parent '${c.options.parentId}'` : ""}${c.options.id ? ` with ID '${c.options.id}'` : ""}`,
        );
      if (matches.length > 1) {
        const candidates = matches
          .map((playlist) => `${playlist.ID} (parent ${playlist.ParentID})`)
          .join(", ");
        throw new Error(
          `Multiple playlists named '${c.args.name}' match: ${candidates}. Pass --parent-id or --id.`,
        );
      }

      const playlist = matches[0]!;
      const count = db.countPlaylistTracks(playlist);
      const tracks = db.getPlaylistTracks(playlist, {
        limit: c.options.limit,
        offset: c.options.offset,
      });
      const machineOutput = c.format !== "md";
      return {
        playlist: {
          id: playlist.ID,
          name: playlist.Name,
          parentId: playlist.ParentID,
          type: playlist.isSmartPlaylist ? ("smart" as const) : ("playlist" as const),
          count,
        },
        page: {
          offset: c.options.offset,
          limit: c.options.limit ?? null,
          returned: tracks.length,
          hasMore: c.options.offset + tracks.length < count,
        },
        tracks: tracks.map((track) => ({
          position: track.position,
          artist: machineOutput ? track.artist : (track.artist ?? ""),
          title: machineOutput ? track.title : (track.title ?? ""),
          bpm: track.bpm,
          key: track.key,
          duration: formatDuration(track.durationSeconds),
          format: formatFileType(track.fileType, track.path),
          ...(machineOutput
            ? {
                analyzed: track.analyzed,
                contentId: track.contentId,
                durationSeconds: track.durationSeconds,
                fileType: track.fileType,
                membershipId: track.membershipId,
                path: track.path,
              }
            : {}),
        })),
      };
    } finally {
      db.close();
    }
  },
});

function formatDuration(seconds: number | null): string | null {
  if (seconds === null) return null;
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function formatFileType(fileType: number | null, path: string | null): string | null {
  if (fileType === 1) return "MP3";
  if (fileType === 4) return "M4A";
  if (fileType === 5) return "FLAC";
  if (fileType === 11) return "WAV";
  if (fileType === 12) return "AIFF";
  const extension = path ? extname(path).slice(1).toUpperCase() : "";
  return extension || null;
}

databasePlaylistCli.command("create", {
  description: "Create a normal playlist, folder, or smart playlist.",
  args: z.object({ name: z.string().describe("Playlist name") }),
  options: dbWriteOptions.extend({
    parent: z.string().optional().describe("Parent folder ID"),
    seq: z.number().int().positive().optional().describe("One-based sibling sequence"),
    smartXml: z.string().optional().describe("Smart-list NODE XML"),
    type: z.enum(["playlist", "folder", "smart"]).default("playlist"),
  }),
  run(c) {
    const db = openDatabase(c.options, true);
    try {
      const options = { parent: c.options.parent, seq: c.options.seq };
      const row =
        c.options.type === "folder"
          ? db.createPlaylistFolder(c.args.name, options)
          : c.options.type === "smart"
            ? db.createSmartPlaylist(
                c.args.name,
                SmartList.fromXml(c.options.smartXml ?? ""),
                options,
              )
            : db.createPlaylist(c.args.name, options);
      db.commit();
      return row;
    } finally {
      db.close();
    }
  },
});

databasePlaylistCli.command("add-track", {
  description: "Add content to a normal playlist.",
  args: z.object({
    playlistId: z.string().describe("Playlist ID"),
    contentId: z.string().describe("Content ID"),
  }),
  options: dbWriteOptions.extend({
    trackNumber: z.number().int().positive().optional().describe("One-based insertion point"),
  }),
  run(c) {
    const db = openDatabase(c.options, true);
    try {
      const row = db.addToPlaylist(c.args.playlistId, c.args.contentId, c.options.trackNumber);
      db.commit();
      return row;
    } finally {
      db.close();
    }
  },
});

databasePlaylistCli.command("remove-track", {
  description: "Remove a playlist-membership row.",
  args: z.object({
    playlistId: z.string().describe("Playlist ID"),
    songId: z.string().describe("djmdSongPlaylist ID"),
  }),
  options: dbWriteOptions,
  run(c) {
    const db = openDatabase(c.options, true);
    try {
      db.removeFromPlaylist(c.args.playlistId, c.args.songId);
      db.commit();
      return { playlistId: c.args.playlistId, removed: c.args.songId };
    } finally {
      db.close();
    }
  },
});

databasePlaylistCli.command("move", {
  description: "Move a playlist to another parent and/or sequence.",
  args: z.object({ playlistId: z.string().describe("Playlist ID") }),
  options: dbWriteOptions.extend({
    parent: z.string().optional().describe("New parent folder ID"),
    seq: z.number().int().positive().optional().describe("New one-based sequence"),
  }),
  run(c) {
    const db = openDatabase(c.options, true);
    try {
      db.movePlaylist(c.args.playlistId, { parent: c.options.parent, seq: c.options.seq });
      db.commit();
      return db.query(DjmdPlaylist).where({ ID: c.args.playlistId }).one();
    } finally {
      db.close();
    }
  },
});

databasePlaylistCli.command("rename", {
  description: "Rename a playlist or folder.",
  args: z.object({
    playlistId: z.string().describe("Playlist ID"),
    name: z.string().describe("New name"),
  }),
  options: dbWriteOptions,
  run(c) {
    const db = openDatabase(c.options, true);
    try {
      db.renamePlaylist(c.args.playlistId, c.args.name);
      db.commit();
      return db.query(DjmdPlaylist).where({ ID: c.args.playlistId }).one();
    } finally {
      db.close();
    }
  },
});

databasePlaylistCli.command("delete", {
  description: "Delete a playlist subtree and resequence its siblings.",
  args: z.object({ playlistId: z.string().describe("Playlist or folder ID") }),
  options: dbWriteOptions,
  run(c) {
    const db = openDatabase(c.options, true);
    try {
      const row = db.query(DjmdPlaylist).where({ ID: c.args.playlistId }).one();
      const deleted = row.toJSON();
      db.deletePlaylist(row);
      db.commit();
      return { deleted };
    } finally {
      db.close();
    }
  },
});

databasePlaylistCli.command("move-track", {
  description: "Move a playlist-membership row to a new one-based track number.",
  args: z.object({
    playlistId: z.string().describe("Playlist ID"),
    songId: z.string().describe("djmdSongPlaylist ID"),
    trackNumber: z.number().int().positive().describe("New one-based track number"),
  }),
  options: dbWriteOptions,
  run(c) {
    const db = openDatabase(c.options, true);
    try {
      db.moveSongInPlaylist(c.args.playlistId, c.args.songId, c.args.trackNumber);
      db.commit();
      return db.query(DjmdSongPlaylist).where({ ID: c.args.songId }).one();
    } finally {
      db.close();
    }
  },
});

databaseCli.command(databaseRowCli);
databaseCli.command(databaseContentCli);
databaseCli.command(databaseMetadataCli);
databaseCli.command(databasePlaylistCli);
rekordboxCli.command(databaseCli);

const deviceOpenOptions = z.object({
  path: z.string().describe("exportLibrary.db path"),
  plain: z.boolean().default(false).describe("Open an unencrypted SQLite database"),
});
const deviceWriteOptions = deviceOpenOptions;

function openDeviceLibrary(
  options: { path: string; plain: boolean },
  write = false,
): DeviceLibraryPlus {
  return new DeviceLibraryPlus({
    key: process.env.REKORDBOX_DEVICE_DB_KEY,
    path: options.path,
    readonly: !write,
    unlock: !options.plain,
  });
}

const deviceCli = Cli.create("device", {
  description: "Query and mutate Device Library Plus exportLibrary.db databases.",
});

deviceCli.command("info", {
  description: "Show Device Library Plus tables and high-level counts.",
  options: deviceOpenOptions,
  run(c) {
    const db = openDeviceLibrary(c.options);
    try {
      return {
        contentCount: db.hasTable("content") ? db.query(DeviceContent).count() : 0,
        path: db.path,
        playlistCount: db.hasTable("playlist") ? db.query(DevicePlaylist).count() : 0,
        readonly: db.readonly,
        tables: db.tableNames,
      };
    } finally {
      db.close();
    }
  },
});

deviceCli.command("table", {
  description: "List rows from any Device Library Plus physical table.",
  args: z.object({ table: z.string().describe("Physical table name") }),
  options: deviceOpenOptions.extend({
    descending: z.boolean().default(false).describe("Use descending order"),
    filters: z.string().default("{}").describe("JSON object of equality filters"),
    limit: z.number().int().min(1).max(100_000).default(100).describe("Maximum rows"),
    offset: z.number().int().min(0).default(0).describe("Rows to skip"),
    orderBy: z.string().optional().describe("Physical column to order by"),
  }),
  run(c) {
    const db = openDeviceLibrary(c.options);
    try {
      const model = deviceModelByTable[c.args.table];
      let query = model ? db.query(model) : db.query(c.args.table);
      query = query.where(parseJsonObject(c.options.filters, "filters"));
      if (c.options.orderBy)
        query = query.orderBy(c.options.orderBy, c.options.descending ? "desc" : "asc");
      const count = query.count();
      return {
        count,
        limit: c.options.limit,
        offset: c.options.offset,
        rows: query.offset(c.options.offset).limit(c.options.limit).all(),
        table: c.args.table,
      };
    } finally {
      db.close();
    }
  },
});

deviceCli.command("search", {
  description: "Search exported tracks and joined artist/album/genre/key metadata.",
  args: z.object({ text: z.string().describe("Case-insensitive search text") }),
  options: deviceOpenOptions.extend({
    limit: z.number().int().min(1).max(100_000).default(100),
    offset: z.number().int().min(0).default(0),
  }),
  run(c) {
    const db = openDeviceLibrary(c.options);
    try {
      const rows = db.searchContent(c.args.text);
      return {
        count: rows.length,
        rows: rows.slice(c.options.offset, c.options.offset + c.options.limit),
      };
    } finally {
      db.close();
    }
  },
});

deviceCli.command("sql", {
  description: "Execute parameterized SQL against a Device Library Plus database.",
  args: z.object({ sql: z.string().describe("SQLite statement") }),
  options: deviceWriteOptions.extend({
    parameters: z.string().default("[]").describe("JSON array of bind parameters"),
    limit: z.number().int().min(1).max(100_000).default(1_000),
    offset: z.number().int().min(0).default(0),
  }),
  run(c) {
    const db = openDeviceLibrary(c.options, true);
    try {
      const result = db.executeSql(c.args.sql, parseJsonArray(c.options.parameters, "parameters"));
      if (Array.isArray(result))
        return {
          count: result.length,
          limit: c.options.limit,
          offset: c.options.offset,
          rows: result.slice(c.options.offset, c.options.offset + c.options.limit),
        };
      return { changes: result.changes, lastInsertRowid: String(result.lastInsertRowid) };
    } finally {
      db.close();
    }
  },
});

deviceCli.command("copy-unlocked", {
  description: "Copy a decrypted Device Library Plus database into a plain SQLite file.",
  args: z.object({ output: z.string().describe("New destination database") }),
  options: deviceOpenOptions,
  async run(c) {
    const db = openDeviceLibrary(c.options);
    try {
      await db.copyUnlocked(c.args.output);
      return { output: c.args.output, source: db.path, tables: db.tableNames.length };
    } finally {
      db.close();
    }
  },
});

const deviceRowCli = Cli.create("row", {
  description: "Generic Device Library Plus row mutations.",
});

deviceRowCli.command("create", {
  description: "Insert a mapped row from physical-column JSON.",
  args: z.object({
    table: z.string().describe("Physical table name"),
    values: z.string().describe("JSON object of physical column values"),
  }),
  options: deviceWriteOptions,
  run(c) {
    const db = openDeviceLibrary(c.options, true);
    try {
      const model = deviceModelByTable[c.args.table];
      if (!model) throw new TypeError(`No mapped Device Library Plus table '${c.args.table}'`);
      const row = db.create(model, parseJsonObject(c.args.values, "values"));
      db.commit();
      return { row, table: c.args.table };
    } finally {
      db.close();
    }
  },
});

deviceRowCli.command("update", {
  description: "Update exactly one row selected by equality-filter JSON.",
  args: z.object({
    table: z.string().describe("Physical table name"),
    filters: z.string().describe("JSON object selecting exactly one row"),
    values: z.string().describe("JSON object of physical column updates"),
  }),
  options: deviceWriteOptions,
  run(c) {
    const db = openDeviceLibrary(c.options, true);
    try {
      const model = deviceModelByTable[c.args.table];
      if (!model) throw new TypeError(`No mapped Device Library Plus table '${c.args.table}'`);
      const row = db.query(model).where(parseJsonObject(c.args.filters, "filters")).one();
      for (const [key, value] of Object.entries(parseJsonObject(c.args.values, "values")))
        row.set(key, value as DatabaseValue);
      db.commit();
      return { row, table: c.args.table };
    } finally {
      db.close();
    }
  },
});

deviceRowCli.command("delete", {
  description: "Delete exactly one row selected by equality-filter JSON.",
  args: z.object({
    table: z.string().describe("Physical table name"),
    filters: z.string().describe("JSON object selecting exactly one row"),
  }),
  options: deviceWriteOptions,
  run(c) {
    const db = openDeviceLibrary(c.options, true);
    try {
      const model = deviceModelByTable[c.args.table];
      if (!model) throw new TypeError(`No mapped Device Library Plus table '${c.args.table}'`);
      const row = db.query(model).where(parseJsonObject(c.args.filters, "filters")).one();
      const deleted = row.toJSON();
      db.delete(row);
      db.commit();
      return { deleted, table: c.args.table };
    } finally {
      db.close();
    }
  },
});

const deviceContentCli = Cli.create("content", {
  description: "Create Device Library Plus content rows.",
});

const deviceMetadataCli = Cli.create("metadata", {
  description: "Create common Device Library Plus metadata rows.",
});

deviceMetadataCli.command("add", {
  description: "Add a named artist, genre, label, color, key, image, or album.",
  args: z.object({
    type: z.enum(["artist", "genre", "label", "color", "key", "image", "album"]),
    value: z.string().describe("Metadata name, or image path"),
  }),
  options: deviceWriteOptions.extend({
    artistId: z.number().int().positive().optional().describe("Album artist ID"),
    imageId: z.number().int().positive().optional().describe("Album image ID"),
    compilation: z.boolean().default(false).describe("Mark an album as a compilation"),
    searchString: z.string().optional().describe("Artist or album search string"),
  }),
  run(c) {
    const db = openDeviceLibrary(c.options, true);
    try {
      const row =
        c.args.type === "artist"
          ? db.addArtist(c.args.value, c.options.searchString)
          : c.args.type === "genre"
            ? db.addGenre(c.args.value)
            : c.args.type === "label"
              ? db.addLabel(c.args.value)
              : c.args.type === "color"
                ? db.addColor(c.args.value)
                : c.args.type === "key"
                  ? db.addKey(c.args.value)
                  : c.args.type === "image"
                    ? db.addImage(c.args.value)
                    : db.addAlbum(c.args.value, {
                        artistId: c.options.artistId,
                        imageId: c.options.imageId,
                        isCompilation: c.options.compilation,
                        searchString: c.options.searchString,
                      });
      db.commit();
      return row;
    } finally {
      db.close();
    }
  },
});

deviceContentCli.command("add", {
  description: "Add an existing audio file to an export library.",
  args: z.object({
    audioPath: z.string().describe("Existing audio file"),
    fileType: z.number().int().positive().describe("Device Library Plus file-type number"),
  }),
  options: deviceWriteOptions.extend({
    analysisPath: z.string().optional(),
    bitDepth: z.number().int().min(0).default(0),
    bitrate: z.number().int().min(0).default(0),
    samplingRate: z.number().int().min(0).default(0),
    values: z.string().default("{}").describe("Additional physical-column JSON"),
  }),
  run(c) {
    const db = openDeviceLibrary(c.options, true);
    try {
      const row = db.addContent(c.args.audioPath, c.args.fileType, {
        analysisPath: c.options.analysisPath,
        bitDepth: c.options.bitDepth,
        bitrate: c.options.bitrate,
        samplingRate: c.options.samplingRate,
        values: parseJsonObject(c.options.values, "values"),
      });
      if (db.hasTable("property") && db.getProperty().count()) db.updateContentCount();
      db.commit();
      return row;
    } finally {
      db.close();
    }
  },
});

const devicePlaylistCli = Cli.create("playlist", {
  description: "Query and mutate Device Library Plus playlists.",
});

devicePlaylistCli.command("contents", {
  description: "List playlist memberships and their content rows.",
  args: z.object({ playlistId: z.number().int().nonnegative().describe("Playlist ID") }),
  options: deviceOpenOptions.extend({
    limit: z.number().int().min(1).max(100_000).default(100),
    offset: z.number().int().min(0).default(0),
  }),
  run(c) {
    const db = openDeviceLibrary(c.options);
    try {
      const query = db
        .query(DevicePlaylistContent)
        .where({ playlist_id: c.args.playlistId })
        .orderBy("sequenceNo");
      const rows = query
        .offset(c.options.offset)
        .limit(c.options.limit)
        .all()
        .map((membership) => ({ content: membership.content, membership }));
      return { count: query.count(), rows };
    } finally {
      db.close();
    }
  },
});

devicePlaylistCli.command("create", {
  description: "Create a playlist or playlist folder.",
  args: z.object({ name: z.string().describe("Playlist name") }),
  options: deviceWriteOptions.extend({
    imageId: z.number().int().positive().optional(),
    parentId: z.number().int().nonnegative().default(0),
    sequenceNo: z.number().int().positive().optional(),
    type: z.enum(["playlist", "folder"]).default("playlist"),
  }),
  run(c) {
    const db = openDeviceLibrary(c.options, true);
    try {
      const options = {
        parentId: c.options.parentId,
        sequenceNo: c.options.sequenceNo,
      };
      const row =
        c.options.type === "folder"
          ? db.addPlaylistFolder(c.args.name, options)
          : db.addPlaylist(c.args.name, { ...options, imageId: c.options.imageId });
      db.commit();
      return row;
    } finally {
      db.close();
    }
  },
});

devicePlaylistCli.command("add-track", {
  description: "Add a content row to a playlist.",
  args: z.object({
    playlistId: z.number().int().positive(),
    contentId: z.number().int().positive(),
  }),
  options: deviceWriteOptions.extend({
    sequenceNo: z.number().int().positive().optional(),
  }),
  run(c) {
    const db = openDeviceLibrary(c.options, true);
    try {
      const row = db.addPlaylistContent(c.args.playlistId, c.args.contentId, c.options.sequenceNo);
      db.commit();
      return row;
    } finally {
      db.close();
    }
  },
});

const deviceTagCli = Cli.create("tag", {
  description: "Create Device Library Plus My Tags and assignments.",
});

deviceTagCli.command("create", {
  description: "Create a My Tag or tag folder.",
  args: z.object({ name: z.string().describe("Tag name") }),
  options: deviceWriteOptions.extend({
    attribute: z.number().int().default(0),
    parentId: z.number().int().nonnegative().default(0),
    sequenceNo: z.number().int().positive().optional(),
  }),
  run(c) {
    const db = openDeviceLibrary(c.options, true);
    try {
      const row = db.addMyTag(c.args.name, {
        attribute: c.options.attribute,
        parentId: c.options.parentId,
        sequenceNo: c.options.sequenceNo,
      });
      db.commit();
      return row;
    } finally {
      db.close();
    }
  },
});

deviceTagCli.command("add-track", {
  description: "Assign a My Tag to a content row.",
  args: z.object({
    tagId: z.number().int().positive(),
    contentId: z.number().int().positive(),
  }),
  options: deviceWriteOptions,
  run(c) {
    const db = openDeviceLibrary(c.options, true);
    try {
      const row = db.addMyTagContent(c.args.tagId, c.args.contentId);
      db.commit();
      return row;
    } finally {
      db.close();
    }
  },
});

deviceCli.command(deviceRowCli);
deviceCli.command(deviceContentCli);
deviceCli.command(deviceMetadataCli);
deviceCli.command(devicePlaylistCli);
deviceCli.command(deviceTagCli);
rekordboxCli.command(deviceCli);

function playlistPath(xml: RekordboxXml, path: string | undefined) {
  return path ? xml.getPlaylist(...path.split("/").filter(Boolean)) : xml.rootPlaylistFolder;
}

function trackSelector(options: {
  index?: number;
  location?: string;
  trackId?: number;
}): TrackSelector {
  if (options.trackId !== undefined) return { trackId: options.trackId };
  if (options.location !== undefined) return { location: options.location };
  return { index: options.index ?? 0 };
}

const xmlCli = Cli.create("xml", {
  description: "Read and write Rekordbox collection XML files.",
});

xmlCli.command("info", {
  description: "Show collection, product, and playlist metadata.",
  args: z.object({ path: z.string().describe("Rekordbox XML file") }),
  run(c) {
    return new RekordboxXml(c.args.path).summary();
  },
});

xmlCli.command("tracks", {
  description: "List typed collection track metadata.",
  args: z.object({ path: z.string().describe("Rekordbox XML file") }),
  options: z.object({
    limit: z.number().int().min(1).max(10_000).default(100).describe("Maximum tracks to return"),
    offset: z.number().int().min(0).default(0).describe("Tracks to skip"),
  }),
  run(c) {
    const xml = new RekordboxXml(c.args.path);
    return {
      count: xml.numTracks,
      limit: c.options.limit,
      offset: c.options.offset,
      tracks: xml.getTracks().slice(c.options.offset, c.options.offset + c.options.limit),
    };
  },
});

xmlCli.command("playlists", {
  description: "Show a playlist subtree.",
  args: z.object({ path: z.string().describe("Rekordbox XML file") }),
  options: z.object({
    playlist: z.string().optional().describe("Slash-delimited playlist path"),
  }),
  run(c) {
    const xml = new RekordboxXml(c.args.path);
    const node = playlistPath(xml, c.options.playlist);
    return { node: node.toJSON(), tree: node.treeString() };
  },
});

xmlCli.command("create", {
  description: "Create an empty Rekordbox XML file.",
  args: z.object({ output: z.string().describe("Destination XML file") }),
  options: z.object({
    company: z.string().default("").describe("Product company"),
    formatVersion: z.string().default("1.0.0").describe("Rekordbox XML format version"),
    name: z.string().default("rekordbox-ts").describe("Product name"),
    version: z.string().default("0.0.0").describe("Product version"),
  }),
  run(c) {
    const xml = new RekordboxXml({
      company: c.options.company,
      formatVersion: c.options.formatVersion,
      name: c.options.name,
      version: c.options.version,
    });
    xml.save(c.args.output);
    return { output: c.args.output, ...xml.summary() };
  },
});

const xmlTrackCli = Cli.create("track", {
  description: "Inspect and mutate XML collection tracks.",
});

xmlTrackCli.command("show", {
  description: "Show one track selected by index, ID, or location.",
  args: z.object({ path: z.string().describe("Rekordbox XML file") }),
  options: z.object({
    index: z.number().int().min(0).optional().describe("Zero-based collection index"),
    location: z.string().optional().describe("Track filesystem location"),
    trackId: z.number().int().optional().describe("Track ID"),
  }),
  run(c) {
    return new RekordboxXml(c.args.path).getTrack(trackSelector(c.options));
  },
});

xmlTrackCli.command("add", {
  description: "Add a track and save the XML document.",
  args: z.object({
    path: z.string().describe("Rekordbox XML file"),
    location: z.string().describe("Audio-file location"),
  }),
  options: z.object({
    album: z.string().optional().describe("Album"),
    artist: z.string().optional().describe("Artist"),
    genre: z.string().optional().describe("Genre"),
    name: z.string().optional().describe("Track title"),
    output: z.string().optional().describe("Destination; defaults to the source file"),
    rating: z.number().int().min(0).max(5).optional().describe("Rating from zero to five"),
    trackId: z.number().int().positive().optional().describe("Explicit track ID"),
  }),
  run(c) {
    const xml = new RekordboxXml(c.args.path);
    const attributes: TrackAttributes = {
      Album: c.options.album,
      Artist: c.options.artist,
      Genre: c.options.genre,
      Name: c.options.name,
      Rating: c.options.rating,
      TrackID: c.options.trackId,
    };
    const track = xml.addTrack(c.args.location, attributes);
    const output = c.options.output ?? c.args.path;
    xml.save(output);
    return { output, track };
  },
});

xmlTrackCli.command("remove", {
  description: "Remove a track and save the XML document.",
  args: z.object({ path: z.string().describe("Rekordbox XML file") }),
  options: z.object({
    location: z.string().optional().describe("Track filesystem location"),
    output: z.string().optional().describe("Destination; defaults to the source file"),
    trackId: z.number().int().optional().describe("Track ID"),
  }),
  run(c) {
    if (c.options.trackId === undefined && c.options.location === undefined)
      throw new TypeError("Either --track-id or --location is required");
    const xml = new RekordboxXml(c.args.path);
    const selector: TrackSelector =
      c.options.trackId !== undefined
        ? { trackId: c.options.trackId }
        : { location: c.options.location! };
    const track = xml.getTrack(selector);
    const removed = track.toJSON();
    xml.removeTrack(track);
    const output = c.options.output ?? c.args.path;
    xml.save(output);
    return { output, removed };
  },
});

const xmlPlaylistCli = Cli.create("playlist", {
  description: "Inspect and mutate XML playlists and folders.",
});

xmlPlaylistCli.command("add", {
  description: "Add a playlist or folder and save the XML document.",
  args: z.object({
    path: z.string().describe("Rekordbox XML file"),
    name: z.string().describe("New playlist or folder name"),
  }),
  options: z.object({
    folder: z.boolean().default(false).describe("Create a folder instead of a playlist"),
    keyType: z.enum(["TrackID", "Location"]).default("TrackID").describe("Playlist key type"),
    output: z.string().optional().describe("Destination; defaults to the source file"),
    parent: z.string().optional().describe("Slash-delimited parent folder path"),
  }),
  run(c) {
    const xml = new RekordboxXml(c.args.path);
    const parent = playlistPath(xml, c.options.parent);
    const node = c.options.folder
      ? parent.addPlaylistFolder(c.args.name)
      : parent.addPlaylist(c.args.name, c.options.keyType as NodeKeyType);
    const output = c.options.output ?? c.args.path;
    xml.save(output);
    return { node: node.toJSON(), output };
  },
});

xmlPlaylistCli.command("remove", {
  description: "Remove a playlist or folder and save the XML document.",
  args: z.object({
    path: z.string().describe("Rekordbox XML file"),
    name: z.string().describe("Playlist or folder name"),
  }),
  options: z.object({
    output: z.string().optional().describe("Destination; defaults to the source file"),
    parent: z.string().optional().describe("Slash-delimited parent folder path"),
  }),
  run(c) {
    const xml = new RekordboxXml(c.args.path);
    playlistPath(xml, c.options.parent).removePlaylist(c.args.name);
    const output = c.options.output ?? c.args.path;
    xml.save(output);
    return { output, removed: c.args.name };
  },
});

xmlPlaylistCli.command("add-track", {
  description: "Add a track key to a playlist and save the XML document.",
  args: z.object({
    path: z.string().describe("Rekordbox XML file"),
    playlist: z.string().describe("Slash-delimited playlist path"),
    key: z.string().describe("Track ID or location, according to playlist KeyType"),
  }),
  options: z.object({
    output: z.string().optional().describe("Destination; defaults to the source file"),
  }),
  run(c) {
    const xml = new RekordboxXml(c.args.path);
    const playlist = playlistPath(xml, c.args.playlist);
    const key = playlist.keyType === "TrackID" ? Number.parseInt(c.args.key, 10) : c.args.key;
    playlist.addTrack(key);
    const output = c.options.output ?? c.args.path;
    xml.save(output);
    return { entries: playlist.entries, key, output, playlist: c.args.playlist };
  },
});

xmlPlaylistCli.command("remove-track", {
  description: "Remove a track key from a playlist and save the XML document.",
  args: z.object({
    path: z.string().describe("Rekordbox XML file"),
    playlist: z.string().describe("Slash-delimited playlist path"),
    key: z.string().describe("Track ID or location, according to playlist KeyType"),
  }),
  options: z.object({
    output: z.string().optional().describe("Destination; defaults to the source file"),
  }),
  run(c) {
    const xml = new RekordboxXml(c.args.path);
    const playlist = playlistPath(xml, c.args.playlist);
    const key = playlist.keyType === "TrackID" ? Number.parseInt(c.args.key, 10) : c.args.key;
    playlist.removeTrack(key);
    const output = c.options.output ?? c.args.path;
    xml.save(output);
    return { entries: playlist.entries, key, output, playlist: c.args.playlist };
  },
});

xmlCli.command(xmlTrackCli);
xmlCli.command(xmlPlaylistCli);
rekordboxCli.command(xmlCli);

export async function runRekordboxCli(argv = process.argv.slice(2)): Promise<void> {
  await rekordboxCli.serve(argv);
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) await runRekordboxCli();

export default rekordboxCli;
