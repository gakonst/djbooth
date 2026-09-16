import { AuthError, CONNECT_API, CONNECT_APP_ID, credential, type Account } from "./auth.js";
import type { Env } from "./index.js";
import { imports } from "./imports.js";

type Provider = "spotify" | "soundcloud";
type Wire = Record<string, unknown>;
const record = (value: unknown): Wire =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Wire) : {};
const list = (value: unknown): Wire[] => (Array.isArray(value) ? value.map(record) : []);
const string = (value: unknown): string => (typeof value === "string" ? value : "");
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
const json = (body: unknown) =>
  Response.json(body, { headers: { "cache-control": "private, no-store" } });
export interface MusicSource {
  id: string;
  provider: Provider;
  connectionID: string;
  accountID: string;
  label: string;
}
export interface MusicTrack {
  id: string;
  remoteID: string;
  title: string;
  artists: string[];
  album?: string;
  durationSeconds: number;
  url: string;
  isrc?: string;
  available: boolean;
}
export interface MusicPlaylist {
  id: string;
  remoteID: string;
  sourceID: string;
  name: string;
  url: string;
  trackCount: number;
}
const providerHost = (provider: Provider) =>
  provider === "spotify" ? "api.spotify.com" : "api.soundcloud.com";

/** Only fixed provider routes leave this BFF. The broker enforces the grant's exact account selection. */
async function connect(request: Request, env: Env, path: string, body?: unknown): Promise<unknown> {
  const token = credential(request)?.split(".")[2];
  if (!token) throw new AuthError(401, "Sign in to Nanocodex.");
  const upstream = new Request(`${CONNECT_API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      origin: new URL(request.url).origin,
      "x-nanocodex-app-id": CONNECT_APP_ID,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  const response = await (env.CONNECT_API_SERVICE
    ? env.CONNECT_API_SERVICE.fetch(upstream)
    : fetch(upstream));
  if (!response.ok) {
    if (response.status === 429)
      throw new AuthError(
        429,
        `Music service is busy. Retry after ${response.headers.get("retry-after") ?? "30"} seconds.`,
      );
    throw new AuthError(
      response.status >= 400 && response.status < 500 ? response.status : 502,
      "The music service could not complete this request. Check your connector or retry.",
    );
  }
  return response.json();
}
export async function musicSources(
  request: Request,
  env: Env,
  account: Account,
): Promise<MusicSource[]> {
  if (!account.capabilities.some((v) => v === "spotify" || v === "soundcloud")) return [];
  // Public music requests already received this live projection during grant
  // authentication. Internal callers still validate directly with the issuer.
  const connectors =
    account.musicConnectors ??
    record(
      record(
        await connect(
          request,
          env,
          `/v1/grants/${encodeURIComponent(account.grantId)}/connectors?providers=spotify,soundcloud`,
        ),
      ).connectors,
    );
  return (["spotify", "soundcloud"] as const).flatMap((provider) => {
    if (!account.capabilities.includes(provider)) return [];
    return list(record(connectors[provider]).connections).flatMap((connection) => {
      const connectionID = string(connection.id);
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(connectionID)) return [];
      return [
        {
          id: `${provider}:${connectionID}`,
          provider,
          connectionID,
          accountID: string(connection.account_id),
          label: string(connection.label) || (provider === "spotify" ? "Spotify" : "SoundCloud"),
        },
      ];
    });
  });
}
async function providerRead(
  request: Request,
  env: Env,
  source: MusicSource,
  path: string,
): Promise<Wire> {
  return record(
    await connect(request, env, `/v1/connectors/${source.provider}/request`, {
      path,
      method: "GET",
      connection_id: source.connectionID,
    }),
  );
}
function playlist(source: MusicSource, item: Wire): MusicPlaylist | undefined {
  const remoteID =
    source.provider === "spotify" ? string(item.id) : string(item.urn) || String(item.id ?? "");
  const name = string(item.name) || string(item.title);
  if (!remoteID || !name) return;
  return {
    id: `connected:${source.id}:playlist:${remoteID}`,
    remoteID,
    sourceID: source.id,
    name,
    url:
      source.provider === "spotify"
        ? `https://open.spotify.com/playlist/${remoteID}`
        : string(item.permalink_url),
    trackCount:
      source.provider === "spotify"
        ? count(record(item.items ?? item.tracks).total)
        : count(item.track_count),
  };
}
function track(source: MusicSource, item: Wire): MusicTrack | undefined {
  const spotify = source.provider === "spotify";
  const remoteID = spotify ? string(item.id) : string(item.urn) || String(item.id ?? "");
  const title = string(item.name) || string(item.title);
  if (!remoteID || !title || item.type === "episode" || item.is_local === true) return;
  const artists = spotify
    ? list(item.artists)
        .map((v) => string(v.name))
        .filter(Boolean)
    : [string(item.metadata_artist) || string(record(item.user).username)].filter(Boolean);
  return {
    id: `connected:${source.id}:track:${remoteID}`,
    remoteID,
    title,
    artists,
    ...(string(record(item.album).name) ? { album: string(record(item.album).name) } : {}),
    durationSeconds: count(item.duration_ms ?? item.duration) / 1000,
    url: spotify ? `https://open.spotify.com/track/${remoteID}` : string(item.permalink_url),
    ...(string(record(item.external_ids).isrc ?? item.isrc)
      ? { isrc: string(record(item.external_ids).isrc ?? item.isrc) }
      : {}),
    available: spotify
      ? item.is_playable !== false
      : item.access !== "blocked" && item.access !== "preview" && item.streamable !== false,
  };
}
/** Never follow a provider's next link to a new host or endpoint. */
export function pagePath(
  value: string,
  provider: Provider,
  pathname: string,
  accountID?: string,
): string {
  const url = new URL(value, `https://${providerHost(provider)}`);
  // Spotify canonicalizes /me/playlists to this exact connected user's endpoint.
  if (
    provider === "spotify" &&
    pathname === "/v1/me/playlists" &&
    accountID &&
    url.pathname === `/v1/users/${encodeURIComponent(accountID)}/playlists`
  )
    url.pathname = pathname;
  if (
    url.protocol !== "https:" ||
    url.host !== providerHost(provider) ||
    url.username ||
    url.password ||
    url.pathname !== pathname ||
    url.hash
  )
    throw new AuthError(502, "Invalid music pagination response.");
  const fields =
    provider === "soundcloud"
      ? ["limit", "offset", "cursor", "linked_partitioning", "page_size"]
      : ["limit", "offset"];
  if ([...url.searchParams.keys()].some((key) => !fields.includes(key)))
    throw new AuthError(502, "Invalid music pagination parameters.");
  return `${url.pathname}${url.search}`;
}
async function snapshot(request: Request, env: Env, source: MusicSource, id: string) {
  const base = `${source.provider === "spotify" ? "/v1" : ""}/playlists/${encodeURIComponent(id)}`;
  const info = await providerRead(request, env, source, base);
  const metadata = playlist(source, info);
  if (!metadata) throw new AuthError(502, "Playlist metadata is unavailable.");
  const tracks: MusicTrack[] = [];
  if (source.provider === "spotify") {
    const path = `${base}/items`;
    let next: string | undefined = `${path}?limit=100&offset=0`;
    const seen = new Set<string>();
    while (next) {
      if (seen.has(next) || tracks.length >= 10000)
        throw new AuthError(502, "Playlist pagination did not finish.");
      seen.add(next);
      const page = await providerRead(request, env, source, next);
      tracks.push(
        ...list(page.items).flatMap((entry) => {
          const value = track(source, record(entry.item ?? entry.track));
          return value ? [value] : [];
        }),
      );
      next = page.next ? pagePath(string(page.next), source.provider, path) : undefined;
    }
  } else {
    for (let item of list(info.tracks)) {
      if (!item.title)
        item = await providerRead(
          request,
          env,
          source,
          `/tracks/${encodeURIComponent(string(item.urn) || String(item.id ?? ""))}`,
        );
      const value = track(source, item);
      if (value) tracks.push(value);
      if (tracks.length > 10000) throw new AuthError(413, "Playlist is too large.");
    }
  }
  return { playlist: metadata, tracks, fetchedAt: Date.now() / 1000 };
}
// Ephemeral signed URLs only. Authentication and exact connector approval are
// checked by musicRoute on EVERY request, including cache hits. No audio is cached.
export class SoundCloudStreamCache {
  private readonly entries = new Map<string, { expiresAt: number; value: Promise<string> }>();
  constructor(
    private readonly ttl = 15_000,
    private readonly capacity = 128,
  ) {}
  get(key: string, resolve: () => Promise<string>): Promise<string> {
    const now = Date.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
    const cached = this.entries.get(key);
    if (cached) return cached.value;
    while (this.entries.size >= this.capacity)
      this.entries.delete(this.entries.keys().next().value!);
    const entry = { expiresAt: now + this.ttl, value: Promise.resolve().then(resolve) };
    this.entries.set(key, entry);
    entry.value = entry.value.catch((error: unknown) => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    });
    return entry.value;
  }
}
const soundCloudStreams = new SoundCloudStreamCache();
async function soundCloudStream(
  request: Request,
  env: Env,
  source: MusicSource,
  id: string,
): Promise<string> {
  const [info, streams] = await Promise.all([
    providerRead(request, env, source, `/tracks/${encodeURIComponent(id)}`),
    providerRead(request, env, source, `/tracks/${encodeURIComponent(id)}/streams`),
  ]);
  if (!track(source, info)?.available)
    throw new AuthError(403, "SoundCloud does not allow full playback of this track.");
  const value = [
    streams.hls_aac_160_url,
    streams.hls_aac_96_url,
    streams.hls_mp3_128_url,
    streams.http_mp3_128_url,
  ]
    .map(string)
    .find(Boolean);
  if (!value) throw new AuthError(403, "SoundCloud does not provide a full stream for this track.");
  let stream: URL;
  try {
    stream = new URL(value);
  } catch {
    throw new AuthError(502, "SoundCloud did not return a playable stream.");
  }
  if (
    stream.origin === "https://api.soundcloud.com" &&
    !stream.search &&
    !stream.hash &&
    /^\/tracks\/(?:soundcloud(?::|%3A)tracks(?::|%3A))?\d+\/streams\/[A-Za-z0-9-]+\/(hls|http)$/i.test(
      stream.pathname,
    )
  ) {
    const resolved = record(
      await connect(request, env, "/v1/connectors/soundcloud/stream", {
        path: stream.pathname,
        connection_id: source.connectionID,
      }),
    );
    try {
      stream = new URL(string(resolved.url));
    } catch {
      throw new AuthError(502, "SoundCloud did not return a playable stream.");
    }
  }
  if (
    stream.protocol !== "https:" ||
    !(
      stream.hostname.endsWith(".sndcdn.com") ||
      stream.hostname === "playback.media-streaming.soundcloud.cloud"
    ) ||
    stream.username ||
    stream.password ||
    stream.port ||
    stream.hash ||
    [...stream.searchParams.keys()].some((name) =>
      /^(oauth_token|access_token|refresh_token|client_secret)$/i.test(name),
    )
  )
    throw new AuthError(502, "SoundCloud did not return a playable stream.");
  return stream.href;
}
export async function musicRoute(
  request: Request,
  env: Env,
  account: Account,
  readJSON: (r: Request) => Promise<unknown>,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/v1/music/sources" && request.method === "GET")
    return json({ sources: await musicSources(request, env, account) });
  const match =
    /^\/v1\/music\/(spotify|soundcloud)\/([A-Za-z0-9_-]{1,256})\/(playlists|tracks)(?:\/([^/]+)(?:\/(download|stream))?)?$/.exec(
      url.pathname,
    );
  if (!match) throw new AuthError(404, "Music route not found.");
  const id = match[4] ? decodeURIComponent(match[4]) : undefined;
  if (id && !/^[A-Za-z0-9:_-]{1,256}$/.test(id)) throw new AuthError(400, "Invalid music ID.");
  if (
    match[1] === "soundcloud" &&
    match[3] === "tracks" &&
    id &&
    match[5] === "stream" &&
    request.method === "GET"
  ) {
    if (!account.capabilities.includes("soundcloud"))
      throw new AuthError(403, "This music account is not connected or approved.");
    const requested: MusicSource = {
      id: `soundcloud:${match[2]}`,
      provider: "soundcloud",
      connectionID: match[2],
      accountID: "",
      label: "",
    };
    const resolve = () => soundCloudStream(request, env, requested, id);
    const cacheKey = JSON.stringify([account.id, account.grantId, requested.connectionID, id]);
    const force = /(?:^|,)\s*(?:no-cache|no-store)\b/i.test(
      request.headers.get("cache-control") ?? "",
    );
    // Each provider request independently enforces the exact opted-in connection
    // at the broker. The separate account check can therefore run alongside it,
    // and must still succeed before returning a URL, including on cache hits.
    const [sources, stream] = await Promise.all([
      musicSources(request, env, account),
      force ? resolve() : soundCloudStreams.get(cacheKey, resolve),
    ]);
    if (
      !sources.some(
        (source) =>
          source.provider === "soundcloud" && source.connectionID === requested.connectionID,
      )
    )
      throw new AuthError(403, "This music account is not connected or approved.");
    return json({ url: stream });
  }
  const sources = await musicSources(request, env, account);
  const source = sources.find((v) => v.provider === match[1] && v.connectionID === match[2]);
  if (!source) throw new AuthError(403, "This music account is not connected or approved.");
  if (match[3] === "playlists" && !id && request.method === "GET") {
    const path = source.provider === "spotify" ? "/v1/me/playlists" : "/me/playlists";
    const cursor = url.searchParams.get("cursor");
    const page = await providerRead(
      request,
      env,
      source,
      cursor
        ? pagePath(cursor, source.provider, path, source.accountID)
        : `${path}?limit=50${source.provider === "soundcloud" ? "&linked_partitioning=true" : ""}`,
    );
    const next = string(page.next ?? page.next_href);
    return json({
      playlists: list(page.items ?? page.collection).flatMap((v) => {
        const value = playlist(source, v);
        return value ? [value] : [];
      }),
      next: next ? pagePath(next, source.provider, path, source.accountID) : null,
    });
  }
  if (match[3] === "playlists" && id && !match[5] && request.method === "GET")
    return json(await snapshot(request, env, source, id));
  if (match[3] === "playlists" && id && match[5] === "download" && request.method === "POST") {
    const body = record(await readJSON(request));
    if (!/^[a-f0-9-]{36}$/i.test(string(body.id)))
      throw new AuthError(400, "Invalid download request ID.");
    const value = await snapshot(request, env, source, id);
    if (!value.tracks.length)
      throw new AuthError(422, "This playlist has no available track metadata.");
    const input = {
      provider: source.provider,
      id: value.playlist.remoteID,
      title: value.playlist.name,
      url: value.playlist.url,
      tracks: value.tracks.map((v, i) => ({
        provider: source.provider,
        order: i + 1,
        title: v.title,
        artists: v.artists.length ? v.artists : ["Unknown artist"],
        ...(v.album ? { album: v.album } : {}),
        ...(v.durationSeconds > 0 ? { durationMs: Math.round(v.durationSeconds * 1000) } : {}),
        ...(v.isrc ? { isrc: v.isrc } : {}),
        ...(source.provider === "spotify"
          ? { id: v.remoteID, uri: `spotify:track:${v.remoteID}`, url: v.url }
          : { urn: v.remoteID, permalinkUrl: v.url }),
      })),
    };
    // Immutable input artifact. master.db remains the workflow's durable state.
    const existing = await env.LIBRARY_DB.prepare(
      "SELECT id, source FROM import_requests WHERE account_id=? AND (id=? OR source=?) ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1",
    )
      .bind(account.id, body.id, input.url, body.id)
      .first<{ id: string; source: string }>();
    if (existing && existing.source !== input.url)
      throw new AuthError(409, "Request ID belongs to another playlist.");
    const key = `connected-playlists/${account.id}/${existing?.id ?? body.id}.json`;
    const encoded = JSON.stringify(input);
    if (encoded.length > 8 * 1024 * 1024)
      throw new AuthError(413, "Playlist metadata is too large.");
    const prior = await env.MEDIA.get(key);
    if (prior) {
      const old = await prior.json<{ url: string }>();
      if (old.url !== input.url)
        throw new AuthError(409, "Request ID belongs to another playlist.");
    } else await env.MEDIA.put(key, encoded, { onlyIf: { etagDoesNotMatch: "*" } });
    return imports(
      new Request(new URL("/v1/imports", request.url), {
        method: "POST",
        headers: request.headers,
      }),
      env,
      account,
      async () => ({ id: body.id, source: input.url }),
    );
  }
  throw new AuthError(405, "Method not allowed.");
}
