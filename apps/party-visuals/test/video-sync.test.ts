import assert from "node:assert/strict";
import { test } from "node:test";
import {
  alignedVideoTime,
  alignVideo,
  videoSyncAction,
  type AudioFingerprint,
} from "../src/video-sync.ts";
import { clipForTrack, isOriginalVideoMatch } from "../src/video-clips.ts";
import { trackVideoCandidates, verifiedLiveVideoTrack } from "../src/track-video.ts";
import { createBeatPulse } from "../src/music/beat-pulse.ts";
import type { DeckState } from "../../dj-monitor/src/types.ts";

test("a connected CDJ must match the local recording before its audio can align a video", () => {
  const track = {
    id: "mj",
    title: "Billie Jean",
    artist: "Michael Jackson",
    bpm: 117,
    durationSeconds: 294.15,
    fileExists: true,
  };
  const deck = {
    trackId: "mj",
    trackTitle: "Billie Jean",
    trackArtist: "Michael Jackson",
    trackLengthSec: 294,
  } as unknown as DeckState;
  assert.equal(verifiedLiveVideoTrack(deck, track), track);
  assert.equal(verifiedLiveVideoTrack({ ...deck, trackTitle: "Different song" }, track), null);
  assert.equal(verifiedLiveVideoTrack({ ...deck, trackLengthSec: 310 }, track), null);
  assert.equal(verifiedLiveVideoTrack({ ...deck, trackArtist: "Cover artist" }, track), null);
  assert.equal(verifiedLiveVideoTrack(deck, { ...track, fileExists: false }), null);
});

test("every scene receives a visible pulse on the actual beat and releases in silence", () => {
  const pulse = createBeatPulse();
  const onBeat = pulse.update(24, 0.5, 0.05, false);
  assert.ok(onBeat > 0.8);
  let offBeat = 0;
  for (let i = 0; i < 8; i++) offBeat = pulse.update(24.8, 0.5, 0.05, false);
  assert.ok(offBeat < 0.02);
  pulse.update(25, 0.5, 0.05, false);
  assert.equal(pulse.update(25.1, 0.5, 0.05, true), 0);
  pulse.update(26, 0.5, 0.05, false);
  for (let i = 0; i < 20; i++) offBeat = pulse.update(26, 0, 0.05, false);
  assert.ok(offBeat < 0.00001);
});

test("original Michael Jackson recordings request exact matching; remixes and other artists do not", () => {
  const original = { title: "Billie Jean", artist: "Michael Jackson" };
  const clip = clipForTrack(original)!;
  assert.equal(isOriginalVideoMatch(original, clip), true);
  assert.equal(
    isOriginalVideoMatch({ ...original, title: "Billie Jean (Club Remix)" }, clip),
    false,
  );
  assert.equal(isOriginalVideoMatch({ ...original, artist: "Different artist" }, clip), false);
  const track = { ...original, id: "mj", bpm: 117, durationSeconds: 294, fileExists: true };
  const candidates = trackVideoCandidates(
    [
      { playing: true, fader: 0.8, track },
      { playing: true, fader: 0.2, track: { ...track, id: "remix", title: "Billie Jean Remix" } },
    ],
    [clip.id],
    "auto",
    null,
  );
  assert.equal(candidates[0]!.trackId, "mj");
  assert.equal(candidates[0]!.exact, true);
  assert.equal(candidates[0]!.deckIndex, 0);
  assert.equal(
    trackVideoCandidates([{ playing: false, fader: 1, track }], [clip.id], "auto", null).length,
    0,
  );
});

test("audio matching finds an inserted video intro from actual content", () => {
  let seed = 73;
  const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const values = Array.from({ length: 48 * 20 * 3 }, random);
  const audio: AudioFingerprint = { rate: 20, duration: 48, values };
  const video: AudioFingerprint = {
    rate: 20,
    duration: 56,
    values: [...Array.from({ length: 8 * 20 * 3 }, random), ...values],
  };
  const alignment = alignVideo(audio, video);
  assert.ok(alignment.confidence > 0.99);
  assert.ok(alignment.anchors.length >= 5);
  assert.equal(alignedVideoTime(alignment, 17), 25);
});

test("video alignment handles drift but never stretches across unrelated film scenes", () => {
  const alignment = {
    confidence: 0.97,
    anchors: [
      { audio: 3, video: 3.3, confidence: 0.97 },
      { audio: 19, video: 19.36, confidence: 0.97 },
      { audio: 35, video: 35.42, confidence: 0.97 },
      { audio: 51, video: 151.42, confidence: 0.97 },
    ],
  };
  assert.ok(Math.abs(alignedVideoTime(alignment, 11)! - 11.33) < 1e-9);
  assert.equal(alignedVideoTime(alignment, 43), null);
  assert.equal(alignedVideoTime(alignment, 51), 151.42);
  assert.equal(alignedVideoTime(alignment, 100), null);
});

test("video clock seeks big jumps and nudges minor drift at the deck playback speed", () => {
  assert.equal(videoSyncAction(30, 2, 1.25, 100).seek, true);
  const fine = videoSyncAction(30, 29.97, 1.25, 100);
  assert.equal(fine.seek, false);
  assert.ok(fine.rate > 1.25 && fine.rate < 1.29);
  assert.equal(videoSyncAction(0.2, 0.2, 1, 100, true).seek, true);
  assert.equal(videoSyncAction(105, 98, 1, 100).time, 99.975);
});
