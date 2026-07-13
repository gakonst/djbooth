import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LibrarySidebar } from "../src/client/components/LibrarySidebar.js";

describe("LibrarySidebar", () => {
  it("renders an unavailable smart-playlist count as an accessible warning", () => {
    const markup = renderToStaticMarkup(
      createElement(LibrarySidebar, {
        activeFilter: "all",
        items: [
          {
            countError: "Unsupported smart-playlist criterion: mixName",
            id: "smart-1",
            name: "Unsupported smart",
            parentId: "root",
            seq: 1,
            trackCount: null,
            type: "smart",
          },
        ],
        loading: false,
        onClose() {},
        onCreatePlaylist() {},
        onSelectFilter() {},
        onSelectPlaylist() {},
        open: true,
        selectedPlaylistId: null,
      }),
    );

    expect(markup).toContain("sidebar-count is-error");
    expect(markup).toContain(
      'aria-label="Track count unavailable: Unsupported smart-playlist criterion: mixName"',
    );
    expect(markup).toContain(">!</span>");
    expect(markup).not.toContain(">0</span>");
  });
});
