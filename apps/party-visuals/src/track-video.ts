import type { LibraryTrack } from "./decks.js";
import { clipForTrack, isOriginalVideoMatch, VIDEO_CLIPS } from "./video-clips.js";
import type { DeckState } from "../../dj-monitor/src/types.js";

export type VideoDeck = {
  playing: boolean;
  fader: number;
  track: LibraryTrack | null;
  audio: { currentTime: number; playbackRate: number };
};

/** A USB's numeric ID alone must never select an unrelated local recording. */
export function verifiedLiveVideoTrack(
  deck: DeckState,
  track: LibraryTrack | null,
): LibraryTrack | null {
  const normalized = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();
  if (!track?.fileExists || String(deck.trackId) !== track.id || !deck.trackTitle) return null;
  if (
    normalized(deck.trackTitle) !== normalized(track.title) ||
    normalized(deck.trackArtist) !== normalized(track.artist)
  )
    return null;
  if (
    deck.trackLengthSec == null ||
    track.durationSeconds == null ||
    Math.abs(deck.trackLengthSec - track.durationSeconds) > 2
  )
    return null;
  return track;
}

export type LocalTrackVideo = {
  source: string;
  title: string;
  gain: number;
  deckIndex: number;
  trackId: string;
  clipId: string | null;
  exact: boolean;
};
export type CustomTrackVideo = { url: string; title: string; trackId: string };

/** Only audible, playing owners may present footage, including manually chosen clips. */
export function trackVideoCandidates(
  decks: ReadonlyArray<{ playing: boolean; fader: number; track: LibraryTrack | null }>,
  available: readonly string[],
  choice: string,
  custom: CustomTrackVideo | null,
): LocalTrackVideo[] {
  const candidates = new Map<string, LocalTrackVideo>();
  for (const [deckIndex, deck] of decks.entries()) {
    if (!deck.playing || !deck.track || !Number.isFinite(deck.fader) || deck.fader <= 0) continue;
    const matching = clipForTrack(deck.track);
    let source: string,
      title: string,
      clipId: string | null = null,
      exact = false;
    if (choice === "custom") {
      if (!custom || custom.trackId !== deck.track.id) continue;
      source = custom.url;
      title = custom.title;
    } else {
      const clip = choice === "auto" ? matching : VIDEO_CLIPS.find((item) => item.id === choice);
      if (!clip || clip.id !== matching?.id || !available.includes(clip.id)) continue;
      source = `/clips/${clip.id}.mp4`;
      title = clip.title;
      clipId = clip.id;
      exact = isOriginalVideoMatch(deck.track, clip);
    }
    const previous = candidates.get(source);
    candidates.set(source, {
      source,
      title,
      gain: Math.min(1, (previous?.gain ?? 0) + deck.fader),
      deckIndex: previous && previous.gain > deck.fader ? previous.deckIndex : deckIndex,
      trackId: previous && previous.gain > deck.fader ? previous.trackId : deck.track.id,
      clipId,
      exact: previous && previous.gain > deck.fader ? previous.exact : exact,
    });
  }
  return [...candidates.values()];
}
