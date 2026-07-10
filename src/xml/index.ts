import { readFileSync, writeFileSync } from "node:fs";
import { normalize } from "node:path";

import { XMLBuilder, XMLParser } from "fast-xml-parser";

const urlPrefix = "file://localhost/";
const positionMarkTypes = ["cue", "fadein", "fadeout", "load", "loop"] as const;
const ratings = [0, 51, 102, 153, 204, 255] as const;
const nodeKeyTypes = ["TrackID", "Location"] as const;

type OrderedNode = {
  ":@"?: Record<string, string>;
  [key: string]: unknown;
};

type Converter = (value: unknown) => unknown;

function tagOf(node: OrderedNode): string {
  const tag = Object.keys(node).find((key) => key !== ":@");
  if (!tag) throw new TypeError("Invalid ordered XML node");
  return tag;
}

function childrenOf(node: OrderedNode): Array<OrderedNode> {
  const children = node[tagOf(node)];
  return Array.isArray(children) ? (children as Array<OrderedNode>) : [];
}

function attributesOf(node: OrderedNode): Record<string, string> {
  if (!node[":@"]) node[":@"] = {};
  return node[":@"]!;
}

function createElement(tag: string, attributes: Record<string, string> = {}): OrderedNode {
  return { [tag]: [], ":@": { ...attributes } };
}

function appendElement(
  parent: OrderedNode,
  tag: string,
  attributes: Record<string, string> = {},
): OrderedNode {
  const element = createElement(tag, attributes);
  childrenOf(parent).push(element);
  return element;
}

function directChildren(parent: OrderedNode, tag: string): Array<OrderedNode> {
  return childrenOf(parent).filter((child) => tagOf(child) === tag);
}

function descendants(parent: OrderedNode, tag: string): Array<OrderedNode> {
  const matches: Array<OrderedNode> = [];
  for (const child of childrenOf(parent)) {
    if (tagOf(child) === tag) matches.push(child);
    matches.push(...descendants(child, tag));
  }
  return matches;
}

function directChild(parent: OrderedNode, tag: string): OrderedNode | undefined {
  return directChildren(parent, tag)[0];
}

function removeElement(parent: OrderedNode, element: OrderedNode): void {
  const children = childrenOf(parent);
  const index = children.indexOf(element);
  if (index === -1) throw new Error(`XML element '${tagOf(element)}' is not a direct child`);
  children.splice(index, 1);
}

function percentEncodePath(path: string): string {
  const bytes = Buffer.from(path, "utf8");
  let encoded = "";
  for (const byte of bytes) {
    const isAlphaNumeric =
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a);
    const isSafe = [0x2d, 0x2e, 0x2f, 0x3a, 0x5c, 0x5f, 0x7e].includes(byte);
    encoded +=
      isAlphaNumeric || isSafe
        ? String.fromCharCode(byte)
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

/** Encode a filesystem path as a Rekordbox XML file URL. */
export function encodePath(path: string): string {
  return urlPrefix + percentEncodePath(path).replaceAll("\\", "/");
}

/** Decode a Rekordbox XML file URL into a normalized filesystem path. */
export function decodePath(url: string): string {
  return normalize(decodeURIComponent(url).replace(urlPrefix, ""));
}

/** Error thrown when an XML element has not been initialized. */
export class XmlElementNotInitializedError extends Error {
  override name = "XmlElementNotInitializedError";

  constructor(elementName: string) {
    super(`XML element ${elementName} is not initialized!`);
  }
}

/** Error thrown when the root playlist folder is missing. */
export class RootNodeNotInitializedError extends Error {
  override name = "RootNodeNotInitializedError";

  constructor() {
    super("Playlist root node is not initialized!");
  }
}

/** Error thrown when a collection already contains a track key. */
export class XmlDuplicateError extends Error {
  override name = "XmlDuplicateError";

  constructor(keyType: string, key: string | number) {
    super(`XML database already contains a track with ${keyType}=${key}`);
  }
}

/** Error thrown when an attribute is not valid for an XML domain element. */
export class XmlAttributeKeyError extends Error {
  override name = "XmlAttributeKeyError";

  constructor(className: string, key: string, attributes: Array<string>) {
    super(
      `${key} is not a valid key for ${className}! Valid attributes:\n${attributes.join(", ")}`,
    );
  }
}

/** Base class for typed Rekordbox XML elements. */
export abstract class AbstractElement {
  static TAG = "";
  static ATTRIBS: Array<string> = [];
  static GETTERS: Record<string, Converter> = {};
  static SETTERS: Record<string, Converter> = {};

  /** @internal Raw ordered XML element. */
  element: OrderedNode;

  protected constructor(element: OrderedNode) {
    this.element = element;
    const constructor = this.constructor as typeof AbstractElement;
    for (const key of constructor.ATTRIBS) {
      if (key in this) continue;
      Object.defineProperty(this, key, {
        configurable: true,
        enumerable: true,
        get: () => this.get(key),
        set: (value: unknown) => this.set(key, value),
      });
    }
  }

  /** Return a converted XML attribute value. */
  get(key: string, defaultValue?: unknown): unknown {
    const constructor = this.constructor as typeof AbstractElement;
    if (!constructor.ATTRIBS.includes(key))
      throw new XmlAttributeKeyError(constructor.name, key, constructor.ATTRIBS);
    const value = attributesOf(this.element)[key];
    if (value === undefined) return defaultValue;
    return constructor.GETTERS[key]?.(value) ?? value;
  }

  /** Set an XML attribute, applying the element's type conversion. */
  set(key: string, value: unknown): void {
    const constructor = this.constructor as typeof AbstractElement;
    if (!constructor.ATTRIBS.includes(key))
      throw new XmlAttributeKeyError(constructor.name, key, constructor.ATTRIBS);
    if (value === undefined || value === null) {
      delete attributesOf(this.element)[key];
      return;
    }
    const converted = constructor.SETTERS[key]?.(value) ?? String(value);
    if (converted === undefined)
      throw new TypeError(`Unsupported ${constructor.name}.${key} value '${String(value)}'`);
    attributesOf(this.element)[key] = String(converted);
  }

  /** Return the number of present XML attributes. */
  get size(): number {
    return Object.keys(attributesOf(this.element)).length;
  }

  /** Return present attribute names. */
  keys(): Array<string> {
    return Object.keys(attributesOf(this.element));
  }

  /** Convert present attributes to a plain object. */
  toJSON(): Record<string, unknown> {
    return Object.fromEntries(this.keys().map((key) => [key, this.get(key)]));
  }
}

/** Attributes accepted by a `TEMPO` beat-grid element. */
export type TempoAttributes = {
  Battito: number;
  Bpm: number;
  Inizio: number;
  Metro: string;
};

/** Beat-grid item in a Rekordbox XML track. */
export class Tempo extends AbstractElement {
  static override TAG = "TEMPO";
  static override ATTRIBS = ["Inizio", "Bpm", "Metro", "Battito"];
  static override GETTERS = {
    Battito: (value: unknown) => Number.parseInt(String(value), 10),
    Bpm: Number,
    Inizio: Number,
  };

  declare Battito: number;
  declare Bpm: number;
  declare Inizio: number;
  declare Metro: string;

  /** @internal Construct a wrapper around an ordered XML element. */
  constructor(element: OrderedNode) {
    super(element);
  }

  /** @internal Create and append a beat-grid item. */
  static create(parent: OrderedNode, attributes: TempoAttributes): Tempo {
    return new Tempo(
      appendElement(
        parent,
        Tempo.TAG,
        Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, String(value)])),
      ),
    );
  }
}

/** Supported XML position-mark type. */
export type PositionMarkType = (typeof positionMarkTypes)[number];

/** Cue, loop, fade, or load marker in a Rekordbox XML track. */
export class PositionMark extends AbstractElement {
  static override TAG = "POSITION_MARK";
  static override ATTRIBS = ["Name", "Type", "Start", "End", "Num"];
  static override GETTERS = {
    End: Number,
    Num: (value: unknown) => Number.parseInt(String(value), 10),
    Start: Number,
    Type: (value: unknown) => positionMarkTypes[Number.parseInt(String(value), 10)],
  };
  static override SETTERS = {
    Type: (value: unknown) => {
      const index = positionMarkTypes.indexOf(value as PositionMarkType);
      return index === -1 ? undefined : index;
    },
  };

  declare End: number | undefined;
  declare Name: string;
  declare Num: number;
  declare Start: number;
  declare Type: PositionMarkType;

  /** @internal Construct a wrapper around an ordered XML element. */
  constructor(element: OrderedNode) {
    super(element);
  }

  /** @internal Create and append a position marker. */
  static create(
    parent: OrderedNode,
    name = "",
    type: PositionMarkType = "cue",
    start = 0,
    end: number | undefined = undefined,
    num = -1,
  ): PositionMark {
    if (!positionMarkTypes.includes(type)) throw new TypeError(`Type '${type}' is not supported!`);
    const attributes: Record<string, string> = {
      Name: name,
      Num: String(num),
      Start: String(start),
      Type: String(positionMarkTypes.indexOf(type)),
    };
    if (end !== undefined) attributes.End = String(end);
    return new PositionMark(appendElement(parent, PositionMark.TAG, attributes));
  }
}

/** All standard attributes on a Rekordbox XML track. */
export type TrackAttributes = {
  Album?: string;
  Artist?: string;
  AverageBpm?: number;
  BitRate?: number;
  Colour?: string;
  Comments?: string;
  Composer?: string;
  DateAdded?: string;
  DateModified?: string;
  DiscNumber?: number;
  Genre?: string;
  Grouping?: string;
  Kind?: string;
  Label?: string;
  LastPlayed?: string;
  Mix?: string;
  Name?: string;
  PlayCount?: number;
  Rating?: number;
  Remixer?: string;
  SampleRate?: number;
  Size?: number;
  Tonality?: string;
  TotalTime?: number;
  TrackID?: number;
  TrackNumber?: number;
  Year?: number;
};

/** Track metadata and analysis elements in a Rekordbox XML collection. */
export class Track extends AbstractElement {
  static override TAG = "TRACK";
  static override ATTRIBS = [
    "TrackID",
    "Name",
    "Artist",
    "Composer",
    "Album",
    "Grouping",
    "Genre",
    "Kind",
    "Size",
    "TotalTime",
    "DiscNumber",
    "TrackNumber",
    "Year",
    "AverageBpm",
    "DateModified",
    "DateAdded",
    "BitRate",
    "SampleRate",
    "Comments",
    "PlayCount",
    "LastPlayed",
    "Rating",
    "Location",
    "Remixer",
    "Tonality",
    "Label",
    "Mix",
    "Colour",
  ];
  static override GETTERS = Object.fromEntries([
    ...[
      "TrackID",
      "Size",
      "TotalTime",
      "DiscNumber",
      "TrackNumber",
      "Year",
      "BitRate",
      "PlayCount",
    ].map((key) => [key, (value: unknown) => Number.parseInt(String(value), 10)]),
    ...["AverageBpm", "SampleRate"].map((key) => [key, Number]),
    ["Rating", (value: unknown) => ratings.indexOf(Number(value) as (typeof ratings)[number])],
    ["Location", (value: unknown) => decodePath(String(value))],
  ]);
  static override SETTERS = {
    Location: (value: unknown) => encodePath(String(value)),
    Rating: (value: unknown) => {
      const rating = Number(value);
      return Number.isInteger(rating) && rating >= 0 && rating <= 5 ? ratings[rating] : undefined;
    },
  };

  declare Album: string | undefined;
  declare Artist: string | undefined;
  declare AverageBpm: number | undefined;
  declare BitRate: number | undefined;
  declare Colour: string | undefined;
  declare Comments: string | undefined;
  declare Composer: string | undefined;
  declare DateAdded: string | undefined;
  declare DateModified: string | undefined;
  declare DiscNumber: number | undefined;
  declare Genre: string | undefined;
  declare Grouping: string | undefined;
  declare Kind: string | undefined;
  declare Label: string | undefined;
  declare LastPlayed: string | undefined;
  declare Location: string;
  declare Mix: string | undefined;
  declare Name: string | undefined;
  declare PlayCount: number | undefined;
  declare Rating: number | undefined;
  declare Remixer: string | undefined;
  declare SampleRate: number | undefined;
  declare Size: number | undefined;
  declare Tonality: string | undefined;
  declare TotalTime: number | undefined;
  declare TrackID: number;
  declare TrackNumber: number | undefined;
  declare Year: number | undefined;

  tempos: Array<Tempo>;
  marks: Array<PositionMark>;

  /** @internal Construct a wrapper around an ordered XML element. */
  constructor(element: OrderedNode) {
    super(element);
    this.tempos = directChildren(element, Tempo.TAG).map((child) => new Tempo(child));
    this.marks = descendants(element, PositionMark.TAG).map((child) => new PositionMark(child));
  }

  /** @internal Create and append a collection track. */
  static create(parent: OrderedNode, location: string, attributes: TrackAttributes = {}): Track {
    const track = new Track(appendElement(parent, Track.TAG, { Location: encodePath(location) }));
    for (const [key, value] of Object.entries(attributes)) track.set(key, value);
    return track;
  }

  /** Append a tempo/beat-grid element. */
  addTempo(inizio: number, bpm: number, metro = "4/4", battito = 1): Tempo {
    const tempo = Tempo.create(this.element, {
      Battito: battito,
      Bpm: bpm,
      Inizio: inizio,
      Metro: metro,
    });
    this.tempos.push(tempo);
    return tempo;
  }

  /** Append a cue, loop, fade, or load marker. */
  addMark(
    name = "",
    type: PositionMarkType = "cue",
    start = 0,
    end: number | undefined = undefined,
    num = -1,
  ): PositionMark {
    const mark = PositionMark.create(this.element, name, type, start, end, num);
    this.marks.push(mark);
    return mark;
  }

  /** Convert track metadata and nested analysis elements to JSON. */
  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), marks: this.marks, tempos: this.tempos };
  }
}

/** Playlist key representation in Rekordbox XML. */
export type NodeKeyType = (typeof nodeKeyTypes)[number];

/** Playlist folder or playlist in a Rekordbox XML document. */
export class Node {
  static TAG = "NODE";
  static FOLDER = 0;
  static PLAYLIST = 1;

  /** @internal Raw ordered XML element. */
  element: OrderedNode;
  /** @internal Raw ordered XML parent. */
  parentElement: OrderedNode | undefined;

  /** @internal Construct a wrapper around a playlist node. */
  constructor(element: OrderedNode, parent?: OrderedNode) {
    this.element = element;
    this.parentElement = parent;
  }

  /** @internal Create and append a folder node. */
  static folder(parent: OrderedNode, name: string): Node {
    return new Node(
      appendElement(parent, Node.TAG, { Count: "0", Name: name, Type: String(Node.FOLDER) }),
      parent,
    );
  }

  /** @internal Create and append a playlist node. */
  static playlist(parent: OrderedNode, name: string, keyType: NodeKeyType = "TrackID"): Node {
    const keyIndex = nodeKeyTypes.indexOf(keyType);
    if (keyIndex === -1) throw new TypeError(`Key type '${keyType}' is not supported!`);
    return new Node(
      appendElement(parent, Node.TAG, {
        Entries: "0",
        KeyType: String(keyIndex),
        Name: name,
        Type: String(Node.PLAYLIST),
      }),
      parent,
    );
  }

  /** Node name. */
  get name(): string {
    const name = attributesOf(this.element).Name;
    if (name === undefined) throw new TypeError("Name attribute has no value");
    return name;
  }

  /** Node type (`0` folder or `1` playlist). */
  get type(): number {
    const type = attributesOf(this.element).Type;
    if (type === undefined) throw new TypeError("Type attribute has no value");
    return Number.parseInt(type, 10);
  }

  /** Number of children in a folder. */
  get count(): number {
    return Number.parseInt(attributesOf(this.element).Count ?? "0", 10);
  }

  /** Number of tracks in a playlist. */
  get entries(): number {
    return Number.parseInt(attributesOf(this.element).Entries ?? "0", 10);
  }

  /** Track key type used by a playlist. */
  get keyType(): NodeKeyType {
    const keyType = nodeKeyTypes[Number.parseInt(attributesOf(this.element).KeyType ?? "0", 10)];
    if (!keyType) throw new TypeError("Invalid playlist KeyType");
    return keyType;
  }

  /** Whether this node is a playlist folder. */
  get isFolder(): boolean {
    return this.type === Node.FOLDER;
  }

  /** Whether this node is a playlist. */
  get isPlaylist(): boolean {
    return this.type === Node.PLAYLIST;
  }

  private updateCount(): void {
    attributesOf(this.element).Count = String(directChildren(this.element, Node.TAG).length);
  }

  private updateEntries(): void {
    attributesOf(this.element).Entries = String(directChildren(this.element, Track.TAG).length);
  }

  /** Return a child node by zero-based index. */
  getNode(index: number): Node {
    const element = directChildren(this.element, Node.TAG)[index];
    if (!element) throw new RangeError(`Playlist node index ${index} is out of range`);
    return new Node(element, this.element);
  }

  /** Return the first descendant node with a given name. */
  getPlaylist(name: string): Node {
    const element = descendants(this.element, Node.TAG).find(
      (candidate) => attributesOf(candidate).Name === name,
    );
    if (!element) throw new Error(`Playlist '${name}' not found below '${this.name}'`);
    const parent = this.findParent(element) ?? this.element;
    return new Node(element, parent);
  }

  private findParent(target: OrderedNode): OrderedNode | undefined {
    for (const child of directChildren(this.element, Node.TAG)) {
      if (child === target) return this.element;
      const parent = new Node(child, this.element).findParent(target);
      if (parent) return parent;
    }
    return undefined;
  }

  /** Return direct child playlist/folder nodes. */
  getPlaylists(): Array<Node> {
    return directChildren(this.element, Node.TAG).map((child) => new Node(child, this.element));
  }

  /** Add a child playlist folder. */
  addPlaylistFolder(name: string): Node {
    if (this.isPlaylist) throw new TypeError("Sub-elements can only be added to a folder node!");
    const node = Node.folder(this.element, name);
    this.updateCount();
    return node;
  }

  /** Add a child playlist. */
  addPlaylist(name: string, keyType: NodeKeyType = "TrackID"): Node {
    if (this.isPlaylist) throw new TypeError("Sub-elements can only be added to a folder node!");
    const node = Node.playlist(this.element, name, keyType);
    this.updateCount();
    return node;
  }

  /** Remove a child playlist or folder by name. */
  removePlaylist(name: string): void {
    const node = this.getPlaylist(name);
    if (!node.parentElement) throw new RootNodeNotInitializedError();
    removeElement(node.parentElement, node.element);
    if (node.parentElement === this.element) this.updateCount();
  }

  /** Add a track key to a playlist. */
  addTrack(key: number | string): void {
    if (!this.isPlaylist) throw new TypeError("Tracks can only be added to a playlist node!");
    appendElement(this.element, Track.TAG, { Key: String(key) });
    this.updateEntries();
  }

  /** Remove a track key from a playlist. */
  removeTrack(key: number | string): void {
    const element = directChildren(this.element, Track.TAG).find(
      (candidate) => attributesOf(candidate).Key === String(key),
    );
    if (!element) throw new Error(`Track key ${key} not found.`);
    removeElement(this.element, element);
    this.updateEntries();
  }

  /** Return all track keys in a playlist. */
  getTracks(): Array<number | string> {
    if (this.isFolder) return [];
    return directChildren(this.element, Track.TAG).map((element) => {
      const key = attributesOf(element).Key ?? "";
      return this.keyType === "TrackID" ? Number.parseInt(key, 10) : key;
    });
  }

  /** Return one formatted track key, or throw when it is absent. */
  getTrack(key: number | string): number | string {
    const found = this.getTracks().find((candidate) => String(candidate) === String(key));
    if (found === undefined) throw new Error(`Track key ${key} not found.`);
    return found;
  }

  /** Render the playlist hierarchy as an indented tree. */
  treeString(indent = 4, level = 0): string {
    const space = " ".repeat(indent * level);
    if (this.isPlaylist) return `${space}Playlist: ${this.name} (${this.entries} Tracks)\n`;
    return `${space}Folder: ${this.name}\n${this.getPlaylists()
      .map((node) => node.treeString(indent, level + 1))
      .join("")}`;
  }

  /** Compare node identity by parent and name. */
  equals(other: Node): boolean {
    return this.parentElement === other.parentElement && this.name === other.name;
  }

  /** Convert a playlist subtree to structured data. */
  toJSON(): Record<string, unknown> {
    return this.isPlaylist
      ? {
          entries: this.entries,
          keyType: this.keyType,
          name: this.name,
          tracks: this.getTracks(),
          type: "playlist",
        }
      : { children: this.getPlaylists(), count: this.count, name: this.name, type: "folder" };
  }
}

/** Options for creating or parsing a Rekordbox XML document. */
export type RekordboxXmlOptions = {
  company?: string;
  formatVersion?: string;
  name?: string;
  path?: string;
  version?: string;
};

/** Selector accepted by {@link RekordboxXml.getTrack}. */
export type TrackSelector = {
  index?: number;
  location?: string;
  trackId?: number | string;
};

/** Read and write Rekordbox collection XML files. */
export class RekordboxXml {
  static ROOT_TAG = "DJ_PLAYLISTS";
  static PRODUCT_TAG = "PRODUCT";
  static PLAYLISTS_TAG = "PLAYLISTS";
  static COLLECTION_TAG = "COLLECTION";

  private document: Array<OrderedNode> = [];
  private root: OrderedNode;
  private product: OrderedNode;
  private collection: OrderedNode;
  private playlists: OrderedNode;
  private rootNode: Node;
  private lastId = 0;
  private locations = new Set<string>();
  private ids = new Set<number>();
  private sourcePath: string | undefined;

  constructor(pathOrOptions: string | RekordboxXmlOptions = {}) {
    const options = typeof pathOrOptions === "string" ? { path: pathOrOptions } : pathOrOptions;
    if (options.path) {
      const parsed = this.parse(options.path);
      this.document = parsed.document;
      this.root = parsed.root;
      this.product = parsed.product;
      this.collection = parsed.collection;
      this.playlists = parsed.playlists;
      this.rootNode = parsed.rootNode;
      this.sourcePath = options.path;
    } else {
      const initialized = this.initialize(options);
      this.document = initialized.document;
      this.root = initialized.root;
      this.product = initialized.product;
      this.collection = initialized.collection;
      this.playlists = initialized.playlists;
      this.rootNode = initialized.rootNode;
    }
    this.updateCache();
  }

  private parse(path: string): {
    collection: OrderedNode;
    document: Array<OrderedNode>;
    playlists: OrderedNode;
    product: OrderedNode;
    root: OrderedNode;
    rootNode: Node;
  } {
    const parser = new XMLParser({
      attributeNamePrefix: "",
      commentPropName: "#comment",
      ignoreAttributes: false,
      parseAttributeValue: false,
      preserveOrder: true,
      processEntities: false,
      trimValues: false,
    });
    const document = parser.parse(readFileSync(path, "utf8")) as Array<OrderedNode>;
    const root = document.find((node) => tagOf(node) === RekordboxXml.ROOT_TAG);
    if (!root) throw new Error(`No ${RekordboxXml.ROOT_TAG} root found in '${path}'`);
    const product = directChild(root, RekordboxXml.PRODUCT_TAG);
    const collection = directChild(root, RekordboxXml.COLLECTION_TAG);
    const playlists = directChild(root, RekordboxXml.PLAYLISTS_TAG);
    if (!product) throw new Error(`No product found in '${path}'`);
    if (!collection) throw new Error(`No collection found in '${path}'`);
    if (!playlists) throw new Error(`No playlists found in '${path}'`);
    const rootNodeElement = directChild(playlists, Node.TAG);
    if (!rootNodeElement) throw new RootNodeNotInitializedError();
    return {
      collection,
      document,
      playlists,
      product,
      root,
      rootNode: new Node(rootNodeElement, playlists),
    };
  }

  private initialize(options: RekordboxXmlOptions): {
    collection: OrderedNode;
    document: Array<OrderedNode>;
    playlists: OrderedNode;
    product: OrderedNode;
    root: OrderedNode;
    rootNode: Node;
  } {
    const declaration: OrderedNode = {
      "?xml": [{ "#text": "" }],
      ":@": { encoding: "UTF-8", version: "1.0" },
    };
    const root = createElement(RekordboxXml.ROOT_TAG, {
      Version: options.formatVersion ?? "1.0.0",
    });
    const product = appendElement(root, RekordboxXml.PRODUCT_TAG, {
      Company: options.company ?? "",
      Name: options.name ?? "rekordbox-ts",
      Version: options.version ?? "0.0.0",
    });
    const collection = appendElement(root, RekordboxXml.COLLECTION_TAG, { Entries: "0" });
    const playlists = appendElement(root, RekordboxXml.PLAYLISTS_TAG);
    const rootNode = Node.folder(playlists, "ROOT");
    return { collection, document: [declaration, root], playlists, product, root, rootNode };
  }

  /** Rekordbox XML format version. */
  get formatVersion(): string {
    return attributesOf(this.root).Version ?? "";
  }

  /** Compatibility alias for pyrekordbox's `frmt_version`. */
  get frmtVersion(): string {
    return this.formatVersion;
  }

  /** Product name embedded in the XML document. */
  get productName(): string {
    return attributesOf(this.product).Name ?? "";
  }

  /** Product version embedded in the XML document. */
  get productVersion(): string {
    return attributesOf(this.product).Version ?? "";
  }

  /** Product company embedded in the XML document. */
  get productCompany(): string {
    return attributesOf(this.product).Company ?? "";
  }

  /** Number of tracks declared in the collection. */
  get numTracks(): number {
    return Number.parseInt(attributesOf(this.collection).Entries ?? "0", 10);
  }

  /** Root playlist folder. */
  get rootPlaylistFolder(): Node {
    return this.rootNode;
  }

  /** Return every collection track. */
  getTracks(): Array<Track> {
    return directChildren(this.collection, Track.TAG).map((element) => new Track(element));
  }

  /** Return one collection track by index, ID, or filesystem location. */
  getTrack(selector: number | TrackSelector): Track {
    const normalized = typeof selector === "number" ? { index: selector } : selector;
    let element: OrderedNode | undefined;
    if (normalized.trackId !== undefined)
      element = directChildren(this.collection, Track.TAG).find(
        (candidate) => attributesOf(candidate).TrackID === String(normalized.trackId),
      );
    else if (normalized.location !== undefined)
      element = directChildren(this.collection, Track.TAG).find(
        (candidate) => attributesOf(candidate).Location === encodePath(normalized.location!),
      );
    else if (normalized.index !== undefined)
      element = directChildren(this.collection, Track.TAG)[normalized.index];
    else throw new TypeError("Either index, trackId or location has to be specified!");
    if (!element) throw new Error(`Track not found for selector ${JSON.stringify(normalized)}`);
    return new Track(element);
  }

  /** Return all collection track IDs. */
  getTrackIds(): Array<number> {
    return this.getTracks().map((track) => track.TrackID);
  }

  /** Resolve a playlist path, or return the root folder when no names are supplied. */
  getPlaylist(...names: Array<string>): Node {
    let node = this.rootNode;
    for (const name of names) node = node.getPlaylist(name);
    return node;
  }

  private updateCache(): void {
    this.locations.clear();
    this.ids.clear();
    for (const track of this.getTracks()) {
      this.locations.add(normalize(track.Location));
      this.ids.add(track.TrackID);
    }
    this.lastId = this.ids.size ? Math.max(...this.ids) : 0;
  }

  /** Add a unique track to the collection. */
  addTrack(location: string, attributes: TrackAttributes = {}): Track {
    const trackId = attributes.TrackID ?? this.lastId + 1;
    if (this.locations.has(normalize(location))) throw new XmlDuplicateError("Location", location);
    if (this.ids.has(trackId)) throw new XmlDuplicateError("TrackID", trackId);
    const track = Track.create(this.collection, location, { ...attributes, TrackID: trackId });
    attributesOf(this.collection).Entries = String(this.numTracks + 1);
    this.locations.add(normalize(track.Location));
    this.ids.add(track.TrackID);
    this.lastId = Math.max(this.lastId, track.TrackID);
    return track;
  }

  /** Remove a track from the collection. */
  removeTrack(track: Track): void {
    removeElement(this.collection, track.element);
    attributesOf(this.collection).Entries = String(this.numTracks - 1);
    this.locations.delete(normalize(track.Location));
    this.ids.delete(track.TrackID);
  }

  /** Add a top-level playlist folder. */
  addPlaylistFolder(name: string): Node {
    return this.rootNode.addPlaylistFolder(name);
  }

  /** Add a top-level playlist. */
  addPlaylist(name: string, keyType: NodeKeyType = "TrackID"): Node {
    return this.rootNode.addPlaylist(name, keyType);
  }

  private validateTrackCount(): void {
    const count = directChildren(this.collection, Track.TAG).length;
    if (count !== this.numTracks)
      throw new Error(`Track count ${this.numTracks} does not match number of elements ${count}`);
  }

  /** Serialize the complete XML document. */
  toString(options: { indent?: string } = {}): string {
    this.validateTrackCount();
    const builder = new XMLBuilder({
      attributeNamePrefix: "",
      commentPropName: "#comment",
      format: true,
      ignoreAttributes: false,
      indentBy: options.indent ?? "\t",
      preserveOrder: true,
      processEntities: false,
      suppressEmptyNode: true,
    });
    return `${builder.build(this.document).trim()}\n`;
  }

  /** Save the complete XML document, defaulting to the source file when parsed from disk. */
  save(path: string | undefined = this.sourcePath, options: { indent?: string } = {}): void {
    if (!path) throw new TypeError("A destination path is required for a new XML document");
    writeFileSync(path, this.toString(options), "utf8");
    this.sourcePath = path;
  }

  /** Return compact document metadata suitable for CLI output. */
  summary(): Record<string, unknown> {
    return {
      formatVersion: this.formatVersion,
      numTracks: this.numTracks,
      product: {
        company: this.productCompany,
        name: this.productName,
        version: this.productVersion,
      },
      playlists: this.rootNode.toJSON(),
    };
  }
}
