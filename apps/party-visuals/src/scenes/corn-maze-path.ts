import type * as THREE from "three";

/** Width of one maze cell; the corridor fills it from corn wall to corn wall. */
export const CELL = 4;

/** North (the way in), east, south, west, as grid steps. */
export const SIDES = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;

export type Cell = { x: number; z: number };
/** One cornstalk: where it stands, how tall it grew, and how it turned and leans. */
export type Stalk = { x: number; z: number; height: number; turn: number; lean: number; tone: number; keep: number };
/** A pumpkin sitting at the foot of a wall, facing into the corridor. */
export type Pumpkin = { x: number; z: number; turn: number; size: number; carved: boolean };

const key = (x: number, z: number) => `${x},${z}`;

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * An endless corn maze, grown just ahead of whoever walks it. The way through only ever heads
 * north, east or west, so it never doubles back on itself; dead ends branch off it to make
 * the walk look like a choice.
 */
export class Maze {
  readonly path: Cell[] = [{ x: 0, z: 0 }];
  /** Open cells and a bitmask of which of their sides lead somewhere. */
  private readonly open = new Map<string, number>([[key(0, 0), 0]]);
  private readonly branches = new Map<number, Cell[]>();
  private readonly corn = new Map<string, { stalks: Stalk[]; pumpkins: Pumpkin[] }>();
  private readonly random: () => number;
  private heading = 0;
  private run = 3;
  private branched = 0;

  constructor(seed: number) {
    this.random = mulberry32(seed);
  }

  /** Lay the path out at least to cell `index`, with its dead ends decided. */
  ensure(index: number) {
    while (this.path.length <= index || this.branched <= index) {
      this.step();
      // A dead end is only dug once the path has moved well past it, so the two never touch.
      while (this.path.at(-1)!.z <= this.path[this.branched]!.z - 4) this.branch(this.branched++);
    }
  }

  private step() {
    if (this.run <= 0) {
      this.heading = this.heading === 0 ? (this.random() < 0.5 ? -1 : 1) : 0;
      this.run = 2 + Math.floor(this.random() * 4);
    }
    this.run--;
    const last = this.path.at(-1)!;
    const side = this.heading === 0 ? 0 : this.heading === 1 ? 1 : 3;
    const [dx, dz] = SIDES[side]!;
    this.link(last, side);
    this.path.push({ x: last.x + dx, z: last.z + dz });
  }

  private link(cell: Cell, side: number) {
    const [dx, dz] = SIDES[side]!;
    const a = key(cell.x, cell.z),
      b = key(cell.x + dx, cell.z + dz);
    this.open.set(a, (this.open.get(a) ?? 0) | (1 << side));
    this.open.set(b, (this.open.get(b) ?? 0) | (1 << ((side + 2) % 4)));
  }

  /** A cell can be dug out if it and its neighbours, apart from where it is entered, are corn. */
  private free(x: number, z: number, from: Cell) {
    if (this.open.has(key(x, z))) return false;
    return SIDES.every(([dx, dz]) => (x + dx === from.x && z + dz === from.z) || !this.open.has(key(x + dx, z + dz)));
  }

  private branch(index: number) {
    const cell = this.path[index]!;
    const dug: Cell[] = [];
    for (let side = 0; side < 4; side++) {
      if (((this.open.get(key(cell.x, cell.z)) ?? 0) >> side) & 1 || this.random() > 0.2) continue;
      const [dx, dz] = SIDES[side]!;
      let at = cell;
      for (let length = 1 + Math.floor(this.random() * 2); length > 0; length--) {
        const next = { x: at.x + dx, z: at.z + dz };
        if (!this.free(next.x, next.z, at)) break;
        this.link(at, side);
        dug.push(next);
        at = next;
      }
    }
    this.branches.set(index, dug);
  }

  /** The path cells from `from` to `to` and the dead ends off them. */
  cells(from: number, to: number) {
    this.ensure(to);
    const out: Cell[] = [];
    for (let i = Math.max(0, from); i <= to; i++) out.push(this.path[i]!, ...(this.branches.get(i) ?? []));
    return out;
  }

  /** Whether a point on the ground is well inside an open cell, where no corn may grow. */
  private clear(x: number, z: number, margin: number) {
    const cx = Math.round(x / CELL),
      cz = Math.round(z / CELL);
    if (!this.open.has(key(cx, cz))) return false;
    const half = CELL / 2 - margin;
    return Math.abs(x - cx * CELL) < half && Math.abs(z - cz * CELL) < half;
  }

  /** The corn walls and pumpkins around one open cell, grown once and then kept. */
  cornAround(cell: Cell) {
    const id = key(cell.x, cell.z);
    let grown = this.corn.get(id);
    if (grown) return grown;
    grown = { stalks: [], pumpkins: [] };
    const random = mulberry32((cell.x * 73856093) ^ (cell.z * 19349663));
    const links = this.open.get(id) ?? 0;
    const span = CELL + 1.6;
    for (let side = 0; side < 4; side++) {
      if ((links >> side) & 1) continue;
      const [nx, nz] = SIDES[side]!;
      // Along the wall runs perpendicular to the side's normal.
      const ax = -nz,
        az = nx;
      for (let row = 0; row < 4; row++)
        for (let k = 0; k < 9; k++) {
          const along = ((k + 0.2 + random() * 0.6) / 9 - 0.5) * span;
          const out = CELL / 2 - 0.15 + row * 0.5 + random() * 0.3;
          const x = cell.x * CELL + nx * out + ax * along,
            z = cell.z * CELL + nz * out + az * along;
          if (this.clear(x, z, 0.35)) continue;
          grown.stalks.push({
            x,
            z,
            height: 2.5 + random() * 1.1 + row * 0.1,
            turn: random() * Math.PI * 2,
            lean: (random() - 0.5) * 0.12,
            tone: random(),
            keep: row === 0 ? random() * 0.5 : random(),
          });
        }
      if (random() < 0.3) {
        const along = (random() - 0.5) * (CELL - 1.2);
        const inset = CELL / 2 - 0.45;
        grown.pumpkins.push({
          x: cell.x * CELL + nx * inset + ax * along,
          z: cell.z * CELL + nz * inset + az * along,
          turn: Math.atan2(-nx, -nz) + (random() - 0.5) * 0.8,
          size: 0.7 + random() * 0.6,
          carved: random() < 0.45,
        });
      }
    }
    this.corn.set(id, grown);
    return grown;
  }

  /** Forget corn far behind the walker. */
  prune(before: number) {
    for (const cell of this.cells(Math.max(0, before - 8), before)) this.corn.delete(key(cell.x, cell.z));
  }

  /** Where the walk is at distance `s`, rounding each corner on a curve through its cell. */
  sample(s: number, point: THREE.Vector3, tangent?: THREE.Vector3) {
    const f = Math.max(0.5, s / CELL);
    const i = Math.max(1, Math.round(f));
    this.ensure(i + 1);
    const u = Math.min(1, Math.max(0, f - i + 0.5));
    const a = this.path[i - 1]!,
      b = this.path[i]!,
      c = this.path[i + 1]!;
    const ax = (a.x + b.x) / 2,
      az = (a.z + b.z) / 2,
      cx = (b.x + c.x) / 2,
      cz = (b.z + c.z) / 2;
    const m = 1 - u;
    point.set((m * m * ax + 2 * m * u * b.x + u * u * cx) * CELL, 0, (m * m * az + 2 * m * u * b.z + u * u * cz) * CELL);
    tangent?.set(m * (b.x - ax) + u * (cx - b.x), 0, m * (b.z - az) + u * (cz - b.z)).normalize();
    return point;
  }
}
