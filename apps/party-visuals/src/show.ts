import {
  DEFAULT_VISUAL_LOOK,
  type VisualLook,
  type VisualTheme,
} from "../../dj-monitor/src/visual-presets.js";
import type { SceneId } from "./scenes.js";

export type Intro = "fade" | "flicker" | "cut";
export const INTROS: Intro[] = ["fade", "flicker", "cut"];
export const THEMES: { value: VisualTheme; label: string }[] = [
  { value: "halloween", label: "Halloween" },
  { value: "eighties", label: "80s" },
  { value: "y2k", label: "Y2K" },
  { value: "tech-house", label: "Tech house" },
];
export const LOOK_PARAMS: {
  key: Exclude<keyof VisualLook, "theme">;
  label: string;
  max: number;
}[] = [
  { key: "intensity", label: "Intensity", max: 2 },
  { key: "motion", label: "Motion", max: 2 },
  { key: "density", label: "Density", max: 1 },
  { key: "halloween", label: "Spookiness", max: 1 },
];

export type Design = {
  id: string;
  name: string;
  scene: SceneId;
  look: VisualLook;
  intro: Intro;
  updatedAt: number;
  /** Set when a thumbnail has been captured; also busts the image cache. */
  thumbAt?: number;
};

export type Show = {
  version: 1;
  designs: Design[];
  /** The design the Play page shows. */
  liveId: string | null;
};

const starter = (
  id: string,
  name: string,
  scene: SceneId,
  look: Partial<VisualLook> = {},
): Design => ({
  id,
  name,
  scene,
  look: { ...DEFAULT_VISUAL_LOOK, ...look },
  intro: "fade",
  updatedAt: 0,
});

/** Every existing booth scene, plus the saved looks from the workbench's visual show. */
export function starterShow(): Show {
  return {
    version: 1,
    liveId: "haunted-booth",
    designs: [
      starter("haunted-booth", "Haunted Booth", "halloween"),
      starter("corn-maze", "Corn Maze", "corn-maze"),
      starter("neon-midnight", "Neon Midnight", "halloween", {
        theme: "eighties",
        intensity: 0.75,
        motion: 0.65,
        density: 0.7,
        halloween: 0.35,
      }),
      starter("y2k-pop", "Y2K Pop", "halloween", { theme: "y2k", density: 0.9, halloween: 0.45 }),
      starter("after-dark", "After Dark", "halloween", {
        theme: "tech-house",
        intensity: 1.25,
        motion: 1.15,
        halloween: 0.6,
      }),
      starter("space-race", "Space Race", "race", {
        theme: "eighties",
        intensity: 0.9,
        density: 0.8,
      }),
      starter("temple-run", "Temple Run", "temple-run"),
      starter("jungle-hero", "Jungle Hero", "jungle-hero"),
      starter("skeleton-disco", "Skeleton Disco", "skeleton-disco"),
      starter("prism-glass", "Prism Glass", "vgpu"),
      starter("folded-surface", "Folded Surface", "webgpu"),
      starter("ribbons", "Ribbons", "ribbons"),
      starter("architecture", "Architecture", "architecture"),
      starter("line-waves", "Line Waves", "lines"),
      starter("dither-knot", "Dither Knot", "dither"),
    ],
  };
}

export function newDesignId(name: string, taken: Set<string>) {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "")
      .slice(0, 40) || "design";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

export async function loadShow(): Promise<Show> {
  const response = await fetch("/party/show");
  if (response.status === 404) return starterShow();
  if (!response.ok) throw new Error(`Could not load show (${response.status})`);
  return (await response.json()) as Show;
}

export async function saveShow(show: Show) {
  const response = await fetch("/party/show", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(show),
  });
  if (!response.ok) throw new Error(`Save failed (${response.status})`);
}

export async function saveThumb(id: string, image: Blob) {
  const response = await fetch(`/party/thumbs/${id}.jpg`, { method: "PUT", body: image });
  if (!response.ok) throw new Error(`Thumbnail save failed (${response.status})`);
}

export const thumbUrl = (design: Design) =>
  design.thumbAt ? `/party/thumbs/${design.id}.jpg?v=${design.thumbAt}` : null;
