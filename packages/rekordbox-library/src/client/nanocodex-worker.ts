/// <reference lib="webworker" />

import { Agent } from "nanocodex/browser";
import type { DefaultAgent, ToolMap, Turn } from "nanocodex";

import type {
  HotCueSlot,
  PlaylistItem,
  PromptAction,
  PromptPlan,
  TrackCueInput,
  TrackSummary,
  TracksResponse,
} from "../shared/types.js";
import type {
  NanocodexLibraryContext,
  NanocodexWorkerCommand,
  NanocodexWorkerMessage,
} from "./nanocodex-protocol.js";
import {
  isSemanticDiscoveryRequest,
  modelTrack,
  resolveTemporaryCrateTracks,
  selectLibraryCandidates,
  summarizeLibraryCatalog,
} from "./semantic-library.js";

const worker = self as DedicatedWorkerGlobalScope;
let agent: DefaultAgent | undefined;
let activeContext: NanocodexLibraryContext | undefined;
let activeActions: PromptAction[] = [];
let activePlanId: string | undefined;
let activeDiscoveryIntent = false;
let catalogCache: { loadedAt: number; tracks: TrackSummary[] } | undefined;
let commands = Promise.resolve();

worker.onmessage = ({ data }: MessageEvent<NanocodexWorkerCommand>) => {
  commands = commands
    .then(() => handle(data))
    .catch((error) => {
      post({
        type: "error",
        ...(data.type === "plan" ? { id: data.id } : {}),
        message: errorMessage(error),
      });
    });
};

async function handle(command: NanocodexWorkerCommand): Promise<void> {
  if (command.type === "start") {
    if (agent) return;
    const created = await Agent.create({
      apiKey: "host-managed",
      websocketUrl: responsesEndpoint(),
      createWebSocket(endpoint: string, sessionId: string) {
        const url = new URL(endpoint);
        url.searchParams.set("session_id", sessionId);
        return new WebSocket(url);
      },
      instructions: `You are the command planner inside a Rekordbox library workstation.
Use the supplied planning tools to turn the user's request into bounded application actions.
Never claim that an action happened: tools only stage a plan which the application validates and executes.
Use Code Mode to compose multi-step requests. Fan out independent tool calls with Promise.all; keep dependent or explicitly ordered actions sequential.
For mood, vibe, occasion, energy, warm-up, set-building, or recommendation requests, NEVER use searchTracks. Inspect the library, retrieve structured candidates, curate an ordered selection, then show one temporary crate. A semantic crate normally contains 12–30 tracks.
Use searchTracks only for a literal title, artist, album, filename, or other text the user expects to appear in track metadata.
Use IDs exactly as supplied in the current context. Prefer one action; use multiple only when explicitly requested.
Do not use tools for unsupported destructive operations. If the request cannot be represented, explain why without calling a tool.`,
      thinking: "medium",
      tools: planningTools(),
    });
    agent = created;
    const watch = created.events.watch();
    watch.onEvent((event) =>
      post({ type: "event", ...(activePlanId ? { id: activePlanId } : {}), event }),
    );
    post({ type: "ready" });
    return;
  }

  if (!agent) throw new Error("Nanocodex is not ready");
  activeContext = command.context;
  activeActions = [];
  activePlanId = command.id;
  activeDiscoveryIntent = isSemanticDiscoveryRequest(command.prompt);
  let turn: Turn | undefined;
  try {
    turn = agent.turn.prompt({ input: plannerPrompt(command.prompt, command.context) });
    const result = await turn.result();
    const plan: PromptPlan = {
      id: command.id,
      prompt: command.prompt,
      summary: result.finalMessage.trim() || summarizeActions(activeActions),
      actions: [...activeActions],
    };
    post({ type: "result", id: command.id, plan });
  } finally {
    turn?.dispose();
    activeContext = undefined;
    activeActions = [];
    activePlanId = undefined;
    activeDiscoveryIntent = false;
  }
}

function planningTools(): ToolMap {
  return {
    openPlaylist: {
      description: "Stage opening one existing playlist by its exact supplied ID.",
      parameters: objectSchema({ playlistId: stringSchema() }, ["playlistId"]),
      handler(input) {
        const playlist = requirePlaylist(stringField(input, "playlistId"));
        stage({
          type: "open-playlist",
          playlistId: playlist.id,
          label: `Open “${playlist.name}”`,
        });
        return { staged: true, playlist: playlist.name };
      },
    },
    searchTracks: {
      description:
        "Stage a literal metadata substring search for a known title, artist, album, or filename. Never use for moods, vibes, occasions, energy, recommendations, warm-ups, or set building.",
      parameters: objectSchema({ query: stringSchema() }, ["query"]),
      handler(input) {
        if (activeDiscoveryIntent)
          throw new TypeError(
            "This is a semantic discovery request. Use inspectLibrary, findLibraryCandidates, and showTemporaryCrate instead of literal search.",
          );
        const query = stringField(input, "query").trim();
        if (!query) throw new TypeError("Search query cannot be empty");
        stage({ type: "search-tracks", query, label: `Search for “${query}”` });
        return { staged: true, query };
      },
    },
    inspectLibrary: {
      description:
        "Inspect bounded local-library genre counts and BPM distribution before curating tracks for a mood, occasion, energy profile, warm-up, or DJ set.",
      parameters: objectSchema({}, []),
      async handler() {
        return summarizeLibraryCatalog(await libraryCatalog());
      },
    },
    findLibraryCandidates: {
      description:
        "Return real playable local tracks for semantic curation. Choose genre terms from inspectLibrary and infer an appropriate BPM window from the user's intent. This reads candidates; it does not stage a UI action.",
      parameters: objectSchema(
        {
          bpmMin: { type: "number", minimum: 30, maximum: 300 },
          bpmMax: { type: "number", minimum: 30, maximum: 300 },
          genreTerms: stringArraySchema(12),
          textTerms: stringArraySchema(12),
          limit: { type: "integer", minimum: 8, maximum: 120 },
        },
        [],
      ),
      async handler(input) {
        const record = objectValue(input);
        const bpmMin = optionalNumberField(record, "bpmMin");
        const bpmMax = optionalNumberField(record, "bpmMax");
        if (bpmMin !== undefined && bpmMax !== undefined && bpmMin > bpmMax)
          throw new RangeError("bpmMin must be less than or equal to bpmMax");
        const candidates = selectLibraryCandidates(await libraryCatalog(), {
          ...(bpmMin === undefined ? {} : { bpmMin }),
          ...(bpmMax === undefined ? {} : { bpmMax }),
          genreTerms: stringArrayField(record, "genreTerms"),
          textTerms: stringArrayField(record, "textTerms"),
          ...(optionalNumberField(record, "limit") === undefined
            ? {}
            : { limit: optionalNumberField(record, "limit") }),
        });
        return {
          count: candidates.length,
          tracks: candidates.map(modelTrack),
          guidance:
            "Choose an ordered 12–30 track subset and pass only its IDs to showTemporaryCrate.",
        };
      },
    },
    showTemporaryCrate: {
      description:
        "Stage a temporary, non-destructive crate of real candidate IDs for auditioning. Use after inspecting and finding candidates; order IDs as a useful musical progression.",
      parameters: objectSchema(
        {
          name: stringSchema(),
          description: stringSchema(),
          trackIds: stringArraySchema(50, 3),
        },
        ["name", "description", "trackIds"],
      ),
      async handler(input) {
        const name = stringField(input, "name").trim();
        const description = stringField(input, "description").trim();
        const trackIds = stringArrayField(objectValue(input), "trackIds");
        const tracks = resolveTemporaryCrateTracks(await libraryCatalog(), trackIds);
        if (tracks.length < 3)
          throw new RangeError("A temporary crate needs at least three tracks");
        stage({
          type: "show-temporary-crate",
          name,
          description,
          tracks,
          label: `Open temporary crate “${name}” (${String(tracks.length)} tracks)`,
        });
        return { staged: true, name, trackCount: tracks.length };
      },
    },
    showSetCanvas: {
      description: "Stage opening the visual set canvas for the current playlist.",
      parameters: objectSchema({}, []),
      handler() {
        requireCurrentPlaylist();
        stage({ type: "show-canvas", label: "Open set canvas" });
        return { staged: true };
      },
    },
    createPlaylist: {
      description: "Stage creation of a Rekordbox playlist or folder. Requires write access.",
      parameters: objectSchema(
        {
          name: stringSchema(),
          kind: { type: "string", enum: ["playlist", "folder"] },
          parentId: stringSchema(),
        },
        ["name", "kind"],
      ),
      handler(input) {
        requireWritable();
        const name = stringField(input, "name").trim();
        const kind = optionalStringField(input, "kind") === "folder" ? "folder" : "playlist";
        const parentId = optionalStringField(input, "parentId");
        if (parentId) requirePlaylist(parentId, true);
        stage({
          type: "mutate",
          mutation: { type: "create-playlist", name, kind, ...(parentId ? { parentId } : {}) },
          label: `Create ${kind} “${name}”`,
        });
        return { staged: true, name, kind };
      },
    },
    renameCurrentPlaylist: {
      description: "Stage renaming the currently open playlist. Requires write access.",
      parameters: objectSchema({ name: stringSchema() }, ["name"]),
      handler(input) {
        requireWritable();
        const playlist = requireCurrentPlaylist();
        const name = stringField(input, "name").trim();
        stage({
          type: "mutate",
          mutation: { type: "rename-playlist", playlistId: playlist.id, name },
          label: `Rename “${playlist.name}” to “${name}”`,
        });
        return { staged: true, name };
      },
    },
    addCurrentTrackToPlaylist: {
      description:
        "Stage adding the currently selected track to an existing playlist. Omit playlistId to use the current playlist.",
      parameters: objectSchema({ playlistId: stringSchema() }, []),
      handler(input) {
        requireWritable();
        const contentId = requireContext().trackId;
        if (!contentId) throw new TypeError("Select a track first");
        const requestedId = optionalStringField(input, "playlistId");
        const playlist = requestedId ? requirePlaylist(requestedId) : requireCurrentPlaylist();
        if (playlist.type !== "playlist") throw new TypeError("Target must be a playlist");
        stage({
          type: "mutate",
          mutation: { type: "add-track", playlistId: playlist.id, contentId },
          label: `Add selected track to “${playlist.name}”`,
        });
        return { staged: true, playlist: playlist.name };
      },
    },
    setCue: {
      description:
        "Stage a memory or hot cue on the selected track. Omit seconds to use the current playhead. Hot cue slots are 1 through 16.",
      parameters: objectSchema(
        {
          kind: { type: "string", enum: ["memory", "hot"] },
          seconds: { type: "number", minimum: 0 },
          slot: { type: "integer", minimum: 1, maximum: 16 },
        },
        ["kind"],
      ),
      handler(input) {
        requireWritable();
        const context = requireContext();
        if (!context.trackId) throw new TypeError("Select a track first");
        const record = objectValue(input);
        const kind = record.kind === "hot" ? "hot" : "memory";
        const seconds =
          typeof record.seconds === "number" ? record.seconds : context.playheadSeconds;
        if (seconds === null || !Number.isFinite(seconds) || seconds < 0)
          throw new TypeError("Cue time is unavailable");
        const common = { kind, type: "cue" as const, startSeconds: seconds };
        let cue: TrackCueInput;
        if (kind === "hot") {
          const slot = record.slot;
          if (!Number.isInteger(slot) || Number(slot) < 1 || Number(slot) > 16)
            throw new TypeError("Hot cue slot must be between 1 and 16");
          cue = { ...common, kind, slot: Number(slot) as HotCueSlot };
        } else {
          cue = { ...common, kind };
        }
        stage({
          type: "mutate",
          mutation: { type: "upsert-cue", contentId: context.trackId, cue },
          label: `Set ${kind} cue at ${seconds.toFixed(2)}s`,
        });
        return { staged: true, kind, seconds };
      },
    },
    analyzeCurrentTrack: {
      description:
        "Stage clean-room Rekordbox analysis for the selected local track. Generated artifacts stay outside the live library.",
      parameters: objectSchema({}, []),
      handler() {
        const contentId = requireContext().trackId;
        if (!contentId) throw new TypeError("Select a local track first");
        stage({
          type: "process-track",
          contentId,
          operation: "analyze",
          label: "Run clean-room analysis on the selected track",
        });
        return { staged: true, operation: "analyze" };
      },
    },
    separateCurrentTrack: {
      description:
        "Stage Apple-GPU MLX stem separation for the selected local track. Select all sources, vocals, or instrumental.",
      parameters: objectSchema(
        { stem: { type: "string", enum: ["all", "vocals", "instrumental"] } },
        [],
      ),
      handler(input) {
        const contentId = requireContext().trackId;
        if (!contentId) throw new TypeError("Select a local track first");
        const requested = optionalStringField(input, "stem");
        const stem = requested === "vocals" || requested === "instrumental" ? requested : "all";
        stage({
          type: "process-track",
          contentId,
          operation: "stems",
          stem,
          label: `Generate ${stem === "all" ? "four" : stem} MLX stems for the selected track`,
        });
        return { staged: true, operation: "stems", stem };
      },
    },
  };
}

function plannerPrompt(prompt: string, context: NanocodexLibraryContext): string {
  return `Current application context:\n${JSON.stringify(context)}\n\nUser request:\n${prompt}`;
}

function responsesEndpoint(): string {
  const protocol = self.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${self.location.host}/api/responses`;
}

function requireContext(): NanocodexLibraryContext {
  if (!activeContext) throw new Error("No active planning context");
  return activeContext;
}

function requireWritable(): void {
  if (!requireContext().canWrite)
    throw new TypeError(
      "Library writes are unavailable while Rekordbox is running or write mode is disabled",
    );
}

function requireCurrentPlaylist(): PlaylistItem {
  const context = requireContext();
  if (!context.playlistId) throw new TypeError("Open a playlist first");
  return requirePlaylist(context.playlistId);
}

function requirePlaylist(id: string, allowFolder = false): PlaylistItem {
  const playlist = requireContext().playlists.find((candidate) => candidate.id === id);
  if (!playlist) throw new TypeError(`Playlist '${id}' does not exist`);
  if (!allowFolder && playlist.type === "folder")
    throw new TypeError(`'${playlist.name}' is a folder`);
  return playlist;
}

function stage(action: PromptAction): void {
  if (activeActions.length >= 8) throw new RangeError("A prompt may stage at most eight actions");
  activeActions.push(action);
}

function summarizeActions(actions: PromptAction[]): string {
  return actions.length ? actions.map((action) => action.label).join("; ") : "No actions staged";
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function stringSchema(): Record<string, unknown> {
  return { type: "string", minLength: 1 };
}

function stringArraySchema(maxItems: number, minItems = 0): Record<string, unknown> {
  return { type: "array", items: stringSchema(), minItems, maxItems };
}

function objectValue(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("Tool input must be an object");
  return input as Record<string, unknown>;
}

function stringField(input: unknown, name: string): string {
  const value = objectValue(input)[name];
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a string`);
  return value;
}

function optionalStringField(input: unknown, name: string): string | undefined {
  const value = objectValue(input)[name];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalNumberField(input: Record<string, unknown>, name: string): number | undefined {
  const value = input[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArrayField(input: Record<string, unknown>, name: string): string[] {
  const value = input[name];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim()))
    throw new TypeError(`${name} must be an array of non-empty strings`);
  return value.map((item) => String(item).trim());
}

async function libraryCatalog(): Promise<TrackSummary[]> {
  if (catalogCache && Date.now() - catalogCache.loadedAt < 60_000) return catalogCache.tracks;
  const response = await fetch("/api/tracks?limit=10000&sort=plays&direction=desc", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok)
    throw new Error(`Library catalog request failed: HTTP ${String(response.status)}`);
  const body = (await response.json()) as Partial<TracksResponse>;
  if (!Array.isArray(body.items)) throw new TypeError("Library catalog response is invalid");
  catalogCache = { loadedAt: Date.now(), tracks: body.items };
  return body.items;
}

function post(message: NanocodexWorkerMessage): void {
  worker.postMessage(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
