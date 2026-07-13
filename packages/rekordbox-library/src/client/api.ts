import type {
  ApiError,
  LibraryBootstrap,
  LibraryEvent,
  LibraryMutation,
  MutationReceipt,
  PlaylistItem,
  PromptContext,
  PromptPlan,
  TrackDetail,
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
};

export function getBootstrap(signal?: AbortSignal): Promise<LibraryBootstrap> {
  return apiRequest<LibraryBootstrap>("/api/bootstrap", { signal });
}

export async function getPlaylists(signal?: AbortSignal): Promise<PlaylistItem[]> {
  const response = await apiRequest<{ items: PlaylistItem[] }>("/api/playlists", { signal });
  return response.items;
}

export function getTracks(query: TrackQuery, signal?: AbortSignal): Promise<TracksResponse> {
  const params = new URLSearchParams();
  if (query.query?.trim()) params.set("q", query.query.trim());
  if (query.playlistId) params.set("playlistId", query.playlistId);
  if (query.filter && query.filter !== "all") params.set("filter", query.filter);
  params.set("limit", String(query.limit ?? 100));
  params.set("offset", String(query.offset ?? 0));
  return apiRequest<TracksResponse>(`/api/tracks?${params.toString()}`, { signal });
}

export async function getAllTracks(
  query: Omit<TrackQuery, "limit" | "offset">,
  signal?: AbortSignal,
): Promise<TracksResponse> {
  const pageSize = 500;
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
