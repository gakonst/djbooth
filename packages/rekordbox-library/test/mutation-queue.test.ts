import { describe, expect, it } from "vitest";

import type { LibraryMutation } from "../src/shared/types.js";
import {
  libraryMutationCoalesceKey,
  SerialMutationQueue,
} from "../src/client/useLibraryMutationQueue.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

describe("serial mutation queue", () => {
  it("runs writes one at a time", async () => {
    const gates = [deferred<string>(), deferred<string>()];
    const started: string[] = [];
    const queue = new SerialMutationQueue<string, string>({
      execute: async (input) => {
        started.push(input);
        return gates[started.length - 1]!.promise;
      },
    });

    const first = queue.enqueue("first");
    const second = queue.enqueue("second");
    await Promise.resolve();
    expect(started).toEqual(["first"]);

    gates[0]!.resolve("one");
    await expect(first).resolves.toBe("one");
    await Promise.resolve();
    expect(started).toEqual(["first", "second"]);

    gates[1]!.resolve("two");
    await expect(second).resolves.toBe("two");
  });

  it("coalesces only adjacent waiting moves for the same membership", async () => {
    const gate = deferred<string>();
    const executed: LibraryMutation[] = [];
    const queue = new SerialMutationQueue<LibraryMutation, string>({
      coalesceKey: libraryMutationCoalesceKey,
      execute: async (input) => {
        executed.push(input);
        if (executed.length === 1) return gate.promise;
        return input.type;
      },
    });
    const first = queue.enqueue({
      type: "add-track",
      playlistId: "playlist",
      contentId: "track",
    });
    const stale = queue.enqueue({
      type: "move-track",
      playlistId: "playlist",
      membershipId: "membership",
      trackNumber: 2,
    });
    const latest = queue.enqueue({
      type: "move-track",
      playlistId: "playlist",
      membershipId: "membership",
      trackNumber: 3,
    });

    expect(queue.pendingCount).toBe(2);
    gate.resolve("add-track");
    await first;
    await expect(Promise.all([stale, latest])).resolves.toEqual(["move-track", "move-track"]);
    expect(executed).toHaveLength(2);
    expect(executed[1]).toMatchObject({ trackNumber: 3 });
  });

  it("keeps playlist replacements ordered because each snapshot is a precondition", () => {
    expect(
      libraryMutationCoalesceKey({
        type: "replace-playlist-tracks",
        playlistId: "playlist",
        contentIds: ["b", "a"],
        expectedMembershipIds: ["ma", "mb"],
      }),
    ).toBeUndefined();
  });

  it("coalesces adjacent waiting metadata snapshots for one track", () => {
    const metadata = {
      title: "First",
      artist: null,
      album: null,
      genre: null,
      key: null,
      bpm: null,
      rating: 0,
      comment: null,
      releaseYear: null,
      isrc: null,
    };
    expect(
      libraryMutationCoalesceKey({
        type: "update-track",
        contentId: "track",
        expectedRevision: "2026-07-12 12:00:00.000 +00:00",
        metadata,
      }),
    ).toBe("track-metadata:track");
  });

  it("rejects dependent queued writes after a failure", async () => {
    const gate = deferred<string>();
    const errors: unknown[] = [];
    const queue = new SerialMutationQueue<string, string>({
      execute: (input) => (input === "first" ? gate.promise : Promise.resolve(input)),
      onError: (error) => errors.push(error),
    });
    const first = queue.enqueue("first");
    const dependent = queue.enqueue("dependent");
    const failure = new Error("write conflict");
    gate.reject(failure);

    await expect(first).rejects.toBe(failure);
    await expect(dependent).rejects.toBe(failure);
    expect(errors).toEqual([failure]);
    expect(queue.pendingCount).toBe(0);
  });
});
