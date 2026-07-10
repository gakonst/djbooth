import { existsSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import type SQLite from "better-sqlite3-multiple-ciphers";

import {
  MasterDatabase,
  type CommitOptions,
  type DatabaseEventHandler,
  type Query,
} from "../masterdb/database.js";
import type { DatabaseRow, DatabaseValue, ModelClass } from "../masterdb/models.js";
import type { DjmdContent } from "../masterdb/models.js";
import { deobfuscate } from "../utils.js";
import * as models from "./models.js";

/** Obfuscated default key shipped by Rekordbox for Device Library Plus databases. */
export const DEVICE_LIBRARY_PLUS_KEY_BLOB =
  "PN_1dH8$oLJY)16j_RvM6qphWw`476>;C1cWmI#se(PG`j}~xAjlufj?`#0i{;=glh(SkW)y0>n?YEiD`l%t(";

export type DeviceLibraryPlusOptions = {
  allowWhileRunning?: boolean;
  key?: string;
  path: string;
  readonly?: boolean;
  unlock?: boolean;
};

type Filters = Record<string, DatabaseValue>;

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

/** Internal shared SQLite engine with Device Library Plus relationship semantics. */
class DeviceDatabaseEngine extends MasterDatabase {
  private relation<row extends DatabaseRow>(
    model: ModelClass<row>,
    column: string,
    value: DatabaseValue | undefined,
  ): row | undefined {
    return value == null
      ? undefined
      : this.query(model)
          .where({ [column]: value })
          .oneOrNone();
  }

  private relatedRows<row extends DatabaseRow>(
    model: ModelClass<row>,
    filters: Filters,
    order?: string,
  ): Array<row> {
    const query = this.query(model).where(filters);
    return (order && this.hasColumn(model.tableName, order) ? query.orderBy(order) : query).all();
  }

  /** @internal Resolve SQLAlchemy-style relationships and association proxies. */
  override getComputed(row: DatabaseRow, property: string): unknown {
    const named = (relation: unknown, key: string) =>
      relation instanceof models.Base ? relation.get(key) : undefined;

    if (row.tableName === "album") {
      if (property === "artist")
        return this.relation(models.Artist, "artist_id", row.get("artist_id"));
      if (property === "image") return this.relation(models.Image, "image_id", row.get("image_id"));
      if (property === "artist_name") return named(this.getComputed(row, "artist"), "name");
      if (property === "image_path") return named(this.getComputed(row, "image"), "path");
    }
    if (row.tableName === "category") {
      if (property === "menuItem")
        return this.relation(models.MenuItem, "menuItem_id", row.get("menuItem_id"));
      if (property === "menuItem_name") return named(this.getComputed(row, "menuItem"), "name");
    }
    if (row.tableName === "content") {
      const relations: Record<string, [ModelClass, string, string]> = {
        album: [models.Album, "album_id", "album_id"],
        artist: [models.Artist, "artist_id", "artist_id_artist"],
        color: [models.Color, "color_id", "color_id"],
        composer: [models.Artist, "artist_id", "artist_id_composer"],
        genre: [models.Genre, "genre_id", "genre_id"],
        image: [models.Image, "image_id", "image_id"],
        key: [models.Key, "key_id", "key_id"],
        label: [models.Label, "label_id", "label_id"],
        lyricist: [models.Artist, "artist_id", "artist_id_lyricist"],
        originalArtist: [models.Artist, "artist_id", "artist_id_originalArtist"],
        remixer: [models.Artist, "artist_id", "artist_id_remixer"],
      };
      const relation = relations[property];
      if (relation) return this.relation(relation[0], relation[1], row.get(relation[2]));
      if (property === "cues")
        return this.relatedRows(models.Cue, { content_id: row.get("content_id")! }, "cue_id");
      const proxies: Record<string, [string, string]> = {
        album_name: ["album", "name"],
        artist_name: ["artist", "name"],
        composer_name: ["composer", "name"],
        genre_name: ["genre", "name"],
        image_path: ["image", "path"],
        label_name: ["label", "name"],
        lyricist_name: ["lyricist", "name"],
        original_artist_name: ["originalArtist", "name"],
        remixer_name: ["remixer", "name"],
      };
      const proxy = proxies[property];
      if (proxy) return named(this.getComputed(row, proxy[0]), proxy[1]);
    }
    if (row.tableName === "cue" && property === "content")
      return this.relation(models.Content, "content_id", row.get("content_id"));

    const treeRelations: Record<
      string,
      { child: ModelClass; childKey: string; id: string; parent: string }
    > = {
      history: {
        child: models.History,
        childKey: "history_id_parent",
        id: "history_id",
        parent: "history_id_parent",
      },
      hotCueBankList: {
        child: models.HotCueBankList,
        childKey: "hotCueBankList_id_parent",
        id: "hotCueBankList_id",
        parent: "hotCueBankList_id_parent",
      },
      myTag: {
        child: models.MyTag,
        childKey: "myTag_id_parent",
        id: "myTag_id",
        parent: "myTag_id_parent",
      },
      playlist: {
        child: models.Playlist,
        childKey: "playlist_id_parent",
        id: "playlist_id",
        parent: "playlist_id_parent",
      },
    };
    const tree = treeRelations[row.tableName];
    if (tree) {
      if (property === "children")
        return this.relatedRows(tree.child, { [tree.childKey]: row.get(tree.id)! }, "sequenceNo");
      if (property === "parent") return this.relation(tree.child, tree.id, row.get(tree.parent));
    }

    if (row.tableName === "history") {
      if (property === "songs")
        return this.relatedRows(
          models.HistoryContent,
          { history_id: row.get("history_id")! },
          "sequenceNo",
        );
      if (property === "contents")
        return (this.getComputed(row, "songs") as Array<models.HistoryContent>)
          .map((song) => song.content)
          .filter((content): content is models.Content => content !== undefined);
    }
    if (row.tableName === "history_content") {
      if (property === "history")
        return this.relation(models.History, "history_id", row.get("history_id"));
      if (property === "content")
        return this.relation(models.Content, "content_id", row.get("content_id"));
    }
    if (row.tableName === "hotCueBankList") {
      if (property === "image") return this.relation(models.Image, "image_id", row.get("image_id"));
      if (property === "hotCueBankList_cues")
        return this.relatedRows(
          models.HotCueBankListCue,
          { hotCueBankList_id: row.get("hotCueBankList_id")! },
          "sequenceNo",
        );
    }
    if (row.tableName === "hotCueBankList_cue") {
      if (property === "hotCueBankList")
        return this.relation(
          models.HotCueBankList,
          "hotCueBankList_id",
          row.get("hotCueBankList_id"),
        );
      if (property === "cue") return this.relation(models.Cue, "cue_id", row.get("cue_id"));
    }
    if (row.tableName === "myTag" && property === "myTags")
      return this.relatedRows(models.MyTagContent, { myTag_id: row.get("myTag_id")! });
    if (row.tableName === "myTag_content") {
      if (property === "myTag") return this.relation(models.MyTag, "myTag_id", row.get("myTag_id"));
      if (property === "content")
        return this.relation(models.Content, "content_id", row.get("content_id"));
    }
    if (row.tableName === "playlist") {
      if (property === "image") return this.relation(models.Image, "image_id", row.get("image_id"));
      if (property === "songs")
        return this.relatedRows(
          models.PlaylistContent,
          { playlist_id: row.get("playlist_id")! },
          "sequenceNo",
        );
      if (property === "contents")
        return (this.getComputed(row, "songs") as Array<models.PlaylistContent>)
          .map((song) => song.content)
          .filter((content): content is models.Content => content !== undefined);
    }
    if (row.tableName === "playlist_content") {
      if (property === "playlist")
        return this.relation(models.Playlist, "playlist_id", row.get("playlist_id"));
      if (property === "content")
        return this.relation(models.Content, "content_id", row.get("content_id"));
    }
    if (row.tableName === "recommendedLike") {
      if (property === "content_1")
        return this.relation(models.Content, "content_id", row.get("content_id_1"));
      if (property === "content_2")
        return this.relation(models.Content, "content_id", row.get("content_id_2"));
    }
    if (row.tableName === "sort" && property === "menuItem")
      return this.relation(models.MenuItem, "menuItem_id", row.get("menuItem_id"));
    return super.getComputed(row, property);
  }

  /** Commit without master.db USN processing. */
  override commit(options: CommitOptions | boolean = {}): void {
    const normalized = typeof options === "boolean" ? {} : options;
    super.commit({ ...normalized, autoincrement: false });
  }
}

/** Synchronous handler for a Rekordbox `exportLibrary.db` Device Library Plus database. */
export class DeviceLibraryPlus {
  private engine: DeviceDatabaseEngine;

  constructor(path: string, options?: Omit<DeviceLibraryPlusOptions, "path">);
  constructor(options: DeviceLibraryPlusOptions);
  constructor(
    pathOrOptions: string | DeviceLibraryPlusOptions,
    overrides: Omit<DeviceLibraryPlusOptions, "path"> = {},
  ) {
    const supplied =
      typeof pathOrOptions === "string" ? { ...overrides, path: pathOrOptions } : pathOrOptions;
    const unlock = supplied.unlock ?? true;
    if (supplied.key && !supplied.key.startsWith("r8gd"))
      throw new TypeError("The provided Device Library Plus key does not look valid");
    this.engine = new DeviceDatabaseEngine({
      allowWhileRunning: supplied.allowWhileRunning,
      key: unlock ? (supplied.key ?? deobfuscate(DEVICE_LIBRARY_PLUS_KEY_BLOB)) : undefined,
      path: supplied.path,
      readonly: supplied.readonly ?? true,
      unlock,
    });
  }

  /** Native SQLite connection for advanced use. */
  get connection(): SQLite.Database | undefined {
    return this.engine.connection;
  }
  /** Database file path. */
  get path(): string {
    return this.engine.path;
  }
  /** Whether writes are disabled. */
  get readonly(): boolean {
    return this.engine.readonly;
  }
  /** Physical table names. */
  get tableNames(): Array<string> {
    return this.engine.tableNames;
  }

  open(): void {
    this.engine.open();
  }
  close(): void {
    this.engine.close();
  }
  hasTable(table: string): boolean {
    return this.engine.hasTable(table);
  }
  hasColumn(table: string, column: string): boolean {
    return this.engine.hasColumn(table, column);
  }
  registerEvent(identifier: string, callback: DatabaseEventHandler): void {
    this.engine.registerEvent(identifier, callback);
  }
  unregisterEvent(identifier: string): void {
    this.engine.unregisterEvent(identifier);
  }
  withNoAutoflush<result>(callback: () => result): result {
    return this.engine.withNoAutoflush(callback);
  }
  get noAutoflush(): <result>(callback: () => result) => result {
    return this.engine.noAutoflush;
  }

  query<row extends DatabaseRow>(model: ModelClass<row>): Query<row>;
  query(model: string): Query<DatabaseRow>;
  query<row extends DatabaseRow>(model: ModelClass<row> | string): Query<row> {
    return (
      typeof model === "string" ? this.engine.query(model) : this.engine.query(model)
    ) as Query<row>;
  }

  create<row extends DatabaseRow>(model: ModelClass<row>, values: Filters): row {
    return this.engine.create(model, values);
  }
  add(row: DatabaseRow): void {
    this.engine.add(row);
  }
  delete(row: DatabaseRow): void {
    this.engine.delete(row);
  }
  flush(): void {
    this.engine.flush();
  }
  rollback(): void {
    this.engine.rollback();
  }
  commit(options: CommitOptions | boolean = {}): void {
    this.engine.commit(options);
  }
  async copyUnlocked(output: string): Promise<void> {
    await this.engine.copyUnlocked(output);
  }

  private getMapped<row extends DatabaseRow>(
    model: ModelClass<row>,
    idColumn: string | undefined,
    filters: Filters,
  ): Query<row> | row | undefined {
    const normalized = { ...filters };
    if (idColumn && "id" in normalized) {
      normalized[idColumn] = normalized.id!;
      delete normalized.id;
    }
    const query = this.query(model).where(normalized);
    return idColumn && idColumn in normalized ? query.oneOrNone() : query;
  }

  getAlbum(filters: Filters = {}) {
    return this.getMapped(models.Album, "album_id", filters);
  }
  getArtist(filters: Filters = {}) {
    return this.getMapped(models.Artist, "artist_id", filters);
  }
  getCategory(filters: Filters = {}) {
    return this.getMapped(models.Category, "category_id", filters);
  }
  getColor(filters: Filters = {}) {
    return this.getMapped(models.Color, "color_id", filters);
  }
  getContent(filters: Filters = {}) {
    return this.getMapped(models.Content, "content_id", filters);
  }
  getCue(filters: Filters = {}) {
    return this.getMapped(models.Cue, "cue_id", filters);
  }
  getGenre(filters: Filters = {}) {
    return this.getMapped(models.Genre, "genre_id", filters);
  }
  getHistory(filters: Filters = {}) {
    return this.getMapped(models.History, "history_id", filters);
  }
  getHistoryContent(filters: Filters = {}) {
    return this.query(models.HistoryContent).where(filters);
  }
  getHotCueBanklist(filters: Filters = {}) {
    return this.getMapped(models.HotCueBankList, "hotCueBankList_id", filters);
  }
  getHotCueBanklistCue(filters: Filters = {}) {
    return this.query(models.HotCueBankListCue).where(filters);
  }
  getImage(filters: Filters = {}) {
    return this.getMapped(models.Image, "image_id", filters);
  }
  getKey(filters: Filters = {}) {
    return this.getMapped(models.Key, "key_id", filters);
  }
  getLabel(filters: Filters = {}) {
    return this.getMapped(models.Label, "label_id", filters);
  }
  getMenuItem(filters: Filters = {}) {
    return this.getMapped(models.MenuItem, "menuItem_id", filters);
  }
  getMyTag(filters: Filters = {}) {
    return this.getMapped(models.MyTag, "myTag_id", filters);
  }
  getMyTagContent(filters: Filters = {}) {
    return this.query(models.MyTagContent).where(filters);
  }
  getPlaylist(filters: Filters = {}) {
    return this.getMapped(models.Playlist, "playlist_id", filters);
  }
  getPlaylistContent(filters: Filters = {}) {
    return this.query(models.PlaylistContent).where(filters);
  }
  getProperty(filters: Filters = {}) {
    return this.query(models.Property).where(filters);
  }
  getRecommendedLike(filters: Filters = {}) {
    return this.query(models.RecommendedLike).where(filters);
  }
  getSort(filters: Filters = {}) {
    return this.getMapped(models.Sort, "sort_id", filters);
  }

  /** Search Device Library Plus content and its descriptive relations. */
  searchContent(text: string): Array<models.Content> {
    const pattern = `%${escapeLike(text)}%`;
    return this.query(models.Content)
      .whereRaw(
        `("title" LIKE ? ESCAPE '\\' OR "titleForSearch" LIKE ? ESCAPE '\\'
          OR "djComment" LIKE ? ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM "artist" WHERE "artist_id" = "content"."artist_id_artist" AND "name" LIKE ? ESCAPE '\\')
          OR EXISTS (SELECT 1 FROM "album" WHERE "album_id" = "content"."album_id" AND "name" LIKE ? ESCAPE '\\')
          OR EXISTS (SELECT 1 FROM "genre" WHERE "genre_id" = "content"."genre_id" AND "name" LIKE ? ESCAPE '\\')
          OR EXISTS (SELECT 1 FROM "key" WHERE "key_id" = "content"."key_id" AND "name" LIKE ? ESCAPE '\\'))`,
        Array(7).fill(pattern),
      )
      .orderBy("content_id")
      .all();
  }

  private createAndFlush<row extends DatabaseRow>(model: ModelClass<row>, values: Filters): row {
    const row = this.create(model, values);
    this.flush();
    return row;
  }

  addAlbum(
    name: string,
    options: {
      artistId?: number;
      imageId?: number;
      isCompilation?: boolean;
      searchString?: string;
    } = {},
  ): models.Album {
    return this.createAndFlush(models.Album, {
      artist_id: options.artistId ?? null,
      image_id: options.imageId ?? null,
      isComplation: Number(options.isCompilation ?? false),
      name,
      nameForSearch: options.searchString ?? "",
    });
  }

  addArtist(name: string, searchString = ""): models.Artist {
    return this.createAndFlush(models.Artist, { name, nameForSearch: searchString });
  }

  addCategory(menuItemId: number, sequenceNo: number, isVisible = true): models.Category {
    return this.createAndFlush(models.Category, {
      isVisible: Number(isVisible),
      menuItem_id: menuItemId,
      sequenceNo,
    });
  }

  addColor(name: string): models.Color {
    return this.createAndFlush(models.Color, { name });
  }

  addContent(
    path: string,
    fileType: models.FileType | number,
    options: {
      analysisPath?: string;
      bitDepth?: number;
      bitrate?: number;
      samplingRate?: number;
      values?: Filters;
    } = {},
  ): models.Content {
    if (!existsSync(path) || !statSync(path).isFile())
      throw new TypeError(`Content file '${path}' does not exist`);
    if (this.query(models.Content).where({ path }).count())
      throw new Error(`Track with path '${path}' already exists in database`);
    const now = new Date();
    return this.createAndFlush(models.Content, {
      analysisDataFilePath: options.analysisPath ?? null,
      analysisDataUpdateCount: 0,
      bitDepth: options.bitDepth ?? 0,
      bitrate: options.bitrate ?? 0,
      cueUpdateCount: 0,
      dateAdded: now,
      dateCreated: now,
      fileName: basename(path),
      fileSize: statSync(path).size,
      fileType,
      hasModified: 0,
      informationUpdateCount: 0,
      path,
      samplingRate: options.samplingRate ?? 0,
      ...options.values,
    });
  }

  addContentFromDb(path: string, source: DjmdContent): models.Content {
    return this.addContent(path, Number(source.get("FileType")), {
      bitDepth: Number(source.get("BitDepth") ?? 0),
      bitrate: Number(source.get("BitRate") ?? 0),
      samplingRate: Number(source.get("SampleRate") ?? 0),
      values: {
        album_id: null,
        analysedBits: null,
        artist_id_artist: null,
        artist_id_composer: null,
        artist_id_lyricist: null,
        artist_id_originalArtist: null,
        artist_id_remixer: null,
        bpmx100: source.get("BPM") ?? null,
        color_id: null,
        contentLink: source.get("ContentLink") ?? null,
        dateAdded: source.get("created_at") ?? new Date(),
        discNo: source.get("DiscNo") ?? null,
        djComment: source.get("Commnt") ?? null,
        genre_id: null,
        image_id: null,
        isHotCueAutoLoadOn: source.get("HotCueAutoLoad") ?? null,
        isKuvoDeliverStatusOn: null,
        isrc: source.get("ISRC") ?? null,
        key_id: null,
        kuvoDeliveryComment: null,
        label_id: null,
        length: source.get("Length") ?? null,
        masterContentId: null,
        masterDbId: Number(source.get("ID")),
        rating: source.get("Rating") ?? null,
        releaseDate: source.get("ReleaseDate") ?? null,
        releaseYear: source.get("ReleaseYear") ?? null,
        subtitle: source.get("Subtitle") ?? null,
        title: source.get("Title") ?? null,
        trackNo: source.get("TrackNo") ?? null,
      },
    });
  }

  addGenre(name: string): models.Genre {
    return this.createAndFlush(models.Genre, { name });
  }
  addImage(path: string): models.Image {
    return this.createAndFlush(models.Image, { path });
  }
  addKey(name: string): models.Key {
    return this.createAndFlush(models.Key, { name });
  }
  addLabel(name: string): models.Label {
    return this.createAndFlush(models.Label, { name });
  }
  addMenuItem(kind: number, name: string): models.MenuItem {
    return this.createAndFlush(models.MenuItem, { kind, name });
  }

  addMyTag(
    name: string,
    options: { attribute?: number; parentId?: number; sequenceNo?: number } = {},
  ): models.MyTag {
    const parentId = options.parentId ?? 0;
    const sequenceNo =
      options.sequenceNo ??
      this.query(models.MyTag).where({ myTag_id_parent: parentId }).count() + 1;
    return this.createAndFlush(models.MyTag, {
      attribute: options.attribute ?? 0,
      myTag_id_parent: parentId,
      name,
      sequenceNo,
    });
  }

  addMyTagContent(myTagId: number, contentId: number): models.MyTagContent {
    return this.createAndFlush(models.MyTagContent, {
      content_id: contentId,
      myTag_id: myTagId,
    });
  }

  private addPlaylistRow(
    name: string,
    attribute: models.PlaylistType,
    options: { imageId?: number; parentId?: number; sequenceNo?: number } = {},
  ): models.Playlist {
    const parentId = options.parentId ?? 0;
    const sequenceNo =
      options.sequenceNo ??
      this.query(models.Playlist).where({ playlist_id_parent: parentId }).count() + 1;
    return this.createAndFlush(models.Playlist, {
      attribute,
      image_id: options.imageId ?? null,
      name,
      playlist_id_parent: parentId,
      sequenceNo,
    });
  }

  addPlaylist(
    name: string,
    options: { imageId?: number; parentId?: number; sequenceNo?: number } = {},
  ): models.Playlist {
    return this.addPlaylistRow(name, models.PlaylistType.PLAYLIST, options);
  }

  addPlaylistFolder(
    name: string,
    options: { parentId?: number; sequenceNo?: number } = {},
  ): models.Playlist {
    return this.addPlaylistRow(name, models.PlaylistType.FOLDER, options);
  }

  addPlaylistContent(
    playlistId: number,
    contentId: number,
    sequenceNo?: number,
  ): models.PlaylistContent {
    const sequence =
      sequenceNo ??
      this.query(models.PlaylistContent).where({ playlist_id: playlistId }).count() + 1;
    return this.createAndFlush(models.PlaylistContent, {
      content_id: contentId,
      playlist_id: playlistId,
      sequenceNo: sequence,
    });
  }

  addProperty(
    myTagMasterDbId: number,
    options: { backgroundColorType?: number; databaseVersion?: number; deviceName?: string } = {},
  ): models.Property {
    return this.createAndFlush(models.Property, {
      backGroundColorType: options.backgroundColorType ?? 0,
      createdDate: new Date(),
      dbVersion: options.databaseVersion ?? 1000,
      deviceName: options.deviceName ?? "",
      myTagMasterDBID: myTagMasterDbId,
      numberOfContents: 0,
    });
  }

  updateContentCount(): void {
    const property = this.query(models.Property).oneOrNone();
    if (!property) throw new Error("No property entry found in the database");
    property.numberOfContents = this.query(models.Content).count();
  }

  addRecommendedLike(
    firstContentId: number,
    secondContentId: number,
    rating: number,
  ): models.RecommendedLike {
    return this.createAndFlush(models.RecommendedLike, {
      content_id_1: firstContentId,
      content_id_2: secondContentId,
      createdDate: new Date(),
      rating,
    });
  }

  addSort(
    menuItemId: number,
    sequenceNo: number,
    options: { isSelectedAsColumn?: boolean; isVisible?: boolean } = {},
  ): models.Sort {
    return this.createAndFlush(models.Sort, {
      isSelectedAsSubColumn: Number(options.isSelectedAsColumn ?? false),
      isVisible: Number(options.isVisible ?? true),
      menuItem_id: menuItemId,
      sequenceNo,
    });
  }

  /** Convert all mapped Device Library Plus tables to plain objects. */
  toObject(): Record<string, Array<Record<string, unknown>>> {
    return Object.fromEntries(
      models.TABLES.filter((name) => this.hasTable(models.modelClasses[name].tableName)).map(
        (name) => [
          name,
          this.query(models.modelClasses[name] as ModelClass)
            .all()
            .map((row) => row.toJSON()),
        ],
      ),
    );
  }

  /** Upstream-compatible alias for {@link toObject}. */
  toDict(): Record<string, Array<Record<string, unknown>>> {
    return this.toObject();
  }

  toJson(path: string, options: { indent?: number } = {}): void {
    writeFileSync(path, `${JSON.stringify(this.toObject(), null, options.indent ?? 2)}\n`, "utf8");
  }
}
