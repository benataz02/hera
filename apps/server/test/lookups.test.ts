import { describe, expect, test, it } from "bun:test";
import { ORPCError } from "@orpc/server";
import type { ModelDef, ODataQuery, ResolvedLookups, ResolvedTable } from "@hera/config-engine";
import {
  addQueryTables, enrichLookups, fetchQueryTable, optionsFromRef, queryPageSource, resolveLookups,
  tablesFromTenant, withSearch,
  type QueryPage, type QueryRunner,
} from "../src/lookups.ts";

const noRun: QueryRunner = async () => {
  throw new Error("unexpected read");
};

/** A runner that just hands back rows, recording what it was asked for. */
const rowsRunner = (rows: Record<string, unknown>[], sink?: (q: ODataQuery) => void): QueryRunner =>
  async (_t, q) => { sink?.(q); return { rows }; };

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
    await addQueryTables(
      tables,
      [{ name: "items", target: "b1", query: { entitySet: "Items" }, columns: ["ItemCode", "ItemName"] }],
      rowsRunner([{ ItemCode: "A1", ItemName: "Widget" }]),
    );
    const opts = optionsFromRef({ source: "query", table: "items", valueCol: "ItemCode", labelCol: "ItemName" }, tables);
    expect(opts).toEqual([{ value: "A1", label: "Widget" }]);
  });

  it("query without pinned columns: fields come from the response, key/label by convention", async () => {
    const tables: Record<string, ResolvedTable> = {};
    await addQueryTables(
      tables,
      [{ name: "items", target: "b1", query: { entitySet: "Items" }, columns: [] }],
      rowsRunner([
        { "@odata.etag": "W/1", ItemCode: "A1", ItemName: "Widget" }, // non-identifier keys dropped
        { ItemCode: "B2", ItemName: "Gadget", OnHand: 3 }, // late field still discovered
      ]),
    );
    expect(tables.items).toEqual({
      columns: ["ItemCode", "ItemName", "OnHand"],
      rows: [["A1", "Widget", null], ["B2", "Gadget", 3]],
    });
    expect(optionsFromRef({ source: "query", table: "items" }, tables)).toEqual([
      { value: "A1", label: "Widget" },
      { value: "B2", label: "Gadget" },
    ]);
  });
});

describe("resolveLookups", () => {
  test("the model's own $select is the source's columns, not a stored field", async () => {
    const seen: string[][] = [];
    const model = minimalModel({
      queryTables: [{ name: "items", target: "b1", query: { entitySet: "Items" }, columns: ["Code"] }],
    });

    await resolveLookups(model, [], async (_target, _q, columns) => {
      seen.push(columns);
      return { rows: [{ Code: "M1" }] };
    });

    expect(seen).toEqual([["Code"]]);
  });

  test("builds domains + tables; queryTables read and projected; reads deduped per (target,query)", async () => {
    let calls = 0;
    const run: QueryRunner = async () => {
      calls++;
      return { rows: [{ Code: "M1", Price: 5 }, { Code: "M2", Price: 7 }] };
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
      // Two queryTables sharing one (target, query) → still just one read (memoized in resolveLookups).
      queryTables: [
        { name: "items", target: "b1", query: { entitySet: "Items" }, columns: ["Code"] },
        { name: "prices", target: "b1", query: { entitySet: "Items" }, columns: ["Code", "Price"] },
      ],
    });
    const lookups = await resolveLookups(model, [], run);
    expect(lookups.domains.mat).toEqual([
      { value: "M1", label: "M1" },
      { value: "M2", label: "M2" },
    ]);
    expect(lookups.domains.grade).toEqual([{ value: "std", label: "std" }]);
    expect(lookups.tables.items).toEqual({ columns: ["Code"], rows: [["M1"], ["M2"]] });
    expect(lookups.tables.prices).toEqual({ columns: ["Code", "Price"], rows: [["M1", 5], ["M2", 7]] });
    expect(calls).toBe(1); // same (target, query) read once across both queryTables
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
      noRun,
    );
    expect(lookups.tables.colors).toEqual({ columns: ["code"], rows: [["R"], ["B"]] });
    expect(lookups.domains.color!.map((o) => o.value)).toEqual(["R", "B"]);
  });
});

describe("enrichLookups", () => {
  const queryModel = (query: ODataQuery = { entitySet: "Items" }, type: "string" | "number" = "string") =>
    minimalModel({
      parameters: [{
        key: "material", label: "Material", type, ui: "select",
        domain: { kind: "options", ref: { source: "query", table: "items", valueCol: "Code", columns: ["Price"] } },
      }],
      queryTables: [{ name: "items", target: "b1", query, columns: ["Code", "Price"] }],
    });
  const canonical = (value: string | number = "A"): ResolvedLookups => ({
    domains: { material: [{ value, label: String(value) }] },
    tables: { items: { columns: ["Code", "Price"], rows: [[value, 3]], nextSkip: 1 } },
  });

  test("composes an escaped exact string predicate", async () => {
    let asked: ODataQuery | undefined;
    const result = await enrichLookups(queryModel(), { material: "O'B" }, canonical(), async (target, q, columns) => {
      expect(target).toBe("b1");
      expect(columns).toEqual(["Code", "Price"]);
      asked = q;
      return { rows: [{ Code: "O'B", Price: 9 }] };
    });

    expect(asked!.filter).toBe("Code eq 'O''B'");
    expect(result.tables.items!.rows.at(-1)).toEqual(["O'B", 9]);
  });

  test("ANDs the exact predicate with the model query filter", async () => {
    let asked: ODataQuery | undefined;
    await enrichLookups(
      queryModel({ entitySet: "Items", filter: "Active eq true" }),
      { material: "Z" },
      canonical(),
      rowsRunner([{ Code: "Z", Price: 7 }], (q) => { asked = q; }),
    );

    expect(asked!.filter).toBe("(Active eq true) and (Code eq 'Z')");
    expect(asked!.entitySet).toBe("Items");
  });

  test("appends the exact row without changing canonical domains or cached objects", async () => {
    const base = canonical();
    const before = structuredClone(base);
    const result = await enrichLookups(queryModel(), { material: "B" }, base, rowsRunner([{ Code: "B", Price: 8 }]));

    expect(result.domains).toBe(base.domains);
    expect(result.domains.material).toEqual([{ value: "A", label: "A" }]);
    expect(result.tables.items!.rows).toEqual([["A", 3], ["B", 8]]);
    expect(base).toEqual(before);
    expect(result.tables.items).not.toBe(base.tables.items);
  });

  test("preserves numeric predicates and rejects a string key for a numeric selection", async () => {
    let asked: ODataQuery | undefined;
    await expect(
      enrichLookups(
        queryModel({ entitySet: "Items" }, "number"), { material: 7 }, canonical(1),
        rowsRunner([{ Code: "7", Price: 5 }], (q) => { asked = q; }),
      ),
    ).rejects.toThrow("Invalid lookup value for parameter 'material'");

    expect(asked!.filter).toBe("Code eq 7");
  });

  test("rejects missing and stale exact-query rows consistently", async () => {
    for (const rows of [[], [{ Code: "OLD", Price: 8 }]]) {
      const error = await enrichLookups(queryModel(), { material: "B" }, canonical(), rowsRunner(rows))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ORPCError);
      expect(error).toMatchObject({
        code: "BAD_REQUEST",
        message: "Invalid lookup value for parameter 'material': value is missing or stale",
      });
    }
  });
});

test("fetchQueryTable carries the next-page offset through", async () => {
  const page: QueryPage = { rows: [{ Code: "M1" }], nextSkip: 100 };
  const table = await fetchQueryTable(async () => page, "b1", { entitySet: "Items" }, ["Code"]);
  expect(table.nextSkip).toBe(100);
});

describe("withSearch", () => {
  test("adds a contains OR-group over the searched columns", () => {
    const q = withSearch({ entitySet: "Items" }, ["ItemCode", "ItemName"], "alu");
    expect(q.filter).toBe("contains(ItemCode,'alu') or contains(ItemName,'alu')");
    expect(q.entitySet).toBe("Items");
  });

  test("ANDs onto an existing $filter and keeps the other options", () => {
    const q = withSearch({ entitySet: "Items", filter: "Valid eq 'Y'", top: 50 }, ["ItemCode"], "alu");
    expect(q.filter).toBe("(Valid eq 'Y') and (contains(ItemCode,'alu'))");
    expect(q.top).toBe(50);
  });

  test("escapes quotes and drops non-identifier columns", () => {
    expect(withSearch({ entitySet: "Items" }, ["ItemCode", "a;drop"], "O'B").filter)
      .toBe("contains(ItemCode,'O''B')");
  });

  test("no search, no filter", () => {
    expect(withSearch({ entitySet: "Items" }, ["ItemCode"], "  ").filter).toBeUndefined();
    expect(withSearch({ entitySet: "Items" }, [], "alu").filter).toBeUndefined();
  });
});

describe("queryPageSource", () => {
  const model = minimalModel({
    queryTables: [{
      name: "items", target: "b1",
      query: { entitySet: "Items", filter: "Valid eq 'Y'" }, columns: ["ItemCode"],
    }],
  });

  test("query comes from the model, search is compiled in", () => {
    const q = queryPageSource(model, { table: "items", search: "alu", searchCols: ["ItemCode"] });
    expect(q.target).toBe("b1");
    expect(q.columns).toEqual(["ItemCode"]);
    expect(q.query.entitySet).toBe("Items");
    expect(q.query.filter).toBe("(Valid eq 'Y') and (contains(ItemCode,'alu'))");
  });

  // The cursor used to be a B1 URL that had to be re-validated against the canonical one. As a
  // row offset it can express nothing but paging — there is no other entity set to re-aim at.
  test("the cursor is a row offset and only a row offset", () => {
    expect(queryPageSource(model, { table: "items", cursor: 100 }).skip).toBe(100);
    expect(queryPageSource(model, { table: "items", cursor: 100 }).query.entitySet).toBe("Items");
    expect(() => queryPageSource(model, { table: "items", cursor: -1 })).toThrow("Cursor");
    expect(() => queryPageSource(model, { table: "items", cursor: 1.5 })).toThrow("Cursor");
  });

  test("searches only declared columns", () => {
    expect(() => queryPageSource(model, {
      table: "items", search: "x", searchCols: ["CreditCardNumber"],
    })).toThrow("Search");
  });

  test("a searched continuation keeps the same filter on every page", () => {
    const first = queryPageSource(model, { table: "items", search: "alu", searchCols: ["ItemCode"] });
    const second = queryPageSource(model, { table: "items", search: "alu", searchCols: ["ItemCode"], cursor: 100 });
    expect(second.query).toEqual(first.query);
    expect(second.skip).toBe(100);
  });

  test("unknown table is rejected, not fetched", () => {
    expect(() => queryPageSource(model, { table: "nope" })).toThrow("nope");
  });
});
