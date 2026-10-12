import { useEffect, useRef, useState, type CSSProperties } from "react";

import type {
  ConnectionStatus,
  ControlState,
  DashboardSnapshot,
  DecodedEvent,
  DeckState,
  MeterState,
} from "./types.js";
import { CdjWaveform } from "./CdjWaveform.js";
import { useA9Midi } from "./useA9Midi.js";
import { useHardwareMonitor } from "./useHardwareMonitor.js";
import { useTrackWaveform } from "./useTrackWaveform.js";
import cdj3000Image from "./assets/CDJ-3000_top.webp";
import djmA9Image from "./assets/djm-a9_2.png";

const CDJ_3000_IMAGE = cdj3000Image;
const DJM_A9_IMAGE = djmA9Image;

type HardwareMonitorProps = {
  snapshot: DashboardSnapshot;
  status: ConnectionStatus;
  activity?: DecodedEvent[];
};

const A9_IMAGE = {
  left: -34.31,
  top: -13.68,
  width: 168.9,
  height: 119.2,
  faceRatio: 1061 / 1104,
} as const;

const CDJ_IMAGE = {
  left: 0,
  top: 0,
  width: 100,
  height: 100,
  faceRatio: 2478 / 3300,
} as const;

type A9KnobFamily =
  | "input-selector"
  | "trim"
  | "eq"
  | "color"
  | "utility"
  | "fx-selector"
  | "fx-depth";

/**
 * Radius of the physical moving body relative to the measured control footprint.
 * The source photograph outside this radius is fixed artwork: legends, scales,
 * center-lock marks, faceplate and cast shadows must never rotate.
 */
const A9_KNOB_BODY_RADIUS: Record<A9KnobFamily, number> = {
  "input-selector": 0.46,
  trim: 0.44,
  eq: 0.47,
  color: 0.485,
  utility: 0.45,
  "fx-selector": 0.48,
  "fx-depth": 0.475,
};

export function LiveHardwareMonitor() {
  const monitor = useHardwareMonitor();
  const midi = useA9Midi();
  const replay = new URLSearchParams(window.location.search).has("hardwareWs");
  return (
    <HardwareMonitor
      {...monitor}
      snapshot={{
        ...monitor.snapshot,
        mixer: {
          ...monitor.snapshot.mixer,
          connected: monitor.snapshot.mixer.connected || midi.connected,
          controls: { ...monitor.snapshot.mixer.controls, ...midi.controls },
        },
      }}
      mode={replay ? "replay" : "live"}
    />
  );
}

export function HardwareMonitor({
  snapshot,
  status,
  activity = [],
  mode = "live",
}: HardwareMonitorProps & { mode?: "live" | "replay" }) {
  const decks = monitorDecks(snapshot.decks);

  return (
    <main className="monitor-shell">
      <header className="monitor-header">
        <div className="brand-lockup">
          <span>DJBOOTH</span>
          <i />
          <strong>{mode === "replay" ? "SESSION REPLAY" : "LIVE HARDWARE"}</strong>
        </div>
        <div className="header-status">
          <span className={`status-pill status-${status}`}>
            <i /> {mode === "replay" && status === "live" ? "replay" : status}
          </span>
          <span className="clock-readout">
            <strong>{formatBpm(snapshot.mixer.bpm)}</strong>
            <small>MIDI CLOCK</small>
          </span>
          <span className="sequence">FRAME {snapshot.sequence.toString().padStart(6, "0")}</span>
        </div>
      </header>

      <section className="booth-grid" aria-label="Three CDJ-3000 players and a DJM-A9 mixer">
        <Cdj3000 deck={decks[0] ?? emptyDeck(1)} />
        <Cdj3000 deck={decks[1] ?? emptyDeck(2)} />
        <DjmA9
          controls={snapshot.mixer.controls}
          meters={snapshot.mixer.meters ?? {}}
          connected={snapshot.mixer.connected}
          bpm={snapshot.mixer.bpm}
        />
        <Cdj3000 deck={decks[2] ?? emptyDeck(3)} />
      </section>

      <Activity events={activity} />
    </main>
  );
}

function monitorDecks(decks: DeckState[]): DeckState[] {
  const byPlayer = new Map(decks.map((deck) => [deck.player, deck]));
  const players = [
    ...decks.filter((deck) => deck.connected).map((deck) => deck.player),
    ...decks.map((deck) => deck.player),
    1,
    2,
    3,
  ].filter((player, index, all) => all.indexOf(player) === index);

  return players
    .slice(0, 3)
    .sort((a, b) => a - b)
    .map((player) => byPlayer.get(player) ?? emptyDeck(player));
}

function Cdj3000({ deck }: { deck: DeckState }) {
  const waveform = useTrackWaveform(deck.trackId, deck.sourcePlayer, deck.sourceSlot);
  const trackLengthSec = deck.trackLengthSec ?? waveform?.durationSeconds ?? null;
  const beatGridMs = beatGridPositionMs(deck.beatNumber, waveform?.beatGrid);
  const inferredPlayheadMs = useDeckPlayhead(deck, trackLengthSec, beatGridMs);
  const progress =
    inferredPlayheadMs != null && trackLengthSec != null && trackLengthSec > 0
      ? clamp((inferredPlayheadMs / (trackLengthSec * 1_000)) * 100, 0, 100)
      : 0;
  const bpm = deck.effectiveBpm ?? deck.bpm;
  const jogAngle = (((inferredPlayheadMs ?? 0) % 1_800) / 1_800) * 360;

  return (
    <article
      className={`cdj3000 ${deck.connected ? "is-online" : "is-offline"} ${deck.playing ? "is-playing" : ""}`}
      aria-label={`CDJ-3000 player ${deck.player}`}
    >
      <div className="cdj-coordinate-plane">
        <img className="hardware-photo cdj-photo" src={CDJ_3000_IMAGE} alt="CDJ-3000 top view" />

        <section className="cdj-live-screen">
          <div className="cdj-screen-nav">
            <b>{deck.connected ? (deck.model ?? "CDJ-3000") : "PRO DJ LINK"}</b>
            <span>PLAYER {deck.player}</span>
            <em className={deck.connected ? "online" : "offline"}>
              {deck.connected ? "LINK" : "WAITING"}
            </em>
          </div>
          {deck.connected ? (
            <>
              <div className="cdj-trackline">
                <span>
                  <strong>
                    {deck.trackTitle ?? (deck.trackId ? "LOADING TRACK…" : "NO TRACK LOADED")}
                  </strong>
                  {deck.trackArtist ? <small>{deck.trackArtist}</small> : null}
                </span>
                <b>{deck.tempoMaster ? "MASTER" : deck.synced ? "SYNC" : ""}</b>
              </div>
              <CdjWaveform playheadMs={inferredPlayheadMs} bpm={deck.bpm} waveform={waveform} />
              <div className="cdj-screen-bottom">
                <span>
                  <small>PLAYED</small>
                  <b>{Math.round(progress)}%</b>
                </span>
                <span className="cdj-time">
                  <small>ELAPSED / TOTAL</small>
                  <b>
                    {formatTime(inferredPlayheadMs)} / {formatDuration(trackLengthSec)}
                  </b>
                </span>
                <span>
                  <small>TEMPO</small>
                  <b>{formatPitch(deck.pitchPercent)}</b>
                </span>
                <span className="cdj-bpm">
                  <small>BPM</small>
                  <b>{formatBpm(bpm)}</b>
                </span>
              </div>
            </>
          ) : (
            <div className="cdj-offline-screen">
              <i />
              <strong>LINK OFFLINE</strong>
              <span>Waiting for player {deck.player}</span>
            </div>
          )}
        </section>

        <div
          className="cdj-jog-live"
          style={cdjSpriteStyle(50.2, 67.4, 50.2, 67.4, 12.8, 12.8 * CDJ_IMAGE.faceRatio)}
        >
          <i style={{ transform: `rotate(${jogAngle}deg)` }} />
          <span>{deck.playing ? "PLAY" : (deck.playState ?? "IDLE").toUpperCase()}</span>
          <strong>{formatTime(inferredPlayheadMs)}</strong>
          <small>{deck.beatInBar ?? "–"}/4</small>
        </div>

        <i
          className={`cdj-photo-button cdj-cue-glow ${deck.active && !deck.playing ? "lit" : ""}`}
          style={cdjSpriteStyle(13.25, 81.4, 13.25, 81.4, 10.8, 10.8 * CDJ_IMAGE.faceRatio)}
          aria-label={deck.active && !deck.playing ? "Cue active" : "Cue inactive"}
        />
        <i
          className={`cdj-photo-button cdj-play-glow ${deck.playing ? "lit" : ""}`}
          style={cdjSpriteStyle(13.25, 91.25, 13.25, 91.25, 10.8, 10.8 * CDJ_IMAGE.faceRatio)}
          aria-label={deck.playing ? "Playing" : "Play paused"}
        />
        <CdjTempoFader pitch={deck.pitchPercent} />
      </div>
    </article>
  );
}

type DeckTimelineAnchor = {
  trackId: number | null;
  rawMs: number | null;
  positionMs: number;
  anchoredAtMs: number;
  playing: boolean;
  durationMs: number | null;
  playbackRate: number;
};

function useDeckPlayhead(
  deck: DeckState,
  durationSec: number | null,
  beatGridMs: number | null,
): number | null {
  const durationMs = durationSec == null ? null : durationSec * 1_000;
  const rawMs = deck.playheadMs ?? beatGridMs;
  const playbackRate = Math.max(0, 1 + (deck.pitchPercent ?? 0) / 100);
  const anchorRef = useRef<DeckTimelineAnchor | undefined>(undefined);
  const [positionMs, setPositionMs] = useState<number | null>(rawMs);

  useEffect(() => {
    const now = performance.now();
    const previous = anchorRef.current;
    const previousEstimate = previous == null ? 0 : estimateDeckPosition(previous, now);
    const trackChanged = previous?.trackId !== deck.trackId;
    const rawChanged = rawMs != null && rawMs !== previous?.rawMs;
    const errorMs = rawMs == null ? 0 : rawMs - previousEstimate;
    // Preserve seeks/loops and stopped positions, but absorb packet timing jitter
    // during playback instead of snapping the scrolling waveform on every beat.
    const snap = trackChanged || !deck.playing || !previous?.playing || Math.abs(errorMs) > 750;
    const nextPosition = trackChanged
      ? (rawMs ?? 0)
      : rawChanged
        ? snap
          ? rawMs
          : previousEstimate + errorMs * 0.12
        : previousEstimate;
    const boundedPosition = boundPlayhead(nextPosition, durationMs);
    anchorRef.current = {
      trackId: deck.trackId,
      rawMs,
      positionMs: boundedPosition,
      anchoredAtMs: now,
      playing: deck.playing,
      durationMs,
      playbackRate,
    };
    setPositionMs(deck.trackId == null ? null : boundedPosition);
  }, [deck.playing, deck.trackId, durationMs, playbackRate, rawMs]);

  useEffect(() => {
    if (!deck.playing || deck.trackId == null) return;
    let frame = 0;
    const tick = (now: number) => {
      const anchor = anchorRef.current;
      if (anchor) {
        setPositionMs(estimateDeckPosition(anchor, now));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [deck.playing, deck.trackId]);

  return positionMs;
}

function estimateDeckPosition(anchor: DeckTimelineAnchor, now: number): number {
  const elapsed = anchor.playing ? Math.max(0, now - anchor.anchoredAtMs) * anchor.playbackRate : 0;
  return boundPlayhead(anchor.positionMs + elapsed, anchor.durationMs);
}

function beatGridPositionMs(
  beatNumber: number | null,
  beatGrid?: Array<{ beat: 1 | 2 | 3 | 4; timeSeconds: number }>,
): number | null {
  if (beatNumber == null || !beatGrid?.length) return null;
  if (beatNumber <= 0) return 0;
  const beat = beatGrid[beatNumber - 1];
  return beat == null ? null : beat.timeSeconds * 1_000;
}

function boundPlayhead(positionMs: number, durationMs: number | null): number {
  return clamp(positionMs, 0, durationMs ?? Number.MAX_SAFE_INTEGER);
}

function CdjTempoFader({ pitch }: { pitch?: number | null }) {
  if (pitch == null) return null;
  const sourceX = 86.7;
  const sourceY = 79.0;
  const top = 66.7;
  const height = 25.5;
  const y = top + (pitchToFader(pitch) / 100) * height;
  return (
    <span className="cdj-tempo-live" aria-label={`Tempo ${formatPitch(pitch)}`}>
      <i
        className="cdj-tempo-restoration"
        style={cdjSpriteStyle(sourceX, sourceY - 3.35, sourceX, sourceY, 5.8, 3.0)}
      />
      <i className="cdj-tempo-cap" style={cdjSpriteStyle(sourceX, sourceY, sourceX, y, 5.8, 2.7)} />
    </span>
  );
}

function cdjSpriteStyle(
  sourceX: number,
  sourceY: number,
  x: number,
  y: number,
  width: number,
  height: number,
): CSSProperties {
  const sourceLeft = sourceX - width / 2;
  const sourceTop = sourceY - height / 2;
  const imageLeft = ((CDJ_IMAGE.left - sourceLeft) / width) * 100;
  const imageTop = ((CDJ_IMAGE.top - sourceTop) / height) * 100;
  const imageWidth = (CDJ_IMAGE.width / width) * 100;
  const imageHeight = (CDJ_IMAGE.height / height) * 100;
  const positionX = (imageLeft / (100 - imageWidth)) * 100;
  const positionY = (imageTop / (100 - imageHeight)) * 100;
  return {
    left: `${x}%`,
    top: `${y}%`,
    width: `${width}%`,
    height: `${height}%`,
    backgroundImage: `url("${CDJ_3000_IMAGE}")`,
    backgroundPosition: `${positionX}% ${positionY}%`,
    backgroundRepeat: "no-repeat",
    backgroundSize: `${imageWidth}% ${imageHeight}%`,
    transform: "translate(-50%, -50%)",
  };
}

function DjmA9({
  controls,
  meters,
  connected,
  bpm,
}: {
  controls: Record<string, ControlState>;
  meters: Record<string, MeterState>;
  connected: boolean;
  bpm?: number | null;
}) {
  const channelXs = [30.34, 40.91, 51.43, 61.99];
  const soundColorFx = controlState(controls, "soundColorFx.effect");
  const beatFx = controlState(controls, "beatFx.effect");
  const beatFxChannel = controlState(controls, "beatFx.channel");
  const beatFxTime = controls["beatFx.time"];
  const beatFxXPad = controls["beatFx.xPad"];
  const calibration = a9CalibrationMode();

  return (
    <article
      className={`djma9 ${connected ? "is-online" : "is-offline"} ${calibration === "sweep" ? "is-calibrating-sweep" : ""}`}
      aria-label="DJM-A9 mixer"
    >
      <div className="a9-photo-crop">
        <img className="hardware-photo a9-photo" src={DJM_A9_IMAGE} alt="DJM-A9 front top view" />

        {[1, 2, 3, 4].map((channel, index) => {
          const x = channelXs[index] ?? 0;
          const path = `channel.${channel}`;
          return (
            <div className="a9-channel-live" key={channel}>
              <PhotoLevelMeter
                x={x - 4.84}
                meter={
                  meters[`ethernet.${channel}`] ?? meters[`usb.${index * 2 + 3}_${index * 2 + 4}`]
                }
                label={`Channel ${channel}`}
              />
              <PhotoStateKnob
                x={x}
                y={9.4}
                size={3.5}
                family="input-selector"
                control={controls[`${path}.input`]}
                states={["bluetooth", "a", "b", "digital", "line", "phono", "return", "usb"]}
              />
              <PhotoKnob
                x={x}
                y={16.0}
                size={3.7}
                family="trim"
                control={controls[`${path}.trim`]}
              />
              <PhotoKnob
                x={x}
                y={23.0}
                size={4.5}
                family="eq"
                control={controls[`${path}.eq.high`]}
              />
              <PhotoKnob
                x={x}
                y={30.98}
                size={4.5}
                family="eq"
                control={controls[`${path}.eq.mid`]}
              />
              <PhotoKnob
                x={x}
                y={38.85}
                size={4.5}
                family="eq"
                control={controls[`${path}.eq.low`]}
              />
              <PhotoKnob
                x={x}
                y={49.0}
                size={5.1}
                family="color"
                control={controls[`${path}.color`]}
              />
              <PhotoLed
                x={x - 2.2}
                y={57.6}
                size={3.9}
                on={isOn(controls[`${path}.cueA`])}
                known={controls[`${path}.cueA`] !== undefined}
                color="amber"
              />
              <PhotoLed
                x={x + 2.2}
                y={57.6}
                size={3.9}
                on={isOn(controls[`${path}.cueB`])}
                known={controls[`${path}.cueB`] !== undefined}
                color="amber"
              />
              <PhotoFader x={x} y={73.8} height={12.5} control={controls[`${path}.fader`]} />
              <PhotoThreeSwitch x={x} y={86.0} control={controls[`${path}.crossfaderAssign`]} />
            </div>
          );
        })}

        <PhotoLevelMeter
          x={71.4}
          meter={meters["usb.1_2"]}
          label="Master left"
          channel="left"
          narrow
        />
        <PhotoLevelMeter
          x={76.55}
          meter={meters["usb.1_2"]}
          label="Master right"
          channel="right"
          narrow
        />

        <PhotoImageButton
          x={18.3}
          y={24.6}
          width={3.85}
          height={2.75}
          on={isOn(controls["bluetooth.on"])}
          known={controls["bluetooth.on"] !== undefined}
          label="Bluetooth"
          tone="blue"
        />
        <PhotoImageButton
          x={6.75}
          y={42.25}
          width={2.05}
          height={1.95}
          on={isOn(controls["microphone.talkOver"])}
          known={controls["microphone.talkOver"] !== undefined}
          label="Microphone talk over"
          tone="red"
          round
        />
        {(
          [
            { name: "echo", y: 47.05 },
            { name: "pitch", y: 51.75 },
            { name: "megaphone", y: 56.45 },
          ] as const
        ).map((effect) => (
          <PhotoImageButton
            key={effect.name}
            x={6.75}
            y={effect.y}
            width={3.95}
            height={2.12}
            on={isOn(controls[`microphone.fx.${effect.name}`])}
            known={controls[`microphone.fx.${effect.name}`] !== undefined}
            label={`Microphone ${effect.name}`}
            tone="blue"
          />
        ))}
        <PhotoImageButton
          x={6.75}
          y={71.1}
          width={3.7}
          height={2.15}
          on={isOn(controls["microphone.reverb"])}
          known={controls["microphone.reverb"] !== undefined}
          label="Microphone reverb"
          tone="blue"
        />
        <PhotoImageButton
          x={6.75}
          y={91.1}
          width={4.05}
          height={3.88}
          on={isOn(controls["microphone.on"])}
          known={controls["microphone.on"] !== undefined}
          label="Microphone on"
          tone="blue"
          round
        />

        <PhotoKnob
          x={6.9}
          y={28.0}
          size={3.8}
          family="eq"
          control={controls["microphone.eq.high"]}
        />
        <PhotoKnob
          x={6.9}
          y={35.1}
          size={3.8}
          family="eq"
          control={controls["microphone.eq.low"]}
        />
        <PhotoKnob
          x={6.7}
          y={62.9}
          size={4.3}
          family="utility"
          control={controls["microphone.fx.parameter"]}
        />
        <PhotoKnob
          x={6.7}
          y={76.8}
          size={4.3}
          family="utility"
          control={controls["microphone.reverbParameter"]}
        />

        <SoundColorFx effect={soundColorFx} />
        <PhotoImageButton
          x={15.85}
          y={71.15}
          width={3.65}
          height={2.12}
          on={isOn(controls["headphonesA.linkCue"])}
          known={controls["headphonesA.linkCue"] !== undefined}
          label="Headphones A link cue"
          tone="amber"
        />
        <PhotoImageButton
          x={20.95}
          y={71.15}
          width={3.65}
          height={2.12}
          on={isOn(controls["headphonesA.monoSplit"])}
          known={controls["headphonesA.monoSplit"] !== undefined}
          label="Headphones A mono split"
          tone="amber"
        />
        <PhotoKnob
          x={18.3}
          y={62.9}
          size={4.4}
          family="utility"
          control={controls["soundColorFx.parameter"]}
        />
        <PhotoKnob
          x={18.3}
          y={76.9}
          size={4.4}
          family="utility"
          control={controls["headphonesA.mixing"]}
        />
        <PhotoKnob
          x={18.3}
          y={83.8}
          size={4.4}
          family="utility"
          control={controls["headphonesA.level"]}
        />

        <PhotoKnob
          x={74.0}
          y={7.4}
          size={4.4}
          family="utility"
          control={controls["master.level"]}
        />
        <PhotoKnob x={74.0} y={41.5} size={3.8} family="eq" control={controls["booth.eq.high"]} />
        <PhotoKnob x={74.0} y={46.0} size={3.8} family="eq" control={controls["booth.eq.low"]} />
        <PhotoKnob
          x={74.0}
          y={51.8}
          size={4.2}
          family="utility"
          control={controls["booth.level"]}
        />
        <PhotoKnob
          x={74.0}
          y={71.6}
          size={4.3}
          family="utility"
          control={controls["headphonesB.mixing"]}
        />
        <PhotoKnob
          x={74.0}
          y={77.6}
          size={4.3}
          family="utility"
          control={controls["headphonesB.level"]}
        />
        <PhotoStateKnob
          x={82.55}
          y={8.05}
          size={4.2}
          family="input-selector"
          control={controls["multiIo.sendChannel"]}
          states={[
            "channel1",
            "channel2",
            "channel3",
            "channel4",
            "microphone",
            "crossfaderA",
            "crossfaderB",
            "master",
          ]}
        />
        <PhotoKnob
          x={82.55}
          y={15.3}
          size={4.1}
          family="utility"
          control={controls["multiIo.sendLevel"]}
        />
        <PhotoVerticalSwitch
          x={89.25}
          y={8.45}
          control={controls["multiIo.insertSource"]}
          low="return"
          high="usb"
          label="Multi I/O insert source"
        />
        <PhotoImageButton
          x={89.25}
          y={15.3}
          width={3.05}
          height={2.95}
          on={isOn(controls["multiIo.insert"])}
          known={controls["multiIo.insert"] !== undefined}
          label="Multi I/O insert"
          tone="blue"
          round
        />
        <PhotoImageButton
          x={71.7}
          y={57.6}
          width={3.9}
          height={2.22}
          on={isOn(controls["master.cueA"])}
          known={controls["master.cueA"] !== undefined}
          label="Master cue A"
          tone="amber"
        />
        <PhotoImageButton
          x={76.25}
          y={57.6}
          width={3.9}
          height={2.22}
          on={isOn(controls["master.cueB"])}
          known={controls["master.cueB"] !== undefined}
          label="Master cue B"
          tone="amber"
        />
        <PhotoImageButton
          x={71.7}
          y={66.3}
          width={3.7}
          height={2.08}
          on={isOn(controls["headphonesB.linkCue"])}
          known={controls["headphonesB.linkCue"] !== undefined}
          label="Headphones B link cue"
          tone="amber"
        />
        <PhotoImageButton
          x={76.25}
          y={66.3}
          width={3.7}
          height={2.08}
          on={isOn(controls["headphonesB.monoSplit"])}
          known={controls["headphonesB.monoSplit"] !== undefined}
          label="Headphones B mono split"
          tone="amber"
        />

        <section className="a9-beatfx-screen">
          <header>
            <span className={isOn(controls["beatFx.quantize"]) ? "active" : ""}>QUANTIZE</span>
            <em>AUTO</em>
            <b>
              {formatBpm(bpm)} <small>BPM</small>
            </b>
          </header>
          <strong>{beatFx ? prettyEffect(beatFx) : "BEAT FX"}</strong>
          <div className="a9-beat-values">
            <span>1/2</span>
            <span>1</span>
            <span>2</span>
          </div>
          <div className="a9-fx-time">
            <small>TIME</small>
            <b>{beatFxTime?.value ?? "---"}</b>
            <small>ms</small>
          </div>
          <div className="a9-screen-xpad">
            <i style={{ width: `${beatFxXPad?.percent ?? 0}%` }} />
            <span>X-PAD</span>
          </div>
          <footer>{formatFxChannel(beatFxChannel)}</footer>
        </section>
        <PhotoXPad control={controls["beatFx.xPad"]} />
        <PhotoImageButton
          x={84.85}
          y={42.3}
          width={4.15}
          height={2.2}
          on={isOn(controls["beatFx.beatLeft"])}
          known={controls["beatFx.beatLeft"] !== undefined}
          label="Beat FX beat left"
        />
        <PhotoImageButton
          x={93.55}
          y={42.3}
          width={4.15}
          height={2.2}
          on={isOn(controls["beatFx.beatRight"])}
          known={controls["beatFx.beatRight"] !== undefined}
          label="Beat FX beat right"
        />
        <PhotoImageButton
          x={84.45}
          y={47.15}
          width={2.35}
          height={2.28}
          on={isOn(controls["beatFx.autoTap"])}
          known={controls["beatFx.autoTap"] !== undefined}
          label="Beat FX auto tap"
          round
        />
        <PhotoImageButton
          x={89.2}
          y={47.15}
          width={4.05}
          height={3.9}
          on={isOn(controls["beatFx.tap"])}
          known={controls["beatFx.tap"] !== undefined}
          label="Beat FX tap"
          tone="green"
          round
        />
        <PhotoImageButton
          x={93.85}
          y={47.15}
          width={2.35}
          height={2.28}
          on={isOn(controls["beatFx.quantize"])}
          known={controls["beatFx.quantize"] !== undefined}
          label="Beat FX quantize"
          tone="red"
          round
        />
        <div className="a9-frequency-lights">
          {(["low", "mid", "high"] as const).map((band, index) => (
            <PhotoImageButton
              key={band}
              x={[84.6, 89.05, 93.5][index] ?? 0}
              y={52.3}
              width={3.45}
              height={1.72}
              on={
                a9CalibrationMode() === "max" ||
                (a9CalibrationMode() !== "min" && isOn(controls[`beatFx.frequency.${band}`]))
              }
              known={controls[`beatFx.frequency.${band}`] !== undefined}
              label={`Beat FX frequency ${band}`}
              tone="blue"
            />
          ))}
        </div>
        <PhotoStateKnob
          x={89.1}
          y={58.3}
          size={5.1}
          family="fx-selector"
          control={controls["beatFx.effect"]}
          states={[
            "delay",
            "echo",
            "pingPong",
            "spiral",
            "helix",
            "reverb",
            "flanger",
            "phaser",
            "filter",
            "tripletFilter",
            "trans",
            "roll",
            "tripletRoll",
            "mobius",
          ]}
        />
        <BeatFxChannelButtons selected={beatFxChannel} known={beatFxChannel !== undefined} />
        <PhotoKnob
          x={89.1}
          y={76.7}
          size={4.4}
          family="utility"
          control={controls["beatFx.time"]}
        />
        <PhotoKnob
          x={89.1}
          y={84.8}
          size={5.1}
          family="fx-depth"
          control={controls["beatFx.levelDepth"]}
        />
        <PhotoLed
          x={89.1}
          y={92.9}
          size={4.5}
          on={isOn(controls["beatFx.on"])}
          known={controls["beatFx.on"] !== undefined}
          color="blue"
        />
        <PhotoThreeSwitch
          x={74.0}
          y={83.15}
          control={controls["eq.curve"]}
          label="EQ curve"
          positions={{ isolator: -0.68, eq: 0.68 }}
        />
        <PhotoThreeSwitch
          x={74.0}
          y={87.55}
          control={controls["channelFader.curve"]}
          label="Channel fader curve"
          positions={{ left: -0.78, center: 0, right: 0.78 }}
        />
        <PhotoThreeSwitch
          x={74.0}
          y={92.0}
          control={controls["crossfader.curve"]}
          label="Crossfader curve"
          positions={{ left: -0.78, center: 0, right: 0.78 }}
        />
        <PhotoHorizontalFader
          x={45.8}
          y={94.65}
          width={10.8}
          control={controls["crossfader.position"]}
        />
      </div>
    </article>
  );
}

const A9_METER_THRESHOLDS = [-33, -30, -27, -24, -21, -18, -15, -12, -9, -6, -3, 0, 3, 6, 9, 12];

function PhotoLevelMeter({
  x,
  meter,
  label,
  channel = "combined",
  narrow = false,
}: {
  x: number;
  meter?: MeterState;
  label: string;
  channel?: "combined" | "left" | "right";
  narrow?: boolean;
}) {
  const sourceDbfs =
    channel === "left"
      ? meter?.leftPeakDbfs
      : channel === "right"
        ? meter?.rightPeakDbfs
        : meter?.peakDbfs;
  // Pioneer aligns 0 dBFS with the top of the meter. The faceplate's printed
  // scale is an analog-style +12…-33 scale, so shift digital full-scale by 12 dB.
  const displayDb = sourceDbfs == null ? -120 : sourceDbfs + 12;
  const litSegments = A9_METER_THRESHOLDS.filter((threshold) => displayDb >= threshold).length;
  const revealTop = 100 - (litSegments / A9_METER_THRESHOLDS.length) * 100;
  const width = narrow ? 1.05 : 1.18;
  const sprite = a9SpriteStyle(x, 24.275, x, 24.275, width, 24.15);
  return (
    <span
      className={`a9-level-meter ${narrow ? "is-master" : ""}`}
      title={`${label}: ${sourceDbfs == null ? "—" : `${sourceDbfs.toFixed(1)} dBFS`}`}
      aria-label={`${label} level ${sourceDbfs == null ? "unavailable" : `${sourceDbfs.toFixed(1)} dBFS`}`}
    >
      <i className="a9-photo-sprite a9-meter-sprite is-dark" style={sprite} />
      <i
        className="a9-photo-sprite a9-meter-sprite is-lit"
        style={{ ...sprite, clipPath: `inset(${revealTop}% 0 0)` }}
      />
    </span>
  );
}

function SoundColorFx({ effect }: { effect?: string }) {
  const calibration = a9CalibrationMode();
  const buttons = [
    { effect: "space", x: 15.85, y: 47.0 },
    { effect: "dubEcho", x: 20.95, y: 47.0 },
    { effect: "crush", x: 15.85, y: 51.65 },
    { effect: "sweep", x: 20.95, y: 51.65 },
    { effect: "noise", x: 15.85, y: 56.4 },
    { effect: "filter", x: 20.95, y: 56.4 },
  ] as const;
  return (
    <div className="a9-colorfx-live" aria-label={`Sound Color FX ${effect ?? "unknown"}`}>
      {buttons.map((button) => (
        <PhotoImageButton
          key={button.effect}
          x={button.x}
          y={button.y}
          width={4.0}
          height={2.18}
          on={calibration === "max" || (calibration !== "min" && effect === button.effect)}
          known={effect !== undefined}
          label={prettyEffect(button.effect)}
        />
      ))}
    </div>
  );
}

function PhotoImageButton({
  x,
  y,
  width,
  height,
  on,
  known = true,
  label,
  tone = "white",
  round = false,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  on: boolean;
  known?: boolean;
  label: string;
  tone?: "white" | "blue" | "red" | "amber" | "green";
  round?: boolean;
}) {
  const calibration = a9CalibrationMode();
  if (!known && calibration == null) return null;
  const illuminated = calibration === "max" || (calibration !== "min" && on);
  return (
    <i
      className={`a9-photo-sprite a9-image-button tone-${tone} ${round ? "is-round" : ""} ${illuminated ? "lit" : ""}`}
      style={a9SpriteStyle(x, y, x, y, width, height)}
      aria-label={`${label} ${illuminated ? "on" : "off"}`}
    />
  );
}

function PhotoKnob({
  x,
  y,
  size,
  family,
  control,
}: {
  x: number;
  y: number;
  size: number;
  family: A9KnobFamily;
  control?: ControlState;
}) {
  const value = calibratedPercent(control?.percent);
  if (value === undefined) return null;
  const angle = -135 + (value ?? 50) * 2.7;
  const rotor = a9RotorStyle(x, y, size, angle, A9_KNOB_BODY_RADIUS[family]);
  return (
    <span
      className={`a9-rotor-window knob-${family}`}
      style={rotor.frame}
      title={`${control?.label ?? "Uninitialized"}: ${value === undefined ? "—" : `${Math.round(value)}%`}`}
    >
      <i className="a9-rotor-sprite" style={rotor.sprite} />
    </span>
  );
}

function PhotoStateKnob({
  x,
  y,
  size,
  family,
  control,
  states,
}: {
  x: number;
  y: number;
  size: number;
  family: Extract<A9KnobFamily, "input-selector" | "fx-selector">;
  control?: ControlState;
  states: string[];
}) {
  const index = control?.state ? states.indexOf(control.state) : -1;
  const livePercent = index < 0 ? undefined : (index / Math.max(states.length - 1, 1)) * 100;
  const percent = calibratedPercent(livePercent);
  if (percent === undefined) return null;
  const angle = -135 + (percent ?? 50) * 2.7;
  const rotor = a9RotorStyle(x, y, size, angle, A9_KNOB_BODY_RADIUS[family]);
  return (
    <span
      className={`a9-rotor-window photo-selector knob-${family}`}
      style={rotor.frame}
      title={`${control?.label ?? "Uninitialized"}: ${control?.state ?? "—"}`}
    >
      <i className="a9-rotor-sprite" style={rotor.sprite} />
    </span>
  );
}

function a9RotorStyle(
  x: number,
  y: number,
  size: number,
  angle: number,
  radiusScale: number,
): { frame: CSSProperties; sprite: CSSProperties } {
  const diameter = size * radiusScale * 2;
  const diameterY = diameter * A9_IMAGE.faceRatio;
  const windowLeft = x - diameter / 2;
  const windowTop = y - diameterY / 2;
  const imageLeft = ((A9_IMAGE.left - windowLeft) / diameter) * 100;
  const imageTop = ((A9_IMAGE.top - windowTop) / diameterY) * 100;
  const imageWidth = (A9_IMAGE.width / diameter) * 100;
  const imageHeight = (A9_IMAGE.height / diameterY) * 100;
  const positionX = (imageLeft / (100 - imageWidth)) * 100;
  const positionY = (imageTop / (100 - imageHeight)) * 100;
  return {
    frame: {
      left: `${x}%`,
      top: `${y}%`,
      width: `${diameter}%`,
    },
    sprite: {
      backgroundImage: `url("${DJM_A9_IMAGE}")`,
      backgroundPosition: `${positionX}% ${positionY}%`,
      backgroundRepeat: "no-repeat",
      backgroundSize: `${imageWidth}% ${imageHeight}%`,
      transform: `rotate(${angle}deg)`,
    },
  };
}

function a9SpriteStyle(
  sourceX: number,
  sourceY: number,
  x: number,
  y: number,
  width: number,
  height: number,
): CSSProperties {
  const sourceLeft = sourceX - width / 2;
  const sourceTop = sourceY - height / 2;
  const imageLeft = ((A9_IMAGE.left - sourceLeft) / width) * 100;
  const imageTop = ((A9_IMAGE.top - sourceTop) / height) * 100;
  const imageWidth = (A9_IMAGE.width / width) * 100;
  const imageHeight = (A9_IMAGE.height / height) * 100;
  const positionX = (imageLeft / (100 - imageWidth)) * 100;
  const positionY = (imageTop / (100 - imageHeight)) * 100;

  return {
    left: `${x}%`,
    top: `${y}%`,
    width: `${width}%`,
    height: `${height}%`,
    backgroundImage: `url("${DJM_A9_IMAGE}")`,
    backgroundPosition: `${positionX}% ${positionY}%`,
    backgroundRepeat: "no-repeat",
    backgroundSize: `${imageWidth}% ${imageHeight}%`,
    transform: "translate(-50%, -50%)",
  };
}

function PhotoThreeSwitch({
  x,
  y,
  control,
  label = "Crossfader assign",
  positions = { a: -0.9, thru: 0, b: 0.9 },
}: {
  x: number;
  y: number;
  control?: ControlState;
  label?: string;
  positions?: Record<string, number>;
}) {
  const calibration = a9CalibrationMode();
  const availableOffsets = Object.values(positions);
  const liveOffset = control?.state == null ? undefined : positions[control.state];
  const offset =
    calibration === "min"
      ? Math.min(...availableOffsets)
      : calibration === "max"
        ? Math.max(...availableOffsets)
        : calibration === "center"
          ? 0
          : (liveOffset ?? 0);
  const known = calibration != null || liveOffset !== undefined;
  if (!known) return null;
  return (
    <span
      className="a9-three-switch-live"
      title={`${control?.label ?? label}: ${control?.state ?? "—"}`}
    >
      <i
        className="a9-photo-sprite a9-switch-restoration"
        style={a9SpriteStyle(x - 1.45, y, x, y, 1.6, 1.18)}
      />
      <i
        className="a9-photo-sprite a9-switch-cap"
        style={a9SpriteStyle(x, y, x + offset, y, 1.6, 1.18)}
      />
    </span>
  );
}

function PhotoVerticalSwitch({
  x,
  y,
  control,
  low,
  high,
  label,
}: {
  x: number;
  y: number;
  control?: ControlState;
  low: string;
  high: string;
  label: string;
}) {
  const calibration = a9CalibrationMode();
  const state =
    calibration === "min"
      ? low
      : calibration === "max"
        ? high
        : calibration === "center"
          ? low
          : control?.state;
  if (state == null) return null;
  const offset = state === high ? 0.72 : -0.72;
  return (
    <span className="a9-vertical-switch-live" title={`${control?.label ?? label}: ${state ?? "—"}`}>
      <i
        className="a9-photo-sprite a9-vswitch-restoration"
        style={a9SpriteStyle(x, y - 2.1, x, y, 1.65, 2.15)}
      />
      <i
        className="a9-photo-sprite a9-vswitch-cap"
        style={a9SpriteStyle(x, y, x, y + offset, 1.5, 1.85)}
      />
    </span>
  );
}

function PhotoXPad({ control }: { control?: ControlState }) {
  const value = calibratedPercent(control?.percent);
  if (value === undefined) return null;
  return (
    <span className="photo-xpad">
      <i style={{ left: `${value}%` }} />
    </span>
  );
}

function BeatFxChannelButtons({ selected, known }: { selected?: string; known: boolean }) {
  const channels = [
    { name: "channel1", x: 83.85, y: 66.35 },
    { name: "channel2", x: 87.4, y: 66.35 },
    { name: "channel3", x: 90.95, y: 66.35 },
    { name: "channel4", x: 94.45, y: 66.35 },
    { name: "microphone", x: 83.85, y: 69.1 },
    { name: "crossfaderA", x: 87.4, y: 69.1 },
    { name: "crossfaderB", x: 90.95, y: 69.1 },
    { name: "master", x: 94.45, y: 69.1 },
  ] as const;
  const calibration = a9CalibrationMode();
  return (
    <span className="a9-channel-select-live">
      {channels.map((channel) => (
        <PhotoImageButton
          key={channel.name}
          x={channel.x}
          y={channel.y}
          width={2.75}
          height={1.62}
          on={calibration === "max" || (calibration !== "min" && channel.name === selected)}
          known={known}
          label={`Beat FX ${prettyEffect(channel.name)}`}
          tone="blue"
        />
      ))}
    </span>
  );
}

function PhotoFader({
  x,
  y,
  height,
  control,
}: {
  x: number;
  y: number;
  height: number;
  control?: ControlState;
}) {
  const value = calibratedPercent(control?.percent);
  if (value === undefined) return null;
  const handleY = y + height / 2 - ((value ?? 50) / 100) * height;
  return (
    <span
      className="a9-vfader-live"
      title={`${control?.label ?? "Uninitialized"}: ${value === undefined ? "—" : `${Math.round(value)}%`}`}
    >
      <i
        className="a9-photo-sprite a9-vfader-restoration"
        style={a9SpriteStyle(x, y - 2.5, x, y, 5.15, 2.35)}
      />
      <i
        className="a9-photo-sprite a9-vfader-cap"
        style={a9SpriteStyle(x, y, x, handleY, 5.05, 1.72)}
      />
    </span>
  );
}

function PhotoHorizontalFader({
  x,
  y,
  width,
  control,
}: {
  x: number;
  y: number;
  width: number;
  control?: ControlState;
}) {
  const value = calibratedPercent(control?.percent);
  if (value === undefined) return null;
  const handleX = x - width / 2 + ((value ?? 50) / 100) * width;
  return (
    <span
      className="a9-hfader-live"
      title={`${control?.label ?? "Crossfader"}: ${value === undefined ? "—" : `${Math.round(value)}%`}`}
    >
      <i
        className="a9-photo-sprite a9-hfader-restoration"
        style={a9SpriteStyle(x - 3.2, y, x, y, 2.55, 5.8)}
      />
      <i
        className="a9-photo-sprite a9-hfader-cap"
        style={a9SpriteStyle(x, y, handleX, y, 2.25, 5.45)}
      />
    </span>
  );
}

function PhotoLed({
  x,
  y,
  on,
  known = true,
  color,
  size = 1.8,
}: {
  x: number;
  y: number;
  on: boolean;
  known?: boolean;
  color: "amber" | "blue";
  size?: number;
}) {
  const calibration = a9CalibrationMode();
  if (!known && calibration == null) return null;
  const illuminated = calibration === "max" || (calibration !== "min" && on);
  const height = (size * A9_IMAGE.faceRatio) / (color === "amber" ? 1.55 : 1);
  const sourceX = color === "amber" ? (illuminated ? 28.2 : 32.6) : 89.1;
  const sourceY = color === "amber" ? 57.6 : 92.9;
  return (
    <i
      className={`a9-photo-sprite a9-photo-led led-${color} ${illuminated ? "lit" : ""}`}
      style={a9SpriteStyle(sourceX, sourceY, x, y, size, height)}
    />
  );
}

function Activity({ events }: { events: DecodedEvent[] }) {
  return (
    <aside className="activity-strip">
      <span>LIVE INPUT</span>
      <div>
        {events.length === 0 ? (
          <i>Waiting for hardware input…</i>
        ) : (
          events.slice(0, 7).map((event, index) => (
            <i key={`${event.timestampUs}-${index}`}>
              {event.control ?? "unknown"} <b>{event.state ?? formatPercent(event.percent)}</b>
            </i>
          ))
        )}
      </div>
    </aside>
  );
}

function controlState(controls: Record<string, ControlState>, path: string): string | undefined {
  const state = controls[path]?.state;
  return state && state !== "off" ? state : undefined;
}

function isOn(control?: ControlState): boolean {
  return control?.state === "on";
}

function prettyEffect(effect: string): string {
  return effect.replace(/([A-Z])/g, " $1").toUpperCase();
}

function formatFxChannel(channel?: string): string {
  if (!channel) return "CH SELECT —";
  return channel.replace("channel", "CH ").replace("crossfader", "CF.").toUpperCase();
}

function formatBpm(value?: number | null): string {
  return value == null ? "---.-" : value.toFixed(1);
}

function formatPitch(value?: number | null): string {
  if (value == null) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatTime(value?: number | null): string {
  if (value == null) return "--:--.---";
  const seconds = Math.floor(value / 1_000);
  const milliseconds = Math.floor(value % 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function formatDuration(value?: number | null): string {
  if (value == null) return "--:--";
  const seconds = Math.max(0, Math.floor(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatPercent(value?: number): string {
  return value === undefined ? "" : `${Math.round(value)}%`;
}

function calibratedPercent(value?: number | null): number | undefined {
  const mode = a9CalibrationMode();
  if (mode === "min") return 0;
  if (mode === "center" || mode === "sweep") return 50;
  if (mode === "max") return 100;
  return value ?? undefined;
}

function a9CalibrationMode(): "min" | "center" | "max" | "sweep" | null {
  const value = new URLSearchParams(window.location.search).get("a9-calibration");
  return value === "min" || value === "center" || value === "max" || value === "sweep"
    ? value
    : null;
}

function pitchToFader(pitch?: number | null): number {
  if (pitch == null) return 50;
  return clamp(50 + (pitch / 16) * 45, 5, 95);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

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
