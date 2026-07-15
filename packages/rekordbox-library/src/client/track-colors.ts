import type { TrackColorId } from "../shared/types.js";

export type TrackColor = {
  id: TrackColorId;
  name: string;
  value: string;
};

/** Rekordbox's fixed track-color IDs, in the order shown by Rekordbox and CDJs. */
export const TRACK_COLOR_PALETTE: readonly TrackColor[] = [
  { id: "1", name: "Pink", value: "#e65aa5" },
  { id: "2", name: "Red", value: "#e34b55" },
  { id: "3", name: "Orange", value: "#ef8a3a" },
  { id: "4", name: "Yellow", value: "#e7ce45" },
  { id: "5", name: "Green", value: "#38bd70" },
  { id: "6", name: "Aqua", value: "#35bfd0" },
  { id: "7", name: "Blue", value: "#4f7de8" },
  { id: "8", name: "Purple", value: "#9a65dc" },
];

export function rekordboxTrackColor(id: TrackColorId | null | undefined): TrackColor | undefined {
  return TRACK_COLOR_PALETTE.find((color) => color.id === id);
}
