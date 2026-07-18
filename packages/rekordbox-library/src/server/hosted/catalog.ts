import type {
  HostedMutationReceipt,
  HostedPlaylistMutation,
  HostedPlaylistProvider,
  HostedPlaylistsResponse,
  PlaylistItem,
  TrackSummary,
} from "../../shared/types.js";
import { parseHostedPlaylistId, parseHostedTrackId } from "./ids.js";
import type {
  HostedPlaylistProviderAdapter,
  HostedPlaylistStateReaderWriter,
  HostedPlaylistStoredState,
  HostedTrackStream,
  HostedTrackStreamRequest,
} from "./types.js";
import { errorMessage, HostedTrackStreamUnavailableError } from "./types.js";

export type HostedPlaylistCatalogOptions = {
  adapters: readonly HostedPlaylistProviderAdapter[];
  now?: () => Date;
  state?: HostedPlaylistStateReaderWriter;
};

/** Provider-neutral hosted-playlist facade used by the HTTP API and outbox worker. */
export class HostedPlaylistCatalog {
  readonly #adapters = new Map<HostedPlaylistProvider, HostedPlaylistProviderAdapter>();
  readonly #now: () => Date;
  readonly #state: HostedPlaylistStateReaderWriter | undefined;
  readonly #writeTails = new Map<string, Promise<void>>();

  constructor(options: HostedPlaylistCatalogOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#state = options.state;
    for (const adapter of options.adapters) {
      if (this.#adapters.has(adapter.provider)) {
        throw new TypeError(`Duplicate hosted-playlist adapter: ${adapter.provider}`);
      }
      this.#adapters.set(adapter.provider, adapter);
    }
  }

  async listPlaylists(): Promise<HostedPlaylistsResponse> {
    const storedStates = this.#state?.listPlaylists
      ? new Map(
          (await this.#state.listPlaylists()).map((state) => [
            playlistStateKey(state.provider, state.remoteId),
            state,
          ]),
        )
      : undefined;
    const results = await Promise.all(
      [...this.#adapters.values()].map(async (adapter) => {
        try {
          const result = await adapter.listPlaylists();
          return {
            items: await Promise.all(
              result.items.map((item) => this.#decoratePlaylist(item, storedStates)),
            ),
            status: {
              provider: adapter.provider,
              connected: true,
              ...(result.displayName ? { displayName: result.displayName } : {}),
            },
          };
        } catch (error) {
          return {
            items: [] as PlaylistItem[],
            status: {
              provider: adapter.provider,
              connected: false,
              error: errorMessage(error),
            },
          };
        }
      }),
    );
    return {
      items: results.flatMap((result) => result.items),
      providers: results.map((result) => result.status),
    };
  }

  async getTracks(playlistId: string): Promise<TrackSummary[]> {
    const { provider, remoteId } = parseHostedPlaylistId(playlistId);
    const tracks = await this.#adapter(provider).getTracks(remoteId);
    return this.#decorateTracks(provider, tracks);
  }

  /** Reapply local sync/download state without making another provider request. */
  async refreshPlaylistState(response: HostedPlaylistsResponse): Promise<HostedPlaylistsResponse> {
    if (!this.#state?.listPlaylists) return response;
    const storedStates = new Map(
      (await this.#state.listPlaylists()).map((state) => [
        playlistStateKey(state.provider, state.remoteId),
        state,
      ]),
    );
    return {
      ...response,
      items: await Promise.all(
        response.items.map((item) => this.#decoratePlaylist(item, storedStates)),
      ),
    };
  }

  /** Reapply local track mappings without refetching the provider playlist contents. */
  async refreshTrackState(
    playlistId: string,
    tracks: readonly TrackSummary[],
  ): Promise<TrackSummary[]> {
    const { provider } = parseHostedPlaylistId(playlistId);
    return this.#decorateTracks(provider, tracks);
  }

  async #decorateTracks(
    provider: HostedPlaylistProvider,
    tracks: readonly TrackSummary[],
  ): Promise<TrackSummary[]> {
    if (!this.#state) return [...tracks];
    const storedTracks = this.#state.listTracks
      ? new Map(
          (await this.#state.listTracks(provider)).map((state) => [state.remoteTrackId, state]),
        )
      : undefined;
    return Promise.all(
      tracks.map(async (track) => {
        const remoteTrackId = track.hosted?.remoteId;
        if (!track.hosted || !remoteTrackId) return track;
        const state =
          storedTracks?.get(remoteTrackId) ??
          (storedTracks ? undefined : await this.#state!.getTrack(provider, remoteTrackId));
        if (!state) return track;
        const {
          downloadError: _downloadError,
          downloadState: _downloadState,
          localContentId: _localContentId,
          ...providerTrack
        } = track.hosted;
        return {
          ...track,
          hosted: {
            ...providerTrack,
            localContentId: state.localContentId,
            downloadState: state.downloadState,
            ...(state.downloadError ? { downloadError: state.downloadError } : {}),
          },
        };
      }),
    );
  }

  streamTrack(trackId: string, request: HostedTrackStreamRequest = {}): Promise<HostedTrackStream> {
    const { provider, remoteId } = parseHostedTrackId(trackId);
    const adapter = this.#adapter(provider);
    if (!adapter.streamTrack) {
      throw new HostedTrackStreamUnavailableError(
        `${provider} does not expose a direct audio stream`,
      );
    }
    return adapter.streamTrack(remoteId, request);
  }

  mutate(mutation: HostedPlaylistMutation): Promise<HostedMutationReceipt> {
    if (mutation.type === "create-hosted-playlist") {
      return this.#serialize(`provider:${mutation.provider}`, () => this.#create(mutation));
    }
    const reference = parseHostedPlaylistId(mutation.playlistId);
    return this.#serialize(mutation.playlistId, () => this.#mutateExisting(mutation, reference));
  }

  #adapter(provider: HostedPlaylistProvider): HostedPlaylistProviderAdapter {
    const adapter = this.#adapters.get(provider);
    if (!adapter) throw new TypeError(`Hosted-playlist provider is not configured: ${provider}`);
    return adapter;
  }

  async #decoratePlaylist(
    item: PlaylistItem,
    storedStates?: Map<string, HostedPlaylistStoredState>,
  ): Promise<PlaylistItem> {
    if (!item.hosted || !this.#state) return item;
    const state = storedStates
      ? storedStates.get(playlistStateKey(item.hosted.provider, item.hosted.remoteId))
      : await this.#state.getPlaylist(item.hosted.provider, item.hosted.remoteId);
    if (!state) return item;
    const {
      downloadEnabled: _downloadEnabled,
      syncError: _syncError,
      syncState: _syncState,
      ...providerPlaylist
    } = item.hosted;
    return {
      ...item,
      hosted: {
        ...providerPlaylist,
        downloadEnabled: state.downloadEnabled,
        syncState: state.syncState,
        ...(state.syncError ? { syncError: state.syncError } : {}),
      },
    };
  }

  async #create(
    mutation: Extract<HostedPlaylistMutation, { type: "create-hosted-playlist" }>,
  ): Promise<HostedMutationReceipt> {
    const created = await this.#adapter(mutation.provider).createPlaylist(mutation.name);
    if (!created.hosted) throw new Error("Hosted provider returned a local playlist");
    await this.#recordSuccessfulSync(created);
    return this.#receipt(mutation.type, created.id, created.hosted.revision);
  }

  async #mutateExisting(
    mutation: Exclude<HostedPlaylistMutation, { type: "create-hosted-playlist" }>,
    reference: { provider: HostedPlaylistProvider; remoteId: string },
  ): Promise<HostedMutationReceipt> {
    const adapter = this.#adapter(reference.provider);
    if (mutation.type === "set-hosted-playlist-download") {
      if (!this.#state) throw new Error("Hosted playlist state storage is not configured");
      const state = await this.#state.setDownloadEnabled(
        reference.provider,
        reference.remoteId,
        mutation.enabled,
      );
      return this.#receipt(mutation.type, mutation.playlistId, state.revision);
    }

    let changed: PlaylistItem | undefined;
    try {
      if (mutation.type === "rename-hosted-playlist") {
        changed = await adapter.renamePlaylist(
          reference.remoteId,
          mutation.name,
          mutation.expectedRevision,
        );
      } else if (mutation.type === "replace-hosted-playlist-tracks") {
        changed = await adapter.replacePlaylistTracks(
          reference.remoteId,
          mutation.remoteTrackIds,
          mutation.expectedRevision,
        );
      } else {
        await adapter.deletePlaylist(reference.remoteId, mutation.expectedRevision);
      }
    } catch (error) {
      await this.#recordFailedSync(reference.provider, reference.remoteId, error);
      throw error;
    }

    if (changed) await this.#recordSuccessfulSync(changed);
    return this.#receipt(mutation.type, mutation.playlistId, changed?.hosted?.revision ?? null);
  }

  async #recordSuccessfulSync(item: PlaylistItem): Promise<void> {
    if (!this.#state || !item.hosted) return;
    await this.#state.updatePlaylistSync(item.hosted.provider, item.hosted.remoteId, {
      revision: item.hosted.revision,
      state: "idle",
      error: null,
    });
  }

  async #recordFailedSync(
    provider: HostedPlaylistProvider,
    remoteId: string,
    error: unknown,
  ): Promise<void> {
    if (!this.#state) return;
    await this.#state.updatePlaylistSync(provider, remoteId, {
      state: "error",
      error: errorMessage(error),
    });
  }

  #receipt(
    operation: HostedPlaylistMutation["type"],
    playlistId: string,
    revision: string | null,
  ): HostedMutationReceipt {
    return {
      operation,
      playlistId,
      revision,
      queuedAt: this.#now().toISOString(),
    };
  }

  #serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#writeTails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#writeTails.set(key, tail);
    void tail.finally(() => {
      if (this.#writeTails.get(key) === tail) this.#writeTails.delete(key);
    });
    return result;
  }
}

function playlistStateKey(provider: HostedPlaylistProvider, remoteId: string): string {
  return `${provider}\0${remoteId}`;
}
