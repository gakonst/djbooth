import { useEffect, useRef, type RefObject } from "react";

export type VideoPosition = "top-left" | "top-right" | "center" | "bottom-left" | "bottom-right";
export type VideoLayout = {
  width: number;
  opacity: number;
  position: VideoPosition;
  bouncing: boolean;
};
export const DEFAULT_VIDEO_LAYOUT: VideoLayout = {
  width: 30,
  opacity: 100,
  position: "top-left",
  bouncing: false,
};
const PRESETS: { name: string; description: string; layout: VideoLayout }[] = [
  { name: "Corner", description: "Keep the game in view", layout: DEFAULT_VIDEO_LAYOUT },
  {
    name: "Spotlight",
    description: "Give the video room",
    layout: { width: 60, opacity: 100, position: "center", bouncing: false },
  },
  {
    name: "Float",
    description: "Move around the stage",
    layout: { width: 30, opacity: 90, position: "top-left", bouncing: true },
  },
  {
    name: "Full screen",
    description: "Let the video take over",
    layout: { width: 100, opacity: 100, position: "center", bouncing: false },
  },
];
const POSITIONS: { value: VideoPosition; label: string }[] = [
  { value: "top-left", label: "Top left" },
  { value: "top-right", label: "Top right" },
  { value: "center", label: "Center" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "bottom-right", label: "Bottom right" },
];

/** Mirrors the existing video decoder; configuring a layout never starts a second player. */
function LayoutPreview({
  video,
  layout,
  visible,
}: {
  video: RefObject<HTMLVideoElement | null>;
  layout: VideoLayout;
  visible: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const draw = () => {
      const target = canvas.current;
      if (!target?.offsetParent) return;
      const context = target.getContext("2d");
      if (!context) return;
      context.clearRect(0, 0, target.width, target.height);
      const source = video.current;
      if (source && source.readyState >= 2 && source.videoWidth > 0 && visible) {
        const scale = Math.min(
          target.width / source.videoWidth,
          target.height / source.videoHeight,
        );
        const w = source.videoWidth * scale,
          h = source.videoHeight * scale;
        context.drawImage(source, (target.width - w) / 2, (target.height - h) / 2, w, h);
      }
    };
    draw();
    const timer = setInterval(draw, 125);
    return () => clearInterval(timer);
  }, [video, visible]);
  return (
    <div
      className="video-layout-preview"
      aria-label={`Layout preview: ${layout.bouncing ? "floating" : layout.position.replaceAll("-", " ")}, ${layout.width}% wide`}
    >
      <span className="video-preview-stage">YOUR GAME / VISUAL</span>
      <div
        className={`video-preview-tile ${layout.position} ${layout.bouncing ? "floating" : ""} ${visible ? "" : "off"}`}
        style={{ width: `${layout.width}%`, opacity: visible ? layout.opacity / 100 : 0.3 }}
      >
        <span>{visible ? "VIDEO" : "HIDDEN"}</span>
        <canvas ref={canvas} width={480} height={270} aria-hidden="true" />
      </div>
    </div>
  );
}

export function VideoControls({
  visible,
  onVisible,
  layout,
  onLayout,
  video,
  title,
  detail,
  state,
  customTitle,
  customSelected,
  onAutomatic,
  onCustom,
  onUpload,
  canUpload,
  error,
  onRetry,
}: {
  visible: boolean;
  onVisible: (visible: boolean) => void;
  layout: VideoLayout;
  onLayout: (layout: VideoLayout) => void;
  video: RefObject<HTMLVideoElement | null>;
  title: string;
  detail: string;
  state: string;
  customTitle?: string;
  customSelected: boolean;
  onAutomatic: () => void;
  onCustom: () => void;
  onUpload: (file: File) => void;
  canUpload: boolean;
  error: string;
  onRetry?: () => void;
}) {
  const upload = useRef<HTMLInputElement>(null);
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  return (
    <section className="video-controls" aria-label="Music video controls">
      <header className="video-control-heading">
        <div>
          <h2>Music video</h2>
          <p>Follows the track. Fits your show.</p>
        </div>
        <button
          className="video-switch"
          role="switch"
          aria-label="Show music video"
          aria-checked={visible}
          onClick={() => onVisible(!visible)}
        >
          <span aria-hidden="true" />
          {visible ? "On" : "Off"}
        </button>
      </header>
      <div className="video-config-overview">
        <LayoutPreview video={video} layout={layout} visible={visible} />
        <div className="video-now-playing">
          <span className={`video-sync-pill ${state === "Synced" ? "synced" : ""}`} role="status">
            {visible ? state : "Video hidden"}
          </span>
          <strong title={title}>{title}</strong>
          <p>{detail}</p>
          <div className="video-source-actions">
            <button aria-pressed={!customSelected} onClick={onAutomatic}>
              Auto-match
            </button>
            {customTitle ? (
              <button aria-pressed={customSelected} title={customTitle} onClick={onCustom}>
                My clip
              </button>
            ) : null}
            <button
              disabled={!canUpload}
              title={
                canUpload
                  ? "Attach a video to the playing track"
                  : "Play a track to attach your video"
              }
              onClick={() => upload.current?.click()}
            >
              {customTitle ? "Replace clip…" : "Use my clip…"}
            </button>
            <input
              ref={upload}
              className="video-file-input"
              aria-label="Choose a video for the playing track"
              type="file"
              accept="video/*"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onUpload(file);
                event.target.value = "";
              }}
            />
          </div>
          {!canUpload ? (
            <p className="video-upload-hint">Play a track to attach your own clip.</p>
          ) : null}
        </div>
      </div>
      <div className="video-layout-presets" role="group" aria-label="Video layout">
        {PRESETS.map((preset) => {
          const selected = Object.keys(preset.layout).every(
            (key) => layout[key as keyof VideoLayout] === preset.layout[key as keyof VideoLayout],
          );
          return (
            <button
              key={preset.name}
              aria-pressed={selected}
              disabled={preset.layout.bouncing && reducedMotion}
              title={
                preset.layout.bouncing && reducedMotion
                  ? "Your device has reduced motion enabled"
                  : preset.description
              }
              onClick={() => onLayout({ ...preset.layout })}
            >
              <span
                className={`video-preset-icon ${preset.name.toLowerCase().replaceAll(" ", "-")}`}
                aria-hidden="true"
              >
                <i />
              </span>
              <strong>{preset.name}</strong>
              <small>{preset.description}</small>
            </button>
          );
        })}
      </div>
      <details className="video-fine-tune">
        <summary>
          Fine-tune{" "}
          <span>
            {layout.width}% size · {layout.opacity}% opacity ·{" "}
            {layout.bouncing ? "floating" : "fixed"}
          </span>
        </summary>
        <div className="video-tuning-grid">
          <label>
            Size <output>{layout.width}%</output>
            <input
              aria-label="Video size"
              type="range"
              min="20"
              max="100"
              value={layout.width}
              onChange={(event) => onLayout({ ...layout, width: Number(event.target.value) })}
            />
          </label>
          <label>
            Opacity <output>{layout.opacity}%</output>
            <input
              aria-label="Video opacity"
              type="range"
              min="20"
              max="100"
              value={layout.opacity}
              onChange={(event) => onLayout({ ...layout, opacity: Number(event.target.value) })}
            />
          </label>
          <fieldset className="video-placement">
            <legend>Position</legend>
            <div>
              {POSITIONS.map((position) => (
                <button
                  key={position.value}
                  aria-label={`Place video ${position.label.toLowerCase()}`}
                  title={position.label}
                  aria-pressed={layout.position === position.value && !layout.bouncing}
                  className={position.value}
                  onClick={() => onLayout({ ...layout, position: position.value, bouncing: false })}
                >
                  <i aria-hidden="true" />
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="video-motion">
            <legend>Motion</legend>
            <div>
              <button
                aria-pressed={!layout.bouncing}
                onClick={() => onLayout({ ...layout, bouncing: false })}
              >
                Stay put
              </button>
              <button
                aria-pressed={layout.bouncing}
                disabled={reducedMotion}
                onClick={() => onLayout({ ...layout, bouncing: true })}
              >
                Float
              </button>
            </div>
            <p>
              {reducedMotion
                ? "Reduced motion is enabled on your device."
                : "Choose a position to keep the video there."}
            </p>
          </fieldset>
        </div>
        <button className="video-reset" onClick={() => onLayout({ ...DEFAULT_VIDEO_LAYOUT })}>
          Reset layout
        </button>
      </details>
      {error ? (
        <div className="video-config-error" role="status">
          <p>{error}</p>
          {onRetry ? <button onClick={onRetry}>Resume video</button> : null}
        </div>
      ) : null}
    </section>
  );
}
