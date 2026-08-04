import type { TrackMetadataInput } from "./types.js";

function cleanMetadataValue(value: string | null): string | null {
  const cleaned = value?.trim();
  return cleaned ? cleaned : null;
}

/** Normalize deterministic metadata fields identically before optimistic display and SQLite write. */
export function normalizeTrackMetadataInput(metadata: TrackMetadataInput): TrackMetadataInput {
  return {
    ...metadata,
    title: metadata.title.trim(),
    artist: cleanMetadataValue(metadata.artist),
    album: cleanMetadataValue(metadata.album),
    ...(metadata.label === undefined ? {} : { label: cleanMetadataValue(metadata.label) }),
    genre: cleanMetadataValue(metadata.genre),
    key: cleanMetadataValue(metadata.key),
    bpm: metadata.bpm === null ? null : Math.round(metadata.bpm * 100) / 100,
    comment: cleanMetadataValue(metadata.comment),
    isrc: cleanMetadataValue(metadata.isrc),
  };
}
