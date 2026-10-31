/** A visible beat accent for every renderer, driven only by the audible track's beat position. */
export function createBeatPulse() {
  let value = 0;
  return {
    update(beat: number, level: number, elapsed: number, reduced: boolean) {
      if (reduced) return (value = 0);
      const active = Number.isFinite(beat) && Number.isFinite(level) && level > 0.008;
      const phase = ((beat % 1) + 1) % 1;
      const target = active
        ? Math.exp(-phase * 7) * Math.min(1, Math.sqrt(Math.max(0, level)) * 2)
        : 0;
      const dt = Number.isFinite(elapsed) ? Math.max(0, Math.min(0.1, elapsed)) : 0;
      value += (target - value) * (1 - Math.exp(-dt * (target > value ? 50 : 15)));
      return value;
    },
  };
}
