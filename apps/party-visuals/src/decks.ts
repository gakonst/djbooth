import type { TrackRhythm } from "../../djbooth/src/shared/types.js";
import type { TrackWaveform } from "../../dj-monitor/src/types.js";

export type LibraryTrack = {
  id: string;
  title: string | null;
  artist: string | null;
  bpm: number | null;
  durationSeconds: number | null;
  fileExists: boolean;
  path?: string | null;
};

export const trackLabel = (track: LibraryTrack) =>
  track.title || track.path?.split("/").pop() || track.id;

let context: AudioContext | undefined;

/** The page's shared audio graph, once a deck has been started by a user gesture. */
export const audioContext = () => context;

/** One preview player fed from the Rekordbox library, analysed for the visuals. */
export class PreviewDeck {
  readonly audio = new Audio();
  analyser?: AnalyserNode;
  gain?: GainNode;
  track: LibraryTrack | null = null;
  waveform: TrackWaveform | null = null;
  rhythm: TrackRhythm | null = null;
  fader: number;
  private loads = 0;

  constructor(fader: number) {
    this.fader = fader;
    this.audio.preload = "auto";
  }

  get playing() {
    return !this.audio.paused && !this.audio.ended;
  }

  get bpm() {
    return (this.track?.bpm ?? 120) * this.audio.playbackRate;
  }

  /** Browsers only allow audio graphs after a user gesture; call from a key or click. */
  private connect() {
    context ??= new AudioContext();
    if (!this.analyser) {
      this.analyser = context.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.8;
      this.gain = context.createGain();
      this.gain.gain.value = this.fader * 0.8;
      context.createMediaElementSource(this.audio).connect(this.analyser);
      this.analyser.connect(this.gain);
      this.gain.connect(context.destination);
    }
    void context.resume();
  }

  async load(track: LibraryTrack) {
    const load = ++this.loads;
    this.connect();
    this.track = track;
    this.waveform = null;
    this.rhythm = null;
    this.audio.src = `/api/audio/${encodeURIComponent(track.id)}`;
    await this.audio.play();
    const id = encodeURIComponent(track.id);
    const [waveform, rhythm] = await Promise.all([
      fetch(`/api/waveforms/${id}`),
      // Older workbenches have no rhythm route; the chart then reads the colour waveform.
      fetch(`/api/rhythm/${id}`).catch(() => undefined),
    ]);
    if (load !== this.loads) return;
    if (rhythm?.ok) this.rhythm = ((await rhythm.json()) as { rhythm: TrackRhythm }).rhythm;
    if (waveform.ok) this.waveform = ((await waveform.json()) as { waveform: TrackWaveform }).waveform;
  }

  async toggle() {
    if (!this.track) return;
    this.connect();
    if (this.playing) this.audio.pause();
    else await this.audio.play();
  }

  seek(seconds: number) {
    if (Number.isFinite(this.audio.duration))
      this.audio.currentTime = Math.max(0, Math.min(this.audio.duration - 0.1, seconds));
  }

  setFader(value: number) {
    this.fader = Math.max(0, Math.min(1, value));
    if (this.gain && context) this.gain.gain.setTargetAtTime(this.fader * 0.8, context.currentTime, 0.02);
  }
}

/**
 * The two preview decks, created once per page. Hot reloads re-run the app's hooks; without
 * this, a reload would start fresh decks while the old audio kept playing unseen.
 */
export function previewDecks(): PreviewDeck[] {
  const cache = globalThis as { partyVisualsDecks?: PreviewDeck[] };
  return (cache.partyVisualsDecks ??= [new PreviewDeck(1), new PreviewDeck(0)]);
}
