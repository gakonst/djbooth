export type DeckEq = {
  lowDb: number;
  midDb: number;
  highDb: number;
  trimDb: number;
};

export const FLAT_DECK_EQ: DeckEq = { lowDb: 0, midDb: 0, highDb: 0, trimDb: 0 };

export type DeckAudioGraph = {
  resume(): Promise<void>;
  update(eq: DeckEq, outputGain: number): void;
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

/** Connect one local media element to a three-band DJ EQ and deck output gain. */
export function connectDeckAudio(
  media: HTMLMediaElement,
  eq: DeckEq,
  outputGain: number,
): DeckAudioGraph | undefined {
  const AudioContextConstructor = window.AudioContext;
  if (!AudioContextConstructor) return undefined;
  const context = new AudioContextConstructor({ latencyHint: "interactive" });
  const source = context.createMediaElementSource(media);
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
  source.connect(low).connect(mid).connect(high).connect(output).connect(context.destination);

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
    dispose() {
      source.disconnect();
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
