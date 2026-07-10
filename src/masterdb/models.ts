import type { MasterDatabase } from "./database.js";

/** Rekordbox playlist row types. */
export const PlaylistType = { FOLDER: 1, PLAYLIST: 0, SMART_PLAYLIST: 4 } as const;
/** Rekordbox playlist row type. */
export type PlaylistType = (typeof PlaylistType)[keyof typeof PlaylistType];

/** Rekordbox content file type values. */
export const FileType = { AIF: 12, AIFF: 12, FLAC: 5, M4A: 4, MP3: 1, WAV: 11 } as const;
/** Rekordbox content file type. */
export type FileType = (typeof FileType)[keyof typeof FileType];

/** Scalar values supported by SQLite rows. */
export type DatabaseValue = string | number | bigint | Buffer | Date | null;
/** Plain row data keyed by physical column name. */
export type RowData = Record<string, DatabaseValue>;

/** Runtime state for a row tracked by {@link MasterDatabase}. */
export type RowState = "deleted" | "existing" | "new";

/** Constructor/static contract for one mapped Rekordbox table. */
export type ModelClass<row extends DatabaseRow = DatabaseRow> = {
  new (database: MasterDatabase, data: RowData, state?: RowState): row;
  tableName: string;
};

/**
 * Dynamic, mutation-tracked row returned by the master database.
 *
 * Physical database columns are available as properties and through `get`/`set`.
 */
export class DatabaseRow {
  static tableName = "";

  /** Owning database. */
  database: MasterDatabase;
  /** Physical table name. */
  tableName: string;
  /** @internal Current column values. */
  data: RowData;
  /** @internal Values at the last commit/query boundary. */
  original: RowData;
  /** @internal Persistence state. */
  state: RowState;
  /** @internal Last data flushed into the open transaction. */
  flushed: RowData | undefined;

  [key: string]: unknown;

  constructor(database: MasterDatabase, data: RowData, state: RowState = "existing") {
    this.database = database;
    this.tableName = (this.constructor as typeof DatabaseRow).tableName;
    this.data = { ...data };
    this.original = { ...data };
    this.state = state;
    this.flushed = undefined;
    return new Proxy(this, {
      get: (target, property, receiver) => {
        if (typeof property !== "string" || property in target)
          return Reflect.get(target, property, receiver);
        if (property in target.data) return target.data[property];
        return target.database.getComputed(target, property);
      },
      set: (target, property, value, receiver) => {
        if (typeof property !== "string" || property in target)
          return Reflect.set(target, property, value, receiver);
        if (target.database.hasColumn(target.tableName, property)) {
          target.database.setRowValue(target, property, value as DatabaseValue);
          return true;
        }
        if (target.database.setComputed(target, property, value)) return true;
        return Reflect.set(target, property, value, receiver);
      },
    });
  }

  /** Return one physical column value. */
  get(key: string): DatabaseValue | undefined {
    return this.data[key];
  }

  /** Set one physical column value. */
  set(key: string, value: DatabaseValue): this {
    if (!this.database.hasColumn(this.tableName, key))
      throw new RangeError(`Column '${key}' does not exist on '${this.tableName}'`);
    this.database.setRowValue(this, key, value);
    return this;
  }

  /** Physical column names. */
  keys(): Array<string> {
    return Object.keys(this.data);
  }

  /** Physical column values. */
  values(): Array<DatabaseValue> {
    return this.keys().map((key) => this.data[key]!);
  }

  /** Physical column entries. */
  entries(): Array<[string, DatabaseValue]> {
    return this.keys().map((key) => [key, this.data[key]!]);
  }

  /** Convert to JSON-safe physical column data. */
  toJSON(): Record<string, unknown> {
    return Object.fromEntries(
      this.entries().map(([key, value]) => [
        key,
        value instanceof Date ? value.toISOString() : value,
      ]),
    );
  }
}

export class AgentRegistry extends DatabaseRow {
  static override tableName = "agentRegistry";
}
export class CloudAgentRegistry extends DatabaseRow {
  static override tableName = "cloudAgentRegistry";
}
export class ContentActiveCensor extends DatabaseRow {
  static override tableName = "contentActiveCensor";
}
export class ContentCue extends DatabaseRow {
  static override tableName = "contentCue";
}
export class ContentFile extends DatabaseRow {
  static override tableName = "contentFile";
}
export class DjmdActiveCensor extends DatabaseRow {
  static override tableName = "djmdActiveCensor";
}
export class DjmdAlbum extends DatabaseRow {
  static override tableName = "djmdAlbum";
  declare ID: string;
  declare Name: string | null;
}
export class DjmdArtist extends DatabaseRow {
  static override tableName = "djmdArtist";
  declare ID: string;
  declare Name: string | null;
}
export class DjmdCategory extends DatabaseRow {
  static override tableName = "djmdCategory";
}
export class DjmdColor extends DatabaseRow {
  static override tableName = "djmdColor";
}
export class DjmdCue extends DatabaseRow {
  static override tableName = "djmdCue";
}
export class DjmdDevice extends DatabaseRow {
  static override tableName = "djmdDevice";
}
export class DjmdGenre extends DatabaseRow {
  static override tableName = "djmdGenre";
  declare ID: string;
  declare Name: string | null;
}
export class DjmdHistory extends DatabaseRow {
  static override tableName = "djmdHistory";
}
export class DjmdHotCueBanklist extends DatabaseRow {
  static override tableName = "djmdHotCueBanklist";
}
export class DjmdKey extends DatabaseRow {
  static override tableName = "djmdKey";
  declare ID: string;
  declare ScaleName: string | null;
}
export class DjmdLabel extends DatabaseRow {
  static override tableName = "djmdLabel";
  declare ID: string;
  declare Name: string | null;
}
export class DjmdMenuItems extends DatabaseRow {
  static override tableName = "djmdMenuItems";
}
export class DjmdMixerParam extends DatabaseRow {
  static override tableName = "djmdMixerParam";
  declare Gain: number;
  declare Peak: number;
}
export class DjmdMyTag extends DatabaseRow {
  static override tableName = "djmdMyTag";
}
export class DjmdProperty extends DatabaseRow {
  static override tableName = "djmdProperty";
}
export class DjmdRelatedTracks extends DatabaseRow {
  static override tableName = "djmdRelatedTracks";
}
export class DjmdSampler extends DatabaseRow {
  static override tableName = "djmdSampler";
}
export class DjmdSongHistory extends DatabaseRow {
  static override tableName = "djmdSongHistory";
}
export class DjmdSongHotCueBanklist extends DatabaseRow {
  static override tableName = "djmdSongHotCueBanklist";
}
export class DjmdSongMyTag extends DatabaseRow {
  static override tableName = "djmdSongMyTag";
}
export class DjmdSongRelatedTracks extends DatabaseRow {
  static override tableName = "djmdSongRelatedTracks";
}
export class DjmdSongSampler extends DatabaseRow {
  static override tableName = "djmdSongSampler";
}
export class DjmdSongTagList extends DatabaseRow {
  static override tableName = "djmdSongTagList";
}
export class DjmdSort extends DatabaseRow {
  static override tableName = "djmdSort";
}
export class HotCueBanklistCue extends DatabaseRow {
  static override tableName = "hotCueBanklistCue";
}
export class ImageFile extends DatabaseRow {
  static override tableName = "imageFile";
}
export class SettingFile extends DatabaseRow {
  static override tableName = "settingFile";
}
export class UuidIDMap extends DatabaseRow {
  static override tableName = "uuidIDMap";
}

/** Track row with common columns declared for TypeScript consumers. */
export class DjmdContent extends DatabaseRow {
  static override tableName = "djmdContent";
  declare ID: string;
  declare Title: string | null;
  declare FolderPath: string | null;
  declare FileNameL: string | null;
  declare ArtistID: string | null;
  declare AlbumID: string | null;
  declare GenreID: string | null;
  declare AnalysisDataPath: string | null;
  declare Artist: DjmdArtist | undefined;
  declare Album: DjmdAlbum | undefined;
  declare Genre: DjmdGenre | undefined;
  declare Key: DjmdKey | undefined;
  declare Label: DjmdLabel | undefined;
}

/** Playlist/folder row with common columns declared for TypeScript consumers. */
export class DjmdPlaylist extends DatabaseRow {
  static override tableName = "djmdPlaylist";
  declare ID: string;
  declare Seq: number;
  declare Name: string;
  declare Attribute: number;
  declare ParentID: string;
  declare SmartList: string | null;
  declare isFolder: boolean;
  declare isPlaylist: boolean;
  declare isSmartPlaylist: boolean;
  declare Songs: Array<DjmdSongPlaylist>;
  declare Children: Array<DjmdPlaylist>;
}

/** Playlist membership row. */
export class DjmdSongPlaylist extends DatabaseRow {
  static override tableName = "djmdSongPlaylist";
  declare ID: string;
  declare PlaylistID: string;
  declare ContentID: string;
  declare TrackNo: number;
  declare Content: DjmdContent;
  declare Playlist: DjmdPlaylist;
}

/** Exported upstream model names in compatibility order. */
export const TABLES = [
  "AgentRegistry",
  "CloudAgentRegistry",
  "ContentActiveCensor",
  "ContentCue",
  "ContentFile",
  "DjmdActiveCensor",
  "DjmdAlbum",
  "DjmdArtist",
  "DjmdCategory",
  "DjmdColor",
  "DjmdContent",
  "DjmdCue",
  "DjmdDevice",
  "DjmdGenre",
  "DjmdHistory",
  "DjmdHotCueBanklist",
  "DjmdKey",
  "DjmdLabel",
  "DjmdMenuItems",
  "DjmdMixerParam",
  "DjmdMyTag",
  "DjmdPlaylist",
  "DjmdProperty",
  "DjmdRelatedTracks",
  "DjmdSampler",
  "DjmdSongHistory",
  "DjmdSongHotCueBanklist",
  "DjmdSongMyTag",
  "DjmdSongPlaylist",
  "DjmdSongRelatedTracks",
  "DjmdSongSampler",
  "DjmdSongTagList",
  "DjmdSort",
  "HotCueBanklistCue",
  "ImageFile",
  "SettingFile",
  "UuidIDMap",
] as const;

/** Model classes keyed by upstream class name. */
export const modelClasses = {
  AgentRegistry,
  CloudAgentRegistry,
  ContentActiveCensor,
  ContentCue,
  ContentFile,
  DjmdActiveCensor,
  DjmdAlbum,
  DjmdArtist,
  DjmdCategory,
  DjmdColor,
  DjmdContent,
  DjmdCue,
  DjmdDevice,
  DjmdGenre,
  DjmdHistory,
  DjmdHotCueBanklist,
  DjmdKey,
  DjmdLabel,
  DjmdMenuItems,
  DjmdMixerParam,
  DjmdMyTag,
  DjmdPlaylist,
  DjmdProperty,
  DjmdRelatedTracks,
  DjmdSampler,
  DjmdSongHistory,
  DjmdSongHotCueBanklist,
  DjmdSongMyTag,
  DjmdSongPlaylist,
  DjmdSongRelatedTracks,
  DjmdSongSampler,
  DjmdSongTagList,
  DjmdSort,
  HotCueBanklistCue,
  ImageFile,
  SettingFile,
  UuidIDMap,
} satisfies Record<(typeof TABLES)[number], ModelClass>;

/** Model classes keyed by physical table name. */
export const modelByTable = Object.fromEntries(
  Object.values(modelClasses).map((model) => [model.tableName, model]),
) as Record<string, ModelClass>;
