import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AudioLines,
  ChevronDown,
  ChevronRight,
  Disc3,
  Folder,
  FolderOpen,
  ListMusic,
  Music2,
  PanelLeftClose,
  PanelRightOpen,
  Plus,
  Search,
  Sparkles,
  X,
} from "lucide-react";

import type { LibraryBootstrap, PlaylistItem } from "../../shared/types.js";
import { compactCount } from "../format.js";

type Props = {
  bootstrap?: LibraryBootstrap;
  items: PlaylistItem[];
  selectedPlaylistId: string | null;
  activeFilter: string;
  loading: boolean;
  open: boolean;
  canWrite: boolean;
  onClose(): void;
  onSelectPlaylist(id: string | null): void;
  onSelectFilter(filter: string): void;
  onCreatePlaylist(parentId?: string): void;
  onEditPlaylist?(playlist: PlaylistItem): void;
  onPlaylistContextMenu?(
    point: { x: number; y: number },
    playlist: PlaylistItem,
    returnFocus: HTMLElement,
    folder?: { expanded: boolean; toggle(): void },
  ): void;
};

type PlaylistNode = PlaylistItem & { children: PlaylistNode[] };

const smartViews = [
  { id: "all", label: "All tracks", icon: Music2, count: "tracks" as const },
  { id: "analyzed", label: "Analyzed", icon: Activity, count: "analyzed" as const },
  {
    id: "attention",
    label: "Needs attention",
    icon: AudioLines,
    count: "missingAnalysis" as const,
  },
];

export function LibrarySidebar({
  bootstrap,
  items,
  selectedPlaylistId,
  activeFilter,
  loading,
  open,
  canWrite,
  onClose,
  onSelectPlaylist,
  onSelectFilter,
  onCreatePlaylist,
  onEditPlaylist,
  onPlaylistContextMenu,
}: Props) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const tree = useMemo(() => buildPlaylistTree(items), [items]);
  const normalizedQuery = query.trim().toLocaleLowerCase();

  useEffect(() => {
    if (!selectedPlaylistId) return;
    const parents = parentChain(items, selectedPlaylistId);
    if (!parents.length) return;
    setExpanded((current) => new Set([...current, ...parents]));
  }, [items, selectedPlaylistId]);

  const selectSmartView = (id: string) => {
    onSelectPlaylist(null);
    onSelectFilter(id);
    onClose();
  };

  return (
    <aside className={`library-sidebar ${open ? "is-open" : ""}`} aria-label="Library browser">
      <div className="sidebar-brand">
        <span className="brand-mark" aria-hidden="true">
          <Disc3 size={17} />
        </span>
        <div className="brand-copy">
          <strong>Music Library</strong>
          <span>Rekordbox workbench</span>
        </div>
        <button className="icon-button sidebar-close" type="button" onClick={onClose}>
          <X size={17} />
          <span className="sr-only">Close library browser</span>
        </button>
        <button className="icon-button sidebar-collapse" type="button" onClick={onClose}>
          <PanelLeftClose size={16} />
          <span className="sr-only">Collapse library browser</span>
        </button>
      </div>

      <div className="sidebar-search">
        <Search size={14} aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          type="search"
          placeholder="Filter playlists"
          aria-label="Filter playlists"
        />
        {query ? (
          <button type="button" onClick={() => setQuery("")} aria-label="Clear playlist filter">
            <X size={13} />
          </button>
        ) : null}
      </div>

      <nav className="sidebar-scroll" aria-label="Library sections">
        <div className="sidebar-section">
          <div className="sidebar-section-label">Library</div>
          <div className="sidebar-menu">
            {smartViews.map((view) => {
              const active = selectedPlaylistId === null && activeFilter === view.id;
              const Icon = view.icon;
              const count = view.count ? bootstrap?.library.stats[view.count] : undefined;
              return (
                <button
                  key={view.id}
                  type="button"
                  className={`sidebar-item ${active ? "is-active" : ""}`}
                  aria-current={active ? "page" : undefined}
                  onClick={() => selectSmartView(view.id)}
                >
                  <Icon size={15} aria-hidden="true" />
                  <span>{view.label}</span>
                  {count != null ? (
                    <span className="sidebar-count">{compactCount(count)}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        <div className="sidebar-section playlists-section">
          <div className="sidebar-section-heading">
            <span className="sidebar-section-label">Playlists</span>
            <button
              className="small-icon-button"
              type="button"
              disabled={!canWrite}
              onClick={() => onCreatePlaylist()}
              aria-label="Create playlist"
              title="Create playlist"
            >
              <Plus size={14} />
            </button>
          </div>
          {loading ? (
            <PlaylistSkeleton />
          ) : tree.length === 0 ? (
            <div className="sidebar-empty">
              <ListMusic size={17} />
              <span>No playlists found</span>
            </div>
          ) : (
            <div className="playlist-tree" role="tree" aria-label="Rekordbox playlists">
              {tree.map((node) => (
                <PlaylistTreeNode
                  key={node.id}
                  node={node}
                  depth={0}
                  query={normalizedQuery}
                  selectedId={selectedPlaylistId}
                  expanded={expanded}
                  onToggle={(id) =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    })
                  }
                  onSelect={(id) => {
                    onSelectFilter("all");
                    onSelectPlaylist(id);
                    onClose();
                  }}
                  onContextMenu={onPlaylistContextMenu}
                  onEdit={(playlist) => onEditPlaylist?.(playlist)}
                />
              ))}
            </div>
          )}
        </div>
      </nav>

      <div className="sidebar-footer">
        <div className="database-status" title={bootstrap?.library.dbPath}>
          <span className={`status-dot ${bootstrap ? "is-online" : ""}`} />
          <span className="database-status-copy">
            <strong>{bootstrap ? "Library connected" : "Connecting…"}</strong>
            <span>
              {bootstrap
                ? `${compactCount(bootstrap.library.stats.tracks)} tracks · ${compactCount(bootstrap.library.stats.playlists)} playlists`
                : "Reading local database"}
            </span>
          </span>
        </div>
      </div>
    </aside>
  );
}

function PlaylistTreeNode({
  node,
  depth,
  query,
  selectedId,
  expanded,
  onToggle,
  onSelect,
  onContextMenu,
  onEdit,
}: {
  node: PlaylistNode;
  depth: number;
  query: string;
  selectedId: string | null;
  expanded: Set<string>;
  onToggle(id: string): void;
  onSelect(id: string): void;
  onContextMenu?(
    point: { x: number; y: number },
    playlist: PlaylistItem,
    returnFocus: HTMLElement,
    folder?: { expanded: boolean; toggle(): void },
  ): void;
  onEdit(playlist: PlaylistItem): void;
}) {
  const isFolder = node.type === "folder";
  const descendantsMatch = nodeMatches(node, query);
  if (query && !descendantsMatch) return null;
  const isExpanded = Boolean(query) || expanded.has(node.id);
  const Icon = isFolder
    ? isExpanded
      ? FolderOpen
      : Folder
    : node.type === "smart"
      ? Sparkles
      : ListMusic;
  const active = node.id === selectedId;

  return (
    <div
      className="playlist-node"
      role="treeitem"
      aria-expanded={isFolder ? isExpanded : undefined}
    >
      <div
        className={`playlist-node-row ${active ? "is-active" : ""}`}
        style={{ "--depth": depth } as React.CSSProperties}
      >
        {isFolder ? (
          <button
            type="button"
            className="tree-toggle"
            onClick={() => onToggle(node.id)}
            aria-label={`${isExpanded ? "Collapse" : "Expand"} ${node.name}`}
          >
            {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        ) : (
          <span className="tree-spacer" />
        )}
        <button
          type="button"
          className="playlist-select"
          onClick={() => (isFolder ? onToggle(node.id) : onSelect(node.id))}
          onDoubleClick={() => !isFolder && node.type === "playlist" && onEdit(node)}
          onContextMenu={(event) => {
            event.preventDefault();
            onContextMenu?.(
              { x: event.clientX, y: event.clientY },
              node,
              event.currentTarget,
              isFolder ? { expanded: isExpanded, toggle: () => onToggle(node.id) } : undefined,
            );
          }}
          onKeyDown={(event) => {
            if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            onContextMenu?.(
              { x: bounds.left + 24, y: bounds.bottom },
              node,
              event.currentTarget,
              isFolder ? { expanded: isExpanded, toggle: () => onToggle(node.id) } : undefined,
            );
          }}
          aria-current={active ? "page" : undefined}
        >
          <Icon size={14} aria-hidden="true" />
          <span className="playlist-name">{node.name}</span>
          {!isFolder ? (
            <span
              className={`sidebar-count ${node.countError ? "is-error" : ""}`}
              aria-label={
                node.countError
                  ? `Track count unavailable: ${node.countError}`
                  : node.trackCount === null
                    ? "Track count unavailable"
                    : `${String(node.trackCount)} tracks`
              }
              title={
                node.countError ??
                (node.trackCount === null ? "Track count unavailable" : undefined)
              }
            >
              {node.countError
                ? "!"
                : node.trackCount === null
                  ? "—"
                  : compactCount(node.trackCount)}
            </span>
          ) : null}
        </button>
        {node.type === "playlist" ? (
          <button
            className="playlist-edit-button"
            type="button"
            onClick={() => onEdit(node)}
            aria-label={`Edit ${node.name} in split view`}
            title="Edit in split view"
          >
            <PanelRightOpen size={12} />
          </button>
        ) : null}
      </div>
      {isFolder && isExpanded && node.children.length ? (
        <div role="group">
          {node.children.map((child) => (
            <PlaylistTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              query={query}
              selectedId={selectedId}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
              onEdit={onEdit}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PlaylistSkeleton() {
  return (
    <div className="playlist-skeleton" aria-label="Loading playlists">
      {[72, 58, 83, 66, 77].map((width, index) => (
        <div key={`${width}-${index}`} className="skeleton-line" style={{ width: `${width}%` }} />
      ))}
    </div>
  );
}

function buildPlaylistTree(items: PlaylistItem[]): PlaylistNode[] {
  const nodes = new Map<string, PlaylistNode>(
    items.map((item) => [item.id, { ...item, children: [] }]),
  );
  const roots: PlaylistNode[] = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(node.parentId);
    if (parent && parent.id !== node.id) parent.children.push(node);
    else roots.push(node);
  }
  const sortNodes = (values: PlaylistNode[]) => {
    values.sort((left, right) => left.seq - right.seq || left.name.localeCompare(right.name));
    for (const value of values) sortNodes(value.children);
  };
  sortNodes(roots);
  return roots;
}

function nodeMatches(node: PlaylistNode, query: string): boolean {
  if (!query) return true;
  return (
    node.name.toLocaleLowerCase().includes(query) ||
    node.children.some((child) => nodeMatches(child, query))
  );
}

function parentChain(items: PlaylistItem[], selectedId: string): string[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const result: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(selectedId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.parentId);
    if (!parent) break;
    result.push(parent.id);
    current = parent;
  }
  return result;
}
