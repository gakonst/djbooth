export type DeckEq = {
  lowDb: number;
  midDb: number;
  highDb: number;
  trimDb: number;
};

export const FLAT_DECK_EQ: DeckEq = { lowDb: 0, midDb: 0, highDb: 0, trimDb: 0 };

export type DeckStemSource = {
  id: string;
  label: string;
  url: string;
};

export type DeckAudioGraph = {
  resume(): Promise<void>;
  update(eq: DeckEq, outputGain: number): void;
  setStemSources(sources: readonly DeckStemSource[]): void;
  /** Undefined restores the original recording; an empty array intentionally mutes every part. */
  setStemMix(enabledIds: readonly string[] | undefined): Promise<void>;
  dispose(): void;
};

/** Equal-power crossfade gains. The midpoint keeps perceived power approximately constant. */
export function equalPowerGains(position: number): { a: number; b: number } {
  const normalized = clamp(position, 0, 1);
  return {
    a: Math.cos((normalized * Math.PI) / 2),
    b: Math.sin((normalized * Math.PI) / 2),
  };
}

/** Toggle one separated part. Toggling from original mode enters a one-part solo. */
export function toggleStemMix(enabledIds: readonly string[] | undefined, stemId: string): string[] {
  if (enabledIds === undefined) return [stemId];
  return enabledIds.includes(stemId)
    ? enabledIds.filter((id) => id !== stemId)
    : [...enabledIds, stemId];
}

/** Connect one local media element and optional synchronized stems to a DJ EQ and output gain. */
export function connectDeckAudio(
  media: HTMLMediaElement,
  eq: DeckEq,
  outputGain: number,
): DeckAudioGraph | undefined {
  const AudioContextConstructor = window.AudioContext;
  if (!AudioContextConstructor) return undefined;
  const context = new AudioContextConstructor({ latencyHint: "interactive" });
  const source = context.createMediaElementSource(media);
  const originalGain = context.createGain();
  const low = context.createBiquadFilter();
  const mid = context.createBiquadFilter();
  const high = context.createBiquadFilter();
  const output = context.createGain();
  low.type = "lowshelf";
  low.frequency.value = 120;
  mid.type = "peaking";
  mid.frequency.value = 1_000;
  mid.Q.value = 0.8;
  high.type = "highshelf";
  high.frequency.value = 8_000;
  source
    .connect(originalGain)
    .connect(low)
    .connect(mid)
    .connect(high)
    .connect(output)
    .connect(context.destination);

  type ConnectedStem = {
    element: HTMLAudioElement;
    gain: GainNode;
    source: MediaElementAudioSourceNode;
  };
  const stems = new Map<string, ConnectedStem>();
  let enabledStemIds: Set<string> | undefined;
  let disposed = false;

  const setGain = (gain: GainNode, value: number) => {
    gain.gain.cancelScheduledValues(context.currentTime);
    gain.gain.setTargetAtTime(value, context.currentTime, 0.008);
  };
  const mirrorMediaLevel = () => {
    for (const stem of stems.values()) {
      stem.element.volume = media.volume;
      stem.element.muted = media.muted;
    }
  };
  const alignStem = (element: HTMLAudioElement, force = false) => {
    if (!Number.isFinite(media.currentTime)) return;
    if (force || Math.abs(element.currentTime - media.currentTime) > 0.08) {
      try {
        element.currentTime = media.currentTime;
      } catch {
        // Metadata may still be loading. The next timeupdate/seek event retries alignment.
      }
    }
    element.playbackRate = media.playbackRate;
  };
  const alignStems = (force = false) => {
    if (!enabledStemIds) return;
    for (const stem of stems.values()) alignStem(stem.element, force);
  };
  const playEnabledStems = async () => {
    if (!enabledStemIds || media.paused) return;
    const active = [...stems.entries()].filter(([id]) => enabledStemIds?.has(id));
    for (const [, stem] of active) alignStem(stem.element, true);
    await Promise.all(active.map(([, stem]) => stem.element.play()));
  };
  const pauseStems = () => {
    for (const stem of stems.values()) stem.element.pause();
  };

  const onPlay = () =>
    void playEnabledStems().catch(() => {
      enabledStemIds = undefined;
      pauseStems();
      setGain(originalGain, 1);
      for (const stem of stems.values()) setGain(stem.gain, 0);
    });
  const onPause = () => pauseStems();
  const onSeeked = () => alignStems(true);
  const onTimeUpdate = () => alignStems();
  const onRateChange = () => alignStems();
  const onVolumeChange = () => mirrorMediaLevel();
  media.addEventListener("play", onPlay);
  media.addEventListener("pause", onPause);
  media.addEventListener("seeking", onSeeked);
  media.addEventListener("seeked", onSeeked);
  media.addEventListener("timeupdate", onTimeUpdate);
  media.addEventListener("ratechange", onRateChange);
  media.addEventListener("volumechange", onVolumeChange);

  const update = (nextEq: DeckEq, nextOutputGain: number) => {
    const now = context.currentTime;
    low.gain.setTargetAtTime(clamp(nextEq.lowDb, -24, 12), now, 0.015);
    mid.gain.setTargetAtTime(clamp(nextEq.midDb, -24, 12), now, 0.015);
    high.gain.setTargetAtTime(clamp(nextEq.highDb, -24, 12), now, 0.015);
    output.gain.setTargetAtTime(
      clamp(nextOutputGain, 0, 1) * decibelsToGain(clamp(nextEq.trimDb, -24, 12)),
      now,
      0.01,
    );
  };
  update(eq, outputGain);
  return {
    async resume() {
      if (context.state === "suspended") await context.resume();
    },
    update,
    setStemSources(nextSources) {
      pauseStems();
      for (const stem of stems.values()) {
        stem.source.disconnect();
        stem.gain.disconnect();
        stem.element.removeAttribute("src");
        stem.element.load();
      }
      stems.clear();
      enabledStemIds = undefined;
      setGain(originalGain, 1);
      for (const stemSource of nextSources) {
        if (!stemSource.id || !stemSource.url || stems.has(stemSource.id)) continue;
        const element = document.createElement("audio");
        element.preload = "metadata";
        element.src = stemSource.url;
        element.volume = media.volume;
        element.muted = media.muted;
        const stemSourceNode = context.createMediaElementSource(element);
        const stemGain = context.createGain();
        stemGain.gain.value = 0;
        stemSourceNode.connect(stemGain).connect(low);
        stems.set(stemSource.id, { element, gain: stemGain, source: stemSourceNode });
      }
    },
    async setStemMix(nextEnabledIds) {
      if (disposed) throw new Error("Deck audio graph is closed");
      if (nextEnabledIds === undefined) {
        enabledStemIds = undefined;
        setGain(originalGain, 1);
        for (const stem of stems.values()) setGain(stem.gain, 0);
        pauseStems();
        return;
      }
      const next = new Set(nextEnabledIds.filter((id) => stems.has(id)));
      enabledStemIds = next;
      try {
        await playEnabledStems();
      } catch (error) {
        enabledStemIds = undefined;
        pauseStems();
        setGain(originalGain, 1);
        for (const stem of stems.values()) setGain(stem.gain, 0);
        throw error;
      }
      setGain(originalGain, 0);
      for (const [id, stem] of stems) setGain(stem.gain, next.has(id) ? 1 : 0);
    },
    dispose() {
      disposed = true;
      media.removeEventListener("play", onPlay);
      media.removeEventListener("pause", onPause);
      media.removeEventListener("seeking", onSeeked);
      media.removeEventListener("seeked", onSeeked);
      media.removeEventListener("timeupdate", onTimeUpdate);
      media.removeEventListener("ratechange", onRateChange);
      media.removeEventListener("volumechange", onVolumeChange);
      pauseStems();
      for (const stem of stems.values()) {
        stem.source.disconnect();
        stem.gain.disconnect();
        stem.element.removeAttribute("src");
        stem.element.load();
      }
      stems.clear();
      source.disconnect();
      originalGain.disconnect();
      low.disconnect();
      mid.disconnect();
      high.disconnect();
      output.disconnect();
      void context.close();
    },
  };
}

function decibelsToGain(db: number): number {
  return 10 ** (db / 20);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
