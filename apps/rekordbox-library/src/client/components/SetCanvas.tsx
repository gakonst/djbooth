import { Check, Minus, Move, Music2, Plus, Trash2, X } from "lucide-react";
import {
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import type { TrackSummary } from "../../shared/types.js";
import { artworkHue, titleInitials } from "../format.js";

const NODE_WIDTH = 204;
const NODE_HEIGHT = 92;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;
const GRID_SIZE = 16;

export type CanvasPoint = { x: number; y: number };

export type SetCanvasNode = {
  /** Canvas identity. Separate from the content ID so one track can appear more than once. */
  id: string;
  track: TrackSummary;
  position: CanvasPoint;
  /** Playlist nodes participate in ordering even before they have a connection. */
  kind?: "playlist" | "candidate";
  artworkUrl?: string | null;
  playlistIndex?: number;
};

export type SetCanvasConnection = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
};

export type SetCanvasNodePositionChange = {
  nodeId: string;
  position: CanvasPoint;
};

export type SetCanvasConnectIntent = {
  fromNodeId: string;
  toNodeId: string;
  /** Existing incoming/outgoing links that must be replaced to preserve one ordered chain. */
  replaceConnectionIds: string[];
};

export type SetCanvasContext = {
  client: CanvasPoint;
  canvas: CanvasPoint;
};

export type SetCanvasProps = {
  nodes: SetCanvasNode[];
  connections: SetCanvasConnection[];
  selectedNodeId?: string | null;
  canWrite?: boolean;
  className?: string;
  ariaLabel?: string;
  onSelectNode?(nodeId: string | null): void;
  onNodesChange?(changes: SetCanvasNodePositionChange[], options: { commit: boolean }): void;
  onConnect?(intent: SetCanvasConnectIntent): void;
  onDisconnect?(connectionId: string): void;
  onRemoveNode?(nodeId: string): void;
  onDropTrackIds?(trackIds: string[], position: CanvasPoint): void;
  onNodeContextMenu?(nodeId: string, context: SetCanvasContext): void;
  onCanvasContextMenu?(context: SetCanvasContext): void;
};

/** Ordered optimistic-concurrency snapshot for protected playlist replacement. */
export function playlistMembershipSnapshot(tracks: ReadonlyArray<TrackSummary>): string[] {
  return tracks.flatMap((track) =>
    track.playlistMembershipId ? [track.playlistMembershipId] : [],
  );
}

/** Reconcile the browser-local graph after history restores an authoritative playlist order. */
export function alignCanvasStateToPlaylist(
  tracks: ReadonlyArray<TrackSummary>,
  current: { nodes: SetCanvasNode[]; connections: SetCanvasConnection[] },
): { nodes: SetCanvasNode[]; connections: SetCanvasConnection[] } {
  const remaining = [...current.nodes];
  const usedIds = new Set(current.nodes.map((node) => node.id));
  const playlistNodes = tracks.map((track, index): SetCanvasNode => {
    const existingIndex = remaining.findIndex((node) => node.track.id === track.id);
    const existing = existingIndex >= 0 ? remaining.splice(existingIndex, 1)[0] : undefined;
    const id = existing?.id ?? unusedHistoryNodeId(track.id, index, usedIds);
    usedIds.add(id);
    return {
      id,
      track,
      position: existing?.position ?? { x: 56 + index * 244, y: 72 + (index % 2) * 124 },
      kind: "playlist",
      playlistIndex: index,
      artworkUrl: existing?.artworkUrl ?? `/api/artwork/${encodeURIComponent(track.id)}`,
    };
  });
  const candidates = remaining.map((node): SetCanvasNode => {
    const { playlistIndex: _playlistIndex, ...candidate } = node;
    return { ...candidate, kind: "candidate" };
  });
  return {
    nodes: [...playlistNodes, ...candidates],
    connections: playlistNodes.slice(0, -1).map((node, index) => ({
      id: `history:${node.id}:${playlistNodes[index + 1]!.id}`,
      fromNodeId: node.id,
      toNodeId: playlistNodes[index + 1]!.id,
    })),
  };
}

type Viewport = CanvasPoint & { zoom: number };

type NodeDrag = {
  nodeId: string;
  pointerId: number;
  clientStart: CanvasPoint;
  positionStart: CanvasPoint;
  position: CanvasPoint;
};

type PanDrag = {
  pointerId: number;
  clientStart: CanvasPoint;
  viewportStart: Viewport;
};

type ConnectionDrag = {
  fromNodeId: string;
  pointerId: number;
  point: CanvasPoint;
};

/**
 * Return the playlist order represented by directed links.
 *
 * Disconnected playlist nodes retain their `playlistIndex`; loose candidates only join the
 * result once connected. Malformed branches/cycles are still returned deterministically so
 * callers never lose a node while repairing a draft.
 */
export function deriveConnectedOrder(
  nodes: SetCanvasNode[],
  connections: SetCanvasConnection[],
): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, string>();
  const incoming = new Set<string>();
  const participating = new Set(
    nodes
      .filter((node) => node.kind === "playlist" || node.playlistIndex !== undefined)
      .map((node) => node.id),
  );

  for (const connection of connections) {
    if (
      !byId.has(connection.fromNodeId) ||
      !byId.has(connection.toNodeId) ||
      connection.fromNodeId === connection.toNodeId
    ) {
      continue;
    }
    if (!outgoing.has(connection.fromNodeId)) {
      outgoing.set(connection.fromNodeId, connection.toNodeId);
      incoming.add(connection.toNodeId);
    }
    participating.add(connection.fromNodeId);
    participating.add(connection.toNodeId);
  }

  const compareNodes = (leftId: string, rightId: string) => {
    const left = byId.get(leftId)!;
    const right = byId.get(rightId)!;
    return (
      (left.playlistIndex ?? Number.MAX_SAFE_INTEGER) -
        (right.playlistIndex ?? Number.MAX_SAFE_INTEGER) ||
      left.position.x - right.position.x ||
      left.position.y - right.position.y ||
      left.id.localeCompare(right.id)
    );
  };
  const roots = [...participating].filter((nodeId) => !incoming.has(nodeId)).sort(compareNodes);
  const remaining = [...participating].sort(compareNodes);
  const order: string[] = [];
  const visited = new Set<string>();

  const visit = (startId: string) => {
    let nodeId: string | undefined = startId;
    while (nodeId && !visited.has(nodeId)) {
      visited.add(nodeId);
      order.push(nodeId);
      nodeId = outgoing.get(nodeId);
    }
  };
  for (const root of roots) visit(root);
  for (const nodeId of remaining) visit(nodeId);
  return order;
}

export function SetCanvas({
  nodes,
  connections,
  selectedNodeId,
  canWrite = false,
  className,
  ariaLabel = "Visual set builder",
  onSelectNode,
  onNodesChange,
  onConnect,
  onDisconnect,
  onRemoveNode,
  onDropTrackIds,
  onNodeContextMenu,
  onCanvasContextMenu,
}: SetCanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const arrowMarkerId = useId().replaceAll(":", "");
  const [viewport, setViewport] = useState<Viewport>({ x: 72, y: 72, zoom: 1 });
  const [nodeDrag, setNodeDrag] = useState<NodeDrag>();
  const [panDrag, setPanDrag] = useState<PanDrag>();
  const [connectionDrag, setConnectionDrag] = useState<ConnectionDrag>();
  const [connectingFrom, setConnectingFrom] = useState<string>();
  const [announcement, setAnnouncement] = useState("");

  const positions = useMemo(() => {
    const result = new Map(nodes.map((node) => [node.id, node.position]));
    if (nodeDrag) result.set(nodeDrag.nodeId, nodeDrag.position);
    return result;
  }, [nodeDrag, nodes]);
  const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const orderedNodeIds = useMemo(
    () => deriveConnectedOrder(nodes, connections),
    [connections, nodes],
  );
  const orderByNodeId = useMemo(
    () => new Map(orderedNodeIds.map((nodeId, index) => [nodeId, index + 1])),
    [orderedNodeIds],
  );

  const clientToCanvas = useCallback(
    (clientX: number, clientY: number): CanvasPoint => {
      const rect = viewportRef.current?.getBoundingClientRect();
      return {
        x: (clientX - (rect?.left ?? 0) - viewport.x) / viewport.zoom,
        y: (clientY - (rect?.top ?? 0) - viewport.y) / viewport.zoom,
      };
    },
    [viewport],
  );

  const setZoom = useCallback((nextZoom: number, anchor?: CanvasPoint) => {
    setViewport((current) => {
      const zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
      const rect = viewportRef.current?.getBoundingClientRect();
      const localAnchor = anchor ?? {
        x: (rect?.width ?? 0) / 2,
        y: (rect?.height ?? 0) / 2,
      };
      const worldX = (localAnchor.x - current.x) / current.zoom;
      const worldY = (localAnchor.y - current.y) / current.zoom;
      return {
        x: localAnchor.x - worldX * zoom,
        y: localAnchor.y - worldY * zoom,
        zoom,
      };
    });
  }, []);

  const fitView = useCallback(() => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect || nodes.length === 0) {
      setViewport({ x: 72, y: 72, zoom: 1 });
      return;
    }
    const xs = nodes.map((node) => positions.get(node.id)?.x ?? node.position.x);
    const ys = nodes.map((node) => positions.get(node.id)?.y ?? node.position.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs) + NODE_WIDTH;
    const maxY = Math.max(...ys) + NODE_HEIGHT;
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    const padding = 96;
    const zoom = clamp(
      Math.min((rect.width - padding * 2) / width, (rect.height - padding * 2) / height),
      MIN_ZOOM,
      1.25,
    );
    setViewport({
      x: (rect.width - width * zoom) / 2 - minX * zoom,
      y: (rect.height - height * zoom) / 2 - minY * zoom,
      zoom,
    });
  }, [nodes, positions]);

  const requestConnection = useCallback(
    (fromNodeId: string, toNodeId: string) => {
      setConnectingFrom(undefined);
      setConnectionDrag(undefined);
      if (!canWrite || fromNodeId === toNodeId) {
        setAnnouncement(
          fromNodeId === toNodeId
            ? "A track cannot connect to itself."
            : "Set editing is disabled.",
        );
        return;
      }
      const replaced = connections.filter(
        (connection) =>
          (connection.fromNodeId === fromNodeId && connection.toNodeId !== toNodeId) ||
          (connection.toNodeId === toNodeId && connection.fromNodeId !== fromNodeId),
      );
      const duplicate = connections.some(
        (connection) => connection.fromNodeId === fromNodeId && connection.toNodeId === toNodeId,
      );
      if (duplicate) {
        setAnnouncement("Those tracks are already connected.");
        return;
      }
      const ignoredIds = new Set(replaced.map((connection) => connection.id));
      if (wouldCreateCycle(fromNodeId, toNodeId, connections, ignoredIds)) {
        setAnnouncement("That connection would create a loop. Disconnect another track first.");
        return;
      }
      onConnect?.({
        fromNodeId,
        toNodeId,
        replaceConnectionIds: [...ignoredIds],
      });
      setAnnouncement(
        `Connected ${nodesById.get(fromNodeId)?.track.title ?? "track"} to ${
          nodesById.get(toNodeId)?.track.title ?? "track"
        }.`,
      );
    },
    [canWrite, connections, nodesById, onConnect],
  );

  const handleViewportPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    if ((event.target as HTMLElement).closest("[data-canvas-interactive]")) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setPanDrag({
      pointerId: event.pointerId,
      clientStart: { x: event.clientX, y: event.clientY },
      viewportStart: viewport,
    });
    onSelectNode?.(null);
  };

  const handleViewportPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!panDrag || panDrag.pointerId !== event.pointerId) return;
    setViewport({
      ...panDrag.viewportStart,
      x: panDrag.viewportStart.x + event.clientX - panDrag.clientStart.x,
      y: panDrag.viewportStart.y + event.clientY - panDrag.clientStart.y,
    });
  };

  const handleViewportPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (panDrag?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setPanDrag(undefined);
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    setZoom(viewport.zoom * Math.exp(-event.deltaY * 0.0015), {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  };

  const handleNodePointerDown = (event: ReactPointerEvent<HTMLElement>, node: SetCanvasNode) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelectNode?.(node.id);
    setNodeDrag({
      nodeId: node.id,
      pointerId: event.pointerId,
      clientStart: { x: event.clientX, y: event.clientY },
      positionStart: positions.get(node.id) ?? node.position,
      position: positions.get(node.id) ?? node.position,
    });
  };

  const handleNodePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!nodeDrag || nodeDrag.pointerId !== event.pointerId) return;
    const unsnapped = {
      x: nodeDrag.positionStart.x + (event.clientX - nodeDrag.clientStart.x) / viewport.zoom,
      y: nodeDrag.positionStart.y + (event.clientY - nodeDrag.clientStart.y) / viewport.zoom,
    };
    const position = event.altKey
      ? unsnapped
      : {
          x: Math.round(unsnapped.x / GRID_SIZE) * GRID_SIZE,
          y: Math.round(unsnapped.y / GRID_SIZE) * GRID_SIZE,
        };
    setNodeDrag((current) => (current ? { ...current, position } : current));
    onNodesChange?.([{ nodeId: nodeDrag.nodeId, position }], { commit: false });
  };

  const handleNodePointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (!nodeDrag || nodeDrag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onNodesChange?.([{ nodeId: nodeDrag.nodeId, position: nodeDrag.position }], { commit: true });
    setNodeDrag(undefined);
  };

  const handleNodeKeyDown = (event: ReactKeyboardEvent<HTMLElement>, node: SetCanvasNode) => {
    if ((event.target as HTMLElement).closest("button")) return;
    const distance = event.shiftKey ? GRID_SIZE * 4 : GRID_SIZE;
    const delta: CanvasPoint | undefined =
      event.key === "ArrowLeft"
        ? { x: -distance, y: 0 }
        : event.key === "ArrowRight"
          ? { x: distance, y: 0 }
          : event.key === "ArrowUp"
            ? { x: 0, y: -distance }
            : event.key === "ArrowDown"
              ? { x: 0, y: distance }
              : undefined;
    if (delta) {
      event.preventDefault();
      const current = positions.get(node.id) ?? node.position;
      onNodesChange?.(
        [{ nodeId: node.id, position: { x: current.x + delta.x, y: current.y + delta.y } }],
        { commit: true },
      );
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && canWrite) {
      event.preventDefault();
      onRemoveNode?.(node.id);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelectNode?.(node.id);
    } else if (event.key === "Escape") {
      setConnectingFrom(undefined);
      onSelectNode?.(null);
    }
  };

  const beginConnectionDrag = (event: ReactPointerEvent<HTMLButtonElement>, fromNodeId: string) => {
    if (!canWrite || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setConnectingFrom(fromNodeId);
    setConnectionDrag({
      fromNodeId,
      pointerId: event.pointerId,
      point: clientToCanvas(event.clientX, event.clientY),
    });
  };

  const moveConnectionDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!connectionDrag || connectionDrag.pointerId !== event.pointerId) return;
    setConnectionDrag({
      ...connectionDrag,
      point: clientToCanvas(event.clientX, event.clientY),
    });
  };

  const finishConnectionDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!connectionDrag || connectionDrag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-canvas-input]")?.dataset.canvasInput;
    const source = connectionDrag.fromNodeId;
    setConnectionDrag(undefined);
    if (target) requestConnection(source, target);
  };

  const handleCanvasKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("[data-canvas-interactive]")) return;
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      setZoom(viewport.zoom * 1.2);
    } else if (event.key === "-") {
      event.preventDefault();
      setZoom(viewport.zoom / 1.2);
    } else if (event.key === "0") {
      event.preventDefault();
      fitView();
    } else if (event.key === "Escape") {
      setConnectingFrom(undefined);
      onSelectNode?.(null);
    }
  };

  const handleDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (!canWrite) return;
    const trackIds = readDroppedTrackIds(event.dataTransfer);
    if (trackIds.length === 0) return;
    onDropTrackIds?.(trackIds, clientToCanvas(event.clientX, event.clientY));
    setAnnouncement(
      `${String(trackIds.length)} track${trackIds.length === 1 ? "" : "s"} added to the canvas.`,
    );
  };

  const worldStyle = {
    transform: `translate(${String(viewport.x)}px, ${String(viewport.y)}px) scale(${String(
      viewport.zoom,
    )})`,
    "--canvas-zoom": String(viewport.zoom),
  } as CSSProperties;

  return (
    <section className={`set-canvas-shell${className ? ` ${className}` : ""}`}>
      <div className="set-canvas-toolbar" aria-label="Canvas controls">
        <span className="set-canvas-toolbar-title">
          <Move size={14} aria-hidden="true" /> Set canvas
        </span>
        <span className="set-canvas-toolbar-actions">
          <button
            className="small-icon-button"
            type="button"
            onClick={() => setZoom(viewport.zoom / 1.2)}
            aria-label="Zoom out"
            title="Zoom out (−)"
          >
            <Minus size={14} />
          </button>
          <output className="canvas-zoom-value" aria-label="Canvas zoom">
            {String(Math.round(viewport.zoom * 100))}%
          </output>
          <button
            className="small-icon-button"
            type="button"
            onClick={() => setZoom(viewport.zoom * 1.2)}
            aria-label="Zoom in"
            title="Zoom in (+)"
          >
            <Plus size={14} />
          </button>
          <button
            className="secondary-button compact-button canvas-fit-button"
            type="button"
            onClick={fitView}
            title="Fit all tracks (0)"
          >
            Fit
          </button>
        </span>
      </div>

      <div
        ref={viewportRef}
        className={`set-canvas-viewport${panDrag ? " is-panning" : ""}`}
        role="application"
        aria-label={ariaLabel}
        tabIndex={0}
        onPointerDown={handleViewportPointerDown}
        onPointerMove={handleViewportPointerMove}
        onPointerUp={handleViewportPointerUp}
        onPointerCancel={handleViewportPointerUp}
        onWheel={handleWheel}
        onKeyDown={handleCanvasKeyDown}
        onDragOver={(event) => {
          if (canWrite) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={handleDrop}
        onContextMenu={(event) => {
          if ((event.target as HTMLElement).closest("[data-canvas-interactive]")) return;
          event.preventDefault();
          onCanvasContextMenu?.({
            client: { x: event.clientX, y: event.clientY },
            canvas: clientToCanvas(event.clientX, event.clientY),
          });
        }}
      >
        <div className="set-canvas-grid" aria-hidden="true" />
        <div className="set-canvas-world" style={worldStyle}>
          <svg className="canvas-connections" aria-label="Track connections">
            {connections.map((connection) => {
              const from = positions.get(connection.fromNodeId);
              const to = positions.get(connection.toNodeId);
              if (!from || !to) return null;
              const start = { x: from.x + NODE_WIDTH, y: from.y + NODE_HEIGHT / 2 };
              const end = { x: to.x, y: to.y + NODE_HEIGHT / 2 };
              const path = connectionPath(start, end);
              const fromTitle = nodesById.get(connection.fromNodeId)?.track.title ?? "track";
              const toTitle = nodesById.get(connection.toNodeId)?.track.title ?? "track";
              return (
                <g
                  className="canvas-connection"
                  key={connection.id}
                  data-canvas-interactive
                  role="button"
                  tabIndex={canWrite ? 0 : -1}
                  aria-label={`Disconnect ${fromTitle} from ${toTitle}`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onDoubleClick={() => canWrite && onDisconnect?.(connection.id)}
                  onKeyDown={(event) => {
                    if (canWrite && (event.key === "Delete" || event.key === "Backspace")) {
                      event.preventDefault();
                      onDisconnect?.(connection.id);
                    }
                  }}
                >
                  <path className="canvas-connection-hit" d={path} />
                  <path
                    className="canvas-connection-line"
                    d={path}
                    markerEnd={`url(#${arrowMarkerId})`}
                  />
                  <title>{`${fromTitle} → ${toTitle}. Double-click or press Delete to disconnect.`}</title>
                </g>
              );
            })}
            {connectionDrag ? (
              <path
                className="canvas-connection-line is-preview"
                d={connectionPath(
                  {
                    x: (positions.get(connectionDrag.fromNodeId)?.x ?? 0) + NODE_WIDTH,
                    y: (positions.get(connectionDrag.fromNodeId)?.y ?? 0) + NODE_HEIGHT / 2,
                  },
                  connectionDrag.point,
                )}
                markerEnd={`url(#${arrowMarkerId})`}
              />
            ) : null}
            <defs>
              <marker
                id={arrowMarkerId}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path className="canvas-arrow" d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
            </defs>
          </svg>

          {nodes.map((node) => {
            const position = positions.get(node.id) ?? node.position;
            const sequence = orderByNodeId.get(node.id);
            const selected = selectedNodeId === node.id;
            const awaitingConnection = connectingFrom === node.id;
            return (
              <article
                key={node.id}
                className={`canvas-node canvas-node-${node.kind ?? "candidate"}${
                  selected ? " is-selected" : ""
                }${awaitingConnection ? " is-connecting" : ""}`}
                style={
                  {
                    transform: `translate(${String(position.x)}px, ${String(position.y)}px)`,
                    "--artwork-hue": artworkHue(node.track.id),
                  } as CSSProperties
                }
                data-canvas-interactive
                data-node-id={node.id}
                tabIndex={0}
                aria-label={`${sequence ? `Track ${String(sequence)}: ` : "Candidate: "}${
                  node.track.title || "Untitled"
                } by ${node.track.artist ?? "Unknown artist"}`}
                aria-pressed={selected}
                onFocus={() => onSelectNode?.(node.id)}
                onPointerDown={(event) => handleNodePointerDown(event, node)}
                onPointerMove={handleNodePointerMove}
                onPointerUp={handleNodePointerUp}
                onPointerCancel={handleNodePointerUp}
                onKeyDown={(event) => handleNodeKeyDown(event, node)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectNode?.(node.id);
                  onNodeContextMenu?.(node.id, {
                    client: { x: event.clientX, y: event.clientY },
                    canvas: clientToCanvas(event.clientX, event.clientY),
                  });
                }}
              >
                <button
                  className="canvas-node-port canvas-node-input"
                  type="button"
                  data-canvas-input={node.id}
                  disabled={!canWrite}
                  aria-label={`Connect into ${node.track.title}`}
                  title="Incoming connection"
                  onClick={() => connectingFrom && requestConnection(connectingFrom, node.id)}
                />
                <CanvasArtwork node={node} />
                <span className="canvas-node-copy">
                  <strong title={node.track.title}>{node.track.title || "Untitled"}</strong>
                  <span title={node.track.artist ?? undefined}>
                    {node.track.artist ?? "Unknown artist"}
                  </span>
                  <span className="canvas-node-metadata">
                    {node.track.bpm ? `${node.track.bpm.toFixed(1)} BPM` : "— BPM"}
                    <i aria-hidden="true">·</i>
                    {node.track.key ?? "— key"}
                  </span>
                </span>
                {sequence ? <span className="canvas-node-sequence">{String(sequence)}</span> : null}
                <button
                  className="canvas-node-port canvas-node-output"
                  type="button"
                  disabled={!canWrite}
                  aria-label={`Connect ${node.track.title} to another track`}
                  aria-pressed={awaitingConnection}
                  title="Drag or activate, then choose the next track"
                  onPointerDown={(event) => beginConnectionDrag(event, node.id)}
                  onPointerMove={moveConnectionDrag}
                  onPointerUp={finishConnectionDrag}
                  onPointerCancel={finishConnectionDrag}
                  onClick={(event) => {
                    if (event.detail === 0) {
                      setConnectingFrom((current) => (current === node.id ? undefined : node.id));
                    }
                  }}
                />
                {canWrite && onRemoveNode ? (
                  <button
                    className="canvas-node-remove"
                    type="button"
                    onClick={() => onRemoveNode(node.id)}
                    aria-label={`Remove ${node.track.title} from canvas`}
                    title="Remove from canvas"
                  >
                    <Trash2 size={12} />
                  </button>
                ) : null}
                {sequence ? (
                  <span className="canvas-node-in-set" title="Included in playlist order">
                    <Check size={11} /> In set
                  </span>
                ) : null}
              </article>
            );
          })}
        </div>

        {nodes.length === 0 ? (
          <div className="set-canvas-empty">
            <span className="set-canvas-empty-icon">
              <Music2 size={24} />
            </span>
            <strong>Build a set visually</strong>
            <span>Drag tracks here, then connect them to define playlist order.</span>
          </div>
        ) : null}

        {connectingFrom ? (
          <div className="canvas-connection-hint" role="status">
            Choose the next track <X size={12} aria-hidden="true" />
            <button type="button" onClick={() => setConnectingFrom(undefined)}>
              Cancel
            </button>
          </div>
        ) : null}
      </div>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </section>
  );
}

function CanvasArtwork({ node }: { node: SetCanvasNode }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [node.artworkUrl]);
  if (node.artworkUrl && !failed) {
    return (
      <span className="canvas-node-artwork">
        <img src={node.artworkUrl} alt="" loading="lazy" onError={() => setFailed(true)} />
      </span>
    );
  }
  return (
    <span className="canvas-node-artwork is-placeholder" aria-hidden="true">
      <span>{titleInitials(node.track.title, node.track.artist)}</span>
      <Music2 size={26} />
    </span>
  );
}

function connectionPath(start: CanvasPoint, end: CanvasPoint): string {
  const direction = end.x >= start.x ? 1 : -1;
  const distance = Math.max(56, Math.abs(end.x - start.x) * 0.45);
  return `M ${String(start.x)} ${String(start.y)} C ${String(start.x + direction * distance)} ${String(
    start.y,
  )}, ${String(end.x - direction * distance)} ${String(end.y)}, ${String(end.x)} ${String(end.y)}`;
}

function wouldCreateCycle(
  fromNodeId: string,
  toNodeId: string,
  connections: SetCanvasConnection[],
  ignoredIds: Set<string>,
): boolean {
  const outgoing = new Map(
    connections
      .filter((connection) => !ignoredIds.has(connection.id))
      .map((connection) => [connection.fromNodeId, connection.toNodeId]),
  );
  outgoing.set(fromNodeId, toNodeId);
  const visited = new Set<string>();
  let nodeId: string | undefined = toNodeId;
  while (nodeId && !visited.has(nodeId)) {
    if (nodeId === fromNodeId) return true;
    visited.add(nodeId);
    nodeId = outgoing.get(nodeId);
  }
  return false;
}

function readDroppedTrackIds(dataTransfer: DataTransfer): string[] {
  const candidates = [
    dataTransfer.getData("application/x-rekordbox-track-ids"),
    dataTransfer.getData("application/x-rekordbox-track"),
    dataTransfer.getData("application/json"),
    dataTransfer.getData("text/plain"),
  ];
  for (const candidate of candidates) {
    if (!candidate.trim()) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (Array.isArray(parsed)) return uniqueStrings(parsed);
      if (typeof parsed === "object" && parsed !== null) {
        const record = parsed as { trackId?: unknown; trackIds?: unknown };
        if (Array.isArray(record.trackIds)) return uniqueStrings(record.trackIds);
        if (typeof record.trackId === "string") return [record.trackId];
      }
      if (typeof parsed === "string") return [parsed];
    } catch {
      const ids = candidate
        .split(/[\n,]/u)
        .map((value) => value.trim())
        .filter(Boolean);
      if (ids.length) return [...new Set(ids)];
    }
  }
  return [];
}

function uniqueStrings(values: unknown[]): string[] {
  return [
    ...new Set(
      values.filter((value): value is string => typeof value === "string" && value.length > 0),
    ),
  ];
}

function unusedHistoryNodeId(trackId: string, index: number, usedIds: Set<string>): string {
  const base = `playlist:${trackId}:history:${String(index)}`;
  let id = base;
  let suffix = 1;
  while (usedIds.has(id)) id = `${base}:${String(suffix++)}`;
  return id;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
