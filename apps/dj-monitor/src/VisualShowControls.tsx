import { useEffect, useRef, useState } from "react";
import {
  initialVisualLook,
  defaultVisualShow,
  type VisualLook,
  type VisualShow,
  type VisualTheme,
} from "./visual-presets.js";
import "./visual-show.css";

const themes: { value: VisualTheme; label: string }[] = [
  { value: "halloween", label: "Halloween" },
  { value: "eighties", label: "80s" },
  { value: "y2k", label: "Y2K · Pop / R&B" },
  { value: "tech-house", label: "Tech house" },
];
const clock = (ms: number) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

export function VisualShowControls({ onLook }: { onLook: (look: VisualLook) => void }) {
  const visual = new URLSearchParams(location.search).get("visual");
  const [show, setShow] = useState<VisualShow>(defaultVisualShow);
  const [look, setLook] = useState<VisualLook>(() => initialVisualLook(visual));
  const [selected, setSelected] = useState(visual === "race" ? "eighties" : "halloween");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [index, setIndex] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [finished, setFinished] = useState(false);
  const timer = useRef({ index: 0, elapsed: 0, started: 0 });
  const latest = useRef({ show, onLook });
  latest.current = { show, onLook };

  useEffect(() => {
    const abort = new AbortController();
    void fetch("/api/visual-show", { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Load failed (${response.status})`);
        const data = (await response.json()) as VisualShow;
        if (data.version !== 1 || !Array.isArray(data.presets) || !Array.isArray(data.cues))
          throw new Error("Invalid visual show response");
        setShow(data);
        setFeedback("Saved sequence loaded. Playback is stopped.");
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted)
          setError(
            `${cause instanceof Error ? cause.message : "Load failed"}. Using editable defaults; these have not been saved.`,
          );
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, []);

  function apply(next: VisualLook, id: string) {
    setLook({ ...next });
    setSelected(id);
    latest.current.onLook(next);
  }
  function activate(nextIndex: number, start: boolean) {
    const cue = show.cues[nextIndex];
    const preset = show.presets.find((entry) => entry.id === cue?.presetId);
    if (!cue || !preset) return;
    timer.current = { index: nextIndex, elapsed: 0, started: performance.now() };
    setIndex(nextIndex);
    setElapsed(0);
    setFinished(false);
    setRunning(start);
    apply(preset.look, preset.id);
  }
  useEffect(() => {
    if (!running) return;
    const tick = () => {
      const current = latest.current.show;
      const state = timer.current;
      const now = performance.now();
      let passed = state.elapsed + now - state.started;
      let position = state.index;
      const cycle = current.cues.reduce((sum, cue) => sum + cue.minutes * 60000, 0);
      if (current.loop && cycle > 0) passed %= cycle;
      while (current.cues[position] && passed >= current.cues[position]!.minutes * 60000) {
        passed -= current.cues[position]!.minutes * 60000;
        if (position + 1 < current.cues.length) position++;
        else if (current.loop) position = 0;
        else {
          const finalPreset = current.presets.find(
            (preset) => preset.id === current.cues[position]?.presetId,
          );
          if (finalPreset) apply(finalPreset.look, finalPreset.id);
          state.index = position;
          state.elapsed = current.cues[position]!.minutes * 60000;
          setIndex(position);
          setElapsed(state.elapsed);
          setRunning(false);
          setFinished(true);
          return;
        }
      }
      if (position !== state.index) {
        const preset = current.presets.find(
          (entry) => entry.id === current.cues[position]?.presetId,
        );
        if (preset) apply(preset.look, preset.id);
        state.index = position;
        setIndex(position);
      }
      state.elapsed = passed;
      state.started = now;
      setElapsed(passed);
    };
    tick();
    const interval = window.setInterval(tick, 200);
    return () => window.clearInterval(interval);
  }, [running]);

  function edit(next: VisualShow) {
    setShow(next);
    setDirty(true);
    setFeedback("");
  }
  function editCues(cues: VisualShow["cues"]) {
    setRunning(false);
    setIndex(null);
    setElapsed(0);
    setFinished(false);
    edit({ ...show, cues });
  }
  function changeLook(next: VisualLook) {
    apply(next, selected);
  }
  async function save(snapshot = show) {
    setSaving(true);
    setError("");
    setFeedback("");
    try {
      const bootstrapResponse = await fetch("/api/bootstrap");
      if (!bootstrapResponse.ok)
        throw new Error(`Authorization failed (${bootstrapResponse.status})`);
      const bootstrap = (await bootstrapResponse.json()) as { csrfToken?: string };
      if (!bootstrap.csrfToken) throw new Error("Authorization token missing");
      const response = await fetch("/api/visual-show", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-djbooth-token": bootstrap.csrfToken },
        body: JSON.stringify(snapshot),
      });
      if (!response.ok)
        throw new Error(
          `Save failed (${response.status}): ${(await response.text()).slice(0, 200)}`,
        );
      if (latest.current.show === snapshot) {
        setDirty(false);
        setFeedback("Sequence and named looks saved.");
      } else setFeedback("Sequence snapshot saved; newer edits still need saving.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }
  const cue = index === null ? undefined : show.cues[index];
  const selectedPreset = show.presets.find((preset) => preset.id === selected);
  return (
    <aside className="visual-director" aria-label="Visual director">
      <div className="visual-director-status" aria-live="polite">
        <nav className="visual-scene-nav" aria-label="Visual scene">
          {[
            { label: "Stage", visual: "halloween", active: !visual || visual === "halloween" },
            { label: "Space race", visual: "race", active: visual === "race" },
          ].map((scene) => {
            const url = new URL(location.href);
            url.searchParams.set("visual", scene.visual);
            return (
              <a
                key={scene.visual}
                href={url.toString()}
                aria-current={scene.active ? "page" : undefined}
              >
                {scene.label}
              </a>
            );
          })}
        </nav>
        <span>{themes.find((theme) => theme.value === look.theme)?.label}</span>
        <span>
          {cue
            ? `${cue.label} · ${finished ? "Complete · holding" : running ? "Playing" : "Paused"} · ${clock(cue.minutes * 60000 - elapsed)}`
            : "Manual look · sequence stopped"}
        </span>
      </div>
      <details className="visual-show-controls">
        <summary>Visual director</summary>
        <div className="visual-show-body">
          <p className="visual-show-note">
            Save a look to keep it. Save the sequence after editing chapters. Editing chapters stops
            playback.
          </p>
          {error && (
            <p role="alert" className="visual-show-error">
              {error}
            </p>
          )}
          <p role="status">
            {loading ? "Loading saved sequence…" : feedback || (dirty ? "Unsaved changes" : "")}
          </p>
          <fieldset disabled={loading || saving}>
            <legend>Current look</legend>
            <div className="visual-preset-buttons">
              {show.presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  aria-pressed={selected === preset.id}
                  onClick={() => {
                    setRunning(false);
                    setIndex(null);
                    setFinished(false);
                    apply(preset.look, preset.id);
                  }}
                >
                  {preset.name}
                </button>
              ))}
            </div>
            <label>
              Theme
              <select
                value={look.theme}
                onChange={(event) =>
                  changeLook({ ...look, theme: event.target.value as VisualTheme })
                }
              >
                {themes.map((theme) => (
                  <option key={theme.value} value={theme.value}>
                    {theme.label}
                  </option>
                ))}
              </select>
            </label>
            {(
              [
                ["intensity", "Intensity", 0, 2],
                ["motion", visual === "race" ? "Speed" : "Motion", 0, 2],
                ["density", "Density", 0.1, 1],
                ["halloween", "Halloween", 0, 1],
              ] as const
            ).map(([key, label, min, max]) => (
              <label key={key}>
                {label}
                <output>{look[key].toFixed(2)}</output>
                <input
                  type="range"
                  min={min}
                  max={max}
                  step="0.05"
                  value={look[key]}
                  onChange={(event) => changeLook({ ...look, [key]: Number(event.target.value) })}
                />
              </label>
            ))}
            <label>
              New preset name
              <input
                value={name}
                maxLength={100}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <div className="visual-show-actions">
              <button
                type="button"
                disabled={!name.trim() || show.presets.length >= 64}
                onClick={() => {
                  const id = crypto.randomUUID();
                  const next = {
                    ...show,
                    presets: [...show.presets, { id, name: name.trim(), look: { ...look } }],
                  };
                  edit(next);
                  setSelected(id);
                  setName("");
                  void save(next);
                }}
              >
                Save new look
              </button>
              <button
                type="button"
                disabled={!selectedPreset}
                onClick={() => {
                  const next = {
                    ...show,
                    presets: show.presets.map((preset) =>
                      preset.id === selected ? { ...preset, look: { ...look } } : preset,
                    ),
                  };
                  edit(next);
                  void save(next);
                }}
              >
                Update “{selectedPreset?.name ?? "selected look"}”
              </button>
            </div>
          </fieldset>
          <fieldset disabled={loading}>
            <legend>Set chapters</legend>
            <ol className="visual-cues">
              {show.cues.map((entry, position) => (
                <li key={entry.id} aria-current={index === position ? "step" : undefined}>
                  <label>
                    Chapter {position + 1}
                    <input
                      value={entry.label}
                      maxLength={100}
                      onChange={(event) =>
                        editCues(
                          show.cues.map((item) =>
                            item.id === entry.id ? { ...item, label: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    Look
                    <select
                      value={entry.presetId}
                      onChange={(event) =>
                        editCues(
                          show.cues.map((item) =>
                            item.id === entry.id ? { ...item, presetId: event.target.value } : item,
                          ),
                        )
                      }
                    >
                      {show.presets.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Minutes
                    <input
                      type="number"
                      min="0.1"
                      max="240"
                      step="0.1"
                      value={entry.minutes}
                      onChange={(event) => {
                        const minutes = Number(event.target.value);
                        if (Number.isFinite(minutes) && minutes >= 0.1 && minutes <= 240)
                          editCues(
                            show.cues.map((item) =>
                              item.id === entry.id ? { ...item, minutes } : item,
                            ),
                          );
                      }}
                    />
                  </label>
                  <div className="visual-show-actions">
                    <button
                      type="button"
                      disabled={position === 0}
                      aria-label={`Move chapter ${position + 1} up`}
                      onClick={() => {
                        const cues = [...show.cues];
                        [cues[position - 1], cues[position]] = [
                          cues[position]!,
                          cues[position - 1]!,
                        ];
                        editCues(cues);
                      }}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={position === show.cues.length - 1}
                      aria-label={`Move chapter ${position + 1} down`}
                      onClick={() => {
                        const cues = [...show.cues];
                        [cues[position], cues[position + 1]] = [
                          cues[position + 1]!,
                          cues[position]!,
                        ];
                        editCues(cues);
                      }}
                    >
                      ↓
                    </button>
                    <button type="button" onClick={() => activate(position, running)}>
                      Apply chapter {position + 1}
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove chapter ${position + 1}`}
                      onClick={() => editCues(show.cues.filter((item) => item.id !== entry.id))}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ol>
            <button
              type="button"
              disabled={!show.presets.length || show.cues.length >= 128}
              onClick={() =>
                editCues([
                  ...show.cues,
                  {
                    id: crypto.randomUUID(),
                    label: "New chapter",
                    presetId: show.presets[0]!.id,
                    minutes: 30,
                  },
                ])
              }
            >
              Add chapter
            </button>
            <label className="visual-loop">
              <input
                type="checkbox"
                checked={show.loop}
                onChange={(event) => edit({ ...show, loop: event.target.checked })}
              />
              Loop sequence
            </label>
            <div className="visual-show-actions">
              <button type="button" disabled={!show.cues.length} onClick={() => activate(0, true)}>
                Start sequence
              </button>
              <button
                type="button"
                disabled={index === null || finished}
                onClick={() => {
                  if (running) {
                    timer.current.elapsed += performance.now() - timer.current.started;
                    setElapsed(timer.current.elapsed);
                    setRunning(false);
                  } else {
                    timer.current.started = performance.now();
                    setRunning(true);
                  }
                }}
              >
                {running ? "Pause" : "Resume"}
              </button>
              <button
                type="button"
                disabled={index === null || index === 0}
                onClick={() => activate(index! - 1, running)}
              >
                Previous
              </button>
              <button
                type="button"
                disabled={index === null || index >= show.cues.length - 1}
                onClick={() => activate(index! + 1, running)}
              >
                Next
              </button>
            </div>
          </fieldset>
          <button
            className="visual-save"
            type="button"
            disabled={loading || saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save sequence & looks"}
          </button>
        </div>
      </details>
    </aside>
  );
}
