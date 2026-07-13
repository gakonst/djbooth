import type {
  ApiError,
  LibraryBootstrap,
  LibraryMutation,
  MutationReceipt,
  PlaylistItem,
  TrackDetail,
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

export async function getTrackDetail(id: string, signal?: AbortSignal): Promise<TrackDetail> {
  const response = await apiRequest<{ track: TrackDetail }>(
    `/api/tracks/${encodeURIComponent(id)}`,
    { signal },
  );
  return response.track;
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
