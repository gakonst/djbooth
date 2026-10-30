import { DEFAULT_VISUAL_LOOK, type VisualLook } from "../../../dj-monitor/src/visual-presets.js";
import { waveformBeat } from "../../../dj-monitor/src/waveform-signal.js";
import type { MusicLane, SceneEngine } from "../scenes.js";

/** One colour behind every dancer for now. */
const TILE_COLOR = "#ff7a1a";
const BONE = "#f6f1e4";
const INK = "#1c0d02";
/** How many dancers each eight-bar phrase shows: grow, shrink, grow again. */
const COUNTS = [2, 4, 6, 8, 6, 4, 2, 3, 6, 8, 4];
const PHRASE_BEATS = 32;
const MOVE_BEATS = 8;
/** Seconds for the grid to make room for new dancers, or close up after old ones. */
const REFLOW = 2.4;

type Point = [number, number];
/** Where the dancer is: pelvis, torso and head lean, hands relative to the shoulders, feet on the floor. */
type Pose = {
  pelvis: Point;
  tilt: number;
  head: number;
  left: Point;
  right: Point;
  leftFoot: Point;
  rightFoot: Point;
};

// Figure proportions, in tile units (the tile is 1×1, centred on 0,0, y down).
const FLOOR = 0.4;
const PELVIS_Y = 0.08;
const TORSO = 0.24;
const SHOULDER = 0.075;
const HIP = 0.045;
const UPPER_ARM = 0.13;
const FOREARM = 0.12;
const THIGH = 0.165;
const SHIN = 0.165;
const SKULL = 0.062;

const NEUTRAL: Pose = {
  pelvis: [0, PELVIS_Y],
  tilt: 0,
  head: 0,
  left: [-0.1, 0.24],
  right: [0.1, 0.24],
  leftFoot: [-0.065, FLOOR],
  rightFoot: [0.065, FLOOR],
};

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const mixPoint = (a: Point, b: Point, t: number): Point => [mix(a[0], b[0], t), mix(a[1], b[1], t)];
const mixPose = (a: Pose, b: Pose, t: number): Pose => ({
  pelvis: mixPoint(a.pelvis, b.pelvis, t),
  tilt: mix(a.tilt, b.tilt, t),
  head: mix(a.head, b.head, t),
  left: mixPoint(a.left, b.left, t),
  right: mixPoint(a.right, b.right, t),
  leftFoot: mixPoint(a.leftFoot, b.leftFoot, t),
  rightFoot: mixPoint(a.rightFoot, b.rightFoot, t),
});
const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};
/** Move quickly just after each beat, then hold the pose: the snap of a disco step. */
const snap = (beat: number) => Math.floor(beat) + smooth((((beat % 1) + 1) % 1) / 0.45);

/** Each move maps the song's beat position to a pose; even beats one way, odd the other. */
const MOVES: { name: string; pose(beat: number): Pose }[] = [
  {
    name: "groove",
    pose(b) {
      const side = Math.cos(Math.PI * b);
      const dip = 0.5 + 0.5 * Math.cos(2 * Math.PI * b);
      return {
        pelvis: [side * 0.03, PELVIS_Y + dip * 0.03],
        tilt: -side * 0.08,
        head: side * 0.12,
        left: [-0.11 + side * 0.03, 0.16 - dip * 0.03],
        right: [0.11 + side * 0.03, 0.16 - dip * 0.03],
        leftFoot: [-0.065, FLOOR - Math.max(0, -side) * 0.02],
        rightFoot: [0.065, FLOOR - Math.max(0, side) * 0.02],
      };
    },
  },
  {
    name: "disco point",
    pose(b) {
      const u = 0.5 - 0.5 * Math.cos(Math.PI * snap(b));
      const dip = 0.5 + 0.5 * Math.cos(2 * Math.PI * b);
      return {
        pelvis: [mix(-0.035, 0.03, u), PELVIS_Y + dip * 0.02],
        tilt: mix(0.13, -0.06, u),
        head: mix(0.25, -0.1, u),
        left: [-0.085, 0.2],
        right: mixPoint([0.2, -0.33], [-0.05, 0.2], u),
        leftFoot: [-0.07, FLOOR],
        rightFoot: [mix(0.12, 0.06, u), FLOOR - (1 - u) * 0.01],
      };
    },
  },
  {
    name: "arm roll",
    pose(b) {
      const side = Math.cos(Math.PI * b);
      const dip = 0.5 + 0.5 * Math.cos(2 * Math.PI * b);
      const angle = 2 * Math.PI * b;
      const roll = (offset: number): Point => [
        Math.cos(angle + offset) * 0.045 + side * 0.04,
        0.09 + Math.sin(angle + offset) * 0.035,
      ];
      return {
        pelvis: [side * 0.035, PELVIS_Y + dip * 0.025],
        tilt: -side * 0.06,
        head: side * 0.1,
        left: roll(Math.PI),
        right: roll(0),
        leftFoot: [-0.07, FLOOR],
        rightFoot: [0.07, FLOOR],
      };
    },
  },
  {
    name: "step clap",
    pose(b) {
      const side = Math.cos(Math.PI * snap(b));
      const dip = 0.5 + 0.5 * Math.cos(2 * Math.PI * b);
      const open = 1 - dip;
      return {
        pelvis: [side * 0.06, PELVIS_Y + dip * 0.025],
        tilt: side * 0.05,
        head: -side * 0.12,
        left: [-0.015 - open * 0.1, 0.05 + open * 0.06],
        right: [0.015 + open * 0.1, 0.05 + open * 0.06],
        leftFoot: [
          side * 0.06 - 0.075 + Math.max(0, side) * 0.015,
          FLOOR - Math.max(0, side) * 0.025,
        ],
        rightFoot: [
          side * 0.06 + 0.075 - Math.max(0, -side) * 0.015,
          FLOOR - Math.max(0, -side) * 0.025,
        ],
      };
    },
  },
  {
    name: "raise the roof",
    pose(b) {
      const side = Math.cos(Math.PI * b);
      const push = 0.5 + 0.5 * Math.cos(2 * Math.PI * b);
      return {
        pelvis: [side * 0.025, PELVIS_Y + push * 0.03],
        tilt: -side * 0.05,
        head: side * 0.08 - push * 0.05,
        left: [-0.17, -0.17 - push * 0.07],
        right: [0.17, -0.17 - push * 0.07],
        leftFoot: [-0.075, FLOOR],
        rightFoot: [0.075, FLOOR],
      };
    },
  },
  {
    name: "shimmy",
    pose(b) {
      const shake = Math.sin(4 * Math.PI * b);
      const dip = 0.5 + 0.5 * Math.cos(2 * Math.PI * b);
      return {
        pelvis: [0, PELVIS_Y + dip * 0.035],
        tilt: shake * 0.07,
        head: -shake * 0.05,
        left: [-0.18, 0.06 + shake * 0.02],
        right: [0.18, 0.06 - shake * 0.02],
        leftFoot: [-0.08, FLOOR],
        rightFoot: [0.08, FLOOR],
      };
    },
  },
  {
    name: "hustle",
    pose(b) {
      // Roll the arms for two beats, then point down to one side; the side swaps every bar.
      const bar = Math.floor(b / 4);
      const side = bar % 2 ? -1 : 1;
      const inBar = ((b % 4) + 4) % 4;
      const point = smooth((inBar - 1.6) / 0.4) * (1 - smooth((inBar - 3.6) / 0.4));
      const angle = 2 * Math.PI * b;
      const roll = (offset: number): Point => [
        Math.cos(angle + offset) * 0.04,
        0.1 + Math.sin(angle + offset) * 0.03,
      ];
      const dip = 0.5 + 0.5 * Math.cos(2 * Math.PI * b);
      return {
        pelvis: [side * point * 0.04, PELVIS_Y + dip * 0.025],
        tilt: -side * point * 0.1,
        head: side * point * 0.2,
        left: mixPoint(roll(Math.PI), side < 0 ? [-0.24, 0.12] : [0.02, 0.12], point),
        right: mixPoint(roll(0), side > 0 ? [0.24, 0.12] : [-0.02, 0.12], point),
        leftFoot: [-0.07 - (side < 0 ? point * 0.04 : 0), FLOOR],
        rightFoot: [0.07 + (side > 0 ? point * 0.04 : 0), FLOOR],
      };
    },
  },
  {
    name: "swim",
    pose(b) {
      const u = 0.5 - 0.5 * Math.cos(Math.PI * snap(b));
      const dip = 0.5 + 0.5 * Math.cos(2 * Math.PI * b);
      return {
        pelvis: [mix(-0.025, 0.025, u), PELVIS_Y + dip * 0.025],
        tilt: mix(0.05, -0.05, u),
        head: mix(-0.08, 0.08, u),
        left: mixPoint([-0.12, -0.14], [-0.1, 0.14], u),
        right: mixPoint([0.1, 0.14], [0.12, -0.14], u),
        leftFoot: [-0.07, FLOOR],
        rightFoot: [0.07, FLOOR],
      };
    },
  },
  {
    name: "the bump",
    pose(b) {
      const side = Math.cos(Math.PI * snap(b));
      const dip = 0.5 + 0.5 * Math.cos(2 * Math.PI * b);
      // Hips bump out on the beat; the hands clap on the other side.
      return {
        pelvis: [side * 0.055, PELVIS_Y + dip * 0.02],
        tilt: -side * 0.14,
        head: side * 0.18,
        left: [-side * 0.08 - 0.015, 0.04 + dip * 0.02],
        right: [-side * 0.08 + 0.015, 0.04 + dip * 0.02],
        leftFoot: [-0.075, FLOOR],
        rightFoot: [0.075, FLOOR],
      };
    },
  },
  {
    name: "wave",
    pose(b) {
      const sway = Math.sin(Math.PI * b);
      const dip = 0.5 + 0.5 * Math.cos(2 * Math.PI * b);
      return {
        pelvis: [sway * 0.035, PELVIS_Y + dip * 0.02],
        tilt: -sway * 0.07,
        head: sway * 0.1,
        left: [-0.12 + sway * 0.09, -0.23],
        right: [0.12 + sway * 0.09, -0.23],
        leftFoot: [-0.07, FLOOR - Math.max(0, -sway) * 0.015],
        rightFoot: [0.07, FLOOR - Math.max(0, sway) * 0.015],
      };
    },
  },
];

const hash = (x: number) => {
  const v = Math.sin(x * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
};
/** The moves in a shuffled order that changes every round, so no two in a row repeat. */
function shuffled(round: number) {
  const order = MOVES.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(hash(round * 31 + i) * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}
function moveAt(index: number) {
  const n = MOVES.length;
  const round = Math.floor(index / n),
    at = index - round * n;
  const order = shuffled(round);
  // A round never opens with the move the last one ended on.
  if (order[0] === shuffled(round - 1)[n - 1]) [order[0], order[1]] = [order[1]!, order[0]!];
  return MOVES[order[at]!]!;
}

/** Two-bone IK: the joint that lets a limb of lengths a and b reach from root to target. */
function reach(root: Point, target: Point, a: number, b: number, bend: number): Point {
  const dx = target[0] - root[0],
    dy = target[1] - root[1];
  const d = Math.min(a + b - 1e-4, Math.max(Math.abs(a - b) + 1e-4, Math.hypot(dx, dy)));
  const angle = Math.acos((a * a + d * d - b * b) / (2 * a * d));
  const base = Math.atan2(dy, dx) + bend * angle;
  return [root[0] + Math.cos(base) * a, root[1] + Math.sin(base) * a];
}

/** Of the two ways an arm can bend, the elbow that sticks out sideways (and a little down). */
function elbow(shoulder: Point, hand: Point, side: number) {
  const [a, b] = [
    reach(shoulder, hand, UPPER_ARM, FOREARM, 1),
    reach(shoulder, hand, UPPER_ARM, FOREARM, -1),
  ];
  const score = (p: Point) => side * p[0] + 0.3 * p[1];
  return score(a) >= score(b) ? a : b;
}

/** Where the dancer's joints are for a pose. Arms and legs are short of full stretch, never longer. */
function skeleton(pose: Pose) {
  const [px, py] = pose.pelvis;
  const up: Point = [Math.sin(pose.tilt), -Math.cos(pose.tilt)];
  const across: Point = [Math.cos(pose.tilt), Math.sin(pose.tilt)];
  const at = (base: Point, x: number, y: number): Point => [
    base[0] + across[0] * x - up[0] * y,
    base[1] + across[1] * x - up[1] * y,
  ];
  const pelvis: Point = [px, py];
  const chest: Point = [px + up[0] * TORSO, py + up[1] * TORSO];
  const shoulders = [at(chest, -SHOULDER, 0.015), at(chest, SHOULDER, 0.015)] as const;
  const hips = [at(pelvis, -HIP, 0), at(pelvis, HIP, 0)] as const;
  const hands = [
    at(chest, pose.left[0], pose.left[1]),
    at(chest, pose.right[0], pose.right[1]),
  ] as const;
  // Elbows and knees bend outwards, like a figure facing the crowd.
  const elbows = [elbow(shoulders[0], hands[0], -1), elbow(shoulders[1], hands[1], 1)] as const;
  const knees = [
    reach(hips[0], pose.leftFoot, THIGH, SHIN, 1),
    reach(hips[1], pose.rightFoot, THIGH, SHIN, -1),
  ] as const;
  const neck: Point = [chest[0] + up[0] * 0.035, chest[1] + up[1] * 0.035];
  const headAngle = pose.tilt + pose.head;
  const head: Point = [
    neck[0] + Math.sin(headAngle) * SKULL * 1.15,
    neck[1] - Math.cos(headAngle) * SKULL * 1.15,
  ];
  return {
    pelvis,
    chest,
    shoulders,
    hips,
    hands,
    elbows,
    knees,
    neck,
    head,
    headAngle,
    tilt: pose.tilt,
  };
}

/** `pixels` is the tile size on screen; canvas shadows ignore the transform. */
function drawDancer(c: CanvasRenderingContext2D, pose: Pose, glow: number, pixels: number) {
  const s = skeleton(pose);
  const line = (a: Point, b: Point, width: number) => {
    c.lineWidth = width;
    c.beginPath();
    c.moveTo(a[0], a[1]);
    c.lineTo(b[0], b[1]);
    c.stroke();
  };
  const knob = (p: Point, r: number) => {
    c.beginPath();
    c.arc(p[0], p[1], r, 0, Math.PI * 2);
    c.fill();
  };
  const limbs: [Point, Point, number][] = [
    [s.shoulders[0], s.elbows[0], 0.022],
    [s.elbows[0], s.hands[0], 0.019],
    [s.shoulders[1], s.elbows[1], 0.022],
    [s.elbows[1], s.hands[1], 0.019],
    [s.hips[0], s.knees[0], 0.026],
    [s.knees[0], [pose.leftFoot[0], pose.leftFoot[1] - 0.012], 0.022],
    [s.hips[1], s.knees[1], 0.026],
    [s.knees[1], [pose.rightFoot[0], pose.rightFoot[1] - 0.012], 0.022],
  ];
  const joints: [Point, number][] = [
    ...s.shoulders.map((p) => [p, 0.02] as [Point, number]),
    ...s.elbows.map((p) => [p, 0.016] as [Point, number]),
    ...s.knees.map((p) => [p, 0.019] as [Point, number]),
    ...s.hands.map((p) => [p, 0.02] as [Point, number]),
  ];

  // Shadow on the floor, between the feet.
  c.fillStyle = "rgba(0,0,0,0.18)";
  c.beginPath();
  c.ellipse(pose.pelvis[0], FLOOR + 0.012, 0.15, 0.022, 0, 0, Math.PI * 2);
  c.fill();

  c.lineCap = "round";
  c.lineJoin = "round";
  // Two passes: a dark outline under every bone, then the bones themselves.
  for (const pass of [0, 1]) {
    const pad = pass ? 0 : 0.014;
    c.strokeStyle = c.fillStyle = pass ? BONE : INK;
    // The glow sits behind the outline, so it rims the figure.
    c.shadowColor = `rgba(255,250,220,${Math.min(0.9, glow)})`;
    c.shadowBlur = pass || glow <= 0 ? 0 : pixels * 0.05 * glow;

    // Spine, collarbones and pelvis.
    line(s.pelvis, s.neck, 0.016 + pad);
    line(s.shoulders[0], s.shoulders[1], 0.016 + pad);
    for (const [a, b, w] of limbs) line(a, b, w + pad);
    for (const [p, r] of joints) knob(p, r + pad / 2);

    // Ribcage: curved ribs either side of the spine.
    c.save();
    c.translate(s.chest[0], s.chest[1]);
    c.rotate(s.tilt);
    for (let k = 0; k < 4; k++) {
      const y = 0.035 + k * 0.04;
      const w = 0.075 - k * 0.009;
      c.lineWidth = 0.009 + pad * 0.6;
      for (const side of [-1, 1]) {
        c.beginPath();
        c.moveTo(0, y);
        c.quadraticCurveTo(side * w * 1.15, y - 0.004, side * w * 0.85, y + 0.026);
        c.stroke();
      }
    }
    // Pelvis: a butterfly of two rounded wings.
    c.translate(0, TORSO);
    for (const side of [-1, 1]) {
      c.beginPath();
      c.ellipse(side * 0.035, -0.005, 0.04 + pad / 2, 0.028 + pad / 2, side * 0.4, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();

    // Feet point outwards.
    for (const [foot, side] of [
      [pose.leftFoot, -1],
      [pose.rightFoot, 1],
    ] as const) {
      c.beginPath();
      c.ellipse(
        foot[0] + side * 0.02,
        foot[1],
        0.035 + pad / 2,
        0.016 + pad / 2,
        0,
        0,
        Math.PI * 2,
      );
      c.fill();
    }

    // Skull and jaw.
    c.save();
    c.translate(s.head[0], s.head[1]);
    c.rotate(s.headAngle);
    c.beginPath();
    c.arc(0, -0.008, SKULL + pad / 2, 0, Math.PI * 2);
    c.fill();
    c.beginPath();
    c.roundRect(-0.036 - pad / 2, 0.022, 0.072 + pad, 0.045 + pad / 2, 0.016);
    c.fill();
    c.restore();
  }
  c.shadowBlur = 0;

  // Face: hollow eyes with a glint, a nose and a row of teeth.
  c.save();
  c.translate(s.head[0], s.head[1]);
  c.rotate(s.headAngle);
  c.fillStyle = INK;
  for (const side of [-1, 1]) {
    c.beginPath();
    c.ellipse(side * 0.024, -0.006, 0.017, 0.02, side * 0.2, 0, Math.PI * 2);
    c.fill();
  }
  c.fillStyle = TILE_COLOR;
  for (const side of [-1, 1]) {
    c.beginPath();
    c.arc(side * 0.024, -0.004, 0.005 + glow * 0.003, 0, Math.PI * 2);
    c.fill();
  }
  c.fillStyle = INK;
  c.beginPath();
  c.moveTo(0, 0.014);
  c.lineTo(-0.007, 0.027);
  c.lineTo(0.007, 0.027);
  c.closePath();
  c.fill();
  c.strokeStyle = INK;
  c.lineWidth = 0.004;
  c.beginPath();
  c.moveTo(-0.026, 0.045);
  c.lineTo(0.026, 0.045);
  for (let k = -2; k <= 2; k++) {
    c.moveTo(k * 0.011, 0.036);
    c.lineTo(k * 0.011, 0.056);
  }
  c.stroke();
  c.restore();
}

type Rect = { x: number; y: number; w: number; h: number };
/** A dancer's box, gliding from one place in the grid to the next. */
type Tile = {
  from: Rect;
  to: Rect;
  leaving: boolean;
  row: number;
  column: number;
  mirror: boolean;
};

const gridFor = (count: number) =>
  count <= 3 ? { rows: 1, columns: count } : { rows: 2, columns: Math.ceil(count / 2) };
const ease = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};
const lerpRect = (a: Rect, b: Rect, t: number): Rect => ({
  x: mix(a.x, b.x, t),
  y: mix(a.y, b.y, t),
  w: mix(a.w, b.w, t),
  h: mix(a.h, b.h, t),
});

/**
 * A disco line of skeletons, each dancing in its own box. The boxes always fill the
 * screen; every eight bars the line grows or shrinks, new dancers sliding in from the
 * sides (or a new row from below). They dance only while a deck plays, on its beat grid.
 */
export async function createSkeletonDisco(host: HTMLCanvasElement): Promise<SceneEngine> {
  const element = document.createElement("canvas");
  element.setAttribute("aria-hidden", "true");
  host.after(element);
  const c = element.getContext("2d")!;

  let target: VisualLook = { ...DEFAULT_VISUAL_LOOK };
  const look = { ...target };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let lanes: MusicLane[] = [];
  let tiles: Tile[] = [];
  let grid = { rows: 0, columns: 0 };
  let reflowAt = -Infinity;
  let width = 0,
    height = 0;
  let previous: number | undefined;
  let clock = 0,
    level = 0,
    groove = 0,
    flash = 0,
    lastWhole = -1,
    beat = 0;
  let statusText = "";

  const cell = (row: number, column: number, rows: number, columns: number): Rect => ({
    x: (column * width) / columns,
    y: (row * height) / rows,
    w: width / columns,
    h: height / rows,
  });
  const current = (tile: Tile) => lerpRect(tile.from, tile.to, ease((clock - reflowAt) / REFLOW));

  /** Make room for `count` dancers: columns grow at both sides, rows from the bottom. */
  const reflow = (count: number) => {
    const next = gridFor(count);
    const old = grid;
    const extra = next.columns - old.columns;
    const shift = extra >= 0 ? Math.floor(extra / 2) : -Math.floor(-extra / 2);
    const placed: Tile[] = [];
    const taken = new Set<string>();
    for (const tile of tiles) {
      if (tile.leaving) continue;
      const from = current(tile);
      const column = tile.column + shift;
      if (tile.row >= next.rows)
        placed.push({ ...tile, from, to: { ...from, y: height, h: 0 }, leaving: true });
      else if (column < 0 || column >= next.columns) {
        const edge = column < 0 ? 0 : width;
        placed.push({ ...tile, from, to: { ...from, x: edge, w: 0 }, leaving: true });
      } else {
        placed.push({ ...tile, from, column, to: cell(tile.row, column, next.rows, next.columns) });
        taken.add(`${tile.row}:${column}`);
      }
    }
    for (let row = 0; row < next.rows; row++)
      for (let column = 0; column < next.columns; column++) {
        if (taken.has(`${row}:${column}`)) continue;
        const to = cell(row, column, next.rows, next.columns);
        const from =
          row >= old.rows
            ? { ...to, y: height, h: 0 }
            : column < next.columns / 2
              ? { ...to, x: 0, w: 0 }
              : { ...to, x: width, w: 0 };
        placed.push({ from, to, leaving: false, row, column, mirror: (row + column) % 2 === 1 });
      }
    tiles = placed;
    grid = next;
    reflowAt = clock;
  };

  /** The loudest playing deck, if any; its beat grid drives the dance. */
  const leader = () => {
    let best: MusicLane | undefined;
    for (const lane of lanes)
      if (lane.playing && lane.level > 0.005 && (!best || lane.level > best.level)) best = lane;
    return best;
  };

  return {
    setLook(next) {
      target = next;
    },
    setMusic(next) {
      lanes = next;
    },
    status() {
      return statusText;
    },
    draw(time) {
      const bounds = host.getBoundingClientRect();
      const ratio = Math.min(devicePixelRatio, 2);
      const w = Math.max(1, bounds.width),
        h = Math.max(1, bounds.height);
      if (element.width !== Math.round(w * ratio) || element.height !== Math.round(h * ratio)) {
        element.width = Math.round(w * ratio);
        element.height = Math.round(h * ratio);
      }
      const dt = previous === undefined ? 0 : Math.min(0.05, Math.max(0, time - previous));
      previous = time;
      clock += dt;
      const blend = 1 - Math.exp(-dt * 2);
      for (const key of ["intensity", "motion", "density", "halloween"] as const)
        look[key] += (target[key] - look[key]) * blend;

      // Dance only while music plays; when it stops they ease back to standing still.
      const lane = leader();
      if (lane) beat = waveformBeat(lane.waveform, lane.time, lane.bpm);
      level +=
        ((lane ? Math.min(1, Math.sqrt(lane.level) * 1.5) : 0) - level) * (1 - Math.exp(-dt * 4));
      groove += ((lane ? 1 : 0) - groove) * (1 - Math.exp(-dt * (lane ? 3 : 4)));

      const whole = Math.floor(beat);
      if (whole !== lastWhole && lane) flash = 0.6 + level * 0.4;
      lastWhole = whole;
      flash *= Math.exp(-dt * 5);

      // A new phrase brings a new number of dancers; a resize snaps the grid into place.
      const phrase = Math.floor(beat / PHRASE_BEATS);
      const count = COUNTS[((phrase % COUNTS.length) + COUNTS.length) % COUNTS.length]!;
      const wanted = gridFor(count);
      if (w !== width || h !== height) {
        width = w;
        height = h;
        if (!tiles.length) reflow(count);
        tiles = tiles.filter((t) => !t.leaving);
        for (const tile of tiles)
          tile.from = tile.to = cell(tile.row, tile.column, grid.rows, grid.columns);
      }
      if (wanted.rows !== grid.rows || wanted.columns !== grid.columns) reflow(count);
      if (clock - reflowAt > REFLOW) tiles = tiles.filter((t) => !t.leaving);

      // The move changes every two bars, in an order that keeps shuffling.
      const moveIndex = Math.floor(beat / MOVE_BEATS);
      const into = beat - moveIndex * MOVE_BEATS;
      const move = moveAt(moveIndex);
      const before = moveAt(moveIndex - 1);
      const calm = reduced.matches ? 0.3 : 1;
      const amount = Math.min(1.4, (0.65 + level * 0.35) * look.motion * calm) * groove;
      const danced = mixPose(before.pose(beat), move.pose(beat), smooth(into));
      const pose = mixPose(NEUTRAL, danced, amount);
      const glow = flash * look.intensity;

      c.setTransform(1, 0, 0, 1, 0, 0);
      c.fillStyle = INK;
      c.fillRect(0, 0, element.width, element.height);
      c.setTransform(ratio, 0, 0, ratio, 0, 0);
      const line = Math.max(2, Math.min(width, height) * 0.004);
      for (const tile of tiles) {
        const r = current(tile);
        if (r.w < 1 || r.h < 1) continue;
        c.save();
        c.beginPath();
        c.rect(r.x, r.y, r.w, r.h);
        c.clip();
        c.fillStyle = TILE_COLOR;
        c.fillRect(r.x, r.y, r.w, r.h);
        // The dancer keeps its proportions and stands on the bottom of its box.
        const size = Math.min(r.w * 1.3, r.h);
        c.translate(r.x + r.w / 2, r.y + r.h - size / 2);
        c.scale(size, size);
        // Neighbours mirror each other, like a dance line.
        if (tile.mirror) c.scale(-1, 1);
        drawDancer(c, pose, glow, size * ratio);
        c.restore();
        c.strokeStyle = INK;
        c.lineWidth = line;
        c.strokeRect(r.x, r.y, r.w, r.h);
      }

      statusText = `${tiles.filter((t) => !t.leaving).length} dancers · ${move.name}${lane ? "" : " · waiting for music"}`;
    },
    dispose() {
      element.remove();
    },
  };
}
