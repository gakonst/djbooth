import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LibraryTrack, PreviewDeck } from "./decks.js";
import { clipForTrack } from "./video-clips.js";
import { VideoControls, DEFAULT_VIDEO_LAYOUT, type VideoLayout } from "./video-controls.js";
import { alignmentForTrack } from "./video-alignment.js";
import { alignedVideoTime, videoSyncAction, type VideoAlignment } from "./video-sync.js";
import {
  trackVideoCandidates,
  type CustomTrackVideo,
  type LocalTrackVideo,
  type VideoDeck,
} from "./track-video.js";

const LAYOUT_KEY = "party-video-layout";
function savedLayout(): VideoLayout {
  try {
    const saved = JSON.parse(
      localStorage.getItem(LAYOUT_KEY) ?? "null",
    ) as Partial<VideoLayout> | null;
    if (!saved) return { ...DEFAULT_VIDEO_LAYOUT };
    return {
      width:
        typeof saved.width === "number" && Number.isFinite(saved.width)
          ? Math.max(20, Math.min(100, saved.width))
          : 30,
      opacity:
        typeof saved.opacity === "number" && Number.isFinite(saved.opacity)
          ? Math.max(20, Math.min(100, saved.opacity))
          : 100,
      position: ["top-left", "top-right", "center", "bottom-left", "bottom-right"].includes(
        saved.position ?? "",
      )
        ? saved.position!
        : "top-left",
      bouncing: saved.bouncing === true && !matchMedia("(prefers-reduced-motion: reduce)").matches,
    };
  } catch {
    return { ...DEFAULT_VIDEO_LAYOUT };
  }
}

/** Local footage above the game, with all controls kept in the operator menu. */
export function TrackVideos({
  decks,
  controlsHost,
  active,
  readDecks,
}: {
  decks: PreviewDeck[];
  controlsHost: HTMLDivElement | null;
  active: boolean;
  readDecks?: () => VideoDeck[];
}) {
  const [visible, setVisible] = useState(true);
  const [track, setTrack] = useState<LibraryTrack | null>(null);
  const [choice, setChoice] = useState("auto");
  const [layout, setLayout] = useState<VideoLayout>(savedLayout);
  const { width, opacity, position, bouncing } = layout;
  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      /* Private browsing. */
    }
  }, [layout]);
  useEffect(() => {
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => {
      if (preference.matches) setLayout((current) => ({ ...current, bouncing: false }));
    };
    preference.addEventListener("change", change);
    return () => preference.removeEventListener("change", change);
  }, []);
  const [custom, setCustom] = useState<CustomTrackVideo | null>(null);
  const [displayed, setDisplayed] = useState<LocalTrackVideo | null>(null);
  const [shouldPlay, setShouldPlay] = useState(false);
  const [available, setAvailable] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [libraryError, setLibraryError] = useState("");
  const [syncStatus, setSyncStatus] = useState("");
  const alignments = useRef(new Map<string, VideoAlignment | null | undefined>());
  const video = useRef<HTMLVideoElement>(null);
  const source = displayed?.source;
  const title = displayed?.title;
  const playback = useRef({ available, choice, custom, active, visible, opacity, readDecks });
  playback.current = { available, choice, custom, active, visible, opacity, readDecks };

  useEffect(() => {
    let current: LocalTrackVideo | null = null;
    let fade = 0;
    let last = performance.now();
    let frame = 0;
    let candidates: LocalTrackVideo[] = [];
    let sampledAt = -Infinity;
    let wasPlaying = false;
    let lastOpacity = "";
    let lastElement: HTMLVideoElement | null = null;
    let syncedOwner = "";
    let lastSyncStatus = "";
    const update = (now: number) => {
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      const settings = playback.current;
      const transports = settings.readDecks?.() ?? decks;
      // Track ownership needs 30 Hz; fades and motion still follow every display frame.
      if (now - sampledAt >= 1000 / 30) {
        sampledAt = now;
        candidates =
          settings.active && settings.visible
            ? trackVideoCandidates(transports, settings.available, settings.choice, settings.custom)
            : [];
      }
      const loudest = candidates.reduce<LocalTrackVideo | null>(
        (best, item) => (!best || item.gain > best.gain ? item : best),
        null,
      );
      const owner = candidates.find((item) => item.source === current?.source);
      const next = owner && (!loudest || loudest.gain <= owner.gain + 0.12) ? owner : loudest;
      if (current && next?.source === current.source) {
        if (
          current.trackId !== next.trackId ||
          current.deckIndex !== next.deckIndex ||
          current.exact !== next.exact
        )
          setDisplayed(next);
        current = next;
      }
      if (!current && next) {
        current = next;
        setDisplayed(next);
      }
      const switching = current?.source !== next?.source;
      const target = switching ? 0 : (next?.gain ?? 0);
      fade += Math.sign(target - fade) * Math.min(Math.abs(target - fade), dt / 0.6);
      if (switching && fade <= 0.001) {
        current = next;
        fade = 0;
        setDisplayed(next);
      }
      const clip = owner ?? (next && next.source === current?.source ? next : null);
      const ownerDeck = clip ? transports[clip.deckIndex] : undefined;
      let syncReady = true;
      let message = clip ? "Related footage · follows track transport" : "";
      const element = video.current;
      if (clip?.exact && clip.clipId && ownerDeck) {
        const key = `${clip.trackId}:${clip.clipId}`;
        if (!alignments.current.has(key)) {
          alignments.current.set(key, undefined);
          void alignmentForTrack(clip.trackId, clip.clipId).then((result) =>
            alignments.current.set(key, result),
          );
        }
        const alignment = alignments.current.get(key);
        const audioTime = ownerDeck.audio.currentTime;
        const targetTime = alignment ? alignedVideoTime(alignment, audioTime) : null;
        syncReady = targetTime !== null && !!element && element.readyState >= 1;
        message =
          alignment === undefined
            ? "Matching video to track…"
            : targetTime === null
              ? "No matching footage for this section"
              : "Video synced to track";
        if (syncReady && element && targetTime !== null) {
          const identity = `${key}:${clip.deckIndex}`;
          const future = alignedVideoTime(alignment!, audioTime + 0.1);
          const slope =
            future === null ? 1 : Math.max(0.98, Math.min(1.02, (future - targetTime) / 0.1));
          const action = videoSyncAction(
            targetTime,
            element.currentTime,
            ownerDeck.audio.playbackRate * slope,
            element.duration,
            syncedOwner !== identity,
          );
          if (!element.seeking && action.seek) element.currentTime = action.time;
          if (Math.abs(element.playbackRate - action.rate) > 0.001)
            element.playbackRate = action.rate;
          syncedOwner = identity;
          syncReady = !element.seeking && Math.abs(element.currentTime - targetTime) < 0.15;
        }
      } else if (element && ownerDeck) {
        const rate = Math.max(0.25, Math.min(4, ownerDeck.audio.playbackRate || 1));
        if (element.playbackRate !== rate) element.playbackRate = rate;
        syncedOwner = "";
      }
      if (message !== lastSyncStatus) {
        lastSyncStatus = message;
        setSyncStatus(message);
      }
      const playing = !!current && !!clip && (syncReady || !clip.exact);
      if (playing !== wasPlaying) {
        wasPlaying = playing;
        setShouldPlay(playing);
      }
      // Retain only the final frame while fading after pause/end, then release the video.
      if (!playing) video.current?.pause();
      const nextOpacity = (syncReady ? (fade * settings.opacity) / 100 : 0).toFixed(4);
      if (video.current !== lastElement) {
        lastElement = video.current;
        lastOpacity = "";
      }
      if (video.current && nextOpacity !== lastOpacity) {
        video.current.style.opacity = nextOpacity;
        lastOpacity = nextOpacity;
      }
      if (!video.current) lastOpacity = "";
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => {
      cancelAnimationFrame(frame);
      video.current?.pause();
    };
  }, [decks]);

  useEffect(() => {
    let selected: VideoDeck | undefined;
    const update = () => {
      const playing = (playback.current.readDecks?.() ?? decks).filter(
        (deck) => deck.playing && deck.fader > 0.015,
      );
      const loudest = playing.reduce<VideoDeck | undefined>(
        (best, deck) => (!best || deck.fader > best.fader ? deck : best),
        undefined,
      );
      selected = playing.find((deck) => deck.track?.id === selected?.track?.id);
      // Avoid swapping back and forth around the midpoint of a crossfade.
      if (!selected || (loudest && loudest.fader > selected.fader + 0.12)) selected = loudest;
      const next = selected?.track ?? null;
      setTrack((current) => (current?.id === next?.id ? current : next));
    };
    update();
    const timer = setInterval(update, 250);
    return () => clearInterval(timer);
  }, [decks]);

  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const response = await fetch("/party/clips", { signal: controller.signal });
        if (!response.ok) throw new Error("Local video library is unavailable");
        const data = (await response.json()) as { ids: string[] };
        if (!controller.signal.aborted) {
          setAvailable((previous) =>
            previous.length === data.ids.length && previous.every((id, i) => id === data.ids[i])
              ? previous
              : data.ids,
          );
          setLibraryError("");
        }
      } catch {
        if (!controller.signal.aborted) setLibraryError("Cannot read the local video library");
      } finally {
        loading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, []);

  useEffect(
    () => () => {
      if (custom) URL.revokeObjectURL(custom.url);
    },
    [custom],
  );

  useEffect(() => {
    setStatus("");
    const element = video.current;
    if (!element) return;
    if (!visible || !active || !source || !shouldPlay) {
      element.pause();
      return;
    }
    element.muted = true;
    void element.play().catch(() => setStatus("Playback paused. Click Resume video in this menu."));
    return () => {
      element.pause();
    };
  }, [source, visible, active, shouldPlay]);

  useEffect(() => {
    const element = video.current;
    const game = element?.closest(".app")?.querySelector(".stage");
    if (!element || !game || !source || !visible || !active || !bouncing) return;
    let x = 0,
      y = 0,
      dx = 1,
      dy = 1;
    let left = 0,
      top = 0,
      right = 0,
      bottom = 0;
    let initialized = false;
    const measure = () => {
      const bounds = game.getBoundingClientRect();
      left = Math.max(0, bounds.left);
      top = Math.max(0, bounds.top);
      right = Math.max(left, Math.min(innerWidth, bounds.right) - element.offsetWidth);
      bottom = Math.max(top, Math.min(innerHeight, bounds.bottom) - element.offsetHeight);
      if (!initialized) {
        x = position.endsWith("right") ? right : position === "center" ? (left + right) / 2 : left;
        y = position.startsWith("bottom")
          ? bottom
          : position === "center"
            ? (top + bottom) / 2
            : top;
        dx = position.endsWith("right") ? -1 : 1;
        initialized = true;
      }
      x = Math.max(left, Math.min(right, x));
      y = Math.max(top, Math.min(bottom, y));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(game);
    observer.observe(element);
    window.addEventListener("resize", measure);
    measure();
    element.style.left = "0";
    element.style.top = "0";
    element.style.right = "auto";
    let last = performance.now();
    let frame = 0;
    const move = (now: number) => {
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      x += dx * 110 * dt;
      y += dy * 78 * dt;
      if (x <= left) {
        x = left;
        dx = 1;
      } else if (x >= right) {
        x = right;
        dx = -1;
      }
      if (y <= top) {
        y = top;
        dy = 1;
      } else if (y >= bottom) {
        y = bottom;
        dy = -1;
      }
      element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      frame = requestAnimationFrame(move);
    };
    frame = requestAnimationFrame(move);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
      for (const property of ["left", "top", "right", "transform"])
        element.style.removeProperty(property);
    };
  }, [source, visible, active, bouncing, position]);

  const match = track ? clipForTrack(track) : undefined;
  const ownsCustom = !!custom && custom.trackId === track?.id;
  useEffect(() => {
    if (track && custom && custom.trackId !== track.id && choice === "custom") setChoice("auto");
  }, [track, custom, choice]);
  const customSelected = choice === "custom" && ownsCustom;
  const syncState = !track
    ? "Waiting for music"
    : customSelected
      ? "Custom clip"
      : !match
        ? "No matching video"
        : !available.includes(match.id)
          ? "Video unavailable"
          : syncStatus === "Video synced to track"
            ? "Synced"
            : syncStatus === "Matching video to track…"
              ? "Matching audio…"
              : syncStatus === "No matching footage for this section"
                ? "Waiting for matching footage"
                : syncStatus.startsWith("Related footage")
                  ? "Related footage"
                  : "Ready";
  const detail = !track
    ? "Start a track on your selected music source to see its video."
    : customSelected
      ? "Attached to this track. Follows play and pause; timing is manual."
      : !match
        ? "No video is matched to this track yet. You can attach your own."
        : !available.includes(match.id)
          ? "This track’s video is not available locally. You can use your own clip."
          : syncState === "Synced"
            ? "Matched to the recording. Follows the playhead and tempo."
            : syncState === "Matching audio…"
              ? "Finding the matching moments in the original video."
              : syncState === "Waiting for matching footage"
                ? "The game stays visible until the audio and video match again."
                : syncState === "Related footage"
                  ? "Original footage accompanies this remix with looser timing."
                  : "The matching video appears automatically when the track plays.";

  return (
    <>
      {controlsHost && active
        ? createPortal(
            <VideoControls
              visible={visible}
              onVisible={setVisible}
              layout={layout}
              onLayout={setLayout}
              video={video}
              title={
                customSelected
                  ? custom!.title
                  : (match?.title ?? track?.title ?? "Your next track sets the scene")
              }
              detail={detail}
              state={syncState}
              customTitle={ownsCustom ? custom!.title : undefined}
              customSelected={customSelected}
              onAutomatic={() => setChoice("auto")}
              onCustom={() => setChoice("custom")}
              canUpload={!!track}
              onUpload={(file) => {
                if (!track) return;
                setCustom({ url: URL.createObjectURL(file), title: file.name, trackId: track.id });
                setChoice("custom");
                setVisible(true);
              }}
              error={status || libraryError}
              onRetry={
                status && source
                  ? () => {
                      const element = video.current;
                      if (!element) return;
                      element.muted = true;
                      void element
                        .play()
                        .then(() => setStatus(""))
                        .catch(() =>
                          setStatus("This clip could not play. Try another video file."),
                        );
                    }
                  : undefined
              }
            />,
            controlsHost,
          )
        : null}
      {active && visible && source ? (
        <video
          key={source}
          ref={video}
          className={`track-video ${position} ${width === 100 && position === "center" && !bouncing ? "full-screen" : ""}`}
          style={{ width: `${width}%` }}
          aria-label={`Music video over the game: ${title ?? "local video"}`}
          src={source}
          muted
          loop={!displayed?.exact}
          playsInline
          preload="auto"
          disablePictureInPicture
          disableRemotePlayback
          onPlaying={() => setStatus("")}
          onError={() => setStatus("This video could not play. Choose another local video.")}
        />
      ) : null}
    </>
  );
}
