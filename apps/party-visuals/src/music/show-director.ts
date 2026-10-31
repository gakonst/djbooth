import { waveformBeat } from "../../../dj-monitor/src/waveform-signal.js";
import type { MusicLane } from "../scenes.js";
import { analyzeSong, sectionAt, type SongMap, type Style } from "./song-map.js";

export type ShowCue = {
  active: boolean;
  bpm: number;
  beat: number;
  phase: Style | "idle";
  source: "phrases" | "waveform" | "audio" | "idle";
  progress: number;
  bass: number;
  body: number;
  air: number;
  kick: number;
  energy: number;
  bloom: number;
};

const clamp = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0);
const phraseStyle = {
  intro: "vocal",
  up: "build",
  down: "break",
  verse: "vocal",
  bridge: "break",
  chorus: "drop",
  outro: "break",
} as const;

/** One musical lighting desk for every scene. No synthetic beats when the decks are silent. */
export function createShowDirector() {
  const maps = new WeakMap<object, { bpm: number; song: SongMap }>();
  let leader = -1;
  let challenger = -1;
  let held = 0;
  let sectionKey = "";
  let bloom = 0;
  let bass = 0,
    body = 0,
    air = 0,
    energy = 0,
    kick = 0;
  const smooth = (from: number, to: number, dt: number) =>
    from + (to - from) * (1 - Math.exp(-dt * (to > from ? 16 : 5)));

  return {
    update(lanes: MusicLane[], bands: Float32Array, elapsed: number): ShowCue {
      const dt = Math.max(0, Math.min(0.1, elapsed));
      const levels = lanes.map((lane) => (lane.playing ? clamp(lane.level) : 0));
      let best = -1;
      levels.forEach((value, i) => {
        if (value > 0.008 && (best < 0 || value > levels[best]!)) best = i;
      });
      if (best !== leader && best >= 0) {
        if ((levels[leader] ?? 0) < 0.008) leader = best;
        else if (levels[best]! > levels[leader]! * 1.3) {
          if (challenger !== best) {
            challenger = best;
            held = 0;
          }
          held += dt;
          if (held >= 0.65) {
            leader = best;
            held = 0;
          }
        } else {
          challenger = -1;
          held = 0;
        }
      } else {
        challenger = -1;
        held = 0;
      }
      const active = best >= 0;
      const lane = active ? lanes[leader] : undefined;
      const sum = (offset: number) =>
        clamp(
          lanes.reduce(
            (total, item, i) =>
              total + (item.playing && levels[i]! > 0.008 ? (bands[i * 4 + offset] ?? 0) : 0),
            0,
          ),
        );
      bass = smooth(bass, sum(1), dt);
      body = smooth(body, sum(2), dt);
      air = smooth(air, sum(3), dt);
      energy = smooth(energy, clamp(levels.reduce((a, b) => a + b, 0)), dt);
      const sourceBpm = lane?.sourceBpm ?? lane?.bpm ?? 120;
      let beat = lane ? waveformBeat(lane.waveform, lane.time, sourceBpm) : 0;
      // Some beat grids begin on beat 2–4, rather than on a downbeat.
      beat += (lane?.waveform?.beatGrid?.[0]?.beat ?? 1) - 1;
      const beatPhase = ((beat % 1) + 1) % 1;
      kick = smooth(kick, active ? Math.exp(-beatPhase * 9) * clamp(bass * 1.8) : 0, dt);
      let phase: ShowCue["phase"] = active ? "groove" : "idle";
      let source: ShowCue["source"] = active ? "audio" : "idle";
      let progress = 0;
      let start = 0;
      const phrase = lane?.rhythm?.phrases?.entries.find(
        (item) => lane.time >= item.startSeconds && lane.time < item.endSeconds,
      );
      if (phrase) {
        phase = phraseStyle[phrase.kind];
        source = "phrases";
        start = phrase.startSeconds;
        progress = clamp((lane!.time - start) / Math.max(0.01, phrase.endSeconds - start));
      } else if (
        lane?.waveform?.source === "rekordbox" &&
        lane.waveform.durationSeconds > 0 &&
        lane.waveform.peaks.length
      ) {
        let cached = maps.get(lane.waveform);
        if (
          !cached ||
          (!lane.waveform.beatGrid?.length && Math.abs(cached.bpm - sourceBpm) > 0.5)
        ) {
          cached = { bpm: sourceBpm, song: analyzeSong(lane.waveform, sourceBpm) };
          maps.set(lane.waveform, cached);
        }
        const section = sectionAt(cached.song, lane.time);
        if (section) {
          phase = section.style;
          source = "waveform";
          start = section.start;
          progress = clamp((lane.time - start) / Math.max(0.01, section.end - start));
        }
      }
      const key = `${lane?.trackId ?? "idle"}:${start}:${phase}`;
      // A seek or a new track resets the lighting to that phrase; the glow is bounded and decays.
      if (key !== sectionKey) {
        bloom = phase === "drop" && active ? 0.7 : 0;
        sectionKey = key;
      }
      bloom *= Math.exp(-dt * 1.6);
      return {
        active,
        bpm: lane?.bpm ?? 0,
        beat,
        phase,
        source,
        progress,
        bass,
        body,
        air,
        kick,
        energy,
        bloom,
      };
    },
  };
}
