import type { MusicLane } from "../scenes.js";
import { analyzeSong, idleSong, type SongMap } from "./song-map.js";

export type Followed = { key: string; song: SongMap; time: number; playing: boolean };

/**
 * Picks the song a scene should follow: the loudest playing deck, with a demo song when nothing
 * plays. Its clock runs steadily and is only gently pulled towards the deck's uneven one.
 */
export function createMusicFollower() {
  const songs = new Map<string, SongMap>();
  const idle = idleSong();
  let leader = -1;
  let challengerSince = 0;
  let idleTime = 0;
  let current: Followed = { key: "idle", song: idle, time: 0, playing: true };

  const songFor = (lane: MusicLane) => {
    if (!lane.trackId || !lane.waveform) return undefined;
    let song = songs.get(lane.trackId);
    if (!song) {
      song = analyzeSong(lane.waveform, lane.bpm);
      songs.set(lane.trackId, song);
    }
    return song;
  };

  return {
    idle,
    update(lanes: MusicLane[], clock: number, dt: number): Followed {
      // Another deck has to stay clearly louder for a moment to take over.
      const loudness = lanes.map((lane) => (lane.playing && lane.waveform ? lane.level + 0.001 : 0));
      let best = -1;
      loudness.forEach((value, i) => value > 0 && (best < 0 || value > loudness[best]!) && (best = i));
      const leading = loudness[leader] ?? 0;
      if (best >= 0 && best !== leader && (leading <= 0 || loudness[best]! > leading * 1.4)) {
        challengerSince ||= clock;
        if (leading <= 0 || clock - challengerSince > 0.8) {
          leader = best;
          challengerSince = 0;
        }
      } else challengerSince = 0;

      const lane = lanes[leader];
      const song = lane ? songFor(lane) : undefined;
      // A paused deck holds the scene still where it is.
      if (lane && song && (lane.playing || current.key === lane.trackId)) {
        let time = current.time;
        const drift = lane.time - time;
        if (current.key !== lane.trackId || Math.abs(drift) > 0.5) time = lane.time;
        else if (lane.playing) time += dt + drift * Math.min(1, dt * 1.5);
        current = { key: lane.trackId!, song, time, playing: lane.playing };
      } else {
        idleTime += dt;
        current = { key: "idle", song: idle, time: idleTime % idle.duration, playing: true };
      }
      return current;
    },
  };
}
