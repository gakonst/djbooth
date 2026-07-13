import { Check, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type ContextMenuPoint = { x: number; y: number };

export type ContextMenuAction = {
  kind?: "action";
  id: string;
  label: string;
  icon?: React.ReactNode;
  shortcut?: string;
  disabled?: boolean;
  dangerous?: boolean;
  checked?: boolean;
  /** Visual affordance for an action which opens another picker/dialog. */
  expands?: boolean;
};

export type ContextMenuSeparator = {
  kind: "separator";
  id?: string;
};

export type ContextMenuHeading = {
  kind: "heading";
  id?: string;
  label: string;
};

export type ContextMenuEntry = ContextMenuAction | ContextMenuSeparator | ContextMenuHeading;

export type ContextMenuProps = {
  open: boolean;
  point: ContextMenuPoint;
  entries: ReadonlyArray<ContextMenuEntry>;
  ariaLabel?: string;
  returnFocus?: HTMLElement | null;
  onClose(): void;
  onSelect(action: ContextMenuAction): void;
};

/**
 * Portal-backed WAI-ARIA menu for track and playlist actions.
 *
 * Arrow keys, Home/End, typeahead, Enter/Space, Escape, outside clicks, viewport clamping, and
 * focus restoration are handled internally. Keep destructive confirmation in the selected action's
 * dialog rather than inside this transient menu.
 */
export function ContextMenu({
  open,
  point,
  entries,
  ariaLabel = "Actions",
  returnFocus,
  onClose,
  onSelect,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const typeaheadRef = useRef("");
  const typeaheadTimeoutRef = useRef<number | undefined>(undefined);
  const lifecycleRef = useRef({
    actions: [] as ReadonlyArray<ContextMenuAction>,
    onClose,
    returnFocus,
  });
  const [position, setPosition] = useState(point);
  const actions = useMemo(
    () =>
      entries.filter(
        (entry): entry is ContextMenuAction =>
          entry.kind !== "separator" && entry.kind !== "heading",
      ),
    [entries],
  );
  lifecycleRef.current = { actions, onClose, returnFocus };

  useLayoutEffect(() => {
    if (!open) return;
    setPosition(point);
    const menu = menuRef.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    const gutter = 8;
    setPosition({
      x: clamp(point.x, gutter, Math.max(gutter, window.innerWidth - bounds.width - gutter)),
      y: clamp(point.y, gutter, Math.max(gutter, window.innerHeight - bounds.height - gutter)),
    });
  }, [entries, open, point]);

  useEffect(() => {
    if (!open) return;
    const firstEnabled = lifecycleRef.current.actions.find((entry) => !entry.disabled);
    const frame = window.requestAnimationFrame(() => {
      (firstEnabled ? itemRefs.current.get(firstEnabled.id) : menuRef.current)?.focus();
    });

    const closeForPointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) lifecycleRef.current.onClose();
    };
    const closeForViewportChange = () => lifecycleRef.current.onClose();
    window.addEventListener("pointerdown", closeForPointer, true);
    window.addEventListener("resize", closeForViewportChange);
    window.addEventListener("scroll", closeForViewportChange, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", closeForPointer, true);
      window.removeEventListener("resize", closeForViewportChange);
      window.removeEventListener("scroll", closeForViewportChange, true);
      window.clearTimeout(typeaheadTimeoutRef.current);
      lifecycleRef.current.returnFocus?.focus({ preventScroll: true });
    };
  }, [open]);

  const focusAction = (direction: 1 | -1, boundary?: "first" | "last") => {
    const enabledActions = actions.filter((entry) => !entry.disabled);
    if (!enabledActions.length) return;
    const activeIndex = enabledActions.findIndex(
      (entry) => itemRefs.current.get(entry.id) === document.activeElement,
    );
    const nextIndex =
      boundary === "first"
        ? 0
        : boundary === "last"
          ? enabledActions.length - 1
          : (activeIndex + direction + enabledActions.length) % enabledActions.length;
    itemRefs.current.get(enabledActions[nextIndex]!.id)?.focus();
  };

  const handleTypeahead = (key: string) => {
    typeaheadRef.current += key.toLocaleLowerCase();
    window.clearTimeout(typeaheadTimeoutRef.current);
    typeaheadTimeoutRef.current = window.setTimeout(() => {
      typeaheadRef.current = "";
    }, 500);
    const match = actions.find(
      (entry) =>
        !entry.disabled && entry.label.toLocaleLowerCase().startsWith(typeaheadRef.current),
    );
    if (match) itemRefs.current.get(match.id)?.focus();
  };

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      tabIndex={-1}
      aria-label={ariaLabel}
      style={{ position: "fixed", left: position.x, top: position.y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        switch (event.key) {
          case "ArrowDown":
            event.preventDefault();
            focusAction(1);
            break;
          case "ArrowUp":
            event.preventDefault();
            focusAction(-1);
            break;
          case "Home":
            event.preventDefault();
            focusAction(1, "first");
            break;
          case "End":
            event.preventDefault();
            focusAction(-1, "last");
            break;
          case "Escape":
            event.preventDefault();
            onClose();
            break;
          case "Tab":
            onClose();
            break;
          default:
            if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
              handleTypeahead(event.key);
            }
        }
      }}
    >
      {entries.map((entry, index) => {
        if (entry.kind === "separator") {
          return (
            <div className="context-menu-separator" role="separator" key={entry.id ?? index} />
          );
        }
        if (entry.kind === "heading") {
          return (
            <div className="context-menu-heading" role="presentation" key={entry.id ?? index}>
              {entry.label}
            </div>
          );
        }
        return (
          <button
            ref={(node) => {
              if (node) itemRefs.current.set(entry.id, node);
              else itemRefs.current.delete(entry.id);
            }}
            className={`context-menu-item${entry.dangerous ? " is-dangerous" : ""}`}
            type="button"
            role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"}
            aria-checked={entry.checked}
            disabled={entry.disabled}
            key={entry.id}
            onClick={() => {
              if (entry.disabled) return;
              onSelect(entry);
              onClose();
            }}
          >
            <span className="context-menu-icon" aria-hidden="true">
              {entry.checked ? <Check size={13} /> : entry.icon}
            </span>
            <span className="context-menu-label">{entry.label}</span>
            {entry.shortcut ? <kbd className="context-menu-shortcut">{entry.shortcut}</kbd> : null}
            {entry.expands ? <ChevronRight className="context-menu-expands" size={13} /> : null}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

export type ContextMenuController<T> = {
  open: boolean;
  point: ContextMenuPoint;
  value: T | undefined;
  returnFocus: HTMLElement | null;
  openAt(point: ContextMenuPoint, value: T, returnFocus?: HTMLElement | null): void;
  openFromPointer(event: React.MouseEvent<HTMLElement>, value: T): void;
  openFromKeyboard(event: React.KeyboardEvent<HTMLElement>, value: T): void;
  close(): void;
  getTriggerProps(value: T): {
    "aria-haspopup": "menu";
    "aria-expanded": boolean;
    onContextMenu(event: React.MouseEvent<HTMLElement>): void;
    onKeyDown(event: React.KeyboardEvent<HTMLElement>): void;
  };
};

/** Controlled context-menu state which works with mouse, Shift+F10, and the ContextMenu key. */
export function useContextMenu<T>(): ContextMenuController<T> {
  const [state, setState] = useState<{
    open: boolean;
    point: ContextMenuPoint;
    value?: T;
    returnFocus: HTMLElement | null;
  }>({ open: false, point: { x: 0, y: 0 }, returnFocus: null });

  const openAt = useCallback(
    (point: ContextMenuPoint, value: T, returnFocus: HTMLElement | null = null) => {
      setState({ open: true, point, value, returnFocus });
    },
    [],
  );
  const openFromPointer = useCallback(
    (event: React.MouseEvent<HTMLElement>, value: T) => {
      event.preventDefault();
      event.stopPropagation();
      openAt({ x: event.clientX, y: event.clientY }, value, event.currentTarget);
    },
    [openAt],
  );
  const openFromKeyboard = useCallback(
    (event: React.KeyboardEvent<HTMLElement>, value: T) => {
      if (!(event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))) return;
      event.preventDefault();
      event.stopPropagation();
      const bounds = event.currentTarget.getBoundingClientRect();
      openAt(
        { x: bounds.left + Math.min(bounds.width, 32), y: bounds.bottom },
        value,
        event.currentTarget,
      );
    },
    [openAt],
  );
  const close = useCallback(() => setState((current) => ({ ...current, open: false })), []);
  const getTriggerProps = useCallback(
    (value: T) => ({
      "aria-haspopup": "menu" as const,
      "aria-expanded": state.open,
      onContextMenu: (event: React.MouseEvent<HTMLElement>) => openFromPointer(event, value),
      onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => openFromKeyboard(event, value),
    }),
    [openFromKeyboard, openFromPointer, state.open],
  );

  return {
    open: state.open,
    point: state.point,
    value: state.value,
    returnFocus: state.returnFocus,
    openAt,
    openFromPointer,
    openFromKeyboard,
    close,
    getTriggerProps,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
