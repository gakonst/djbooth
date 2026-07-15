import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

export type SpotifyEmbedPlayerHandle = {
  play(): void;
  pause(): void;
  toggle(): void;
  seek(seconds: number): void;
  isPlaying(): boolean;
};

type SpotifyPlaybackUpdate = {
  duration: number;
  isBuffering: boolean;
  isPaused: boolean;
  playingURI: string;
  position: number;
};

type SpotifyEmbedController = {
  addListener(event: string, listener: (event: { data: SpotifyPlaybackUpdate }) => void): void;
  destroy(): void;
  loadEntity(uri: string, preferVideo?: boolean, startAt?: number): void;
  pause(): void;
  play(): void;
  seek(seconds: number): void;
  togglePlay(): void;
};

type SpotifyIframeApi = {
  createController(
    element: HTMLElement,
    options: { uri: string; width: number; height: number },
    ready: (controller: SpotifyEmbedController) => void,
  ): void;
};

type Props = {
  uri: string;
  onError(error: Error): void;
  onPlaybackUpdate(update: SpotifyPlaybackUpdate): void;
  onReady(): void;
};

let iframeApiPromise: Promise<SpotifyIframeApi> | undefined;

export const SpotifyEmbedPlayer = forwardRef<SpotifyEmbedPlayerHandle, Props>(
  function SpotifyEmbedPlayer({ uri, onError, onPlaybackUpdate, onReady }, forwardedRef) {
    const hostRef = useRef<HTMLDivElement>(null);
    const controllerRef = useRef<SpotifyEmbedController | undefined>(undefined);
    const entityUriRef = useRef(spotifyEmbedTrackUri(uri));
    const readyEntityRef = useRef<string | undefined>(undefined);
    const playingRef = useRef(false);
    const playRequestedRef = useRef(false);
    const callbacksRef = useRef({ onError, onPlaybackUpdate, onReady });
    callbacksRef.current = { onError, onPlaybackUpdate, onReady };
    entityUriRef.current = spotifyEmbedTrackUri(uri);

    useImperativeHandle(
      forwardedRef,
      () => ({
        play() {
          playRequestedRef.current = true;
          controllerRef.current?.play();
        },
        pause() {
          playRequestedRef.current = false;
          controllerRef.current?.pause();
        },
        toggle() {
          playRequestedRef.current = !playingRef.current;
          controllerRef.current?.togglePlay();
        },
        seek(seconds) {
          controllerRef.current?.seek(seconds);
        },
        isPlaying() {
          return playingRef.current;
        },
      }),
      [],
    );

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;
      let cancelled = false;
      void loadSpotifyIframeApi()
        .then((api) => {
          if (cancelled) return;
          api.createController(
            host,
            { uri: entityUriRef.current, width: 1, height: 1 },
            (controller) => {
              if (cancelled) {
                controller.destroy();
                return;
              }
              controllerRef.current = controller;
              const notifyReady = () => {
                const entityUri = entityUriRef.current;
                if (readyEntityRef.current === entityUri) return;
                readyEntityRef.current = entityUri;
                callbacksRef.current.onReady();
              };
              controller.addListener("ready", notifyReady);
              controller.addListener("playback_update", (event) => {
                if (!sameSpotifyEntity(event.data.playingURI, entityUriRef.current)) return;
                notifyReady();
                // A newly loaded embed reports its initial paused state before the explicit play
                // takes effect. Suppress that stale edge so the compact transport does not flash.
                if (event.data.isPaused && playRequestedRef.current) return;
                playingRef.current = !event.data.isPaused;
                if (!event.data.isPaused) playRequestedRef.current = false;
                callbacksRef.current.onPlaybackUpdate(event.data);
              });
              // createController's callback is itself a ready boundary. The listener remains as a
              // fallback for implementations that emit ready after controller creation.
              notifyReady();
            },
          );
        })
        .catch((error: unknown) =>
          callbacksRef.current.onError(error instanceof Error ? error : new Error(String(error))),
        );
      return () => {
        cancelled = true;
        controllerRef.current?.destroy();
        controllerRef.current = undefined;
        readyEntityRef.current = undefined;
        host.replaceChildren();
      };
    }, []);

    useEffect(() => {
      const controller = controllerRef.current;
      if (!controller) return;
      const entityUri = spotifyEmbedTrackUri(uri);
      entityUriRef.current = entityUri;
      readyEntityRef.current = undefined;
      playingRef.current = false;
      playRequestedRef.current = false;
      controller.loadEntity(entityUri);
      readyEntityRef.current = entityUri;
      callbacksRef.current.onReady();
    }, [uri]);

    return <div className="spotify-embed-player" ref={hostRef} aria-hidden="true" />;
  },
);

function loadSpotifyIframeApi(): Promise<SpotifyIframeApi> {
  const windowWithApi = window as typeof window & {
    __musicLibrarySpotifyIframeApi?: SpotifyIframeApi;
    onSpotifyIframeApiReady?: (api: SpotifyIframeApi) => void;
  };
  if (windowWithApi.__musicLibrarySpotifyIframeApi)
    return Promise.resolve(windowWithApi.__musicLibrarySpotifyIframeApi);
  iframeApiPromise ??= new Promise((resolve, reject) => {
    const prior = windowWithApi.onSpotifyIframeApiReady;
    windowWithApi.onSpotifyIframeApiReady = (api) => {
      windowWithApi.__musicLibrarySpotifyIframeApi = api;
      prior?.(api);
      resolve(api);
    };
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-music-library-spotify-iframe="true"]',
    );
    if (existing) return;
    const script = document.createElement("script");
    script.src = "https://open.spotify.com/embed/iframe-api/v1";
    script.async = true;
    script.dataset.musicLibrarySpotifyIframe = "true";
    script.addEventListener("error", () => reject(new Error("Spotify player failed to load")), {
      once: true,
    });
    document.head.append(script);
  });
  return iframeApiPromise;
}

export function spotifyEmbedTrackUri(value: string): string {
  const normalized = value.trim();
  if (/^[0-9A-Za-z]+$/u.test(normalized)) return `spotify:track:${normalized}`;
  const urlMatch = /^https?:\/\/(?:open\.)?spotify\.com\/track\/([0-9A-Za-z]+)/u.exec(normalized);
  if (urlMatch?.[1]) return `spotify:track:${urlMatch[1]}`;
  return normalized;
}

function sameSpotifyEntity(left: string, right: string): boolean {
  return spotifyEmbedTrackUri(left) === spotifyEmbedTrackUri(right);
}
