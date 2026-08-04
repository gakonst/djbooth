import { describe, expect, it, vi } from "vitest";

import {
  buildHotkeyPalette,
  eventMatchesHotkey,
  formatHotkey,
  parseHotkey,
  type HotkeyBinding,
} from "../src/client/useHotkeys.js";

describe("hotkey utilities", () => {
  it("parses portable modifiers and printable aliases", () => {
    expect(parseHotkey("mod+shift+k")).toEqual({
      key: "k",
      alt: false,
      control: false,
      meta: false,
      shift: true,
      mod: true,
    });
    expect(parseHotkey("?")).toMatchObject({ key: "?", shift: true });
  });

  it("matches Mod against the active platform with exact modifiers", () => {
    const macEvent = { key: "k", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };
    expect(eventMatchesHotkey(macEvent, "mod+k", "mac")).toBe(true);
    expect(eventMatchesHotkey(macEvent, "mod+k", "other")).toBe(false);
    expect(eventMatchesHotkey({ ...macEvent, shiftKey: true }, "mod+k", "mac")).toBe(false);
  });

  it("formats platform labels and groups searchable palette entries", () => {
    const bindings: HotkeyBinding[] = [
      {
        id: "player.toggle",
        label: "Play / pause",
        category: "Player",
        shortcut: "Space",
        handler: vi.fn(),
      },
      {
        id: "library.search",
        label: "Search tracks",
        category: "Library",
        shortcut: "mod+k",
        handler: vi.fn(),
      },
    ];

    expect(formatHotkey("mod+shift+k", "mac")).toBe("⇧⌘K");
    expect(formatHotkey("mod+shift+k", "other")).toBe("Ctrl + Shift + K");
    expect(buildHotkeyPalette(bindings, "pause", "mac")).toEqual([
      {
        category: "Player",
        items: [
          {
            id: "player.toggle",
            label: "Play / pause",
            category: "Player",
            shortcuts: ["Space"],
            disabled: false,
          },
        ],
      },
    ]);
  });
});
