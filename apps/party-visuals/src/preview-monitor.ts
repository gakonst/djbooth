import type { ControlState, DashboardSnapshot } from "../../dj-monitor/src/types.js";
import { waveformBeat } from "../../dj-monitor/src/waveform-signal.js";
import type { PreviewDeck } from "./decks.js";

/** A display-only snapshot of browser playback; never sent to physical players. */
export function previewSnapshot(decks: PreviewDeck[], sequence: number): DashboardSnapshot {
  const observedAtUs = performance.now() * 1000;
  const controls: Record<string, ControlState> = {};
  for (const [index, deck] of decks.entries()) {
    controls[`channel.${index + 1}.fader`] = {
      label: `Channel ${index + 1}`,
      value: Math.round(deck.fader * 127),
      percent: deck.fader * 100,
      state: null,
      raw: "browser preview",
      changedAtUs: observedAtUs,
    };
  }
  return {
    schemaVersion: 1,
    sequence,
    observedAtUs,
    mixer: {
      device: "Simulated mixer",
      connected: true,
      bpm: decks.find((deck) => deck.playing)?.bpm ?? null,
      controls,
      meters: {},
    },
    decks: decks.map((deck, index) => {
      const position = deck.audio.currentTime;
      const duration = Number.isFinite(deck.audio.duration)
        ? deck.audio.duration
        : (deck.track?.durationSeconds ?? null);
      const beat = Math.floor(waveformBeat(deck.waveform, position, deck.sourceBpm));
      return {
        player: index + 1,
        connected: true,
        source: "djLink",
        model: "CDJ-3000",
        ip: null,
        active: !!deck.track,
        sourcePlayer: null,
        sourceSlot: null,
        trackType: null,
        trackId: deck.track ? Number(deck.track.id) : null,
        trackTitle: deck.track?.title ?? null,
        trackArtist: deck.track?.artist ?? null,
        trackAlbum: null,
        trackArtworkUrl: null,
        playing: deck.playing,
        playState: deck.playing ? "playing" : "paused",
        synced: false,
        tempoMaster: deck.fader >= 0.5,
        bpm: deck.track?.bpm ?? null,
        effectiveBpm: deck.bpm,
        pitchPercent: (deck.audio.playbackRate - 1) * 100,
        beatInBar: (((beat % 4) + 4) % 4) + 1,
        beatNumber: beat + 1,
        trackProgressPercent: duration ? (position / duration) * 100 : 0,
        trackLengthSec: duration,
        playheadMs: position * 1000,
      };
    }),
  };
}
