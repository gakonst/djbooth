import { useEffect, useId, useRef, useState } from "react";
import {
  estimateCrowdMotion,
  IDLE_CROWD_MOTION,
  smoothCrowdMotion,
  type CrowdMotion,
} from "./crowd-motion.js";
import "./crowd-camera.css";

export function CrowdCameraControls({
  onMotion,
  onEnabledChange,
}: {
  onMotion: (motion: CrowdMotion) => void;
  onEnabledChange?: (enabled: boolean) => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [deviceId, setDeviceId] = useState("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [influence, setInfluence] = useState(0.7);
  const [status, setStatus] = useState("Camera off");
  const callback = useRef(onMotion);
  const enabledCallback = useRef(onEnabledChange);
  const strength = useRef(influence);
  const id = useId();
  callback.current = onMotion;
  enabledCallback.current = onEnabledChange;
  strength.current = influence;

  useEffect(() => {
    enabledCallback.current?.(enabled);
  }, [enabled]);

  useEffect(() => () => enabledCallback.current?.(false), []);

  useEffect(() => {
    callback.current({ ...IDLE_CROWD_MOTION });
    if (!enabled) return;
    let cancelled = false;
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let frameCallback: number | undefined;
    let removeDeviceListener: (() => void) | undefined;
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    const stopTracks = () => stream?.getTracks().forEach((track) => track.stop());
    const start = async () => {
      try {
        setStatus("Waiting for camera permission…");
        if (!navigator.mediaDevices?.getUserMedia)
          throw new Error("Camera requires a secure browser connection.");
        const acquired = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            width: { ideal: 160 },
            height: { ideal: 120 },
            frameRate: { ideal: 12, max: 15 },
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          },
        });
        if (cancelled) {
          acquired.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = acquired;
        const refreshDevices = async () => {
          try {
            const available = await navigator.mediaDevices.enumerateDevices();
            if (!cancelled) setDevices(available.filter((device) => device.kind === "videoinput"));
          } catch {
            /* Device labels are optional; the granted camera still works. */
          }
        };
        void refreshDevices();
        navigator.mediaDevices.addEventListener("devicechange", refreshDevices);
        removeDeviceListener = () =>
          navigator.mediaDevices.removeEventListener("devicechange", refreshDevices);
        video.srcObject = stream;
        const canvas = document.createElement("canvas");
        canvas.width = 80;
        canvas.height = 60;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("Camera frame processing is unavailable.");
        let previous: Uint8ClampedArray | undefined;
        let target = { ...IDLE_CROWD_MOTION };
        let motion = { ...IDLE_CROWD_MOTION };
        let lastTime = performance.now();
        let lastFrame = lastTime;
        let videoTime = -1;
        let decodedFrames = 0;
        const tracksDecodedFrames = typeof video.requestVideoFrameCallback === "function";
        const onFrame = () => {
          if (cancelled) return;
          decodedFrames++;
          frameCallback = video.requestVideoFrameCallback(onFrame);
        };
        if (tracksDecodedFrames) frameCallback = video.requestVideoFrameCallback(onFrame);
        let ended = false;
        for (const track of stream.getVideoTracks()) {
          track.addEventListener(
            "ended",
            () => {
              if (cancelled) return;
              ended = true;
              previous = undefined;
              target = { ...IDLE_CROWD_MOTION };
              stopTracks();
              setStatus("Camera ended — disable and enable to reconnect");
            },
            { once: true },
          );
        }
        setStatus("Starting camera…");
        timer = setInterval(() => {
          if (cancelled) return;
          const now = performance.now();
          const frameTime = tracksDecodedFrames ? decodedFrames : video.currentTime;
          if (now - lastFrame > 400) previous = undefined;
          if (!ended && video.readyState >= 2 && frameTime !== videoTime) {
            try {
              context.drawImage(video, 0, 0, 80, 60);
              const frame = context.getImageData(0, 0, 80, 60).data;
              target = previous
                ? estimateCrowdMotion(previous, frame, 80, 60)
                : { active: true, energy: 0, steering: 0 };
              previous = frame;
              videoTime = frameTime;
              lastFrame = now;
              setStatus("Camera active · local motion only");
            } catch {
              ended = true;
              stopTracks();
              setStatus("Camera frame processing failed — disable and retry");
            }
          }
          if (ended || now - lastFrame > 400) {
            target = { ...IDLE_CROWD_MOTION };
            previous = undefined;
            if (!ended) setStatus("Camera stalled · motion fading to center");
          }
          motion = smoothCrowdMotion(motion, target, (now - lastTime) / 1000, strength.current);
          lastTime = now;
          callback.current(motion);
        }, 1000 / 12);
        await video.play();
      } catch (error) {
        if (cancelled) return;
        if (timer) clearInterval(timer);
        stopTracks();
        callback.current({ ...IDLE_CROWD_MOTION });
        const denied = error instanceof DOMException && error.name === "NotAllowedError";
        setStatus(
          denied
            ? "Camera permission denied — allow camera access, then enable again"
            : error instanceof Error
              ? `Camera unavailable: ${error.message}`
              : "Camera unavailable",
        );
        setEnabled(false);
      }
    };
    void start();
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      if (frameCallback !== undefined) video.cancelVideoFrameCallback(frameCallback);
      removeDeviceListener?.();
      stopTracks();
      video.pause();
      video.srcObject = null;
      callback.current({ ...IDLE_CROWD_MOTION });
    };
  }, [enabled, deviceId]);

  return (
    <section className="crowd-camera" aria-label="Crowd camera steering">
      <div className="crowd-camera__heading">
        <strong>Crowd steering</strong>
        <button
          type="button"
          aria-pressed={enabled}
          onClick={() => {
            setEnabled(!enabled);
            if (enabled) setStatus("Camera off");
          }}
        >
          {enabled ? "Disable camera" : "Enable camera"}
        </button>
      </div>
      <p>
        Steer toward movement in the mirrored camera view. Moving on your left steers left;
        stillness recenters. Camera frames stay on this device. No face tracking or recording.
      </p>
      {devices.length > 0 && (
        <label htmlFor={`${id}-source`}>
          Camera
          <select
            id={`${id}-source`}
            value={deviceId}
            onChange={(event) => setDeviceId(event.target.value)}
          >
            <option value="">Default camera</option>
            {devices.map((device, index) => (
              <option key={device.deviceId || index} value={device.deviceId}>
                {device.label || `Camera ${index + 1}`}
              </option>
            ))}
          </select>
        </label>
      )}
      <label htmlFor={`${id}-influence`}>
        Influence <output>{Math.round(influence * 100)}%</output>
        <input
          id={`${id}-influence`}
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={influence}
          onChange={(event) => setInfluence(Number(event.target.value))}
        />
      </label>
      <p className="crowd-camera__status" role="status">
        {status}
      </p>
    </section>
  );
}
