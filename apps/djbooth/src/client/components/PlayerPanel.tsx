import {
  AudioLines,
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

import type {
  HostedTrack,
  HotCueSlot,
  ProcessingJob,
  TrackCue,
  TrackWaveform,
  UsbTrack,
} from "../../shared/types.js";
import { getTrackWaveform } from "../api.js";
import { rekordboxHotCueColor } from "../cue-palette.js";
import { formatBpm } from "../format.js";
import {
  connectDeckAudio,
  FLAT_DECK_EQ,
  toggleStemMix,
  type DeckAudioGraph,
  type DeckEq,
  type DeckStemSource,
} from "../deck-audio.js";
import {
  trackSourcesFromComment,
  type TrackSource,
  type TrackSourceProvider,
} from "../track-sources.js";
import { displayWaveform } from "../waveform-display.js";
import { PlayerWaveformCanvas } from "./PlayerWaveformCanvas.js";
import { RgbWaveform } from "./RgbWaveform.js";
import { SpotifyEmbedPlayer, type SpotifyEmbedPlayerHandle } from "./SpotifyEmbedPlayer.js";

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
  comment?: string | null;
  hosted?: HostedTrack;
  usb?: UsbTrack;
};

export type PlayerCue = TrackCue;
export type PlayerWaveform = TrackWaveform;

/**
 * Trusted media boundary for {@link PlayerPanel}.
 *
 * The player never receives filesystem paths. The host supplies same-origin media URLs and may
 * supply precomputed Rekordbox peaks. The hidden WaveSurfer transport receives a flat peak solely
 * to prevent browser-side decoding; visible canvases render only real analysis data.
 */
export interface PlayerAdapter {
  getAudioUrl(track: PlayerTrack): string | undefined;
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
  compact?: boolean;
  deckLabel?: "A" | "B";
  eq?: DeckEq;
  outputGain?: number;
  showEqControls?: boolean;
  mediaSessionEnabled?: boolean;
  minimal?: boolean;
  stemsPending?: boolean;
  stemJob?: ProcessingJob;
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
  onEqChange?(eq: DeckEq): void;
  onSeparateStems?(): void;
  onError?(error: Error): void;
};

const HOT_CUE_SLOTS = Array.from({ length: 16 }, (_, index) => (index + 1) as HotCueSlot);
const MAX_REMOTE_LOAD_RETRIES = 2;
const REMOTE_RETRY_BASE_MS = 400;
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
    compact = false,
    deckLabel,
    eq,
    outputGain = 1,
    showEqControls = true,
    mediaSessionEnabled = true,
    minimal = false,
    stemsPending = false,
    stemJob,
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
    onEqChange,
    onSeparateStems,
    onError,
  },
  forwardedRef,
) {
  const waveformElementRef = useRef<HTMLDivElement>(null);
  const waveSurferRef = useRef<WaveSurfer | undefined>(undefined);
  const spotifyPlayerRef = useRef<SpotifyEmbedPlayerHandle>(null);
  const audioGraphRef = useRef<DeckAudioGraph | undefined>(undefined);
  const stemSourcesRef = useRef<readonly DeckStemSource[]>([]);
  const mixRef = useRef({ eq: eq ?? FLAT_DECK_EQ, outputGain });
  const spotifyWasPlayingRef = useRef(false);
  const currentTimeRef = useRef(0);
  const hlsRef = useRef<import("hls.js").default | undefined>(undefined);
  const soundCloudReadyRef = useRef(false);
  const soundCloudPlayPendingRef = useRef(false);
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
  const [waveformData, setWaveformData] = useState<PlayerWaveform | null>(null);
  const [liveStemIds, setLiveStemIds] = useState<string[] | undefined>();

  callbacksRef.current = { onEnded, onReady, onTimeChange, onPlayStateChange, onError };
  currentTimeRef.current = currentTime;
  mixRef.current = { eq: eq ?? FLAT_DECK_EQ, outputGain };

  const audioUrl = useMemo(
    () => (track ? adapter.getAudioUrl(track) : undefined),
    [adapter, track],
  );
  const artworkUrl = useMemo(
    () => (track ? adapter.getArtworkUrl(track) : undefined),
    [adapter, track],
  );
  const trackSources = useMemo(() => {
    const sources = trackSourcesFromComment(track?.comment);
    if (
      track?.hosted?.externalUrl &&
      !sources.some((source) => source.provider === track.hosted?.provider)
    ) {
      sources.unshift({
        provider: track.hosted.provider,
        kind: "reference",
        url: track.hosted.externalUrl,
      });
    }
    return sources;
  }, [track?.comment, track?.hosted]);
  const availableStems = useMemo(
    () =>
      (stemJob?.status === "completed" ? (stemJob.artifacts ?? []) : [])
        .filter((artifact): artifact is typeof artifact & { stem: string; url: string } =>
          Boolean(artifact.stem && artifact.url),
        )
        .map((artifact) => ({
          id: artifact.stem.toLowerCase(),
          label: stemLabel(artifact.stem),
          url: artifact.url,
        }))
        .sort((left, right) => stemOrder(left.id) - stemOrder(right.id)),
    [stemJob],
  );
  const stemFingerprint = availableStems.map(({ id, url }) => `${id}:${url}`).join("|");
  stemSourcesRef.current = availableStems;
  const spotifyStreaming =
    track?.hosted?.provider === "spotify" && track.hosted.localContentId === null;
  const soundCloudStreaming =
    track?.hosted?.provider === "soundcloud" && track.hosted.localContentId === null;
  const soundCloudProgressive = soundCloudStreaming && track.hosted?.streamKind === "progressive";
  const remoteStreaming = spotifyStreaming || soundCloudStreaming;
  const effectiveDuration = finitePositive(duration) ?? finitePositive(track?.durationSeconds) ?? 0;

  const reportError = useCallback(
    (cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      setMediaError(error.message);
      if (!remoteStreaming) callbacksRef.current.onError?.(error);
    },
    [remoteStreaming],
  );

  const seekTo = useCallback(
    (seconds: number) => {
      if (spotifyStreaming) {
        const nextTime = clamp(seconds, 0, effectiveDuration);
        spotifyPlayerRef.current?.seek(nextTime);
        setCurrentTime(nextTime);
        callbacksRef.current.onTimeChange?.(nextTime);
        return;
      }
      const waveSurfer = waveSurferRef.current;
      if (!waveSurfer) return;
      const nextTime = clamp(seconds, 0, waveSurfer.getDuration() || effectiveDuration);
      waveSurfer.setTime(nextTime);
      setCurrentTime(nextTime);
      callbacksRef.current.onTimeChange?.(nextTime);
    },
    [effectiveDuration, spotifyStreaming],
  );

  const setVolume = useCallback((nextVolume: number) => {
    const normalized = clamp(nextVolume, 0, 1);
    const waveSurfer = waveSurferRef.current;
    waveSurfer?.setVolume(normalized);
    if (normalized > 0) waveSurfer?.setMuted(false);
    setVolumeState(normalized);
    if (normalized > 0) setMuted(false);
  }, []);

  const applyStemMix = useCallback(
    async (nextIds: string[] | undefined) => {
      const graph = audioGraphRef.current;
      if (!graph) {
        reportError(new Error("Live stems require local deck audio"));
        return;
      }
      try {
        await graph.resume();
        await graph.setStemMix(nextIds);
        setLiveStemIds(nextIds);
      } catch (error) {
        reportError(error);
      }
    },
    [reportError],
  );

  const play = useCallback(async () => {
    if (spotifyStreaming) {
      spotifyPlayerRef.current?.play();
      return;
    }
    if (soundCloudStreaming && !soundCloudReadyRef.current) {
      soundCloudPlayPendingRef.current = true;
      return;
    }
    if ((!track?.fileExists && !soundCloudStreaming) || !waveSurferRef.current) return;
    try {
      await audioGraphRef.current?.resume();
      await waveSurferRef.current?.play();
    } catch (error) {
      reportError(error);
    }
  }, [reportError, soundCloudStreaming, spotifyStreaming, track?.fileExists]);

  const pause = useCallback(() => {
    if (spotifyStreaming) spotifyPlayerRef.current?.pause();
    else {
      soundCloudPlayPendingRef.current = false;
      waveSurferRef.current?.pause();
    }
  }, [spotifyStreaming]);
  const toggle = useCallback(async () => {
    if (spotifyStreaming) {
      spotifyPlayerRef.current?.toggle();
      return;
    }
    if (waveSurferRef.current?.isPlaying()) pause();
    else await play();
  }, [pause, play, spotifyStreaming]);

  useImperativeHandle(
    forwardedRef,
    () => ({
      play,
      pause,
      toggle,
      seekTo,
      seekBy(seconds) {
        seekTo(
          (spotifyStreaming ? currentTime : (waveSurferRef.current?.getCurrentTime() ?? 0)) +
            seconds,
        );
      },
      setVolume,
      getCurrentTime() {
        return spotifyStreaming ? currentTime : (waveSurferRef.current?.getCurrentTime() ?? 0);
      },
      isPlaying() {
        return spotifyStreaming
          ? (spotifyPlayerRef.current?.isPlaying() ?? false)
          : (waveSurferRef.current?.isPlaying() ?? false);
      },
    }),
    [currentTime, pause, play, seekTo, setVolume, spotifyStreaming, toggle],
  );

  useEffect(() => {
    const container = waveformElementRef.current;
    setPlaying(false);
    setLoadingPercent(0);
    setReady(false);
    setCurrentTime(0);
    setDuration(finitePositive(track?.durationSeconds) ?? 0);
    setMediaError(undefined);
    setWaveformData(null);
    soundCloudReadyRef.current = false;
    soundCloudPlayPendingRef.current = false;
    if (
      !container ||
      !track ||
      !audioUrl ||
      (track.fileExists === false && !soundCloudStreaming) ||
      spotifyStreaming
    )
      return;
    const controller = new AbortController();
    const media = document.createElement("audio");
    media.preload = "metadata";
    const waveSurfer = WaveSurfer.create({
      container,
      backend: "MediaElement",
      height: 1,
      waveColor: "transparent",
      progressColor: "transparent",
      cursorWidth: 0,
      interact: false,
      media,
      mediaControls: false,
    });
    waveSurferRef.current = waveSurfer;
    audioGraphRef.current = connectDeckAudio(media, mixRef.current.eq, mixRef.current.outputGain);
    audioGraphRef.current?.setStemSources(stemSourcesRef.current);
    waveSurfer.setVolume(volume);
    waveSurfer.setMuted(muted);

    const reportWaveSurferError = (error: Error) => {
      // Hls.js owns MSE recovery for SoundCloud. Chromium can emit a transient MEDIA_ERR_SRC_NOT_SUPPORTED
      // while a MediaSource is being replaced; surfacing that generic element error races Hls.js recovery
      // and produces the misleading "no supported source" toast.
      if (!soundCloudStreaming || soundCloudProgressive || !hlsRef.current) reportError(error);
    };
    let readyNotified = false;
    const notifyReady = () => {
      if (readyNotified || controller.signal.aborted) return;
      readyNotified = true;
      setMediaError(undefined);
      setReady(true);
      callbacksRef.current.onReady?.();
    };
    const unsubscribers = [
      waveSurfer.on("loading", (percent) => {
        if (!controller.signal.aborted) setLoadingPercent(percent);
      }),
      waveSurfer.on("ready", (loadedDuration) => {
        if (controller.signal.aborted) return;
        setDuration(loadedDuration);
        setLoadingPercent(100);
        notifyReady();
      }),
      waveSurfer.on("timeupdate", (seconds) => {
        if (controller.signal.aborted) return;
        setCurrentTime(seconds);
        callbacksRef.current.onTimeChange?.(seconds);
      }),
      waveSurfer.on("play", () => {
        if (controller.signal.aborted) return;
        setPlaying(true);
        callbacksRef.current.onPlayStateChange?.(true);
      }),
      waveSurfer.on("pause", () => {
        if (controller.signal.aborted) return;
        setPlaying(false);
        callbacksRef.current.onPlayStateChange?.(false);
      }),
      waveSurfer.on("finish", () => {
        if (controller.signal.aborted) return;
        setPlaying(false);
        callbacksRef.current.onPlayStateChange?.(false);
        callbacksRef.current.onEnded?.();
      }),
      waveSurfer.on("error", (error) => {
        if (!controller.signal.aborted) reportWaveSurferError(error);
      }),
    ];

    let mediaReady = false;
    const markSoundCloudReady = () => {
      if (!media || mediaReady || controller.signal.aborted) return;
      mediaReady = true;
      soundCloudReadyRef.current = true;
      const loadedDuration =
        finitePositive(media.duration) ?? finitePositive(track.durationSeconds);
      if (loadedDuration) setDuration(loadedDuration);
      setLoadingPercent(100);
      notifyReady();
      if (soundCloudPlayPendingRef.current) {
        soundCloudPlayPendingRef.current = false;
        void waveSurfer.play().catch(reportError);
      }
    };
    const updateSoundCloudDuration = () => {
      const loadedDuration = media ? finitePositive(media.duration) : undefined;
      if (loadedDuration) setDuration(loadedDuration);
      // Metadata is enough to expose a stable timeline and accept seeks. Playback itself remains
      // queued until canplay so a slow remote stream never makes the transport lie.
      notifyReady();
    };
    media?.addEventListener("loadedmetadata", updateSoundCloudDuration);
    media?.addEventListener("canplay", markSoundCloudReady, { once: true });

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
        // playback readiness and can be drawn later without reloading the media.
        if (soundCloudStreaming && soundCloudProgressive) {
          await waveSurfer.load(
            audioUrl,
            [Float32Array.of(0)],
            finitePositive(track.durationSeconds),
          );
        } else if (soundCloudStreaming && media) {
          const { default: Hls, ErrorTypes, Events: HlsEvents } = await import("hls.js");
          if (controller.signal.aborted) return;
          if (Hls.isSupported()) {
            let recoveredMediaError = false;
            const hls = new Hls({
              autoStartLoad: true,
              enableWorker: true,
              startFragPrefetch: false,
            });
            hlsRef.current = hls;
            hls.on(HlsEvents.ERROR, (_event, data) => {
              if (controller.signal.aborted) return;
              if (!data.fatal) return;
              if (data.type === ErrorTypes.MEDIA_ERROR && !recoveredMediaError) {
                recoveredMediaError = true;
                hls.recoverMediaError();
                return;
              }
              reportError(data.error);
            });
            hls.on(HlsEvents.MEDIA_ATTACHED, () => {
              if (!controller.signal.aborted) hls.loadSource(audioUrl);
            });
            hls.attachMedia(media);
          } else if (media.canPlayType("application/vnd.apple.mpegurl")) {
            media.src = audioUrl;
            media.load();
          } else {
            throw new Error("This browser cannot play SoundCloud AAC HLS streams");
          }
        } else {
          await waveSurfer.load(
            audioUrl,
            [Float32Array.of(0)],
            finitePositive(track.durationSeconds),
          );
        }
        const waveform = await waveformRequest;
        if (!controller.signal.aborted) setWaveformData(displayWaveform(waveform));
      } catch (error) {
        if (!controller.signal.aborted) reportError(error);
      }
    })();

    return () => {
      controller.abort();
      for (const unsubscribe of unsubscribers) unsubscribe();
      media?.removeEventListener("loadedmetadata", updateSoundCloudDuration);
      media?.removeEventListener("canplay", markSoundCloudReady);
      soundCloudReadyRef.current = false;
      soundCloudPlayPendingRef.current = false;
      hlsRef.current?.destroy();
      hlsRef.current = undefined;
      waveSurfer.destroy();
      audioGraphRef.current?.dispose();
      audioGraphRef.current = undefined;
      if (waveSurferRef.current === waveSurfer) waveSurferRef.current = undefined;
    };
    // Media is keyed by URL/track. Callback updates are routed through callbacksRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    adapter,
    audioUrl,
    loadAttempt,
    soundCloudProgressive,
    soundCloudStreaming,
    spotifyStreaming,
    track?.fileExists,
    track?.id,
  ]);

  useEffect(() => {
    audioGraphRef.current?.update(eq ?? FLAT_DECK_EQ, outputGain);
  }, [eq, outputGain]);

  useEffect(() => {
    setLiveStemIds(undefined);
    audioGraphRef.current?.setStemSources(availableStems);
    // Artifact identity, not query-object identity, determines whether media layers changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stemFingerprint, track?.id]);

  useEffect(() => setLoadAttempt(0), [track?.id]);
  useEffect(() => {
    if (!mediaError || !remoteStreaming) return;
    if (loadAttempt >= MAX_REMOTE_LOAD_RETRIES) {
      callbacksRef.current.onError?.(new Error(mediaError));
      return;
    }
    const timeout = window.setTimeout(
      () => {
        setMediaError(undefined);
        setLoadAttempt((current) => current + 1);
      },
      REMOTE_RETRY_BASE_MS * 2 ** loadAttempt,
    );
    return () => window.clearTimeout(timeout);
  }, [loadAttempt, mediaError, remoteStreaming]);
  useEffect(() => setSelectedHotCueSlot(undefined), [track?.id]);
  useEffect(() => {
    spotifyWasPlayingRef.current = false;
  }, [track?.id]);

  useEffect(() => {
    if (!mediaSessionEnabled || !("mediaSession" in navigator) || !track) return;
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
          seekTo(
            (spotifyStreaming
              ? currentTimeRef.current
              : (waveSurferRef.current?.getCurrentTime() ?? 0)) - (details.seekOffset ?? 10),
          ),
      ],
      [
        "seekforward",
        (details) =>
          seekTo(
            (spotifyStreaming
              ? currentTimeRef.current
              : (waveSurferRef.current?.getCurrentTime() ?? 0)) + (details.seekOffset ?? 10),
          ),
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
  }, [artworkUrl, mediaSessionEnabled, onNext, onPrevious, pause, play, seekTo, track]);

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
  const unavailable =
    !track || (track.fileExists === false && !spotifyStreaming && !soundCloudStreaming);

  return (
    <section
      className={`player-panel${compact ? " is-compact" : ""}${minimal ? " is-minimal" : ""}`}
      aria-label={deckLabel ? `Deck ${deckLabel}` : "Track player"}
    >
      {spotifyStreaming && track?.hosted ? (
        <SpotifyEmbedPlayer
          key={`${track.id}:${String(loadAttempt)}`}
          ref={spotifyPlayerRef}
          uri={track.hosted.remoteId}
          onReady={() => {
            setMediaError(undefined);
            setReady(true);
            setLoadingPercent(100);
            callbacksRef.current.onReady?.();
          }}
          onPlaybackUpdate={(update) => {
            setMediaError(undefined);
            const seconds = update.position / 1_000;
            const durationSeconds = update.duration / 1_000;
            const ended =
              spotifyWasPlayingRef.current &&
              update.isPaused &&
              durationSeconds > 0 &&
              seconds >= durationSeconds - 0.75;
            spotifyWasPlayingRef.current = !update.isPaused;
            setCurrentTime(seconds);
            if (durationSeconds > 0) setDuration(durationSeconds);
            setPlaying(!update.isPaused);
            // Buffering is transient media state, not loss of timeline readiness. Keeping the
            // scrub surfaces enabled prevents the transport from flickering during a seek.
            setReady(true);
            callbacksRef.current.onTimeChange?.(seconds);
            callbacksRef.current.onPlayStateChange?.(!update.isPaused);
            if (ended) callbacksRef.current.onEnded?.();
          }}
          onError={reportError}
        />
      ) : null}
      <div className="player-overview">
        <div className="player-overview-header">
          <div className="player-track-copy">
            <div className="player-track-title-row">
              {deckLabel ? (
                <span className={`deck-label is-${deckLabel.toLowerCase()}`}>{deckLabel}</span>
              ) : null}
              <strong title={track?.title}>{track?.title || "No track selected"}</strong>
              {trackSources.length ? (
                <div className="player-source-links" aria-label="Track sources">
                  {trackSources.map((source) => {
                    const label = sourceLabel(source);
                    return source.url ? (
                      <a
                        key={source.provider}
                        className="player-source-badge"
                        data-provider={source.provider}
                        href={source.url}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={label}
                        title={label}
                      >
                        <TrackSourceIcon provider={source.provider} />
                      </a>
                    ) : (
                      <span
                        key={source.provider}
                        className="player-source-badge is-static"
                        data-provider={source.provider}
                        aria-label={label}
                        title={label}
                      >
                        <TrackSourceIcon provider={source.provider} />
                      </span>
                    );
                  })}
                </div>
              ) : null}
              {availableStems.length ? (
                <div className="player-live-stems" aria-label="Live stem mix">
                  <button
                    type="button"
                    className={liveStemIds === undefined ? "is-active" : ""}
                    onClick={() => void applyStemMix(undefined)}
                    aria-pressed={liveStemIds === undefined}
                    title="Play the original recording"
                  >
                    Orig
                  </button>
                  <button
                    type="button"
                    className={liveStemIds?.length === availableStems.length ? "is-active" : ""}
                    onClick={() => void applyStemMix(availableStems.map(({ id }) => id))}
                    aria-pressed={liveStemIds?.length === availableStems.length}
                    title="Play all separated parts"
                  >
                    All
                  </button>
                  {availableStems.map((stem) => {
                    const active = liveStemIds?.includes(stem.id) ?? false;
                    return (
                      <button
                        key={stem.id}
                        type="button"
                        className={active ? "is-active" : ""}
                        onClick={() => void applyStemMix(toggleStemMix(liveStemIds, stem.id))}
                        aria-pressed={active}
                        title={`${active ? "Mute" : "Enable"} ${stem.label.toLowerCase()}`}
                      >
                        {stemShortLabel(stem.id)}
                      </button>
                    );
                  })}
                </div>
              ) : onSeparateStems ? (
                <button
                  className="player-stems-button"
                  type="button"
                  disabled={
                    !track ||
                    track.fileExists === false ||
                    Boolean(track.hosted) ||
                    Boolean(track.usb) ||
                    stemsPending
                  }
                  onClick={onSeparateStems}
                  title="Generate four MLX stems"
                >
                  {stemsPending ? (
                    <LoaderCircle size={11} className="spin" />
                  ) : (
                    <AudioLines size={11} />
                  )}
                  Stems
                </button>
              ) : null}
            </div>
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
              </div>
            ) : null}
          </div>
          <div className="player-overview-stats" aria-label="Playback and track statistics">
            <span>−{formatTime(Math.max(0, effectiveDuration - currentTime))}</span>
            <span>{formatTime(currentTime)}</span>
            <span>{track?.key ?? "—"}</span>
            <span>{formatBpm(track?.bpm)}</span>
          </div>
        </div>
        <button
          className="player-overview-waveform"
          type="button"
          disabled={unavailable || !ready || effectiveDuration <= 0}
          onClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            const ratio = clamp((event.clientX - bounds.left) / Math.max(1, bounds.width), 0, 1);
            seekTo(ratio * effectiveDuration);
          }}
          aria-label="Track overview waveform"
          title="Click to seek"
        >
          <RgbWaveform waveform={waveformData} className="player-overview-waveform-canvas" />
          <span
            className="player-overview-progress"
            style={{
              width: `${String(
                effectiveDuration > 0 ? clamp(currentTime / effectiveDuration, 0, 1) * 100 : 0,
              )}%`,
            }}
            aria-hidden="true"
          />
          <span
            className="player-overview-playhead"
            style={{
              left: `${String(
                effectiveDuration > 0 ? clamp(currentTime / effectiveDuration, 0, 1) * 100 : 0,
              )}%`,
            }}
            aria-hidden="true"
          />
        </button>
      </div>

      <div className="player-identity">
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
            {!ready && track && !mediaError ? (
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
        <div className="player-waveform">
          <div ref={waveformElementRef} className="player-waveform-engine" aria-hidden="true" />
          <PlayerWaveformCanvas
            currentTime={currentTime}
            cues={cues}
            disabled={unavailable || !ready}
            duration={effectiveDuration}
            onSeek={seekTo}
            playing={playing}
            waveform={waveformData}
          />
        </div>
        {!track ? <span className="player-waveform-empty">Select a track</span> : null}
        <div className="player-time-row" aria-live="off">
          <span>{formatTime(currentTime)}</span>
          {!ready && track && !mediaError ? (
            <span className="player-loading-label">
              <LoaderCircle size={11} className="spin" /> {String(Math.round(loadingPercent))}%
            </span>
          ) : null}
          <span>−{formatTime(Math.max(0, effectiveDuration - currentTime))}</span>
        </div>
      </div>

      <div className="player-volume">
        <span className="player-volume-label">{showEqControls && eq ? "Deck EQ" : "Level"}</span>
        {showEqControls && eq && onEqChange ? (
          <div className="player-eq-controls">
            <EqControl
              label="Low"
              value={eq.lowDb}
              onChange={(lowDb) => onEqChange({ ...eq, lowDb })}
            />
            <EqControl
              label="Mid"
              value={eq.midDb}
              onChange={(midDb) => onEqChange({ ...eq, midDb })}
            />
            <EqControl
              label="High"
              value={eq.highDb}
              onChange={(highDb) => onEqChange({ ...eq, highDb })}
            />
            <EqControl
              label="Trim"
              value={eq.trimDb}
              onChange={(trimDb) => onEqChange({ ...eq, trimDb })}
            />
          </div>
        ) : (
          <>
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
          </>
        )}
      </div>

      <div className="player-cues" aria-label="Cue points">
        <span className="player-cues-label">
          Hot cues <small>A–P</small>
        </span>
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

      {mediaError && (!remoteStreaming || loadAttempt >= MAX_REMOTE_LOAD_RETRIES) ? (
        <div className="player-error" role="alert">
          <span>{mediaError}</span>
          {track?.fileExists !== false || remoteStreaming ? (
            <button
              type="button"
              onClick={() => {
                setMediaError(undefined);
                setLoadAttempt((current) => current + 1);
              }}
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

function EqControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange(value: number): void;
}) {
  const normalized = (clamp(value, -24, 12) + 24) / 36;
  const angle = -135 + normalized * 270;
  const changeBy = (delta: number) => onChange(clamp(Math.round((value + delta) * 2) / 2, -24, 12));
  return (
    <label className="player-eq-knob-control">
      <span>{label}</span>
      <span
        className="player-eq-knob"
        role="slider"
        tabIndex={0}
        aria-label={`${label} EQ`}
        aria-valuemin={-24}
        aria-valuemax={12}
        aria-valuenow={value}
        aria-valuetext={`${value > 0 ? "+" : ""}${value.toFixed(1)} decibels`}
        style={{ "--knob-angle": `${String(angle)}deg` } as React.CSSProperties}
        title="Drag vertically · double-click to reset"
        onDoubleClick={() => onChange(0)}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.dataset.startY = String(event.clientY);
          event.currentTarget.dataset.startValue = String(value);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const startY = Number(event.currentTarget.dataset.startY);
          const startValue = Number(event.currentTarget.dataset.startValue);
          const next = startValue + ((startY - event.clientY) / 120) * 36;
          onChange(clamp(Math.round(next * 2) / 2, -24, 12));
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowRight") changeBy(0.5);
          else if (event.key === "ArrowDown" || event.key === "ArrowLeft") changeBy(-0.5);
          else if (event.key === "PageUp") changeBy(3);
          else if (event.key === "PageDown") changeBy(-3);
          else if (event.key === "Home") onChange(-24);
          else if (event.key === "End") onChange(12);
          else return;
          event.preventDefault();
        }}
      >
        <span className="player-eq-knob-marker" />
      </span>
      <output>{value === 0 ? "0" : `${value > 0 ? "+" : ""}${value.toFixed(1)}`}</output>
    </label>
  );
}

function stemLabel(stem: string): string {
  return stem.charAt(0).toUpperCase() + stem.slice(1).toLowerCase();
}

function stemShortLabel(stem: string): string {
  return { vocals: "V", drums: "D", bass: "B", other: "O" }[stem] ?? stem.slice(0, 1).toUpperCase();
}

function stemOrder(stem: string): number {
  return ["vocals", "drums", "bass", "other"].indexOf(stem);
}

function sourceLabel(source: TrackSource): string {
  const provider = {
    spotify: "Spotify",
    soundcloud: "SoundCloud",
    youtube: "YouTube",
    soulseek: "Soulseek",
  }[source.provider];
  if (!source.url) return `Downloaded from ${provider}${source.peer ? ` · ${source.peer}` : ""}`;
  return source.kind === "download" ? `Open original on ${provider}` : `Open track on ${provider}`;
}

function TrackSourceIcon({ provider }: { provider: TrackSourceProvider }) {
  if (provider === "youtube") {
    return (
      <svg className="player-source-icon" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="1.5" y="5" width="21" height="14" rx="5" fill="currentColor" />
        <path d="m10 8.6 5.8 3.4-5.8 3.4Z" fill="var(--source-cutout)" />
      </svg>
    );
  }
  if (provider === "spotify") {
    return (
      <svg className="player-source-icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="10.5" fill="currentColor" />
        <path
          d="M6.7 9.2c3.9-1.1 8.1-.7 11.3 1M7.4 12.2c3.3-.8 7-.5 9.8.8M8.1 15c2.8-.6 5.8-.3 8.2.7"
          fill="none"
          stroke="var(--source-cutout)"
          strokeWidth="1.65"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (provider === "soundcloud") {
    return (
      <svg className="player-source-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M2.5 13.1v2.5M4.5 11.8v5.1M6.5 10.3v7.1M8.5 9.2v8.5M10.5 8.5v9.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinecap="round"
        />
        <path d="M11.8 17.7h7.5a3.1 3.1 0 0 0 .2-6.2 5 5 0 0 0-7.7-3.2Z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg className="player-source-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <text x="12" y="14.2" textAnchor="middle" fill="currentColor" fontSize="6" fontWeight="700">
        slsk
      </text>
    </svg>
  );
}

function compareCues(left: PlayerCue, right: PlayerCue): number {
  return (
    left.startSeconds - right.startSeconds ||
    (left.slot ?? Number.MAX_SAFE_INTEGER) - (right.slot ?? Number.MAX_SAFE_INTEGER)
  );
}

function cueColor(cue: PlayerCue, fallback: string): string {
  return cue.kind === "hot" ? (rekordboxHotCueColor(cue.colorTableIndex) ?? fallback) : fallback;
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
