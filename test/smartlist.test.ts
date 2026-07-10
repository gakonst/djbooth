import { describe, expect, it } from "vitest";

import {
  Condition,
  leftBitshift,
  LogicalOperator,
  Operator,
  Property,
  rightBitshift,
  SmartList,
} from "../src/masterdb/smartlist.js";

const source =
  '<NODE Id="-1692716440" LogicalOperator="1" AutomaticUpdate="0"><CONDITION PropertyName="artist" Operator="1" ValueUnit="" ValueLeft="Loopmasters" ValueRight=""/><CONDITION PropertyName="name" Operator="8" ValueUnit="" ValueLeft="Demo" ValueRight=""/></NODE>';

describe("SmartList XML", () => {
  it("parses and serializes Rekordbox smart-playlist XML", () => {
    const smartList = SmartList.fromXml(source);
    expect(smartList.playlistId).toBe("2602250856");
    expect(smartList.logicalOperator).toBe(LogicalOperator.ALL);
    expect(smartList.conditions).toHaveLength(2);
    expect(smartList.conditions[0]?.toJSON()).toEqual({
      operator: Operator.EQUAL,
      property: Property.ARTIST,
      unit: "",
      valueLeft: "Loopmasters",
      valueRight: "",
    });
    expect(smartList.toXml()).toBe(source);
  });

  it("supports positional and object condition creation", () => {
    const smartList = new SmartList(LogicalOperator.ANY, 1);
    smartList.playlistId = 42;
    smartList.addCondition(Property.ARTIST, Operator.EQUAL, "Loopmasters").addCondition({
      operator: Operator.IN_RANGE,
      property: Property.YEAR,
      valueLeft: 2020,
      valueRight: 2026,
    });
    expect(smartList.conditions).toHaveLength(2);
    const xml = smartList.toXml();
    expect(SmartList.fromXml(xml).toXml()).toBe(xml);
  });

  it("validates property/operator combinations and range operands", () => {
    expect(
      () =>
        new Condition({
          operator: Operator.GREATER,
          property: Property.ARTIST,
          valueLeft: "A",
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new Condition({
          operator: Operator.IN_RANGE,
          property: Property.YEAR,
          valueLeft: 2020,
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new Condition({
          operator: Operator.GREATER,
          property: Property.YEAR,
          valueLeft: "not-a-number",
        }),
    ).toThrow(RangeError);
    expect(() => new SmartList(99 as never)).toThrow(RangeError);
    expect(() => new SmartList(LogicalOperator.ALL, 2)).toThrow(RangeError);
    expect(() =>
      SmartList.fromXml('<NODE Id="wat" LogicalOperator="1" AutomaticUpdate="0"/>'),
    ).toThrow(RangeError);
    const invalidId = new SmartList();
    invalidId.playlistId = Number.NaN;
    expect(() => invalidId.toXml()).toThrow(RangeError);
  });

  it("converts signed and unsigned 32-bit playlist IDs", () => {
    expect(leftBitshift(2602250856)).toBe(-1692716440);
    expect(rightBitshift(-1692716440)).toBe(2602250856);
    expect(() => leftBitshift(Number.NaN)).toThrow(RangeError);
  });
});

describe("SmartList SQL compilation", () => {
  it("compiles all conditions into parameterized SQL", () => {
    const smartList = SmartList.fromXml(source);
    expect(smartList.compileSql({ tableAlias: "content" })).toEqual({
      parameters: ["Loopmasters", "%Demo%"],
      sql: '("content"."ArtistName" = ? AND "content"."Title" LIKE ? ESCAPE \'\\\')',
      unsupported: [],
    });
  });

  it("compiles ranges and relative dates without interpolating values", () => {
    const smartList = new SmartList(LogicalOperator.ANY);
    smartList
      .addCondition(Property.YEAR, Operator.IN_RANGE, 2020, 2026)
      .addCondition(Property.STOCK_DATE, Operator.IN_LAST, 3, "", "month");
    expect(smartList.compileSql()).toEqual({
      parameters: [2020, 2026, "-3 months"],
      sql: '("ReleaseYear" BETWEEN ? AND ? OR "StockDate" > datetime(\'now\', ?))',
      unsupported: [],
    });
  });

  it("reports properties without a known database mapping", () => {
    const smartList = new SmartList();
    smartList.addCondition(Property.MIX_NAME, Operator.EQUAL, "Club Mix");
    expect(smartList.compileSql()).toEqual({
      parameters: [],
      sql: "1",
      unsupported: [Property.MIX_NAME],
    });
  });
});
