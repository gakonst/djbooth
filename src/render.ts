import { TracksError } from "./errors.js";
import { parseManifest, type SetManifest } from "./manifest.js";
import { formatTimestamp, parseTimestamp } from "./time.js";
import type { Tracklist, TracklistEntry, TracklistOverlap } from "./types.js";

export type RenderStyle = "text" | "youtube" | "cue";

export interface RenderOptions {
  style?: RenderStyle;
  audioFile?: string;
}

export function renderTracklist(tracklist: Tracklist, options: RenderOptions = {}): string {
  switch (options.style ?? "text") {
    case "text":
      return renderText(tracklist.tracks);
    case "youtube":
      return renderYoutube(tracklist);
    case "cue":
      return renderCue(tracklist, options.audioFile ?? "set.mp3");
  }
}

export function parseTracklistJson(value: unknown): Tracklist {
  const outer = asRecord(value);
  const candidate = asRecord(outer.data ?? value);
  if (candidate.kind === "dj-set-pipeline") {
    return tracklistFromManifest(parseManifest(candidate));
  }
  if (!Array.isArray(candidate.tracks)) {
    throw new TracksError("INVALID_SOURCE", "JSON does not contain a manifest or tracks array", {
      exitCode: 2,
    });
  }
  const tracks = candidate.tracks.map((item, index) => parseEntry(item, index));
  const lineup = stringArray(candidate.lineup);
  const warnings = stringArray(candidate.warnings);
  const durationSeconds = numberValue(candidate.durationSeconds);
  const sampledEverySeconds = numberValue(candidate.sampledEverySeconds);
  return {
    source: typeof candidate.source === "string" ? candidate.source : "imported JSON",
    ...(typeof candidate.sourceId === "string" ? { sourceId: candidate.sourceId } : {}),
    provider: isProvider(candidate.provider) ? candidate.provider : "audd",
    complete: candidate.complete === true,
    tracks,
    ...(typeof candidate.title === "string" ? { title: candidate.title } : {}),
    ...(typeof candidate.url === "string" ? { url: candidate.url } : {}),
    ...(typeof candidate.uploader === "string" ? { uploader: candidate.uploader } : {}),
    ...(typeof candidate.date === "string" ? { date: candidate.date } : {}),
    ...(lineup ? { lineup } : {}),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    ...(sampledEverySeconds === undefined ? {} : { sampledEverySeconds }),
    ...(warnings ? { warnings } : {}),
  };
}

function tracklistFromManifest(manifest: SetManifest): Tracklist {
  return {
    source: manifest.source.input,
    ...(manifest.source.id ? { sourceId: manifest.source.id } : {}),
    provider: manifest.tracklist.provider,
    ...(manifest.source.title ? { title: manifest.source.title } : {}),
    ...(manifest.source.url ? { url: manifest.source.url } : {}),
    ...(manifest.source.uploader ? { uploader: manifest.source.uploader } : {}),
    ...(manifest.source.date ? { date: manifest.source.date } : {}),
    ...(manifest.source.lineup ? { lineup: [...manifest.source.lineup] } : {}),
    ...(manifest.source.durationSeconds === undefined
      ? {}
      : { durationSeconds: manifest.source.durationSeconds }),
    ...(manifest.tracklist.sampledEverySeconds === undefined
      ? {}
      : { sampledEverySeconds: manifest.tracklist.sampledEverySeconds }),
    complete: manifest.tracklist.complete,
    tracks: manifest.entries.map((entry) => {
      const { status: _status, searchQuery: _searchQuery, ...identity } = entry.identity;
      return { order: entry.order, ...entry.cue, ...identity };
    }),
    ...(manifest.warnings.length ? { warnings: [...manifest.warnings] } : {}),
    ...(manifest.tracklist.matches ? { matches: manifest.tracklist.matches } : {}),
  };
}

function renderText(tracks: readonly TracklistEntry[]): string {
  const lines: string[] = [];
  for (const track of tracks) {
    const timestamp = entryTimestamp(track);
    lines.push(`${timestamp}  ${trackName(track)}${track.label ? `  [${track.label}]` : ""}`);
    for (const overlap of track.overlaps ?? []) {
      lines.push(`${" ".repeat(timestamp.length)}  w/ ${overlap.artist} — ${overlap.title}`);
    }
  }
  return lines.join("\n");
}

function renderYoutube(tracklist: Tracklist): string {
  requirePositions(tracklist.tracks, "YouTube chapters");
  const lines = tracklist.tracks.map(
    (track) => `${youtubeTimestamp(entrySeconds(track))} ${trackName(track)}`,
  );
  if (tracklist.tracks.length && Math.floor(entrySeconds(tracklist.tracks[0]!)) > 0) {
    lines.unshift(`00:00 ${tracklist.title ?? "Intro"}`);
  }
  return lines.join("\n");
}

function renderCue(tracklist: Tracklist, audioFile: string): string {
  requirePositions(tracklist.tracks, "CUE export");
  const lines = [
    `TITLE ${cueQuote(tracklist.title ?? "DJ set")}`,
    `FILE ${cueQuote(audioFile)} ${cueFileType(audioFile)}`,
  ];
  for (const track of tracklist.tracks) {
    const order = String(track.order).padStart(2, "0");
    lines.push(`  TRACK ${order} AUDIO`);
    lines.push(`    TITLE ${cueQuote(track.title ?? "ID")}`);
    if (track.artist) lines.push(`    PERFORMER ${cueQuote(track.artist)}`);
    lines.push(`    INDEX 01 ${cueTimestamp(entrySeconds(track))}`);
  }
  return lines.join("\n");
}

function parseEntry(value: unknown, index: number): TracklistEntry {
  const item = asRecord(value);
  const startSeconds =
    numberValue(item.startSeconds) ??
    (typeof item.timestamp === "string" ? parseTimestamp(item.timestamp) : undefined);
  const endSeconds = numberValue(item.endSeconds);
  const confidence = numberValue(item.confidence);
  const overlaps = Array.isArray(item.overlaps)
    ? item.overlaps
        .map(parseOverlap)
        .filter((overlap): overlap is NonNullable<typeof overlap> => overlap !== undefined)
    : [];
  return {
    order: numberValue(item.order) ?? index + 1,
    ...(typeof item.isId === "boolean" ? { isId: item.isId } : {}),
    ...(startSeconds === undefined
      ? typeof item.timestamp === "string"
        ? { timestamp: item.timestamp }
        : {}
      : { startSeconds, timestamp: formatTimestamp(startSeconds) }),
    ...(endSeconds === undefined ? {} : { endSeconds }),
    ...(typeof item.artist === "string" ? { artist: item.artist } : {}),
    ...(typeof item.title === "string" ? { title: item.title } : {}),
    ...(typeof item.mix === "string" ? { mix: item.mix } : {}),
    ...(typeof item.album === "string" ? { album: item.album } : {}),
    ...(typeof item.label === "string" ? { label: item.label } : {}),
    ...(typeof item.releaseDate === "string" ? { releaseDate: item.releaseDate } : {}),
    ...(typeof item.isrc === "string" ? { isrc: item.isrc } : {}),
    ...(typeof item.upc === "string" ? { upc: item.upc } : {}),
    ...(typeof item.songLink === "string" ? { songLink: item.songLink } : {}),
    ...(confidence === undefined ? {} : { confidence }),
    ...(overlaps.length ? { overlaps } : {}),
  };
}

function parseOverlap(value: unknown): TracklistOverlap | undefined {
  const item = asRecord(value);
  if (typeof item.artist !== "string" || typeof item.title !== "string") return undefined;
  const confidence = numberValue(item.confidence);
  return {
    artist: item.artist,
    title: item.title,
    ...(confidence === undefined ? {} : { confidence }),
  };
}

function entrySeconds(track: TracklistEntry): number {
  return track.startSeconds ?? parseTimestamp(track.timestamp) ?? 0;
}

function entryTimestamp(track: TracklistEntry): string {
  return track.timestamp ?? formatTimestamp(track.startSeconds ?? 0);
}

function trackName(track: TracklistEntry): string {
  if (track.artist && track.title) return `${track.artist} — ${track.title}`;
  return track.title ?? track.artist ?? "ID";
}

function youtubeTimestamp(seconds: number): string {
  const full = formatTimestamp(seconds);
  return full.startsWith("00:") ? full.slice(3) : full.replace(/^0/, "");
}

function cueTimestamp(seconds: number): string {
  const frames = Math.floor((seconds % 1) * 75);
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}:${String(frames).padStart(2, "0")}`;
}

function cueQuote(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function cueFileType(audioFile: string): "AIFF" | "MP3" | "WAVE" {
  const extension = audioFile.toLocaleLowerCase().split(".").at(-1);
  if (extension === "mp3") return "MP3";
  if (extension === "aif" || extension === "aiff") return "AIFF";
  return "WAVE";
}

function requirePositions(tracks: readonly TracklistEntry[], format: string): void {
  const missing = tracks.find(
    (track) => track.startSeconds === undefined && parseTimestamp(track.timestamp) === undefined,
  );
  if (missing) {
    throw new TracksError(
      "INVALID_SOURCE",
      `${format} requires timestamps; track ${missing.order} has no source position`,
      { exitCode: 2 },
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function isProvider(value: unknown): value is Tracklist["provider"] {
  return (
    value === "description" ||
    value === "1001tracklists" ||
    value === "audd" ||
    value === "acrcloud"
  );
}
