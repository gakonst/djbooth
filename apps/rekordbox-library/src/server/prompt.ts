import type {
  HotCueSlot,
  PlaylistItem,
  PromptAction,
  PromptContext,
  PromptPlan,
  TrackCueInput,
} from "../shared/types.js";

type PlaylistResolution = {
  id: string;
  name: string;
};

const LEVENSHTEIN_THRESHOLD = 0.7;

/** Plan a bounded library command locally without invoking a model or mutating the library. */
export function planLibraryPrompt(
  prompt: string,
  context: PromptContext,
  playlists: readonly PlaylistItem[],
): PromptPlan {
  const input = prompt.trim();
  if (!input) throw new TypeError("Enter a library command.");

  if (/^(?:please\s+)?create\s+(?:a\s+)?playlist(?:\s+(?:named|called))?\s*$/i.test(input)) {
    throw new TypeError("Give the new playlist a name.");
  }

  const createMatch = input.match(
    /^(?:please\s+)?create\s+(?:a\s+)?playlist(?:\s+(?:named|called))?\s+(.+)$/i,
  );
  if (createMatch) {
    const name = requiredValue(createMatch[1], "Give the new playlist a name.");
    return makePlan(input, `Create playlist “${name}”`, [
      {
        type: "mutate",
        mutation: { type: "create-playlist", name },
        label: `Create playlist “${name}”`,
      },
    ]);
  }

  const renameMatch = input.match(
    /^(?:please\s+)?rename\s+(?:(?:the\s+)?(?:current|this)\s+)?playlist(?:\s+(?:to|as))?\s+(.+)$/i,
  );
  if (renameMatch) {
    const playlistId = requirePlaylistContext(context);
    const name = requiredValue(renameMatch[1], "Give the playlist a new name.");
    return makePlan(input, `Rename the current playlist to “${name}”`, [
      {
        type: "mutate",
        mutation: { type: "rename-playlist", playlistId, name },
        label: `Rename current playlist to “${name}”`,
      },
    ]);
  }
  if (
    /^(?:please\s+)?rename\s+(?:(?:the\s+)?(?:current|this)\s+)?playlist(?:\s+(?:to|as))?\s*$/i.test(
      input,
    )
  ) {
    requirePlaylistContext(context);
    throw new TypeError("Give the playlist a new name.");
  }

  const addMatch = input.match(
    /^(?:please\s+)?add\s+(?:(?:the\s+)?(?:current|selected|this)\s+)?track(?:\s+to(?:\s+(?:the\s+)?)?)?(.*)$/i,
  );
  if (addMatch) {
    const contentId = requireTrackContext(context);
    const target = resolveAddTarget(addMatch[1] ?? "", context, playlists);
    return makePlan(input, `Add the current track to “${target.name}”`, [
      {
        type: "mutate",
        mutation: { type: "add-track", playlistId: target.id, contentId },
        label: `Add current track to “${target.name}”`,
      },
    ]);
  }

  const removeMatch = input.match(
    /^(?:please\s+)?remove\s+(?:(?:the\s+)?(?:current|selected|this)\s+)?track\s+from\s+(?:(?:the\s+)?(?:current|this)\s+)?playlist$/i,
  );
  if (removeMatch) {
    requireTrackContext(context);
    requirePlaylistContext(context);
    throw new TypeError(
      "Removing the current track needs its playlist membership ID. Use the track context menu’s “Remove from playlist” action.",
    );
  }

  const hotCueMatch = input.match(
    /^(?:please\s+)?set\s+(?:a\s+)?hot\s*cue\s+([a-p])(?:\s+(?:at\s+)?(.+))?$/i,
  );
  if (hotCueMatch) {
    const contentId = requireTrackContext(context);
    const letter = hotCueMatch[1]?.toUpperCase();
    if (!letter) throw new TypeError("Choose a hot cue slot from A through P.");
    const slot = (letter.charCodeAt(0) - 64) as HotCueSlot;
    const startSeconds = resolveCueTime(hotCueMatch[2], context);
    const cue = cueInput("hot", startSeconds, slot);
    return makePlan(input, `Set hot cue ${letter} at ${formatTime(startSeconds)}`, [
      {
        type: "mutate",
        mutation: { type: "upsert-cue", contentId, cue },
        label: `Set hot cue ${letter} at ${formatTime(startSeconds)}`,
      },
    ]);
  }

  const memoryCueMatch = input.match(
    /^(?:please\s+)?set\s+(?:a\s+)?memory\s+cue(?:\s+(?:at\s+)?(.+))?$/i,
  );
  if (memoryCueMatch) {
    const contentId = requireTrackContext(context);
    const startSeconds = resolveCueTime(memoryCueMatch[1], context);
    const cue = cueInput("memory", startSeconds);
    return makePlan(input, `Set a memory cue at ${formatTime(startSeconds)}`, [
      {
        type: "mutate",
        mutation: { type: "upsert-cue", contentId, cue },
        label: `Set memory cue at ${formatTime(startSeconds)}`,
      },
    ]);
  }
  if (/^(?:please\s+)?set\s+(?:a\s+)?hot\s*cue(?:\s+.*)?$/i.test(input)) {
    throw new TypeError("Choose a hot cue slot from A through P.");
  }

  if (/^(?:please\s+)?(?:show|open|switch\s+to)\s+(?:(?:the|set)\s+)*canvas$/i.test(input)) {
    return makePlan(input, "Open the set canvas", [
      { type: "show-canvas", label: "Open set canvas" },
    ]);
  }

  const searchMatch = input.match(
    /^(?:please\s+)?(?:search|find)(?:\s+(?:the\s+)?(?:library|tracks?))?(?:\s+for)?\s+(.+)$/i,
  );
  if (searchMatch) {
    const query = requiredValue(searchMatch[1], "Give the track search a query.");
    return makePlan(input, `Search tracks for “${query}”`, [
      { type: "search-tracks", query, label: `Search for “${query}”` },
    ]);
  }
  if (
    /^(?:please\s+)?(?:search|find)(?:\s+(?:the\s+)?(?:library|tracks?))?(?:\s+for)?\s*$/i.test(
      input,
    )
  ) {
    throw new TypeError("Give the track search a query.");
  }

  if (
    /^(?:please\s+)?(?:open|show|select|go\s+to)\s+(?:(?:the\s+)?playlist(?:\s+(?:named|called))?)?\s*$/i.test(
      input,
    )
  ) {
    throw new TypeError("Name the playlist to open.");
  }

  const openMatch = input.match(
    /^(?:please\s+)?(?:open|show|select|go\s+to)\s+(?:(?:the\s+)?playlist(?:\s+(?:named|called))?\s+)?(.+)$/i,
  );
  if (openMatch) {
    const query = requiredValue(openMatch[1], "Name the playlist to open.");
    const playlist = resolvePlaylist(query, playlists, { writableOnly: false });
    return makePlan(input, `Open playlist “${playlist.name}”`, [
      {
        type: "open-playlist",
        playlistId: playlist.id,
        label: `Open “${playlist.name}”`,
      },
    ]);
  }

  throw new TypeError(
    "Command not understood. Try create/open/rename playlist, search tracks, add the current track, set a memory or hot cue, or open canvas.",
  );
}

function cueInput(kind: "memory", startSeconds: number): TrackCueInput;
function cueInput(kind: "hot", startSeconds: number, slot: HotCueSlot): TrackCueInput;
function cueInput(kind: "memory" | "hot", startSeconds: number, slot?: HotCueSlot): TrackCueInput {
  const common = {
    type: "cue",
    startSeconds,
    endSeconds: null,
    activeLoop: false,
    comment: "",
    color: null,
    colorTableIndex: null,
  } as const;
  if (kind === "hot") {
    if (slot === undefined) throw new TypeError("Choose a hot cue slot from A through P.");
    return { ...common, kind, slot };
  }
  return { ...common, kind };
}

function resolveAddTarget(
  rawTarget: string,
  context: PromptContext,
  playlists: readonly PlaylistItem[],
): PlaylistResolution {
  const target = rawTarget
    .trim()
    .replace(/^(?:the\s+)?playlist(?:\s+(?:named|called))?\s+/i, "")
    .trim();
  if (!target || /^(?:(?:the\s+)?(?:current|this)\s+playlist)$/i.test(target)) {
    const playlistId = requirePlaylistContext(context);
    const playlist = playlists.find((item) => item.id === playlistId);
    if (!playlist) {
      throw new TypeError("The current playlist no longer exists. Open a playlist and try again.");
    }
    if (playlist.type !== "playlist") {
      throw new TypeError("The current selection is not a writable playlist.");
    }
    return { id: playlistId, name: playlist.name };
  }
  return resolvePlaylist(target, playlists, { writableOnly: true });
}

function resolvePlaylist(
  rawQuery: string,
  playlists: readonly PlaylistItem[],
  options: { writableOnly: boolean },
): PlaylistResolution {
  const query = unquote(rawQuery);
  if (!query) throw new TypeError("Name the playlist.");
  const candidates = playlists.filter((playlist) =>
    options.writableOnly ? playlist.type === "playlist" : playlist.type !== "folder",
  );
  const normalizedQuery = normalizeName(query);
  if (!normalizedQuery) throw new TypeError("Name the playlist.");

  const exact = candidates.filter((playlist) => normalizeName(playlist.name) === normalizedQuery);
  if (exact.length === 1) return playlistResult(exact[0]);
  if (exact.length > 1) throw ambiguousPlaylist(query, exact);

  const contained = candidates.filter((playlist) => {
    const name = normalizeName(playlist.name);
    return name.includes(normalizedQuery) || normalizedQuery.includes(name);
  });
  if (contained.length === 1) return playlistResult(contained[0]);
  if (contained.length > 1) {
    const resolved = uniqueBest(scorePlaylists(normalizedQuery, contained));
    if (resolved) return playlistResult(resolved);
    throw ambiguousPlaylist(query, contained);
  }

  const scored = scorePlaylists(normalizedQuery, candidates)
    .filter(({ score }) => score >= LEVENSHTEIN_THRESHOLD)
    .sort(
      (left, right) => right.score - left.score || comparePlaylists(left.playlist, right.playlist),
    );
  if (scored.length === 0) {
    throw new TypeError(`No playlist matches “${query}”.`);
  }
  const bestScore = scored[0]?.score ?? 0;
  const best = scored.filter(({ score }) => bestScore - score < 0.04);
  if (best.length > 1) {
    throw ambiguousPlaylist(
      query,
      best.map(({ playlist }) => playlist),
    );
  }
  const resolved = scored[0]?.playlist;
  if (!resolved) throw new TypeError(`No playlist matches “${query}”.`);
  return playlistResult(resolved);
}

function scorePlaylists(normalizedQuery: string, playlists: readonly PlaylistItem[]) {
  return playlists
    .map((playlist) => ({
      playlist,
      score: similarity(normalizedQuery, normalizeName(playlist.name)),
    }))
    .sort(
      (left, right) => right.score - left.score || comparePlaylists(left.playlist, right.playlist),
    );
}

function uniqueBest(
  scored: readonly { playlist: PlaylistItem; score: number }[],
): PlaylistItem | null {
  const first = scored[0];
  if (!first) return null;
  const second = scored[1];
  return !second || first.score - second.score >= 0.04 ? first.playlist : null;
}

function ambiguousPlaylist(query: string, playlists: readonly PlaylistItem[]): TypeError {
  const labels = [...playlists]
    .sort(comparePlaylists)
    .slice(0, 5)
    .map((playlist) => `“${playlist.name}”`)
    .join(", ");
  return new TypeError(`Playlist “${query}” is ambiguous. Be more specific: ${labels}.`);
}

function comparePlaylists(left: PlaylistItem, right: PlaylistItem): number {
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

function playlistResult(playlist: PlaylistItem | undefined): PlaylistResolution {
  if (!playlist) throw new TypeError("Playlist not found.");
  return { id: playlist.id, name: playlist.name };
}

function requirePlaylistContext(context: PromptContext): string {
  if (!context.playlistId) {
    throw new TypeError("Open a playlist first, then run this command again.");
  }
  return context.playlistId;
}

function requireTrackContext(context: PromptContext): string {
  if (!context.trackId) {
    throw new TypeError("Select a track first, then run this command again.");
  }
  return context.trackId;
}

function resolveCueTime(rawTime: string | undefined, context: PromptContext): number {
  const value = rawTime?.trim();
  if (
    !value ||
    /^(?:here|now|(?:the\s+)?(?:current\s+)?playhead|current\s+position)$/i.test(value)
  ) {
    if (context.playheadSeconds === null) {
      throw new TypeError("Start the player or give a cue time, for example 1:23.");
    }
    return validSeconds(context.playheadSeconds);
  }

  const colon = value.match(/^(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d{1,3})?)$/);
  if (colon) {
    const hours = Number(colon[1] ?? 0);
    const minutes = Number(colon[2]);
    const seconds = Number(colon[3]);
    if (minutes >= 60 && colon[1] !== undefined) throw invalidCueTime(value);
    if (seconds >= 60) throw invalidCueTime(value);
    return validSeconds(hours * 3600 + minutes * 60 + seconds);
  }

  const minuteSecond = value.match(
    /^(?:(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes))?(?:\s*(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds))?$/i,
  );
  if (minuteSecond && (minuteSecond[1] !== undefined || minuteSecond[2] !== undefined)) {
    const minutes = Number(minuteSecond[1] ?? 0);
    const seconds = Number(minuteSecond[2] ?? 0);
    return validSeconds(minutes * 60 + seconds);
  }

  if (/^\d+(?:\.\d+)?$/.test(value)) return validSeconds(Number(value));
  throw invalidCueTime(value);
}

function invalidCueTime(value: string): TypeError {
  return new TypeError(`Invalid cue time “${value}”. Use seconds, M:SS, or H:MM:SS.`);
}

function validSeconds(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw invalidCueTime(String(value));
  return Math.round(value * 1000) / 1000;
}

function formatTime(seconds: number): string {
  const wholeMinutes = Math.floor(seconds / 60);
  const remaining = seconds - wholeMinutes * 60;
  const precision = Number.isInteger(remaining) ? 0 : Math.min(3, decimalPlaces(remaining));
  return `${String(wholeMinutes)}:${remaining
    .toFixed(precision)
    .padStart(precision ? 3 + precision : 2, "0")}`;
}

function decimalPlaces(value: number): number {
  const text = value.toFixed(3).replace(/0+$/, "");
  return text.includes(".") ? (text.split(".")[1]?.length ?? 0) : 0;
}

function requiredValue(value: string | undefined, message: string): string {
  const parsed = unquote(value ?? "");
  if (!parsed) throw new TypeError(message);
  return parsed;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed.at(-1);
  if (
    (first === '"' && last === '"') ||
    (first === "'" && last === "'") ||
    (first === "“" && last === "”")
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "");
}

function similarity(left: string, right: string): number {
  const longest = Math.max(left.length, right.length);
  return longest === 0 ? 1 : 1 - levenshtein(left, right) / longest;
}

function levenshtein(left: string, right: string): number {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1] ?? 0;
      const insertion = current[rightIndex - 1] ?? 0;
      const deletion = previous[rightIndex] ?? 0;
      current[rightIndex] =
        left[leftIndex - 1] === right[rightIndex - 1]
          ? substitution
          : Math.min(substitution, insertion, deletion) + 1;
    }
    previous = current;
  }
  return previous[right.length] ?? longestFallback(left, right);
}

function longestFallback(left: string, right: string): number {
  return Math.max(left.length, right.length);
}

function makePlan(prompt: string, summary: string, actions: PromptAction[]): PromptPlan {
  const seed = JSON.stringify({ prompt, summary, actions });
  return {
    id: `prompt-${fnv1a(seed).toString(16).padStart(8, "0")}`,
    prompt,
    summary,
    actions,
  };
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
