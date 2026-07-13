import { useEffect, useMemo, useRef, useState } from "react";

export type HotkeyPlatform = "mac" | "other";

export type HotkeyBinding = {
  id: string;
  label: string;
  description?: string;
  category?: string;
  /** One shortcut or equivalent alternatives, e.g. `"Space"` or `["mod+k", "?"]`. */
  shortcut: string | ReadonlyArray<string>;
  handler(event: KeyboardEvent): void;
  enabled?: boolean;
  allowInEditable?: boolean;
  allowRepeat?: boolean;
  preventDefault?: boolean;
  stopPropagation?: boolean;
  priority?: number;
  /** Evaluated when the key is pressed, allowing modal/scope-aware bindings. */
  when?(): boolean;
  /** Hide the binding from the command/keybinding palette without disabling it. */
  hideFromPalette?: boolean;
};

export type UseHotkeysOptions = {
  enabled?: boolean;
  target?: Window | Document | HTMLElement | null;
  capture?: boolean;
  platform?: HotkeyPlatform;
};

export type ParsedHotkey = {
  key: string;
  alt: boolean;
  control: boolean;
  meta: boolean;
  shift: boolean;
  mod: boolean;
};

export type HotkeyPaletteItem = {
  id: string;
  label: string;
  description?: string;
  category: string;
  shortcuts: ReadonlyArray<string>;
  disabled: boolean;
};

export type HotkeyPaletteGroup = {
  category: string;
  items: ReadonlyArray<HotkeyPaletteItem>;
};

/**
 * Registers conflict-aware global keybindings. Higher-priority bindings win; only one matching
 * handler runs. Editable controls are protected unless a binding explicitly opts in.
 */
export function useHotkeys(
  bindings: ReadonlyArray<HotkeyBinding>,
  options: UseHotkeysOptions = {},
): void {
  const bindingsRef = useRef(bindings);
  const optionsRef = useRef(options);
  bindingsRef.current = bindings;
  optionsRef.current = options;

  useEffect(() => {
    if (options.enabled === false) return;
    const target = options.target ?? window;
    if (!target) return;

    const onKeyDown = (event: Event) => {
      if (!(event instanceof KeyboardEvent)) return;
      if (event.defaultPrevented) return;
      const currentOptions = optionsRef.current;
      if (currentOptions.enabled === false) return;
      const platform = currentOptions.platform ?? detectHotkeyPlatform();
      const sortedBindings = [...bindingsRef.current].sort(
        (left, right) => (right.priority ?? 0) - (left.priority ?? 0),
      );

      for (const binding of sortedBindings) {
        if (binding.enabled === false || binding.when?.() === false) continue;
        if (event.repeat && !binding.allowRepeat) continue;
        if (!binding.allowInEditable && isEditableTarget(event.target)) continue;
        const shortcuts = Array.isArray(binding.shortcut) ? binding.shortcut : [binding.shortcut];
        if (!shortcuts.some((shortcut) => eventMatchesHotkey(event, shortcut, platform))) continue;

        if (binding.preventDefault !== false) event.preventDefault();
        if (binding.stopPropagation) event.stopPropagation();
        binding.handler(event);
        return;
      }
    };

    target.addEventListener("keydown", onKeyDown, { capture: options.capture });
    return () => target.removeEventListener("keydown", onKeyDown, { capture: options.capture });
  }, [options.capture, options.enabled, options.target]);
}

/** Parse a portable shortcut (`mod`, `ctrl`, `meta`, `alt`, `shift`, then one key). */
export function parseHotkey(shortcut: string): ParsedHotkey {
  const tokens = shortcut
    .split("+")
    .map((token) => token.trim().toLocaleLowerCase())
    .filter(Boolean);
  if (!tokens.length) throw new TypeError("Hotkey shortcut cannot be empty");

  const parsed: ParsedHotkey = {
    key: "",
    alt: false,
    control: false,
    meta: false,
    shift: false,
    mod: false,
  };
  for (const token of tokens) {
    switch (token) {
      case "alt":
      case "option":
      case "opt":
        parsed.alt = true;
        break;
      case "control":
      case "ctrl":
        parsed.control = true;
        break;
      case "command":
      case "cmd":
      case "meta":
        parsed.meta = true;
        break;
      case "shift":
        parsed.shift = true;
        break;
      case "mod":
        parsed.mod = true;
        break;
      default:
        if (parsed.key)
          throw new TypeError(`Hotkey '${shortcut}' has more than one non-modifier key`);
        parsed.key = normalizeKey(token);
        if (isShiftedPrintable(parsed.key)) parsed.shift = true;
    }
  }
  if (!parsed.key) throw new TypeError(`Hotkey '${shortcut}' is missing a non-modifier key`);
  return parsed;
}

export function eventMatchesHotkey(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">,
  shortcut: string,
  platform: HotkeyPlatform = detectHotkeyPlatform(),
): boolean {
  const parsed = parseHotkey(shortcut);
  const expectedMeta = parsed.meta || (parsed.mod && platform === "mac");
  const expectedControl = parsed.control || (parsed.mod && platform !== "mac");
  return (
    normalizeKey(event.key) === parsed.key &&
    event.altKey === parsed.alt &&
    event.ctrlKey === expectedControl &&
    event.metaKey === expectedMeta &&
    event.shiftKey === parsed.shift
  );
}

/** Human-readable shortcut using macOS glyphs or conventional modifier names. */
export function formatHotkey(
  shortcut: string,
  platform: HotkeyPlatform = detectHotkeyPlatform(),
): string {
  const parsed = parseHotkey(shortcut);
  if (platform === "mac") {
    return [
      parsed.control ? "⌃" : "",
      parsed.alt ? "⌥" : "",
      parsed.shift ? "⇧" : "",
      parsed.meta || parsed.mod ? "⌘" : "",
      displayKey(parsed.key),
    ].join("");
  }
  return [
    parsed.control || parsed.mod ? "Ctrl" : "",
    parsed.alt ? "Alt" : "",
    parsed.shift ? "Shift" : "",
    parsed.meta ? "Meta" : "",
    displayKey(parsed.key),
  ]
    .filter(Boolean)
    .join(" + ");
}

/** Build filtered, category-grouped data for a keybinding/command palette. */
export function buildHotkeyPalette(
  bindings: ReadonlyArray<HotkeyBinding>,
  query = "",
  platform: HotkeyPlatform = detectHotkeyPlatform(),
): ReadonlyArray<HotkeyPaletteGroup> {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const groups = new Map<string, HotkeyPaletteItem[]>();
  for (const binding of bindings) {
    if (binding.hideFromPalette) continue;
    const category = binding.category?.trim() || "General";
    const shortcuts = (Array.isArray(binding.shortcut) ? binding.shortcut : [binding.shortcut]).map(
      (shortcut) => formatHotkey(shortcut, platform),
    );
    const haystack = [binding.label, binding.description, category, ...shortcuts]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase();
    if (normalizedQuery && !haystack.includes(normalizedQuery)) continue;
    const item: HotkeyPaletteItem = {
      id: binding.id,
      label: binding.label,
      ...(binding.description ? { description: binding.description } : {}),
      category,
      shortcuts,
      disabled: binding.enabled === false,
    };
    const group = groups.get(category) ?? [];
    group.push(item);
    groups.set(category, group);
  }
  return [...groups].map(([category, items]) => ({ category, items }));
}

/** State/data helper; rendering remains with the host app's dialog/palette primitives. */
export function useHotkeyPalette(
  bindings: ReadonlyArray<HotkeyBinding>,
  options: { initiallyOpen?: boolean; platform?: HotkeyPlatform } = {},
) {
  const [open, setOpen] = useState(options.initiallyOpen ?? false);
  const [query, setQuery] = useState("");
  const groups = useMemo(
    () => buildHotkeyPalette(bindings, query, options.platform),
    [bindings, options.platform, query],
  );

  const close = () => {
    setOpen(false);
    setQuery("");
  };
  return {
    open,
    query,
    groups,
    setOpen,
    setQuery,
    openPalette: () => setOpen(true),
    close,
    toggle: () => {
      if (open) close();
      else setOpen(true);
    },
  };
}

export function detectHotkeyPlatform(): HotkeyPlatform {
  if (typeof navigator === "undefined") return "other";
  const navigatorWithHints = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform =
    navigatorWithHints.userAgentData?.platform ?? navigator.platform ?? navigator.userAgent;
  return /mac|iphone|ipad|ipod/iu.test(platform) ? "mac" : "other";
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined") return false;
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    Boolean(target.closest("[contenteditable='true'], [role='textbox']"))
  );
}

function normalizeKey(input: string): string {
  const key = input.toLocaleLowerCase();
  const aliases: Readonly<Record<string, string>> = {
    " ": "space",
    spacebar: "space",
    esc: "escape",
    return: "enter",
    left: "arrowleft",
    right: "arrowright",
    up: "arrowup",
    down: "arrowdown",
    slash: "/",
    question: "?",
    comma: ",",
    period: ".",
  };
  return aliases[key] ?? key;
}

function displayKey(key: string): string {
  const labels: Readonly<Record<string, string>> = {
    space: "Space",
    escape: "Esc",
    enter: "Enter",
    tab: "Tab",
    backspace: "Backspace",
    delete: "Delete",
    arrowleft: "←",
    arrowright: "→",
    arrowup: "↑",
    arrowdown: "↓",
  };
  return labels[key] ?? (key.length === 1 ? key.toLocaleUpperCase() : key);
}

function isShiftedPrintable(key: string): boolean {
  return '~!@#$%^&*()_+{}|:"<>?'.includes(key);
}
