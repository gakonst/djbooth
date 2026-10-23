// The library application owns the persisted show schema; the stage consumes it.
export * from "../../djbooth/src/shared/visual-presets.js";
import { DEFAULT_VISUAL_LOOK, type VisualLook } from "../../djbooth/src/shared/visual-presets.js";

export function initialVisualLook(visual: string | null): VisualLook {
  return visual === "race"
    ? { ...DEFAULT_VISUAL_LOOK, theme: "eighties", intensity: 0.9, density: 0.8 }
    : { ...DEFAULT_VISUAL_LOOK };
}
