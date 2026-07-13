import { Check, CircleAlert, LoaderCircle, RotateCcw, Trash2, X } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

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
};

export type PromptActionResult = {
  summary?: string;
  details?: string[];
};

export type PromptDockProps = {
  /** Server-backed action history. Local submissions overlay it until an entry with the same ID arrives. */
  actions?: PromptAction[];
  disabled?: boolean;
  disabledReason?: string;
  playlistName?: string;
  suggestions?: string[];
  placeholder?: string;
  className?: string;
  /** Scope the global Mod+K focus shortcut while dialogs or other command surfaces are active. */
  globalShortcutEnabled?: boolean;
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
  disabled = false,
  disabledReason,
  playlistName,
  suggestions = DEFAULT_SUGGESTIONS,
  placeholder,
  className,
  globalShortcutEnabled = true,
  onSubmit,
  onCancel,
  onClear,
}: PromptDockProps) {
  const [prompt, setPrompt] = useState("");
  const [expanded, setExpanded] = useState(true);
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
        setExpanded(true);
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
    setExpanded(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  return (
    <aside
      className={`prompt-dock${expanded ? " is-expanded" : " is-collapsed"}${
        className ? ` ${className}` : ""
      }`}
      aria-label="Playlist prompt commands"
    >
      <header className="prompt-dock-header">
        <button
          className="prompt-dock-title"
          type="button"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
        >
          <span className="prompt-dock-mark" aria-hidden="true">
            ✦
          </span>
          <span>
            <strong>Playlist copilot</strong>
            <small>{playlistName ? `Editing ${playlistName}` : "Prompt your library"}</small>
          </span>
        </button>
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
          <button
            className="small-icon-button"
            type="button"
            onClick={() => setExpanded((current) => !current)}
            aria-label={expanded ? "Collapse prompt dock" : "Expand prompt dock"}
          >
            <span className="prompt-collapse-glyph" aria-hidden="true">
              {expanded ? "⌄" : "⌃"}
            </span>
          </button>
        </span>
      </header>

      {expanded ? (
        <div className="prompt-dock-body">
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
              <span>Changes appear here immediately, then reconcile with Rekordbox.</span>
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
                  ? (disabledReason ?? "Library writes unavailable")
                  : "Changes are backed up and verified"}
              </span>
              <span className="prompt-submit-wrap">
                <kbd>⌘↵</kbd>
                <button
                  className="primary-button"
                  type="submit"
                  disabled={disabled || !prompt.trim()}
                >
                  Run
                </button>
              </span>
            </div>
          </form>
        </div>
      ) : null}
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
        <strong>{action.prompt}</strong>
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
    </li>
  );
}

function labelForStatus(status: PromptActionStatus): string {
  switch (status) {
    case "optimistic":
      return "Applying locally…";
    case "pending":
      return "Writing and verifying…";
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
