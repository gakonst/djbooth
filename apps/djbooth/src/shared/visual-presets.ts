export type VisualTheme = "halloween" | "eighties" | "y2k" | "tech-house";
export type VisualLook = {
  theme: VisualTheme;
  intensity: number;
  motion: number;
  density: number;
  halloween: number;
};
export type SavedVisualPreset = { id: string; name: string; look: VisualLook };
export type VisualCue = { id: string; presetId: string; label: string; minutes: number };
export type VisualShow = {
  version: 1;
  presets: SavedVisualPreset[];
  cues: VisualCue[];
  loop: boolean;
};
export const DEFAULT_VISUAL_LOOK: VisualLook = {
  theme: "halloween",
  intensity: 1,
  motion: 1,
  density: 1,
  halloween: 1,
};
export function defaultVisualShow(): VisualShow {
  return {
    version: 1,
    presets: [
      {
        id: "eighties",
        name: "80s · Neon midnight",
        look: { theme: "eighties", intensity: 0.75, motion: 0.65, density: 0.7, halloween: 0.35 },
      },
      {
        id: "y2k",
        name: "2000s · Pop / R&B",
        look: { theme: "y2k", intensity: 1, motion: 1, density: 0.9, halloween: 0.45 },
      },
      {
        id: "tech-house",
        name: "Tech house · After dark",
        look: { theme: "tech-house", intensity: 1.25, motion: 1.15, density: 1, halloween: 0.6 },
      },
      { id: "halloween", name: "Halloween · Haunted booth", look: { ...DEFAULT_VISUAL_LOOK } },
    ],
    cues: [
      { id: "opening", presetId: "eighties", label: "Opening · 80s", minutes: 30 },
      { id: "pop", presetId: "y2k", label: "2000s pop / R&B", minutes: 30 },
      { id: "club", presetId: "tech-house", label: "Modern · Tech house", minutes: 45 },
    ],
    loop: false,
  };
}
