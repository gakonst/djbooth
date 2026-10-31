import type {
  DashboardSnapshot,
  DeckState,
  ServerMessage,
  TrackWaveform,
  ControlState,
} from "../../dj-monitor/src/types.js";
import {
  visualLane,
  waveformBands,
  waveformVisualLane,
} from "../../dj-monitor/src/visual-signals.js";
import type { LibraryTrack } from "./decks.js";
import { verifiedLiveVideoTrack } from "./track-video.js";

function websocketUrl() {
  const override = new URLSearchParams(location.search).get("hardwareWs");
  if (override) {
    try {
      const url = new URL(override);
      if (
        ["ws:", "wss:"].includes(url.protocol) &&
        ["127.0.0.1", "localhost", "::1"].includes(url.hostname)
      )
        return url.href;
    } catch {
      /* Ignore malformed replay URLs. */
    }
  }
  return (
    (import.meta.env.VITE_HARDWARE_WS_URL as string | undefined) ??
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/v1/events`
  );
}

/** One subscription per stage; reconnects always start with an empty hardware state. */
export function createLiveMusic() {
  let snapshot: DashboardSnapshot = empty();
  let disposed = false;
  let connected = false;
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retry = 500;
  let midi = { connected: false, controls: {} as Record<string, ControlState> };
  const mergedSnapshot = (): DashboardSnapshot =>
    midi.connected
      ? {
          ...snapshot,
          mixer: {
            ...snapshot.mixer,
            connected: true,
            controls: { ...snapshot.mixer.controls, ...midi.controls },
          },
        }
      : snapshot;
  const tracks = new Map<
    number,
    {
      key: string;
      waveform: TrackWaveform | null;
      videoTrack: LibraryTrack | null;
      controller: AbortController;
    }
  >();
  const positions = new Map<number, { deck: DeckState; at: number }>();
  function empty(): DashboardSnapshot {
    return {
      schemaVersion: 1,
      sequence: 0,
      observedAtUs: 0,
      decks: [],
      mixer: { device: "DJM-A9", connected: false, bpm: null, controls: {}, meters: {} },
    };
  }
  function clear() {
    snapshot = empty();
    positions.clear();
    for (const track of tracks.values()) track.controller.abort();
    tracks.clear();
  }
  function reconcile() {
    for (const player of tracks.keys()) {
      if (
        !snapshot.decks.some(
          (deck) => deck.player === player && deck.connected && deck.trackId != null,
        )
      ) {
        tracks.get(player)!.controller.abort();
        tracks.delete(player);
      }
    }
    for (const deck of snapshot.decks) {
      positions.set(
        deck.player,
        positions.get(deck.player)?.deck === deck
          ? positions.get(deck.player)!
          : { deck, at: performance.now() },
      );
      if (!deck.connected || deck.trackId == null) continue;
      const key = `${deck.trackId}:${deck.sourcePlayer}:${deck.sourceSlot}`;
      if (tracks.get(deck.player)?.key === key) continue;
      tracks.get(deck.player)?.controller.abort();
      const entry = {
        key,
        waveform: null as TrackWaveform | null,
        videoTrack: null as LibraryTrack | null,
        controller: new AbortController(),
      };
      tracks.set(deck.player, entry);
      void fetch(`/api/tracks/${encodeURIComponent(String(deck.trackId))}`, {
        signal: entry.controller.signal,
      })
        .then(async (response) =>
          response.ok ? ((await response.json()) as { track: LibraryTrack }).track : null,
        )
        .then((track) => {
          if (!entry.controller.signal.aborted) entry.videoTrack = track;
        })
        .catch(() => {});
      const query = new URLSearchParams();
      if (deck.sourcePlayer != null) query.set("sourcePlayer", String(deck.sourcePlayer));
      if (deck.sourceSlot != null) query.set("sourceSlot", String(deck.sourceSlot));
      void fetch(`/v1/tracks/${encodeURIComponent(String(deck.trackId))}/waveform?${query}`, {
        signal: entry.controller.signal,
      })
        .then(async (response) => (response.ok ? ((await response.json()) as TrackWaveform) : null))
        .then((waveform) => {
          if (!entry.controller.signal.aborted) entry.waveform = waveform;
        })
        .catch(() => {});
    }
  }
  function connect() {
    if (disposed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(websocketUrl());
    } catch {
      schedule();
      return;
    }
    socket = ws;
    ws.addEventListener("open", () => {
      if (!disposed) {
        connected = true;
        retry = 500;
      }
    });
    ws.addEventListener("message", (event) => {
      if (disposed || socket !== ws) return;
      try {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        if (
          message.type === "snapshot" &&
          Array.isArray(message.snapshot?.decks) &&
          message.snapshot.mixer?.controls
        ) {
          snapshot = message.snapshot;
          reconcile();
        } else if (message.type === "deck" && typeof message.deck?.player === "number") {
          snapshot.decks = [
            ...snapshot.decks.filter((deck) => deck.player !== message.deck.player),
            message.deck,
          ].sort((a, b) => a.player - b.player);
          reconcile();
        } else if (message.type === "meters" && message.meters) {
          snapshot.mixer.meters = message.meters;
        } else if (message.type === "event" && message.event) {
          const event = message.event;
          if (event.control) snapshot.mixer.connected = true;
          snapshot.mixer.bpm = event.bpm ?? snapshot.mixer.bpm;
          if (event.control)
            snapshot.mixer.controls[event.control] = {
              label: event.label ?? event.control,
              value: event.value ?? null,
              percent: event.percent ?? null,
              state: event.state ?? null,
              raw: event.raw,
              changedAtUs: event.timestampUs,
            };
        }
      } catch {
        /* Ignore unrelated or malformed events. */
      }
    });
    ws.addEventListener("close", () => {
      connected = false;
      clear();
      if (!disposed) schedule();
    });
    ws.addEventListener("error", () => {
      connected = false;
      clear();
      ws.close();
    });
  }
  function schedule() {
    timer = setTimeout(connect, retry);
    retry = Math.min(5000, retry * 2);
  }
  connect();
  return {
    setMidi(connected: boolean, controls: Record<string, ControlState>) {
      midi = { connected, controls: connected ? controls : {} };
    },
    snapshot: mergedSnapshot,
    midi() {
      return {
        connected: snapshot.mixer.connected || midi.connected,
        source: midi.connected
          ? "USB MIDI"
          : snapshot.mixer.connected
            ? "DJBooth MIDI"
            : "disconnected",
      };
    },
    connected() {
      return connected;
    },
    sample() {
      if (!connected) return [];
      const mixed = mergedSnapshot();
      return mixed.decks
        .filter((deck) => deck.connected)
        .sort((a, b) => a.player - b.player)
        .slice(0, 3)
        .map((rawDeck) => {
          // OMNIS transport state is authoritative; its CDJ flag bits also remain set while paused.
          const deck =
            rawDeck.model?.toUpperCase() === "OMNIS-DUO"
              ? {
                  ...rawDeck,
                  playing: ["playing", "looping", "cue-playing", "moving-alt"].includes(
                    rawDeck.playState ?? "",
                  ),
                }
              : rawDeck;
          const waveform = tracks.get(deck.player)?.waveform ?? null;
          const base =
            deck.playheadMs != null
              ? deck.playheadMs / 1000
              : ((deck.trackProgressPercent ?? 0) / 100) *
                (deck.trackLengthSec ?? waveform?.durationSeconds ?? 0);
          const bpm = deck.effectiveBpm ?? deck.bpm ?? 120;
          const elapsed =
            (performance.now() - (positions.get(deck.player)?.at ?? performance.now())) / 1000;
          const time = Math.max(
            0,
            Math.min(
              deck.trackLengthSec ?? waveform?.durationSeconds ?? Infinity,
              base + (deck.playing ? Math.min(elapsed, 2) * (deck.bpm ? bpm / deck.bpm : 1) : 0),
            ),
          );
          return {
            deck,
            trackId:
              deck.trackId == null
                ? null
                : `${deck.trackId}:${deck.sourcePlayer}:${deck.sourceSlot}`,
            waveform,
            videoTrack: verifiedLiveVideoTrack(deck, tracks.get(deck.player)?.videoTrack ?? null),
            // Video visibility follows the mixer, not individual quiet waveform samples.
            gain: visualLane(mixed, deck, deck.player, 1).level,
            time,
            bpm,
            bands: waveformBands(mixed, deck.player),
            signal: waveformVisualLane(mixed, deck, deck.player, waveform, time),
          };
        });
    },
    dispose() {
      disposed = true;
      connected = false;
      if (timer !== undefined) clearTimeout(timer);
      socket?.close();
      clear();
    },
  };
}
