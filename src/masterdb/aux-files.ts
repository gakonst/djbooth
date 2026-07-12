import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { XMLBuilder, XMLParser } from "fast-xml-parser";

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** Parsed playlist metadata from `masterPlaylists6.xml`. */
export type MasterPlaylistEntry = {
  Attribute: number;
  CheckType: number;
  Id: string;
  Lib_Type: number;
  ParentId: string;
  Timestamp: Date;
};

/** Rekordbox `masterPlaylists6.xml` companion-file handler. */
export class MasterPlaylistXml {
  /** Source/destination path. */
  path: string;
  /** Whether in-memory data differs from the saved file. */
  modified = false;

  private document: Record<string, unknown>;
  private root: Record<string, unknown>;
  private product: Record<string, unknown>;
  private playlists: Record<string, unknown>;

  constructor(path: string) {
    this.path = path;
    const parser = new XMLParser({
      attributeNamePrefix: "",
      ignoreAttributes: false,
      parseAttributeValue: false,
      processEntities: false,
    });
    this.document = asRecord(parser.parse(readFileSync(path, "utf8")));
    this.root = asRecord(this.document.MASTER_PLAYLIST);
    this.product = asRecord(this.root.PRODUCT);
    this.playlists = asRecord(this.root.PLAYLISTS);
    if (!Object.keys(this.root).length || !Object.keys(this.product).length)
      throw new TypeError(`Invalid master playlist XML '${path}'`);
  }

  /** Companion-file format version. */
  get version(): string {
    return String(this.root.Version ?? "");
  }

  /** Automatic-sync flag. */
  get automaticSync(): string {
    return String(this.root.AutomaticSync ?? "");
  }

  /** Rekordbox product version. */
  get rekordboxVersion(): string {
    return String(this.product.Version ?? "");
  }

  private rawEntries(): Array<Record<string, unknown>> {
    const nodes = this.playlists.NODE;
    if (!nodes) return [];
    return (Array.isArray(nodes) ? nodes : [nodes]).map(asRecord);
  }

  private setEntries(entries: Array<Record<string, unknown>>): void {
    this.playlists.NODE = entries;
  }

  /** Raw string attributes for all playlist nodes. */
  getPlaylists(): Array<Record<string, string>> {
    return this.rawEntries().map((entry) =>
      Object.fromEntries(Object.entries(entry).map(([key, value]) => [key, String(value)])),
    );
  }

  /** Return one playlist by decimal database ID. */
  get(playlistId: string | number): MasterPlaylistEntry | undefined {
    const id = Number(playlistId).toString(16).toUpperCase();
    const entry = this.rawEntries().find((candidate) => candidate.Id === id);
    if (!entry) return undefined;
    return {
      Attribute: Number(entry.Attribute),
      CheckType: Number(entry.CheckType),
      Id: String(entry.Id),
      Lib_Type: Number(entry.Lib_Type),
      ParentId: String(entry.ParentId),
      Timestamp: new Date(Number(entry.Timestamp)),
    };
  }

  /** Add a playlist node. */
  add(
    playlistId: string | number,
    parentId: string | number,
    attribute: number,
    updatedAt: Date,
    options: { checkType?: number; libType?: number } = {},
  ): void {
    if (this.get(playlistId)) throw new Error(`Playlist '${playlistId}' already exists in XML`);
    const entries = this.rawEntries();
    entries.push({
      Attribute: String(attribute),
      CheckType: String(options.checkType ?? 0),
      Id: Number(playlistId).toString(16).toUpperCase(),
      Lib_Type: String(options.libType ?? 0),
      ParentId: parentId === "root" ? "0" : Number(parentId).toString(16).toUpperCase(),
      Timestamp: String(updatedAt.getTime()),
    });
    this.setEntries(entries);
    this.modified = true;
  }

  /** Remove a playlist node. */
  remove(playlistId: string | number): void {
    const id = Number(playlistId).toString(16).toUpperCase();
    const entries = this.rawEntries();
    const index = entries.findIndex((entry) => entry.Id === id);
    if (index === -1) throw new Error(`Playlist '${playlistId}' not found in XML`);
    entries.splice(index, 1);
    this.setEntries(entries);
    this.modified = true;
  }

  /** Update selected playlist-node attributes. */
  update(
    playlistId: string | number,
    values: {
      attribute?: number;
      checkType?: number;
      libType?: number;
      parentId?: string | number;
      updatedAt?: Date;
    },
  ): void {
    const id = Number(playlistId).toString(16).toUpperCase();
    const entry = this.rawEntries().find((candidate) => candidate.Id === id);
    if (!entry) throw new Error(`Playlist '${playlistId}' not found in XML`);
    if (values.parentId !== undefined)
      entry.ParentId =
        values.parentId === "root" ? "0" : Number(values.parentId).toString(16).toUpperCase();
    if (values.attribute !== undefined) entry.Attribute = String(values.attribute);
    if (values.updatedAt !== undefined) entry.Timestamp = String(values.updatedAt.getTime());
    if (values.libType !== undefined) entry.Lib_Type = String(values.libType);
    if (values.checkType !== undefined) entry.CheckType = String(values.checkType);
    this.modified = true;
  }

  /** Serialize the companion file. */
  toString(indent = "    "): string {
    const builder = new XMLBuilder({
      attributeNamePrefix: "",
      format: true,
      ignoreAttributes: false,
      indentBy: indent,
      processEntities: false,
      suppressEmptyNode: true,
    });
    return `<?xml version="1.0" encoding="utf-8"?>\n${builder.build(this.document).trim()}\n`;
  }

  /** Save the companion file. */
  save(path = this.path, indent = "    "): void {
    const directory = dirname(path);
    const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o666;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryPath, "wx", mode);
      writeFileSync(descriptor, this.toString(indent), "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, path);
    } catch (error) {
      if (descriptor !== undefined)
        try {
          closeSync(descriptor);
        } catch {
          // Preserve the original write error.
        }
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The temporary file may not have been created or may already have been renamed.
      }
      throw error;
    }
    this.path = path;
    this.modified = false;
  }
}
