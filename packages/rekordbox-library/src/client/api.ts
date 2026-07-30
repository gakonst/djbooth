import type {
  ApiError,
  HostedMutationReceipt,
  HostedPlaylistMutation,
  HostedPlaylistsResponse,
  LibraryBootstrap,
  LibraryEvent,
  LibraryMutation,
  MutationReceipt,
  PlaylistItem,
  ProcessingJob,
  PromptContext,
  PromptPlan,
  TrackDetail,
  TrackSort,
  TrackWaveform,
  TracksResponse,
} from "../shared/types.js";

export class LibraryApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "LibraryApiError";
    this.status = status;
    this.code = code;
  }
}

export type TrackQuery = {
  query?: string;
  playlistId?: string | null;
  filter?: string;
  limit?: number;
  offset?: number;
  sort?: TrackSort;
};

export type AssistantAuthStatus = {
  mode: "api-key" | "chatgpt" | "unavailable";
  email?: string;
  plan?: string;
  message: string;
};

export function getBootstrap(signal?: AbortSignal): Promise<LibraryBootstrap> {
  return apiRequest<LibraryBootstrap>("/api/bootstrap", { signal });
}

export function getAssistantAuth(signal?: AbortSignal): Promise<AssistantAuthStatus> {
  return apiRequest<AssistantAuthStatus>("/api/assistant/auth", { signal });
}

export async function getPlaylists(signal?: AbortSignal): Promise<PlaylistItem[]> {
  const response = await apiRequest<{ items: PlaylistItem[] }>("/api/playlists", { signal });
  return response.items;
}

export function getHostedPlaylists(signal?: AbortSignal): Promise<HostedPlaylistsResponse> {
  return apiRequest<HostedPlaylistsResponse>("/api/hosted-playlists", { signal });
}

export function getTracks(query: TrackQuery, signal?: AbortSignal): Promise<TracksResponse> {
  const params = new URLSearchParams();
  if (query.query?.trim()) params.set("q", query.query.trim());
  if (query.playlistId) params.set("playlistId", query.playlistId);
  if (query.filter && query.filter !== "all") params.set("filter", query.filter);
  params.set("limit", String(query.limit ?? 100));
  params.set("offset", String(query.offset ?? 0));
  if (query.sort) {
    params.set("sort", query.sort.field);
    params.set("direction", query.sort.direction);
  }
  return apiRequest<TracksResponse>(`/api/tracks?${params.toString()}`, { signal });
}

export async function getAllTracks(
  query: Omit<TrackQuery, "limit" | "offset">,
  signal?: AbortSignal,
): Promise<TracksResponse> {
  // Canvas/editor snapshots are bounded by the same 10k mutation contract as the server. Most
  // playlists now need one count/select request instead of repeating both for every 500 rows.
  const pageSize = 10_000;
  const first = await getTracks({ ...query, limit: pageSize, offset: 0 }, signal);
  const items = [...first.items];
  while (items.length < first.count) {
    const page = await getTracks({ ...query, limit: pageSize, offset: items.length }, signal);
    if (page.items.length === 0)
      throw new LibraryApiError(409, "INCOMPLETE_PLAYLIST", "Playlist pagination stopped early");
    items.push(...page.items);
  }
  return { items, count: first.count, limit: items.length, offset: 0 };
}

export async function getTrackDetail(id: string, signal?: AbortSignal): Promise<TrackDetail> {
  const response = await apiRequest<{ track: TrackDetail }>(
    `/api/tracks/${encodeURIComponent(id)}`,
    { signal },
  );
  return response.track;
}

export async function getTrackWaveform(id: string, signal?: AbortSignal): Promise<TrackWaveform> {
  const response = await apiRequest<{ waveform: TrackWaveform }>(
    `/api/waveforms/${encodeURIComponent(id)}`,
    { signal },
  );
  return response.waveform;
}

export function subscribeLibraryEvents(onEvent: (event: LibraryEvent) => void): () => void {
  const source = new EventSource("/api/events");
  source.addEventListener("library", (message) => {
    try {
      onEvent(JSON.parse((message as MessageEvent<string>).data) as LibraryEvent);
    } catch {
      // Ignore malformed local events; the stream automatically reconnects.
    }
  });
  return () => source.close();
}

export async function mutateLibrary(
  token: string,
  mutation: LibraryMutation,
  signal?: AbortSignal,
): Promise<MutationReceipt> {
  const response = await apiRequest<{ receipt: MutationReceipt }>("/api/mutations", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-music-library-token": token,
    },
    body: JSON.stringify(mutation),
  });
  return response.receipt;
}

export async function mutateHostedPlaylist(
  token: string,
  mutation: HostedPlaylistMutation,
  signal?: AbortSignal,
): Promise<HostedMutationReceipt> {
  const response = await apiRequest<{ receipt: HostedMutationReceipt }>("/api/hosted-mutations", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-music-library-token": token,
    },
    body: JSON.stringify(mutation),
  });
  return response.receipt;
}

export async function planLibraryPrompt(
  token: string,
  prompt: string,
  context: PromptContext,
  signal?: AbortSignal,
): Promise<PromptPlan> {
  const response = await apiRequest<{ plan: PromptPlan }>("/api/prompts/plan", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-music-library-token": token,
    },
    body: JSON.stringify({ prompt, context }),
  });
  return response.plan;
}

export async function getProcessingJobs(signal?: AbortSignal): Promise<ProcessingJob[]> {
  const response = await apiRequest<{ items: ProcessingJob[] }>("/api/processing/jobs", { signal });
  return response.items;
}

export async function startProcessingJob(
  token: string,
  request: {
    contentId: string;
    operation: "analyze" | "stems";
    stem?: "vocals" | "instrumental" | "all";
  },
  signal?: AbortSignal,
): Promise<ProcessingJob> {
  const response = await apiRequest<{ job: ProcessingJob }>("/api/processing/jobs", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-music-library-token": token,
    },
    body: JSON.stringify(request),
  });
  return response.job;
}

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      accept: "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as ApiError | undefined;
    throw new LibraryApiError(
      response.status,
      body?.error.code ?? "HTTP_ERROR",
      body?.error.message ?? `${response.status} ${response.statusText}`,
    );
  }
  return (await response.json()) as T;
}
