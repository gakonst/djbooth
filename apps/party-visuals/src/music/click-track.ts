import { audioContext, type PreviewDeck } from "../decks.js";
import { chartFor, type Note } from "./note-chart.js";

/** Lower lanes tick lower, so kicks and hats sound different. */
const PITCH = [520, 700, 900, 1150, 1450];
const LOOK_AHEAD = 0.2;

/**
 * Ticks on every charted note, scheduled ahead on the audio clock, so you can hear whether
 * the chart sits on the music instead of judging it by eye.
 */
export class ClickTrack {
  enabled = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly scheduled = new Map<PreviewDeck, { track: string; until: number }>();

  constructor(private readonly decks: PreviewDeck[]) {}

  toggle() {
    this.enabled = !this.enabled;
    clearInterval(this.timer);
    this.scheduled.clear();
    if (this.enabled) this.timer = setInterval(() => this.schedule(), 25);
    return this.enabled;
  }

  private schedule() {
    const context = audioContext();
    if (!context) return;
    for (const deck of this.decks) {
      const track = deck.track?.id;
      if (!track || !deck.playing || !deck.waveform?.peaks.length) {
        this.scheduled.delete(deck);
        continue;
      }
      const chart = chartFor(track, deck.waveform, deck.bpm, deck.rhythm);
      const now = deck.audio.currentTime;
      const rate = deck.audio.playbackRate || 1;
      let from = this.scheduled.get(deck);
      // A new track or a seek starts again from the playhead.
      if (!from || from.track !== track || from.until < now - 0.5 || from.until > now + 1)
        from = { track, until: now };
      const until = now + LOOK_AHEAD;
      let last = -1;
      for (const note of chart.notes) {
        if (note.time <= from.until || note.time === last) continue;
        if (note.time > until) break;
        // Chords tick once, on their lowest lane.
        last = note.time;
        this.tick(context, context.currentTime + (note.time - now) / rate, note);
      }
      this.scheduled.set(deck, { track, until });
    }
  }

  private tick(context: AudioContext, at: number, note: Note) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = PITCH[note.lane]! * (note.big ? 0.5 : 1);
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(note.big ? 0.45 : 0.3, at + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.05);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(at);
    oscillator.stop(at + 0.06);
  }
}
