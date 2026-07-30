import { AudioLines, Check, CircleAlert, LoaderCircle, RotateCcw, Trash2, X } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ProcessingJob } from "../../shared/types.js";

export type PromptActionStatus = "optimistic" | "pending" | "succeeded" | "failed";

export type PromptAction = {
  id: string;
  prompt: string;
  status: PromptActionStatus;
  summary?: string;
  details?: string[];
  error?: string;
  submittedAt: string;
  finishedAt?: string;
};

export type PromptSubmission = {
  id: string;
  prompt: string;
  submittedAt: string;
  report(summary: string): void;
};

export type PromptActionResult = {
  summary?: string;
  details?: string[];
};

export type PromptDockProps = {
  /** Server-backed action history. Local submissions overlay it until an entry with the same ID arrives. */
  actions?: PromptAction[];
  authLabel?: string;
  disabled?: boolean;
  disabledReason?: string;
  playlistName?: string;
  suggestions?: string[];
  placeholder?: string;
  className?: string;
  /** Scope the global Mod+K focus shortcut while dialogs or other command surfaces are active. */
  globalShortcutEnabled?: boolean;
  jobs?: ProcessingJob[];
  onAudition?(job: ProcessingJob): void;
  onSubmit(
    submission: PromptSubmission,
  ): void | PromptActionResult | Promise<void | PromptActionResult>;
  onCancel?(actionId: string): void;
  onClear?(): void;
};

const DEFAULT_SUGGESTIONS = [
  "Build a warm-up arc from these tracks",
  "Move the energy peak later",
  "Find a harmonic bridge for the selected tracks",
];

/** Prompt-first command surface with immediate, reconciled action state. */
export function PromptDock({
  actions = [],
  authLabel,
  disabled = false,
  disabledReason,
  playlistName,
  suggestions = DEFAULT_SUGGESTIONS,
  placeholder,
  className,
  globalShortcutEnabled = true,
  jobs = [],
  onAudition,
  onSubmit,
  onCancel,
  onClear,
}: PromptDockProps) {
  const [prompt, setPrompt] = useState("");
  const [localActions, setLocalActions] = useState<PromptAction[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (
        globalShortcutEnabled &&
        !event.defaultPrevented &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [globalShortcutEnabled]);

  useEffect(() => {
    if (actions.length === 0) return;
    const controlledIds = new Set(actions.map((action) => action.id));
    setLocalActions((current) => current.filter((action) => !controlledIds.has(action.id)));
  }, [actions]);

  const mergedActions = useMemo(() => {
    const controlledIds = new Set(actions.map((action) => action.id));
    return [...actions, ...localActions.filter((action) => !controlledIds.has(action.id))].sort(
      (left, right) => right.submittedAt.localeCompare(left.submittedAt),
    );
  }, [actions, localActions]);
  const activeActions = mergedActions.filter(
    (action) => action.status === "optimistic" || action.status === "pending",
  );

  const submitPrompt = async (event?: FormEvent) => {
    event?.preventDefault();
    const value = prompt.trim();
    if (!value || disabled) return;
    const submittedAt = new Date().toISOString();
    const submission: PromptSubmission = {
      id: createActionId(),
      prompt: value,
      submittedAt,
      report(summary) {
        setLocalAction(submission.id, { status: "pending", summary });
      },
    };
    setPrompt("");
    setHistory((current) => [value, ...current.filter((entry) => entry !== value)].slice(0, 30));
    setHistoryIndex(-1);
    setLocalActions((current) => [
      ...current,
      { ...submission, status: "optimistic", summary: "Applying changes locally…" },
    ]);

    await Promise.resolve();
    setLocalAction(submission.id, {
      status: "pending",
      summary: "Planning and applying library changes…",
    });
    try {
      const result = await onSubmit(submission);
      setLocalAction(submission.id, {
        status: "succeeded",
        summary: result?.summary ?? "Changes applied",
        details: result?.details,
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      setLocalAction(submission.id, {
        status: "failed",
        summary: "No changes were applied",
        error: error instanceof Error ? error.message : String(error),
        finishedAt: new Date().toISOString(),
      });
    }
  };

  const setLocalAction = (id: string, patch: Partial<PromptAction>) => {
    setLocalActions((current) =>
      current.map((action) => (action.id === id ? { ...action, ...patch } : action)),
    );
  };

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void submitPrompt();
      return;
    }
    if (event.key === "Escape") {
      event.currentTarget.blur();
      return;
    }
    if (event.key === "ArrowUp" && !prompt && history.length > 0) {
      event.preventDefault();
      const nextIndex = Math.min(history.length - 1, historyIndex + 1);
      setHistoryIndex(nextIndex);
      setPrompt(history[nextIndex] ?? "");
    } else if (event.key === "ArrowDown" && historyIndex >= 0) {
      event.preventDefault();
      const nextIndex = historyIndex - 1;
      setHistoryIndex(nextIndex);
      setPrompt(nextIndex >= 0 ? (history[nextIndex] ?? "") : "");
    }
  };

  const retry = (action: PromptAction) => {
    setPrompt(action.prompt);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  return (
    <aside
      className={`prompt-dock is-expanded${className ? ` ${className}` : ""}`}
      aria-label="Nanocodex assistant"
    >
      <header className="prompt-dock-header">
        <div className="prompt-dock-title">
          <span className="prompt-dock-mark" aria-hidden="true">
            ✦
          </span>
          <span>
            <strong>Nanocodex</strong>
            <small>
              Rust/WASM ·{" "}
              {authLabel ?? (playlistName ? `Working in ${playlistName}` : "Library agent")}
            </small>
          </span>
        </div>
        <span className="prompt-dock-header-actions">
          {activeActions.length ? (
            <span className="prompt-active-count" role="status">
              <LoaderCircle size={12} className="spin" /> {String(activeActions.length)} running
            </span>
          ) : null}
          {mergedActions.length ? (
            <button
              className="small-icon-button"
              type="button"
              onClick={() => {
                setLocalActions([]);
                onClear?.();
              }}
              aria-label="Clear prompt history"
              title="Clear history"
            >
              <Trash2 size={13} />
            </button>
          ) : null}
        </span>
      </header>

      <div className="prompt-dock-body">
        <div className="assistant-transcript">
          {mergedActions.length ? (
            <ol
              className="prompt-action-list"
              aria-label="Prompt action history"
              aria-live="polite"
            >
              {mergedActions.map((action) => (
                <PromptActionRow
                  key={action.id}
                  action={action}
                  {...(onCancel
                    ? {
                        onCancel: (actionId: string) => {
                          setLocalAction(actionId, {
                            status: "failed",
                            summary: "Command cancelled",
                            finishedAt: new Date().toISOString(),
                          });
                          onCancel(actionId);
                        },
                      }
                    : {})}
                  onRetry={retry}
                />
              ))}
            </ol>
          ) : (
            <div className="prompt-dock-empty">
              <strong>Describe the set you want.</strong>
              <span>Chat with your library, run analysis, or generate and audition stems.</span>
              <div className="prompt-suggestions" aria-label="Suggested prompts">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => {
                      setPrompt(suggestion);
                      inputRef.current?.focus();
                    }}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {jobs.length ? (
          <section className="assistant-jobs" aria-label="Background audio jobs">
            <header>
              <span>BACKGROUND WORK</span>
              <small>
                {String(
                  jobs.filter((job) => job.status === "running" || job.status === "queued").length,
                )}{" "}
                active
              </small>
            </header>
            {jobs.slice(0, 3).map((job) => (
              <article className={`assistant-job is-${job.status}`} key={job.id}>
                <span>
                  {job.status === "running" || job.status === "queued" ? (
                    <LoaderCircle size={12} className="spin" />
                  ) : (
                    <AudioLines size={12} />
                  )}
                </span>
                <div>
                  <strong>{job.trackTitle}</strong>
                  <small>{job.error ?? job.message ?? job.status}</small>
                </div>
                {job.status === "completed" &&
                job.operation === "stems" &&
                job.artifacts?.length &&
                onAudition ? (
                  <button type="button" onClick={() => onAudition(job)}>
                    Audition
                  </button>
                ) : null}
              </article>
            ))}
          </section>
        ) : null}

        <form className="prompt-composer" onSubmit={(event) => void submitPrompt(event)}>
          <label className="sr-only" htmlFor="playlist-prompt-input">
            Playlist command
          </label>
          <textarea
            ref={inputRef}
            id="playlist-prompt-input"
            rows={2}
            value={prompt}
            disabled={disabled}
            placeholder={
              placeholder ??
              (playlistName
                ? `Ask for changes to ${playlistName}…`
                : "Build a playlist, reorder tracks, or find a transition…")
            }
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={handleInputKeyDown}
          />
          <div className="prompt-composer-footer">
            <span className={`prompt-write-state${disabled ? " is-disabled" : ""}`}>
              {disabled
                ? (disabledReason ?? "Assistant unavailable")
                : "Nanocodex plans; typed tools execute locally"}
            </span>
            <span className="prompt-submit-wrap">
              <kbd>⌘↵</kbd>
              <button
                className="primary-button"
                type="submit"
                disabled={disabled || !prompt.trim()}
              >
                Send
              </button>
            </span>
          </div>
        </form>
      </div>
    </aside>
  );
}

function PromptActionRow({
  action,
  onCancel,
  onRetry,
}: {
  action: PromptAction;
  onCancel?: (actionId: string) => void;
  onRetry(action: PromptAction): void;
}) {
  const active = action.status === "optimistic" || action.status === "pending";
  return (
    <li className={`prompt-action prompt-action-${action.status}`}>
      <div className="assistant-message is-user">
        <span className="assistant-avatar">YOU</span>
        <p>{action.prompt}</p>
      </div>
      <div className="assistant-message is-assistant">
        <span className="prompt-action-status" aria-hidden="true">
          {active ? (
            <LoaderCircle size={14} className="spin" />
          ) : action.status === "succeeded" ? (
            <Check size={14} />
          ) : (
            <CircleAlert size={14} />
          )}
        </span>
        <span className="prompt-action-copy">
          <strong>Nanocodex</strong>
          <span>{action.error ?? action.summary ?? labelForStatus(action.status)}</span>
          {action.details?.length ? (
            <ul>
              {action.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          ) : null}
        </span>
        <span className="prompt-action-meta">
          <time dateTime={action.finishedAt ?? action.submittedAt}>
            {formatActionTime(action.finishedAt ?? action.submittedAt)}
          </time>
          {active && onCancel ? (
            <button
              className="small-icon-button"
              type="button"
              onClick={() => onCancel(action.id)}
              aria-label={`Cancel: ${action.prompt}`}
              title="Cancel"
            >
              <X size={12} />
            </button>
          ) : action.status === "failed" ? (
            <button
              className="small-icon-button"
              type="button"
              onClick={() => onRetry(action)}
              aria-label={`Retry: ${action.prompt}`}
              title="Retry"
            >
              <RotateCcw size={12} />
            </button>
          ) : null}
        </span>
      </div>
    </li>
  );
}

function labelForStatus(status: PromptActionStatus): string {
  switch (status) {
    case "optimistic":
      return "Applying locally…";
    case "pending":
      return "Saving in the background…";
    case "succeeded":
      return "Changes applied";
    case "failed":
      return "Command failed";
  }
}

function formatActionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

function createActionId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `prompt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
