import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { MasterDatabase } from "@gakonst/rekordbox/masterdb";

import { sha256File } from "./acquisition.js";
import { TracksError, errorMessage } from "./errors.js";
import { mapConcurrent, runProcess } from "./process.js";
import { acquireRekordboxDatabaseLock } from "./rekordbox-db.js";

const LOUDNESS_TABLE = "djboothAudioLoudness";
const MEASUREMENT_METHOD = "ffmpeg-loudnorm-v1";

export type RekordboxLoudnessScope = { kind: "library" } | { kind: "folder"; name: string };

export type AudioLoudnessMeasurement = {
  integratedLufs: number;
  loudnessRangeLu: number;
  truePeakDbtp: number;
  thresholdLufs: number;
};

export type RekordboxLoudnessRecord = AudioLoudnessMeasurement & {
  contentId: string;
  title: string;
  artist?: string;
  path: string;
  artifactSha256: string;
  artifactSize: number;
  artifactMtimeMs: number;
  measurementMethod: typeof MEASUREMENT_METHOD;
  measuredAt: string;
};

export type RekordboxLoudnessFailure = {
  contentId: string;
  title: string;
  path?: string;
  message: string;
};

export type AnalyzeRekordboxLoudnessOptions = {
  dbPath?: string;
  dbDirectory?: string;
  folder?: string;
  ffmpeg?: string;
  concurrency?: number;
  refresh?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: RekordboxLoudnessProgress) => void;
};

export type RekordboxLoudnessProgress = {
  phase: "inventory" | "measure" | "write";
  current: number;
  total: number;
  message: string;
};

export type AnalyzeRekordboxLoudnessResult = {
  dbPath: string;
  scope: RekordboxLoudnessScope;
  tracks: number;
  measured: number;
  reused: number;
  failed: number;
  records: RekordboxLoudnessRecord[];
  failures: RekordboxLoudnessFailure[];
};

export type InspectRekordboxLoudnessOptions = Pick<
  AnalyzeRekordboxLoudnessOptions,
  "dbPath" | "dbDirectory" | "folder"
>;

export type InspectRekordboxLoudnessResult = {
  dbPath: string;
  scope: RekordboxLoudnessScope;
  tracks: number;
  measured: number;
  missing: number;
  records: RekordboxLoudnessRecord[];
};

export type LoudnessNormalizationPlanEntry = RekordboxLoudnessRecord & {
  requestedGainDb: number;
  gainDb: number;
  projectedTruePeakDbtp: number;
  ceilingLimited: boolean;
};

export type LoudnessNormalizationPlan = {
  targetLufs: number;
  targetSource: "explicit" | "median";
  truePeakCeilingDbtp: number;
  measured: number;
  ceilingLimited: number;
  entries: LoudnessNormalizationPlanEntry[];
};

export type PlanRekordboxLoudnessNormalizationOptions = InspectRekordboxLoudnessOptions & {
  targetLufs?: number;
  truePeakCeilingDbtp?: number;
};

export type PlanRekordboxLoudnessNormalizationResult = LoudnessNormalizationPlan & {
  dbPath: string;
  scope: RekordboxLoudnessScope;
  tracks: number;
  missing: number;
  dryRun: true;
};

type LibraryTrack = {
  contentId: string;
  title: string;
  artist?: string;
  path?: string;
};

type StoredLoudnessRow = {
  ContentID: string;
  ArtifactSha256: string;
  ArtifactSize: number;
  ArtifactMtimeMs: number;
  Path: string;
  IntegratedLufs: number;
  LoudnessRangeLu: number;
  TruePeakDbtp: number;
  ThresholdLufs: number;
  MeasurementMethod: string;
  MeasuredAt: string;
};

/** Measure one complete audio stream according to EBU R128, including inter-sample true peak. */
export async function measureAudioLoudness(
  path: string,
  options: { ffmpeg?: string; signal?: AbortSignal } = {},
): Promise<AudioLoudnessMeasurement> {
  const absolutePath = resolve(path);
  const result = await runProcess(
    options.ffmpeg ?? process.env.FFMPEG_PATH ?? "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-i",
      absolutePath,
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-dn",
      "-filter:a",
      "loudnorm=I=-23:LRA=7:TP=-1:print_format=json",
      "-f",
      "null",
      "-",
    ],
    options.signal ? { signal: options.signal } : {},
  );
  return parseLoudnormOutput(result.stderr, absolutePath);
}

/** Analyze a Rekordbox library and persist artifact-bound measurements in master.db. */
export async function analyzeRekordboxLoudness(
  options: AnalyzeRekordboxLoudnessOptions = {},
): Promise<AnalyzeRekordboxLoudnessResult> {
  const { database, dbPath, dbDirectory } = openReader(options);
  const folder = options.folder?.trim() || undefined;
  const scope: RekordboxLoudnessScope = folder
    ? { kind: "folder", name: folder }
    : { kind: "library" };
  let tracks: LibraryTrack[];
  let stored: Map<string, RekordboxLoudnessRecord>;
  try {
    tracks = readLibraryTracks(database, folder);
    stored = readStoredLoudness(database, tracks);
  } finally {
    database.close();
  }

  options.onProgress?.({
    phase: "inventory",
    current: tracks.length,
    total: tracks.length,
    message: `${String(tracks.length)} unique tracks in ${folder ?? "the Rekordbox library"}`,
  });

  let completed = 0;
  const outcomes = await mapConcurrent(tracks, options.concurrency ?? 2, async (track) => {
    try {
      if (!track.path) throw new Error("Track has no local audio path");
      const path = resolve(track.path);
      const artifact = await stat(path);
      if (!artifact.isFile()) throw new Error("Local audio path is not a file");
      const existing = stored.get(track.contentId);
      if (
        !options.refresh &&
        existing &&
        existing.path === path &&
        existing.artifactSize === artifact.size &&
        existing.artifactMtimeMs === artifact.mtimeMs
      ) {
        return { kind: "reused" as const, record: withTrackMetadata(existing, track) };
      }
      const [measurement, artifactSha256] = await Promise.all([
        measureAudioLoudness(path, {
          ...(options.ffmpeg ? { ffmpeg: options.ffmpeg } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        }),
        sha256File(path),
      ]);
      return {
        kind: "measured" as const,
        record: {
          ...measurement,
          contentId: track.contentId,
          title: track.title,
          ...(track.artist ? { artist: track.artist } : {}),
          path,
          artifactSha256,
          artifactSize: artifact.size,
          artifactMtimeMs: artifact.mtimeMs,
          measurementMethod: MEASUREMENT_METHOD,
          measuredAt: new Date().toISOString(),
        } satisfies RekordboxLoudnessRecord,
      };
    } catch (error) {
      return {
        kind: "failed" as const,
        failure: {
          contentId: track.contentId,
          title: track.title,
          ...(track.path ? { path: track.path } : {}),
          message: errorMessage(error),
        } satisfies RekordboxLoudnessFailure,
      };
    } finally {
      completed += 1;
      options.onProgress?.({
        phase: "measure",
        current: completed,
        total: tracks.length,
        message: `Measured or reused ${String(completed)}/${String(tracks.length)}`,
      });
    }
  });

  const measured = outcomes.flatMap((outcome) =>
    outcome.kind === "measured" ? [outcome.record] : [],
  );
  if (measured.length) {
    const releaseLock = await acquireRekordboxDatabaseLock(dbPath, { durability: "session" });
    try {
      const writer = new MasterDatabase({
        path: dbPath,
        dbDirectory,
        playlistXml: false,
        readonly: false,
        unlock: true,
      });
      try {
        ensureLoudnessTable(writer);
        for (const [index, record] of measured.entries()) {
          writeStoredLoudness(writer, record);
          options.onProgress?.({
            phase: "write",
            current: index + 1,
            total: measured.length,
            message: `Stored loudness ${String(index + 1)}/${String(measured.length)}`,
          });
        }
      } finally {
        writer.close();
      }
    } finally {
      await releaseLock();
    }
  }

  const records = outcomes.flatMap((outcome) =>
    outcome.kind === "failed" ? [] : [outcome.record],
  );
  const failures = outcomes.flatMap((outcome) =>
    outcome.kind === "failed" ? [outcome.failure] : [],
  );
  return {
    dbPath,
    scope,
    tracks: tracks.length,
    measured: measured.length,
    reused: outcomes.filter((outcome) => outcome.kind === "reused").length,
    failed: failures.length,
    records,
    failures,
  };
}

/** Read current artifact-bound measurements without touching audio or the database. */
export function inspectRekordboxLoudness(
  options: InspectRekordboxLoudnessOptions = {},
): InspectRekordboxLoudnessResult {
  const { database, dbPath } = openReader(options);
  const folder = options.folder?.trim() || undefined;
  const scope: RekordboxLoudnessScope = folder
    ? { kind: "folder", name: folder }
    : { kind: "library" };
  try {
    const tracks = readLibraryTracks(database, folder);
    const stored = readStoredLoudness(database, tracks);
    const records = tracks.flatMap((track) => {
      const record = stored.get(track.contentId);
      return record ? [withTrackMetadata(record, track)] : [];
    });
    return {
      dbPath,
      scope,
      tracks: tracks.length,
      measured: records.length,
      missing: tracks.length - records.length,
      records,
    };
  } finally {
    database.close();
  }
}

/** Plan level matching with static gain only; this never modifies tags, audio, or mixer rows. */
export function planRekordboxLoudnessNormalization(
  options: PlanRekordboxLoudnessNormalizationOptions = {},
): PlanRekordboxLoudnessNormalizationResult {
  const inspected = inspectRekordboxLoudness(options);
  const plan = planLoudnessNormalization(inspected.records, options);
  return { ...inspected, ...plan, dryRun: true };
}

/** Pure normalization planner used by library consumers and level-matched quality comparisons. */
export function planLoudnessNormalization(
  records: readonly RekordboxLoudnessRecord[],
  options: Pick<
    PlanRekordboxLoudnessNormalizationOptions,
    "targetLufs" | "truePeakCeilingDbtp"
  > = {},
): LoudnessNormalizationPlan {
  if (!records.length) {
    throw new TracksError(
      "INVALID_SOURCE",
      "No stored loudness measurements are available; run loudness analyze first",
      { exitCode: 2 },
    );
  }
  const targetLufs = options.targetLufs ?? median(records.map((record) => record.integratedLufs));
  const truePeakCeilingDbtp = options.truePeakCeilingDbtp ?? -1;
  if (!Number.isFinite(targetLufs)) throw new TypeError("Target LUFS must be finite");
  if (!Number.isFinite(truePeakCeilingDbtp) || truePeakCeilingDbtp > 0) {
    throw new TypeError("True-peak ceiling must be finite and no greater than 0 dBTP");
  }
  const entries = records.map((record) => {
    const requestedGainDb = targetLufs - record.integratedLufs;
    const maximumSafeGainDb = truePeakCeilingDbtp - record.truePeakDbtp;
    const gainDb = Math.min(requestedGainDb, maximumSafeGainDb);
    const ceilingLimited = gainDb < requestedGainDb - 1e-9;
    return {
      ...record,
      requestedGainDb,
      gainDb,
      projectedTruePeakDbtp: record.truePeakDbtp + gainDb,
      ceilingLimited,
    };
  });
  return {
    targetLufs,
    targetSource: options.targetLufs === undefined ? "median" : "explicit",
    truePeakCeilingDbtp,
    measured: records.length,
    ceilingLimited: entries.filter((entry) => entry.ceilingLimited).length,
    entries,
  };
}

function parseLoudnormOutput(stderr: string, path: string): AudioLoudnessMeasurement {
  const blocks = stderr.match(/\{\s*"input_i"[\s\S]*?\}/gu);
  const block = blocks?.at(-1);
  if (!block) {
    throw new TracksError("INVALID_RESPONSE", `ffmpeg returned no loudness JSON for ${path}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(block);
  } catch (error) {
    throw new TracksError("INVALID_RESPONSE", `ffmpeg returned invalid loudness JSON for ${path}`, {
      cause: error,
    });
  }
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    integratedLufs: loudnessNumber(record.input_i, "integrated loudness", path),
    loudnessRangeLu: loudnessNumber(record.input_lra, "loudness range", path),
    truePeakDbtp: loudnessNumber(record.input_tp, "true peak", path),
    thresholdLufs: loudnessNumber(record.input_thresh, "relative threshold", path),
  };
}

function loudnessNumber(value: unknown, name: string, path: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new TracksError("INVALID_RESPONSE", `ffmpeg returned invalid ${name} for ${path}`);
  }
  return parsed;
}

function openReader(options: InspectRekordboxLoudnessOptions): {
  database: MasterDatabase;
  dbPath: string;
  dbDirectory: string;
} {
  const database = new MasterDatabase({
    ...(options.dbPath ? { path: resolve(options.dbPath) } : {}),
    ...(options.dbDirectory ? { dbDirectory: resolve(options.dbDirectory) } : {}),
    playlistXml: false,
    readonly: true,
    unlock: true,
  });
  return { database, dbPath: database.path, dbDirectory: database.dbDirectory };
}

function readLibraryTracks(database: MasterDatabase, folder?: string): LibraryTrack[] {
  const select = `SELECT DISTINCT content."ID" AS contentId, content."Title" AS title,
                          content."FolderPath" AS path, artist."Name" AS artist
                     FROM "djmdContent" content
                     LEFT JOIN "djmdArtist" artist ON artist."ID" = content."ArtistID"`;
  const rows = folder
    ? database.selectRawRows(
        `${select}
          WHERE content."ID" IN (
            SELECT membership."ContentID"
              FROM "djmdSongPlaylist" membership
              JOIN "djmdPlaylist" playlist ON playlist."ID" = membership."PlaylistID"
              JOIN "djmdPlaylist" parent ON parent."ID" = playlist."ParentID"
             WHERE parent."Name" = ? AND parent."Attribute" = 1 AND playlist."Attribute" = 0
          )
          ORDER BY artist."Name", content."Title"`,
        [folder],
      )
    : database.selectRawRows(`${select} ORDER BY artist."Name", content."Title"`);
  if (folder && !rows.length) {
    throw new TracksError("INVALID_SOURCE", `No tracks found under '${folder}'`, { exitCode: 2 });
  }
  return rows.map((row) => {
    const artist = cleanText(row.artist);
    const path = cleanText(row.path);
    return {
      contentId: String(row.contentId),
      title: cleanText(row.title) ?? "Untitled",
      ...(artist ? { artist } : {}),
      ...(path ? { path } : {}),
    };
  });
}

function readStoredLoudness(
  database: MasterDatabase,
  tracks: readonly LibraryTrack[],
): Map<string, RekordboxLoudnessRecord> {
  if (!database.hasTable(LOUDNESS_TABLE)) return new Map();
  const rows = database.selectRawRows<StoredLoudnessRow>(
    `SELECT "ContentID", "ArtifactSha256", "ArtifactSize", "ArtifactMtimeMs", "Path",
            "IntegratedLufs", "LoudnessRangeLu", "TruePeakDbtp", "ThresholdLufs",
            "MeasurementMethod", "MeasuredAt"
       FROM "${LOUDNESS_TABLE}"`,
  );
  const metadata = new Map(tracks.map((track) => [track.contentId, track]));
  return new Map(
    rows.flatMap((row) => {
      const track = metadata.get(row.ContentID);
      if (!track || row.MeasurementMethod !== MEASUREMENT_METHOD) return [];
      return [
        [
          row.ContentID,
          {
            contentId: row.ContentID,
            title: track.title,
            ...(track.artist ? { artist: track.artist } : {}),
            path: resolve(row.Path),
            artifactSha256: row.ArtifactSha256,
            artifactSize: Number(row.ArtifactSize),
            artifactMtimeMs: Number(row.ArtifactMtimeMs),
            integratedLufs: Number(row.IntegratedLufs),
            loudnessRangeLu: Number(row.LoudnessRangeLu),
            truePeakDbtp: Number(row.TruePeakDbtp),
            thresholdLufs: Number(row.ThresholdLufs),
            measurementMethod: MEASUREMENT_METHOD,
            measuredAt: row.MeasuredAt,
          },
        ] as const,
      ];
    }),
  );
}

function ensureLoudnessTable(database: MasterDatabase): void {
  database.executeSql(
    `CREATE TABLE IF NOT EXISTS "${LOUDNESS_TABLE}" (
       "ContentID" TEXT PRIMARY KEY NOT NULL,
       "ArtifactSha256" TEXT NOT NULL,
       "ArtifactSize" INTEGER NOT NULL,
       "ArtifactMtimeMs" REAL NOT NULL,
       "Path" TEXT NOT NULL,
       "IntegratedLufs" REAL NOT NULL,
       "LoudnessRangeLu" REAL NOT NULL,
       "TruePeakDbtp" REAL NOT NULL,
       "ThresholdLufs" REAL NOT NULL,
       "MeasurementMethod" TEXT NOT NULL,
       "MeasuredAt" TEXT NOT NULL
     )`,
  );
}

function writeStoredLoudness(database: MasterDatabase, record: RekordboxLoudnessRecord): void {
  database.executeSql(
    `INSERT INTO "${LOUDNESS_TABLE}" (
       "ContentID", "ArtifactSha256", "ArtifactSize", "ArtifactMtimeMs", "Path",
       "IntegratedLufs", "LoudnessRangeLu", "TruePeakDbtp", "ThresholdLufs",
       "MeasurementMethod", "MeasuredAt"
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT("ContentID") DO UPDATE SET
       "ArtifactSha256" = excluded."ArtifactSha256",
       "ArtifactSize" = excluded."ArtifactSize",
       "ArtifactMtimeMs" = excluded."ArtifactMtimeMs",
       "Path" = excluded."Path",
       "IntegratedLufs" = excluded."IntegratedLufs",
       "LoudnessRangeLu" = excluded."LoudnessRangeLu",
       "TruePeakDbtp" = excluded."TruePeakDbtp",
       "ThresholdLufs" = excluded."ThresholdLufs",
       "MeasurementMethod" = excluded."MeasurementMethod",
       "MeasuredAt" = excluded."MeasuredAt"`,
    [
      record.contentId,
      record.artifactSha256,
      record.artifactSize,
      record.artifactMtimeMs,
      record.path,
      record.integratedLufs,
      record.loudnessRangeLu,
      record.truePeakDbtp,
      record.thresholdLufs,
      record.measurementMethod,
      record.measuredAt,
    ],
  );
}

function withTrackMetadata(
  record: RekordboxLoudnessRecord,
  track: LibraryTrack,
): RekordboxLoudnessRecord {
  const { artist: _artist, ...rest } = record;
  return {
    ...rest,
    title: track.title,
    ...(track.artist ? { artist: track.artist } : {}),
  };
}

function cleanText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function median(values: readonly number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}
