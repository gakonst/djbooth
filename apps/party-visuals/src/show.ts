import {
  DEFAULT_VISUAL_LOOK,
  type VisualLook,
  type VisualTheme,
} from "../../dj-monitor/src/visual-presets.js";
import { SCENES, type SceneId } from "./scenes.js";

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

/** The ten Halloween favorites. Retired renderers are no longer part of the show. */
export function starterShow(): Show {
  return {
    version: 1,
    liveId: "jungle-hero",
    designs: [
      starter("ritual-cathedral", "Ritual Cathedral", "ritual-cathedral"),
      starter("haunted-booth", "Haunted Booth", "halloween"),
      starter("corn-maze", "Corn Maze", "corn-maze"),
      starter("rainbow-road", "Spectral Highway", "rainbow-road"),
      starter("pac-man", "Pumpkin Pursuit", "pac-man"),
      starter("space-race", "Space Race", "race", {
        theme: "halloween",
        intensity: 0.9,
        density: 0.8,
      }),
      starter("temple-run", "Temple Run", "temple-run"),
      starter("jungle-hero", "Jungle Hero", "jungle-hero"),
      starter("skeleton-disco", "Skeleton Disco", "skeleton-disco"),
      starter("dither-knot", "Dither Knot", "dither"),
    ],
  };
}

/** Old saved designs must not resurrect retired scenes through the fallback renderer. */
export function reconcileShow(show: Show): Show {
  const designs = show.designs.filter((design) =>
    SCENES.some((scene) => scene.id === design.scene),
  );
  if (!designs.length) return starterShow();
  return {
    ...show,
    designs,
    liveId: designs.some((design) => design.id === show.liveId) ? show.liveId : designs[0]!.id,
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
  return reconcileShow((await response.json()) as Show);
}

export async function saveShow(show: Show) {
  const response = await fetch("/party/show", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(reconcileShow(show)),
  });
  if (!response.ok) throw new Error(`Save failed (${response.status})`);
}

export async function saveThumb(id: string, image: Blob) {
  const response = await fetch(`/party/thumbs/${id}.jpg`, { method: "PUT", body: image });
  if (!response.ok) throw new Error(`Thumbnail save failed (${response.status})`);
}

export const thumbUrl = (design: Design) =>
  design.thumbAt ? `/party/thumbs/${design.id}.jpg?v=${design.thumbAt}` : null;
