import type { TrackWaveform } from "../../dj-monitor/src/types.js";
import type { VisualLook } from "../../dj-monitor/src/visual-presets.js";

/** What a deck is playing, for scenes that follow a song's structure rather than its beat. */
export type MusicLane = {
  trackId: string | null;
  waveform: TrackWaveform | null;
  /** Playhead in seconds. */
  time: number;
  playing: boolean;
  /** Audible level after the fader, about 0–1. */
  level: number;
  bpm: number;
  /** Live analyser magnitudes (0–255 per bin), zero while the deck is silent. */
  spectrum?: Uint8Array;
  sampleRate?: number;
};

/** The engine contract every booth scene in apps/dj-monitor already implements. */
export type SceneEngine = {
  dispose(): void;
  setLook?(look: VisualLook): void;
  setMusic?(lanes: MusicLane[]): void;
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
  | "halloween"
  | "race"
  | "temple-run"
  | "temple-run-booth"
  | "vgpu"
  | "webgpu"
  | "ribbons"
  | "architecture"
  | "lines"
  | "dither"
  | "rainbow-road"
  | "infinite-rings"
  | "corn-maze"
  | "infinite-vinyl"
  | "infinite-eyes"
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

/** The spark scene reads its composition from the URL once, while it is created. */
async function withComposition<T>(composition: string, create: () => Promise<T>) {
  const original = location.href;
  const url = new URL(original);
  url.searchParams.set("composition", composition);
  history.replaceState(history.state, "", url);
  try {
    return await create();
  } finally {
    history.replaceState(history.state, "", original);
  }
}

export const SCENES: SceneInfo[] = [
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
    id: "infinite-rings",
    label: "Infinite rings",
    looks: true,
    themes: false,
    create: async (host) => (await import("./scenes/infinite-rings.js")).createInfiniteRings(host),
  },
  {
    id: "pac-man",
    label: "Pac-Man",
    looks: true,
    themes: false,
    create: async (host) => (await import("./scenes/pac-man.js")).createPacMan(host),
  },
  {
    id: "infinite-vinyl",
    label: "Vinyl tunnel",
    looks: true,
    themes: false,
    create: async (host) =>
      (await import("./scenes/infinite-rings.js")).createInfiniteRings(host, "vinyl"),
  },
  {
    id: "infinite-eyes",
    label: "Eye tunnel",
    looks: true,
    themes: false,
    create: async (host) =>
      (await import("./scenes/infinite-rings.js")).createInfiniteRings(host, "eyes"),
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
    id: "temple-run-booth",
    label: "Temple run (booth)",
    looks: true,
    create: async (host) =>
      (await import("../../dj-monitor/src/temple-run-booth.js")).createTempleRunBooth(host),
  },
  {
    id: "vgpu",
    label: "Prism glass",
    looks: false,
    create: async (host) =>
      (await import("../../dj-monitor/src/vgpu-booth.js")).createVgpuBooth(host),
  },
  {
    id: "webgpu",
    label: "Folded surface",
    looks: false,
    create: async (host) =>
      (await import("../../dj-monitor/src/webgpu-booth.js")).createWebGPUBooth(host),
  },
  {
    id: "ribbons",
    label: "Ribbons",
    looks: false,
    create: async (host) =>
      withComposition("", async () =>
        (await import("../../dj-monitor/src/spark-booth.js")).createSparkBooth(host),
      ),
  },
  {
    id: "architecture",
    label: "Architecture",
    looks: false,
    create: async (host) =>
      withComposition("architecture", async () =>
        (await import("../../dj-monitor/src/spark-booth.js")).createSparkBooth(host),
      ),
  },
  {
    id: "lines",
    label: "Line waves",
    looks: false,
    create: async (host) => (await import("./ported/lines-booth.js")).createLinesBooth(host),
  },
  {
    id: "dither",
    label: "Dither knot",
    looks: false,
    create: async (host) => (await import("./ported/dither-booth.js")).createDitherBooth(host),
  },
];

export const sceneInfo = (id: SceneId) => SCENES.find((scene) => scene.id === id) ?? SCENES[0]!;
