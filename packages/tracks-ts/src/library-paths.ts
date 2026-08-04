import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const DJBOOTH_LIBRARY_ROOT_ENV = "DJBOOTH_LIBRARY_ROOT";
export const MUSIC_LIBRARY_ROOT_ENV = "MUSIC_LIBRARY_ROOT";

export type CanonicalTrackPathOptions = {
  title: string;
  artists: readonly string[];
  album?: string;
  qualifier?: string;
  extension: string;
};

/** Return the shared recording root used by every end-to-end acquisition workflow. */
export function defaultTrackLibraryRoot(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  const configured =
    environment[DJBOOTH_LIBRARY_ROOT_ENV]?.trim() || environment[MUSIC_LIBRARY_ROOT_ENV]?.trim();
  if (!configured) return join(homeDirectory, ".djtools", "tracks");
  if (configured === "~") return homeDirectory;
  if (configured.startsWith("~/")) return resolve(homeDirectory, configured.slice(2));
  return resolve(configured);
}

/** Build one deterministic `<root>/<artist>/<album>/<title> [identity].ext` path. */
export function canonicalTrackPath(
  libraryRoot: string,
  options: CanonicalTrackPathOptions,
): string {
  if (!isAbsolute(libraryRoot)) {
    throw new TypeError(`libraryRoot must be absolute: ${libraryRoot}`);
  }
  if (!options.artists.length) throw new TypeError("Canonical track path requires an artist");
  const artist = filesystemSafe(options.artists.join(", "), "Unknown Artist");
  const album = filesystemSafe(options.album ?? "Singles", "Singles");
  const title = filesystemSafe(options.title, "Unknown Track");
  const qualifier = options.qualifier?.trim()
    ? ` [${filesystemSafe(options.qualifier, "recording")}]`
    : "";
  const extension = canonicalExtension(options.extension);
  return join(resolve(libraryRoot), artist, album, `${title}${qualifier}${extension}`);
}

export function filesystemSafe(value: string, fallback = "track"): string {
  const withoutControls = [
    ...latinize(value)
      .normalize("NFKD")
      .replaceAll(/[\u0300-\u036f]/gu, "")
      .replaceAll(/[^\x20-\x7e]/gu, " "),
  ]
    .map((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || code === 127 ? " " : character;
    })
    .join("");
  const safe = withoutControls
    .replaceAll(/[<>:"/\\|?*]+/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .replaceAll(/[. ]+$/gu, "")
    .trim();
  return (safe || fallback).slice(0, 180).replaceAll(/[. ]+$/gu, "");
}

export function latinize(value: string): string {
  return value
    .replaceAll(/[‘’]/gu, "'")
    .replaceAll(/[“”]/gu, '"')
    .replaceAll(/[ØÖ]/gu, "O")
    .replaceAll(/[øö]/gu, "o")
    .replaceAll(/[ĐÐ]/gu, "D")
    .replaceAll(/[đð]/gu, "d")
    .replaceAll(/Þ/gu, "Th")
    .replaceAll(/þ/gu, "th")
    .replaceAll(/Ł/gu, "L")
    .replaceAll(/ł/gu, "l")
    .replaceAll(/Æ/gu, "AE")
    .replaceAll(/æ/gu, "ae")
    .replaceAll(/Œ/gu, "OE")
    .replaceAll(/œ/gu, "oe")
    .replaceAll(/ß/gu, "ss");
}

function canonicalExtension(value: string): string {
  const extension = value.startsWith(".") ? value : `.${value}`;
  if (!/^\.[a-z\d]{1,10}$/iu.test(extension)) {
    throw new TypeError(`Invalid canonical track extension: ${value}`);
  }
  return extension.toLocaleLowerCase("en-US");
}
