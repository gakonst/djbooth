import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";

export type CacheMode = "default" | "refresh" | "off";

export type CacheStats = {
  hits: number;
  misses: number;
  writes: number;
  bypasses: number;
  coalesced: number;
  errors: number;
  readMs: number;
  loadMs: number;
  writeMs: number;
};

export type JsonDiskCacheOptions = {
  namespace: string;
  root?: string;
  defaultTtlMs?: number;
  mode?: CacheMode;
  now?: () => number;
  /** Entries inspected per scheduled GC sweep. Set false to disable opportunistic GC. */
  pruneMaxEntries?: number | false;
};

export type CacheLoadOptions<T = unknown> = {
  ttlMs?: number;
  mode?: CacheMode;
  /** Return false for values that are valid for the caller but unsafe or useless to persist. */
  shouldStore?: (value: T) => boolean;
};

type CacheEnvelope = {
  schemaVersion: 1;
  createdAt: string;
  expiresAt: string;
  value: unknown;
};

type PruneCursor = {
  schemaVersion: 1;
  bucket: string;
  after: string;
  notBefore?: string;
};

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PRUNE_MAX_ENTRIES = 64;
const DEFAULT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const CACHE_FILE_PATTERN = /^[\da-f]{64}\.json$/u;
const CACHE_BUCKET_PATTERN = /^[\da-f]{2}$/u;

/**
 * Small, dependency-free JSON cache for public provider metadata.
 *
 * Values are versioned, TTL-bounded, written atomically, and single-flight within one process.
 * Authentication material is never part of a cache key or envelope.
 */
export class JsonDiskCache {
  readonly #directory: string;
  readonly #defaultTtlMs: number;
  readonly #mode: CacheMode;
  readonly #now: () => number;
  readonly #pruneMaxEntries: number | undefined;
  readonly #inflight = new Map<string, Promise<unknown>>();
  #automaticPrune: Promise<unknown> | undefined;
  readonly #stats: CacheStats = {
    hits: 0,
    misses: 0,
    writes: 0,
    bypasses: 0,
    coalesced: 0,
    errors: 0,
    readMs: 0,
    loadMs: 0,
    writeMs: 0,
  };

  constructor(options: JsonDiskCacheOptions) {
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(options.namespace)) {
      throw new TypeError(
        "Cache namespace must contain only lowercase letters, numbers, ., _, or -",
      );
    }
    this.#defaultTtlMs = positiveTtl(options.defaultTtlMs ?? DEFAULT_TTL_MS);
    this.#mode = options.mode ?? "default";
    this.#now = options.now ?? Date.now;
    this.#pruneMaxEntries =
      options.pruneMaxEntries === false
        ? undefined
        : positiveInteger(options.pruneMaxEntries ?? DEFAULT_PRUNE_MAX_ENTRIES, "pruneMaxEntries");
    this.#directory = join(resolve(options.root ?? defaultCacheRoot()), options.namespace);
  }

  snapshot(): CacheStats {
    return {
      ...this.#stats,
      readMs: roundMilliseconds(this.#stats.readMs),
      loadMs: roundMilliseconds(this.#stats.loadMs),
      writeMs: roundMilliseconds(this.#stats.writeMs),
    };
  }

  async getOrLoad<T>(
    key: unknown,
    load: () => Promise<T>,
    options: CacheLoadOptions<T> = {},
  ): Promise<T> {
    const mode = options.mode ?? this.#mode;
    if (mode === "off") {
      this.#stats.bypasses += 1;
      return load();
    }

    const digest = cacheDigest(key);
    if (this.#pruneMaxEntries !== undefined) {
      this.#automaticPrune ??= this.#pruneExpired(this.#pruneMaxEntries, true);
      await this.#automaticPrune;
    }

    const path = this.#path(digest);
    if (mode === "default") {
      const readStarted = performance.now();
      const cached = await this.#read<T>(path);
      this.#stats.readMs += performance.now() - readStarted;
      if (cached.hit) {
        this.#stats.hits += 1;
        return cached.value;
      }
    }
    this.#stats.misses += 1;

    const running = this.#inflight.get(digest);
    if (running) {
      this.#stats.coalesced += 1;
      return running as Promise<T>;
    }

    const request = (async () => {
      const loadStarted = performance.now();
      let value: T;
      try {
        value = await load();
      } finally {
        this.#stats.loadMs += performance.now() - loadStarted;
      }
      if (value !== undefined && (options.shouldStore?.(value) ?? true)) {
        await this.#write(path, value, positiveTtl(options.ttlMs ?? this.#defaultTtlMs));
      }
      return value;
    })();
    this.#inflight.set(digest, request);
    try {
      return await request;
    } finally {
      this.#inflight.delete(digest);
    }
  }

  /**
   * Inspect at most `maxEntries` cache files and remove expired or invalid envelopes.
   * A persisted cursor lets later cache instances continue the bounded sweep.
   */
  async pruneExpired(
    maxEntries = this.#pruneMaxEntries ?? DEFAULT_PRUNE_MAX_ENTRIES,
  ): Promise<{ scanned: number; removed: number; errors: number }> {
    return this.#pruneExpired(maxEntries, false);
  }

  async #pruneExpired(
    maxEntries: number,
    respectInterval: boolean,
  ): Promise<{ scanned: number; removed: number; errors: number }> {
    const limit = positiveInteger(maxEntries, "maxEntries");
    const result = { scanned: 0, removed: 0, errors: 0 };
    const cursor = await this.#readPruneCursor();
    if (respectInterval && cursor?.notBefore && Date.parse(cursor.notBefore) > this.#now()) {
      return result;
    }
    let buckets: string[];
    try {
      buckets = (await readdir(this.#directory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && CACHE_BUCKET_PATTERN.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (isMissingFile(error)) return result;
      this.#stats.errors += 1;
      result.errors += 1;
      return result;
    }
    if (!buckets.length) return result;

    const startIndex = cursor
      ? Math.max(
          0,
          buckets.findIndex((bucket) => bucket >= cursor.bucket),
        )
      : 0;
    let last: { bucket: string; file: string } | undefined;
    for (let offset = 0; offset < buckets.length; offset += 1) {
      const bucket = buckets[(startIndex + offset) % buckets.length]!;
      let files: string[];
      try {
        files = (await readdir(join(this.#directory, bucket), { withFileTypes: true }))
          .filter((entry) => entry.isFile() && CACHE_FILE_PATTERN.test(entry.name))
          .map((entry) => entry.name)
          .sort();
      } catch (error) {
        if (!isMissingFile(error)) {
          this.#stats.errors += 1;
          result.errors += 1;
        }
        continue;
      }
      const remaining =
        cursor && offset === 0 && bucket === cursor.bucket
          ? files.filter((file) => file > cursor.after)
          : files;
      for (const file of remaining) {
        const path = join(this.#directory, bucket, file);
        result.scanned += 1;
        last = { bucket, file };
        try {
          const envelope = JSON.parse(await readFile(path, "utf8")) as CacheEnvelope;
          if (!validEnvelope(envelope) || Date.parse(envelope.expiresAt) <= this.#now()) {
            await rm(path, { force: true });
            result.removed += 1;
          }
        } catch (error) {
          if (isMissingFile(error)) {
            // Another process already removed this entry.
          } else {
            this.#stats.errors += 1;
            result.errors += 1;
            try {
              await rm(path, { force: true });
              result.removed += 1;
            } catch {
              this.#stats.errors += 1;
              result.errors += 1;
            }
          }
        }
        if (result.scanned >= limit) {
          await this.#writePruneCursor({
            schemaVersion: 1,
            bucket: last.bucket,
            after: last.file,
          });
          return result;
        }
      }
    }

    await this.#writePruneCursor({
      schemaVersion: 1,
      bucket: buckets[0]!,
      after: "",
      notBefore: new Date(this.#now() + DEFAULT_PRUNE_INTERVAL_MS).toISOString(),
    });
    return result;
  }

  async #read<T>(path: string): Promise<{ hit: true; value: T } | { hit: false }> {
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as CacheEnvelope;
      if (!validEnvelope(value)) {
        await rm(path, { force: true });
        return { hit: false };
      }
      if (Date.parse(value.expiresAt) <= this.#now()) {
        await rm(path, { force: true });
        return { hit: false };
      }
      return { hit: true, value: value.value as T };
    } catch (error) {
      if (!isMissingFile(error)) this.#stats.errors += 1;
      return { hit: false };
    }
  }

  async #write(path: string, value: unknown, ttlMs: number): Promise<void> {
    const now = this.#now();
    const envelope: CacheEnvelope = {
      schemaVersion: 1,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
      value,
    };
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const writeStarted = performance.now();
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(temporary, `${JSON.stringify(envelope)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, path);
      this.#stats.writes += 1;
    } catch {
      this.#stats.errors += 1;
      await rm(temporary, { force: true }).catch(() => undefined);
    } finally {
      this.#stats.writeMs += performance.now() - writeStarted;
    }
  }

  #path(digest: string): string {
    return join(this.#directory, digest.slice(0, 2), `${digest}.json`);
  }

  async #readPruneCursor(): Promise<PruneCursor | undefined> {
    try {
      const value = JSON.parse(
        await readFile(join(this.#directory, ".prune-cursor.json"), "utf8"),
      ) as PruneCursor;
      return value.schemaVersion === 1 &&
        CACHE_BUCKET_PATTERN.test(value.bucket) &&
        (value.after === "" || CACHE_FILE_PATTERN.test(value.after)) &&
        (value.notBefore === undefined ||
          (typeof value.notBefore === "string" && Number.isFinite(Date.parse(value.notBefore))))
        ? value
        : undefined;
    } catch (error) {
      if (!isMissingFile(error)) this.#stats.errors += 1;
      return undefined;
    }
  }

  async #writePruneCursor(cursor: PruneCursor): Promise<void> {
    const path = join(this.#directory, ".prune-cursor.json");
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, `${JSON.stringify(cursor)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, path);
    } catch {
      this.#stats.errors += 1;
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

export function defaultCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TRACKS_CACHE_DIR?.trim()) return resolve(env.TRACKS_CACHE_DIR);
  if (env.XDG_CACHE_HOME?.trim()) return resolve(env.XDG_CACHE_HOME, "tracks-ts");
  return join(homedir(), ".cache", "tracks-ts");
}

export function cacheDigest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeCacheKey(value, "$", new WeakSet<object>()));
}

function normalizeCacheKey(value: unknown, path: string, active: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Cache key ${path} contains a non-finite number`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`Cache key ${path} contains unsupported ${typeof value}`);
  }
  if (active.has(value)) throw new TypeError(`Cache key ${path} contains a cycle`);

  active.add(value);
  try {
    if (Array.isArray(value)) return normalizeCacheKeyArray(value, path, active);
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      const kind = prototype?.constructor?.name || "non-plain object";
      throw new TypeError(`Cache key ${path} contains unsupported ${kind}`);
    }
    const normalized: Record<string, unknown> = {};
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
      if (typeof key !== "string") {
        throw new TypeError(`Cache key ${path} contains a symbol property`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable) {
        throw new TypeError(`Cache key ${path}.${key} is non-enumerable`);
      }
      if (!("value" in descriptor)) {
        throw new TypeError(`Cache key ${path}.${key} is an accessor property`);
      }
      if (descriptor.value === undefined) continue;
      normalized[key] = normalizeCacheKey(descriptor.value, `${path}.${key}`, active);
    }
    return Object.fromEntries(
      Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)),
    );
  } finally {
    active.delete(value);
  }
}

function normalizeCacheKeyArray(
  value: readonly unknown[],
  path: string,
  active: WeakSet<object>,
): unknown[] {
  const keys = Reflect.ownKeys(value);
  const expectedKeys = new Set(["length", ...value.map((_, index) => String(index))]);
  if (keys.some((key) => typeof key !== "string" || !expectedKeys.has(key))) {
    throw new TypeError(`Cache key ${path} contains unsupported array properties`);
  }
  const normalized: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError(`Cache key ${path} contains a sparse array`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))!;
    if (!("value" in descriptor)) {
      throw new TypeError(`Cache key ${path}[${index}] is an accessor property`);
    }
    normalized.push(normalizeCacheKey(descriptor.value, `${path}[${index}]`, active));
  }
  return normalized;
}

function positiveTtl(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Cache TTL must be a positive finite number of milliseconds");
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function validEnvelope(value: CacheEnvelope): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    value.schemaVersion === 1 &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt)) &&
    Object.hasOwn(value, "value")
  );
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}
