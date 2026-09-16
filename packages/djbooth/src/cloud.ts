import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import {
  RekordboxLibraryService,
  type PlaylistItem,
  type TrackSummary,
  type TrackWaveform,
} from "@gakonst/djbooth-app";
import { Cli, z } from "incur";

import { loginCloud, savedCloudToken, forgetCloudLogin } from "./cloud-login.js";

const publisherPrefix = "rekordbox-publish:";
const changeSchema = z.object({
  sequence: z.number().int().nonnegative(),
  operationID: z.string(),
  kind: z.enum(["track", "collection", "favorite", "annotation"]),
  entityID: z.string(),
  payload: z.string().nullable(),
  deleted: z.boolean(),
});
type Change = z.infer<typeof changeSchema>;
type CloudTrack = Pick<
  TrackSummary,
  "id" | "title" | "artist" | "album" | "genre" | "key" | "bpm" | "durationSeconds" | "analyzed"
> & {
  artworkAvailable: boolean;
  fileExists: boolean;
  mediaHash?: string;
  mediaExtension?: string;
  waveform?: CloudWaveform;
  analysis?: { mediaHash: string; dat: string; ext: string; twoEx: string };
};
type CloudWaveform = Omit<TrackWaveform, "beatGrid"> & {
  beatGrid?: { times: number[]; beats: number[] };
};
type Collection = { id: string; name: string; trackIDs: string[] };
type Library = Pick<RekordboxLibraryService, "getTracks" | "getPlaylists" | "getAudioPath"> &
  Partial<Pick<RekordboxLibraryService, "getWaveform" | "getAnalysisPaths">>;
type Progress = { phase: string; current: number; total: number };
export type CloudPublishOptions = {
  endpoint?: string;
  token?: string;
  playlist?: string[];
  namespace?: string;
  metadataOnly?: boolean;
  uploadConcurrency?: number;
  dryRun?: boolean;
  onProgress?: (progress: Progress) => void;
};

/** Validate before attaching authorization, including redirects being disabled by the caller. */
export function cloudEndpoint(value: string): URL {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const containerBinding =
    process.env.DJBOOTH_CONTAINER_BINDINGS === "1" && url.host === "djbooth.internal";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && (loopback || containerBinding))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new TypeError("Cloud endpoint must be an HTTPS origin, or HTTP on localhost");
  return url;
}

/** Explicit allowlist: local paths and workstation availability never become portable metadata. */
export function cloudTrack(track: TrackSummary, previous?: Change): CloudTrack {
  const old = previous?.payload && !previous.deleted ? JSON.parse(previous.payload) : undefined;
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    genre: track.genre,
    key: track.key,
    bpm: track.bpm,
    durationSeconds: track.durationSeconds,
    analyzed: track.analyzed,
    artworkAvailable: false,
    fileExists: false,
    ...(typeof old?.mediaHash === "string" && /^[a-f0-9]{64}$/u.test(old.mediaHash)
      ? {
          mediaHash: old.mediaHash,
          ...(typeof old.mediaExtension === "string" ? { mediaExtension: old.mediaExtension } : {}),
          ...(old.analysis?.mediaHash === old.mediaHash ? { analysis: old.analysis } : {}),
        }
      : {}),
  };
}

function allTracks(library: Library, playlistId?: string): TrackSummary[] {
  const tracks: TrackSummary[] = [];
  while (true) {
    const page = library.getTracks({
      limit: 10_000,
      offset: tracks.length,
      ...(playlistId ? { playlistId } : {}),
    });
    tracks.push(...page.items);
    if (tracks.length >= page.count) return tracks;
    if (!page.items.length) throw new Error("Library changed while reading; rerun cloud publish");
  }
}

/** Retain detail for a scrolling player while keeping a track below the sync payload limit. */
export function cloudWaveform(waveform: TrackWaveform): CloudWaveform {
  const entries = waveform.beatGrid?.slice(0, 20_000);
  const beatGrid = entries?.length
    ? {
        times: entries.map((entry) => Math.round(entry.timeSeconds * 1000) / 1000),
        beats: entries.map((entry) => entry.beat),
      }
    : undefined;
  let bars = Math.min(8192, waveform.peaks.length);
  while (true) {
    const peaks: number[] = [];
    const colors: [number, number, number][] = [];
    for (let bar = 0; bar < bars; bar++) {
      const start = Math.floor((bar * waveform.peaks.length) / bars);
      const end = Math.floor(((bar + 1) * waveform.peaks.length) / bars);
      let strongest = start;
      for (let index = start + 1; index < end; index++)
        if (waveform.peaks[index]! > waveform.peaks[strongest]!) strongest = index;
      peaks.push(Math.round(waveform.peaks[strongest]! * 10_000) / 10_000);
      const color = waveform.colors?.[strongest];
      if (color) colors.push(color);
    }
    const result: CloudWaveform = {
      source: waveform.source,
      durationSeconds: waveform.durationSeconds,
      peaks,
      ...(colors.length === peaks.length && colors.length ? { colors } : {}),
      ...(beatGrid ? { beatGrid } : {}),
    };
    // Keep every measured beat; long sets can use a smaller amplitude overview.
    // Leave room for titles and other track metadata under the 256 KiB limit.
    if (Buffer.byteLength(JSON.stringify(result)) <= 220 * 1024) return result;
    if (bars <= 128) throw new Error("Analyzed beatgrid exceeds the cloud track payload limit");
    bars = Math.max(128, Math.floor(bars / 2));
  }
}

function selectPlaylists(playlists: PlaylistItem[], selectors: string[]): PlaylistItem[] {
  const byId = new Map(playlists.map((playlist) => [playlist.id, playlist]));
  function path(playlist: PlaylistItem): string {
    const segments = [playlist.name];
    const visited = new Set([playlist.id]);
    let parent = byId.get(playlist.parentId);
    while (parent && !visited.has(parent.id)) {
      segments.unshift(parent.name);
      visited.add(parent.id);
      parent = byId.get(parent.parentId);
    }
    return segments.join("/");
  }
  if (!selectors.length) return playlists.filter((playlist) => playlist.type !== "folder");
  const selected = new Set<string>();
  for (const selector of selectors) {
    const matches = playlists.filter(
      (playlist) =>
        playlist.id === selector || path(playlist) === selector || playlist.name === selector,
    );
    if (matches.length !== 1)
      throw new Error(
        matches.length
          ? `Playlist '${selector}' is ambiguous; use its ID or full path`
          : `Playlist '${selector}' was not found`,
      );
    const match = matches[0]!;
    selected.add(match.id);
    if (match.type === "folder") {
      for (const playlist of playlists) {
        const visited = new Set<string>();
        let parent = playlist.parentId;
        while (!visited.has(parent)) {
          if (parent === match.id) {
            selected.add(playlist.id);
            break;
          }
          visited.add(parent);
          const next = byId.get(parent);
          if (!next) break;
          parent = next.parentId;
        }
      }
    }
  }
  return playlists.filter((playlist) => playlist.type !== "folder" && selected.has(playlist.id));
}

function entityKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}
function samePayload(change: Change | undefined, value: unknown): boolean {
  return (
    !!change &&
    !change.deleted &&
    !!change.payload &&
    isDeepStrictEqual(JSON.parse(change.payload), value)
  );
}

/** Publish a resumable mirror. master.db remains authoritative; the server is the resume cursor. */
export async function publishCloudLibrary(
  library: Library,
  options: CloudPublishOptions,
  request: typeof fetch = fetch,
) {
  if (options.namespace && !/^cloud:[a-f0-9-]{36}$/i.test(options.namespace))
    throw new TypeError("Invalid cloud playlist namespace");
  const trackID = (id: string) => (options.namespace ? `${options.namespace}:track:${id}` : id);
  const portableTrack = (track: TrackSummary, previous?: Change) => ({
    ...cloudTrack(track, previous),
    id: trackID(track.id),
  });
  const uploadConcurrency = options.uploadConcurrency ?? 3;
  if (!Number.isInteger(uploadConcurrency) || uploadConcurrency < 1 || uploadConcurrency > 3)
    throw new RangeError("Upload concurrency must be an integer between 1 and 3");
  let progress: Progress = { phase: "inspect", current: 0, total: 1 };
  const emit = (phase: string, current: number, total: number) => {
    progress = { phase, current, total };
    try {
      options.onProgress?.(progress);
    } catch {
      /* Diagnostics cannot interrupt publishing. */
    }
  };
  emit("inspect", 0, 1);
  const heartbeat = setInterval(
    () => emit(progress.phase, progress.current, progress.total),
    2_000,
  );
  heartbeat.unref();
  try {
    const playlists = selectPlaylists(library.getPlaylists(), options.playlist ?? []);
    const collections: Collection[] = playlists.map((playlist) => ({
      id: options.namespace
        ? `${options.namespace}:playlist:${playlist.id}`
        : `rekordbox:${playlist.id}`,
      name: playlist.name,
      trackIDs: allTracks(library, playlist.id).map((track) => track.id),
    }));
    const selectedIDs = new Set(collections.flatMap((collection) => collection.trackIDs));
    const libraryTracks = allTracks(library);
    const byID = new Map(libraryTracks.map((track) => [track.id, track]));
    // Make the beginning of a selected playlist playable first while uploads continue.
    const tracks = options.playlist?.length
      ? [...selectedIDs].flatMap((id) => {
          const track = byID.get(id);
          return track ? [track] : [];
        })
      : libraryTracks;
    const result = {
      dryRun: options.dryRun ?? false,
      tracks: tracks.length,
      playlists: collections.map(({ id, name, trackIDs }) => ({
        id,
        name,
        tracks: trackIDs.length,
      })),
      availableAudio: tracks.filter((track) => track.fileExists).length,
      published: 0,
      unchanged: 0,
      uploaded: 0,
      reusedMedia: 0,
      cdjReady: 0,
      conflicts: [] as string[],
      failures: [] as { id: string; title: string; message: string }[],
    };
    if (options.dryRun) {
      emit("complete", tracks.length, tracks.length);
      return result;
    }
    if (!options.endpoint || !options.token)
      throw new Error(
        "Run cloud login --endpoint <url>, then cloud publish --endpoint <url>; or provide --token-file",
      );
    const endpoint = cloudEndpoint(options.endpoint);
    const headers = { Authorization: `Bearer ${options.token}` };
    const remote = new Map<string, Change>();
    async function call(path: string, init: RequestInit = {}, timeout = 60_000): Promise<Response> {
      // JSON sync writes carry stable operation IDs. Audio streams must instead
      // resume through the outer workflow because their bodies cannot be replayed.
      const attempts = init.body == null || typeof init.body === "string" ? 3 : 1;
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await request(new URL(path, endpoint), {
            ...init,
            headers: { ...headers, ...init.headers },
            redirect: "error",
            signal: AbortSignal.timeout(timeout),
          });
          if (attempt + 1 >= attempts || ![429, 502, 503, 504].includes(response.status))
            return response;
          await response.body?.cancel();
        } catch (error) {
          if (attempt + 1 >= attempts) throw error;
        }
        await delay(250 * 2 ** attempt);
      }
    }
    async function checked(response: Response): Promise<Response> {
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Cloud request failed (${response.status})`);
      }
      return response;
    }
    let cursor = 0;
    emit("reconcile", 0, 1);
    while (true) {
      const scope = options.namespace ? `&namespace=${encodeURIComponent(options.namespace)}` : "";
      const response = await checked(await call(`/v1/sync/changes?after=${cursor}${scope}`));
      const page = z
        .object({
          changes: z.array(changeSchema),
          cursor: z.number().int().nonnegative(),
          hasMore: z.boolean(),
        })
        .parse(await response.json());
      for (const change of page.changes)
        remote.set(entityKey(change.kind, change.entityID), change);
      if (!page.hasMore) break;
      if (page.cursor <= cursor) throw new Error("Cloud returned a non-advancing sync cursor");
      cursor = page.cursor;
    }
    async function publish(
      kind: "track" | "collection",
      entityID: string,
      value: CloudTrack | Collection,
    ): Promise<boolean> {
      const key = entityKey(kind, entityID);
      const previous = remote.get(key);
      if (samePayload(previous, value)) {
        result.unchanged++;
        return true;
      }
      // A mobile edit is never silently replaced by a workstation snapshot.
      if (previous && !previous.operationID.startsWith(publisherPrefix)) {
        result.conflicts.push(key);
        return false;
      }
      const payload = JSON.stringify(value);
      const baseVersion = previous?.sequence ?? 0;
      const operationID =
        publisherPrefix +
        createHash("sha256")
          .update(JSON.stringify({ kind, entityID, baseVersion, payload }))
          .digest("hex");
      const response = await call("/v1/sync/changes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operationID, kind, entityID, baseVersion, payload, deleted: false }),
      });
      if (response.status === 409) {
        await response.body?.cancel();
        result.conflicts.push(key);
        return false;
      }
      const change = changeSchema.parse(await (await checked(response)).json());
      remote.set(key, change);
      result.published++;
      return true;
    }
    // Metadata arrives first so a phone can browse while recordings are still uploading.
    const accepted = new Set<string>();
    const waveforms = new Map<string, ReturnType<typeof cloudWaveform>>();
    let current = 0;
    const metadataTotal = tracks.length + collections.length;
    emit("metadata", 0, metadataTotal);
    for (const track of tracks) {
      if (track.analyzed && library.getWaveform)
        waveforms.set(track.id, cloudWaveform(library.getWaveform(track.id)));
      const value = portableTrack(track, remote.get(entityKey("track", trackID(track.id))));
      const waveform = waveforms.get(track.id);
      if (waveform) value.waveform = waveform;
      if (await publish("track", trackID(track.id), value)) accepted.add(track.id);
      emit("metadata", ++current, metadataTotal);
    }
    for (const collection of collections) {
      await publish("collection", collection.id, {
        ...collection,
        trackIDs: collection.trackIDs.map(trackID),
      });
      emit("metadata", ++current, metadataTotal);
    }
    if (!options.metadataOnly) {
      const audio = tracks.filter((track) => track.fileExists && accepted.has(track.id));
      current = 0;
      emit("audio", 0, audio.length);
      const uploadTrack = async (track: TrackSummary) => {
        try {
          const path = library.getAudioPath(track.id);
          const before = await stat(path);
          const hash = createHash("sha256");
          for await (const chunk of createReadStream(path)) hash.update(chunk);
          const digest = hash.digest("hex");
          const head = await call(`/v1/media/${digest}`, { method: "HEAD" });
          if (head.status === 404) {
            async function upload(hash: string, start: number, size: number): Promise<void> {
              const stream = createReadStream(path, { start, end: start + size - 1 });
              try {
                const init = {
                  method: "PUT",
                  headers: {
                    "Content-Type": "application/octet-stream",
                    "Content-Length": String(size),
                  },
                  body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
                  duplex: "half",
                };
                const uploaded = await checked(await call(`/v1/media/${hash}`, init, 600_000));
                await uploaded.body?.cancel();
              } finally {
                stream.destroy();
              }
            }
            const chunkSize = 16 * 1024 * 1024;
            if (before.size > chunkSize) {
              if (before.size > 4 * 1024 * 1024 * 1024)
                throw new Error("Cloud recordings are limited to 4 GiB");
              const chunks: { hash: string; size: number }[] = [];
              const totalChunks = Math.ceil(before.size / chunkSize);
              emit("audio-chunks", 0, totalChunks);
              for (let start = 0; start < before.size; start += chunkSize) {
                const size = Math.min(chunkSize, before.size - start);
                const chunkHash = createHash("sha256");
                for await (const chunk of createReadStream(path, { start, end: start + size - 1 }))
                  chunkHash.update(chunk);
                const hash = chunkHash.digest("hex");
                const exists = await call(`/v1/media/${hash}`, { method: "HEAD" });
                if (exists.status === 404) await upload(hash, start, size);
                else await checked(exists);
                chunks.push({ hash, size });
                emit("audio-chunks", chunks.length, totalChunks);
              }
              emit("audio-verify", current, audio.length);
              const composed = await checked(
                await call(
                  `/v1/media/${digest}/compose`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ chunks }),
                  },
                  600_000,
                ),
              );
              await composed.body?.cancel();
            } else await upload(digest, 0, before.size);
            result.uploaded++;
          } else {
            await checked(head);
            result.reusedMedia++;
          }
          const after = await stat(path);
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
            throw new Error("Recording changed while publishing; rerun cloud publish");
          const value = portableTrack(track);
          const waveform = waveforms.get(track.id);
          if (waveform) value.waveform = waveform;
          value.mediaHash = digest;
          value.mediaExtension = extname(path).slice(1).toLowerCase();
          if (track.analyzed && library.getAnalysisPaths) {
            const paths = library.getAnalysisPaths(track.id);
            const hashes: string[] = [];
            for (const type of ["DAT", "EXT", "2EX"] as const) {
              const path = paths[type];
              if (!path)
                throw new Error(`Missing ${type} analysis; run analyze before cloud publish`);
              const bytes = await readFile(path);
              const hash = createHash("sha256").update(bytes).digest("hex");
              const exists = await call(`/v1/media/${hash}`, { method: "HEAD" });
              if (exists.status === 404) {
                const uploaded = await checked(
                  await call(`/v1/media/${hash}`, {
                    method: "PUT",
                    headers: {
                      "Content-Type": "application/octet-stream",
                      "Content-Length": String(bytes.length),
                    },
                    body: bytes,
                  }),
                );
                await uploaded.body?.cancel();
              } else await checked(exists);
              hashes.push(hash);
            }
            value.analysis = {
              mediaHash: digest,
              dat: hashes[0]!,
              ext: hashes[1]!,
              twoEx: hashes[2]!,
            };
          }
          if (await publish("track", trackID(track.id), value)) {
            if (value.analysis) result.cdjReady++;
          }
        } catch (error) {
          result.failures.push({
            id: track.id,
            title: track.title,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        emit("audio", ++current, audio.length);
      };
      // Finish the first song before fanning out; a newly hosted playlist can start playing.
      if (audio[0]) await uploadTrack(audio[0]);
      let next = 1;
      const uploadNext = async () => {
        while (next < audio.length) await uploadTrack(audio[next++]!);
      };
      await Promise.all(
        Array.from(
          { length: Math.min(uploadConcurrency, Math.max(0, audio.length - 1)) },
          uploadNext,
        ),
      );
    }
    emit(
      result.failures.length || result.conflicts.length ? "needs-attention" : "complete",
      tracks.length,
      tracks.length,
    );
    return result;
  } finally {
    clearInterval(heartbeat);
  }
}

export const cloudCli = Cli.create("cloud", {
  description:
    "Publish the local Rekordbox library and recordings to private cross-device cloud sync.",
}).command("publish", {
  description:
    "Mirror ready master.db tracks and ordered playlists, with resumable content-addressed audio uploads.",
  hint: "Rerun to reconcile. Mobile edits are retained as conflicts. No credentials or local paths are uploaded.",
  options: z.object({
    endpoint: z.string().optional().describe("Cloud HTTPS origin; defaults to DJBOOTH_CLOUD_URL"),
    tokenFile: z
      .string()
      .optional()
      .describe("Private file containing the cloud bearer token; otherwise DJBOOTH_CLOUD_TOKEN"),
    dbPath: z.string().optional().describe("master.db path; defaults to Rekordbox discovery"),
    playlist: z
      .array(z.string())
      .optional()
      .describe("Playlist/folder ID, exact name, or hierarchy path; repeat to select more"),
    namespace: z
      .string()
      .optional()
      .describe(
        "Isolated cloud playlist namespace (cloud:<request UUID>); leaves desktop IDs unchanged",
      ),
    metadataOnly: z
      .boolean()
      .default(false)
      .describe("Publish catalog now without uploading audio"),
    uploadConcurrency: z
      .number()
      .int()
      .min(1)
      .max(3)
      .default(3)
      .describe("Parallel audio uploads after prioritizing the first song; 1–3"),
    dryRun: z
      .boolean()
      .default(false)
      .describe("Inspect the selected local catalog without making cloud requests"),
    progress: z.enum(["auto", "always", "never"]).default("auto").describe("Progress on stderr"),
  }),
  async run(c) {
    const endpoint = c.options.endpoint ?? process.env.DJBOOTH_CLOUD_URL;
    let token = process.env.DJBOOTH_CLOUD_TOKEN;
    if (!token && !c.options.tokenFile && endpoint && !c.options.dryRun)
      token = await savedCloudToken(cloudEndpoint(endpoint));
    if (c.options.tokenFile && !c.options.dryRun) {
      const info = await stat(c.options.tokenFile);
      if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
        throw new Error("Cloud token file must be private (chmod 600)");
      token = (await readFile(c.options.tokenFile, "utf8")).trim();
    }
    const library = new RekordboxLibraryService({
      writeEnabled: false,
      ...(c.options.dbPath ? { dbPath: c.options.dbPath } : {}),
    });
    try {
      return await publishCloudLibrary(library, {
        ...(endpoint ? { endpoint } : {}),
        ...(token ? { token } : {}),
        ...(c.options.playlist ? { playlist: c.options.playlist } : {}),
        ...(c.options.namespace ? { namespace: c.options.namespace } : {}),
        metadataOnly: c.options.metadataOnly,
        uploadConcurrency: c.options.uploadConcurrency,
        dryRun: c.options.dryRun,
        ...(c.options.progress === "always" ||
        (c.options.progress === "auto" && process.stderr.isTTY)
          ? {
              onProgress: ({ phase, current, total }: Progress) =>
                process.stderr.write(`cloud ${phase} ${current}/${total}\n`),
            }
          : {}),
      });
    } finally {
      library.close();
    }
  },
});
cloudCli.command("container", {
  description:
    "Run one isolated playlist's import, analysis, R2 backups, and publishing inside Cloudflare Containers.",
  hint: "Container entrypoint; configured by the cloud service's per-playlist environment. master.db is restored from R2 before resuming.",
  options: z.object({
    progress: z.enum(["auto", "always", "never"]).default("auto").describe("Progress on stderr"),
  }),
  async run(c) {
    const { runPlaylistContainer } = await import("./cloud-container.js");
    const show =
      c.options.progress === "always" || (c.options.progress === "auto" && process.stderr.isTTY);
    await runPlaylistContainer(
      show
        ? {
            onProgress: ({ phase, current, total }) => {
              process.stderr.write(`cloud ${phase} ${current}/${total}\n`);
            },
          }
        : {},
    );
    return { stopped: true };
  },
});

cloudCli.command("login", {
  description: "Sign in through Nanocodex Connect and save an account-scoped cloud credential.",
  options: z.object({
    endpoint: z.string().optional().describe("Cloud library URL; otherwise DJBOOTH_CLOUD_URL"),
    progress: z.enum(["auto", "always", "never"]).default("auto").describe("Progress on stderr"),
  }),
  async run(c) {
    const endpoint = c.options.endpoint ?? process.env.DJBOOTH_CLOUD_URL;
    if (!endpoint) throw new Error("Provide --endpoint or DJBOOTH_CLOUD_URL");
    return loginCloud(cloudEndpoint(endpoint), {
      onProgress: (phase, url) => {
        if (url) process.stderr.write(`Open ${url}\n`);
        if (
          c.options.progress === "always" ||
          (c.options.progress === "auto" && process.stderr.isTTY)
        )
          process.stderr.write(
            `cloud login ${phase} ${phase === "complete" ? 2 : phase === "verify" ? 1 : 0}/2\n`,
          );
      },
    });
  },
});
cloudCli.command("logout", {
  description: "Remove this workstation's saved cloud login.",
  options: z.object({
    endpoint: z.string().optional().describe("Cloud library URL; otherwise DJBOOTH_CLOUD_URL"),
  }),
  async run(c) {
    const endpoint = c.options.endpoint ?? process.env.DJBOOTH_CLOUD_URL;
    if (!endpoint) throw new Error("Provide --endpoint or DJBOOTH_CLOUD_URL");
    await forgetCloudLogin(cloudEndpoint(endpoint));
    return { signedOut: true };
  },
});

cloudCli.command("migrate-legacy", {
  description:
    "Copy the operator-assigned pre-login library, recordings, backups and import history into your signed-in account.",
  hint: "Requires explicit LEGACY_LIBRARY_OWNER assignment by the operator. Rerun to resume; archived originals and newer account edits are preserved.",
  options: z.object({
    endpoint: z.string().optional().describe("Cloud library URL; otherwise DJBOOTH_CLOUD_URL"),
    dryRun: z
      .boolean()
      .default(false)
      .describe("Inspect the assigned migration without copying data"),
    progress: z.enum(["auto", "always", "never"]).default("auto").describe("Progress on stderr"),
  }),
  async run(c) {
    const value = c.options.endpoint ?? process.env.DJBOOTH_CLOUD_URL;
    if (!value) throw new Error("Provide --endpoint or DJBOOTH_CLOUD_URL");
    const endpoint = cloudEndpoint(value);
    const token = await savedCloudToken(endpoint);
    if (!token) throw new Error("Run cloud login before migrating your library");
    const { migrateCloudLegacy } = await import("./cloud-migrate.js");
    return migrateCloudLegacy({
      endpoint,
      token,
      dryRun: c.options.dryRun,
      ...(c.options.progress === "always" || (c.options.progress === "auto" && process.stderr.isTTY)
        ? {
            onProgress: (phase: string, current: number, total: number) =>
              process.stderr.write(`cloud migrate ${phase} ${current}/${total}\n`),
          }
        : {}),
    });
  },
});
