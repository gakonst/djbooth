import { describe, expect, it } from "vitest";
import {
  advanceRaceGame,
  CHECKPOINTS,
  createRaceGame,
  type RaceInput,
} from "../../dj-monitor/src/race-game.js";
const input: RaceInput = {
  motion: 1,
  activity: 1,
  beat: 0,
  reducedMotion: false,
  crowd: { active: false, energy: 0, steering: 0 },
};
function frames(
  game: ReturnType<typeof createRaceGame>,
  count: number,
  override: Partial<RaceInput> = {},
) {
  for (let i = 0; i < count; i++) advanceRaceGame(game, 1 / 60, 1000, { ...input, ...override });
}
describe("space race simulation", () => {
  it("crosses checkpoints and laps without resetting integrated race distance", () => {
    const game = createRaceGame();
    game.distance = 999.9;
    advanceRaceGame(game, 0.05, 1000, input);
    expect(game.distance).toBeGreaterThan(1000);
    expect(game.checkpoints).toBe(CHECKPOINTS);
    expect(game.lap).toBe(2);
    frames(game, 120);
    expect(game.checkpoints).toBeGreaterThan(CHECKPOINTS);
  });
  it("integrates rival positions and changes rank on real overtaking", () => {
    const game = createRaceGame();
    const before = game.rivals.map((rival) => rival.distance);
    frames(game, 1800);
    game.rivals.forEach((rival, i) => expect(rival.distance).toBeGreaterThan(before[i]!));
    expect(game.place).toBe(1);
    frames(game, 6000, { activity: 0 });
    expect(game.place).toBe(4);
  });
  it("requires charge and a rising beat, then limits boost duration and frequency", () => {
    const game = createRaceGame();
    game.charge = 1;
    frames(game, 1, { beat: 1 });
    expect(game.boost).toBe(1.5);
    expect(game.charge).toBe(0);
    frames(game, 120, { beat: 1 });
    expect(game.boost).toBe(0);
    expect(game.cooldown).toBeGreaterThan(0);
    game.charge = 1;
    frames(game, 600, { beat: 1 });
    expect(game.boost).toBe(0); // held input is never another beat edge
    frames(game, 1, { beat: 0 });
    frames(game, 1, { beat: 1 });
    expect(game.boost).toBe(1.5);
  });
  it.each([{ motion: 0 }, { reducedMotion: true }])(
    "freezes race, crowd steering and boost timers when paused: %j",
    (override) => {
      const game = createRaceGame();
      game.boost = 1;
      const before = structuredClone(game);
      frames(game, 200, { ...override, crowd: { active: true, energy: 1, steering: 1 } });
      expect(game).toEqual({ ...before, speed: 0 });
    },
  );
  it("bounds and smooths crowd steering, and returns to center when disabled", () => {
    const game = createRaceGame();
    frames(game, 1, { crowd: { active: true, energy: 8, steering: 100 } });
    expect(game.lane).toBeGreaterThan(0);
    expect(game.lane).toBeLessThan(0.3);
    frames(game, 600, { crowd: { active: true, energy: 8, steering: 100 } });
    expect(game.lane).toBeLessThanOrEqual(3.7);
    expect(game.crowdEnergy).toBeLessThanOrEqual(1);
    frames(game, 600);
    expect(game.lane).toBeCloseTo(0);
  });
  it("caps suspended frames and increases integrated speed with music and boost", () => {
    const slow = createRaceGame();
    const loud = createRaceGame();
    const boosted = createRaceGame();
    boosted.charge = 1;
    frames(slow, 60, { activity: 0 });
    frames(loud, 60);
    frames(boosted, 60, { beat: 1 });
    expect(loud.distance).toBeGreaterThan(slow.distance);
    expect(boosted.distance).toBeGreaterThan(loud.distance);
    const normal = createRaceGame();
    const delayed = createRaceGame();
    advanceRaceGame(normal, 0.05, 1000, input);
    advanceRaceGame(delayed, 100, 1000, input);
    expect(delayed).toEqual(normal);
  });
});
