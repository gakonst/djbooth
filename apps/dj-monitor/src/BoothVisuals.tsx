import { useEffect, useRef, useState } from "react";
import { drawBoothWaveformOverlay } from "./booth-waveform-overlay.js";
import type { DashboardSnapshot, DeckState } from "./types.js";
import { waveformSignal, waveformBeat, shapeWaveformSignal } from "./waveform-signal.js";
import { useTrackWaveform } from "./useTrackWaveform.js";
import { VisualShowControls } from "./VisualShowControls.js";
import { CrowdCameraControls } from "./CrowdCameraControls.js";
import type { CrowdMotion } from "./crowd-motion.js";
import { initialVisualLook, type VisualLook } from "./visual-presets.js";
import {
  visualLane,
  waveformVisualLane,
  waveformBands,
  type VisualLane,
} from "./visual-signals.js";

type Track = {
  id: string;
  title: string;
  artist: string | null;
  path?: string;
  fileExists: boolean;
  bpm?: number;
  durationSeconds?: number;
};
const vertex = `
attribute vec3 seed;
uniform float time,aspect,pixelRatio,activity;
uniform vec4 energy[3],motion[3];
uniform vec2 origins[3];
uniform sampler2D waveforms;
varying vec3 ink;
varying float opacity;
vec3 orbit(float t,float shape){
 vec3 knot=vec3(sin(t)+.32*sin(3.*t),.65*sin(2.*t),.4*cos(3.*t));
 vec3 loop=vec3(cos(t)*(1.+.2*cos(3.*t)),sin(t)*.75,.42*sin(2.*t));
 return mix(knot,loop,shape);
}
void main(){
 int lane=int(seed.z); vec4 e=energy[0];vec4 m=motion[0];vec2 origin=origins[0];vec3 color=vec3(.12,.86,1.);
 if(lane==1){e=energy[1];m=motion[1];origin=origins[1];color=vec3(1.,.2,.55);}
 if(lane==2){e=energy[2];m=motion[2];origin=origins[2];color=vec3(1.,.65,.12);}
 float u=seed.x;
 float family=floor(seed.y*3.);
 float v=fract(seed.y*3.);
 vec4 signal=texture2D(waveforms,vec2(u,(seed.z+.5)/3.));
 float amplitude=signal.a;
 color=signal.rgb;
 float beatPulse=exp(-fract(m.w)*7.);
 float travelingPulse=exp(-fract(m.w-u*8.)*9.);
 float phase=time*.055+seed.z*2.094;
 float spread=sqrt(aspect);
 vec3 p;vec2 root=vec2(0.);float weight=1.;
 if(family<.5){
   // A traveling waveform follows a morphing knot, displaced along the
   // curve normal. Its origin stays attached to the corresponding deck.
   float row=floor(v*24.);
   float shell=(row-11.5)/11.5;
   float shape=.5+.5*sin(time*.043+seed.z*.7);
   float t=u*6.283185+phase+seed.z*.5;
   vec3 curve=orbit(t,shape);
   vec3 tangent=normalize(orbit(t+.01,shape)-orbit(t-.01,shape));
   vec3 normal=normalize(cross(tangent,vec3(0.,0.,1.)));
   float wave=(amplitude-.5)*(.2+e.y*.3)*(1.+m.y);
   float enter=smoothstep(0.,.22,u);
   p=curve*enter;
   p+=normal*(wave+shell*(.035+amplitude*.14)*(1.+travelingPulse*.7))*enter;
   p.z+=shell*.12*enter+m.x*sin(t)*.18;
   p.x*=spread;
   root=origin*(1.-enter);
   weight=(1.-smoothstep(.9,1.,u))*(.95-abs(shell)*.35);
 }else if(family<1.5){
   // Orderly contour sections of a slowly folding shared surface.
   float theta=u*6.283185;
   float phi=floor(v*24.)/24.*6.283185+phase;
   float fold=sin(theta*3.+phi*2.+time*.12+m.x)*(.07+e.z*.1)+(amplitude-.5)*.12;
   float radius=.65+fold+(.18+e.y*.1)*cos(phi+theta*2.);
   p=vec3(cos(theta+phase*.2)*radius*spread,
          sin(theta+phase*.2)*radius,
          (.18+amplitude*.08)*sin(phi+theta*2.));
   p.z+=cos(theta*2.-phase)*.2+m.y*sin(theta*6.+phi)*.08;
   float swivel=sin(time*.067+seed.z)*.6;
   p.xy=mat2(cos(swivel),-sin(swivel),sin(swivel),cos(swivel))*p.xy;
   p.x+=sin(time*.09+seed.z*2.094)*.25;
   p.y+=cos(time*.07+seed.z*2.094)*.18;
   weight=.25;
 }else{
   // Nested square portals create a precise architectural vanishing point.
   // Fade at both ends of travel so recycling a portal never flashes.
   float travel=fract(floor(v*24.)/24.+time*.012);
   float perimeter=u*4.;
   vec2 q;
   if(perimeter<1.)q=vec2(-1.+perimeter*2.,-1.);
   else if(perimeter<2.)q=vec2(1.,-1.+(perimeter-1.)*2.);
   else if(perimeter<3.)q=vec2(1.-(perimeter-2.)*2.,1.);
   else q=vec2(-1.,1.-(perimeter-3.)*2.);
   float scale=.25+travel*1.35;
   float twist=sin(time*.045)*.3+travel*.6+seed.z*.035;
   q=mat2(cos(twist),-sin(twist),sin(twist),cos(twist))*q;
   p=vec3(q*vec2(spread,1.)*scale,travel*.3);
   p.z+=(amplitude-.5)*.05;
   p.xy+=vec2(sin(time*.055),cos(time*.041))*(1.-travel)*.3;
   weight=sin(travel*3.14159)*.16;
 }
 // Each player owns a recognizable family even when WebGPU is unavailable:
 // CDJ 1 ribbons, CDJ 2 folding contours, CDJ 3 square wave portals.
 weight*=abs(family-float(lane))<.5 ? 1. : .08;
 p*=1.+beatPulse*(.045+amplitude*.12);
 float tilt=sin(time*.045)*.16;
 p.yz=mat2(cos(tilt),-sin(tilt),sin(tilt),cos(tilt))*p.yz;
 float perspective=1./(1.+p.z*.55);
 gl_Position=vec4(root+vec2(p.x/aspect,p.y)*perspective,0.,1.);
 float accent=(.88+travelingPulse*.12)*(family<.5 ? 1. : .35);
 vec3 tint=color/max(.004,max(color.r,max(color.g,color.b)));
 ink=mix(vec3(1.),tint,accent)*(.45+amplitude*.25+travelingPulse*.3);
 opacity=min(1.,sqrt(max(0.,e.x))*1.8)*weight*(.6+beatPulse*.4);
 opacity+=activity*.008;

}`;
const fragment = `precision mediump float;varying vec3 ink;varying float opacity;
float threshold(vec2 p){vec2 a=mod(floor(p),2.);vec2 b=mod(floor(p/2.),2.);float x=mod(a.x+a.y,2.)*2.+a.y;float y=mod(b.x+b.y,2.)*2.+b.y;return (x*4.+y+.5)/16.;}
void main(){gl_FragColor=vec4(ink,opacity*(.85+.15*threshold(gl_FragCoord.xy)));}`;

export function BoothVisuals({
  snapshot,
  decks,
  onPreview,
}: {
  snapshot: DashboardSnapshot;
  decks: DeckState[];
  onPreview: (snapshot: DashboardSnapshot | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const waveformOverlayRef = useRef<HTMLCanvasElement>(null);
  const crowdMotion = useRef<CrowdMotion>({ active: false, energy: 0, steering: 0 });
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const audioRefs = useRef<Array<HTMLAudioElement | null>>([]);
  const analysers = useRef<AnalyserNode[]>([]);
  const gains = useRef<GainNode[]>([]);
  const contextRef = useRef<AudioContext | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [trackIds, setTrackIds] = useState<string[]>([]);
  const [faders, setFaders] = useState([0.8, 0.45, 0.25]);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState("");
  const [look, setLook] = useState<VisualLook>(() =>
    initialVisualLook(new URLSearchParams(location.search).get("visual")),
  );
  const waveforms = [
    useTrackWaveform(
      preview ? Number(trackIds[0]) || null : (decks[0]?.trackId ?? null),
      preview ? null : decks[0]?.sourcePlayer,
      preview ? null : decks[0]?.sourceSlot,
    ),
    useTrackWaveform(
      preview ? Number(trackIds[1]) || null : (decks[1]?.trackId ?? null),
      preview ? null : decks[1]?.sourcePlayer,
      preview ? null : decks[1]?.sourceSlot,
    ),
    useTrackWaveform(
      preview ? Number(trackIds[2]) || null : (decks[2]?.trackId ?? null),
      preview ? null : decks[2]?.sourcePlayer,
      preview ? null : decks[2]?.sourceSlot,
    ),
  ];
  const current = useRef({
    snapshot,
    decks,
    preview,
    tracks,
    trackIds,
    faders,
    onPreview,
    waveforms,
    look,
  });
  useEffect(() => {
    current.current = {
      snapshot,
      decks,
      preview,
      tracks,
      trackIds,
      faders,
      onPreview,
      waveforms,
      look,
    };
  }, [snapshot, decks, preview, tracks, trackIds, faders, onPreview, waveforms, look]);
  useEffect(() => {
    const abort = new AbortController();
    void fetch("/api/tracks?limit=100&filter=analyzed", { signal: abort.signal })
      .then((r) => {
        if (!r.ok) throw new Error("Library unavailable");
        return r.json();
      })
      .then((data: { items: Track[] }) => {
        const available = data.items.filter((t) => t.fileExists);
        setTracks(available);
        const baseBpm = available[0]?.bpm ?? 124;
        const candidates = [...available].sort(
          (a, b) => Math.abs((a.bpm ?? 0) - baseBpm) - Math.abs((b.bpm ?? 0) - baseBpm),
        );
        setTrackIds(candidates.slice(0, 3).map((t) => t.id));
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(String(e));
      });
    return () => {
      abort.abort();
      void contextRef.current?.close();
    };
  }, []);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      powerPreference: "high-performance",
    });
    if (!gl) {
      setError("WebGL unavailable");
      return;
    }
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(shader) ?? "Shader failed");
      return shader;
    };
    let program: WebGLProgram;
    let shaders: WebGLShader[];
    try {
      shaders = [compile(gl.VERTEX_SHADER, vertex), compile(gl.FRAGMENT_SHADER, fragment)];
      program = gl.createProgram()!;
      shaders.forEach((s) => gl.attachShader(program, s));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(program) ?? "Shader link failed");
    } catch (e) {
      setError(String(e));
      return;
    }
    gl.useProgram(program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    const waveformTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, waveformTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(program, "waveforms"), 0);
    const textureData = new Uint8Array(256 * 3 * 4);
    // Explicit line segments keep the geometry coherent instead of scattering
    // unconnected particles. 24 contours in each of three families per deck.
    const contours = 72;
    const segments = 256;
    const verticesPerLane = contours * segments * 2;
    const seeds = new Float32Array(verticesPerLane * 9);
    for (let lane = 0; lane < 3; lane++)
      for (let row = 0; row < contours; row++)
        for (let segment = 0; segment < segments; segment++)
          for (let end = 0; end < 2; end++) {
            const vertex = (row * segments + segment) * 2 + end;
            const offset = (lane * verticesPerLane + vertex) * 3;
            seeds[offset] = (segment + end) / segments;
            seeds[offset + 1] = (row + 0.5) / contours;
            seeds[offset + 2] = lane;
          }
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);
    const attribute = gl.getAttribLocation(program, "seed");
    gl.enableVertexAttribArray(attribute);
    gl.vertexAttribPointer(attribute, 3, gl.FLOAT, false, 0, 0);
    const uniforms = Object.fromEntries(
      ["time", "aspect", "pixelRatio", "activity", "energy", "motion", "origins"].map((name) => [
        name,
        gl.getUniformLocation(
          program,
          ["energy", "motion", "origins"].includes(name) ? `${name}[0]` : name,
        ),
      ]),
    );
    const energy = new Float32Array(12),
      motion = new Float32Array(12),
      origins = new Float32Array(6);
    const audibleLevels = new Float32Array(3);
    const deckPulses = new Float32Array(3);
    const reducedDeckMotion = matchMedia("(prefers-reduced-motion: reduce)");
    const filteredBands = new Float32Array(9).fill(1);
    const bands = new Uint8Array(512);
    const samples = new Float32Array(1024);
    const liveAnchors = Array.from({ length: 3 }, () => ({
      track: null as number | null,
      raw: -1,
      at: 0,
    }));
    let spark:
      | {
          dispose(): void;
          setLook?(look: VisualLook): void;
          setCrowdMotion?(input: CrowdMotion): void;
          draw(
            time: number,
            rgba: Uint8Array,
            energy: Float32Array,
            motion: Float32Array,
            origins: Float32Array,
            audibleLevels?: Float32Array,
          ): void;
        }
      | undefined;
    let disposed = false;
    const visual = new URLSearchParams(location.search).get("visual");
    if (
      visual === "spark" ||
      visual === "webgpu" ||
      visual === "vgpu" ||
      visual === "halloween" ||
      visual === "race" ||
      visual === "temple-run" ||
      !visual
    ) {
      const initialize =
        visual === "race"
          ? import("./race-booth.js").then((module) => module.createRaceBooth(canvas))
          : visual === "temple-run"
            ? import("./temple-run-booth.js").then((module) => module.createTempleRunBooth(canvas))
            : visual === "halloween" || !visual
              ? import("./halloween-booth.js").then((module) => module.createHalloweenBooth(canvas))
              : visual === "vgpu"
                ? import("./vgpu-booth.js").then((module) => module.createVgpuBooth(canvas))
                : visual === "webgpu"
                  ? import("./webgpu-booth.js").then((module) => module.createWebGPUBooth(canvas))
                  : import("./spark-booth.js").then((module) => module.createSparkBooth(canvas));
      void initialize
        .then((engine) => {
          if (disposed) engine.dispose();
          else spark = engine;
        })
        .catch((error) => {
          if (!disposed) setError(`3D scene unavailable; using line visuals. ${String(error)}`);
        });
    }
    const deckElements = Array.from(
      document.querySelectorAll<HTMLElement>(".booth-grid > .cdj3000"),
    );
    const updateOrigins = () => {
      for (let i = 0; i < 3; i++) {
        const rect = deckElements[i]?.getBoundingClientRect();
        origins[i * 2] = rect
          ? ((rect.left + rect.width / 2) / innerWidth) * 2 - 1
          : (i - 1) * 0.55;
        origins[i * 2 + 1] = rect ? 1 - ((rect.top + rect.height / 2) / innerHeight) * 2 : 0;
      }
    };
    const layoutObserver = new ResizeObserver(updateOrigins);
    deckElements.forEach((element) => layoutObserver.observe(element));
    window.addEventListener("resize", updateOrigins);
    updateOrigins();
    let frame = 0;
    let last = performance.now();
    let clock = 0;
    let activity = 0;
    let lastPreviewPaint = 0;
    let previousControls: DashboardSnapshot["mixer"]["controls"] | undefined;
    const channels = (new URLSearchParams(location.search).get("deckChannels") ?? "1,2,3")
      .split(",")
      .map(Number);
    const smooth = (array: Float32Array, i: number, value: number, dt: number) => {
      array[i] = array[i]! + (value - array[i]!) * (1 - Math.exp(-dt * 7));
    };
    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      clock += dt;
      const ratio = Math.min(devicePixelRatio, 1.5);
      const w = Math.round(innerWidth * ratio),
        h = Math.round(innerHeight * ratio);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
      const state = current.current;
      const controls = state.snapshot.mixer.controls;
      if (previousControls)
        for (const [name, control] of Object.entries(controls)) {
          const prior = previousControls[name];
          if (prior && (prior.value !== control.value || prior.state !== control.state))
            activity = 1;
        }
      previousControls = controls;
      activity *= Math.exp(-dt * 2.5);
      let targets = state.decks.map((deck, i) =>
        visualLane(state.snapshot, deck, channels[i] || i + 1),
      );
      if (state.preview) {
        const previewState: DashboardSnapshot = {
          ...state.snapshot,
          decks: [],
          mixer: {
            ...state.snapshot.mixer,
            controls: { ...state.snapshot.mixer.controls },
            meters: {},
          },
        };
        targets = [0, 1, 2].map((i) => {
          const audio = audioRefs.current[i],
            analyser = analysers.current[i];
          const track = state.tracks.find((t) => t.id === state.trackIds[i]);
          const template = state.decks[i];
          const fader = state.faders[i] ?? 0;
          if (audio) audio.volume = 1;
          const gain = gains.current[i];
          if (gain && contextRef.current)
            gain.gain.setTargetAtTime(fader * 0.35, contextRef.current.currentTime, 0.025);
          const position = audio?.currentTime ?? 0;
          const duration =
            audio && Number.isFinite(audio.duration)
              ? audio.duration
              : (track?.durationSeconds ?? 0);
          const playing = !!audio && !audio.paused && !audio.ended;
          const deck: DeckState = {
            ...template!,
            player: i + 1,
            connected: true,
            model: "PREVIEW",
            ip: null,
            sourcePlayer: null,
            sourceSlot: null,
            trackId: track ? Number(track.id) : null,
            trackTitle: track?.title || track?.path?.split("/").pop() || "Select track",
            trackArtist: track?.artist ?? null,
            playing,
            active: playing,
            playState: playing ? "playing" : "paused",
            bpm: track?.bpm ?? 120,
            effectiveBpm: (track?.bpm ?? 120) * (audio?.playbackRate ?? 1),
            pitchPercent: ((audio?.playbackRate ?? 1) - 1) * 100,
            playheadMs: position * 1000,
            trackLengthSec: duration,
            trackProgressPercent: duration ? (position / duration) * 100 : 0,
            beatNumber: null,
            beatInBar: (Math.floor((position * (track?.bpm ?? 120)) / 60) % 4) + 1,
          };
          previewState.decks.push(deck);
          previewState.mixer.controls[`channel.${i + 1}.fader`] = {
            label: `Preview fader ${i + 1}`,
            value: Math.round(fader * 127),
            percent: fader * 100,
            state: null,
            raw: "preview",
            changedAtUs: now * 1000,
          };
          if (analyser) analyser.getByteFrequencyData(bands);
          else bands.fill(0);
          const average = (from: number, to: number) => {
            let sum = 0;
            for (let k = from; k < to; k++) sum += bands[k]!;
            return sum / (to - from) / 255;
          };
          const bass = playing ? average(1, 7) : 0,
            mid = playing ? average(7, 80) : 0,
            high = playing ? average(80, 220) : 0;
          const level = (bass + mid + high) / 3;
          if (analyser) analyser.getFloatTimeDomainData(samples);
          else samples.fill(0);
          let sumSquares = 0,
            peak = 0;
          for (const sample of samples) {
            sumSquares += sample * sample;
            peak = Math.max(peak, Math.abs(sample));
          }
          const rms = Math.sqrt(sumSquares / samples.length) * fader * 0.35;
          const db = playing && rms > 0 ? Math.max(-120, 20 * Math.log10(rms)) : -120;
          const peakDb =
            playing && peak * fader > 0
              ? Math.max(-120, 20 * Math.log10(peak * fader * 0.35))
              : -120;
          previewState.mixer.meters[`usb.${i * 2 + 1}_${i * 2 + 2}`] = {
            pair: i + 1,
            channels: [i * 2 + 1, i * 2 + 2],
            peakDbfs: peakDb,
            rmsDbfs: db,
            leftPeakDbfs: peakDb,
            rightPeakDbfs: peakDb,
            leftRmsDbfs: db,
            rightRmsDbfs: db,
            changedAtUs: now * 1000,
          };
          const lane = visualLane(previewState, deck, i + 1, level);
          lane.low = bass * lane.low * 2;
          lane.mid = mid * lane.mid * 2;
          lane.high = high * lane.high * 2;
          return lane;
        });
        if (now - lastPreviewPaint > 80) {
          state.onPreview(previewState);
          lastPreviewPaint = now;
        }
      }
      for (let lane = 0; lane < 3; lane++) {
        const waveform = state.waveforms[lane];
        const deck = state.decks[lane];
        let position = state.preview
          ? (audioRefs.current[lane]?.currentTime ?? 0)
          : deck?.playheadMs != null
            ? deck.playheadMs / 1000
            : (waveform?.beatGrid?.[Math.max(0, (deck?.beatNumber ?? 1) - 1)]?.timeSeconds ?? 0);
        if (!state.preview && deck) {
          const anchor = liveAnchors[lane]!;
          if (anchor.track !== deck.trackId || anchor.raw !== position || !deck.playing) {
            anchor.track = deck.trackId;
            anchor.raw = position;
            anchor.at = now;
          }
          if (deck.playing)
            position +=
              Math.min(1, (now - anchor.at) / 1000) * (1 + (deck.pitchPercent ?? 0) / 100);
        }
        const bpm = state.preview
          ? (state.tracks.find((t) => t.id === state.trackIds[lane])?.bpm ?? 120)
          : (deck?.bpm ?? 120);
        // The CDJ's own analyzed waveform supplies its energy. USB audio pairs
        // need not correspond to player numbers (the mixer can route them).
        if (!state.preview) {
          targets[lane] = waveformVisualLane(
            state.snapshot,
            deck,
            channels[lane] || lane + 1,
            waveform,
            position,
          );
        }
        motion[lane * 4 + 3] = waveformBeat(waveform, position, bpm);
        const historySeconds = (8 * 60) / (bpm || 120);
        const fallback = [192, 192, 192];
        const bands = waveformBands(state.snapshot, channels[lane] || lane + 1);
        for (let band = 0; band < 3; band++)
          smooth(filteredBands, lane * 3 + band, bands[band]!, dt);
        const shapedBands = [
          filteredBands[lane * 3]!,
          filteredBands[lane * 3 + 1]!,
          filteredBands[lane * 3 + 2]!,
        ] as const;
        for (let x = 0; x < 256; x++) {
          const signal = shapeWaveformSignal(
            waveformSignal(waveform, position - (x / 255) * historySeconds),
            shapedBands,
          );
          const offset = (lane * 256 + x) * 4;
          const color = signal.color ?? fallback;
          for (let c = 0; c < 3; c++)
            textureData[offset + c] = Math.round(Math.max(0, Math.min(255, color[c]!)));
          textureData[offset + 3] = Math.round(Math.max(0, Math.min(1, signal.amplitude)) * 255);
        }
      }
      for (let i = 0; i < 3; i++) {
        const lane: VisualLane = targets[i] ?? {
          level: 0,
          low: 0.5,
          mid: 0.5,
          high: 0.5,
          color: 0,
          fx: 0,
          cue: 0,
          bpm: 120,
          effect: 0,
        };
        [lane.level + lane.cue * 0.06, lane.low, lane.mid, lane.high].forEach((v, k) =>
          smooth(energy, i * 4 + k, v, dt),
        );
        smooth(audibleLevels, i, lane.level, dt);
        [lane.color, lane.fx, lane.effect].forEach((v, k) => smooth(motion, i * 4 + k, v, dt));
      }
      const activeDecks = [0, 1, 2].map((lane) =>
        state.preview
          ? !!audioRefs.current[lane] && !audioRefs.current[lane]!.paused
          : !!state.decks[lane]?.connected && !!state.decks[lane]?.playing,
      );
      for (let lane = 0; lane < 3; lane++) {
        const beat = motion[lane * 4 + 3] ?? 0;
        const targetPulse = activeDecks[lane] ? Math.exp(-(((beat % 1) + 1) % 1) * 6) : 0;
        deckPulses[lane] =
          (deckPulses[lane] ?? 0) +
          (targetPulse - (deckPulses[lane] ?? 0)) * (1 - Math.exp(-dt * 25));
        deckElements[lane]?.style.setProperty(
          "--deck-beat",
          String(reducedDeckMotion.matches ? 0 : deckPulses[lane]),
        );
      }
      if (waveformOverlayRef.current)
        drawBoothWaveformOverlay(waveformOverlayRef.current, textureData, activeDecks, deckPulses);
      if (spark) {
        try {
          spark.setLook?.(state.look);
          spark.setCrowdMotion?.(crowdMotion.current);
          spark.draw(clock, textureData, energy, motion, origins, audibleLevels);
        } catch (error) {
          spark.dispose();
          spark = undefined;
          setError(`3D scene stopped; using line visuals. ${String(error)}`);
        }
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 3, 0, gl.RGBA, gl.UNSIGNED_BYTE, textureData);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform1f(uniforms.time!, clock);
        gl.uniform1f(uniforms.activity!, activity);
        gl.uniform1f(uniforms.aspect!, w / h);
        gl.uniform1f(uniforms.pixelRatio!, ratio);
        gl.uniform4fv(uniforms.energy!, energy);
        gl.uniform4fv(uniforms.motion!, motion);
        gl.uniform2fv(uniforms.origins!, origins);
        gl.drawArrays(gl.LINES, 0, verticesPerLane * 3);
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      disposed = true;
      deckElements.forEach((element) => element.style.removeProperty("--deck-beat"));
      layoutObserver.disconnect();
      window.removeEventListener("resize", updateOrigins);
      spark?.dispose();
      cancelAnimationFrame(frame);
      gl.deleteTexture(waveformTexture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      shaders.forEach((s) => gl.deleteShader(s));
    };
  }, []);
  const begin = async (only?: number) => {
    try {
      if (!contextRef.current) {
        const context = new AudioContext();
        contextRef.current = context;
        audioRefs.current.forEach((audio, i) => {
          if (!audio) return;
          const analyser = context.createAnalyser();
          analyser.fftSize = 1024;
          analyser.smoothingTimeConstant = 0.8;
          context.createMediaElementSource(audio).connect(analyser);
          const gain = context.createGain();
          gain.gain.value = 0;
          analyser.connect(gain);
          gain.connect(context.destination);
          gains.current[i] = gain;
          analysers.current[i] = analyser;
        });
      }
      await contextRef.current.resume();
      setPreview(true);
      setError("");
      const results = await Promise.allSettled(
        audioRefs.current.map(async (audio, i) => {
          if (!audio || (only !== undefined && only !== i)) return;
          audio.volume = 1;
          if (gains.current[i]) gains.current[i]!.gain.value = (faders[i] ?? 0) * 0.35;
          await audio.play();
        }),
      );
      if (results.some((r) => r.status === "rejected"))
        setError("One or more tracks could not play. Choose another track for that deck.");
    } catch (e) {
      setError(String(e));
    }
  };
  const live = () => {
    audioRefs.current.forEach((a) => a?.pause());
    setPreview(false);
    onPreview(null);
  };
  return (
    <>
      <canvas ref={canvasRef} className="booth-visuals" aria-hidden="true" />
      <canvas ref={waveformOverlayRef} className="booth-waveform-overlay" aria-hidden="true" />
      {new URLSearchParams(location.search).get("visual") !== "temple-run" && (
        <VisualShowControls onLook={setLook} />
      )}
      <aside className="visual-preview">
        <details className="preview-controls">
          <summary>
            {preview ? "Library preview · Controls" : "Deck preview · Controls"}
            {cameraEnabled ? " · Camera enabled" : ""}
          </summary>
          <span>
            {preview
              ? "LIBRARY DECK PREVIEW · THREE INDEPENDENT TRACKS"
              : "LIVE · DECK WAVEFORM COLORS + BEATS"}
          </span>
          {[
            { label: "Halloween", visual: "halloween", composition: "" },
            { label: "Space race", visual: "race" },
            { label: "Temple run", visual: "temple-run", composition: "" },
            { label: "Folded surface", visual: "webgpu", composition: "" },
            { label: "Architecture", visual: "spark", composition: "architecture" },
            { label: "Ribbons", visual: "spark", composition: "" },
          ].map((scene) => {
            const url = new URL(location.href);
            if (scene.visual) url.searchParams.set("visual", scene.visual);
            else url.searchParams.delete("visual");
            if (scene.composition !== undefined) {
              if (scene.composition) url.searchParams.set("composition", scene.composition);
              else url.searchParams.delete("composition");
            }
            return (
              <a key={scene.label} href={url.toString()}>
                {scene.label}
              </a>
            );
          })}
          {new URLSearchParams(location.search).get("visual") === "race" && (
            <CrowdCameraControls
              onEnabledChange={setCameraEnabled}
              onMotion={(input) => {
                crowdMotion.current = input;
              }}
            />
          )}
          <div className="preview-decks">
            {[0, 1, 2].map((i) => (
              <div className={`preview-deck preview-deck-${i + 1}`} key={i}>
                <label>
                  DECK {i + 1}
                  <select
                    aria-label={`Deck ${i + 1} preview track`}
                    value={trackIds[i] ?? ""}
                    onChange={(e) =>
                      setTrackIds((ids) => ids.map((id, k) => (k === i ? e.target.value : id)))
                    }
                  >
                    {tracks.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title || t.path?.split("/").pop() || t.id}
                      </option>
                    ))}
                  </select>
                </label>
                <div>
                  <button disabled={!trackIds[i]} onClick={() => void begin(i)}>
                    Play
                  </button>
                  <button onClick={() => audioRefs.current[i]?.pause()}>Pause</button>
                  <input
                    aria-label={`Deck ${i + 1} channel fader`}
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={faders[i]}
                    onChange={(e) =>
                      setFaders((values) =>
                        values.map((v, k) => (k === i ? Number(e.target.value) : v)),
                      )
                    }
                  />
                </div>
                <audio
                  ref={(element) => {
                    audioRefs.current[i] = element;
                  }}
                  src={trackIds[i] ? `/api/audio/${encodeURIComponent(trackIds[i]!)}` : undefined}
                  preload="metadata"
                  onError={() => setError(`Deck ${i + 1}: choose another playable library track.`)}
                />
              </div>
            ))}
          </div>
          <button disabled={trackIds.length < 3} onClick={() => void begin()}>
            Play all three decks
          </button>
          <button onClick={live}>Return to live hardware</button>
        </details>
        {error ? <small role="status">{error}</small> : null}
      </aside>
    </>
  );
}
