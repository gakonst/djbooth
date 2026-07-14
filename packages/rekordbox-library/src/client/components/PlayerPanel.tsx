import {
  Flag,
  LoaderCircle,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";

import type { HotCueSlot, TrackCue, TrackWaveform } from "../../shared/types.js";
import { getTrackWaveform } from "../api.js";
import { rekordboxHotCueColor } from "../cue-palette.js";
import { formatBpm } from "../format.js";
import { renderRgbWaveform } from "./RgbWaveform.js";

export type PlayerTrack = {
  id: string;
  title: string;
  artist?: string | null;
  album?: string | null;
  durationSeconds?: number | null;
  fileExists?: boolean;
  artworkAvailable?: boolean;
  analyzed?: boolean;
  bpm?: number | null;
  genre?: string | null;
  key?: string | null;
  path?: string | null;
  playCount?: number;
  rating?: number;
};

export type PlayerCue = TrackCue;
export type PlayerWaveform = TrackWaveform;

/**
 * Trusted media boundary for {@link PlayerPanel}.
 *
 * The player never receives filesystem paths. The host supplies same-origin media URLs and may
 * supply precomputed Rekordbox peaks. The player always supplies peak data to WaveSurfer—even a
 * flat placeholder—so it streams the media element instead of fetching and decoding the full
 * recording in browser memory.
 */
export interface PlayerAdapter {
  getAudioUrl(track: PlayerTrack): string;
  getArtworkUrl(track: PlayerTrack): string | undefined;
  loadWaveform?(track: PlayerTrack, signal: AbortSignal): Promise<PlayerWaveform | null>;
}

/** Internal same-origin adapter matching the workbench server's media endpoints. */
const defaultPlayerAdapter: PlayerAdapter = {
  getAudioUrl: (track) => `/api/audio/${encodeURIComponent(track.id)}`,
  getArtworkUrl: (track) => `/api/artwork/${encodeURIComponent(track.id)}`,
  loadWaveform: (track, signal) => getTrackWaveform(track.id, signal),
};

export type PlayerPanelHandle = {
  play(): Promise<void>;
  pause(): void;
  toggle(): Promise<void>;
  seekTo(seconds: number): void;
  seekBy(seconds: number): void;
  setVolume(volume: number): void;
  getCurrentTime(): number;
  isPlaying(): boolean;
};

export type PlayerPanelProps = {
  track?: PlayerTrack | null;
  /** Controlled, authoritative cue list from the library API. */
  cues?: ReadonlyArray<PlayerCue>;
  adapter?: PlayerAdapter;
  canEditCues?: boolean;
  cueMutationPending?: boolean;
  previousDisabled?: boolean;
  nextDisabled?: boolean;
  onPrevious?(): void;
  onNext?(): void;
  onEnded?(): void;
  onReady?(): void;
  onTimeChange?(seconds: number): void;
  onPlayStateChange?(playing: boolean): void;
  onAddMemoryCue?(seconds: number): void;
  onAddHotCue?(slot: HotCueSlot, seconds: number): void;
  onDeleteCue?(cue: PlayerCue): void;
  onEditCue?(cue: PlayerCue): void;
  onError?(error: Error): void;
};

const HOT_CUE_SLOTS = Array.from({ length: 16 }, (_, index) => (index + 1) as HotCueSlot);
const DEFAULT_HOT_CUE_COLORS = [
  "#ef4444",
  "#f59e0b",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#f97316",
  "#dc2626",
  "#ca8a04",
  "#16a34a",
  "#0891b2",
  "#2563eb",
  "#7c3aed",
  "#db2777",
  "#ea580c",
] as const;

export const PlayerPanel = forwardRef<PlayerPanelHandle, PlayerPanelProps>(function PlayerPanel(
  {
    track,
    cues = [],
    adapter = defaultPlayerAdapter,
    canEditCues = false,
    cueMutationPending = false,
    previousDisabled = false,
    nextDisabled = false,
    onPrevious,
    onNext,
    onEnded,
    onReady,
    onTimeChange,
    onPlayStateChange,
    onAddMemoryCue,
    onAddHotCue,
    onDeleteCue,
    onEditCue,
    onError,
  },
  forwardedRef,
) {
  const waveformElementRef = useRef<HTMLDivElement>(null);
  const waveSurferRef = useRef<WaveSurfer | undefined>(undefined);
  const regionsRef = useRef<ReturnType<typeof RegionsPlugin.create> | undefined>(undefined);
  const callbacksRef = useRef({ onEnded, onReady, onTimeChange, onPlayStateChange, onError });
  const [playing, setPlaying] = useState(false);
  const [loadingPercent, setLoadingPercent] = useState(0);
  const [ready, setReady] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(0.85);
  const [muted, setMuted] = useState(false);
  const [mediaError, setMediaError] = useState<string>();
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [selectedHotCueSlot, setSelectedHotCueSlot] = useState<HotCueSlot>();

  callbacksRef.current = { onEnded, onReady, onTimeChange, onPlayStateChange, onError };

  const audioUrl = useMemo(
    () => (track ? adapter.getAudioUrl(track) : undefined),
    [adapter, track],
  );
  const artworkUrl = useMemo(
    () => (track ? adapter.getArtworkUrl(track) : undefined),
    [adapter, track],
  );
  const effectiveDuration = finitePositive(duration) ?? finitePositive(track?.durationSeconds) ?? 0;

  const reportError = useCallback((cause: unknown) => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    setMediaError(error.message);
    callbacksRef.current.onError?.(error);
  }, []);

  const seekTo = useCallback(
    (seconds: number) => {
      const waveSurfer = waveSurferRef.current;
      if (!waveSurfer) return;
      const nextTime = clamp(seconds, 0, waveSurfer.getDuration() || effectiveDuration);
      waveSurfer.setTime(nextTime);
      setCurrentTime(nextTime);
      callbacksRef.current.onTimeChange?.(nextTime);
    },
    [effectiveDuration],
  );

  const setVolume = useCallback((nextVolume: number) => {
    const normalized = clamp(nextVolume, 0, 1);
    const waveSurfer = waveSurferRef.current;
    waveSurfer?.setVolume(normalized);
    if (normalized > 0) waveSurfer?.setMuted(false);
    setVolumeState(normalized);
    if (normalized > 0) setMuted(false);
  }, []);

  const play = useCallback(async () => {
    if (!track?.fileExists || !waveSurferRef.current) return;
    try {
      await waveSurferRef.current?.play();
    } catch (error) {
      reportError(error);
    }
  }, [reportError, track?.fileExists]);

  const pause = useCallback(() => waveSurferRef.current?.pause(), []);
  const toggle = useCallback(async () => {
    if (waveSurferRef.current?.isPlaying()) pause();
    else await play();
  }, [pause, play]);

  useImperativeHandle(
    forwardedRef,
    () => ({
      play,
      pause,
      toggle,
      seekTo,
      seekBy(seconds) {
        seekTo((waveSurferRef.current?.getCurrentTime() ?? 0) + seconds);
      },
      setVolume,
      getCurrentTime() {
        return waveSurferRef.current?.getCurrentTime() ?? 0;
      },
      isPlaying() {
        return waveSurferRef.current?.isPlaying() ?? false;
      },
    }),
    [pause, play, seekTo, setVolume, toggle],
  );

  useEffect(() => {
    const container = waveformElementRef.current;
    setPlaying(false);
    setLoadingPercent(0);
    setReady(false);
    setCurrentTime(0);
    setDuration(finitePositive(track?.durationSeconds) ?? 0);
    setMediaError(undefined);
    if (!container || !track || !audioUrl || track.fileExists === false) return;
    const controller = new AbortController();
    const regions = RegionsPlugin.create();
    let waveform: PlayerWaveform | null | undefined;
    const waveSurfer = WaveSurfer.create({
      container,
      backend: "MediaElement",
      height: 52,
      waveColor: "#3c3d47",
      progressColor: "#a78bfa",
      cursorColor: "#f8fafc",
      cursorWidth: 1,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      dragToSeek: { debounceTime: 40 },
      normalize: true,
      mediaControls: false,
      renderFunction: (peaks, context) => renderRgbWaveform(peaks, waveform?.colors, context),
      plugins: [regions],
    });
    waveSurferRef.current = waveSurfer;
    regionsRef.current = regions;
    waveSurfer.setVolume(volume);
    waveSurfer.setMuted(muted);

    const unsubscribers = [
      waveSurfer.on("loading", (percent) => setLoadingPercent(percent)),
      waveSurfer.on("ready", (loadedDuration) => {
        setDuration(loadedDuration);
        setLoadingPercent(100);
        setReady(true);
        callbacksRef.current.onReady?.();
      }),
      waveSurfer.on("timeupdate", (seconds) => {
        setCurrentTime(seconds);
        callbacksRef.current.onTimeChange?.(seconds);
      }),
      waveSurfer.on("play", () => {
        setPlaying(true);
        callbacksRef.current.onPlayStateChange?.(true);
      }),
      waveSurfer.on("pause", () => {
        setPlaying(false);
        callbacksRef.current.onPlayStateChange?.(false);
      }),
      waveSurfer.on("finish", () => {
        setPlaying(false);
        callbacksRef.current.onPlayStateChange?.(false);
        callbacksRef.current.onEnded?.();
      }),
      waveSurfer.on("error", (error) => reportError(error)),
      regions.on("region-clicked", (region, event) => {
        event.stopPropagation();
        waveSurfer.setTime(region.start);
      }),
    ];

    const waveformRequest = (async () => {
      try {
        return (await adapter.loadWaveform?.(track, controller.signal)) ?? null;
      } catch {
        return null;
      }
    })();
    void (async () => {
      try {
        if (controller.signal.aborted) return;
        // Begin streaming immediately. Precomputed RGB peaks are an enhancement, not a gate on
        // playback readiness, and can be drawn over the placeholder without reloading the media.
        await waveSurfer.load(
          audioUrl,
          [Float32Array.of(0)],
          finitePositive(track.durationSeconds),
        );
        waveform = await waveformRequest;
        if (controller.signal.aborted || !waveform?.peaks.length) return;
        const waveformDuration =
          finitePositive(waveform.durationSeconds) ?? finitePositive(track.durationSeconds);
        if (!waveformDuration) return;
        try {
          waveSurfer.setOptions({
            peaks: [Float32Array.from(waveform.peaks)],
            duration: waveformDuration,
          });
          const decoded = waveSurfer.getDecodedData();
          if (decoded) await waveSurfer.getRenderer().render(decoded);
        } catch {
          // Audio remains playable if the optional waveform cannot be redrawn.
        }
      } catch (error) {
        if (!controller.signal.aborted) reportError(error);
      }
    })();

    return () => {
      controller.abort();
      for (const unsubscribe of unsubscribers) unsubscribe();
      waveSurfer.destroy();
      if (waveSurferRef.current === waveSurfer) waveSurferRef.current = undefined;
      if (regionsRef.current === regions) regionsRef.current = undefined;
    };
    // Media is keyed by URL/track. Callback updates are routed through callbacksRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter, audioUrl, loadAttempt, track?.fileExists, track?.id]);

  useEffect(() => setLoadAttempt(0), [track?.id]);
  useEffect(() => setSelectedHotCueSlot(undefined), [track?.id]);

  useEffect(() => {
    const regions = regionsRef.current;
    if (!regions || !ready) return;
    regions.clearRegions();
    for (const cue of cues) {
      const color = cueColor(cue, cue.kind === "hot" ? "#f59e0b" : "#f8fafc");
      regions.addRegion({
        id: cue.id,
        start: clamp(cue.startSeconds, 0, effectiveDuration),
        ...(cue.endSeconds && cue.endSeconds > cue.startSeconds
          ? { end: clamp(cue.endSeconds, cue.startSeconds, effectiveDuration) }
          : {}),
        content: cueLabel(cue),
        color: colorWithAlpha(color, cue.endSeconds ? 0.16 : 0.72),
        drag: false,
        resize: false,
      });
    }
  }, [cues, effectiveDuration, ready]);

  useEffect(() => {
    if (!("mediaSession" in navigator) || !track) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist ?? undefined,
      album: track.album ?? undefined,
      artwork: artworkUrl ? [{ src: artworkUrl }] : undefined,
    });
    const handlers: ReadonlyArray<[MediaSessionAction, MediaSessionActionHandler]> = [
      ["play", () => void play()],
      ["pause", pause],
      [
        "seekbackward",
        (details) =>
          seekTo((waveSurferRef.current?.getCurrentTime() ?? 0) - (details.seekOffset ?? 10)),
      ],
      [
        "seekforward",
        (details) =>
          seekTo((waveSurferRef.current?.getCurrentTime() ?? 0) + (details.seekOffset ?? 10)),
      ],
      ["previoustrack", () => onPrevious?.()],
      ["nexttrack", () => onNext?.()],
    ];
    for (const [action, handler] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // Some browsers expose MediaSession but omit individual actions.
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch {
          // Ignore unsupported actions during cleanup.
        }
      }
    };
  }, [artworkUrl, onNext, onPrevious, pause, play, seekTo, track]);

  const hotCues = useMemo(
    () =>
      new Map(cues.filter((cue) => cue.kind === "hot" && cue.slot).map((cue) => [cue.slot!, cue])),
    [cues],
  );
  const memoryCues = useMemo(
    () => [...cues].filter((cue) => cue.kind === "memory").sort(compareCues),
    [cues],
  );
  const selectedHotCue =
    (selectedHotCueSlot ? hotCues.get(selectedHotCueSlot) : undefined) ??
    HOT_CUE_SLOTS.flatMap((slot) => hotCues.get(slot) ?? []).at(0);
  const unavailable = !track || track.fileExists === false;

  return (
    <section className="player-panel" aria-label="Track player">
      <div className="player-identity">
        <div className="player-track-copy">
          <strong title={track?.title}>{track?.title || "No track selected"}</strong>
          <span title={[track?.artist, track?.album].filter(Boolean).join(" · ") || undefined}>
            {track
              ? [track.artist ?? "Unknown artist", track.album].filter(Boolean).join(" · ")
              : "Double-click a track to load it"}
          </span>
          {track ? (
            <div className="player-track-metadata" aria-label="Track metadata">
              <b>{formatBpm(track.bpm)} BPM</b>
              <b>{track.key ?? "—"}</b>
              {track.genre ? <span>{track.genre}</span> : null}
              {track.rating ? <span>{"★".repeat(Math.min(5, track.rating))}</span> : null}
              <span>{String(track.playCount ?? 0)} plays</span>
            </div>
          ) : null}
        </div>
        <div className="player-transport" aria-label="Playback controls">
          <button
            className="player-control-button"
            type="button"
            disabled={previousDisabled || !onPrevious}
            onClick={onPrevious}
            aria-label="Previous track"
            title="Previous track"
          >
            <SkipBack size={17} fill="currentColor" />
          </button>
          <button
            className="player-control-button"
            type="button"
            disabled={unavailable || !ready}
            onClick={() => seekTo(currentTime - 10)}
            aria-label="Go back 10 seconds"
            title="Back 10 seconds"
          >
            <RotateCcw size={16} />
            <span className="player-skip-label">10</span>
          </button>
          <button
            className="player-play-button"
            type="button"
            disabled={unavailable || !ready}
            onClick={() => void toggle()}
            aria-label={playing ? "Pause" : "Play"}
            title={playing ? "Pause (Space)" : "Play (Space)"}
          >
            {!ready && track?.fileExists ? (
              <LoaderCircle size={21} className="spin" />
            ) : playing ? (
              <Pause size={21} fill="currentColor" />
            ) : (
              <Play size={21} fill="currentColor" />
            )}
          </button>
          <button
            className="player-control-button"
            type="button"
            disabled={unavailable || !ready}
            onClick={() => seekTo(currentTime + 10)}
            aria-label="Go forward 10 seconds"
            title="Forward 10 seconds"
          >
            <RotateCcw className="player-forward-icon" size={16} />
            <span className="player-skip-label">10</span>
          </button>
          <button
            className="player-control-button"
            type="button"
            disabled={nextDisabled || !onNext}
            onClick={onNext}
            aria-label="Next track"
            title="Next track"
          >
            <SkipForward size={17} fill="currentColor" />
          </button>
        </div>
      </div>

      <div className="player-waveform-wrap">
        <div
          ref={waveformElementRef}
          className="player-waveform"
          role="slider"
          tabIndex={unavailable || !ready ? -1 : 0}
          aria-label="Interactive track waveform"
          aria-valuemin={0}
          aria-valuemax={Math.round(effectiveDuration)}
          aria-valuenow={Math.round(currentTime)}
          aria-valuetext={`${formatTime(currentTime)} of ${formatTime(effectiveDuration)}`}
          aria-disabled={unavailable || !ready}
          onKeyDown={(event) => {
            if (unavailable || !ready) return;
            const step = event.shiftKey ? 1 : 5;
            if (event.key === "ArrowLeft") seekTo(currentTime - step);
            else if (event.key === "ArrowRight") seekTo(currentTime + step);
            else if (event.key === "Home") seekTo(0);
            else if (event.key === "End") seekTo(effectiveDuration);
            else return;
            event.preventDefault();
          }}
        />
        {!track ? <span className="player-waveform-empty">Select a track</span> : null}
        <div className="player-time-row" aria-live="off">
          <span>{formatTime(currentTime)}</span>
          {!ready && track?.fileExists ? (
            <span className="player-loading-label">
              <LoaderCircle size={11} className="spin" /> {String(Math.round(loadingPercent))}%
            </span>
          ) : null}
          <span>−{formatTime(Math.max(0, effectiveDuration - currentTime))}</span>
        </div>
      </div>

      <div className="player-volume">
        <button
          className="player-control-button"
          type="button"
          disabled={!track}
          onClick={() => {
            const nextMuted = !muted;
            waveSurferRef.current?.setMuted(nextMuted);
            setMuted(nextMuted);
          }}
          aria-label={muted ? "Unmute" : "Mute"}
          title={muted ? "Unmute" : "Mute"}
        >
          {muted || volume === 0 ? (
            <VolumeX size={17} />
          ) : volume < 0.5 ? (
            <Volume1 size={17} />
          ) : (
            <Volume2 size={17} />
          )}
        </button>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={muted ? 0 : volume}
          disabled={!track}
          onChange={(event) => setVolume(Number(event.target.value))}
          aria-label="Volume"
        />
      </div>

      <div className="player-cues" aria-label="Cue points">
        <div className="player-hot-cues">
          {HOT_CUE_SLOTS.map((slot) => {
            const cue = hotCues.get(slot);
            const label = String.fromCharCode(64 + slot);
            const defaultColor = DEFAULT_HOT_CUE_COLORS[slot - 1] ?? "#f59e0b";
            return (
              <span className={`player-hot-cue ${cue ? "is-set" : ""}`} key={slot}>
                <button
                  type="button"
                  disabled={
                    unavailable ||
                    !ready ||
                    cueMutationPending ||
                    (!cue && (!canEditCues || !onAddHotCue))
                  }
                  onClick={() => {
                    if (cue) {
                      setSelectedHotCueSlot(slot);
                      seekTo(cue.startSeconds);
                    } else {
                      onAddHotCue?.(slot, waveSurferRef.current?.getCurrentTime() ?? currentTime);
                    }
                  }}
                  onFocus={() => cue && setSelectedHotCueSlot(slot)}
                  onKeyDown={(event) => {
                    if (!cue || !canEditCues) return;
                    if ((event.key === "F2" || event.key.toLowerCase() === "e") && onEditCue) {
                      event.preventDefault();
                      onEditCue(cue);
                    } else if (
                      (event.key === "Delete" || event.key === "Backspace") &&
                      onDeleteCue
                    ) {
                      event.preventDefault();
                      onDeleteCue(cue);
                    }
                  }}
                  style={
                    {
                      "--cue-color": cue ? cueColor(cue, defaultColor) : defaultColor,
                    } as React.CSSProperties
                  }
                  aria-label={
                    cue
                      ? `Jump to hot cue ${label} at ${formatTime(cue.startSeconds)}`
                      : `Set hot cue ${label} at ${formatTime(currentTime)}`
                  }
                  title={
                    cue ? `${label} · ${formatTime(cue.startSeconds)}` : `Set hot cue ${label}`
                  }
                >
                  {label}
                </button>
              </span>
            );
          })}
        </div>
        {selectedHotCue && canEditCues && (onEditCue || onDeleteCue) ? (
          <span className="player-hot-cue-actions" aria-label="Selected hot cue actions">
            {onEditCue ? (
              <button
                className="player-edit-cue"
                type="button"
                disabled={cueMutationPending}
                onClick={() => onEditCue(selectedHotCue)}
                title="Edit selected Hot Cue (F2 or E while focused)"
              >
                <Pencil size={9} /> Edit {String.fromCharCode(64 + (selectedHotCue.slot ?? 1))}
              </button>
            ) : null}
            {onDeleteCue ? (
              <button
                className="player-delete-cue"
                type="button"
                disabled={cueMutationPending}
                onClick={() => onDeleteCue(selectedHotCue)}
                aria-label={`Delete hot cue ${String.fromCharCode(64 + (selectedHotCue.slot ?? 1))}`}
                title="Delete selected Hot Cue (Delete while focused)"
              >
                <X size={9} />
              </button>
            ) : null}
          </span>
        ) : null}
        <button
          className="player-memory-cue-button"
          type="button"
          disabled={unavailable || !ready || cueMutationPending || !canEditCues || !onAddMemoryCue}
          onClick={() => onAddMemoryCue?.(waveSurferRef.current?.getCurrentTime() ?? currentTime)}
          title="Add memory cue at playhead"
        >
          {cueMutationPending ? <LoaderCircle size={12} className="spin" /> : <Flag size={12} />}
          Memory cue
        </button>
        {memoryCues.length ? (
          <div className="player-memory-cues" aria-label="Memory cues">
            {memoryCues.map((cue) => (
              <span className="player-memory-cue" key={cue.id}>
                <button
                  type="button"
                  onClick={() => seekTo(cue.startSeconds)}
                  onDoubleClick={() => onEditCue?.(cue)}
                >
                  {cue.comment.trim() || formatTime(cue.startSeconds)}
                </button>
                {canEditCues && onDeleteCue ? (
                  <button
                    type="button"
                    disabled={cueMutationPending}
                    onClick={() => onDeleteCue(cue)}
                    aria-label={`Delete ${cue.comment.trim() || "memory cue"}`}
                  >
                    <X size={10} />
                  </button>
                ) : null}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {mediaError ? (
        <div className="player-error" role="alert">
          <span>{mediaError}</span>
          {track?.fileExists !== false ? (
            <button
              type="button"
              onClick={() => setLoadAttempt((current) => current + 1)}
              aria-label="Retry loading audio"
            >
              <RotateCcw size={11} /> Retry
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
});

function compareCues(left: PlayerCue, right: PlayerCue): number {
  return (
    left.startSeconds - right.startSeconds ||
    (left.slot ?? Number.MAX_SAFE_INTEGER) - (right.slot ?? Number.MAX_SAFE_INTEGER)
  );
}

function cueLabel(cue: PlayerCue): string {
  if (cue.kind === "hot" && cue.slot) return String.fromCharCode(64 + cue.slot);
  return cue.comment.trim() || "M";
}

function cueColor(cue: PlayerCue, fallback: string): string {
  return cue.kind === "hot" ? (rekordboxHotCueColor(cue.colorTableIndex) ?? fallback) : fallback;
}

function colorWithAlpha(color: string, alpha: number): string {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/iu.exec(color);
  if (!match) return color;
  return `rgb(${String(Number.parseInt(match[1]!, 16))} ${String(Number.parseInt(match[2]!, 16))} ${String(Number.parseInt(match[3]!, 16))} / ${String(alpha)})`;
}

function finitePositive(value: number | null | undefined): number | undefined {
  return value !== undefined && value !== null && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const totalSeconds = Math.floor(value);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3_600);
  return hours
    ? `${String(hours)}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes)}:${String(seconds).padStart(2, "0")}`;
}
