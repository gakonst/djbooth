import type { MasterDatabase } from "./database.js";
import type {} from "./model-fields.js";

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

/** Database/session surface required to construct an unattached mapped row. */
export type DatabaseRowFactory = {
  construct<row extends DatabaseRow>(model: ModelClass<row>, values: RowData): row;
};

/**
 * Dynamic, mutation-tracked row returned by the master database.
 *
 * Physical database columns are available as properties and through `get`/`set`.
 */
export class DatabaseRow {
  static tableName = "";

  /** Construct an unattached row, equivalent to pyrekordbox model `create`. */
  static create<row extends DatabaseRow>(
    this: ModelClass<row>,
    database: DatabaseRowFactory,
    values: RowData,
  ): row {
    return database.construct(this, values);
  }

  /** Physical columns for this model in an opened database schema. */
  static columns(this: typeof DatabaseRow, database: MasterDatabase): Array<string> {
    return database.columnNames(this.tableName);
  }

  /** SQLAlchemy-compatible relationship names for this mapped table. */
  static relationships(this: typeof DatabaseRow): Array<string> {
    return [...(relationshipNames[this.tableName] ?? [])];
  }

  /** Physical columns plus relationship names. */
  static keys(this: typeof DatabaseRow, database: MasterDatabase): Array<string> {
    return [...this.columns(database), ...this.relationships()];
  }

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
  /** @internal Whether this row has never been committed to the database. */
  newlyCreated: boolean;
  /** @internal Stable public proxy used by the identity map. */
  proxy!: this;

  [key: string]: unknown;

  constructor(database: MasterDatabase, data: RowData, state: RowState = "existing") {
    this.database = database;
    this.tableName = (this.constructor as typeof DatabaseRow).tableName;
    this.data = { ...data };
    this.original = { ...data };
    this.state = state;
    this.flushed = undefined;
    this.newlyCreated = state === "new";
    const proxy = new Proxy(this, {
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
    Object.defineProperty(this, "proxy", { enumerable: false, value: proxy });
    return proxy;
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

  /** Compatibility alias for physical column names. */
  columns(): Array<string> {
    return this.keys();
  }

  /** Relationship names declared for this row's table. */
  relationships(): Array<string> {
    return [...(relationshipNames[this.tableName] ?? [])];
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

  /** Upstream-compatible plain physical-column dictionary. */
  toDict(): Record<string, unknown> {
    return this.toJSON();
  }

  /** Human-readable table/column representation. */
  pformat(indent = "   "): string {
    const columns = this.columns();
    const width = columns.reduce((maximum, column) => Math.max(maximum, column.length), 0);
    return [
      this.tableName,
      ...columns.map((column) => `${indent}${column.padEnd(width)} ${String(this[column])}`),
    ].join("\n");
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
  declare Content: DjmdContent | undefined;
}
export class ContentCue extends DatabaseRow {
  static override tableName = "contentCue";
  declare Content: DjmdContent | undefined;
}
export class ContentFile extends DatabaseRow {
  static override tableName = "contentFile";
  declare Content: DjmdContent | undefined;
}
export class DjmdActiveCensor extends DatabaseRow {
  static override tableName = "djmdActiveCensor";
  declare Content: DjmdContent | undefined;
}
export class DjmdAlbum extends DatabaseRow {
  static override tableName = "djmdAlbum";
  declare ID: string;
  declare Name: string | null;
  declare AlbumArtist: DjmdArtist | undefined;
  declare AlbumArtistName: string | undefined;
}
export class DjmdArtist extends DatabaseRow {
  static override tableName = "djmdArtist";
  declare ID: string;
  declare Name: string | null;
}
export class DjmdCategory extends DatabaseRow {
  static override tableName = "djmdCategory";
  declare MenuItem: DjmdMenuItems | undefined;
}
export class DjmdColor extends DatabaseRow {
  static override tableName = "djmdColor";
}
export class DjmdCue extends DatabaseRow {
  static override tableName = "djmdCue";
  /** Track that owns this cue. */
  declare Content: DjmdContent | undefined;
  /** Owning track ID. */
  declare ContentID: string | null;
  /** Cue row ID. */
  declare ID: string | null;
  /** Zero for memory cues; otherwise the Hot Cue slot number. */
  declare Kind: number | null;
  /** Whether this row occupies a Hot Cue slot. */
  declare isHotCue: boolean;
  /** Whether this row is a chronological memory cue. */
  declare isMemoryCue: boolean;
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
  declare Songs: Array<DjmdSongHistory>;
  declare Children: Array<DjmdHistory>;
  declare Parent: DjmdHistory | undefined;
}
export class DjmdHotCueBanklist extends DatabaseRow {
  static override tableName = "djmdHotCueBanklist";
  declare Children: Array<DjmdHotCueBanklist>;
  declare Parent: DjmdHotCueBanklist | undefined;
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
  declare MyTags: Array<DjmdSongMyTag>;
  declare Children: Array<DjmdMyTag>;
  declare Parent: DjmdMyTag | undefined;
}
export class DjmdProperty extends DatabaseRow {
  static override tableName = "djmdProperty";
}
export class DjmdRelatedTracks extends DatabaseRow {
  static override tableName = "djmdRelatedTracks";
  declare Songs: Array<DjmdSongRelatedTracks>;
  declare Children: Array<DjmdRelatedTracks>;
  declare Parent: DjmdRelatedTracks | undefined;
}
export class DjmdSampler extends DatabaseRow {
  static override tableName = "djmdSampler";
  declare Songs: Array<DjmdSongSampler>;
  declare Children: Array<DjmdSampler>;
  declare Parent: DjmdSampler | undefined;
}
export class DjmdSongHistory extends DatabaseRow {
  static override tableName = "djmdSongHistory";
  declare History: DjmdHistory | undefined;
  declare Content: DjmdContent | undefined;
}
export class DjmdSongHotCueBanklist extends DatabaseRow {
  static override tableName = "djmdSongHotCueBanklist";
  declare Content: DjmdContent | undefined;
}
export class DjmdSongMyTag extends DatabaseRow {
  static override tableName = "djmdSongMyTag";
  declare MyTagID: string;
  declare MyTag: DjmdMyTag | undefined;
  declare MyTagName: string | undefined;
  declare Content: DjmdContent | undefined;
}
export class DjmdSongRelatedTracks extends DatabaseRow {
  static override tableName = "djmdSongRelatedTracks";
  declare RelatedTracks: DjmdRelatedTracks | undefined;
  declare Content: DjmdContent | undefined;
}
export class DjmdSongSampler extends DatabaseRow {
  static override tableName = "djmdSongSampler";
  declare Sampler: DjmdSampler | undefined;
  declare Content: DjmdContent | undefined;
}
export class DjmdSongTagList extends DatabaseRow {
  static override tableName = "djmdSongTagList";
  declare Content: DjmdContent | undefined;
}
export class DjmdSort extends DatabaseRow {
  static override tableName = "djmdSort";
  declare MenuItem: DjmdMenuItems | undefined;
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
  declare BPM: number | null;
  declare Title: string | null;
  declare FolderPath: string | null;
  declare FileNameL: string | null;
  declare ArtistID: string | null;
  declare AlbumID: string | null;
  declare GenreID: string | null;
  declare KeyID: string | null;
  declare AnalysisDataPath: string | null;
  declare Analysed: number | null;
  declare AnalysisUpdated: string | null;
  declare TrackInfoUpdated: string | null;
  declare Artist: DjmdArtist | undefined;
  declare Album: DjmdAlbum | undefined;
  declare Genre: DjmdGenre | undefined;
  declare Key: DjmdKey | undefined;
  declare Label: DjmdLabel | undefined;
  declare Remixer: DjmdArtist | undefined;
  declare OrgArtist: DjmdArtist | undefined;
  declare Color: DjmdColor | undefined;
  declare Composer: DjmdArtist | undefined;
  declare AlbumArtist: DjmdArtist | undefined;
  declare MyTags: Array<DjmdSongMyTag>;
  declare Cues: Array<DjmdCue>;
  declare ActiveCensors: Array<DjmdActiveCensor>;
  declare MixerParams: Array<DjmdMixerParam>;
  declare ArtistName: string | undefined;
  declare AlbumName: string | undefined;
  declare GenreName: string | undefined;
  declare RemixerName: string | undefined;
  declare LabelName: string | undefined;
  declare OrgArtistName: string | undefined;
  declare KeyName: string | undefined;
  declare ColorName: string | undefined;
  declare ComposerName: string | undefined;
  declare AlbumArtistName: string | undefined;
  declare MyTagNames: Array<string | undefined>;
  declare MyTagIDs: Array<string>;
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

/** Relationship names mirrored from pyrekordbox's SQLAlchemy models. */
export const relationshipNames: Readonly<Record<string, ReadonlyArray<string>>> = {
  album: ["artist", "image"],
  category: ["menuItem"],
  content: [
    "artist",
    "remixer",
    "originalArtist",
    "composer",
    "lyricist",
    "album",
    "genre",
    "label",
    "key",
    "color",
    "image",
    "cues",
  ],
  cue: ["content"],
  history: ["children", "songs"],
  history_content: ["history", "content"],
  hotCueBankList: ["image", "children", "hotCueBankList_cues"],
  hotCueBankList_cue: ["hotCueBankList", "cue"],
  myTag: ["children", "myTags"],
  myTag_content: ["myTag", "content"],
  playlist: ["children", "songs"],
  playlist_content: ["playlist", "content"],
  recommendedLike: ["content_1", "content_2"],
  sort: ["menuItem"],
  contentActiveCensor: ["Content"],
  contentCue: ["Content"],
  contentFile: ["Content"],
  djmdActiveCensor: ["Content"],
  djmdAlbum: ["AlbumArtist"],
  djmdCategory: ["MenuItem"],
  djmdContent: [
    "Artist",
    "Album",
    "Genre",
    "Remixer",
    "Label",
    "OrgArtist",
    "Key",
    "Color",
    "Composer",
    "AlbumArtist",
    "MyTags",
    "Cues",
    "ActiveCensors",
    "MixerParams",
  ],
  djmdCue: ["Content"],
  djmdHistory: ["Songs", "Children", "Parent"],
  djmdHotCueBanklist: ["Children", "Parent"],
  djmdMixerParam: ["Content"],
  djmdMyTag: ["MyTags", "Children", "Parent"],
  djmdPlaylist: ["Songs", "Children", "Parent"],
  djmdRelatedTracks: ["Songs", "Children", "Parent"],
  djmdSampler: ["Songs", "Children", "Parent"],
  djmdSongHistory: ["History", "Content"],
  djmdSongHotCueBanklist: ["Content"],
  djmdSongMyTag: ["MyTag", "Content"],
  djmdSongPlaylist: ["Playlist", "Content"],
  djmdSongRelatedTracks: ["RelatedTracks", "Content"],
  djmdSongSampler: ["Sampler", "Content"],
  djmdSongTagList: ["Content"],
  djmdSort: ["MenuItem"],
};

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
