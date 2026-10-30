import { DEFAULT_VISUAL_LOOK, type VisualLook } from "../../../dj-monitor/src/visual-presets.js";
import type { MusicLane, SceneEngine } from "../scenes.js";

const LANES = 3;
const WALL = 1;
const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
] as const;

type Coin = { x: number; y: number; power: boolean; eaten: boolean; appearAt: number };
type Spark = { x: number; y: number; age: number; color: string };

/**
 * A symmetric maze in the arcade's spirit: a carved perfect maze on the left half, dead ends
 * knocked through into loops, then mirrored. Columns are 3 mod 4 so the centre column holds
 * carved cells and joins both halves; odd sizes keep a one-tile wall border.
 */
export function buildMaze(cols: number, rows: number) {
  const half = (cols + 1) / 2;
  const grid = Array.from({ length: rows }, () => new Uint8Array(half).fill(WALL));
  const open = (x: number, y: number) => x > 0 && y > 0 && x < half && y < rows - 1 && grid[y]![x] !== WALL;
  const carve = (x: number, y: number) => {
    grid[y]![x] = 0;
    const order = [...DIRECTIONS].sort(() => Math.random() - 0.5);
    for (const [dx, dy] of order) {
      const nx = x + dx * 2,
        ny = y + dy * 2;
      if (nx < 1 || ny < 1 || nx >= half || ny >= rows - 1 || grid[ny]![nx] !== WALL) continue;
      grid[y + dy]![x + dx] = 0;
      carve(nx, ny);
    }
  };
  carve(1, 1);
  // Pac-Man mazes have no dead ends: knock each one through to a neighbouring corridor.
  for (let y = 1; y < rows - 1; y += 2)
    for (let x = 1; x < half; x += 2) {
      const exits = DIRECTIONS.filter(([dx, dy]) => open(x + dx, y + dy));
      if (exits.length > 1) continue;
      const options = DIRECTIONS.filter(
        ([dx, dy]) =>
          y + dy * 2 > 0 && y + dy * 2 < rows - 1 && x + dx * 2 > 0 && x + dx * 2 < half && !open(x + dx, y + dy),
      );
      const pick = options[Math.floor(Math.random() * options.length)];
      if (pick) grid[y + pick[1]]![x + pick[0]] = 0;
    }
  // A few extra loops keep the chase flowing.
  for (let y = 1; y < rows - 1; y++)
    for (let x = 1; x < half - 1; x++)
      if (grid[y]![x] === WALL && (x + y) % 2 === 1 && Math.random() < 0.08) grid[y]![x] = 0;
  return Array.from({ length: rows }, (_, y) =>
    Uint8Array.from({ length: cols }, (_, x) => grid[y]![Math.min(x, cols - 1 - x)]!),
  );
}

/** The whole screen is one Pac-Man board: he clears every coin, then a fresh set ripples back in. */
export async function createPacMan(host: HTMLCanvasElement): Promise<SceneEngine> {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  host.after(canvas);
  const context = canvas.getContext("2d")!;
  const walls = document.createElement("canvas");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");

  let target: VisualLook = { ...DEFAULT_VISUAL_LOOK };
  const look = { ...target };
  let music: MusicLane[] = [];
  let width = 0,
    height = 0,
    ratio = 0,
    density = -1;
  let cols = 0,
    rows = 0,
    tile = 0,
    left = 0,
    top = 0;
  let maze: Uint8Array[] = [];
  let coins: Coin[] = [];
  let coinAt: (Coin | undefined)[] = [];
  const sparks: Spark[] = [];
  // Pac-Man's last tile, his heading, and how far (0–1) he is toward the next tile.
  const pac = { x: 1, y: 1, dx: 1, dy: 0, progress: 0, facing: 0 };
  let previous: number | undefined;
  let clock = 0,
    speed = 3,
    score = 0,
    level = 0,
    pulse = 0,
    power = 0,
    refilling = false,
    previousBeat = -1;

  const isOpen = (x: number, y: number) => x >= 0 && y >= 0 && x < cols && y < rows && maze[y]![x] !== WALL;
  const visible = (coin: Coin | undefined) => coin && !coin.eaten && coin.appearAt <= clock;

  function layout() {
    const across = Math.round(21 + look.density * 12);
    cols = across - ((across - 3) % 4);
    tile = width / cols;
    rows = Math.max(9, Math.floor(height / tile)) | 1;
    if (rows * tile > height) rows -= 2;
    left = (width - cols * tile) / 2;
    top = (height - rows * tile) / 2;
    maze = buildMaze(cols, rows);
    coins = [];
    coinAt = new Array(cols * rows);
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        if (!isOpen(x, y)) continue;
        const coin = { x, y, power: false, eaten: false, appearAt: 0 };
        coins.push(coin);
        coinAt[y * cols + x] = coin;
      }
    // A big coin near each corner.
    for (const [cx, cy] of [
      [1, 1],
      [cols - 2, 1],
      [1, rows - 2],
      [cols - 2, rows - 2],
    ] as const) {
      const near = coins.reduce((best, coin) =>
        Math.abs(coin.x - cx) + Math.abs(coin.y - cy) < Math.abs(best.x - cx) + Math.abs(best.y - cy) ? coin : best,
      );
      near.power = true;
    }
    // Start in the middle of the bottom-most corridor near the centre.
    const start = coins.reduce((best, coin) =>
      Math.abs(coin.x - cols / 2) + Math.abs(coin.y - rows * 0.75) < Math.abs(best.x - cols / 2) + Math.abs(best.y - rows * 0.75) ? coin : best,
    );
    Object.assign(pac, { x: start.x, y: start.y, dx: 0, dy: 0, progress: 0 });
    start.eaten = true;
    refilling = false;
    drawWalls();
  }

  /** Neon double-lined walls, traced once per layout along every wall/corridor edge. */
  function drawWalls() {
    walls.width = Math.round(width * ratio);
    walls.height = Math.round(height * ratio);
    const g = walls.getContext("2d")!;
    g.scale(ratio, ratio);
    g.lineCap = "round";
    const inset = tile * 0.32;
    const trace = (lineWidth: number, color: string, blur: number) => {
      g.strokeStyle = color;
      g.lineWidth = lineWidth;
      g.shadowColor = color;
      g.shadowBlur = blur;
      g.beginPath();
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < cols; x++) {
          if (isOpen(x, y)) continue;
          const x0 = left + x * tile,
            y0 = top + y * tile;
          for (const [dx, dy] of DIRECTIONS) {
            if (!isOpen(x + dx, y + dy)) continue;
            // The line runs parallel to the open side, pulled into the wall block.
            if (dx) {
              const lx = dx > 0 ? x0 + tile - inset : x0 + inset;
              const up = isOpen(x, y - 1) ? inset : 0,
                down = isOpen(x, y + 1) ? inset : 0;
              g.moveTo(lx, y0 + up - (up ? 0 : inset));
              g.lineTo(lx, y0 + tile - down + (down ? 0 : inset));
            } else {
              const ly = dy > 0 ? y0 + tile - inset : y0 + inset;
              const back = isOpen(x - 1, y) ? inset : 0,
                fore = isOpen(x + 1, y) ? inset : 0;
              g.moveTo(x0 + back - (back ? 0 : inset), ly);
              g.lineTo(x0 + tile - fore + (fore ? 0 : inset), ly);
            }
          }
        }
      g.stroke();
    };
    trace(Math.max(1.5, tile * 0.09), "#2f5bff", tile * 0.5);
    trace(Math.max(1, tile * 0.04), "#9fb6ff", 0);
  }

  /** Breadth-first search to the nearest coin that is out; returns the first step toward it. */
  function stepTowardCoin(): readonly [number, number] | null {
    const seen = new Int16Array(cols * rows).fill(-1);
    const queue = [pac.y * cols + pac.x];
    seen[queue[0]!] = 4;
    for (let head = 0; head < queue.length; head++) {
      const index = queue[head]!;
      const x = index % cols,
        y = Math.floor(index / cols);
      if (head > 0 && visible(coinAt[index])) {
        let at = index;
        // Walk back to the tile next to Pac-Man.
        while (true) {
          const [dx, dy] = DIRECTIONS[seen[at]!]!;
          const from = (Math.floor(at / cols) - dy) * cols + (at % cols) - dx;
          if (from === queue[0]) return DIRECTIONS[seen[at]!]!;
          at = from;
        }
      }
      DIRECTIONS.forEach(([dx, dy], d) => {
        const nx = x + dx,
          ny = y + dy,
          next = ny * cols + nx;
        if (isOpen(nx, ny) && seen[next] === -1) {
          seen[next] = d;
          queue.push(next);
        }
      });
    }
    return null;
  }

  function arrive(beatLength: number) {
    const coin = coinAt[pac.y * cols + pac.x];
    if (visible(coin)) {
      coin!.eaten = true;
      score += coin!.power ? 50 : 10;
      if (coin!.power) power = 1;
      for (let k = 0; k < (coin!.power ? 8 : 3); k++)
        sparks.push({ x: pac.x, y: pac.y, age: -k * 0.03, color: coin!.power ? "#ff8fd8" : "#ffd75a" });
    }
    if (!refilling && coins.every((c) => c.eaten)) {
      // Board cleared: after a beat, fresh coins ripple out from where he stands.
      refilling = true;
      const start = clock + beatLength;
      for (const c of coins) {
        if (c.x === pac.x && c.y === pac.y) continue;
        c.eaten = false;
        c.appearAt = start + (Math.abs(c.x - pac.x) + Math.abs(c.y - pac.y)) * 0.035;
      }
    }
    if (refilling && coins.every((c) => c.appearAt <= clock)) refilling = false;
    const step = stepTowardCoin();
    if (step) {
      pac.dx = step[0];
      pac.dy = step[1];
      return;
    }
    // Nothing to chase yet: wander, preferring not to turn back.
    const options = DIRECTIONS.filter(([dx, dy]) => isOpen(pac.x + dx, pac.y + dy));
    const forward = options.filter(([dx, dy]) => dx !== -pac.dx || dy !== -pac.dy);
    const pool = forward.length ? forward : options;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    pac.dx = pick?.[0] ?? 0;
    pac.dy = pick?.[1] ?? 0;
  }

  return {
    setLook(next) {
      target = next;
    },
    setMusic(lanes) {
      music = lanes;
    },
    draw(time, _rgba, energy, motion) {
      const bounds = host.getBoundingClientRect();
      const w = Math.max(1, bounds.width),
        h = Math.max(1, bounds.height);
      const r = Math.min(devicePixelRatio, 2);
      const dt = previous === undefined ? 0 : Math.min(0.05, Math.max(0, time - previous));
      previous = time;
      clock += dt;
      const blend = 1 - Math.exp(-dt * 2);
      for (const key of ["intensity", "motion", "density", "halloween"] as const)
        look[key] += (target[key] - look[key]) * blend;
      const wanted = Math.round(look.density * 4);
      if (w !== width || h !== height || r !== ratio || wanted !== density) {
        width = w;
        height = h;
        ratio = r;
        density = wanted;
        canvas.width = Math.round(w * r);
        canvas.height = Math.round(h * r);
        layout();
      }

      // Follow the loudest deck for tempo and beat.
      let lane = 0;
      for (let k = 1; k < LANES; k++) if ((energy[k * 4] ?? 0) > (energy[lane * 4] ?? 0)) lane = k;
      const loud = Math.min(1, Math.sqrt(Math.max(0, energy[lane * 4] ?? 0)) * 1.7);
      level += (loud - level) * (1 - Math.exp(-dt * 6));
      const playing = loud > 0.025;
      const bpm = music[lane]?.bpm || 120;
      const beatLength = 60 / bpm;
      const phase = motion[lane * 4 + 3] ?? 0;
      const beat = Math.floor(phase);
      if (beat !== previousBeat && previousBeat >= 0 && playing) pulse = 1;
      previousBeat = beat;
      pulse *= Math.exp(-dt * 4);
      power *= Math.exp(-dt * 0.9);
      const damping = (reduced.matches ? 0.15 : 1) * look.motion;
      // Two tiles per beat with music, a gentle stroll without.
      const wantSpeed = (playing ? (2 * bpm) / 60 : 3) * damping;
      speed += (wantSpeed - speed) * (1 - Math.exp(-dt * 2));

      // Advance tile to tile, deciding the next turn on each arrival.
      let travel = speed * dt;
      if (!pac.dx && !pac.dy) arrive(beatLength);
      for (let guard = 0; travel > 0 && guard < 8 && (pac.dx || pac.dy); guard++) {
        const remaining = 1 - pac.progress;
        if (travel < remaining) {
          pac.progress += travel;
          break;
        }
        travel -= remaining;
        pac.progress = 0;
        pac.x += pac.dx;
        pac.y += pac.dy;
        arrive(beatLength);
      }
      if (pac.dx || pac.dy) pac.facing = Math.atan2(pac.dy, pac.dx);

      const g = context;
      g.setTransform(r, 0, 0, r, 0, 0);
      g.globalCompositeOperation = "source-over";
      g.globalAlpha = 1;
      g.fillStyle = "#02010a";
      g.fillRect(0, 0, w, h);

      // Walls: steady neon that brightens with the music, warming pink after a big coin.
      const glow = (0.55 + level * 0.3 + pulse * 0.1) * look.intensity;
      g.globalAlpha = Math.min(1, glow);
      g.drawImage(walls, 0, 0, w, h);
      if (power > 0.02) {
        g.globalCompositeOperation = "lighter";
        g.globalAlpha = power * 0.5;
        g.filter = "hue-rotate(90deg)";
        g.drawImage(walls, 0, 0, w, h);
        g.filter = "none";
        g.globalCompositeOperation = "source-over";
      }
      g.globalAlpha = 1;

      // Coins breathe softly on the beat; big coins blink in time like the arcade.
      const breathe = playing ? 1 + pulse * 0.18 : 1;
      const blinkOn = playing ? phase % 1 < 0.6 : Math.floor(clock * 3) % 2 === 0;
      for (const coin of coins) {
        if (coin.eaten || coin.appearAt > clock + 0.5) continue;
        const grow = Math.min(1, Math.max(0, (clock - coin.appearAt) / 0.3));
        if (grow <= 0) continue;
        const pop = grow < 1 ? 1 + Math.sin(grow * Math.PI) * 0.4 : 1;
        const cx = left + (coin.x + 0.5) * tile,
          cy = top + (coin.y + 0.5) * tile;
        if (coin.power) {
          if (!blinkOn && grow >= 1) continue;
          g.fillStyle = "#ffe48a";
          g.shadowColor = "#ffb3ec";
          g.shadowBlur = tile * 0.6;
          g.beginPath();
          g.arc(cx, cy, tile * 0.3 * grow * pop, 0, Math.PI * 2);
          g.fill();
        } else {
          const radius = tile * 0.12 * grow * pop * breathe;
          g.fillStyle = "#ffcf3f";
          g.shadowColor = "#ffcf3f";
          g.shadowBlur = tile * 0.25;
          g.beginPath();
          g.arc(cx, cy, radius, 0, Math.PI * 2);
          g.fill();
          g.shadowBlur = 0;
          g.fillStyle = "#fff6c8";
          g.beginPath();
          g.arc(cx - radius * 0.3, cy - radius * 0.3, radius * 0.35, 0, Math.PI * 2);
          g.fill();
        }
      }
      g.shadowBlur = 0;

      // A few sparks where a coin was eaten.
      for (let i = sparks.length - 1; i >= 0; i--) {
        const spark = sparks[i]!;
        spark.age += dt;
        if (spark.age > 0.45) {
          sparks.splice(i, 1);
          continue;
        }
        if (spark.age < 0) continue;
        const a = (i * 2.4) % (Math.PI * 2);
        const d = spark.age * tile * 1.6;
        g.globalAlpha = 1 - spark.age / 0.45;
        g.fillStyle = spark.color;
        g.beginPath();
        g.arc(left + (spark.x + 0.5) * tile + Math.cos(a) * d, top + (spark.y + 0.5) * tile + Math.sin(a) * d, tile * 0.05, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;

      // Pac-Man: one chomp per tile, which lands on the beat's eighth notes.
      const chomp = playing ? Math.abs(Math.sin(phase * 2 * Math.PI)) : Math.abs(Math.sin(clock * 6));
      const mouth = 0.04 + chomp * 0.32 * Math.PI;
      const px = left + (pac.x + pac.dx * pac.progress + 0.5) * tile,
        py = top + (pac.y + pac.dy * pac.progress + 0.5) * tile;
      const size = tile * 0.46 * (1 + power * 0.15);
      g.save();
      g.translate(px, py);
      g.rotate(pac.facing);
      g.fillStyle = "#ffe23a";
      g.shadowColor = "#ffd000";
      g.shadowBlur = tile * (0.4 + power * 0.6);
      g.beginPath();
      g.moveTo(0, 0);
      g.arc(0, 0, size, mouth, Math.PI * 2 - mouth);
      g.closePath();
      g.fill();
      g.restore();
      g.shadowBlur = 0;

      g.font = `bold ${Math.round(tile * 0.55)}px ui-monospace, Menlo, monospace`;
      g.fillStyle = "#ffffff";
      g.globalAlpha = 0.85;
      g.textBaseline = "middle";
      g.fillText(`${score}`.padStart(6, "0"), left + tile * 0.4, top + tile * 0.5);
      g.globalAlpha = 1;
    },
    dispose() {
      canvas.remove();
    },
  };
}
