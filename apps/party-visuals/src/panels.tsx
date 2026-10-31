import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { waveformBeat } from "../../dj-monitor/src/waveform-signal.js";
import { trackLabel, type LibraryTrack, type PreviewDeck } from "./decks.js";
import type { Mode } from "./App.js";
import { SCENE_DESCRIPTIONS, sceneInfo, type SceneId } from "./scenes.js";
import { INTROS, LOOK_PARAMS, THEMES, thumbUrl, type Design } from "./show.js";
import { SceneGallery, scenePreviewUrl } from "./scene-controls.js";

const wrap = (i: number, n: number) => ((i % n) + n) % n;
const clock = (seconds: number) =>
  Number.isFinite(seconds)
    ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`
    : "–:––";

function Thumb({ design }: { design: Design }) {
  const url = thumbUrl(design);
  return <img src={url ?? scenePreviewUrl(design.scene)} alt="" loading="lazy" />;
}

/** Keep the highlighted row or card in view while navigating with the keyboard. */
function useScrollIntoView(index: number, attribute = "data-index") {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[${attribute}="${index}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [index, attribute]);
  return list;
}

type Playlist = { id: string; name: string; type?: string; trackCount?: number | null };
const ALL_SONGS: Playlist = { id: "", name: "All songs" };
const PLAYLIST_KEY = "party-visuals.song-playlist";
const rememberedPlaylist = () => {
  try {
    return localStorage.getItem(PLAYLIST_KEY) ?? "";
  } catch {
    return "";
  }
};

export function LibraryOverlay({
  designs,
  selectedId,
  liveId,
  onPick,
  onClose,
}: {
  designs: Design[];
  selectedId: string | null;
  liveId: string | null;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const shown = designs.filter((d) =>
    `${d.name} ${sceneInfo(d.scene).label}`.toLowerCase().includes(query.toLowerCase()),
  );
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      designs.findIndex((d) => d.id === selectedId),
    ),
  );
  const columns = 4;
  const current = Math.min(index, Math.max(0, shown.length - 1));
  const grid = useScrollIntoView(current);
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    const moves: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: columns,
      ArrowUp: -columns,
    };
    if (event.key in moves && shown.length) {
      event.preventDefault();
      setIndex(wrap(current + moves[event.key]!, shown.length));
    } else if (event.key === "Enter" && shown[current]) onPick(shown[current].id);
    else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      onClose();
    }
  };
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet library">
        <input
          autoFocus
          placeholder="Search designs…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={onKey}
        />
        <div className="design-grid" ref={grid}>
          {shown.map((design, i) => (
            <button
              key={design.id}
              data-index={i}
              className={`design-card ${i === current ? "highlighted" : ""}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => onPick(design.id)}
            >
              <span className="thumb">
                <Thumb design={design} />
                {design.id === liveId ? <span className="live-pill">ON PLAY</span> : null}
              </span>
              <span className="card-name">{design.name}</span>
              <span className="card-meta">
                {i + 1} · {sceneInfo(design.scene).label}
              </span>
            </button>
          ))}
          {!shown.length ? <p className="empty">No designs match “{query}”.</p> : null}
        </div>
        <footer>
          <kbd>←↑↓→</kbd> move <kbd>⏎</kbd> open <kbd>Esc</kbd> close
        </footer>
      </div>
    </div>
  );
}

export function ScenePicker({
  onPick,
  onClose,
  selected,
}: {
  onPick: (scene: SceneId) => void;
  onClose: () => void;
  selected?: SceneId;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      className="overlay"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={dialog}
        className="sheet scene-gallery-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Choose a game or visual"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
          if (event.key === "Tab") {
            const buttons = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
            ];
            const first = buttons[0],
              last = buttons.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header className="scene-controls-heading">
          <div>
            <h2>Choose a game or visual</h2>
            <p>Explore the midnight collection.</p>
          </div>
          <button onClick={onClose} aria-label="Close scene gallery">
            ✕
          </button>
        </header>
        <SceneGallery selected={selected} onSelect={onPick} selectedLabel="Selected" />
      </div>
    </div>
  );
}

export function SongSearch({
  deck,
  onPick,
  onClose,
}: {
  deck: number;
  onPick: (track: LibraryTrack) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [tracks, setTracks] = useState<LibraryTrack[]>([]);
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState("Loading library…");
  const [playlists, setPlaylists] = useState<Playlist[]>([ALL_SONGS]);
  const [playlistId, setPlaylistId] = useState(rememberedPlaylist);
  const list = useScrollIntoView(index);
  const tabs = useScrollIntoView(
    playlists.findIndex((p) => p.id === playlistId),
    "data-tab",
  );
  useEffect(() => {
    fetch("/api/playlists")
      .then((r) => r.json() as Promise<{ items: Playlist[] }>)
      .then((data) => {
        const found = data.items
          .filter((p) => p.type === "playlist" && (p.trackCount ?? 0) > 0)
          .sort((a, b) => a.name.localeCompare(b.name));
        setPlaylists([ALL_SONGS, ...found]);
        // Default to the Halloween set until a playlist has been chosen.
        setPlaylistId(
          (current) => current || (found.find((p) => p.name === "halloween-end")?.id ?? ""),
        );
      })
      .catch(() => {});
  }, []);
  const choosePlaylist = (id: string) => {
    setPlaylistId(id);
    setIndex(0);
    try {
      localStorage.setItem(PLAYLIST_KEY, id);
    } catch {
      /* Remembering the tab is a convenience only. */
    }
  };
  useEffect(() => {
    const abort = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ limit: playlistId ? "500" : "40", filter: "analyzed" });
      if (playlistId) {
        params.set("playlistId", playlistId);
        params.set("sort", "position");
      }
      if (query.trim()) params.set("q", query.trim());
      fetch(`/api/tracks?${params}`, { signal: abort.signal })
        .then((r) => {
          if (!r.ok) throw new Error(`Library unavailable (${r.status})`);
          return r.json() as Promise<{ items: LibraryTrack[] }>;
        })
        .then((data) => {
          setTracks(data.items);
          setIndex(
            Math.max(
              0,
              data.items.findIndex((t) => t.fileExists),
            ),
          );
          setStatus(data.items.length ? "" : "No analyzed tracks match.");
        })
        .catch((e: unknown) => {
          if (!abort.signal.aborted) setStatus(`${String(e)} — is the workbench running on :4179?`);
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [query, playlistId]);
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (tracks.length)
        setIndex((i) => wrap(i + (event.key === "ArrowDown" ? 1 : -1), tracks.length));
    } else if (event.key === "Tab") {
      event.preventDefault();
      const at = playlists.findIndex((p) => p.id === playlistId);
      choosePlaylist(playlists[wrap(at + (event.shiftKey ? -1 : 1), playlists.length)]!.id);
    } else if (event.key === "Enter" && tracks[index]?.fileExists) onPick(tracks[index]);
    else if (event.key === "Escape") onClose();
  };
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet list-sheet songs">
        <h2>Load a song on deck {deck === 0 ? "A" : "B"}</h2>
        <div className="playlist-tabs" ref={tabs}>
          {playlists.map((playlist, i) => (
            <button
              key={playlist.id}
              data-tab={i}
              tabIndex={-1}
              aria-pressed={playlist.id === playlistId}
              onClick={() => choosePlaylist(playlist.id)}
            >
              {playlist.name}
              {playlist.trackCount ? <small>{playlist.trackCount}</small> : null}
            </button>
          ))}
        </div>
        <input
          autoFocus
          placeholder={`Search ${playlists.find((p) => p.id === playlistId)?.name ?? "library"}…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="song-list" ref={list}>
          {tracks.map((track, i) => (
            <button
              key={track.id}
              data-index={i}
              disabled={!track.fileExists}
              className={`list-row ${i === index ? "highlighted" : ""}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => onPick(track)}
            >
              <span className="song-title">{trackLabel(track)}</span>
              <span className="song-artist">{track.artist}</span>
              <small>
                {track.fileExists ? `${track.bpm?.toFixed(0) ?? "–"} BPM` : "file missing"}
              </small>
            </button>
          ))}
          {status ? <p className="empty">{status}</p> : null}
        </div>
        <footer>
          <kbd>Tab</kbd>/<kbd>⇧Tab</kbd> playlist <kbd>↑↓</kbd> song <kbd>⏎</kbd> load{" "}
          <kbd>Esc</kbd> close
        </footer>
      </div>
    </div>
  );
}

export function Inspector({
  design,
  param,
  renaming,
  onParam,
  onRename,
  onCancelRename,
  onChange,
  onCapture,
}: {
  design: Design;
  param: number;
  renaming: boolean;
  onParam: (index: number) => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  onChange: (patch: Partial<Design>) => void;
  onCapture: () => void;
}) {
  const scene = sceneInfo(design.scene);
  const url = thumbUrl(design);
  const [pickingScene, setPickingScene] = useState(false);
  return (
    <aside className="inspector">
      <div className="inspector-head">
        <span className="inspector-thumb">
          <img src={url ?? scenePreviewUrl(design.scene)} alt="" />
        </span>
        {renaming ? (
          <input
            autoFocus
            className="rename"
            defaultValue={design.name}
            maxLength={32}
            placeholder="Two or three words"
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === "Enter") onRename(e.currentTarget.value);
              if (e.key === "Escape") onCancelRename();
            }}
            onBlur={(e) => onRename(e.currentTarget.value)}
          />
        ) : (
          <h1>
            {design.name} <kbd>R</kbd>
          </h1>
        )}
      </div>

      <Field label="Scene" hint="[ ]">
        <button className="inspector-scene-button" onClick={() => setPickingScene(true)}>
          <img src={scenePreviewUrl(design.scene)} alt="" />
          <span>
            {scene.label}
            <small>Choose a game or visual</small>
          </span>
          <span aria-hidden="true">↗</span>
        </button>
      </Field>
      {pickingScene ? (
        <ScenePicker
          selected={design.scene}
          onPick={(next) => {
            onChange({ scene: next, thumbAt: undefined });
            setPickingScene(false);
          }}
          onClose={() => setPickingScene(false)}
        />
      ) : null}

      <p className="note">{SCENE_DESCRIPTIONS[design.scene]}</p>

      <Field label="Theme" hint="T">
        <div className="chips">
          {THEMES.map((theme) => (
            <button
              key={theme.value}
              disabled={!scene.looks || scene.themes === false}
              aria-pressed={design.look.theme === theme.value}
              onClick={() => onChange({ look: { ...design.look, theme: theme.value } })}
            >
              {theme.label}
            </button>
          ))}
        </div>
      </Field>

      {LOOK_PARAMS.map((spec, i) => (
        <div
          key={spec.key}
          className={`slider ${i === param ? "focused" : ""}`}
          onMouseDown={() => onParam(i)}
        >
          <span>
            <kbd>{i + 1}</kbd> {spec.label}
          </span>
          <input
            type="range"
            tabIndex={-1}
            min={0}
            max={spec.max}
            step={spec.max / 40}
            aria-label={spec.label}
            value={design.look[spec.key]}
            onChange={(e) =>
              onChange({ look: { ...design.look, [spec.key]: Number(e.target.value) } })
            }
          />
          <output>{design.look[spec.key].toFixed(2)}</output>
        </div>
      ))}
      {!scene.looks ? (
        <p className="note">These controls shape the atmospheric lighting around {scene.label}.</p>
      ) : null}

      <Field label="Intro" hint="I">
        <div className="chips">
          {INTROS.map((intro) => (
            <button
              key={intro}
              aria-pressed={design.intro === intro}
              onClick={() => onChange({ intro })}
            >
              {intro}
            </button>
          ))}
        </div>
      </Field>

      <div className="actions">
        <button onClick={onCapture}>
          Retake snippet <kbd>C</kbd>
        </button>
      </div>
      <p className="note">
        <kbd>⏎</kbd> send to Play · <kbd>D</kbd> duplicate · <kbd>N</kbd> new · <kbd>⌫⌫</kbd> delete
      </p>
    </aside>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <span>
        {label} <kbd>{hint}</kbd>
      </span>
      {children}
    </div>
  );
}

/** Two rehearsal decks; refreshed on its own timer so the app does not re-render each beat. */
export function DeckBar({
  decks,
  onSearch,
}: {
  decks: PreviewDeck[];
  onSearch: (deck: number) => void;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 100);
    return () => clearInterval(timer);
  }, []);
  return (
    <footer className="deckbar">
      {decks.map((deck, i) => {
        const position = deck.audio.currentTime;
        const duration = deck.audio.duration;
        const beat = Math.floor(waveformBeat(deck.waveform, position, deck.sourceBpm));
        return (
          <div key={i} className={`deck ${deck.playing ? "playing" : ""}`}>
            <button className="deck-name" onClick={() => onSearch(i)}>
              <b>{i === 0 ? "A" : "B"}</b>
              <span>
                {deck.track ? trackLabel(deck.track) : "Load a song"}
                <small>{deck.track?.artist ?? (i === 0 ? "M" : "Shift M")}</small>
              </span>
            </button>
            <button className="deck-play" disabled={!deck.track} onClick={() => void deck.toggle()}>
              {deck.playing ? "❚❚" : "▶"}
            </button>
            <div className="beats" aria-label="Beat">
              {[0, 1, 2, 3].map((n) => (
                <i key={n} className={deck.playing && wrap(beat, 4) === n ? "on" : ""} />
              ))}
            </div>
            <div
              className="progress"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                deck.seek(((e.clientX - rect.left) / rect.width) * duration);
              }}
            >
              <span style={{ width: `${duration ? (position / duration) * 100 : 0}%` }} />
            </div>
            <span className="time">
              {clock(position)} / {clock(duration)} · {deck.track ? deck.bpm.toFixed(0) : "–"} BPM
            </span>
            <input
              type="range"
              aria-label={`Deck ${i === 0 ? "A" : "B"} fader`}
              tabIndex={-1}
              min={0}
              max={1}
              step={0.01}
              value={deck.fader}
              onChange={(e) => deck.setFader(Number(e.target.value))}
            />
          </div>
        );
      })}
      <span className="deck-hint">
        <kbd>Space</kbd>/<kbd>⇧Space</kbd> play · <kbd>X</kbd> crossfade · <kbd>,</kbd>
        <kbd>.</kbd> ±10s · <kbd>K</kbd> click
      </span>
    </footer>
  );
}

const SHORTCUTS: Record<Mode, [string, string][]> = {
  build: [
    ["V", "Show or hide live decks"],
    ["Tab", "Switch to Play"],
    ["L", "Design library"],
    ["↑ ↓", "Previous / next design"],
    ["⏎", "Send design to Play"],
    ["N", "New design from a scene"],
    ["D", "Duplicate design"],
    ["R", "Rename"],
    ["⌫ ⌫", "Delete design"],
    ["[ ]", "Change scene"],
    ["T", "Next theme"],
    ["I", "Next intro"],
    ["1–4", "Pick a slider"],
    ["← →", "Adjust slider (⇧ for bigger steps)"],
    ["C", "Retake snippet"],
    ["M / ⇧M", "Load song on deck A / B (Tab switches playlist)"],
    ["Space / ⇧Space", "Play or pause deck A / B"],
    ["X", "Crossfade between decks"],
    ["K", "Click track: tick on every charted note"],
    [", .", "Deck A back / forward 10s"],
  ],
  play: [
    ["V", "Show or hide live decks"],
    ["Tab", "Back to Build"],
    ["← →", "Previous / next design"],
    ["1–9", "Jump to design"],
    ["B", "Blackout"],
    ["F", "Fullscreen"],
    ["H", "Operator hints on / off"],
    ["Space", "Play or pause deck A"],
    ["X", "Crossfade between decks"],
    ["K", "Click track: tick on every charted note"],
  ],
};

export function HelpOverlay({ mode, onClose }: { mode: Mode; onClose: () => void }) {
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="sheet help">
        <h2>{mode === "build" ? "Build" : "Play"} shortcuts</h2>
        <dl>
          {SHORTCUTS[mode].map(([keys, action]) => (
            <div key={keys}>
              <dt>
                <kbd>{keys}</kbd>
              </dt>
              <dd>{action}</dd>
            </div>
          ))}
        </dl>
        <footer>
          <kbd>?</kbd> or <kbd>Esc</kbd> to close
        </footer>
      </div>
    </div>
  );
}
