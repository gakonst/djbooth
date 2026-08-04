import { extname, posix } from "node:path";

import { createEmptyLegacyDevicePdb } from "./template.js";

const PAGE_HEADER_BYTES = 0x28;

const TABLE = {
  TRACKS: 0,
  GENRES: 1,
  ARTISTS: 2,
  ALBUMS: 3,
  LABELS: 4,
  KEYS: 5,
  PLAYLIST_TREE: 7,
  PLAYLIST_ENTRIES: 8,
  HISTORY_PLAYLISTS: 11,
  HISTORY_ENTRIES: 12,
} as const;

const FILE_TYPE_BY_EXTENSION: Readonly<Record<string, number>> = {
  ".aif": 12,
  ".aiff": 12,
  ".flac": 5,
  ".m4a": 4,
  ".mp3": 1,
  ".wav": 11,
};

/** Metadata written into one legacy Device Library track row. */
export type LegacyDeviceTrackInput = {
  /** Stable positive DeviceSQL ID. Omit to allocate the next available ID. */
  id?: number;
  title: string;
  filePath: string;
  filename?: string;
  artist?: string | null;
  album?: string | null;
  genre?: string | null;
  key?: string | null;
  label?: string | null;
  comment?: string;
  mixName?: string;
  releaseDate?: string;
  analyzePath?: string;
  dateAdded?: string;
  tempo?: number;
  duration?: number;
  year?: number;
  bitrate?: number;
  sampleRate?: number;
  sampleDepth?: number;
  fileSize?: number;
  trackNumber?: number;
  discNumber?: number;
  playCount?: number;
  rating?: number;
  colorId?: number;
  artworkId?: number;
  fileType?: number;
  /** Desktop master-library content ID retained by Rekordbox's legacy export. */
  masterContentId?: number;
  /** Desktop master database ID split across the legacy row's two 16-bit fields. */
  masterDbId?: number;
  /** Source analysis revision string; defaults to Rekordbox's analyzed-row value. */
  analysisDataUpdateCount?: number;
  /** Source metadata revision string; defaults to Rekordbox's analyzed-row value. */
  informationUpdateCount?: number;
};

/** Parsed track fields used to verify a generated legacy Device Library. */
export type LegacyDevicePdbTrack = {
  id: number;
  title: string;
  filename: string;
  filePath: string;
  analyzePath: string;
  artist: string | null;
  album: string | null;
  genre: string | null;
  key: string | null;
  tempo: number;
  duration: number;
  playCount: number;
};

/** Parsed playlist fields used to verify a generated legacy Device Library. */
export type LegacyDevicePdbPlaylist = {
  id: number;
  parentId: number;
  name: string;
  folder: boolean;
  trackIds: number[];
};

/** One CDJ-created play history and its ordered DeviceSQL track IDs. */
export type LegacyDevicePdbHistory = {
  id: number;
  name: string;
  trackIds: number[];
};

/** Bounded semantic inspection of a generated `export.pdb`. */
export type LegacyDevicePdbInspection = {
  pageSize: number;
  tracks: LegacyDevicePdbTrack[];
  playlists: LegacyDevicePdbPlaylist[];
  histories: LegacyDevicePdbHistory[];
};

function align4(value: number): number {
  return (value + 3) & ~3;
}

function requireUnsigned(name: string, value: number, bytes: 1 | 2 | 4): number {
  const maximum = bytes === 4 ? 0xffff_ffff : 2 ** (bytes * 8) - 1;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new RangeError(`${name}=${String(value)} does not fit in ${String(bytes)} byte(s)`);
  return value;
}

function nextEntityId(ids: ReadonlyMap<string, number>): number {
  return Math.max(0, ...ids.values()) + 1;
}

function encodeDeviceSqlString(text: string): Buffer {
  if ([...text].every((character) => character.codePointAt(0)! <= 0x7f)) {
    const bytes = Buffer.from(text, "ascii");
    if (bytes.length <= 126)
      return Buffer.concat([Buffer.from([(bytes.length + 1) * 2 + 1]), bytes]);
    if (bytes.length > 32_763) throw new RangeError("DeviceSQL string is too long");
    const header = Buffer.alloc(4);
    header[0] = 0x40;
    header.writeUInt16LE(bytes.length + 4, 1);
    return Buffer.concat([header, bytes]);
  }
  const bytes = Buffer.from(text, "utf16le");
  if (bytes.length + 4 > 0x7fff) throw new RangeError("DeviceSQL string is too long");
  const header = Buffer.alloc(4);
  header[0] = 0x90;
  header.writeUInt16LE(bytes.length + 4, 1);
  return Buffer.concat([header, bytes]);
}

function decodeDeviceSqlString(data: Buffer, offset: number): string {
  if (offset < 0 || offset >= data.length)
    throw new RangeError(`DeviceSQL string offset ${String(offset)} is outside the database`);
  const kind = data[offset]!;
  if (kind & 1) {
    const length = Math.max((kind >> 1) - 1, 0);
    return data.toString("utf8", offset + 1, offset + 1 + length);
  }
  if (offset + 4 > data.length) throw new RangeError("Truncated DeviceSQL string header");
  const length = data.readUInt16LE(offset + 1);
  if (length < 4 || offset + length > data.length)
    throw new RangeError("Invalid DeviceSQL string length");
  if (kind === 0x40) return data.toString("utf8", offset + 4, offset + length);
  if (kind === 0x90) return data.toString("utf16le", offset + 4, offset + length);
  throw new TypeError(`Unknown DeviceSQL string kind 0x${kind.toString(16).padStart(2, "0")}`);
}

function inferredFileType(path: string): number {
  const extension = extname(path).toLowerCase();
  const type = FILE_TYPE_BY_EXTENSION[extension];
  if (!type)
    throw new TypeError(
      `Legacy Device Library export does not support '${extension || "(no extension)"}' audio`,
    );
  return type;
}

/**
 * Builds a CDJ-3000-compatible legacy `PIONEER/rekordbox/export.pdb`.
 *
 * This is intentionally a fresh compiler target: SQLite remains authoritative and
 * callers create a new writer for each export.
 */
export class LegacyDevicePdbWriter {
  private data: Buffer;
  private readonly pageSize: number;
  private readonly originalSlots = new Map<number, number>();
  private readonly appendedSlots = new Map<number, number>();
  private readonly newGenerations = new Map<number, number>();
  private readonly touchedPages = new Map<number, Set<number>>();
  private readonly artistIds = new Map<string, number>();
  private readonly albumIds = new Map<string, number>();
  private readonly genreIds = new Map<string, number>();
  private readonly keyIds = new Map<string, number>();
  private readonly labelIds = new Map<string, number>();
  private readonly playlistFolders = new Map<number, boolean>();
  private readonly playlistSortOrders = new Map<number, number>();
  private readonly playlistEntryCounts = new Map<number, number>();
  private readonly trackIds = new Set<number>();
  private readonly historyIds = new Set<number>();
  private readonly historyEntryCounts = new Map<number, number>();
  private trackCount = 0;
  private nextTrackId = 0;
  private playlistCount = 0;
  private nextHistoryId = 0;
  private finalized = false;

  /** Create a fresh database or append rows to an existing legacy Device Library. */
  constructor(existing?: Buffer) {
    this.data = existing ? Buffer.from(existing) : createEmptyLegacyDevicePdb();
    this.pageSize = this.data.readUInt32LE(4);
    if (this.pageSize !== 4096)
      throw new TypeError(`Unsupported DeviceSQL page size ${String(this.pageSize)}`);
    if (existing) this.seedExistingRows();
  }

  /** Append one track and return its generated DeviceSQL track ID. */
  addTrack(input: LegacyDeviceTrackInput): number {
    this.requireMutable();
    if (!input.title.length) throw new TypeError("Legacy Device Library track title is required");
    if (!input.filePath.startsWith("/"))
      throw new TypeError(`Legacy Device Library file path must be absolute: '${input.filePath}'`);

    const values = {
      artworkId: input.artworkId ?? 0,
      bitrate: input.bitrate ?? 0,
      colorId: input.colorId ?? 0,
      discNumber: input.discNumber ?? 0,
      duration: input.duration ?? 0,
      fileSize: input.fileSize ?? 0,
      fileType: input.fileType ?? inferredFileType(input.filePath),
      playCount: input.playCount ?? 0,
      rating: input.rating ?? 0,
      sampleDepth: input.sampleDepth ?? 16,
      sampleRate: input.sampleRate ?? 44_100,
      tempo: input.tempo ?? 0,
      trackNumber: input.trackNumber ?? 0,
      year: input.year ?? 0,
    };
    requireUnsigned("artworkId", values.artworkId, 4);
    requireUnsigned("bitrate", values.bitrate, 4);
    requireUnsigned("colorId", values.colorId, 1);
    requireUnsigned("discNumber", values.discNumber, 2);
    requireUnsigned("duration", values.duration, 2);
    requireUnsigned("fileSize", values.fileSize, 4);
    requireUnsigned("fileType", values.fileType, 2);
    requireUnsigned("playCount", values.playCount, 2);
    requireUnsigned("rating", values.rating, 1);
    requireUnsigned("sampleDepth", values.sampleDepth, 2);
    requireUnsigned("sampleRate", values.sampleRate, 4);
    requireUnsigned("tempo", values.tempo, 4);
    requireUnsigned("trackNumber", values.trackNumber, 4);
    requireUnsigned("year", values.year, 2);

    const filename = input.filename ?? posix.basename(input.filePath);
    const strings = [
      "",
      "",
      String(input.analysisDataUpdateCount ?? 2),
      String(input.informationUpdateCount ?? 2),
      "",
      "",
      "ON",
      "ON",
      "",
      "",
      input.dateAdded ?? "",
      input.releaseDate ?? "",
      input.mixName ?? "",
      "",
      input.analyzePath ?? "",
      input.dateAdded ?? "",
      input.comment ?? "",
      input.title,
      "",
      filename,
      input.filePath,
    ].map(encodeDeviceSqlString);
    const allocation = 0x88 + strings.reduce((sum, value) => sum + align4(value.length), 0) + 4;
    this.requireRowCapacity(allocation);

    const artistId = input.artist ? this.getOrCreateArtist(input.artist) : 0;
    const albumId = input.album ? this.getOrCreateAlbum(input.album, artistId) : 0;
    const genreId = input.genre
      ? this.getOrCreateNamed(TABLE.GENRES, input.genre, this.genreIds)
      : 0;
    const keyId = input.key ? this.getOrCreateKey(input.key) : 0;
    const labelId = input.label
      ? this.getOrCreateNamed(TABLE.LABELS, input.label, this.labelIds)
      : 0;
    const trackId = input.id ?? this.nextAvailableTrackId();
    requireUnsigned("track id", trackId, 4);
    if (trackId === 0) throw new RangeError("Legacy Device Library track ID must be positive");
    if (this.trackIds.has(trackId))
      throw new Error(`Legacy Device Library track ID ${String(trackId)} already exists`);
    this.trackIds.add(trackId);
    this.trackCount++;
    this.nextTrackId = Math.max(this.nextTrackId, trackId);
    const masterContentId = input.masterContentId ?? 0x0010_0000 + trackId;
    const masterDbId = input.masterDbId ?? 0x03dd_ae49;
    requireUnsigned("master content id", masterContentId, 4);
    requireUnsigned("master database id", masterDbId, 4);

    const fixed = Buffer.alloc(0x5e);
    let offset = 0;
    const put16 = (value: number) => {
      fixed.writeUInt16LE(value, offset);
      offset += 2;
    };
    const put32 = (value: number) => {
      fixed.writeUInt32LE(value, offset);
      offset += 4;
    };
    put16(0x0024);
    put16(0);
    put32(0x000c_0700);
    put32(values.sampleRate);
    put32(0);
    put32(values.fileSize);
    put32(masterContentId);
    put16(masterDbId & 0xffff);
    put16(masterDbId >>> 16);
    put32(values.artworkId);
    put32(keyId);
    put32(0);
    put32(labelId);
    put32(0);
    put32(values.bitrate);
    put32(values.trackNumber);
    put32(values.tempo);
    put32(genreId);
    put32(albumId);
    put32(artistId);
    put32(trackId);
    put16(values.discNumber);
    put16(values.playCount);
    put16(values.year);
    put16(values.sampleDepth);
    put16(values.duration);
    put16(0x0029);
    fixed[offset++] = values.colorId;
    fixed[offset++] = values.rating;
    put16(values.fileType);
    put16(0x0003);
    if (offset !== fixed.length) throw new Error("Internal track-row layout mismatch");

    const stringOffsets = Buffer.alloc(42);
    const blobs: Buffer[] = [];
    let position = 0x88;
    for (const [index, encoded] of strings.entries()) {
      if (!(encoded[0]! & 1) && position % 4) {
        const padding = Buffer.alloc(4 - (position % 4));
        blobs.push(padding);
        position += padding.length;
      }
      stringOffsets.writeUInt16LE(position, index * 2);
      blobs.push(encoded);
      position += encoded.length;
    }
    this.appendRow(TABLE.TRACKS, Buffer.concat([fixed, stringOffsets, ...blobs]), allocation, 2);
    return trackId;
  }

  /** Append a playlist or folder and return its generated DeviceSQL node ID. */
  createPlaylist(name: string, options: { parentId?: number; folder?: boolean } = {}): number {
    this.requireMutable();
    if (!name.length) throw new TypeError("Legacy Device Library playlist name is required");
    const parentId = options.parentId ?? 0;
    if (parentId && this.playlistFolders.get(parentId) !== true)
      throw new RangeError(`Playlist parent ${String(parentId)} is missing or is not a folder`);
    const nodeId = ++this.playlistCount;
    const sortOrder = this.playlistSortOrders.get(parentId) ?? 0;
    this.playlistSortOrders.set(parentId, sortOrder + 1);
    const encoded = encodeDeviceSqlString(name);
    const row = Buffer.alloc(20 + encoded.length);
    row.writeUInt32LE(parentId, 0);
    row.writeUInt32LE(0, 4);
    row.writeUInt32LE(sortOrder, 8);
    row.writeUInt32LE(nodeId, 12);
    row.writeUInt32LE(options.folder ? 1 : 0, 16);
    encoded.copy(row, 20);
    this.appendRow(TABLE.PLAYLIST_TREE, row, align4(row.length));
    this.playlistFolders.set(nodeId, options.folder ?? false);
    return nodeId;
  }

  /** Append an ordered track membership to an existing non-folder playlist. */
  addToPlaylist(playlistId: number, trackId: number, entryIndex?: number): void {
    this.requireMutable();
    if (this.playlistFolders.get(playlistId) !== false)
      throw new RangeError(`Playlist ${String(playlistId)} is missing or is a folder`);
    if (!this.trackIds.has(trackId))
      throw new RangeError(`Track ${String(trackId)} does not exist`);
    const position = entryIndex ?? (this.playlistEntryCounts.get(playlistId) ?? 0) + 1;
    requireUnsigned("entryIndex", position, 4);
    const row = Buffer.alloc(12);
    row.writeUInt32LE(position, 0);
    row.writeUInt32LE(trackId, 4);
    row.writeUInt32LE(playlistId, 8);
    this.appendRow(TABLE.PLAYLIST_ENTRIES, row, row.length);
    this.playlistEntryCounts.set(
      playlistId,
      Math.max(position, this.playlistEntryCounts.get(playlistId) ?? 0),
    );
  }

  /** Append a CDJ-style history playlist and return its DeviceSQL history ID. */
  createHistory(name: string, id?: number): number {
    this.requireMutable();
    if (!name.length) throw new TypeError("Legacy Device Library history name is required");
    const historyId = id ?? this.nextAvailableHistoryId();
    requireUnsigned("history id", historyId, 4);
    if (historyId === 0) throw new RangeError("Legacy Device Library history ID must be positive");
    if (this.historyIds.has(historyId))
      throw new Error(`Legacy Device Library history ID ${String(historyId)} already exists`);
    const encoded = encodeDeviceSqlString(name);
    const row = Buffer.alloc(4 + encoded.length);
    row.writeUInt32LE(historyId, 0);
    encoded.copy(row, 4);
    this.appendRow(TABLE.HISTORY_PLAYLISTS, row, align4(row.length));
    this.historyIds.add(historyId);
    this.nextHistoryId = Math.max(this.nextHistoryId, historyId);
    return historyId;
  }

  /** Append one ordered track occurrence to a CDJ-style history playlist. */
  addToHistory(historyId: number, trackId: number, entryIndex?: number): void {
    this.requireMutable();
    if (!this.historyIds.has(historyId))
      throw new RangeError(`History ${String(historyId)} does not exist`);
    if (!this.trackIds.has(trackId))
      throw new RangeError(`Track ${String(trackId)} does not exist`);
    const position = entryIndex ?? (this.historyEntryCounts.get(historyId) ?? 0) + 1;
    requireUnsigned("entryIndex", position, 4);
    const row = Buffer.alloc(12);
    row.writeUInt32LE(trackId, 0);
    row.writeUInt32LE(historyId, 4);
    row.writeUInt32LE(position, 8);
    this.appendRow(TABLE.HISTORY_ENTRIES, row, row.length);
    this.historyEntryCounts.set(
      historyId,
      Math.max(position, this.historyEntryCounts.get(historyId) ?? 0),
    );
  }

  /** Finalize page generations and return a private copy of `export.pdb`. */
  build(): Buffer {
    if (!this.finalized) {
      for (const [table, pages] of this.touchedPages) {
        const generation = this.newGenerations.get(table);
        if (generation === undefined)
          throw new Error(`Missing generation for table ${String(table)}`);
        for (const page of pages) this.putU32(page * this.pageSize + 0x10, generation);
      }
      if (this.touchedPages.size) this.putU32(0x14, this.u32(0x14) + 1);
      this.finalized = true;
    }
    return Buffer.from(this.data);
  }

  private requireMutable(): void {
    if (this.finalized) throw new Error("Legacy Device Library writer is already finalized");
  }

  private nextAvailableTrackId(): number {
    do this.nextTrackId++;
    while (this.trackIds.has(this.nextTrackId));
    return this.nextTrackId;
  }

  private nextAvailableHistoryId(): number {
    do this.nextHistoryId++;
    while (this.historyIds.has(this.nextHistoryId));
    return this.nextHistoryId;
  }

  private seedExistingRows(): void {
    const inspection = inspectLegacyDevicePdb(this.data);
    for (const track of inspection.tracks) this.trackIds.add(track.id);
    this.trackCount = inspection.tracks.length;
    this.nextTrackId = Math.max(0, ...inspection.tracks.map(({ id }) => id));
    this.playlistCount = Math.max(0, ...inspection.playlists.map(({ id }) => id));
    for (const playlist of inspection.playlists) {
      this.playlistFolders.set(playlist.id, playlist.folder);
      this.playlistEntryCounts.set(playlist.id, playlist.trackIds.length);
    }
    for (const offset of tableRows(this.data, TABLE.PLAYLIST_TREE)) {
      const parentId = this.data.readUInt32LE(offset);
      const sortOrder = this.data.readUInt32LE(offset + 8);
      this.playlistSortOrders.set(
        parentId,
        Math.max(this.playlistSortOrders.get(parentId) ?? 0, sortOrder + 1),
      );
    }
    for (const history of inspection.histories) {
      this.historyIds.add(history.id);
      this.historyEntryCounts.set(history.id, history.trackIds.length);
      this.nextHistoryId = Math.max(this.nextHistoryId, history.id);
    }
    for (const offset of tableRows(this.data, TABLE.ARTISTS)) {
      const subtype = this.data.readUInt16LE(offset);
      const nameOffset =
        subtype === 0x64 ? this.data.readUInt16LE(offset + 0x0a) : this.data[offset + 9]!;
      this.artistIds.set(
        decodeDeviceSqlString(this.data, offset + nameOffset),
        this.data.readUInt32LE(offset + 4),
      );
    }
    for (const offset of tableRows(this.data, TABLE.ALBUMS)) {
      const artistId = this.data.readUInt32LE(offset + 8);
      const id = this.data.readUInt32LE(offset + 12);
      const name = decodeDeviceSqlString(this.data, offset + this.data[offset + 0x15]!);
      this.albumIds.set(`${String(artistId)}\0${name}`, id);
    }
    this.seedNamedRows(TABLE.GENRES, this.genreIds, 4);
    this.seedNamedRows(TABLE.LABELS, this.labelIds, 4);
    for (const offset of tableRows(this.data, TABLE.KEYS))
      this.keyIds.set(decodeDeviceSqlString(this.data, offset + 8), this.data.readUInt32LE(offset));
  }

  private seedNamedRows(table: number, ids: Map<string, number>, nameOffset: number): void {
    for (const offset of tableRows(this.data, table))
      ids.set(
        decodeDeviceSqlString(this.data, offset + nameOffset),
        this.data.readUInt32LE(offset),
      );
  }

  private getOrCreateArtist(name: string): number {
    const existing = this.artistIds.get(name);
    if (existing) return existing;
    const id = nextEntityId(this.artistIds);
    const encoded = encodeDeviceSqlString(name);
    const row = Buffer.concat([
      Buffer.from([0x60, 0, 0, 0]),
      u32Buffer(id),
      Buffer.from([0x03, 0x0a]),
      encoded,
    ]);
    this.appendRow(TABLE.ARTISTS, row, align4(10 + align4(encoded.length)) + 4, 2);
    this.artistIds.set(name, id);
    return id;
  }

  private getOrCreateAlbum(name: string, artistId: number): number {
    const key = `${String(artistId)}\0${name}`;
    const existing = this.albumIds.get(key);
    if (existing) return existing;
    const id = nextEntityId(this.albumIds);
    const encoded = encodeDeviceSqlString(name);
    const row = Buffer.concat([
      Buffer.from([0x80, 0, 0, 0]),
      u32Buffer(0),
      u32Buffer(artistId),
      u32Buffer(id),
      u32Buffer(0),
      Buffer.from([0x03, 0x16]),
      encoded,
    ]);
    this.appendRow(TABLE.ALBUMS, row, align4(22 + align4(encoded.length)) + 4, 2);
    this.albumIds.set(key, id);
    return id;
  }

  private getOrCreateNamed(table: number, name: string, ids: Map<string, number>): number {
    const existing = ids.get(name);
    if (existing) return existing;
    const id = nextEntityId(ids);
    const encoded = encodeDeviceSqlString(name);
    const row = Buffer.concat([u32Buffer(id), encoded]);
    this.appendRow(table, row, align4(row.length));
    ids.set(name, id);
    return id;
  }

  private getOrCreateKey(name: string): number {
    const existing = this.keyIds.get(name);
    if (existing) return existing;
    const id = nextEntityId(this.keyIds);
    const encoded = encodeDeviceSqlString(name);
    const row = Buffer.concat([u32Buffer(id), u32Buffer(id), encoded]);
    this.appendRow(TABLE.KEYS, row, align4(row.length));
    this.keyIds.set(name, id);
    return id;
  }

  private appendRow(
    table: number,
    row: Buffer,
    allocation: number,
    indexShiftOffset?: number,
  ): void {
    this.requireRowCapacity(allocation);
    const tableOffset = this.tableEntryOffset(table);
    let pageIndex = this.u32(tableOffset + 12);
    let pageOffset = pageIndex * this.pageSize;
    if (this.data[pageOffset + 0x1b]! & 0x40) {
      pageIndex = this.allocatePage(table);
      pageOffset = pageIndex * this.pageSize;
    }

    let slots = this.slotCount(pageOffset);
    let used = this.u16(pageOffset + 0x1e);
    if (PAGE_HEADER_BYTES + used + allocation + this.directoryBytes(slots + 1) > this.pageSize) {
      pageIndex = this.allocatePage(table);
      pageOffset = pageIndex * this.pageSize;
      slots = 0;
      used = 0;
    }

    if (!this.originalSlots.has(pageIndex)) {
      this.originalSlots.set(pageIndex, slots);
      this.appendedSlots.set(pageIndex, 0);
      for (let group = 0; group < Math.ceil(slots / 16); group++)
        this.putU16(pageOffset + this.pageSize - group * 0x24 - 2, 0);
    }
    this.markTableTouched(table, pageIndex);

    const group = Math.floor(slots / 16);
    const bit = slots % 16;
    const groupBase = pageOffset + this.pageSize - group * 0x24;
    if (!bit) {
      this.putU16(groupBase - 4, 0);
      this.putU16(groupBase - 2, 0);
    }

    const rowStart = pageOffset + PAGE_HEADER_BYTES + used;
    this.data.fill(0, rowStart, rowStart + allocation);
    row.copy(this.data, rowStart);
    if (indexShiftOffset !== undefined) this.putU16(rowStart + indexShiftOffset, 0x20 * slots);

    this.putU16(groupBase - 6 - 2 * bit, used);
    this.putU16(groupBase - 4, this.u16(groupBase - 4) | (1 << bit));
    this.putU16(groupBase - 2, this.u16(groupBase - 2) | (1 << bit));
    const appended = (this.appendedSlots.get(pageIndex) ?? 0) + 1;
    this.appendedSlots.set(pageIndex, appended);

    const newSlots = slots + 1;
    if (newSlots > 511) throw new RangeError("DeviceSQL page exceeds its 511-slot limit");
    const present = this.presentCount(pageOffset, newSlots);
    this.data[pageOffset + 0x18] = newSlots & 0xff;
    this.putU16(pageOffset + 0x19, (0x20 * present) | (newSlots > 255 ? 1 : 0));
    used += allocation;
    this.putU16(pageOffset + 0x1e, used);
    this.putU16(
      pageOffset + 0x1c,
      this.pageSize - PAGE_HEADER_BYTES - used - this.directoryBytes(newSlots),
    );
    this.putU16(pageOffset + 0x20, appended);
    this.putU16(pageOffset + 0x22, this.originalSlots.get(pageIndex) ?? 0);
  }

  private allocatePage(table: number): number {
    const tableOffset = this.tableEntryOffset(table);
    const pageIndex = this.u32(tableOffset + 4);
    const nextUnused = this.u32(12);
    this.ensureLength((pageIndex + 1) * this.pageSize);
    const previousLast = this.u32(tableOffset + 12);
    const pageOffset = pageIndex * this.pageSize;
    this.data.fill(0, pageOffset, pageOffset + this.pageSize);
    this.putU32(pageOffset + 4, pageIndex);
    this.putU32(pageOffset + 8, table);
    this.putU32(pageOffset + 12, nextUnused);
    this.data[pageOffset + 0x1b] = 0x24;
    this.putU16(pageOffset + 0x1c, this.pageSize - PAGE_HEADER_BYTES);
    this.putU32(tableOffset + 12, pageIndex);
    this.putU32(tableOffset + 4, nextUnused);
    this.putU32(12, nextUnused + 1);

    const previousOffset = previousLast * this.pageSize;
    if (this.data[previousOffset + 0x1b]! & 0x40) {
      const heap = previousOffset + PAGE_HEADER_BYTES;
      if (this.u32(heap + 4) === 0x03ff_ffff) this.putU32(heap + 4, pageIndex);
    }
    this.originalSlots.set(pageIndex, 0);
    this.appendedSlots.set(pageIndex, 0);
    this.markTableTouched(table, pageIndex);
    return pageIndex;
  }

  private markTableTouched(table: number, pageIndex: number): void {
    if (!this.newGenerations.has(table)) {
      const tableOffset = this.tableEntryOffset(table);
      let page = this.u32(tableOffset + 8);
      const last = this.u32(tableOffset + 12);
      let generation = 0;
      const visited = new Set<number>();
      while (true) {
        if (visited.has(page))
          throw new TypeError(`DeviceSQL table ${String(table)} contains a page cycle`);
        visited.add(page);
        generation = Math.max(generation, this.u32(page * this.pageSize + 0x10));
        if (page === last) break;
        page = this.u32(page * this.pageSize + 0x0c);
      }
      this.newGenerations.set(table, generation + 1);
    }
    const pages = this.touchedPages.get(table) ?? new Set<number>();
    pages.add(pageIndex);
    this.touchedPages.set(table, pages);
  }

  private requireRowCapacity(allocation: number): void {
    const maximum = this.pageSize - PAGE_HEADER_BYTES - this.directoryBytes(1);
    if (!Number.isSafeInteger(allocation) || allocation < 1 || allocation > maximum)
      throw new RangeError(
        `DeviceSQL row allocation ${String(allocation)} exceeds page capacity ${String(maximum)}`,
      );
  }

  private tableEntryOffset(table: number): number {
    const count = this.u32(8);
    for (let index = 0; index < count; index++) {
      const offset = 0x1c + index * 16;
      if (this.u32(offset) === table) return offset;
    }
    throw new TypeError(`Legacy Device Library has no table ${String(table)}`);
  }

  private slotCount(pageOffset: number): number {
    return this.data[pageOffset + 0x18]! + 0x100 * (this.data[pageOffset + 0x19]! & 1);
  }

  private directoryBytes(slots: number): number {
    return slots ? 2 * slots + 4 * Math.ceil(slots / 16) : 0;
  }

  private presentCount(pageOffset: number, slots: number): number {
    let count = 0;
    for (let group = 0; group < Math.ceil(slots / 16); group++) {
      const base = pageOffset + this.pageSize - group * 0x24;
      const inGroup = Math.min(16, slots - group * 16);
      const mask = inGroup === 16 ? 0xffff : (1 << inGroup) - 1;
      count += bitCount(this.u16(base - 4) & mask);
    }
    return count;
  }

  private ensureLength(length: number): void {
    if (this.data.length >= length) return;
    const expanded = Buffer.alloc(length);
    this.data.copy(expanded);
    this.data = expanded;
  }

  private u16(offset: number): number {
    return this.data.readUInt16LE(offset);
  }

  private u32(offset: number): number {
    return this.data.readUInt32LE(offset);
  }

  private putU16(offset: number, value: number): void {
    this.data.writeUInt16LE(requireUnsigned("u16", value, 2), offset);
  }

  private putU32(offset: number, value: number): void {
    this.data.writeUInt32LE(requireUnsigned("u32", value, 4), offset);
  }
}

function u32Buffer(value: number): Buffer {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(requireUnsigned("u32", value, 4));
  return data;
}

function bitCount(value: number): number {
  let remaining = value >>> 0;
  let count = 0;
  while (remaining) {
    remaining &= remaining - 1;
    count++;
  }
  return count;
}

function tableRows(data: Buffer, tableType: number): number[] {
  if (data.length < 4096) throw new TypeError("Truncated DeviceSQL database");
  const pageSize = data.readUInt32LE(4);
  const tables = data.readUInt32LE(8);
  let first: number | undefined;
  let last: number | undefined;
  for (let index = 0; index < tables; index++) {
    const offset = 0x1c + index * 16;
    if (data.readUInt32LE(offset) !== tableType) continue;
    first = data.readUInt32LE(offset + 8);
    last = data.readUInt32LE(offset + 12);
    break;
  }
  if (first === undefined || last === undefined) return [];
  const rows: number[] = [];
  const visited = new Set<number>();
  let page = first;
  while (true) {
    if (visited.has(page))
      throw new TypeError(`DeviceSQL table ${String(tableType)} contains a page cycle`);
    visited.add(page);
    const pageOffset = page * pageSize;
    if (pageOffset + pageSize > data.length)
      throw new RangeError(`DeviceSQL page ${String(page)} is outside the database`);
    if (!(data[pageOffset + 0x1b]! & 0x40)) {
      const slots = data[pageOffset + 0x18]! + 0x100 * (data[pageOffset + 0x19]! & 1);
      for (let group = 0; group < Math.ceil(slots / 16); group++) {
        const base = pageOffset + pageSize - group * 0x24;
        const presence = data.readUInt16LE(base - 4);
        const count = Math.min(16, slots - group * 16);
        for (let bit = 0; bit < count; bit++)
          if (presence & (1 << bit))
            rows.push(pageOffset + PAGE_HEADER_BYTES + data.readUInt16LE(base - 6 - bit * 2));
      }
    }
    if (page === last) break;
    page = data.readUInt32LE(pageOffset + 0x0c);
  }
  return rows;
}

/** Parse enough semantic data to verify a generated legacy Device Library. */
export function inspectLegacyDevicePdb(data: Buffer): LegacyDevicePdbInspection {
  const pageSize = data.readUInt32LE(4);
  const artists = new Map(
    tableRows(data, TABLE.ARTISTS).map((offset) => {
      const subtype = data.readUInt16LE(offset);
      const nameOffset = subtype === 0x64 ? data.readUInt16LE(offset + 0x0a) : data[offset + 9]!;
      return [data.readUInt32LE(offset + 4), decodeDeviceSqlString(data, offset + nameOffset)];
    }),
  );
  const albums = new Map(
    tableRows(data, TABLE.ALBUMS).map((offset) => [
      data.readUInt32LE(offset + 12),
      decodeDeviceSqlString(data, offset + data[offset + 0x15]!),
    ]),
  );
  const genres = new Map(
    tableRows(data, TABLE.GENRES).map((offset) => [
      data.readUInt32LE(offset),
      decodeDeviceSqlString(data, offset + 4),
    ]),
  );
  const keys = new Map(
    tableRows(data, TABLE.KEYS).map((offset) => [
      data.readUInt32LE(offset),
      decodeDeviceSqlString(data, offset + 8),
    ]),
  );
  const tracks = tableRows(data, TABLE.TRACKS).map((offset): LegacyDevicePdbTrack => {
    const strings = Array.from({ length: 21 }, (_, index) =>
      decodeDeviceSqlString(data, offset + data.readUInt16LE(offset + 0x5e + index * 2)),
    );
    return {
      id: data.readUInt32LE(offset + 0x48),
      title: strings[17]!,
      filename: strings[19]!,
      filePath: strings[20]!,
      analyzePath: strings[14]!,
      artist: artists.get(data.readUInt32LE(offset + 0x44)) ?? null,
      album: albums.get(data.readUInt32LE(offset + 0x40)) ?? null,
      genre: genres.get(data.readUInt32LE(offset + 0x3c)) ?? null,
      key: keys.get(data.readUInt32LE(offset + 0x20)) ?? null,
      tempo: data.readUInt32LE(offset + 0x38),
      duration: data.readUInt16LE(offset + 0x54),
      playCount: data.readUInt16LE(offset + 0x4e),
    };
  });
  const memberships = new Map<number, Array<{ index: number; trackId: number }>>();
  for (const offset of tableRows(data, TABLE.PLAYLIST_ENTRIES)) {
    const playlistId = data.readUInt32LE(offset + 8);
    const entries = memberships.get(playlistId) ?? [];
    entries.push({ index: data.readUInt32LE(offset), trackId: data.readUInt32LE(offset + 4) });
    memberships.set(playlistId, entries);
  }
  const playlists = tableRows(data, TABLE.PLAYLIST_TREE).map((offset): LegacyDevicePdbPlaylist => {
    const id = data.readUInt32LE(offset + 12);
    return {
      id,
      parentId: data.readUInt32LE(offset),
      name: decodeDeviceSqlString(data, offset + 20),
      folder: data.readUInt32LE(offset + 16) !== 0,
      trackIds: (memberships.get(id) ?? [])
        .sort((left, right) => left.index - right.index)
        .map(({ trackId }) => trackId),
    };
  });
  const historyMemberships = new Map<number, Array<{ index: number; trackId: number }>>();
  for (const offset of tableRows(data, TABLE.HISTORY_ENTRIES)) {
    const historyId = data.readUInt32LE(offset + 4);
    const entries = historyMemberships.get(historyId) ?? [];
    entries.push({ index: data.readUInt32LE(offset + 8), trackId: data.readUInt32LE(offset) });
    historyMemberships.set(historyId, entries);
  }
  const histories = tableRows(data, TABLE.HISTORY_PLAYLISTS).map(
    (offset): LegacyDevicePdbHistory => {
      const id = data.readUInt32LE(offset);
      return {
        id,
        name: decodeDeviceSqlString(data, offset + 4),
        trackIds: (historyMemberships.get(id) ?? [])
          .sort((left, right) => left.index - right.index)
          .map(({ trackId }) => trackId),
      };
    },
  );
  return { pageSize, tracks, playlists, histories };
}
