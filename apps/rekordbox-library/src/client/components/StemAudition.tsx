import { Pause, Play, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ProcessingJob } from "../../shared/types.js";

type LoadedChannel = {
  buffer: AudioBuffer;
  gain: GainNode;
  id: string;
  label: string;
  role: "original" | "stem";
};

export type StemAuditionProps = {
  job: ProcessingJob;
  onClose(): void;
};

/** Sample-synchronized original/stem A/B player backed by one Web Audio clock. */
export function StemAudition({ job, onClose }: StemAuditionProps) {
  const audioRef = useRef<AudioContext | undefined>(undefined);
  const channelsRef = useRef<LoadedChannel[]>([]);
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const offsetRef = useRef(0);
  const startedAtRef = useRef(0);
  const playingRef = useRef(false);
  const frameRef = useRef<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [preset, setPreset] = useState<"original" | "stems" | "solo">("original");
  const [solo, setSolo] = useState<string>();

  const stopSources = useCallback(() => {
    for (const source of sourcesRef.current) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // A source may already have ended on the audio clock.
      }
      source.disconnect();
    }
    sourcesRef.current = [];
  }, []);

  const currentPosition = useCallback(() => {
    const context = audioRef.current;
    if (!playingRef.current || !context) return offsetRef.current;
    return Math.min(duration, offsetRef.current + context.currentTime - startedAtRef.current);
  }, [duration]);

  const pause = useCallback(() => {
    if (!playingRef.current) return;
    offsetRef.current = currentPosition();
    playingRef.current = false;
    setPlaying(false);
    setPosition(offsetRef.current);
    stopSources();
  }, [currentPosition, stopSources]);

  const applyPreset = useCallback((next: "original" | "stems" | "solo", soloId?: string) => {
    const context = audioRef.current;
    if (!context) return;
    setPreset(next);
    setSolo(soloId);
    for (const channel of channelsRef.current) {
      const enabled =
        next === "original"
          ? channel.role === "original"
          : next === "stems"
            ? channel.role === "stem"
            : channel.id === soloId;
      channel.gain.gain.setTargetAtTime(enabled ? 1 : 0, context.currentTime, 0.008);
    }
  }, []);

  const play = useCallback(async () => {
    const context = audioRef.current;
    if (!context || loading || playingRef.current) return;
    await context.resume();
    if (offsetRef.current >= duration - 0.01) offsetRef.current = 0;
    stopSources();
    const startAt = context.currentTime + 0.025;
    sourcesRef.current = channelsRef.current.map((channel) => {
      const source = context.createBufferSource();
      source.buffer = channel.buffer;
      source.connect(channel.gain);
      source.start(startAt, offsetRef.current);
      return source;
    });
    startedAtRef.current = startAt;
    playingRef.current = true;
    setPlaying(true);
  }, [duration, loading, stopSources]);

  const seek = useCallback(
    (seconds: number) => {
      const resume = playingRef.current;
      if (resume) pause();
      offsetRef.current = Math.max(0, Math.min(duration, seconds));
      setPosition(offsetRef.current);
      if (resume) void play();
    },
    [duration, pause, play],
  );

  useEffect(() => {
    const context = new AudioContext({ latencyHint: "interactive" });
    audioRef.current = context;
    const controller = new AbortController();
    const tracks = [
      {
        id: "original",
        label: "Original",
        role: "original" as const,
        url: `/api/audio/${encodeURIComponent(job.contentId)}`,
      },
      ...(job.artifacts ?? [])
        .filter((artifact) => artifact.stem && artifact.url)
        .map((artifact) => ({
          id: artifact.stem!,
          label: artifact.label,
          role: "stem" as const,
          url: artifact.url!,
        })),
    ];
    void Promise.all(
      tracks.map(async (track) => {
        const response = await fetch(track.url, { signal: controller.signal });
        if (!response.ok)
          throw new Error(`${track.label} audio failed: ${String(response.status)}`);
        const buffer = await context.decodeAudioData(await response.arrayBuffer());
        const gain = context.createGain();
        gain.gain.value = track.role === "original" ? 1 : 0;
        gain.connect(context.destination);
        return { ...track, buffer, gain };
      }),
    ).then(
      (loaded) => {
        channelsRef.current = loaded;
        const nextDuration = Math.min(...loaded.map((channel) => channel.buffer.duration));
        setDuration(nextDuration);
        setLoading(false);
      },
      (reason) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : String(reason));
        setLoading(false);
      },
    );
    return () => {
      controller.abort();
      stopSources();
      void context.close();
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    };
  }, [job, stopSources]);

  useEffect(() => {
    const render = () => {
      const next = currentPosition();
      setPosition(next);
      if (playingRef.current && next >= duration - 0.01) pause();
      frameRef.current = requestAnimationFrame(render);
    };
    frameRef.current = requestAnimationFrame(render);
    return () => {
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    };
  }, [currentPosition, duration, pause]);

  return (
    <div className="dialog-backdrop stem-audition-backdrop" role="presentation">
      <section className="stem-audition" role="dialog" aria-modal="true" aria-label="Stem audition">
        <header>
          <div>
            <span className="eyebrow">MLX STEMROOM</span>
            <h2>{job.trackTitle}</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close audition"
          >
            <X size={17} />
          </button>
        </header>
        {error ? <div className="connection-banner is-error">{error}</div> : null}
        <div className="stem-transport">
          <button
            className="stem-play"
            type="button"
            disabled={loading || Boolean(error)}
            onClick={() => (playing ? pause() : void play())}
          >
            {playing ? <Pause size={20} /> : <Play size={20} />}
          </button>
          <span>{formatTime(position)}</span>
          <input
            type="range"
            min={0}
            max={duration || 1}
            step={0.01}
            value={position}
            disabled={loading}
            onChange={(event) => seek(Number(event.target.value))}
          />
          <span>{loading ? "Loading…" : formatTime(duration)}</span>
        </div>
        <div className="stem-presets">
          <button
            className={preset === "original" ? "is-active" : ""}
            type="button"
            onClick={() => applyPreset("original")}
          >
            Original
          </button>
          <button
            className={preset === "stems" ? "is-active" : ""}
            type="button"
            onClick={() => applyPreset("stems")}
          >
            Stem sum
          </button>
        </div>
        <div className="stem-channels">
          {(job.artifacts ?? [])
            .filter((artifact) => artifact.stem)
            .map((artifact) => (
              <button
                className={preset === "solo" && solo === artifact.stem ? "is-active" : ""}
                type="button"
                key={artifact.stem}
                onClick={() => applyPreset("solo", artifact.stem)}
              >
                <span>SOLO</span>
                <strong>{artifact.label}</strong>
              </button>
            ))}
        </div>
      </section>
    </div>
  );
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  return `${String(Math.floor(safe / 60))}:${(safe % 60).toFixed(1).padStart(4, "0")}`;
}
