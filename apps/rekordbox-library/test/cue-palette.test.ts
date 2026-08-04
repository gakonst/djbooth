import { describe, expect, it } from "vitest";

import {
  normalizeHotCuePaletteIndex,
  REKORDBOX_HOT_CUE_PALETTE,
  rekordboxHotCueColor,
  resolveCueColorFields,
} from "../src/client/cue-palette.js";

describe("Rekordbox Hot Cue palette", () => {
  it("keeps the verified ColorTableIndex boundaries and hue transitions", () => {
    expect(REKORDBOX_HOT_CUE_PALETTE).toHaveLength(63);
    expect(REKORDBOX_HOT_CUE_PALETTE[0]).toBeNull();
    expect([
      REKORDBOX_HOT_CUE_PALETTE[1],
      REKORDBOX_HOT_CUE_PALETTE[8],
      REKORDBOX_HOT_CUE_PALETTE[9],
      REKORDBOX_HOT_CUE_PALETTE[19],
      REKORDBOX_HOT_CUE_PALETTE[33],
      REKORDBOX_HOT_CUE_PALETTE[34],
      REKORDBOX_HOT_CUE_PALETTE[43],
      REKORDBOX_HOT_CUE_PALETTE[50],
      REKORDBOX_HOT_CUE_PALETTE[54],
      REKORDBOX_HOT_CUE_PALETTE[62],
    ]).toEqual([
      "#305aff",
      "#45acdb",
      "#00e0ff",
      "#30d26e",
      "#e1aa00",
      "#ffa000",
      "#ff376f",
      "#de448d",
      "#dc00ff",
      "#6473ff",
    ]);
    expect(rekordboxHotCueColor(0)).toBeUndefined();
    expect(rekordboxHotCueColor(62)).toBe("#6473ff");
    expect(normalizeHotCuePaletteIndex(63)).toBe(0);
  });

  it("writes Rekordbox Hot Cue sentinel fields for new and explicitly selected colors", () => {
    expect(
      resolveCueColorFields({
        kind: "hot",
        paletteIndex: 62,
        paletteChanged: false,
      }),
    ).toEqual({ color: 255, colorTableIndex: 62 });

    expect(
      resolveCueColorFields({
        kind: "hot",
        existing: { kind: "hot", color: 7, colorTableIndex: 12 },
        paletteIndex: 0,
        paletteChanged: true,
      }),
    ).toEqual({ color: 255, colorTableIndex: 0 });
  });

  it("preserves untouched raw fields and keeps memory cues palette-neutral", () => {
    const raw = { kind: "hot" as const, color: -1, colorTableIndex: 255 };
    expect(
      resolveCueColorFields({
        kind: "hot",
        existing: raw,
        paletteIndex: 0,
        paletteChanged: false,
      }),
    ).toEqual({ color: -1, colorTableIndex: 255 });

    expect(
      resolveCueColorFields({
        kind: "memory",
        paletteIndex: 42,
        paletteChanged: true,
      }),
    ).toEqual({ color: null, colorTableIndex: null });
  });
});
