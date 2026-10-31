import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { SCENES, SCENE_DESCRIPTIONS, sceneInfo, type SceneId } from "./scenes.js";

const GAMES = new Set<SceneId>([
  "corn-maze",
  "rainbow-road",
  "pac-man",
  "jungle-hero",
  "race",
  "temple-run",
]);
export const scenePreviewUrl = (id: SceneId) => `/scene-previews/${id}.jpg`;
type CapturePreview = (scene: SceneId) => Promise<Blob | null>;

/** One small capture of the existing stage; browsing never starts extra game engines. */
function CurrentPreview({
  scene,
  active,
  capture,
}: {
  scene: SceneId;
  active: boolean;
  capture?: CapturePreview;
}) {
  const [preview, setPreview] = useState<{ scene: SceneId; url: string }>();
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active || !capture || !element.current) return;
    let disposed = false,
      visible = false;
    let url: string | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
    });
    observer.observe(element.current);
    const update = async () => {
      try {
        if (visible && !document.hidden) {
          const image = await capture(scene);
          if (disposed) return;
          if (image) {
            const previous = url;
            url = URL.createObjectURL(image);
            setPreview({ scene, url });
            if (previous) URL.revokeObjectURL(previous);
          }
        }
      } catch {
        // A scene still loading or an unavailable canvas keeps its rendered thumbnail.
      } finally {
        if (!disposed) timer = setTimeout(() => void update(), 600);
      }
    };
    timer = setTimeout(() => void update(), 150);
    return () => {
      disposed = true;
      clearTimeout(timer);
      observer.disconnect();
      if (url) URL.revokeObjectURL(url);
      setPreview(undefined);
    };
  }, [scene, active, capture]);
  const live = active && preview?.scene === scene;
  return (
    <div className="scene-current-image" ref={element}>
      <img
        src={live ? preview.url : scenePreviewUrl(scene)}
        alt={`${sceneInfo(scene).label} preview`}
      />
      <span className="scene-preview-badge">{live ? "Live preview" : "Scene preview"}</span>
    </div>
  );
}

/** Reusable actual-render gallery for playback and the design editor. */
export function SceneGallery({
  selected,
  onSelect,
  selectedLabel = "On stage",
}: {
  selected?: SceneId;
  onSelect: (id: SceneId) => void;
  selectedLabel?: string;
}) {
  const [filter, setFilter] = useState<"all" | "games" | "visuals">("all");
  const shown = SCENES.filter(
    (scene) => filter === "all" || GAMES.has(scene.id) === (filter === "games"),
  );
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    const cards = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(".scene-preview-card"),
    ];
    const current = cards.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) return;
    const columns = cards.filter((card) => card.offsetTop === cards[0]?.offsetTop).length || 1;
    const moves: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: columns,
      ArrowUp: -columns,
    };
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? cards.length - 1
          : event.key in moves
            ? (current + moves[event.key]! + cards.length) % cards.length
            : null;
    if (next !== null) {
      event.preventDefault();
      event.stopPropagation();
      cards[next]?.focus();
    }
  };
  return (
    <div className="scene-gallery">
      <div className="scene-gallery-filters" role="group" aria-label="Filter scenes">
        {(["all", "games", "visuals"] as const).map((value) => (
          <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>
            {value === "all" ? "All scenes" : value === "games" ? "Games" : "Visuals"}
            <span>
              {value === "all"
                ? SCENES.length
                : value === "games"
                  ? GAMES.size
                  : SCENES.length - GAMES.size}
            </span>
          </button>
        ))}
      </div>
      <div
        className="scene-preview-grid"
        role="group"
        aria-label="Scene previews"
        onKeyDown={navigate}
      >
        {shown.map((scene) => (
          <button
            className="scene-preview-card"
            key={scene.id}
            aria-label={scene.label}
            aria-pressed={selected === scene.id}
            onClick={() => onSelect(scene.id)}
          >
            <span className="scene-card-image">
              <img src={scenePreviewUrl(scene.id)} alt="" loading="lazy" width={640} height={360} />
              {selected === scene.id ? (
                <span className="scene-card-selected">✓ {selectedLabel}</span>
              ) : null}
            </span>
            <span className="scene-card-title">
              {scene.label}
              <small>{GAMES.has(scene.id) ? "Game" : "Visual"}</small>
            </span>
            <span className="scene-card-description">{SCENE_DESCRIPTIONS[scene.id]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function SceneControls({
  scene,
  onSelect,
  previewActive,
  capture,
}: {
  scene: SceneId;
  onSelect: (scene: SceneId) => void;
  previewActive: boolean;
  capture?: CapturePreview;
}) {
  const [expanded, setExpanded] = useState(false);
  const galleryId = useId();
  const browse = useRef<HTMLButtonElement>(null);
  const step = (direction: number) => {
    const index = SCENES.findIndex((item) => item.id === scene);
    onSelect(SCENES[(index + direction + SCENES.length) % SCENES.length]!.id);
  };
  return (
    <section
      className="scene-controls"
      aria-label="Game and visual controls"
      onKeyDown={(event) => {
        if (event.key === "Escape" && expanded) {
          event.stopPropagation();
          setExpanded(false);
          browse.current?.focus();
        }
        // Native buttons keep their keyboard behavior instead of invoking show transport shortcuts.
        if (
          [
            "Tab",
            " ",
            "Enter",
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
            "Home",
            "End",
          ].includes(event.key)
        )
          event.stopPropagation();
      }}
    >
      <header className="scene-controls-heading">
        <div>
          <h2>Game & visual</h2>
          <p>Pick the world your music moves.</p>
        </div>
        <div className="scene-step-buttons">
          <button aria-label="Previous scene" onClick={() => step(-1)}>
            ←
          </button>
          <button aria-label="Next scene" onClick={() => step(1)}>
            →
          </button>
        </div>
      </header>
      <div className="scene-current">
        <CurrentPreview scene={scene} active={previewActive} capture={capture} />
        <div className="scene-current-copy">
          <span className="scene-on-stage">On stage · {GAMES.has(scene) ? "Game" : "Visual"}</span>
          <strong>{sceneInfo(scene).label}</strong>
          <p>{SCENE_DESCRIPTIONS[scene]}</p>
          <button
            ref={browse}
            className="scene-browse"
            aria-expanded={expanded}
            aria-controls={galleryId}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Close gallery" : `Browse ${SCENES.length} scenes`}
            <span aria-hidden="true">{expanded ? "−" : "+"}</span>
          </button>
        </div>
      </div>
      {expanded ? (
        <div id={galleryId}>
          <SceneGallery
            selected={scene}
            onSelect={(next) => {
              onSelect(next);
              setExpanded(false);
              browse.current?.focus();
            }}
          />
        </div>
      ) : null}
    </section>
  );
}
