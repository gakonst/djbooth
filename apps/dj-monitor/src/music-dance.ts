/** Unitless choreography shared by characters, scenery and shader renderers. */
export type MusicDance = {
  active: boolean;
  beat: number;
  drive: number;
  /** Lift between kicks; feet return to the floor on the beat. */
  bounce: number;
  /** Alternating weight shift, once per two beats. */
  sway: number;
  /** Head/shoulder emphasis on each beat. */
  nod: number;
  /** A slower four-beat torso/ornament turn. */
  twist: number;
  kick: number;
  /** Eighth-note accents, gated by treble energy. */
  tap: number;
};

export const STILL_DANCE: MusicDance = {
  active: false,
  beat: 0,
  drive: 0,
  bounce: 0,
  sway: 0,
  nod: 0,
  twist: 0,
  kick: 0,
  tap: 0,
};
const clamp = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);
const fraction = (n: number) => ((n % 1) + 1) % 1;

/** Track beat position is authoritative. Motion controls scale poses, never the song's tempo. */
export function sampleDance(
  beat: number,
  level: number,
  low: number,
  mid: number,
  high: number,
): MusicDance {
  const active = Number.isFinite(beat) && Number.isFinite(level) && level > 0.008;
  if (!active) return { ...STILL_DANCE, beat: Number.isFinite(beat) ? beat : 0 };
  const drive = clamp(Math.sqrt(clamp(level)) * 1.35);
  const bass = clamp(low / Math.max(level, 0.08));
  const body = clamp(mid / Math.max(level, 0.08));
  const air = clamp(high / Math.max(level, 0.08));
  const angle = beat * Math.PI * 2;
  return {
    active,
    beat,
    drive,
    bounce: (0.5 - 0.5 * Math.cos(angle)) * drive * (0.35 + bass * 0.65),
    sway: Math.sin(angle * 0.5) * drive * (0.45 + body * 0.55),
    nod: Math.cos(angle) * drive * (0.3 + bass * 0.7),
    twist: Math.sin(angle * 0.25) * drive * (0.35 + body * 0.65),
    kick: Math.exp(-fraction(beat) * 9) * bass * drive,
    tap: Math.exp(-fraction(beat * 2) * 12) * air * drive,
  };
}

/** Pose smoothing softens crossfade/seek handoffs and releases the dancers into rest. */
export function createDanceMotion() {
  const value = { ...STILL_DANCE };
  return {
    update(
      beat: number,
      level: number,
      low: number,
      mid: number,
      high: number,
      elapsed: number,
    ): MusicDance {
      const next = sampleDance(beat, level, low, mid, high);
      const dt = Number.isFinite(elapsed) ? Math.max(0, Math.min(0.1, elapsed)) : 0;
      const blend = 1 - Math.exp(-dt * (next.active ? 26 : 8));
      value.active = next.active;
      if (next.active) value.beat = next.beat;
      for (const key of ["drive", "bounce", "sway", "nod", "twist", "kick", "tap"] as const)
        value[key] += (next[key] - value[key]) * blend;
      return value;
    },
  };
}
