import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  HardDrive,
  ListMusic,
  LoaderCircle,
  TriangleAlert,
  Usb,
} from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";

import type { PlaylistItem, UsbMediaDevice, UsbMediaResponse } from "../../shared/types.js";
import { compactCount, formatBytes } from "../format.js";

type Props = {
  media?: UsbMediaResponse;
  loading: boolean;
  query: string;
  selectedPlaylistId: string | null;
  onSelectPlaylist(playlist: PlaylistItem): void;
};

type PlaylistNode = PlaylistItem & { children: PlaylistNode[] };

export function UsbMediaSection({
  media,
  loading,
  query,
  selectedPlaylistId,
  onSelectPlaylist,
}: Props) {
  const [expandedDevices, setExpandedDevices] = useState<Set<string>>(() => new Set());
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
  const seenDevices = useRef(new Set<string>());
  const devices = media?.devices ?? [];

  useEffect(() => {
    const currentDeviceIds = new Set(devices.map((device) => device.id));
    const newDeviceIds = devices
      .map((device) => device.id)
      .filter((deviceId) => !seenDevices.current.has(deviceId));
    seenDevices.current = currentDeviceIds;
    if (!newDeviceIds.length) return;
    setExpandedDevices((current) => {
      return new Set([...current, ...newDeviceIds]);
    });
  }, [devices]);

  return (
    <div className="sidebar-section usb-media-section">
      <div className="sidebar-section-label">USB media</div>
      {loading && !media ? (
        <div className="sidebar-provider-message" role="status">
          <LoaderCircle className="spin" size={13} />
          <span>Looking for mounted media…</span>
        </div>
      ) : devices.length === 0 ? (
        <div className="sidebar-empty usb-media-empty">
          <Usb size={15} />
          <span>No USB stick connected</span>
        </div>
      ) : (
        devices.map((device) => {
          const expanded = expandedDevices.has(device.id);
          const playlists = (media?.playlists ?? []).filter(
            (playlist) => playlist.usb?.deviceId === device.id,
          );
          const tree = buildPlaylistTree(playlists);
          return (
            <div className="usb-device" key={device.id}>
              <button
                className="usb-device-heading"
                type="button"
                onClick={() => setExpandedDevices((current) => toggleSetValue(current, device.id))}
                aria-expanded={expanded}
              >
                {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <HardDrive size={13} aria-hidden="true" />
                <span className="usb-device-name">{device.name}</span>
                {device.status === "error" ? (
                  <TriangleAlert className="usb-device-error" size={12} />
                ) : null}
                <span className="sidebar-count">{compactCount(device.tracks)}</span>
              </button>
              {expanded ? (
                <div className="usb-device-body">
                  <div className={`usb-device-summary status-${device.status}`}>
                    {deviceSummary(device)}
                  </div>
                  {device.status === "ready" ? (
                    <div
                      className="playlist-tree"
                      role="tree"
                      aria-label={`${device.name} playlists`}
                    >
                      {tree.map((node) => (
                        <UsbPlaylistNode
                          key={node.id}
                          node={node}
                          depth={0}
                          query={query}
                          selectedId={selectedPlaylistId}
                          expanded={expandedFolders}
                          onToggle={(id) =>
                            setExpandedFolders((current) => toggleSetValue(current, id))
                          }
                          onSelect={onSelectPlaylist}
                        />
                      ))}
                    </div>
                  ) : (
                    <div
                      className={`sidebar-provider-message ${device.status === "error" ? "is-error" : ""}`}
                      role={device.status === "error" ? "alert" : "status"}
                      title={device.error}
                    >
                      {device.status === "staging" ? (
                        <LoaderCircle className="spin" size={13} />
                      ) : device.status === "error" ? (
                        <TriangleAlert size={13} />
                      ) : (
                        <ListMusic size={13} />
                      )}
                      <span>
                        {device.error ??
                          (device.status === "staging"
                            ? "USB sync is preparing this stick"
                            : "No published Rekordbox library")}
                      </span>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          );
        })
      )}
    </div>
  );
}

function UsbPlaylistNode({
  node,
  depth,
  query,
  selectedId,
  expanded,
  onToggle,
  onSelect,
}: {
  node: PlaylistNode;
  depth: number;
  query: string;
  selectedId: string | null;
  expanded: Set<string>;
  onToggle(id: string): void;
  onSelect(playlist: PlaylistItem): void;
}) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const isFolder = node.type === "folder";
  const matches = nodeMatches(node, normalizedQuery);
  const isExpanded = Boolean(normalizedQuery) || expanded.has(node.id);
  const Icon = isFolder ? (isExpanded ? FolderOpen : Folder) : ListMusic;
  if (normalizedQuery && !matches) return null;
  return (
    <div
      className="playlist-node"
      role="treeitem"
      aria-expanded={isFolder ? isExpanded : undefined}
    >
      <div
        className={`playlist-node-row usb-playlist-row ${node.id === selectedId ? "is-active" : ""}`}
        style={{ "--depth": depth } as CSSProperties}
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
          onClick={() => (isFolder ? onToggle(node.id) : onSelect(node))}
          aria-current={node.id === selectedId ? "page" : undefined}
        >
          <Icon size={14} aria-hidden="true" />
          <span className="playlist-name">{node.name}</span>
          {!isFolder ? (
            <span className="sidebar-count">
              {node.trackCount === null ? "—" : compactCount(node.trackCount)}
            </span>
          ) : null}
        </button>
      </div>
      {isFolder && isExpanded && node.children.length ? (
        <div role="group">
          {node.children.map((child) => (
            <UsbPlaylistNode
              key={child.id}
              node={child}
              depth={depth + 1}
              query={query}
              selectedId={selectedId}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function deviceSummary(device: UsbMediaDevice): string {
  const format =
    device.libraryFormat === "dual"
      ? "Device Library + OneLibrary"
      : device.libraryFormat === "one-library"
        ? "OneLibrary"
        : device.libraryFormat === "device-library"
          ? "Device Library"
          : "Mounted volume";
  const used =
    device.totalBytes !== null && device.availableBytes !== null
      ? `${formatBytes(device.totalBytes - device.availableBytes)} used of ${formatBytes(device.totalBytes)}`
      : undefined;
  return [format, used].filter(Boolean).join(" · ");
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
  const sort = (values: PlaylistNode[]) => {
    values.sort((left, right) => left.seq - right.seq || left.name.localeCompare(right.name));
    for (const value of values) sort(value.children);
  };
  sort(roots);
  return roots;
}

function nodeMatches(node: PlaylistNode, query: string): boolean {
  return (
    !query ||
    node.name.toLocaleLowerCase().includes(query) ||
    node.children.some((child) => nodeMatches(child, query))
  );
}

function toggleSetValue(current: Set<string>, value: string): Set<string> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
