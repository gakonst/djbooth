import { formatTimestamp } from "./time.js";
import type { RecognitionMoment, TrackMatch, TracklistEntry, TracklistOverlap } from "./types.js";

export interface TimelineOptions {
  minScore?: number;
  blendScore?: number;
  maxBlipGapSeconds?: number;
}

export function buildTimeline(
  moments: readonly RecognitionMoment[],
  options: TimelineOptions = {},
): TracklistEntry[] {
  const minScore = options.minScore ?? 40;
  const blendScore = options.blendScore ?? 50;
  const maxBlipGapSeconds = options.maxBlipGapSeconds ?? 120;
  const selected = [...moments]
    .sort((a, b) => a.offsetSeconds - b.offsetSeconds)
    .map((moment) => {
      const candidates = uniqueMatches(moment.matches).sort(
        (a, b) => (b.confidence ?? 100) - (a.confidence ?? 100),
      );
      const primary = candidates.find((match) => (match.confidence ?? 100) >= minScore);
      if (!primary) return undefined;
      return {
        primary,
        overlaps: candidates
          .filter((match) => trackKey(match) !== trackKey(primary))
          .filter((match) => (match.confidence ?? 0) >= blendScore)
          .map(toOverlap),
      };
    })
    .filter((item): item is { primary: TrackMatch; overlaps: TracklistOverlap[] } => Boolean(item));
  const cleaned = removeSingleMomentBlips(selected, blendScore, maxBlipGapSeconds);
  const entries: TracklistEntry[] = [];
  let previousKey: string | undefined;

  for (const { primary, overlaps } of cleaned) {
    const key = trackKey(primary);
    if (key === previousKey) {
      const entry = entries.at(-1);
      mergeOverlaps(entry, overlaps);
      if (
        entry &&
        primary.endSeconds !== undefined &&
        primary.endSeconds > (entry.endSeconds ?? 0)
      ) {
        entry.endSeconds = round(primary.endSeconds);
      }
      continue;
    }

    entries.push({
      order: entries.length + 1,
      timestamp: formatTimestamp(primary.startSeconds),
      startSeconds: round(primary.startSeconds),
      ...(primary.endSeconds === undefined ? {} : { endSeconds: round(primary.endSeconds) }),
      artist: primary.artist,
      title: primary.title,
      ...(primary.album ? { album: primary.album } : {}),
      ...(primary.label ? { label: primary.label } : {}),
      ...(primary.releaseDate ? { releaseDate: primary.releaseDate } : {}),
      ...(primary.isrc ? { isrc: primary.isrc } : {}),
      ...(primary.upc ? { upc: primary.upc } : {}),
      ...(primary.songLink ? { songLink: primary.songLink } : {}),
      ...(primary.confidence === undefined ? {} : { confidence: primary.confidence }),
      ...(overlaps.length ? { overlaps } : {}),
    });
    previousKey = key;
  }

  return entries;
}

function uniqueMatches(matches: readonly TrackMatch[]): TrackMatch[] {
  const strongest = new Map<string, TrackMatch>();
  for (const match of matches) {
    const key = trackKey(match);
    const current = strongest.get(key);
    if (!current || (match.confidence ?? 100) > (current.confidence ?? 100)) {
      strongest.set(key, match);
    }
  }
  return [...strongest.values()];
}

function trackKey(match: Pick<TrackMatch, "artist" | "title">): string {
  return `${normalize(match.artist)}\u0000${normalize(match.title)}`;
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{Z}]+/gu, " ")
    .trim();
}

function toOverlap(match: TrackMatch): TracklistOverlap {
  return {
    artist: match.artist,
    title: match.title,
    ...(match.confidence === undefined ? {} : { confidence: match.confidence }),
  };
}

function mergeOverlaps(entry: TracklistEntry | undefined, overlaps: TracklistOverlap[]): void {
  if (!entry || !overlaps.length) return;
  const known = new Set((entry.overlaps ?? []).map((item) => `${item.artist}\u0000${item.title}`));
  const additions = overlaps.filter((item) => !known.has(`${item.artist}\u0000${item.title}`));
  if (additions.length) entry.overlaps = [...(entry.overlaps ?? []), ...additions];
}

/** Remove only a single low-confidence scan between two scans of the same track. */
function removeSingleMomentBlips(
  selected: { primary: TrackMatch; overlaps: TracklistOverlap[] }[],
  blendScore: number,
  maxGapSeconds: number,
): { primary: TrackMatch; overlaps: TracklistOverlap[] }[] {
  if (selected.length < 3) return selected;
  return selected.filter((current, index) => {
    const before = selected[index - 1];
    const after = selected[index + 1];
    if (
      before &&
      after &&
      trackKey(before.primary) === trackKey(after.primary) &&
      trackKey(current.primary) !== trackKey(before.primary) &&
      current.primary.startSeconds - before.primary.startSeconds <= maxGapSeconds &&
      after.primary.startSeconds - current.primary.startSeconds <= maxGapSeconds &&
      (current.primary.confidence ?? 100) <
        Math.min(before.primary.confidence ?? 100, after.primary.confidence ?? 100)
    ) {
      if ((current.primary.confidence ?? 0) >= blendScore) {
        const overlap = toOverlap(current.primary);
        if (!before.overlaps.some((item) => overlapKey(item) === overlapKey(overlap))) {
          before.overlaps.push(overlap);
        }
      }
      return false;
    }
    return true;
  });
}

function overlapKey(overlap: TracklistOverlap): string {
  return `${normalize(overlap.artist)}\u0000${normalize(overlap.title)}`;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
