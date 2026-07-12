import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  getRekordboxAgentPid,
  getRekordboxPid,
  version as rekordboxVersion,
} from "@gakonst/rekordbox";
import rekordboxCli from "@gakonst/rekordbox/cli";
import soundcloudCli from "@gakonst/soundcloud/cli";
import { FileSessionStore } from "@gakonst/spots";
import spotsCli from "@gakonst/spots/cli";
import { createManifest, identify, type MediaMetadataClient } from "@gakonst/tracks";
import tracksCli from "@gakonst/tracks/cli";
import { ExtractorRegistry, ReferenceClient } from "@gakonst/ytdlp-ts";
import ytdlpCli from "@gakonst/ytdlp-ts/cli";
import { Cli, z } from "incur";
import { SoulseekClient } from "slsk-ts";
import slskCli from "slsk-ts/cli";

export const MUSIC_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

export const MUSIC_MCP_TOOL_FILTER = {
  include: [
    "tracks_*",
    "spots_auth_status",
    "spots_me",
    "spots_recent",
    "spots_request",
    "spots_session",
    "spots_api_search",
    "spots_api_get-track",
    "spots_api_get-several-tracks",
    "spots_api_get-playlist",
    "spots_api_get-playlists-items",
    "soundcloud_auth_status",
    "soundcloud_resolve",
    "soundcloud_search_*",
    "soundcloud_request",
    "soundcloud_api_get-tracks*",
    "slsk_info",
    "slsk_search",
    "slsk_download",
    "ytdlp_engines",
    "ytdlp_inspect",
    "ytdlp_formats",
    "ytdlp_music",
    "ytdlp_download",
    "rekordbox_status",
    "rekordbox_analyze_*",
    "rekordbox_db_info",
    "rekordbox_db_search",
    "rekordbox_db_content_*",
    "rekordbox_db_metadata_add",
    "rekordbox_db_playlist_*",
  ],
};

export type ResolveTracksOptions = {
  provider: "auto" | "description" | "1001tracklists" | "audd" | "acrcloud";
  cacheMode: "default" | "refresh" | "off";
  env: Record<string, string | undefined>;
};

export type SoulseekSearchOptions = {
  username: string;
  password: string;
  server: string;
  listenPort: number;
  timeoutMs: number;
  maxResults: number;
};

export type YtdlpInspectOptions = {
  playlist: boolean;
  flatPlaylist: boolean;
};

export type MusicCliDependencies = {
  resolveTracks(source: string, options: ResolveTracksOptions): Promise<unknown>;
  spotifySession(path?: string): Promise<unknown>;
  searchSoulseek(query: string, options: SoulseekSearchOptions): Promise<unknown>;
  ytdlpEngines(): Promise<unknown>;
  inspectYtdlp(url: string, options: YtdlpInspectOptions): Promise<unknown>;
  rekordboxStatus(): unknown | Promise<unknown>;
};

export function createDefaultMusicDependencies(): MusicCliDependencies {
  const metadataClient = createYtdlpMetadataClient();
  return {
    async resolveTracks(source, options) {
      const tracklist = await identify(source, {
        provider: options.provider,
        cacheMode: options.cacheMode,
        env: options.env,
        metadataClient,
      });
      return createManifest(tracklist);
    },
    async spotifySession(path) {
      const store = new FileSessionStore(path);
      const session = await store.load();
      if (!session) return { loggedIn: false, credentialsPath: store.path };
      return {
        loggedIn: true,
        credentialsPath: store.path,
        clientId: session.clientId,
        redirectUri: session.redirectUri,
        expiresAt: new Date(session.token.expiresAt).toISOString(),
        scopes: session.token.scopes,
      };
    },
    async searchSoulseek(query, options) {
      const client = new SoulseekClient({
        server: parseServerAddress(options.server),
        listenPort: options.listenPort,
      });
      try {
        await client.connect(options.username, options.password);
        return jsonSafe(
          await client.search(query, {
            timeout: options.timeoutMs,
            maxResults: options.maxResults,
          }),
        );
      } finally {
        await client.disconnect();
      }
    },
    async ytdlpEngines() {
      const reference = new ReferenceClient();
      const native = { available: true, extractors: new ExtractorRegistry().list() };
      try {
        return {
          native,
          reference: {
            available: true,
            binary: reference.binary,
            version: await reference.version(),
          },
        };
      } catch (error) {
        return {
          native,
          reference: {
            available: false,
            binary: reference.binary,
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
    async inspectYtdlp(url, options) {
      return {
        engine: "reference",
        info: await new ReferenceClient().inspect(url, {
          playlist: options.playlist,
          flatPlaylist: options.flatPlaylist,
        }),
      };
    },
    rekordboxStatus() {
      return {
        version: rekordboxVersion,
        runtime: process.version,
        rekordboxPid: getRekordboxPid(),
        rekordboxAgentPid: getRekordboxAgentPid(),
      };
    },
  };
}

export function createYtdlpMetadataClient(): MediaMetadataClient {
  return {
    async inspect(source, options = {}) {
      const info = await new ReferenceClient(options.env?.YTDLP_TS_REFERENCE_BINARY).inspect(
        source,
        {
          playlist: false,
          ...(options.cookies ? { cookies: options.cookies } : {}),
          ...(options.cookiesFromBrowser ? { cookiesFromBrowser: options.cookiesFromBrowser } : {}),
        },
      );
      return {
        id: info.id,
        title: info.title,
        ...(typeof info.description === "string" ? { description: info.description } : {}),
        ...(info.duration === undefined ? {} : { durationSeconds: info.duration }),
        ...(info.webpage_url ? { webpageUrl: info.webpage_url } : {}),
        ...(info.uploader ? { uploader: info.uploader } : {}),
        ...(info.extractor_key
          ? { extractor: info.extractor_key }
          : info.extractor
            ? { extractor: info.extractor }
            : {}),
      };
    },
  };
}

const tracksEnvironment = z.object({
  PARSE_API_KEY: z.string().optional().describe("Parse API key for 1001Tracklists"),
  PARSE_API_BASE: z.string().optional().describe("Parse API endpoint override"),
  PARSE_SCRAPER_ID: z.string().optional().describe("Parse scraper ID override"),
  AUDD_API_TOKEN: z.string().optional().describe("AudD API token"),
  ACR_HOST: z.string().optional().describe("ACRCloud host"),
  ACR_ACCESS_KEY: z.string().optional().describe("ACRCloud access key"),
  ACR_ACCESS_SECRET: z.string().optional().describe("ACRCloud access secret"),
  YTDLP_TS_PATH: z.string().optional().describe("ytdlp-ts executable override"),
  FFMPEG_PATH: z.string().optional().describe("ffmpeg executable"),
  FFPROBE_PATH: z.string().optional().describe("ffprobe executable"),
});

const soulseekEnvironment = z.object({
  SLSK_USERNAME: z.string().min(1).describe("Soulseek username"),
  SLSK_PASSWORD: z.string().min(1).describe("Soulseek password"),
  SLSK_SERVER: z.string().default("server.slsknet.org:2242").describe("Soulseek host:port"),
  SLSK_LISTEN_PORT: z.coerce
    .number()
    .int()
    .min(0)
    .max(65_535)
    .default(0)
    .describe("Inbound peer port"),
});

export function createMusicCli(
  overrides: Partial<MusicCliDependencies> = {},
): ReturnType<typeof Cli.create> {
  const dependencies = { ...createDefaultMusicDependencies(), ...overrides };
  const cli = Cli.create("music", {
    version: MUSIC_VERSION,
    description: "Unified metadata, acquisition, and DJ-library tools.",
    hint: "Local CodeMode MCP: music --codemode-mcp",
    mcp: {
      instructions:
        "Compose metadata resolution, provider lookup, individual-track acquisition, analysis, and normal Rekordbox database operations. Inspect before downloading; require explicit write acknowledgement for database mutations.",
      tools: MUSIC_MCP_TOOL_FILTER,
    },
    sync: {
      depth: 0,
      include: [resolve(import.meta.dirname, "../skills/*")],
      suggestions: [
        "resolve a DJ set into tracks",
        "check my Spotify session",
        "search Soulseek for a track",
        "inspect a YouTube or SoundCloud URL",
        "check whether Rekordbox is running",
      ],
    },
  });

  if (Object.keys(overrides).length === 0) {
    cli.command(tracksCli);
    cli.command(spotsCli);
    cli.command(soundcloudCli);
    cli.command(slskCli);
    cli.command(ytdlpCli);
    cli.command(rekordboxCli);
    return cli;
  }

  const tracks = Cli.create("tracks", {
    description: "Resolve DJ sets into durable track manifests.",
  }).command("resolve", {
    description: "Resolve a media or 1001Tracklists source without downloading a remote set.",
    args: z.object({
      source: z.string().min(1).describe("Media URL, tracklist URL, or local path"),
    }),
    env: tracksEnvironment,
    options: z.object({
      provider: z
        .enum(["auto", "description", "1001tracklists", "audd", "acrcloud"])
        .default("auto")
        .describe("Resolution provider"),
      cacheMode: z
        .enum(["default", "refresh", "off"])
        .default("default")
        .describe("Use, refresh, or bypass provider caches"),
    }),
    run: ({ args, env, options }) =>
      dependencies.resolveTracks(args.source, {
        provider: options.provider,
        cacheMode: options.cacheMode,
        env,
      }),
  });

  const spots = Cli.create("spots", {
    description: "Inspect Spotify authentication state without exposing tokens.",
  }).command("session", {
    description: "Show the saved Spotify session metadata.",
    env: z.object({
      SPOTS_CREDENTIALS_PATH: z.string().optional().describe("Spotify credential file"),
    }),
    options: z.object({
      path: z.string().optional().describe("Credential file override"),
    }),
    run: ({ env, options }) =>
      dependencies.spotifySession(options.path ?? env.SPOTS_CREDENTIALS_PATH),
  });

  const slsk = Cli.create("slsk", {
    description: "Search Soulseek for individual recordings.",
  }).command("search", {
    description: "Connect, run one bounded search, and disconnect.",
    args: z.object({ query: z.string().min(1).describe("Track search query") }),
    env: soulseekEnvironment,
    options: z.object({
      timeout: z.number().positive().default(8).describe("Collection window in seconds"),
      maxResults: z.number().int().positive().default(100).describe("Maximum peer result sets"),
    }),
    run: ({ args, env, options }) =>
      dependencies.searchSoulseek(args.query, {
        username: env.SLSK_USERNAME,
        password: env.SLSK_PASSWORD,
        server: env.SLSK_SERVER,
        listenPort: env.SLSK_LISTEN_PORT,
        timeoutMs: options.timeout * 1000,
        maxResults: options.maxResults,
      }),
  });

  const ytdlp = Cli.create("ytdlp", {
    description: "Inspect YouTube and SoundCloud through ytdlp-ts.",
  });
  ytdlp.command("engines", {
    description: "Report native extractors and reference-engine availability.",
    run: () => dependencies.ytdlpEngines(),
  });
  ytdlp.command("inspect", {
    description: "Read media metadata without downloading media bytes.",
    args: z.object({ url: z.url().describe("YouTube or SoundCloud URL") }),
    options: z.object({
      playlist: z.boolean().default(false).describe("Resolve playlist entries"),
      flatPlaylist: z.boolean().default(false).describe("Keep playlist entries flat"),
    }),
    run: ({ args, options }) => dependencies.inspectYtdlp(args.url, options),
  });

  const rekordbox = Cli.create("rekordbox", {
    description: "Inspect the local Rekordbox runtime without opening a database.",
  }).command("status", {
    description: "Show package/runtime versions and Rekordbox process IDs.",
    run: () => dependencies.rekordboxStatus(),
  });

  cli.command(tracks);
  cli.command(spots);
  cli.command(slsk);
  cli.command(ytdlp);
  cli.command(rekordbox);
  return cli;
}

export async function runMusicCli(argv = process.argv.slice(2)): Promise<void> {
  const cli = createMusicCli();
  if (argv.length === 1 && argv[0] === "--codemode-mcp") {
    const { serveLocalMusicCodeMcp } = await import("./mcp.js");
    await serveLocalMusicCodeMcp({ cli });
    return;
  }
  await cli.serve(argv);
}

function parseServerAddress(value: string): { host: string; port: number } {
  const separator = value.lastIndexOf(":");
  if (separator < 1) throw new TypeError("SLSK_SERVER must use host:port format");
  const host = value.slice(0, separator);
  const port = Number(value.slice(separator + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("Invalid Soulseek server port");
  }
  return { host, port };
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, jsonSafe(nested)]),
    );
  }
  return value;
}
