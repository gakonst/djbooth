export type ConnectionStatus = "connecting" | "live" | "offline";

export type ControlState = {
  label: string;
  value: number | null;
  percent: number | null;
  state: string | null;
  raw: string;
  changedAtUs: number;
};

export type DeckState = {
  player: number;
  connected: boolean;
  source: "djLink";
  model: string | null;
  ip: string | null;
  active: boolean;
  sourcePlayer: number | null;
  sourceSlot: number | null;
  trackType: number | null;
  trackId: number | null;
  trackTitle: string | null;
  trackArtist: string | null;
  trackAlbum: string | null;
  trackArtworkUrl: string | null;
  playing: boolean;
  playState: string | null;
  synced: boolean;
  tempoMaster: boolean;
  bpm: number | null;
  effectiveBpm: number | null;
  pitchPercent: number | null;
  beatInBar: number | null;
  beatNumber: number | null;
  trackProgressPercent: number | null;
  trackLengthSec: number | null;
  playheadMs: number | null;
};

export type MixerState = {
  device: string;
  connected: boolean;
  audioMeterConnected?: boolean;
  bpm: number | null;
  controls: Record<string, ControlState>;
  meters: Record<string, MeterState>;
};

export type MeterState = {
  pair: number;
  channels: [number, number];
  peakDbfs: number;
  rmsDbfs: number;
  leftPeakDbfs: number;
  rightPeakDbfs: number;
  leftRmsDbfs: number;
  rightRmsDbfs: number;
  changedAtUs: number;
};

export type DashboardSnapshot = {
  schemaVersion: number;
  sequence: number;
  observedAtUs: number;
  mixer: MixerState;
  decks: DeckState[];
};

export type TrackWaveform = {
  durationSeconds: number;
  peaks: number[];
  colors?: Array<[number, number, number]>;
  beatGrid?: Array<{ beat: 1 | 2 | 3 | 4; timeSeconds: number }>;
  source: "rekordbox" | "placeholder";
};

export type DecodedEvent = {
  elapsedUs: number;
  timestampUs: number;
  kind: "clock" | "control" | "unknown";
  message: string;
  channel?: number;
  control?: string;
  label?: string;
  value?: number;
  percent?: number;
  state?: string;
  bpm?: number;
  raw: string;
};

export type ServerMessage =
  | { type: "snapshot"; schemaVersion: number; snapshot: DashboardSnapshot }
  | {
      type: "event";
      schemaVersion: number;
      sequence: number;
      observedAtUs: number;
      source: "midi";
      event: DecodedEvent;
    }
  | {
      type: "meters";
      schemaVersion: number;
      sequence: number;
      observedAtUs: number;
      source: "usbAudio";
      meters: Record<string, MeterState>;
    }
  | {
      type: "deck";
      schemaVersion: number;
      sequence: number;
      observedAtUs: number;
      source: "djLink";
      kind: "device" | "status" | "beat" | "position";
      deck: DeckState;
    };
