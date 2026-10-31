import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_VISUAL_LOOK } from "../../dj-monitor/src/visual-presets.js";
import { previewDecks } from "./decks.js";
import { previewSnapshot } from "./preview-monitor.js";
import { SetSimulator, type SetSimulatorStatus } from "./set-simulator.js";
import { ClickTrack } from "./music/click-track.js";
import {
  DeckBar,
  HelpOverlay,
  Inspector,
  LibraryOverlay,
  ScenePicker,
  SongSearch,
} from "./panels.js";
import { SCENES, sceneInfo, type SceneId } from "./scenes.js";
import {
  INTROS,
  LOOK_PARAMS,
  THEMES,
  loadShow,
  newDesignId,
  saveShow,
  saveThumb,
  type Design,
  type Show,
} from "./show.js";
import { createStage, type Stage, type MusicInput } from "./stage.js";
import type { ShowCue } from "./music/show-director.js";
import { TrackVideos } from "./video-overlay.js";
import { useA9Midi } from "../../dj-monitor/src/useA9Midi.js";
import { SceneControls } from "./scene-controls.js";

export type Mode = "build" | "play";
type Overlay = "library" | "songs" | "scenes" | "help" | null;
const INPUT_KEY = "party-music-input";

function savedInput(): MusicInput {
  const requested = new URLSearchParams(location.search).get("input");
  if (requested === "live" || requested === "demo") return requested;
  try {
    return localStorage.getItem(INPUT_KEY) === "live" ? "live" : "demo";
  } catch {
    return "demo";
  }
}

const wrap = (i: number, n: number) => ((i % n) + n) % n;
const typing = (target: EventTarget | null) =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  target instanceof HTMLSelectElement;

export function App() {
  const decks = useMemo(() => previewDecks(), []);
  const clicks = useMemo(() => new ClickTrack(decks), [decks]);
  const stageRef = useRef<HTMLDivElement>(null);
  const decksFrame = useRef<HTMLIFrameElement>(null);
  const stage = useRef<Stage>(undefined);
  const previewScene = useRef<SceneId | null>(null);
  const captureScene = useCallback(
    (scene: SceneId) =>
      previewScene.current === scene
        ? (stage.current?.capture() ?? Promise.resolve(null))
        : Promise.resolve(null),
    [],
  );
  const [show, setShow] = useState<Show | null>(null);
  const [mode, setMode] = useState<Mode>(() => (location.hash === "#play" ? "play" : "build"));
  const [musicInput, setMusicInput] = useState<MusicInput>(savedInput);
  const midi = useA9Midi(musicInput === "live");
  const [inputState, setInputState] = useState<ReturnType<Stage["input"]>>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [songDeck, setSongDeck] = useState(0);
  const [param, setParam] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [armedDelete, setArmedDelete] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [blackout, setBlackout] = useState(false);
  const [hud, setHud] = useState(false);
  const [showDecks, setShowDecks] = useState(false);
  const [deckSize, setDeckSize] = useState(70);
  const [deckOpacity, setDeckOpacity] = useState(75);
  const [playScene, setPlayScene] = useState<SceneId | null>(() => {
    const requested = new URLSearchParams(location.search).get("scene");
    return SCENES.find((scene) => scene.id === requested)?.id ?? null;
  });
  useEffect(() => {
    const url = new URL(location.href);
    if (playScene) url.searchParams.set("scene", playScene);
    else url.searchParams.delete("scene");
    history.replaceState(null, "", url);
  }, [playScene]);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [sceneStatus, setSceneStatus] = useState("");
  const [showCue, setShowCue] = useState<ShowCue>();
  const [videoControlsHost, setVideoControlsHost] = useState<HTMLDivElement | null>(null);
  const simulator = useRef<SetSimulator>(undefined);
  const [simulation, setSimulation] = useState<SetSimulatorStatus | null>(null);
  const videoDecks = useCallback(() => stage.current?.videoDecks() ?? decks, [decks]);

  useEffect(() => {
    const created = new SetSimulator(decks, setSimulation);
    simulator.current = created;
    return () => created.dispose();
  }, [decks]);

  useEffect(() => {
    let sequence = 0;
    const timer = setInterval(() => {
      decksFrame.current?.contentWindow?.postMessage(
        {
          type: "party-preview",
          snapshot:
            musicInput === "live"
              ? (stage.current?.hardwareSnapshot() ?? null)
              : decks.some((deck) => deck.track)
                ? previewSnapshot(decks, ++sequence)
                : null,
          mode: musicInput === "live" ? "live" : "replay",
        },
        location.origin,
      );
    }, 100);
    return () => clearInterval(timer);
  }, [decks, musicInput]);

  const designs = show?.designs ?? [];
  const selected = designs.find((d) => d.id === selectedId) ?? designs[0];
  const live = designs.find((d) => d.id === show?.liveId) ?? designs[0];
  const staged = mode === "build" ? selected : live;
  const activeDesign = useMemo(
    () => (staged && mode === "play" && playScene ? { ...staged, scene: playScene } : staged),
    [staged, mode, playScene],
  );

  useEffect(() => {
    loadShow()
      .then((loaded) => {
        setShow(loaded);
        setSelectedId(loaded.liveId ?? loaded.designs[0]?.id ?? null);
      })
      .catch((e: unknown) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!stageRef.current) return;
    const created = createStage(stageRef.current, decks);
    created.onError(setError);
    stage.current = created;
    return () => created.dispose();
  }, [decks]);

  useEffect(() => {
    stage.current?.setMidi(midi.connected, midi.controls);
  }, [midi.connected, midi.controls]);

  useEffect(() => {
    let current = true;
    previewScene.current = null;
    if (activeDesign)
      void stage.current?.show(activeDesign).then(() => {
        if (current) previewScene.current = activeDesign.scene;
      });
    return () => {
      current = false;
    };
  }, [activeDesign]);
  useEffect(() => {
    stage.current?.setInputSource(musicInput);
    try {
      localStorage.setItem(INPUT_KEY, musicInput);
    } catch {
      /* Private browsing. */
    }
    if (musicInput === "live") {
      simulator.current?.stop();
      for (const deck of decks) deck.audio.pause();
      if (clicks.enabled) clicks.toggle();
      setOverlay((current) => (current === "songs" ? null : current));
    }
  }, [musicInput, decks, clicks]);
  useEffect(() => {
    const timer = setInterval(() => setInputState(stage.current?.input()), 250);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => setError(""), [activeDesign?.id, activeDesign?.scene]);

  // Operator diagnostics belong in the editor; playback stays free of status overlays.
  useEffect(() => {
    if (mode !== "build") return;
    const timer = setInterval(() => {
      setSceneStatus(stage.current?.status() ?? "");
      setShowCue(stage.current?.cue());
    }, 100);
    return () => clearInterval(timer);
  }, [mode]);

  useEffect(() => {
    history.replaceState(null, "", mode === "play" ? "#play" : "#build");
  }, [mode]);

  // Autosave every change to show.json; the first load is not a change.
  const loaded = useRef(false);
  useEffect(() => {
    if (!show) return;
    if (!loaded.current) {
      loaded.current = true;
      return;
    }
    setSaveState("saving");
    const timer = setTimeout(() => {
      saveShow(show)
        .then(() => setSaveState("saved"))
        .catch(() => setSaveState("error"));
    }, 400);
    return () => clearTimeout(timer);
  }, [show]);

  const flash = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast((t) => (t === message ? "" : t)), 1600);
  }, []);

  const update = useCallback((id: string, patch: Partial<Design>) => {
    setShow(
      (s) =>
        s && {
          ...s,
          designs: s.designs.map((d) =>
            d.id === id ? { ...d, ...patch, updatedAt: Date.now() } : d,
          ),
        },
    );
  }, []);

  const addDesign = useCallback(
    (design: Omit<Design, "id" | "updatedAt">) => {
      const id = newDesignId(design.name, new Set(designs.map((d) => d.id)));
      const created: Design = { ...design, id, updatedAt: Date.now(), thumbAt: undefined };
      setShow((s) => {
        if (!s) return s;
        const at = s.designs.findIndex((d) => d.id === selected?.id) + 1;
        return { ...s, designs: [...s.designs.slice(0, at), created, ...s.designs.slice(at)] };
      });
      setSelectedId(id);
      setRenaming(true);
    },
    [designs, selected],
  );

  const capture = useCallback(async (design: Design) => {
    const image = await stage.current?.capture();
    if (!image) return;
    await saveThumb(design.id, image);
    setShow(
      (s) =>
        s && {
          ...s,
          designs: s.designs.map((d) => (d.id === design.id ? { ...d, thumbAt: Date.now() } : d)),
        },
    );
  }, []);

  // Designs without a snippet get one after they have been on stage for a moment.
  useEffect(() => {
    if (!staged || staged.thumbAt || mode !== "build") return;
    const timer = setTimeout(() => void capture(staged).catch(() => {}), 3500);
    return () => clearTimeout(timer);
  }, [staged, mode, capture]);

  const crossfade = useCallback(() => {
    const [a, b] = decks;
    if (!a || !b) return;
    const from = [a.fader, b.fader],
      to = a.fader >= b.fader ? [0, 1] : [1, 0];
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 2000);
      a.setFader(from[0]! + (to[0]! - from[0]!) * t);
      b.setFader(from[1]! + (to[1]! - from[1]!) * t);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, [decks]);

  const stepLive = useCallback(
    (delta: number) => {
      if (!designs.length) return;
      setPlayScene(null);
      const index = wrap(designs.findIndex((d) => d.id === live?.id) + delta, designs.length);
      setShow((s) => s && { ...s, liveId: designs[index]!.id });
      flash(designs[index]!.name);
    },
    [designs, live, flash],
  );

  const keys = useRef<(event: KeyboardEvent) => void>(() => {});
  keys.current = (event) => {
    if (typing(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key;
    const handled = () => event.preventDefault();
    if (key === "Tab") {
      handled();
      setOverlay(null);
      setRenaming(false);
      setMode((m) => (m === "build" ? "play" : "build"));
      return;
    }
    if (key === "Escape") return setOverlay(null);
    if (key === "?") {
      handled();
      return setOverlay((o) => (o === "help" ? null : "help"));
    }
    if (overlay) return;
    if (key.toLowerCase() === "v") {
      setShowDecks((visible) => !visible);
      return;
    }

    // Shared transport keys: rehearse with the music in either mode.
    if (key === " ") {
      handled();
      if (musicInput === "live") return;
      return void decks[event.shiftKey ? 1 : 0]?.toggle();
    }
    if (key === "x" || key === "X") return musicInput === "demo" ? crossfade() : undefined;
    if (key === "k" || key === "K") {
      handled();
      if (musicInput === "live") return;
      return flash(clicks.toggle() ? "Click track on: a tick on every note" : "Click track off");
    }
    if (key === "," || key === ".") {
      if (musicInput === "live") return;
      const deck = decks[0]!;
      return deck.seek(deck.audio.currentTime + (key === "," ? -10 : 10));
    }

    if (mode === "play") {
      if (key === "ArrowRight" || key === "ArrowDown") return stepLive(1);
      if (key === "ArrowLeft" || key === "ArrowUp") return stepLive(-1);
      if (/^[1-9]$/u.test(key)) {
        const target = designs[Number(key) - 1];
        if (target) {
          setPlayScene(null);
          setShow((s) => s && { ...s, liveId: target.id });
          flash(target.name);
        }
        return;
      }
      if (key === "b" || key === "B") {
        setBlackout((on) => {
          stage.current?.setBlackout(!on);
          return !on;
        });
        return;
      }
      if (key === "f" || key === "F") {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen();
        return;
      }
      if (key === "h" || key === "H") return setHud((on) => !on);
      return;
    }

    if (!selected) return;
    const lower = key.toLowerCase();
    if (key === "ArrowDown" || key === "ArrowUp") {
      handled();
      const index = designs.findIndex((d) => d.id === selected.id);
      setSelectedId(designs[wrap(index + (key === "ArrowDown" ? 1 : -1), designs.length)]!.id);
      setRenaming(false);
      return;
    }
    if (key === "ArrowLeft" || key === "ArrowRight") {
      handled();
      const spec = LOOK_PARAMS[param]!;
      const step = (spec.max / 40) * (event.shiftKey ? 5 : 1) * (key === "ArrowRight" ? 1 : -1);
      const value = Math.max(0, Math.min(spec.max, selected.look[spec.key] + step));
      return update(selected.id, { look: { ...selected.look, [spec.key]: value } });
    }
    if (/^[1-4]$/u.test(key)) return setParam(Number(key) - 1);
    if (key === "Enter") {
      setShow((s) => s && { ...s, liveId: selected.id });
      return flash(`“${selected.name}” is now on Play`);
    }
    if (key === "Backspace" || key === "Delete") {
      if (!armedDelete) {
        setArmedDelete(true);
        setTimeout(() => setArmedDelete(false), 2500);
        return flash("Press ⌫ again to delete");
      }
      setArmedDelete(false);
      const index = designs.findIndex((d) => d.id === selected.id);
      const rest = designs.filter((d) => d.id !== selected.id);
      if (!rest.length) return flash("Keep at least one design");
      setShow(
        (s) =>
          s && {
            ...s,
            designs: rest,
            liveId: s.liveId === selected.id ? rest[0]!.id : s.liveId,
          },
      );
      setSelectedId(rest[Math.min(index, rest.length - 1)]!.id);
      return flash(`Deleted “${selected.name}”`);
    }
    if (key === "[" || key === "]") {
      const index = SCENES.findIndex((s) => s.id === selected.scene);
      const scene = SCENES[wrap(index + (key === "]" ? 1 : -1), SCENES.length)]!;
      return update(selected.id, { scene: scene.id, thumbAt: undefined });
    }
    if (lower === "l") {
      handled();
      return setOverlay("library");
    }
    if (lower === "n") return setOverlay("scenes");
    if (lower === "m") {
      handled();
      if (musicInput === "live") return;
      setSongDeck(event.shiftKey ? 1 : 0);
      return setOverlay("songs");
    }
    if (lower === "r") {
      handled();
      return setRenaming(true);
    }
    if (lower === "d") {
      handled();
      const { id: _, updatedAt: __, ...copy } = selected;
      return addDesign({ ...copy, name: `${selected.name} copy`.slice(0, 32) });
    }
    if (lower === "t") {
      if (sceneInfo(selected.scene).themes === false)
        return flash("This scene has its own colours");
      const index = THEMES.findIndex((t) => t.value === selected.look.theme);
      const theme = THEMES[wrap(index + 1, THEMES.length)]!.value;
      return update(selected.id, { look: { ...selected.look, theme }, thumbAt: undefined });
    }
    if (lower === "i") {
      const intro = INTROS[wrap(INTROS.indexOf(selected.intro) + 1, INTROS.length)]!;
      update(selected.id, { intro });
      return flash(`Intro: ${intro}`);
    }
    if (lower === "c") {
      void capture(selected)
        .then(() => flash("Snippet updated"))
        .catch(() => flash("Snippet failed"));
    }
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keys.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const createFromScene = (scene: SceneId) => {
    setOverlay(null);
    addDesign({
      name: sceneInfo(scene).label,
      scene,
      look: { ...(selected?.look ?? DEFAULT_VISUAL_LOOK) },
      intro: "fade",
    });
  };

  return (
    <div className={`app ${mode} ${hud ? "controls-open" : ""} ${showDecks ? "with-decks" : ""}`}>
      {mode === "play" ? (
        <button
          className="controls-toggle"
          aria-expanded={hud}
          aria-controls="party-controls"
          onClick={() => setHud((open) => !open)}
        >
          {hud ? "Close controls" : "Music & visuals"}
        </button>
      ) : null}
      {mode === "build" && selected ? (
        <header className="topbar">
          <div className="show-brand" aria-label="All Hallows visual show">
            <span className="brand-sigil" aria-hidden="true">
              ◈
            </span>
            <span>
              ALL HALLOWS<small>A night in the machine</small>
            </span>
          </div>
          <nav className="modes" aria-label="Mode">
            <button aria-current="page">Build</button>
            <button onClick={() => setMode("play")}>Play</button>
            <kbd>Tab</kbd>
          </nav>
          <button className="design-picker" onClick={() => setOverlay("library")}>
            <span className="picker-name">{selected.name}</span>
            <span className="picker-meta">
              {designs.indexOf(selected) + 1}/{designs.length} · {sceneInfo(selected.scene).label}
            </span>
            <span aria-hidden="true">▾</span>
            <kbd>L</kbd>
          </button>
          <span className={`save-state ${saveState}`}>
            {saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : "Save failed"}
          </span>
          <button className="help-button" onClick={() => setOverlay("help")}>
            Shortcuts <kbd>?</kbd>
          </button>
          <button aria-pressed={showDecks} onClick={() => setShowDecks((visible) => !visible)}>
            Decks <kbd>V</kbd>
          </button>
        </header>
      ) : null}

      <main className="workspace">
        <section className="stage-frame">
          {mode === "build" && activeDesign ? (
            <div className="stage-heading">
              <div>
                <span className="eyebrow">THE MIDNIGHT COLLECTION</span>
                <h1>{sceneInfo(activeDesign.scene).label}</h1>
              </div>
              <button className="enter-show" onClick={() => setMode("play")}>
                Enter the show <span aria-hidden="true">↗</span>
              </button>
            </div>
          ) : null}
          <div className="stage">
            <div className="stage-canvas" ref={stageRef} />
            {mode === "build" && live && selected ? (
              <span className={`stage-badge ${live.id === selected.id ? "live" : ""}`}>
                {live.id === selected.id ? "ON PLAY" : `Play shows “${live.name}” · ⏎ to send this`}
              </span>
            ) : null}
            {mode === "build" && sceneStatus ? (
              <span className="stage-status">{sceneStatus}</span>
            ) : null}
            {mode === "build" && showCue ? (
              <div className="music-direction" aria-label="Musical lighting">
                <span className={`signal-dot ${showCue.active ? "active" : ""}`} />
                <span className="direction-phase">
                  {
                    {
                      idle: "After hours",
                      break: "The hush",
                      vocal: "Apparitions",
                      groove: "Night drive",
                      build: "The summoning",
                      drop: "Unleashed",
                    }[showCue.phase]
                  }
                </span>
                <span className="direction-detail">
                  {showCue.active
                    ? `${Math.round(showCue.bpm)} BPM · ${showCue.source === "phrases" ? "Phrase locked" : showCue.source === "waveform" ? "Waveform following" : "Audio following"}`
                    : "Waiting for music"}
                </span>
                <span
                  className="direction-beats"
                  aria-label={
                    showCue.active ? `Beat ${Math.floor(((showCue.beat % 4) + 4) % 4) + 1}` : "Idle"
                  }
                >
                  {[0, 1, 2, 3].map((beat) => (
                    <i
                      key={beat}
                      className={
                        showCue.active && Math.floor(((showCue.beat % 4) + 4) % 4) === beat
                          ? "lit"
                          : ""
                      }
                    />
                  ))}
                </span>
              </div>
            ) : null}
            {showDecks ? (
              <section
                className="live-decks"
                aria-label="Live decks and mixer over the scene"
                style={{
                  width: `${deckSize}%`,
                  left: `${(100 - deckSize) / 2}%`,
                  height: `clamp(${deckSize * 1.1}px, ${deckSize * 0.28}vh, ${deckSize * 3}px)`,
                  maxHeight: `${deckSize * 0.4}%`,
                  opacity: deckOpacity / 100,
                }}
              >
                <iframe
                  ref={decksFrame}
                  title="Live decks and mixer"
                  src="/decks.html"
                  allow="midi"
                />
              </section>
            ) : null}
          </div>
          {mode === "build" ? (
            <div className="stage-caption">
              <span>Music writes the atmosphere.</span>
              <span>BASS / LIGHT · MIDS / FOG · HIGHS / EMBERS</span>
            </div>
          ) : null}
        </section>
        {mode === "build" && selected ? (
          <Inspector
            design={selected}
            param={param}
            renaming={renaming}
            onParam={setParam}
            onRename={(name) => {
              setRenaming(false);
              if (name.trim()) update(selected.id, { name: name.trim() });
            }}
            onCancelRename={() => setRenaming(false)}
            onChange={(patch) => update(selected.id, patch)}
            onCapture={() => void capture(selected)}
          />
        ) : null}
      </main>

      <div className="transport" id="party-controls" aria-label="Music and visual controls">
        <div className="music-source">
          <div className="source-switch" role="group" aria-label="Music source">
            <button aria-pressed={musicInput === "demo"} onClick={() => setMusicInput("demo")}>
              Demo
            </button>
            <button aria-pressed={musicInput === "live"} onClick={() => setMusicInput("live")}>
              Connected CDJs
            </button>
          </div>
          <span className="source-status" role="status">
            {inputState?.status ?? "Connecting…"}
          </span>
        </div>
        {musicInput === "live" ? (
          <div className="midi-controls" aria-label="Mixer MIDI controls">
            <span className={`signal-dot ${inputState?.midi.connected ? "active" : ""}`} />
            <span role="status">
              {midi.connected
                ? `DJM-A9 MIDI connected · ${midi.messages ? `${midi.lastControl.replaceAll(".", " ")} · ${midi.messages} messages` : "Listening for faders and knobs"}`
                : inputState?.midi.connected
                  ? "DJBooth mixer MIDI connected"
                  : midi.status === "blocked"
                    ? "Allow MIDI access in your browser’s site permissions, then retry."
                    : midi.status === "unsupported"
                      ? "Browser MIDI unavailable · use Chrome, Edge or Brave for USB controls."
                      : midi.status === "waiting"
                        ? "Waiting for DJM-A9 USB MIDI"
                        : midi.status === "connecting"
                          ? "Connecting mixer MIDI…"
                          : "Mixer MIDI disconnected"}
            </span>
            {!midi.connected && !inputState?.midi.connected && midi.status !== "unsupported" ? (
              <button onClick={() => void midi.connect()} disabled={midi.status === "connecting"}>
                {midi.status === "blocked" || midi.status === "error"
                  ? "Retry MIDI"
                  : "Enable MIDI"}
              </button>
            ) : null}
          </div>
        ) : null}
        {musicInput === "live" ? (
          <div className="connected-decks" aria-label="Connected CDJ status">
            {inputState?.decks.map((deck) => (
              <div className={`connected-deck ${deck.playing ? "playing" : ""}`} key={deck.player}>
                <strong>
                  <i aria-hidden="true" />
                  {deck.model} · {deck.player}
                </strong>
                <span title={deck.title ?? ""}>{deck.title ?? "No track loaded"}</span>
                <small>
                  {deck.bpm == null
                    ? "Ready"
                    : `${deck.playing ? "Playing" : "Paused"} · ${deck.bpm.toFixed(2)} BPM${deck.analyzed ? " · Beat grid linked" : ""}`}
                </small>
              </div>
            ))}
            {!inputState?.decks.length ? (
              <p>Waiting for decks on DJBooth’s Pro DJ Link connection.</p>
            ) : null}
          </div>
        ) : null}
        {mode === "play" ? (
          <div className="view-controls">
            <button aria-pressed={showDecks} onClick={() => setShowDecks((visible) => !visible)}>
              {showDecks ? "Hide decks" : "Show decks"}
            </button>
            <button onClick={() => setMode("build")}>Open visual editor</button>
            <button
              onClick={() => {
                const change = document.fullscreenElement
                  ? document.exitFullscreen()
                  : document.documentElement.requestFullscreen();
                void change.catch(() => flash("Fullscreen is unavailable in this browser"));
              }}
            >
              Toggle fullscreen
            </button>
            <a
              href={`http://${location.hostname}:4179/?assistant=0`}
              target="_blank"
              rel="noreferrer"
            >
              Library UI ↗
            </a>
            <a href="/decks.html" target="_blank" rel="noreferrer">
              Live decks UI ↗
            </a>
          </div>
        ) : null}
        {mode === "play" ? (
          <div
            className="video-controls-row deck-overlay-controls"
            aria-label="Deck overlay controls"
          >
            <label>
              Deck size {deckSize}%{" "}
              <input
                aria-label="Deck size"
                type="range"
                min="20"
                max="100"
                value={deckSize}
                onChange={(event) => setDeckSize(Number(event.target.value))}
              />
            </label>
            <label>
              Deck opacity {deckOpacity}%{" "}
              <input
                aria-label="Deck opacity"
                type="range"
                min="0"
                max="100"
                value={deckOpacity}
                onChange={(event) => setDeckOpacity(Number(event.target.value))}
              />
            </label>
          </div>
        ) : null}
        {mode === "play" ? (
          <SceneControls
            scene={playScene ?? staged?.scene ?? "pac-man"}
            onSelect={setPlayScene}
            previewActive={hud}
            capture={captureScene}
          />
        ) : null}
        {mode === "play" ? <div ref={setVideoControlsHost} /> : null}
        <div className="set-controls" aria-label="Halloween set controls">
          <button
            hidden={musicInput === "live"}
            onClick={() => {
              if (simulation?.running) simulator.current?.stop();
              else {
                setMode("play");
                setOverlay(null);
                void simulator.current?.start();
              }
            }}
          >
            {simulation?.running ? "Stop set" : "Play Halloween set"}
          </button>
          {musicInput === "demo" && simulation?.running ? (
            <button
              disabled={simulation.loading || simulation.transitioning}
              onClick={() => void simulator.current?.skip()}
            >
              Next track
            </button>
          ) : null}
          <span role="status" hidden={musicInput === "live"}>
            {simulation?.loading
              ? "Loading Halloween playlists…"
              : simulation?.running
                ? `${simulation.transitioning ? "Crossfading · " : ""}${simulation.index}/${simulation.count} · ${simulation.track?.artist ?? ""} — ${simulation.track?.title ?? ""}`
                : ""}
            {simulation?.error ? ` · ${simulation.error}` : ""}
          </span>
        </div>
        {musicInput === "demo" ? (
          <DeckBar
            decks={decks}
            onSearch={(deck) => {
              setSongDeck(deck);
              setOverlay("songs");
            }}
          />
        ) : null}
      </div>

      <TrackVideos
        decks={decks}
        readDecks={videoDecks}
        controlsHost={videoControlsHost}
        active={mode === "play"}
      />
      {toast && (mode === "build" || hud) ? <div className="toast">{toast}</div> : null}
      {error ? (
        <div className="error" role="status" onClick={() => setError("")}>
          {error}
        </div>
      ) : null}

      {overlay === "library" ? (
        <LibraryOverlay
          designs={designs}
          selectedId={selected?.id ?? null}
          liveId={live?.id ?? null}
          onPick={(id) => {
            setSelectedId(id);
            setOverlay(null);
          }}
          onClose={() => setOverlay(null)}
        />
      ) : null}
      {overlay === "scenes" ? (
        <ScenePicker onPick={createFromScene} onClose={() => setOverlay(null)} />
      ) : null}
      {overlay === "songs" ? (
        <SongSearch
          deck={songDeck}
          onPick={(track) => {
            setOverlay(null);
            decks[songDeck]!.load(track).catch((e: unknown) =>
              setError(`Could not play: ${String(e)}`),
            );
          }}
          onClose={() => setOverlay(null)}
        />
      ) : null}
      {overlay === "help" ? <HelpOverlay mode={mode} onClose={() => setOverlay(null)} /> : null}
    </div>
  );
}
