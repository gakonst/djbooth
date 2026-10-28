import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_VISUAL_LOOK } from "../../dj-monitor/src/visual-presets.js";
import { previewDecks } from "./decks.js";
import { DeckBar, HelpOverlay, Inspector, LibraryOverlay, ScenePicker, SongSearch } from "./panels.js";
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
import { createStage, type Stage } from "./stage.js";

export type Mode = "build" | "play";
type Overlay = "library" | "songs" | "scenes" | "help" | null;

const wrap = (i: number, n: number) => ((i % n) + n) % n;
const typing = (target: EventTarget | null) =>
  target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

export function App() {
  const decks = useMemo(() => previewDecks(), []);
  const stageRef = useRef<HTMLDivElement>(null);
  const stage = useRef<Stage>(undefined);
  const [show, setShow] = useState<Show | null>(null);
  const [mode, setMode] = useState<Mode>(() => (location.hash === "#play" ? "play" : "build"));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [songDeck, setSongDeck] = useState(0);
  const [param, setParam] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [armedDelete, setArmedDelete] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [blackout, setBlackout] = useState(false);
  const [hud, setHud] = useState(false);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [sceneStatus, setSceneStatus] = useState("");

  const designs = show?.designs ?? [];
  const selected = designs.find((d) => d.id === selectedId) ?? designs[0];
  const live = designs.find((d) => d.id === show?.liveId) ?? designs[0];
  const staged = mode === "build" ? selected : live;

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
    if (staged) void stage.current?.show(staged);
  }, [staged]);
  useEffect(() => setError(""), [staged?.id, staged?.scene]);

  // What a music-driven scene is reading from the song, shown while building.
  useEffect(() => {
    if (mode !== "build") return;
    const timer = setInterval(() => setSceneStatus(stage.current?.status() ?? ""), 250);
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
    setShow((s) =>
      s && {
        ...s,
        designs: s.designs.map((d) => (d.id === id ? { ...d, ...patch, updatedAt: Date.now() } : d)),
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

  const capture = useCallback(
    async (design: Design) => {
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
    },
    [],
  );

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

    // Shared transport keys: rehearse with the music in either mode.
    if (key === " ") {
      handled();
      return void decks[event.shiftKey ? 1 : 0]?.toggle();
    }
    if (key === "x" || key === "X") return crossfade();
    if (key === "," || key === ".") {
      const deck = decks[0]!;
      return deck.seek(deck.audio.currentTime + (key === "," ? -10 : 10));
    }

    if (mode === "play") {
      if (key === "ArrowRight" || key === "ArrowDown") return stepLive(1);
      if (key === "ArrowLeft" || key === "ArrowUp") return stepLive(-1);
      if (/^[1-9]$/u.test(key)) {
        const target = designs[Number(key) - 1];
        if (target) {
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
      if (!sceneInfo(selected.scene).looks) return flash("This scene has no settings yet");
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
      if (sceneInfo(selected.scene).themes === false) return flash("This scene has its own colours");
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
    <div className={`app ${mode}`}>
      {mode === "build" && selected ? (
        <header className="topbar">
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
        </header>
      ) : null}

      <main className="workspace">
        <section className="stage-frame">
          <div className="stage">
            <div className="stage-canvas" ref={stageRef} />
            {mode === "build" && live && selected ? (
              <span className={`stage-badge ${live.id === selected.id ? "live" : ""}`}>
                {live.id === selected.id ? "ON PLAY" : `Play shows “${live.name}” · ⏎ to send this`}
              </span>
            ) : null}
            {mode === "build" && sceneStatus ? <span className="stage-status">{sceneStatus}</span> : null}
          </div>
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

      {mode === "build" ? <DeckBar decks={decks} onSearch={(deck) => {
        setSongDeck(deck);
        setOverlay("songs");
      }} /> : null}

      {mode === "play" && hud && live ? (
        <div className="play-hud">
          {designs.indexOf(live) + 1}/{designs.length} · {live.name}
          {blackout ? " · BLACKOUT" : ""}
        </div>
      ) : null}
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
            decks[songDeck]!.load(track).catch((e: unknown) => setError(`Could not play: ${String(e)}`));
          }}
          onClose={() => setOverlay(null)}
        />
      ) : null}
      {overlay === "help" ? <HelpOverlay mode={mode} onClose={() => setOverlay(null)} /> : null}
    </div>
  );
}
