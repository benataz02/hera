import { describe, expect, test } from "bun:test";
import type { ModelDef } from "@hera/config-engine";
import { optionsFromRef, resolveLookups, tablesFromTenant, type QueryFetcher } from "../src/lookups.ts";

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
  test("manual: label defaults to String(value)", async () => {
    const opts = await optionsFromRef(
      { source: "manual", options: [{ value: 10 }, { value: "alu", label: "Aluminium" }] },
      {},
      noFetch,
    );
    expect(opts).toEqual([
      { value: 10, label: "10" },
      { value: "alu", label: "Aluminium" },
    ]);
  });

  test("table: projects valueCol/labelCol by name", async () => {
    const tables = tablesFromTenant([
      { name: "colors", columns: [{ key: "code" }, { key: "name" }], rows: [["R", "Red"], ["B", "Blue"]] },
    ]);
    const opts = await optionsFromRef(
      { source: "table", table: "colors", valueCol: "code", labelCol: "name" },
      tables,
      noFetch,
    );
    expect(opts).toEqual([
      { value: "R", label: "Red" },
      { value: "B", label: "Blue" },
    ]);
  });

  test("table: unknown table/column errors name the culprit", async () => {
    await expect(optionsFromRef({ source: "table", table: "nope", valueCol: "x" }, {}, noFetch)).rejects.toThrow(
      "nope",
    );
    const tables = tablesFromTenant([{ name: "t", columns: [{ key: "a" }], rows: [] }]);
    await expect(optionsFromRef({ source: "table", table: "t", valueCol: "x" }, tables, noFetch)).rejects.toThrow("'x'");
  });

  test("query: unwraps { value: [...] } and maps fields", async () => {
    const fetcher: QueryFetcher = async (target, path) => {
      expect(target).toBe("b1");
      expect(path).toBe("/Items?$select=ItemCode,ItemName");
      return { value: [{ ItemCode: "A1", ItemName: "Widget" }] };
    };
    const opts = await optionsFromRef(
      { source: "query", target: "b1", path: "/Items?$select=ItemCode,ItemName", valueField: "ItemCode", labelField: "ItemName" },
      {},
      fetcher,
    );
    expect(opts).toEqual([{ value: "A1", label: "Widget" }]);
  });

  test("query: non-array response errors with target + path", async () => {
    await expect(
      optionsFromRef({ source: "query", target: "beas", path: "/bad", valueField: "x" }, {}, async () => ({ oops: 1 })),
    ).rejects.toThrow("beas GET /bad");
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
          domain: { kind: "options", ref: { source: "query", target: "b1", path: "/Items", valueField: "Code" } },
        },
        {
          key: "grade", label: "Grade", type: "string", ui: "select",
          domain: { kind: "options", ref: { source: "manual", options: [{ value: "std" }] } },
        },
      ],
      queryTables: [{ name: "prices", target: "b1", path: "/Items", columns: ["Code", "Price"] }],
    });
    const lookups = await resolveLookups(model, [], fetcher);
    expect(lookups.domains.mat).toEqual([
      { value: "M1", label: "M1" },
      { value: "M2", label: "M2" },
    ]);
    expect(lookups.domains.grade).toEqual([{ value: "std", label: "std" }]);
    expect(lookups.tables.prices).toEqual({ columns: ["Code", "Price"], rows: [["M1", 5], ["M2", 7]] });
    expect(calls).toBe(1); // same (target, path) fetched once
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
