import { planFastStart, type FastStartPlan } from "./mp4-faststart.js";

// A bounded, disposable cache of derived headers. Original content-addressed
// audio and its analysis remain unchanged; every request is authorized first.
type PlaybackPlan = FastStartPlan & { prefix?: Uint8Array };
const plans = new Map<string, { expires: number; plan: PlaybackPlan | null }>();
const pending = new Map<string, Promise<PlaybackPlan | null>>();
const MAX_PLAN_BYTES = 16 * 1024 * 1024;
let planBytes = 0;
function planSize(plan: PlaybackPlan | null | undefined): number {
  return (plan?.moov.byteLength ?? 0) + (plan?.prefix?.byteLength ?? 0);
}
let activeReads = 0;
const waitingReads: (() => void)[] = [];
async function enterMetadataRead(): Promise<void> {
  if (activeReads < 4) {
    activeReads++;
    return;
  }
  await new Promise<void>((resolve) => waitingReads.push(resolve));
}
function leaveMetadataRead(): void {
  const next = waitingReads.shift();
  if (next) next();
  else activeReads--;
}

type OriginalReader = (
  range?: { offset: number; length: number },
  head?: boolean,
) => Promise<Response>;
async function sourceRange(
  bucket: R2Bucket,
  key: string,
  offset: number,
  length: number,
  original: OriginalReader,
): Promise<ReadableStream<Uint8Array>> {
  const object = await bucket.get(key, { range: { offset, length } });
  if (object) return object.body;
  const response = await original({ offset, length });
  if (
    response.status !== 206 ||
    Number(response.headers.get("content-length")) !== length ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new Error("Playback source range is unavailable");
  }
  return response.body;
}

async function cachedPlan(
  bucket: R2Bucket,
  key: string,
  original: OriginalReader,
): Promise<PlaybackPlan | null> {
  const prior = plans.get(key);
  if (prior && prior.expires > Date.now()) return prior.plan;
  if (prior) {
    planBytes -= planSize(prior.plan);
    plans.delete(key);
  }
  const inflight = pending.get(key);
  if (inflight) return inflight;
  // Avoid unbounded simultaneous metadata reads on a cold Worker isolate.
  if (pending.size >= 128) throw new Error("Playback metadata capacity reached");
  const task = (async () => {
    await enterMetadataRead();
    try {
      const object = await bucket.head(key);
      const head = object ? undefined : await original(undefined, true);
      if (head && !head.ok) throw new Error("Playback source metadata is unavailable");
      const size = object?.size ?? Number(head?.headers.get("content-length"));
      if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Invalid playback source size");
      const windows: { offset: number; bytes: Uint8Array }[] = [];
      const parsed = await planFastStart(size, async (offset, length) => {
        const cached = windows.find(
          (w) => offset >= w.offset && offset + length <= w.offset + w.bytes.length,
        );
        if (cached)
          return cached.bytes.slice(offset - cached.offset, offset - cached.offset + length);
        const count = Math.min(size - offset, Math.max(length, 64 * 1024));
        const bytes = new Uint8Array(
          await new Response(await sourceRange(bucket, key, offset, count, original)).arrayBuffer(),
        );
        if (bytes.length !== count) throw new Error("Playback source range is incomplete");
        // Only keep a few read windows while examining metadata.
        if (windows.length >= 4) windows.shift();
        windows.push({ offset, bytes });
        return bytes.slice(0, length);
      });
      const first = windows.find(
        (window) =>
          window.offset === 0 && window.bytes.length >= (parsed?.insertionOffset ?? Infinity),
      );
      const plan: PlaybackPlan | null = parsed
        ? { ...parsed, ...(first ? { prefix: first.bytes.slice(0, parsed.insertionOffset) } : {}) }
        : null;
      while (plans.size >= 64 || planBytes + planSize(plan) > MAX_PLAN_BYTES) {
        const first = plans.keys().next().value;
        if (first === undefined) break;
        planBytes -= planSize(plans.get(first)?.plan);
        plans.delete(first);
      }
      plans.set(key, { expires: Date.now() + 10 * 60 * 1000, plan });
      planBytes += planSize(plan);
      return plan;
    } finally {
      leaveMetadataRead();
    }
  })();
  pending.set(key, task);
  try {
    return await task;
  } finally {
    pending.delete(key);
  }
}

function byteRange(value: string, size: number): { offset: number; length: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const length = Math.min(Number(match[2]), size);
    return Number.isSafeInteger(length) && length > 0 ? { offset: size - length, length } : null;
  }
  const offset = Number(match[1]),
    end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset >= size || end < offset)
    return null;
  return { offset, length: Math.min(end, size - 1) - offset + 1 };
}

type Segment = { length: number; offset: number } | { length: number; bytes: Uint8Array };
function body(
  bucket: R2Bucket,
  key: string,
  plan: PlaybackPlan,
  start: number,
  length: number,
  original: OriginalReader,
): ReadableStream<Uint8Array> {
  const segments: Segment[] = [
    plan.prefix
      ? { bytes: plan.prefix, length: plan.insertionOffset }
      : { offset: 0, length: plan.insertionOffset },
    { bytes: plan.moov, length: plan.moovSize },
    { offset: plan.insertionOffset, length: plan.moovOffset - plan.insertionOffset },
    {
      offset: plan.moovOffset + plan.moovSize,
      length: plan.size - plan.moovOffset - plan.moovSize,
    },
  ];
  let cursor = 0;
  const selected = segments.flatMap((segment): Segment[] => {
    const from = Math.max(start, cursor),
      to = Math.min(start + length, cursor + segment.length);
    const skip = from - cursor;
    cursor += segment.length;
    if (to <= from) return [];
    return [
      "bytes" in segment
        ? { bytes: segment.bytes.subarray(skip, skip + to - from), length: to - from }
        : { offset: segment.offset + skip, length: to - from },
    ];
  });
  let index = 0,
    canceled = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const source = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!canceled) {
          if (!reader) {
            const segment = selected[index++];
            if (!segment) {
              controller.close();
              return;
            }
            if ("bytes" in segment) {
              controller.enqueue(segment.bytes);
              return;
            }
            const stream = await sourceRange(bucket, key, segment.offset, segment.length, original);
            if (canceled) {
              await stream.cancel();
              return;
            }
            reader = stream.getReader();
          }
          const part = await reader.read();
          if (canceled) return;
          if (part.done) {
            reader.releaseLock();
            reader = undefined;
            continue;
          }
          controller.enqueue(part.value);
          return;
        }
      } catch (error) {
        if (reader) {
          const active = reader;
          reader = undefined;
          await active.cancel(error).catch(() => {});
          active.releaseLock();
        }
        if (!canceled) controller.error(error);
      }
    },
    async cancel(reason) {
      canceled = true;
      if (reader) {
        const active = reader;
        reader = undefined;
        try {
          await active.cancel(reason);
        } finally {
          active.releaseLock();
        }
      }
    },
  });
  // Workers ignores a manual Content-Length on an ordinary ReadableStream.
  // Preserve streaming/backpressure while letting the runtime enforce and
  // advertise the exact full/range length. pipeTo also forwards cancellation
  // to the current R2 reader and source errors to the response body.
  const fixed = new FixedLengthStream(length);
  void source.pipeTo(fixed.writable).catch(() => {
    // The readable side already carries the stream error (or was canceled).
    // Consume the pipe promise rejection without hiding a broken response.
  });
  return fixed.readable;
}

/** Stream a deterministic fast-start view only on the scoped playback route.
 * Canonical /v1/media bytes, hashes, downloads and CDJ seek tables are untouched.
 * Unsupported layouts fall back to the ordinary byte-for-byte media reader. */
export async function fastStartPlayback(
  request: Request,
  bucket: R2Bucket,
  accountID: string,
  hash: string,
  original: OriginalReader,
): Promise<Response | null> {
  const key = `accounts/${accountID}/sha256/${hash}`;
  let plan: PlaybackPlan | null;
  try {
    plan = await cachedPlan(bucket, key, original);
  } catch {
    // Never mix original and relocated bytes under the same playback URL when
    // a transient read fails. Unsupported layouts alone use original bytes.
    return new Response(null, {
      status: 503,
      headers: { "retry-after": "1", "cache-control": "private, no-store" },
    });
  }
  if (!plan) return null;
  const etag = `"playback-faststart-v1-${hash}"`;
  const headers = new Headers({
    "content-type": "audio/mp4",
    "content-length": String(plan.size),
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
    "referrer-policy": "no-referrer",
    etag: etag,
    "x-content-type-options": "nosniff",
    "x-djbooth-playback-layout": "faststart-v1",
  });
  if (
    request.headers
      .get("if-none-match")
      ?.split(",")
      .some((v) => v.trim().replace(/^W\//, "") === etag || v.trim() === "*")
  ) {
    headers.delete("content-length");
    return new Response(null, { status: 304, headers });
  }
  if (request.method === "HEAD") return new Response(null, { headers });
  const rawRange = request.headers.get("range"),
    ifRange = request.headers.get("if-range");
  const range =
    rawRange && (!ifRange || ifRange === etag) ? byteRange(rawRange, plan.size) : undefined;
  if (range === null) {
    headers.set("content-range", `bytes */${plan.size}`);
    headers.set("content-length", "0");
    return new Response(null, { status: 416, headers });
  }
  if (range) {
    headers.set(
      "content-range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${plan.size}`,
    );
    headers.set("content-length", String(range.length));
  }
  return new Response(
    body(bucket, key, plan, range?.offset ?? 0, range?.length ?? plan.size, original),
    { status: range ? 206 : 200, headers },
  );
}
