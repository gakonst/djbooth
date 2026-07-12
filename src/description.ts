import { formatTimestamp, parseTimestamp } from "./time.js";
import type { MediaMetadata } from "./integrations/ytdlp.js";
import type { Tracklist, TracklistEntry, TracklistOverlap } from "./types.js";

export interface DescriptionParseResult {
  tracks: TracklistEntry[];
  timestampedLines: number;
  identifiedLines: number;
}

export function parseDescriptionTracklist(text: string): DescriptionParseResult {
  const tracks: TracklistEntry[] = [];
  let timestampedLines = 0;
  let identifiedLines = 0;

  for (const line of text.split(/\r?\n/)) {
    const parsed = parseTimestampedLine(line);
    if (!parsed) continue;
    timestampedLines += 1;
    const { primary, overlaps } = parseTrackText(parsed.text);
    if (!primary.isId && primary.artist && primary.title) identifiedLines += 1;
    tracks.push({
      order: tracks.length + 1,
      timestamp: formatTimestamp(parsed.seconds),
      startSeconds: parsed.seconds,
      ...(primary.artist ? { artist: primary.artist } : {}),
      ...(primary.title ? { title: primary.title } : {}),
      ...(primary.isId === undefined ? {} : { isId: primary.isId }),
      ...(overlaps.length ? { overlaps } : {}),
    });
  }

  return { tracks, timestampedLines, identifiedLines };
}

export function tracklistFromDescription(
  source: string,
  metadata: MediaMetadata,
): Tracklist | undefined {
  if (!metadata.description) return undefined;
  const parsed = parseDescriptionTracklist(metadata.description);
  if (parsed.tracks.length < 2 || parsed.identifiedLines < 1) return undefined;
  const unresolvedCount = parsed.tracks.filter(
    (track) => track.isId || !track.artist || !track.title,
  ).length;
  return {
    source,
    ...(metadata.id ? { sourceId: metadata.id } : {}),
    provider: "description",
    ...(metadata.title ? { title: metadata.title } : {}),
    ...(metadata.webpageUrl ? { url: metadata.webpageUrl } : { url: source }),
    ...(metadata.uploader ? { uploader: metadata.uploader } : {}),
    ...(metadata.durationSeconds === undefined
      ? {}
      : { durationSeconds: metadata.durationSeconds }),
    complete: true,
    tracks: parsed.tracks,
    ...(unresolvedCount
      ? {
          warnings: [
            `${unresolvedCount} description entr${unresolvedCount === 1 ? "y is" : "ies are"} not directly searchable.`,
          ],
        }
      : {}),
  };
}

function parseTimestampedLine(line: string): { seconds: number; text: string } | undefined {
  const leading = line.match(
    /^\s*[[(]?((?:\d{1,3}:)?\d{1,2}:\d{2}(?:\.\d+)?)[\])]?\s*(?:[-–—|:]\s*)?(.*)$/,
  );
  if (leading) {
    const seconds = parseTimestamp(leading[1]);
    const text = cleanTrackText(leading[2] ?? "");
    if (seconds !== undefined && text) return { seconds, text };
  }

  const trailing = line.match(/^\s*(.*?)\s*[[(]((?:\d{1,3}:)?\d{1,2}:\d{2}(?:\.\d+)?)[\])]\s*$/);
  if (!trailing) return undefined;
  const seconds = parseTimestamp(trailing[2]);
  const text = cleanTrackText(trailing[1] ?? "");
  return seconds === undefined || !text ? undefined : { seconds, text };
}

function cleanTrackText(value: string): string {
  return value
    .trim()
    .replace(/^\d{1,3}\s*[.)]\s*/, "")
    .replace(/^[-–—|:]\s*/, "")
    .trim();
}

function parseTrackText(text: string): {
  primary: { artist?: string; title?: string; isId?: boolean };
  overlaps: TracklistOverlap[];
} {
  const [primaryText, ...overlapTexts] = text.split(/\s+w\/\s+/i);
  const primary = splitArtistTitle(primaryText ?? text);
  const overlaps = overlapTexts
    .map(splitArtistTitle)
    .filter((track): track is { artist: string; title: string; isId?: boolean } =>
      Boolean(track.artist && track.title),
    )
    .map((track) => ({ artist: track.artist, title: track.title }));
  return { primary, overlaps };
}

function splitArtistTitle(text: string): {
  artist?: string;
  title?: string;
  isId?: boolean;
} {
  const value = text.trim();
  for (const separator of [" — ", " – ", " - ", " | "]) {
    const index = value.indexOf(separator);
    if (index <= 0) continue;
    const artist = value.slice(0, index).trim();
    const title = value.slice(index + separator.length).trim();
    if (!artist || !title) continue;
    return {
      artist,
      title,
      isId:
        /^(?:id|\?|unknown)(?:\s*-\s*(?:id|\?|unknown))?$/i.test(title) ||
        /^(?:id|\?|unknown)$/i.test(artist),
    };
  }
  return {
    title: value,
    isId: /^(?:id|\?|unknown)(?:\s*-\s*(?:id|\?|unknown))?$/i.test(value),
  };
}
