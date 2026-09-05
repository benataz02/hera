import { describe, expect, test } from "bun:test";
import type { ModelDef } from "@hera/config-engine";
import { needsSap, queryPageSource, resolveLookups, type MasterdataRow, type QueryRunner } from "../src/lookups.ts";

// Masterdata is tenant-wide: these cover the filter that keeps a model from reading tables it
// never names — one live SAP hop per query row is the cost of getting it wrong.

const model: ModelDef = {
  name: "m",
  parameters: [{
    key: "grade", label: "Grade", type: "string", ui: "select",
    domain: { kind: "options", ref: { source: "query", table: "items", valueCol: "ItemCode" } },
  }],
  structure: { sections: [{ key: "s", title: "S", groups: [{ key: "g", title: "G", params: ["grade"] }] }] },
  computed: [],
  constraints: [],
  bom: [{ id: "b", itemCode: '"X"', qty: "1", price: 'LOOKUP("prices", "code", grade, "price")', scrapPct: 0 }],
  routing: [],
  pricing: { priceExpr: "unitCost", quoteItemCode: "X" },
  batchDefaults: [1],
};

const rows: MasterdataRow[] = [
  { name: "prices", kind: "table", columns: [{ key: "code" }, { key: "price" }], rows: [["A", 2]] },
  { name: "items", kind: "query", columns: [], rows: [], query: { target: "b1", query: { entitySet: "Items" }, columns: ["ItemCode"], labels: { ItemCode: "Item" } } },
  { name: "unused", kind: "query", columns: [], rows: [], query: { target: "b1", query: { entitySet: "Orders" }, columns: ["DocNum"] } },
];

describe("resolveLookups over masterdata", () => {
  test("fetches only the query rows the model names, and carries their display metadata", async () => {
    const read: string[] = [];
    const run: QueryRunner = async (_t, q) => {
      read.push(q.entitySet);
      return { rows: [{ ItemCode: "A" }] };
    };
    const lookups = await resolveLookups(model, rows, run);
    expect(read).toEqual(["Items"]); // "unused" is never read
    expect(lookups.tables.prices!.rows).toEqual([["A", 2]]);
    expect(lookups.tables.items!.labels).toEqual({ ItemCode: "Item" });
    expect(lookups.domains.grade).toEqual([{ value: "A", label: "A" }]);
  });

  test("a model naming no query row needs no agent", () => {
    const offline = { ...model, parameters: [], bom: [] };
    expect(needsSap(offline, rows)).toBe(false);
    expect(needsSap(model, rows)).toBe(true);
  });
});

describe("queryPageSource", () => {
  test("resolves the named row and refuses anything else", () => {
    expect(queryPageSource(rows, { table: "items" })).toEqual({
      target: "b1", query: { entitySet: "Items" }, columns: ["ItemCode"],
    });
    expect(() => queryPageSource(rows, { table: "prices" })).toThrow("Unknown query table 'prices'");
    expect(() => queryPageSource(rows, { table: "items", searchCols: ["Nope"] })).toThrow();
  });
});
