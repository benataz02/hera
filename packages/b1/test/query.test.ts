import { describe, expect, test } from "bun:test";
import { andFilter, buildKeyValue, coerceKey, crossJoinPath, entityPath, entitySetPath, metadataPath, parseKeyParam, queryString } from "../src/query.ts";

const items = { keys: ["ItemCode"], fields: [{ name: "ItemCode", kind: "string" }] };
const orders = { keys: ["DocEntry"], fields: [{ name: "DocEntry", kind: "number" }] };
const tax = {
  keys: ["Code", "Type"],
  fields: [
    { name: "Code", kind: "string" },
    { name: "Type", kind: "number" },
  ],
};

describe("coerceKey", () => {
  test("a digit-only route param is still a string until metadata says otherwise", () => {
    expect(parseKeyParam("0000377")).toBe("0000377");
    expect(parseKeyParam("12")).toBe("12");
    expect(entityPath("Items", coerceKey(items, parseKeyParam("0000377")))).toBe("Items('0000377')");
    expect(entityPath("Orders", coerceKey(orders, parseKeyParam("12")))).toBe("Orders(12)");
  });
  test("string keys stay quoted even when they look like integers", () => {
    expect(entityPath("Items", coerceKey(items, "0000377"))).toBe("Items('0000377')");
    expect(entityPath("Items", coerceKey(items, 377))).toBe("Items('377')");
  });

  test("integer keys are unquoted, including a digit string from a route param", () => {
    expect(entityPath("Orders", coerceKey(orders, 12))).toBe("Orders(12)");
    expect(entityPath("Orders", coerceKey(orders, "12"))).toBe("Orders(12)");
  });

  test("composite keys follow each field's kind", () => {
    expect(buildKeyValue(coerceKey(tax, { Code: "AK", Type: "-3" }))).toBe("Code='AK',Type=-3");
  });
});

describe("buildKeyValue", () => {
  test("numbers unquoted, strings quoted", () => {
    expect(buildKeyValue(123)).toBe("123");
    expect(buildKeyValue("A00001")).toBe("'A00001'");
  });

  // The sample client did `typeof key === 'number' ? key : `'${key}'`` — O'Brien broke out of
  // the literal and could carry arbitrary OData with it.
  test("escapes quotes inside a string key", () => {
    expect(buildKeyValue("O'Brien")).toBe("'O''Brien'");
    expect(buildKeyValue("x') or (1 eq 1")).toBe("'x'') or (1 eq 1'");
  });

  test("composite keys become name=value pairs", () => {
    expect(buildKeyValue({ DocEntry: 12, LineNum: 0 })).toBe("DocEntry=12,LineNum=0");
    expect(buildKeyValue({ Code: "A'B" })).toBe("Code='A''B'");
  });

  test("rejects nonsense keys", () => {
    expect(() => buildKeyValue({})).toThrow();
    expect(() => buildKeyValue({ "bad key": 1 })).toThrow();
    expect(() => buildKeyValue(Number.NaN)).toThrow();
  });
});

describe("query strings", () => {
  test("option names stay literal, values are encoded", () => {
    const qs = queryString({ filter: "DocDate ge '2025-01-01'", top: 20, skip: 40 });
    expect(qs.startsWith("$filter=")).toBe(true);
    expect(qs).toContain("$top=20");
    expect(qs).toContain("$skip=40");
    expect(qs).not.toContain("%24");
    expect(decodeURIComponent(qs)).toContain("DocDate ge '2025-01-01'");
  });

  test("$count=true rides along on the same read", () => {
    expect(queryString({ count: true })).toBe("$count=true");
  });

  test("select columns must be names", () => {
    expect(entitySetPath("Items", { select: ["ItemCode", "ItemName"] }))
      .toBe("Items?$select=ItemCode%2CItemName");
    expect(() => entitySetPath("Items", { select: ["ItemCode;DROP"] })).toThrow("column");
  });

  test("entity sets must be names", () => {
    expect(entityPath("Orders", 5)).toBe("Orders(5)");
    expect(() => entitySetPath("Orders?$filter=1 eq 1")).toThrow("entity set");
  });
});

describe("crossJoinPath", () => {
  // The exact shape verified against b1s/v2 in apps/server/src/doc-history.ts.
  test("expands each entity with its own select and encodes the filter", () => {
    const url = crossJoinPath({
      entities: ["Orders", "Orders/DocumentLines"],
      expand: [
        { entity: "Orders", select: ["DocNum", "DocDate"] },
        { entity: "Orders/DocumentLines", select: ["ItemCode"] },
      ],
      filter: "Orders/DocEntry eq Orders/DocumentLines/DocEntry",
      orderby: "Orders/DocDate desc",
      top: 10,
    });
    expect(url).toBe(
      "$crossjoin(Orders,Orders/DocumentLines)" +
      "?$expand=Orders($select=DocNum,DocDate),Orders/DocumentLines($select=ItemCode)" +
      "&$filter=Orders%2FDocEntry%20eq%20Orders%2FDocumentLines%2FDocEntry" +
      "&$orderby=Orders%2FDocDate%20desc&$top=10",
    );
  });

  test("rejects an injected entity name", () => {
    expect(() => crossJoinPath({ entities: ["Orders)&$filter=1 eq 1"], expand: [] })).toThrow();
  });
});

describe("metadataPath", () => {
  test("annotations become repeated params, not one comma-joined value", () => {
    expect(metadataPath({ scope: "entityset", annotation: "labelWithField,labelWithTable", entityset: "Orders", dependency: true }))
      .toBe("$metadata?scope=entityset&annotation=labelWithField&annotation=labelWithTable&entityset=Orders&dependency=true");
  });
  test("no params, no query string", () => {
    expect(metadataPath()).toBe("$metadata");
  });
});

test("andFilter composes instead of splicing an encoded string", () => {
  expect(andFilter(undefined, "A eq 1")).toBe("A eq 1");
  expect(andFilter("  ", "A eq 1")).toBe("A eq 1");
  expect(andFilter("B eq 2", "A eq 1")).toBe("(B eq 2) and (A eq 1)");
});
