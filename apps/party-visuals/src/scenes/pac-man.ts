import { createDanceMotion, type MusicDance } from "../../../dj-monitor/src/music-dance.js";
import { DEFAULT_VISUAL_LOOK, type VisualLook } from "../../../dj-monitor/src/visual-presets.js";
import type { MusicLane, SceneEngine } from "../scenes.js";
import { createWaveformPulse } from "../music/waveform-pulse.js";

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
  const open = (x: number, y: number) =>
    x > 0 && y > 0 && x < half && y < rows - 1 && grid[y]![x] !== WALL;
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
          y + dy * 2 > 0 &&
          y + dy * 2 < rows - 1 &&
          x + dx * 2 > 0 &&
          x + dx * 2 < half &&
          !open(x + dx, y + dy),
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
  // Rasterize the soft pellet glow once, rather than blurring hundreds of paths per frame.
  const pellet = document.createElement("canvas");
  pellet.width = pellet.height = 64;
  const pg = pellet.getContext("2d")!;
  pg.fillStyle = "#f5bd38";
  pg.shadowColor = "#e9b84e";
  pg.shadowBlur = 10;
  pg.beginPath();
  pg.arc(32, 32, 12, 0, Math.PI * 2);
  pg.fill();
  pg.shadowBlur = 0;
  pg.fillStyle = "#fff6c8";
  pg.beginPath();
  pg.arc(28.4, 28.4, 4.2, 0, Math.PI * 2);
  pg.fill();
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");

  let target: VisualLook = { ...DEFAULT_VISUAL_LOOK };
  const look = { ...target };
  let music: MusicLane[] = [];
  const waveformPulse = createWaveformPulse();
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
    power = 0,
    refilling = false;

  const isOpen = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < cols && y < rows && maze[y]![x] !== WALL;
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
        Math.abs(coin.x - cx) + Math.abs(coin.y - cy) <
        Math.abs(best.x - cx) + Math.abs(best.y - cy)
          ? coin
          : best,
      );
      near.power = true;
    }
    // Start in the middle of the bottom-most corridor near the centre.
    const start = coins.reduce((best, coin) =>
      Math.abs(coin.x - cols / 2) + Math.abs(coin.y - rows * 0.75) <
      Math.abs(best.x - cols / 2) + Math.abs(best.y - rows * 0.75)
        ? coin
        : best,
    );
    Object.assign(pac, { x: start.x, y: start.y, dx: 0, dy: 0, progress: 0 });
    start.eaten = true;
    refilling = false;
    drawWalls();
  }

  /** Cached masonry, worn seams and copper inlay; rebuilt only when the board changes. */
  function drawWalls() {
    walls.width = Math.round(width * ratio);
    walls.height = Math.round(height * ratio);
    const g = walls.getContext("2d")!;
    g.scale(ratio, ratio);
    g.lineCap = "round";
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        const xx = left + x * tile,
          yy = top + y * tile;
        const solid = !isOpen(x, y);
        const stone = g.createLinearGradient(xx, yy, xx + tile, yy + tile);
        stone.addColorStop(0, solid ? "#393243" : "#15131c");
        stone.addColorStop(0.3, solid ? "#24212e" : "#0c0d14");
        stone.addColorStop(1, "#07080e");
        g.fillStyle = stone;
        g.fillRect(xx + 1, yy + 1, tile - 2, tile - 2);
        g.strokeStyle = solid ? "#514252" : "#25212b";
        g.lineWidth = 0.6;
        g.beginPath();
        g.moveTo(xx + 2, yy + tile - 2);
        g.lineTo(xx + 2, yy + 2);
        g.lineTo(xx + tile - 2, yy + 2);
        g.stroke();
        if (solid) {
          // Recessed wall edges cast permanent occlusion into the corridor floor.
          for (const [dx, dy] of DIRECTIONS) {
            if (!isOpen(x + dx, y + dy)) continue;
            const edge = tile * 0.09;
            g.fillStyle = "rgba(0,0,0,0.32)";
            g.fillRect(
              xx + (dx > 0 ? tile : dx < 0 ? -edge : 0),
              yy + (dy > 0 ? tile : dy < 0 ? -edge : 0),
              dx ? edge : tile,
              dy ? edge : tile,
            );
          }
        }
        // Deterministic chips and cracks avoid a noisy animated texture.
        g.strokeStyle = "#090911";
        g.beginPath();
        g.moveTo(xx + tile * 0.23, yy);
        g.lineTo(xx + tile * 0.35, yy + tile * 0.24);
        g.lineTo(xx + tile * 0.28, yy + tile * 0.42);
        g.stroke();
        if (solid && (x * 7 + y * 11) % 13 === 0) {
          g.fillStyle = "#796746";
          g.font = `${tile * 0.38}px serif`;
          g.textAlign = "center";
          g.fillText("✦", xx + tile / 2, yy + tile * 0.64);
        }
      }
    g.textAlign = "start";
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
    trace(Math.max(1.5, tile * 0.09), "#7437a4", tile * 0.28);
    trace(Math.max(1, tile * 0.04), "#be895c", 0);
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
        sparks.push({
          x: pac.x,
          y: pac.y,
          age: -k * 0.03,
          color: coin!.power ? "#ff8fd8" : "#ffd75a",
        });
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

  let suppliedDance: MusicDance | undefined;
  const fallbackDance = createDanceMotion();
  return {
    setDance(next) {
      suppliedDance = next;
    },
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
      const r = Math.min(devicePixelRatio || 1, 1.5, 1920 / w, 1920 / h);
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
      const dance =
        suppliedDance ??
        fallbackDance.update(
          phase,
          energy[lane * 4] ?? 0,
          energy[lane * 4 + 1] ?? 0,
          energy[lane * 4 + 2] ?? 0,
          energy[lane * 4 + 3] ?? 0,
          dt,
        );
      const danceAmount = reduced.matches
        ? 0
        : Math.min(1.5, Math.max(0, look.motion * look.intensity));
      const { pulse } = waveformPulse.update(music, dt);
      power *= Math.exp(-dt * 0.9);
      const damping = (reduced.matches ? 0.15 : 1) * look.motion;
      // Two tiles per beat with music, a gentle stroll without.
      const wantSpeed = (playing ? ((2 * bpm) / 60) * (0.8 + pulse * 1.2) : 3) * damping;
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

      // Masonry keeps its material color; musical light belongs to individual props.
      g.globalAlpha = Math.min(1, 0.85 * look.intensity);
      g.drawImage(walls, 0, 0, w, h);
      g.globalAlpha = 1;
      if (power > 0.02) {
        const cx = left + (pac.x + pac.dx * pac.progress + 0.5) * tile;
        const cy = top + (pac.y + pac.dy * pac.progress + 0.5) * tile;
        const halo = g.createRadialGradient(cx, cy, 0, cx, cy, tile * 1.8);
        halo.addColorStop(0, `rgba(244,149,58,${power * 0.22})`);
        halo.addColorStop(1, "rgba(244,149,58,0)");
        g.fillStyle = halo;
        g.fillRect(cx - tile * 1.8, cy - tile * 1.8, tile * 3.6, tile * 3.6);
      }

      // Small localized responses preserve the carved silhouettes on strong beats.
      const breathe = 1 + pulse * (reduced.matches ? 0 : 0.07);
      for (const coin of coins) {
        if (coin.eaten || coin.appearAt > clock + 0.5) continue;
        const grow = Math.min(1, Math.max(0, (clock - coin.appearAt) / 0.3));
        if (grow <= 0) continue;
        const pop = grow < 1 ? 1 + Math.sin(grow * Math.PI) * 0.4 : 1;
        const cx = left + (coin.x + 0.5) * tile,
          cy = top + (coin.y + 0.5) * tile;
        if (coin.power) {
          const skin = g.createRadialGradient(
            cx - tile * 0.1,
            cy - tile * 0.12,
            0,
            cx,
            cy,
            tile * 0.32,
          );
          skin.addColorStop(0, "#ffdc8a");
          skin.addColorStop(0.5, "#e99736");
          skin.addColorStop(1, "#8a3b19");
          g.fillStyle = skin;
          g.shadowColor = "#e9a348";
          g.shadowBlur = tile * 0.6;
          g.beginPath();
          g.arc(cx, cy, tile * 0.3 * grow * pop * breathe, 0, Math.PI * 2);
          g.fill();
          // Jack-o-lantern power pellets: dark lobes, stem and carved candle eyes.
          const pr = tile * 0.3 * grow * pop * breathe;
          g.shadowBlur = 0;
          g.strokeStyle = "#9a4819";
          g.lineWidth = Math.max(1, tile * 0.025);
          for (const side of [-1, 1]) {
            g.beginPath();
            g.ellipse(cx + side * pr * 0.28, cy, pr * 0.35, pr * 0.92, 0, 0, Math.PI * 2);
            g.stroke();
          }
          g.fillStyle = "#37492c";
          g.fillRect(cx - pr * 0.12, cy - pr * 1.23, pr * 0.24, pr * 0.4);
          g.fillStyle = "#2b130b";
          for (const side of [-1, 1]) {
            g.beginPath();
            g.moveTo(cx + side * pr * 0.48, cy - pr * 0.42);
            g.lineTo(cx + side * pr * 0.12, cy);
            g.lineTo(cx + side * pr * 0.65, cy);
            g.fill();
          }
          g.beginPath();
          g.arc(cx, cy + pr * 0.12, pr * 0.52, 0, Math.PI);
          g.fill();
        } else {
          const radius = tile * 0.12 * grow * pop * breathe;
          const extent = (radius * 64) / 12;
          g.drawImage(pellet, cx - extent / 2, cy - extent / 2, extent, extent);
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
        const d = spark.age * tile * (reduced.matches ? 0.2 : 1.6);
        g.globalAlpha = 1 - spark.age / 0.45;
        g.fillStyle = spark.color;
        g.beginPath();
        g.arc(
          left + (spark.x + 0.5) * tile + Math.cos(a) * d,
          top + (spark.y + 0.5) * tile + Math.sin(a) * d,
          tile * 0.05,
          0,
          Math.PI * 2,
        );
        g.fill();
      }
      g.globalAlpha = 1;

      // Pac-Man: one chomp per tile, which lands on the beat's eighth notes.
      const chomp = reduced.matches
        ? 0.35
        : playing
          ? Math.abs(Math.sin(phase * 2 * Math.PI))
          : Math.abs(Math.sin(clock * 6));
      const mouth = 0.04 + chomp * 0.32 * Math.PI;
      const px = left + (pac.x + pac.dx * pac.progress + 0.5) * tile,
        py = top + (pac.y + pac.dy * pac.progress + 0.5) * tile;
      const size = tile * 0.46 * (1 + power * 0.04 + pulse * (reduced.matches ? 0 : 0.035));
      const contact = g.createRadialGradient(
        px,
        py + tile * 0.22,
        0,
        px,
        py + tile * 0.22,
        size * 1.2,
      );
      contact.addColorStop(0, "rgba(0,0,0,0.58)");
      contact.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = contact;
      g.save();
      g.translate(px, py + tile * 0.22);
      g.scale(1, 0.48);
      g.translate(-px, -py - tile * 0.22);
      g.fillRect(px - size * 1.2, py + tile * 0.22 - size * 1.2, size * 2.4, size * 2.4);
      g.restore();
      g.save();
      // Rendering alone bobs and squashes; pathfinding and coin coordinates never change.
      g.translate(px, py - tile * 0.075 * dance.bounce * danceAmount);
      g.scale(1 + dance.kick * 0.075 * danceAmount, 1 - dance.kick * 0.09 * danceAmount);
      g.rotate(pac.facing + dance.sway * 0.12 * danceAmount);
      const shell = g.createRadialGradient(-size * 0.3, -size * 0.4, 0, 0, 0, size);
      shell.addColorStop(0, "#ffe6a1");
      shell.addColorStop(0.45, "#ee9d31");
      shell.addColorStop(1, "#9d3e16");
      g.fillStyle = shell;
      g.shadowColor = "#ef963b";
      g.shadowBlur = tile * (0.4 + power * 0.6);
      g.beginPath();
      g.moveTo(0, 0);
      g.arc(0, 0, size, mouth, Math.PI * 2 - mouth);
      g.closePath();
      g.fill();
      g.clip();
      g.shadowBlur = 0;
      g.strokeStyle = "#ac511f";
      g.lineWidth = size * 0.045;
      for (const offset of [-0.5, 0, 0.5]) {
        g.beginPath();
        g.ellipse(offset * size, 0, size * 0.4, size, 0, 0, Math.PI * 2);
        g.stroke();
      }
      g.fillStyle = "#25111a";
      g.beginPath();
      g.moveTo(size * 0.02, -size * 0.72);
      g.lineTo(size * 0.42, -size * 0.33);
      g.lineTo(-size * 0.12, -size * 0.3);
      g.fill();
      g.fillStyle = "#fff5bb";
      g.beginPath();
      g.arc(size * 0.08, -size * 0.45, size * 0.06, 0, Math.PI * 2);
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
      walls.width = walls.height = 0;
      pellet.width = pellet.height = 0;
    },
  };
}
