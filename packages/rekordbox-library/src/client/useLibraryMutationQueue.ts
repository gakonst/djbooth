import { useRef, useState } from "react";

import type { LibraryMutation } from "../shared/types.js";

type QueueWaiter<T> = {
  resolve(value: T): void;
  reject(error: unknown): void;
};

type QueueEntry<TInput, TOutput> = {
  input: TInput;
  coalesceKey?: string;
  waiters: QueueWaiter<TOutput>[];
};

export type SerialMutationQueueOptions<TInput, TOutput> = {
  execute(input: TInput): Promise<TOutput>;
  coalesceKey?(input: TInput): string | undefined;
  onError?(error: unknown, input: TInput): void;
  onIdle?(): void;
  onPendingChange?(count: number): void;
  onSuccess?(output: TOutput, input: TInput): void;
};

/**
 * A tiny foreground-friendly write queue.
 *
 * Mutations are committed one at a time, while callers can update local UI state before
 * enqueueing. Only adjacent waiting snapshots with the same key are coalesced; this preserves
 * user intent across interleaved operations.
 */
export class SerialMutationQueue<TInput, TOutput> {
  private active?: QueueEntry<TInput, TOutput>;
  private pumping = false;
  private readonly waiting: QueueEntry<TInput, TOutput>[] = [];

  constructor(private options: SerialMutationQueueOptions<TInput, TOutput>) {}

  updateOptions(options: SerialMutationQueueOptions<TInput, TOutput>): void {
    this.options = options;
  }

  get pendingCount(): number {
    return (this.active ? 1 : 0) + this.waiting.length;
  }

  enqueue(input: TInput): Promise<TOutput> {
    const promise = new Promise<TOutput>((resolve, reject) => {
      const coalesceKey = this.options.coalesceKey?.(input);
      const tail = this.waiting.at(-1);
      if (coalesceKey && tail?.coalesceKey === coalesceKey) {
        tail.input = input;
        tail.waiters.push({ resolve, reject });
      } else {
        this.waiting.push({
          input,
          ...(coalesceKey ? { coalesceKey } : {}),
          waiters: [{ resolve, reject }],
        });
      }
      this.emitPending();
    });
    void this.pump();
    return promise;
  }

  private emitPending(): void {
    this.options.onPendingChange?.(this.pendingCount);
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    while (this.waiting.length > 0) {
      const entry = this.waiting.shift()!;
      this.active = entry;
      this.emitPending();
      try {
        const output = await this.options.execute(entry.input);
        for (const waiter of entry.waiters) waiter.resolve(output);
        this.options.onSuccess?.(output, entry.input);
      } catch (error) {
        for (const waiter of entry.waiters) waiter.reject(error);
        const abandoned = this.waiting.splice(0);
        for (const queued of abandoned) for (const waiter of queued.waiters) waiter.reject(error);
        this.options.onError?.(error, entry.input);
      } finally {
        this.active = undefined;
        this.emitPending();
      }
    }
    this.pumping = false;
    this.options.onIdle?.();
  }
}

export function libraryMutationCoalesceKey(input: LibraryMutation): string | undefined {
  if (input.type === "replace-playlist-tracks") return `playlist-order:${input.playlistId}`;
  if (input.type === "move-track") return `playlist-move:${input.playlistId}:${input.membershipId}`;
  return undefined;
}

export function useLibraryMutationQueue<TInput, TOutput>(
  options: SerialMutationQueueOptions<TInput, TOutput>,
): {
  enqueue(input: TInput): Promise<TOutput>;
  error: unknown;
  isError: boolean;
  isPending: boolean;
  pendingCount: number;
  reset(): void;
} {
  const [pendingCount, setPendingCount] = useState(0);
  const [error, setError] = useState<unknown>();
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const queueRef = useRef<SerialMutationQueue<TInput, TOutput>>(null);
  if (!queueRef.current) {
    queueRef.current = new SerialMutationQueue<TInput, TOutput>({
      ...options,
      execute: (input) => optionsRef.current.execute(input),
      coalesceKey: (input) => optionsRef.current.coalesceKey?.(input),
      onPendingChange: (count) => {
        setPendingCount(count);
        optionsRef.current.onPendingChange?.(count);
      },
      onSuccess: (output, input) => optionsRef.current.onSuccess?.(output, input),
      onError: (nextError, input) => {
        setError(nextError);
        optionsRef.current.onError?.(nextError, input);
      },
      onIdle: () => optionsRef.current.onIdle?.(),
    });
  }

  return {
    enqueue: (input) => queueRef.current!.enqueue(input),
    error,
    isError: error !== undefined,
    isPending: pendingCount > 0,
    pendingCount,
    reset: () => setError(undefined),
  };
}
