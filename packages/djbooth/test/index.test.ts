import { describe, expect, test } from "vitest";

import { library, rekordbox, slsk, soundcloud, spots, tracks, usb, ytdlp } from "../src/index.js";
import * as librarySubpath from "../src/library.js";
import * as rekordboxSubpath from "../src/rekordbox.js";
import * as slskSubpath from "../src/slsk.js";
import * as soundcloudSubpath from "../src/soundcloud.js";
import * as spotsSubpath from "../src/spots.js";
import * as tracksSubpath from "../src/tracks.js";
import * as usbSubpath from "../src/usb.js";
import * as ytdlpSubpath from "../src/ytdlp.js";

describe("umbrella exports", () => {
  test("exposes collision-free package namespaces", () => {
    expect(tracks.identify).toBeTypeOf("function");
    expect(spots.SpotifyClient).toBeTypeOf("function");
    expect(soundcloud.SoundCloudClient).toBeTypeOf("function");
    expect(soundcloud.FileSessionStore).toBeTypeOf("function");
    expect(slsk.SoulseekClient).toBeTypeOf("function");
    expect(ytdlp.ReferenceClient).toBeTypeOf("function");
    expect(rekordbox.MasterDatabase).toBeTypeOf("function");
    expect(library.RekordboxLibraryService).toBeTypeOf("function");
    expect(library.LibraryMutationConflictError).toBeTypeOf("function");
    expect(usb.statusCdjUsb).toBeTypeOf("function");
  });

  test("re-exports each package through its dedicated subpath module", () => {
    expect(tracksSubpath.identify).toBe(tracks.identify);
    expect(spotsSubpath.SpotifyClient).toBe(spots.SpotifyClient);
    expect(soundcloudSubpath.SoundCloudClient).toBe(soundcloud.SoundCloudClient);
    expect(soundcloudSubpath.FileSessionStore).toBe(soundcloud.FileSessionStore);
    expect(slskSubpath.SoulseekClient).toBe(slsk.SoulseekClient);
    expect(ytdlpSubpath.ReferenceClient).toBe(ytdlp.ReferenceClient);
    expect(rekordboxSubpath.MasterDatabase).toBe(rekordbox.MasterDatabase);
    expect(librarySubpath.RekordboxLibraryService).toBe(library.RekordboxLibraryService);
    expect(librarySubpath.LibraryMutationConflictError).toBe(library.LibraryMutationConflictError);
    expect(usbSubpath.statusCdjUsb).toBe(usb.statusCdjUsb);
  });
});
