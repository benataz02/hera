import { describe, expect, test, it } from "bun:test";
import type { ModelDef, ResolvedTable } from "@hera/config-engine";
import { addQueryTables, optionsFromRef, resolveLookups, tablesFromTenant, type QueryFetcher } from "../src/lookups.ts";

const noFetch: QueryFetcher = async () => {
  throw new Error("unexpected fetch");
};

const minimalModel = (over: Partial<ModelDef>): ModelDef => ({
  name: "m",
  parameters: [],
  structure: { sections: [] },
  computed: [],
  constraints: [],
  bom: [],
  routing: [],
  queryTables: [],
  pricing: { priceExpr: "1", quoteItemCode: "X" },
  batchDefaults: [1],
  ...over,
});

describe("optionsFromRef", () => {
  test("manual: label defaults to String(value)", () => {
    const opts = optionsFromRef(
      { source: "manual", options: [{ value: 10 }, { value: "alu", label: "Aluminium" }] },
      {},
    );
    expect(opts).toEqual([
      { value: 10, label: "10" },
      { value: "alu", label: "Aluminium" },
    ]);
  });

  test("table: projects valueCol/labelCol by name", () => {
    const tables = tablesFromTenant([
      { name: "colors", columns: [{ key: "code" }, { key: "name" }], rows: [["R", "Red"], ["B", "Blue"]] },
    ]);
    const opts = optionsFromRef({ source: "table", table: "colors", valueCol: "code", labelCol: "name" }, tables);
    expect(opts).toEqual([
      { value: "R", label: "Red" },
      { value: "B", label: "Blue" },
    ]);
  });

  test("table: unknown table/column errors name the culprit", () => {
    expect(() => optionsFromRef({ source: "table", table: "nope", valueCol: "x" }, {})).toThrow("nope");
    const tables = tablesFromTenant([{ name: "t", columns: [{ key: "a" }], rows: [] }]);
    expect(() => optionsFromRef({ source: "table", table: "t", valueCol: "x" }, tables)).toThrow("'x'");
  });

  it("resolves query domains from a fetched queryTable", async () => {
    const tables: Record<string, ResolvedTable> = {};
    await addQueryTables(tables, [{ name: "items", target: "b1", path: "/Items?$select=ItemCode,ItemName", columns: ["ItemCode", "ItemName"] }],
      async () => ({ value: [{ ItemCode: "A1", ItemName: "Widget" }] }));
    const opts = optionsFromRef({ source: "query", table: "items", valueCol: "ItemCode", labelCol: "ItemName" }, tables);
    expect(opts).toEqual([{ value: "A1", label: "Widget" }]);
  });

  it("throws on a non-array query payload", async () => {
    await expect(
      addQueryTables({}, [{ name: "bad", target: "beas", path: "/bad", columns: ["x"] }], async () => ({ oops: 1 })),
    ).rejects.toThrow("did not return a row array");
  });
});

describe("resolveLookups", () => {
  test("builds domains + tables; queryTables fetched and projected; fetches deduped per (target,path)", async () => {
    let calls = 0;
    const fetcher: QueryFetcher = async () => {
      calls++;
      return { value: [{ Code: "M1", Price: 5 }, { Code: "M2", Price: 7 }] };
    };
    const model = minimalModel({
      parameters: [
        {
          key: "mat", label: "Material", type: "string", ui: "select",
          domain: { kind: "options", ref: { source: "query", table: "items", valueCol: "Code" } },
        },
        {
          key: "grade", label: "Grade", type: "string", ui: "select",
          domain: { kind: "options", ref: { source: "manual", options: [{ value: "std" }] } },
        },
      ],
      // Two queryTables sharing one path (target,path) → still just one GET (memoized in resolveLookups).
      queryTables: [
        { name: "items", target: "b1", path: "/Items", columns: ["Code"] },
        { name: "prices", target: "b1", path: "/Items", columns: ["Code", "Price"] },
      ],
    });
    const lookups = await resolveLookups(model, [], fetcher);
    expect(lookups.domains.mat).toEqual([
      { value: "M1", label: "M1" },
      { value: "M2", label: "M2" },
    ]);
    expect(lookups.domains.grade).toEqual([{ value: "std", label: "std" }]);
    expect(lookups.tables.items).toEqual({ columns: ["Code"], rows: [["M1"], ["M2"]] });
    expect(lookups.tables.prices).toEqual({ columns: ["Code", "Price"], rows: [["M1", 5], ["M2", 7]] });
    expect(calls).toBe(1); // same (target, path) fetched once across both queryTables
  });

  test("tenant config_tables land in tables and are usable as a domain source", async () => {
    const model = minimalModel({
      parameters: [
        {
          key: "color", label: "Color", type: "string", ui: "select",
          domain: { kind: "options", ref: { source: "table", table: "colors", valueCol: "code" } },
        },
      ],
    });
    const lookups = await resolveLookups(
      model,
      [{ name: "colors", columns: [{ key: "code" }], rows: [["R"], ["B"]] }],
      noFetch,
    );
    expect(lookups.tables.colors).toEqual({ columns: ["code"], rows: [["R"], ["B"]] });
    expect(lookups.domains.color!.map((o) => o.value)).toEqual(["R", "B"]);
  });
});
