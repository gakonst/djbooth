import { XMLBuilder, XMLParser } from "fast-xml-parser";

/** Smart-playlist logical combination mode. */
export const LogicalOperator = { ALL: 1, ANY: 2 } as const;
/** Smart-playlist logical combination mode. */
export type LogicalOperator = (typeof LogicalOperator)[keyof typeof LogicalOperator];

/** Rekordbox smart-playlist comparison operators. */
export const Operator = {
  CONTAINS: 8,
  ENDS_WITH: 11,
  EQUAL: 1,
  GREATER: 3,
  IN_LAST: 6,
  IN_RANGE: 5,
  LESS: 4,
  NOT_CONTAINS: 9,
  NOT_EQUAL: 2,
  NOT_IN_LAST: 7,
  STARTS_WITH: 10,
} as const;
/** Rekordbox smart-playlist comparison operator. */
export type Operator = (typeof Operator)[keyof typeof Operator];

/** Rekordbox smart-playlist properties. */
export const Property = {
  ALBUM: "album",
  ALBUM_ARTIST: "albumArtist",
  ARTIST: "artist",
  BPM: "bpm",
  COMMENTS: "comments",
  COUNTER: "counter",
  DATE_CREATED: "dateCreated",
  DATE_RELEASED: "dateReleased",
  DURATION: "duration",
  FILENAME: "fileName",
  GENRE: "genre",
  GROUPING: "grouping",
  KEY: "key",
  LABEL: "label",
  MIX_NAME: "mixName",
  MYTAG: "myTag",
  NAME: "name",
  ORIGINAL_ARTIST: "originalArtist",
  PRODUCER: "producer",
  RATING: "rating",
  REMIXED_BY: "remixedBy",
  STOCK_DATE: "stockDate",
  YEAR: "year",
} as const;
/** Rekordbox smart-playlist property. */
export type Property = (typeof Property)[keyof typeof Property];

const stringOperators = [
  Operator.EQUAL,
  Operator.NOT_EQUAL,
  Operator.CONTAINS,
  Operator.NOT_CONTAINS,
  Operator.STARTS_WITH,
  Operator.ENDS_WITH,
];
const numberOperators = [
  Operator.EQUAL,
  Operator.NOT_EQUAL,
  Operator.GREATER,
  Operator.LESS,
  Operator.IN_RANGE,
];
const dateOperators = [
  Operator.EQUAL,
  Operator.NOT_EQUAL,
  Operator.GREATER,
  Operator.LESS,
  Operator.IN_RANGE,
  Operator.IN_LAST,
  Operator.NOT_IN_LAST,
];

/** Valid comparison operators by smart-playlist property. */
export const validOperators: Record<Property, Array<Operator>> = {
  [Property.ALBUM]: stringOperators,
  [Property.ALBUM_ARTIST]: stringOperators,
  [Property.ARTIST]: stringOperators,
  [Property.BPM]: numberOperators,
  [Property.COMMENTS]: stringOperators,
  [Property.COUNTER]: numberOperators,
  [Property.DATE_CREATED]: dateOperators,
  [Property.DATE_RELEASED]: dateOperators,
  [Property.DURATION]: numberOperators,
  [Property.FILENAME]: stringOperators,
  [Property.GENRE]: stringOperators,
  [Property.GROUPING]: [Operator.EQUAL, Operator.NOT_EQUAL],
  [Property.KEY]: stringOperators,
  [Property.LABEL]: stringOperators,
  [Property.MIX_NAME]: stringOperators,
  [Property.MYTAG]: [Operator.CONTAINS, Operator.NOT_CONTAINS],
  [Property.NAME]: stringOperators,
  [Property.ORIGINAL_ARTIST]: stringOperators,
  [Property.PRODUCER]: stringOperators,
  [Property.RATING]: numberOperators,
  [Property.REMIXED_BY]: stringOperators,
  [Property.STOCK_DATE]: dateOperators,
  [Property.YEAR]: numberOperators,
};

/** Direct master-database column mapping for smart-playlist properties. */
export const propertyColumnMap: Partial<Record<Property, string>> = {
  [Property.ALBUM]: "AlbumName",
  [Property.ALBUM_ARTIST]: "AlbumArtistName",
  [Property.ARTIST]: "ArtistName",
  [Property.BPM]: "BPM",
  [Property.COMMENTS]: "Commnt",
  [Property.COUNTER]: "DJPlayCount",
  [Property.DATE_CREATED]: "created_at",
  [Property.DATE_RELEASED]: "ReleaseDate",
  [Property.DURATION]: "Length",
  [Property.FILENAME]: "FileNameL",
  [Property.GENRE]: "GenreName",
  [Property.GROUPING]: "ColorID",
  [Property.KEY]: "KeyName",
  [Property.LABEL]: "LabelName",
  [Property.MYTAG]: "MyTagIDs",
  [Property.NAME]: "Title",
  [Property.ORIGINAL_ARTIST]: "OrgArtistName",
  [Property.PRODUCER]: "ComposerName",
  [Property.RATING]: "Rating",
  [Property.REMIXED_BY]: "RemixerName",
  [Property.STOCK_DATE]: "StockDate",
  [Property.YEAR]: "ReleaseYear",
};

const properties = new Set<Property>(Object.values(Property));
const numberProperties = new Set<Property>([
  Property.BPM,
  Property.COUNTER,
  Property.DURATION,
  Property.RATING,
  Property.YEAR,
]);

/** Constructor data for one smart-playlist condition. */
export type ConditionInput = {
  operator: Operator;
  property: Property;
  unit?: string;
  valueLeft: string | number;
  valueRight?: string | number;
};

/** One validated smart-playlist condition. */
export class Condition {
  property: Property;
  operator: Operator;
  unit: string;
  valueLeft: string | number;
  valueRight: string | number;

  constructor(input: ConditionInput) {
    if (!properties.has(input.property))
      throw new RangeError(
        `Invalid property '${input.property}'; expected ${[...properties].join(", ")}`,
      );
    if (!validOperators[input.property].includes(input.operator))
      throw new RangeError(
        `Invalid operator '${input.operator}' for '${input.property}'; expected ${validOperators[input.property].join(", ")}`,
      );
    if (
      input.operator === Operator.IN_RANGE &&
      (input.valueRight === undefined || input.valueRight === "")
    )
      throw new RangeError(`Operator '${input.operator}' requires valueRight`);
    this.property = input.property;
    this.operator = input.operator;
    this.unit = input.unit ?? "";
    this.valueLeft = input.valueLeft;
    this.valueRight = input.valueRight ?? "";
  }

  /** Convert to a plain object. */
  toJSON(): Required<ConditionInput> {
    return {
      operator: this.operator,
      property: this.property,
      unit: this.unit,
      valueLeft: this.valueLeft,
      valueRight: this.valueRight,
    };
  }
}

/** Convert an unsigned 32-bit playlist ID to Rekordbox's signed XML form. */
export function leftBitshift(value: number, bits = 32): number {
  return value - 2 ** bits;
}

/** Convert Rekordbox's signed XML playlist ID to an unsigned form. */
export function rightBitshift(value: number, bits = 32): number {
  return value + 2 ** bits;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function sqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** Parameterized SQL generated from a smart playlist. */
export type SmartListSql = {
  parameters: Array<unknown>;
  sql: string;
  unsupported: Array<Property>;
};

/** Rekordbox smart-playlist XML handler and SQL compiler. */
export class SmartList {
  playlistId: number | string = "";
  logicalOperator: LogicalOperator;
  autoUpdate: number;
  conditions: Array<Condition> = [];

  constructor(logicalOperator: LogicalOperator = LogicalOperator.ALL, autoUpdate = 0) {
    this.logicalOperator = logicalOperator;
    this.autoUpdate = autoUpdate;
  }

  /** Parse smart-playlist XML into this object. */
  parse(source: string): this {
    const parser = new XMLParser({
      attributeNamePrefix: "",
      ignoreAttributes: false,
      parseAttributeValue: false,
    });
    const root = asRecord(asRecord(parser.parse(source)).NODE);
    if (!root.Id) throw new TypeError("Smart playlist NODE is missing Id");
    const rawConditions = Array.isArray(root.CONDITION)
      ? root.CONDITION
      : root.CONDITION
        ? [root.CONDITION]
        : [];
    this.playlistId = String(rightBitshift(Number(root.Id)));
    this.logicalOperator = Number(root.LogicalOperator) as LogicalOperator;
    this.autoUpdate = Number(root.AutomaticUpdate);
    this.conditions = rawConditions.map((raw) => {
      const condition = asRecord(raw);
      return new Condition({
        operator: Number(condition.Operator) as Operator,
        property: String(condition.PropertyName) as Property,
        unit: String(condition.ValueUnit ?? ""),
        valueLeft: String(condition.ValueLeft ?? ""),
        valueRight: String(condition.ValueRight ?? ""),
      });
    });
    return this;
  }

  /** Create a new object from smart-playlist XML. */
  static fromXml(source: string): SmartList {
    return new SmartList().parse(source);
  }

  /** Serialize this object to Rekordbox smart-playlist XML. */
  toXml(): string {
    if (this.playlistId === "")
      throw new TypeError("playlistId is required to serialize a smart list");
    const builder = new XMLBuilder({
      attributeNamePrefix: "",
      format: false,
      ignoreAttributes: false,
      suppressEmptyNode: true,
    });
    return builder.build({
      NODE: {
        Id: String(leftBitshift(Number(this.playlistId))),
        LogicalOperator: String(this.logicalOperator),
        AutomaticUpdate: String(this.autoUpdate),
        CONDITION: this.conditions.map((condition) => ({
          PropertyName: condition.property,
          Operator: String(condition.operator),
          ValueUnit: condition.unit,
          ValueLeft: String(condition.valueLeft),
          ValueRight: String(condition.valueRight),
        })),
      },
    });
  }

  /** Add one validated condition. */
  addCondition(input: ConditionInput): this;
  /** Add one condition using pyrekordbox-compatible positional arguments. */
  addCondition(
    property: Property,
    operator: Operator,
    valueLeft: string | number,
    valueRight?: string | number,
    unit?: string,
  ): this;
  addCondition(
    inputOrProperty: ConditionInput | Property,
    operator?: Operator,
    valueLeft?: string | number,
    valueRight: string | number = "",
    unit = "",
  ): this {
    const input: ConditionInput =
      typeof inputOrProperty === "string"
        ? {
            operator: operator!,
            property: inputOrProperty,
            unit,
            valueLeft: valueLeft ?? "",
            valueRight,
          }
        : inputOrProperty;
    this.conditions.push(new Condition(input));
    return this;
  }

  /** Compile conditions to a parameterized SQLite WHERE expression. */
  compileSql(options: { tableAlias?: string } = {}): SmartListSql {
    const clauses: Array<string> = [];
    const parameters: Array<unknown> = [];
    const unsupported: Array<Property> = [];
    const prefix = options.tableAlias ? `${sqlIdentifier(options.tableAlias)}.` : "";

    for (const condition of this.conditions) {
      const columnName = propertyColumnMap[condition.property];
      if (!columnName) {
        unsupported.push(condition.property);
        continue;
      }
      const column = `${prefix}${sqlIdentifier(columnName)}`;
      let left: unknown = condition.valueLeft === "" ? null : condition.valueLeft;
      let right: unknown = condition.valueRight;
      if (numberProperties.has(condition.property)) {
        if (left !== null) left = Number(left);
        if (right !== "") right = Number(right);
      }
      if (condition.property === Property.MYTAG && Number(left) < 0)
        left = String(rightBitshift(Number(left)));

      switch (condition.operator) {
        case Operator.EQUAL:
          clauses.push(left === null ? `${column} IS NULL` : `${column} = ?`);
          if (left !== null) parameters.push(left);
          break;
        case Operator.NOT_EQUAL:
          clauses.push(left === null ? `${column} IS NOT NULL` : `${column} != ?`);
          if (left !== null) parameters.push(left);
          break;
        case Operator.GREATER:
          clauses.push(`${column} > ?`);
          parameters.push(left);
          break;
        case Operator.LESS:
          clauses.push(`${column} < ?`);
          parameters.push(left);
          break;
        case Operator.IN_RANGE:
          clauses.push(`${column} BETWEEN ? AND ?`);
          parameters.push(left, right);
          break;
        case Operator.CONTAINS:
        case Operator.NOT_CONTAINS: {
          const comparison = `${column} LIKE ? ESCAPE '\\'`;
          clauses.push(
            condition.operator === Operator.NOT_CONTAINS ? `NOT (${comparison})` : comparison,
          );
          parameters.push(`%${escapeLike(String(left ?? ""))}%`);
          break;
        }
        case Operator.STARTS_WITH:
          clauses.push(`${column} LIKE ? ESCAPE '\\'`);
          parameters.push(`${escapeLike(String(left ?? ""))}%`);
          break;
        case Operator.ENDS_WITH:
          clauses.push(`${column} LIKE ? ESCAPE '\\'`);
          parameters.push(`%${escapeLike(String(left ?? ""))}`);
          break;
        case Operator.IN_LAST:
        case Operator.NOT_IN_LAST: {
          if (!["day", "month"].includes(condition.unit))
            throw new RangeError(`Unknown relative-date unit '${condition.unit}'`);
          const comparison = condition.operator === Operator.IN_LAST ? ">" : "<";
          clauses.push(`${column} ${comparison} datetime('now', ?)`);
          parameters.push(`-${Number(left)} ${condition.unit}${Number(left) === 1 ? "" : "s"}`);
          break;
        }
      }
    }

    const joiner = this.logicalOperator === LogicalOperator.ALL ? " AND " : " OR ";
    return { parameters, sql: clauses.length ? `(${clauses.join(joiner)})` : "1", unsupported };
  }

  /** Convert the complete smart list to structured data. */
  toJSON(): Record<string, unknown> {
    return {
      autoUpdate: this.autoUpdate,
      conditions: this.conditions,
      logicalOperator: this.logicalOperator,
      playlistId: this.playlistId,
    };
  }
}
