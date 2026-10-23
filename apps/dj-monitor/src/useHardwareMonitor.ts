import { useEffect, useState } from "react";

import type {
  ConnectionStatus,
  DashboardSnapshot,
  DecodedEvent,
  DeckState,
  ServerMessage,
} from "./types.js";

function emptyDeck(player: number): DeckState {
  return {
    player,
    connected: false,
    source: "djLink",
    active: false,
    playing: false,
    synced: false,
    tempoMaster: false,
    model: null,
    ip: null,
    sourcePlayer: null,
    sourceSlot: null,
    trackType: null,
    trackId: null,
    trackTitle: null,
    trackArtist: null,
    trackAlbum: null,
    trackArtworkUrl: null,
    playState: null,
    bpm: null,
    effectiveBpm: null,
    pitchPercent: null,
    beatInBar: null,
    beatNumber: null,
    trackProgressPercent: null,
    trackLengthSec: null,
    playheadMs: null,
  };
}

const EMPTY_SNAPSHOT: DashboardSnapshot = {
  schemaVersion: 1,
  sequence: 0,
  observedAtUs: 0,
  mixer: {
    device: "DJM-A9",
    connected: false,
    bpm: null,
    controls: {},
    meters: {},
  },
  decks: [emptyDeck(1), emptyDeck(2), emptyDeck(3)],
};

function websocketUrl(): string {
  const replayUrl = new URLSearchParams(window.location.search).get("hardwareWs");
  if (replayUrl) {
    const candidate = new URL(replayUrl);
    if (
      (candidate.protocol === "ws:" || candidate.protocol === "wss:") &&
      ["127.0.0.1", "localhost", "::1"].includes(candidate.hostname)
    ) {
      return candidate.toString();
    }
  }
  const configured = import.meta.env.VITE_HARDWARE_WS_URL as string | undefined;
  if (configured) return configured;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/v1/events`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDashboardSnapshot(value: unknown): value is DashboardSnapshot {
  if (!isRecord(value) || !isRecord(value.mixer)) return false;
  return (
    isRecord(value.mixer.controls) &&
    (value.mixer.meters === undefined || isRecord(value.mixer.meters)) &&
    Array.isArray(value.decks)
  );
}

function isServerMessage(value: unknown): value is ServerMessage {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "snapshot":
      return isDashboardSnapshot(value.snapshot);
    case "deck":
      return isRecord(value.deck) && typeof value.deck.player === "number";
    case "event":
      return isRecord(value.event) && typeof value.event.kind === "string";
    case "meters":
      return isRecord(value.meters);
    default:
      return false;
  }
}

export function useHardwareMonitor(): {
  snapshot: DashboardSnapshot;
  status: ConnectionStatus;
  activity: DecodedEvent[];
} {
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [activity, setActivity] = useState<DecodedEvent[]>([]);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let retryMs = 500;

    const connect = () => {
      if (disposed) return;
      setStatus("connecting");
      socket = new WebSocket(websocketUrl());
      socket.addEventListener("open", () => {
        retryMs = 500;
        setStatus("live");
      });
      socket.addEventListener("message", (message) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(message.data));
        } catch {
          return;
        }
        if (!isServerMessage(parsed)) return;
        if (parsed.type === "snapshot") {
          setSnapshot(parsed.snapshot);
          return;
        }
        if (parsed.type === "deck") {
          setSnapshot((current) => ({
            ...current,
            sequence: parsed.sequence,
            observedAtUs: parsed.observedAtUs,
            decks: current.decks.some((deck) => deck.player === parsed.deck.player)
              ? current.decks.map((deck) =>
                  deck.player === parsed.deck.player ? parsed.deck : deck,
                )
              : [...current.decks, parsed.deck].sort((a, b) => a.player - b.player),
          }));
          return;
        }
        if (parsed.type === "meters") {
          setSnapshot((current) => ({
            ...current,
            sequence: parsed.sequence,
            observedAtUs: parsed.observedAtUs,
            mixer: {
              ...current.mixer,
              audioMeterConnected: true,
              meters: parsed.meters,
            },
          }));
          return;
        }
        const event = parsed.event;
        setSnapshot((current) => ({
          ...current,
          sequence: parsed.sequence,
          observedAtUs: parsed.observedAtUs,
          mixer: {
            ...current.mixer,
            connected: true,
            bpm: event.bpm ?? current.mixer.bpm,
            controls: event.control
              ? {
                  ...current.mixer.controls,
                  [event.control]: {
                    label: event.label ?? event.control,
                    value: event.value ?? null,
                    percent: event.percent ?? null,
                    state: event.state ?? null,
                    raw: event.raw,
                    changedAtUs: event.timestampUs,
                  },
                }
              : current.mixer.controls,
          },
        }));
        if (event.kind !== "clock") {
          setActivity((current) => [event, ...current].slice(0, 8));
        }
      });
      socket.addEventListener("close", () => {
        if (disposed) return;
        setStatus("offline");
        reconnectTimer = window.setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 5_000);
      });
      socket.addEventListener("error", () => socket?.close());
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  return { snapshot, status, activity };
}
