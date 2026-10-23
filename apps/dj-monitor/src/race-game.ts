/** Pure racing simulation. Distances are unwrapped so overtaking and laps are real. */
export const CHECKPOINTS = 8;
const bound = (n: number, lo = 0, hi = 1) =>
  Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
export function createRaceGame() {
  return {
    distance: 0,
    speed: 44,
    clock: 0,
    lane: 0,
    crowdEnergy: 0,
    charge: 0.35,
    boost: 0,
    cooldown: 0,
    beatHigh: false,
    checkpoints: 0,
    lap: 1,
    place: 4,
    rivals: [
      { distance: 22, speed: 52, lane: -3.3 },
      { distance: 49, speed: 61, lane: 3.3 },
      { distance: 82, speed: 68, lane: -1.8 },
    ],
  };
}
export type RaceGame = ReturnType<typeof createRaceGame>;
export type RaceInput = {
  motion: number;
  activity: number;
  beat: number;
  reducedMotion: boolean;
  crowd: { active: boolean; energy: number; steering: number };
};
export function advanceRaceGame(game: RaceGame, delta: number, length: number, input: RaceInput) {
  const dt = bound(delta, 0, 0.05);
  const movement = input.reducedMotion ? 0 : bound(input.motion, 0, 2);
  if (!movement) {
    game.speed = 0;
    return;
  }
  if (!dt || !Number.isFinite(length) || length <= 0) return;
  const activity = bound(input.activity);
  const beatHigh = bound(input.beat) > 0.38;
  const steering = input.crowd.active ? bound(input.crowd.steering, -1, 1) * 3.7 : 0;
  game.lane += (steering - game.lane) * (1 - Math.exp(-dt * 3));
  game.crowdEnergy +=
    ((input.crowd.active ? bound(input.crowd.energy) : 0) - game.crowdEnergy) *
    (1 - Math.exp(-dt * 2));
  game.clock += dt * movement;
  game.boost = Math.max(0, game.boost - dt);
  game.cooldown = Math.max(0, game.cooldown - dt);
  game.charge = Math.min(1, game.charge + dt * (activity * 0.13 + game.crowdEnergy * 0.045));
  // A charged, rising beat launches a 1.5s burn; cooldown and recharge prevent beat spam.
  if (beatHigh && !game.beatHigh && game.charge >= 0.99 && game.cooldown === 0) {
    game.boost = 1.5;
    game.cooldown = 6;
    game.charge = 0;
  }
  game.beatHigh = beatHigh;
  const targetSpeed =
    (44 + activity * 30 + game.crowdEnergy * 5 + (game.boost > 0 ? 35 : 0)) * movement;
  game.speed += (targetSpeed - game.speed) * (1 - Math.exp(-dt * 3));
  game.distance += game.speed * dt;
  for (let i = 0; i < game.rivals.length; i++) {
    const rival = game.rivals[i]!;
    const pace = (52 + i * 8 + Math.sin(game.clock * 0.37 + i * 2) * 6) * movement;
    rival.speed += (pace - rival.speed) * (1 - Math.exp(-dt * 2));
    rival.distance += rival.speed * dt;
  }
  game.checkpoints = Math.floor(game.distance / (length / CHECKPOINTS));
  game.lap = Math.floor(game.distance / length) + 1;
  game.place = 1 + game.rivals.filter((rival) => rival.distance > game.distance).length;
}
