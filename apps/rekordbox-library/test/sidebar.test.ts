import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LibrarySidebar } from "../src/client/components/LibrarySidebar.js";

describe("LibrarySidebar", () => {
  it("renders an unavailable smart-playlist count as an accessible warning", () => {
    const markup = renderToStaticMarkup(
      createElement(LibrarySidebar, {
        activeFilter: "all",
        canWrite: false,
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

  it("separates hosted providers and only offers split editing for writable playlists", () => {
    const markup = renderToStaticMarkup(
      createElement(LibrarySidebar, {
        activeFilter: "all",
        canWrite: true,
        items: [],
        hosted: {
          providers: [
            { provider: "spotify", connected: true, displayName: "georgegak" },
            { provider: "soundcloud", connected: true, displayName: "GAK" },
          ],
          items: [
            {
              id: "spotify:editable",
              name: "Editable mix",
              parentId: "spotify",
              seq: 0,
              trackCount: 20,
              type: "playlist",
              hosted: {
                provider: "spotify",
                remoteId: "editable",
                revision: "snapshot",
                externalUrl: "https://open.spotify.com/playlist/editable",
                owned: true,
                capabilities: {
                  itemsReadable: true,
                  detailsEditable: true,
                  itemsEditable: true,
                },
                downloadEnabled: true,
                syncState: "idle",
              },
            },
            {
              id: "spotify:locked",
              name: "Followed mix",
              parentId: "spotify",
              seq: 1,
              trackCount: null,
              type: "playlist",
              hosted: {
                provider: "spotify",
                remoteId: "locked",
                revision: null,
                externalUrl: null,
                owned: false,
                capabilities: {
                  itemsReadable: false,
                  detailsEditable: false,
                  itemsEditable: false,
                },
                downloadEnabled: false,
                syncState: "idle",
              },
            },
          ],
        },
        loading: false,
        onClose() {},
        onCreatePlaylist() {},
        onEditHostedPlaylist() {},
        onSelectFilter() {},
        onSelectHostedPlaylist() {},
        onSelectPlaylist() {},
        onToggleHostedDownload() {},
        open: true,
        selectedHostedPlaylistId: "spotify:editable",
        selectedPlaylistId: null,
      }),
    );

    expect(markup).toContain("Local / Rekordbox");
    expect(markup).toContain("Spotify");
    expect(markup).toContain("SoundCloud");
    expect(markup).toContain("Spotify connected as georgegak");
    expect(markup).toContain('aria-expanded="true" aria-controls="hosted-provider-spotify"');
    expect(markup).toContain('aria-expanded="false" aria-controls="hosted-provider-soundcloud"');
    expect(markup).toContain('aria-label="Stop keeping Editable mix downloaded"');
    expect(markup).toContain('aria-label="Edit Editable mix in split view"');
    expect(markup).toContain('aria-label="Playlist tracks unavailable"');
    expect(markup).not.toContain('aria-label="Edit Followed mix in split view"');
  });
});
