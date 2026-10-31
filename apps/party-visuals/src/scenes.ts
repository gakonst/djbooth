import type { TrackRhythm } from "../../djbooth/src/shared/types.js";
import type { TrackWaveform } from "../../dj-monitor/src/types.js";
import type { VisualLook } from "../../dj-monitor/src/visual-presets.js";
import type { MusicDance } from "../../dj-monitor/src/music-dance.js";

/** What a deck is playing, for scenes that follow a song's structure rather than its beat. */
export type MusicLane = {
  trackId: string | null;
  waveform: TrackWaveform | null;
  /** Playhead in source-file seconds, already advanced by playback speed. */
  time: number;
  playing: boolean;
  /** Audible level after the fader, about 0–1. */
  level: number;
  /** Audible tempo, including playback speed. */
  bpm: number;
  /** Original track tempo, used with source-file timestamps when no beat grid is available. */
  sourceBpm?: number;
  /** Live analyser magnitudes (0–255 per bin), zero while the deck is silent. */
  spectrum?: Uint8Array;
  sampleRate?: number;
  /** Rekordbox's three-band detail waveform and phrases, when the track has them. */
  rhythm?: TrackRhythm | null;
};

/** The engine contract every booth scene in apps/dj-monitor already implements. */
export type SceneEngine = {
  dispose(): void;
  setLook?(look: VisualLook): void;
  setMusic?(lanes: MusicLane[]): void;
  setDance?(dance: MusicDance): void;
  /** A short description of what the scene is reacting to, shown while building. */
  status?(): string;
  draw(
    time: number,
    rgba: Uint8Array,
    energy: Float32Array,
    motion: Float32Array,
    origins: Float32Array,
    audibleLevels?: Float32Array,
  ): void;
};

export type SceneId =
  | "ritual-cathedral"
  | "halloween"
  | "race"
  | "temple-run"
  | "dither"
  | "rainbow-road"
  | "corn-maze"
  | "pac-man"
  | "jungle-hero"
  | "skeleton-disco";

export type SceneInfo = {
  id: SceneId;
  label: string;
  /** Whether the scene responds to the look sliders and theme. */
  looks: boolean;
  /** False when the scene has its own palette and ignores the theme. */
  themes?: boolean;
  create(host: HTMLCanvasElement): Promise<SceneEngine>;
};

export const SCENES: SceneInfo[] = [
  {
    id: "ritual-cathedral",
    label: "Ritual cathedral",
    looks: true,
    themes: false,
    create: async (host) =>
      (await import("./scenes/ritual-cathedral.js")).createRitualCathedral(host),
  },
  {
    id: "corn-maze",
    label: "Corn maze",
    looks: true,
    themes: false,
    create: async (host) => (await import("./scenes/corn-maze.js")).createCornMaze(host),
  },
  {
    id: "rainbow-road",
    label: "Rainbow Road",
    looks: true,
    themes: false,
    create: async (host) => (await import("./scenes/rainbow-road.js")).createRainbowRoad(host),
  },
  {
    id: "pac-man",
    label: "Pac-Man",
    looks: true,
    themes: false,
    create: async (host) => (await import("./scenes/pac-man.js")).createPacMan(host),
  },
  {
    id: "jungle-hero",
    label: "Jungle hero",
    looks: true,
    themes: false,
    create: async (host) => (await import("./scenes/jungle-hero.js")).createJungleHero(host),
  },
  {
    id: "skeleton-disco",
    label: "Skeleton disco",
    looks: true,
    themes: false,
    create: async (host) => (await import("./scenes/skeleton-disco.js")).createSkeletonDisco(host),
  },
  {
    id: "halloween",
    label: "Haunted stage",
    looks: true,
    create: async (host) =>
      (await import("../../dj-monitor/src/halloween-booth.js")).createHalloweenBooth(host),
  },
  {
    id: "race",
    label: "Space race",
    looks: true,
    themes: false,
    create: async (host) =>
      (await import("../../dj-monitor/src/race-booth.js")).createRaceBooth(host),
  },
  {
    id: "temple-run",
    label: "Temple Run",
    looks: true,
    themes: false,
    create: async (host) => (await import("./scenes/temple-run.js")).createTempleRun(host),
  },
  {
    id: "dither",
    label: "Dither knot",
    looks: true,
    themes: false,
    create: async (host) => (await import("./ported/dither-booth.js")).createDitherBooth(host),
  },
];

export const sceneInfo = (id: SceneId) => SCENES.find((scene) => scene.id === id) ?? SCENES[0]!;

export const SCENE_DESCRIPTIONS: Record<SceneId, string> = {
  "ritual-cathedral": "Travel through stained glass, candlelight and a dancing ritual.",
  halloween: "Dancing spirits inside an amber spectral vortex.",
  race: "Pumpkin racers and spectral trails in haunted space.",
  "temple-run": "A torchlit escape through engraved moonlit ruins.",
  dither: "A carved, candlelit pumpkin with an etched halo.",
  "rainbow-road": "A Halloween race on a haunted spectral highway.",
  "corn-maze": "Follow a lantern into the haunted harvest.",
  "pac-man": "A pumpkin pursuit through cracked neon masonry.",
  "jungle-hero": "Hard-mode riffs through a haunted pumpkin grove.",
  "skeleton-disco": "Articulated dancers in a candlelit disco crypt.",
};
