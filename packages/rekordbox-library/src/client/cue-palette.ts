import type { TrackCue } from "../shared/types.js";

/**
 * Rekordbox Hot Cue palette, indexed exactly by djmdCue.ColorTableIndex.
 *
 * Recovered by Deep Symmetry's Beat Link `CueList.findRekordboxColor`; index 0 means the
 * device/default color and deliberately has no invented RGB value.
 */
export const REKORDBOX_HOT_CUE_PALETTE = [
  null,
  "#305aff",
  "#5073ff",
  "#508cff",
  "#50a0ff",
  "#50b4ff",
  "#50b0f2",
  "#50aee8",
  "#45acdb",
  "#00e0ff",
  "#19daf0",
  "#32d2e6",
  "#21b4b9",
  "#20aaa0",
  "#1fa392",
  "#19a08c",
  "#14a584",
  "#14aa7d",
  "#10b176",
  "#30d26e",
  "#37de5a",
  "#3ceb50",
  "#28e214",
  "#7dc13d",
  "#8cc832",
  "#9bd723",
  "#a5e116",
  "#a5dc0a",
  "#aad208",
  "#b4c805",
  "#b4be04",
  "#bab404",
  "#c3af04",
  "#e1aa00",
  "#ffa000",
  "#ff9600",
  "#ff8c00",
  "#ff7500",
  "#e0641b",
  "#e0461e",
  "#e0301e",
  "#e02823",
  "#e62828",
  "#ff376f",
  "#ff2d6f",
  "#ff127b",
  "#f51e8c",
  "#eb2da0",
  "#e637b4",
  "#de44cf",
  "#de448d",
  "#e630b4",
  "#e619dc",
  "#e600ff",
  "#dc00ff",
  "#cc00ff",
  "#b432ff",
  "#b93cff",
  "#c542ff",
  "#aa5aff",
  "#aa72ff",
  "#8272ff",
  "#6473ff",
] as const;

export type CueColorFields = {
  color: number | null;
  colorTableIndex: number | null;
};

export function normalizeHotCuePaletteIndex(value: number | null | undefined): number {
  return Number.isInteger(value) &&
    value !== undefined &&
    value !== null &&
    value >= 0 &&
    value <= 62
    ? value
    : 0;
}

export function rekordboxHotCueColor(index: number | null | undefined): string | undefined {
  const normalized = normalizeHotCuePaletteIndex(index);
  return REKORDBOX_HOT_CUE_PALETTE[normalized] ?? undefined;
}

/**
 * Preserve raw database color fields unless the user explicitly chooses a Hot Cue palette entry.
 * Rekordbox expects Color=255 alongside the selected ColorTableIndex for custom Hot Cue colors.
 */
export function resolveCueColorFields({
  kind,
  existing,
  paletteIndex,
  paletteChanged,
}: {
  kind: "memory" | "hot";
  existing?: Pick<TrackCue, "color" | "colorTableIndex" | "kind">;
  paletteIndex: number;
  paletteChanged: boolean;
}): CueColorFields {
  const preserved = {
    color: existing?.color ?? null,
    colorTableIndex: existing?.colorTableIndex ?? null,
  };
  if (kind !== "hot") return preserved;
  if (existing?.kind === "hot" && !paletteChanged) return preserved;
  return {
    color: 255,
    colorTableIndex: normalizeHotCuePaletteIndex(paletteIndex),
  };
}
