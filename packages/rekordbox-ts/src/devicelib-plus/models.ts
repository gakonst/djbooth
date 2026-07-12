import { DatabaseRow, type ModelClass } from "../masterdb/models.js";

/** Device Library Plus playlist attributes. */
export const PlaylistType = { FOLDER: 1, PLAYLIST: 0, SMART_PLAYLIST: 4 } as const;
export type PlaylistType = (typeof PlaylistType)[keyof typeof PlaylistType];

/** Device Library Plus content file types. */
export const FileType = { AIF: 12, AIFF: 12, FLAC: 5, M4A: 4, MP3: 1, WAV: 11 } as const;
export type FileType = (typeof FileType)[keyof typeof FileType];

/** Compatibility base class shared by Device Library Plus models. */
export class Base extends DatabaseRow {}

export class Album extends Base {
  static override tableName = "album";
  declare album_id: number;
  declare name: string;
  declare artist_id: number | null;
  declare image_id: number | null;
  declare isComplation: number | null;
  declare nameForSearch: string | null;
  declare artist: Artist | undefined;
  declare artist_name: string | undefined;
  declare image: Image | undefined;
  declare image_path: string | undefined;
}

export class Artist extends Base {
  static override tableName = "artist";
  declare artist_id: number;
  declare name: string;
  declare nameForSearch: string | null;
}

export class Category extends Base {
  static override tableName = "category";
  declare category_id: number;
  declare menuItem_id: number | null;
  declare sequenceNo: number | null;
  declare isVisible: number | null;
  declare menuItem: MenuItem | undefined;
  declare menuItem_name: string | undefined;
}

export class Color extends Base {
  static override tableName = "color";
  declare color_id: number;
  declare name: string;
}

export class Content extends Base {
  static override tableName = "content";
  declare content_id: number;
  declare title: string | null;
  declare titleForSearch: string | null;
  declare subtitle: string | null;
  declare bpmx100: number | null;
  declare length: number | null;
  declare trackNo: number | null;
  declare discNo: number | null;
  declare artist_id_artist: number | null;
  declare artist_id_remixer: number | null;
  declare artist_id_originalArtist: number | null;
  declare artist_id_composer: number | null;
  declare artist_id_lyricist: number | null;
  declare album_id: number | null;
  declare genre_id: number | null;
  declare label_id: number | null;
  declare key_id: number | null;
  declare color_id: number | null;
  declare image_id: number | null;
  declare djComment: string | null;
  declare rating: number | null;
  declare releaseYear: number | null;
  declare releaseDate: Date | null;
  declare dateCreated: Date | null;
  declare dateAdded: Date | null;
  declare path: string;
  declare fileName: string;
  declare fileSize: number | bigint;
  declare fileType: number;
  declare bitrate: number;
  declare bitDepth: number;
  declare samplingRate: number;
  declare isrc: string | null;
  declare isHotCueAutoLoadOn: number | null;
  declare isKuvoDeliverStatusOn: number | null;
  declare kuvoDeliveryComment: string | null;
  declare masterDbId: number | null;
  declare masterContentId: number | null;
  declare analysisDataFilePath: string | null;
  declare analysedBits: number | null;
  declare contentLink: number | null;
  declare hasModified: number | null;
  declare cueUpdateCount: number | null;
  declare analysisDataUpdateCount: number | null;
  declare informationUpdateCount: number | null;
  declare artist: Artist | undefined;
  declare remixer: Artist | undefined;
  declare originalArtist: Artist | undefined;
  declare composer: Artist | undefined;
  declare lyricist: Artist | undefined;
  declare album: Album | undefined;
  declare genre: Genre | undefined;
  declare label: Label | undefined;
  declare key: Key | undefined;
  declare color: Color | undefined;
  declare image: Image | undefined;
  declare cues: Array<Cue>;
  declare artist_name: string | undefined;
  declare remixer_name: string | undefined;
  declare original_artist_name: string | undefined;
  declare composer_name: string | undefined;
  declare lyricist_name: string | undefined;
  declare album_name: string | undefined;
  declare genre_name: string | undefined;
  declare label_name: string | undefined;
  declare image_path: string | undefined;
}

export class Cue extends Base {
  static override tableName = "cue";
  declare cue_id: number;
  declare content_id: number | null;
  declare kind: number | null;
  declare colorTableIndex: number | null;
  declare cueComment: string | null;
  declare isActiveLoop: number | null;
  declare beatLoopNumerator: number | null;
  declare beatLoopDenominator: number | null;
  declare inUsec: number | null;
  declare outUsec: number | null;
  declare in150FramePerSec: number | null;
  declare out150FramePerSec: number | null;
  declare inMpegFrameNumber: number | null;
  declare outMpegFrameNumber: number | null;
  declare inMpegAbs: number | null;
  declare outMpegAbs: number | null;
  declare inDecodingStartFramePosition: number | null;
  declare outDecodingStartFramePosition: number | null;
  declare inFileOffsetInBlock: number | null;
  declare outFileOffsetInBlock: number | null;
  declare inNumberOfSampleInBlock: number | null;
  declare outNumberOfSampleInBlock: number | null;
  declare content: Content | undefined;
}

export class Genre extends Base {
  static override tableName = "genre";
  declare genre_id: number;
  declare name: string;
}

export class History extends Base {
  static override tableName = "history";
  declare history_id: number;
  declare sequenceNo: number | null;
  declare name: string | null;
  declare attribute: string | null;
  declare history_id_parent: number | null;
  declare children: Array<History>;
  declare parent: History | undefined;
  declare songs: Array<HistoryContent>;
  declare contents: Array<Content>;
}

export class HistoryContent extends Base {
  static override tableName = "history_content";
  declare history_id: number;
  declare content_id: number;
  declare sequenceNo: number | null;
  declare history: History | undefined;
  declare content: Content | undefined;
}

export class HotCueBankList extends Base {
  static override tableName = "hotCueBankList";
  declare hotCueBankList_id: number;
  declare sequenceNo: number | null;
  declare name: string | null;
  declare image_id: number | null;
  declare attribute: number | null;
  declare hotCueBankList_id_parent: number | null;
  declare image: Image | undefined;
  declare children: Array<HotCueBankList>;
  declare parent: HotCueBankList | undefined;
  declare hotCueBankList_cues: Array<HotCueBankListCue>;
}

export class HotCueBankListCue extends Base {
  static override tableName = "hotCueBankList_cue";
  declare hotCueBankList_id: number;
  declare cue_id: number;
  declare sequenceNo: number | null;
  declare hotCueBankList: HotCueBankList | undefined;
  declare cue: Cue | undefined;
}

export class Image extends Base {
  static override tableName = "image";
  declare image_id: number;
  declare path: string;
}

export class Key extends Base {
  static override tableName = "key";
  declare key_id: number;
  declare name: string;
}

export class Label extends Base {
  static override tableName = "label";
  declare label_id: number;
  declare name: string;
}

export class MenuItem extends Base {
  static override tableName = "menuItem";
  declare menuItem_id: number;
  declare kind: number | null;
  declare name: string | null;
}

export class MyTag extends Base {
  static override tableName = "myTag";
  declare myTag_id: number;
  declare sequenceNo: number;
  declare name: string;
  declare attribute: number | null;
  declare myTag_id_parent: number | null;
  declare children: Array<MyTag>;
  declare parent: MyTag | undefined;
  declare myTags: Array<MyTagContent>;
}

export class MyTagContent extends Base {
  static override tableName = "myTag_content";
  declare myTag_id: number;
  declare content_id: number;
  declare myTag: MyTag | undefined;
  declare content: Content | undefined;
}

export class Playlist extends Base {
  static override tableName = "playlist";
  declare playlist_id: number;
  declare sequenceNo: number;
  declare name: string;
  declare image_id: number | null;
  declare attribute: number | null;
  declare playlist_id_parent: number | null;
  declare children: Array<Playlist>;
  declare parent: Playlist | undefined;
  declare songs: Array<PlaylistContent>;
  declare contents: Array<Content>;
  declare image: Image | undefined;
}

export class PlaylistContent extends Base {
  static override tableName = "playlist_content";
  declare playlist_id: number;
  declare content_id: number;
  declare sequenceNo: number;
  declare playlist: Playlist | undefined;
  declare content: Content | undefined;
}

export class Property extends Base {
  static override tableName = "property";
  declare deviceName: string;
  declare dbVersion: number | null;
  declare numberOfContents: number | null;
  declare createdDate: Date;
  declare backGroundColorType: number | null;
  declare myTagMasterDBID: number | null;
}

export class RecommendedLike extends Base {
  static override tableName = "recommendedLike";
  declare content_id_1: number;
  declare content_id_2: number;
  declare rating: number | null;
  declare createdDate: Date;
  declare content_1: Content | undefined;
  declare content_2: Content | undefined;
}

export class Sort extends Base {
  static override tableName = "sort";
  declare sort_id: number;
  declare menuItem_id: number;
  declare sequenceNo: number | null;
  declare isVisible: number | null;
  declare isSelectedAsSubColumn: number | null;
  declare menuItem: MenuItem | undefined;
}

/** Exported upstream model names in compatibility order. */
export const TABLES = [
  "Album",
  "Artist",
  "Category",
  "Color",
  "Content",
  "Cue",
  "Genre",
  "History",
  "HistoryContent",
  "HotCueBankList",
  "HotCueBankListCue",
  "Image",
  "Key",
  "Label",
  "MenuItem",
  "MyTag",
  "MyTagContent",
  "Playlist",
  "PlaylistContent",
  "Property",
  "RecommendedLike",
  "Sort",
] as const;

export const modelClasses = {
  Album,
  Artist,
  Category,
  Color,
  Content,
  Cue,
  Genre,
  History,
  HistoryContent,
  HotCueBankList,
  HotCueBankListCue,
  Image,
  Key,
  Label,
  MenuItem,
  MyTag,
  MyTagContent,
  Playlist,
  PlaylistContent,
  Property,
  RecommendedLike,
  Sort,
} satisfies Record<(typeof TABLES)[number], ModelClass>;

export const modelByTable = Object.fromEntries(
  Object.values(modelClasses).map((model) => [model.tableName, model]),
) as Record<string, ModelClass>;
