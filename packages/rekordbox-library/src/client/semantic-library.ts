import type { TrackSummary } from "../shared/types.js";

export type LibraryCandidateQuery = {
  bpmMin?: number;
  bpmMax?: number;
  genreTerms?: string[];
  textTerms?: string[];
  limit?: number;
};

export type LibraryFacets = {
  sampledTracks: number;
  playableTracks: number;
  bpmRange: { min: number; max: number } | null;
  bpmBuckets: Array<{ range: string; count: number }>;
  genres: Array<{ name: string; count: number }>;
};

/** Distinguish recommendation/set intent from a literal catalog metadata lookup. */
export function isSemanticDiscoveryRequest(prompt: string): boolean {
  return /\b(?:vibe|mood|energy|warm[- ]?up|opening set|peak[- ]?time|after[- ]?hours|late[- ]?night|recommend|curate|selection|tracks? for)\b/iu.test(
    prompt,
  );
}

/** Summarize the bounded local catalog without sending paths or every track to the model. */
export function summarizeLibraryCatalog(tracks: readonly TrackSummary[]): LibraryFacets {
  const playable = tracks.filter((track) => track.fileExists);
  const bpms = playable.flatMap((track) => (track.bpm && track.bpm > 0 ? [track.bpm] : []));
  const genres = new Map<string, { name: string; count: number }>();
  const bpmBuckets = new Map<number, number>();
  for (const track of playable) {
    const genre = track.genre?.trim();
    if (genre) {
      const key = genre.toLocaleLowerCase();
      const current = genres.get(key);
      genres.set(key, { name: current?.name ?? genre, count: (current?.count ?? 0) + 1 });
    }
    if (track.bpm && track.bpm > 0) {
      const floor = Math.floor(track.bpm / 10) * 10;
      bpmBuckets.set(floor, (bpmBuckets.get(floor) ?? 0) + 1);
    }
  }
  return {
    sampledTracks: tracks.length,
    playableTracks: playable.length,
    bpmRange: bpms.length ? { min: Math.min(...bpms), max: Math.max(...bpms) } : null,
    bpmBuckets: [...bpmBuckets.entries()]
      .sort(([left], [right]) => left - right)
      .map(([floor, count]) => ({ range: `${String(floor)}–${String(floor + 9)}`, count })),
    genres: [...genres.values()]
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
      .slice(0, 48),
  };
}

/** Filter and quality-rank a diverse candidate pool for model-side semantic curation. */
export function selectLibraryCandidates(
  tracks: readonly TrackSummary[],
  query: LibraryCandidateQuery,
): TrackSummary[] {
  const genreTerms = normalizedTerms(query.genreTerms);
  const textTerms = normalizedTerms(query.textTerms);
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? 80), 8), 120);
  const ranked = tracks
    .filter((track) => {
      if (!track.fileExists) return false;
      if (query.bpmMin !== undefined && (!track.bpm || track.bpm < query.bpmMin)) return false;
      if (query.bpmMax !== undefined && (!track.bpm || track.bpm > query.bpmMax)) return false;
      const genre = track.genre?.toLocaleLowerCase() ?? "";
      if (genreTerms.length && !genreTerms.some((term) => genre.includes(term))) return false;
      if (textTerms.length) {
        const haystack = searchableText(track);
        if (!textTerms.some((term) => haystack.includes(term))) return false;
      }
      return true;
    })
    .map((track) => ({ track, score: candidateScore(track, genreTerms, textTerms) }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        (left.track.artist ?? "").localeCompare(right.track.artist ?? "") ||
        left.track.title.localeCompare(right.track.title),
    );

  const selected: TrackSummary[] = [];
  const selectedIds = new Set<string>();
  const artistCounts = new Map<string, number>();
  for (const { track } of ranked) {
    const artist = track.artist?.toLocaleLowerCase() ?? `unknown:${track.id}`;
    if ((artistCounts.get(artist) ?? 0) >= 2) continue;
    selected.push(track);
    selectedIds.add(track.id);
    artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + 1);
    if (selected.length >= limit) return selected;
  }
  for (const { track } of ranked) {
    if (selectedIds.has(track.id)) continue;
    selected.push(track);
    if (selected.length >= limit) break;
  }
  return selected;
}

/** Resolve model-selected IDs back to authoritative catalog rows, preserving requested order. */
export function resolveTemporaryCrateTracks(
  tracks: readonly TrackSummary[],
  trackIds: readonly string[],
  maximum = 50,
): TrackSummary[] {
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const seen = new Set<string>();
  const resolved: TrackSummary[] = [];
  for (const id of trackIds) {
    if (seen.has(id)) continue;
    const track = byId.get(id);
    if (!track) throw new RangeError(`Track '${id}' is not in the inspected library catalog`);
    seen.add(id);
    resolved.push(track);
    if (resolved.length >= maximum) break;
  }
  return resolved;
}

/** Remove filesystem-only fields before returning candidates to the model. */
export function modelTrack(track: TrackSummary): Omit<TrackSummary, "path"> {
  const { path: _path, ...safe } = track;
  return safe;
}

function normalizedTerms(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim().toLocaleLowerCase()).filter(Boolean);
}

function searchableText(track: TrackSummary): string {
  return [track.title, track.artist, track.album, track.genre, track.key]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLocaleLowerCase();
}

function candidateScore(
  track: TrackSummary,
  genreTerms: readonly string[],
  textTerms: readonly string[],
): number {
  const haystack = searchableText(track);
  const relevance = [...genreTerms, ...textTerms].reduce(
    (score, term) => score + (haystack.includes(term) ? 24 : 0),
    0,
  );
  return (
    relevance +
    track.rating * 8 +
    Math.log2(track.playCount + 1) * 5 +
    (track.analyzed ? 4 : 0) +
    (track.artworkAvailable ? 1 : 0)
  );
}
