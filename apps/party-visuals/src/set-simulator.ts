import { audioContext, type LibraryTrack, type PreviewDeck } from "./decks.js";

export type SetSimulatorStatus = {
  running: boolean;
  loading: boolean;
  transitioning: boolean;
  track: LibraryTrack | null;
  /** One-based position, or zero before playback. */
  index: number;
  count: number;
  error: string | null;
};

type Playlist = { id: string; name: string; type: string };

/** Prefer today's Halloween update, then weave all Halloween playlists in their own order. */
export function halloweenPlaylists(items: Playlist[]): Playlist[] {
  return items.filter((item) => item.type === "playlist" && /halloween/i.test(item.name))
    .sort((a, b) => Number(/(?:oct(?:ober)?[ ._-]*31|10[/-]31|31[ ._-]*oct)/i.test(b.name))
      - Number(/(?:oct(?:ober)?[ ._-]*31|10[/-]31|31[ ._-]*oct)/i.test(a.name)));
}

export function weaveTracks(groups: LibraryTrack[][]): LibraryTrack[] {
  const seen = new Set<string>();
  const result: LibraryTrack[] = [];
  const length = Math.max(0, ...groups.map((group) => group.length));
  for (let index = 0; index < length; index++) {
    for (const group of groups) {
      const track = group[index];
      if (!track?.fileExists || seen.has(track.id)) continue;
      seen.add(track.id);
      result.push(track);
    }
  }
  return result;
}

/** Browser-only audition of local library audio. Never addresses physical players. */
export class SetSimulator {
  private decks: [PreviewDeck, PreviewDeck];
  private state: SetSimulatorStatus = {
    running: false, loading: false, transitioning: false, track: null, index: 0, count: 0, error: null,
  };
  private tracks: LibraryTrack[] = [];
  private controller?: AbortController;
  private timer?: ReturnType<typeof setInterval>;
  private active = 0;
  private cursor = 0;
  private busy = false;
  private disposed = false;
  private fadeStart: number | null = null;
  private startTime = 0;
  private savedFaders: number[] = [];
  private generation = 0;
  private preloaded?: { position: number; ready: Promise<void> };

  constructor(decks: PreviewDeck[], private readonly onStatus?: (status: SetSimulatorStatus) => void) {
    if (!decks[0] || !decks[1]) throw new Error("The set simulator requires two preview decks");
    this.decks = [decks[0], decks[1]];
  }

  get status(): SetSimulatorStatus { return { ...this.state }; }

  private update(patch: Partial<SetSimulatorStatus>) {
    this.state = { ...this.state, ...patch };
    this.onStatus?.(this.status);
  }

  private current(generation: number) {
    return !this.disposed && this.state.running && this.generation === generation;
  }

  private async json<T>(url: string, signal: AbortSignal): Promise<T> {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Library request failed (${response.status})`);
    return response.json() as Promise<T>;
  }

  /** Invoke directly in a click handler so both audio graphs can be unlocked. */
  async start() {
    if (this.disposed || this.state.running) return;
    this.savedFaders = this.decks.map((deck) => deck.fader);
    for (const deck of this.decks) {
      deck.unlock();
      deck.audio.pause();
      deck.setFader(0);
    }
    void audioContext()?.resume();
    const generation = ++this.generation;
    const controller = this.controller = new AbortController();
    this.cursor = 0;
    this.tracks = [];
    this.active = 0;
    this.update({ running: true, loading: true, error: null, index: 0, count: 0, track: null });
    try {
      const response = await this.json<{ items: Playlist[] }>("/api/playlists", controller.signal);
      const playlists = halloweenPlaylists(response.items);
      if (!playlists.length) throw new Error("No Halloween playlists found in the local library");
      const groups = await Promise.all(playlists.map(async (playlist) => {
        const tracks: LibraryTrack[] = [];
        for (let offset = 0; offset < 10000;) {
          const query = new URLSearchParams({ playlistId: playlist.id, limit: "500", offset: String(offset), filter: "analyzed", sort: "position" });
          const page = await this.json<{ items: LibraryTrack[]; count: number }>(`/api/tracks?${query}`, controller.signal);
          tracks.push(...page.items);
          offset += page.items.length;
          if (!page.items.length || offset >= page.count) break;
        }
        return tracks;
      }));
      if (!this.current(generation)) return;
      this.tracks = weaveTracks(groups);
      if (!this.tracks.length) throw new Error("Halloween playlists have no analyzed tracks with local audio");
      this.update({ count: this.tracks.length });
      await this.advance(generation);
      if (this.current(generation)) this.timer = setInterval(() => this.tick(generation), 100);
    } catch (error) {
      if (!this.current(generation)) return;
      this.stop();
      this.update({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async advance(generation: number) {
    if (!this.current(generation) || this.busy || this.fadeStart !== null) return;
    this.busy = true;
    this.update({ loading: true });
    const first = this.state.index === 0;
    const incoming = first ? this.active : 1 - this.active;
    const deck = this.decks[incoming]!;
    let started = false;
    try {
      // Each broken source gets one attempt per advance; never loop forever on an empty library.
      for (let attempt = 0; attempt < this.tracks.length && this.current(generation); attempt++) {
        const prepared = this.preloaded;
        this.preloaded = undefined;
        const position = prepared?.position ?? this.cursor++ % this.tracks.length;
        const track = this.tracks[position]!;
        try {
          deck.setFader(0);
          if (prepared) await prepared.ready;
          else await deck.load(track, { autoplay: false, signal: this.controller!.signal });
          if (!this.current(generation)) return;
          await deck.audio.play();
          if (!this.current(generation)) return;
          this.update({ track, index: position + 1, error: null });
          if (first) {
            deck.setFader(1);
            this.startTime = deck.audio.currentTime;
            this.preload(generation);
          } else {
            this.fadeStart = performance.now();
            this.update({ transitioning: true });
          }
          started = true;
          break;
        } catch (error) {
          if (!this.current(generation)) return;
          deck.audio.pause();
          this.update({ error: `Skipped ${track.title || track.id}: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
      if (!started && this.current(generation)) {
        this.stop();
        this.update({ error: "No playable local tracks remain in the Halloween playlists" });
      }
    } finally {
      if (this.generation === generation) {
        this.busy = false;
        this.update({ loading: false });
      }
    }
  }

  private preload(generation: number) {
    if (!this.current(generation) || this.preloaded || !this.tracks.length) return;
    const position = this.cursor++ % this.tracks.length;
    const deck = this.decks[1 - this.active]!;
    deck.setFader(0);
    const ready = deck.load(this.tracks[position]!, { autoplay: false, signal: this.controller!.signal })
      .then(() => {
        if (!this.current(generation)) return;
        deck.audio.pause();
        deck.seek(0);
      });
    // Keep rejected preload promises handled until advance consumes and reports them.
    void ready.catch(() => {});
    this.preloaded = { position, ready };
  }

  private tick(generation: number) {
    if (!this.current(generation)) return;
    if (this.fadeStart !== null) {
      const progress = Math.min(1, (performance.now() - this.fadeStart) / 8000);
      const smooth = progress * progress * (3 - 2 * progress);
      this.decks[this.active]!.setFader(1 - smooth);
      this.decks[1 - this.active]!.setFader(smooth);
      if (progress >= 1) {
        this.decks[this.active]!.audio.pause();
        this.active = 1 - this.active;
        this.startTime = this.decks[this.active]!.audio.currentTime;
        this.fadeStart = null;
        this.update({ transitioning: false });
        this.preload(generation);
      }
      return;
    }
    const audio = this.decks[this.active]!.audio;
    const remaining = audio.duration - audio.currentTime;
    if (audio.ended || audio.error || audio.currentTime - this.startTime >= 67 || (Number.isFinite(remaining) && remaining <= 8)) {
      void this.advance(generation);
    }
  }

  async skip() {
    if (this.state.loading && this.state.index === 0) return;
    await this.advance(this.generation);
  }

  stop() {
    ++this.generation;
    this.controller?.abort();
    this.controller = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.fadeStart = null;
    this.preloaded = undefined;
    this.busy = false;
    this.decks.forEach((deck, index) => {
      deck.audio.pause();
      deck.setFader(this.savedFaders[index] ?? (index === 0 ? 1 : 0));
    });
    this.update({ running: false, loading: false, transitioning: false });
  }

  dispose() { this.stop(); this.disposed = true; }
}
