import { describe, expect, test, it } from "bun:test";
import { ORPCError } from "@orpc/server";
import type { ModelDef, ResolvedLookups, ResolvedTable } from "@hera/config-engine";
import {
  addQueryTables, enrichLookups, fetchQueryTable, optionsFromRef, queryPagePath, resolveLookups, tablesFromTenant, withSearch,
  type QueryFetcher,
} from "../src/lookups.ts";

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

  it("query without pinned columns: fields come from the response, key/label by convention", async () => {
    const tables: Record<string, ResolvedTable> = {};
    await addQueryTables(tables, [{ name: "items", target: "b1", path: "/Items", columns: [] }], async () => ({
      value: [
        { "@odata.etag": "W/1", ItemCode: "A1", ItemName: "Widget" }, // non-identifier keys dropped
        { ItemCode: "B2", ItemName: "Gadget", OnHand: 3 }, // late field still discovered
      ],
    }));
    expect(tables.items).toEqual({
      columns: ["ItemCode", "ItemName", "OnHand"],
      rows: [["A1", "Widget", null], ["B2", "Gadget", 3]],
    });
    expect(optionsFromRef({ source: "query", table: "items" }, tables)).toEqual([
      { value: "A1", label: "Widget" },
      { value: "B2", label: "Gadget" },
    ]);
  });

  it("throws on a non-array query payload", async () => {
    await expect(
      addQueryTables({}, [{ name: "bad", target: "beas", path: "/bad", columns: ["x"] }], async () => ({ oops: 1 })),
    ).rejects.toThrow("did not return a row array");
  });
});

describe("resolveLookups", () => {
  test("forwards the canonical first-page mode through fetchOnce", async () => {
    const seen: Array<{ all?: boolean } | undefined> = [];
    const model = minimalModel({
      queryTables: [{ name: "items", target: "b1", path: "/Items", columns: ["Code"] }],
    });

    await resolveLookups(model, [], async (_target, _path, opts) => {
      seen.push(opts);
      return { value: [{ Code: "M1" }] };
    });

    expect(seen).toEqual([{ all: false }]);
  });

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

describe("enrichLookups", () => {
  const queryModel = (path = "/Items?$select=Code,Price", type: "string" | "number" = "string") => minimalModel({
    parameters: [{
      key: "material", label: "Material", type, ui: "select",
      domain: { kind: "options", ref: { source: "query", table: "items", valueCol: "Code", columns: ["Price"] } },
    }],
    queryTables: [{ name: "items", target: "b1", path, columns: ["Code", "Price"] }],
  });
  const canonical = (value: string | number = "A"): ResolvedLookups => ({
    domains: { material: [{ value, label: String(value) }] },
    tables: { items: { columns: ["Code", "Price"], rows: [[value, 3]], nextLink: "/Items?$skip=1" } },
  });
  const filterOf = (path: string) => decodeURIComponent(/[?&]\$filter=([^&]*)/.exec(path)![1]!);

  test("fetches an escaped exact string predicate with first-page mode", async () => {
    let requested = "";
    const result = await enrichLookups(queryModel(), { material: "O'B" }, canonical(), async (target, path, opts) => {
      expect(target).toBe("b1");
      expect(opts).toEqual({ all: false });
      requested = path;
      return { value: [{ Code: "O'B", Price: 9 }] };
    });

    expect(filterOf(requested)).toBe("Code eq 'O''B'");
    expect(result.tables.items!.rows.at(-1)).toEqual(["O'B", 9]);
  });

  test("ANDs the exact predicate with the model query filter", async () => {
    let requested = "";
    await enrichLookups(
      queryModel("/Items?$filter=Active%20eq%20true&$select=Code,Price"),
      { material: "Z" },
      canonical(),
      async (_target, path) => {
        requested = path;
        return { value: [{ Code: "Z", Price: 7 }] };
      },
    );

    expect(filterOf(requested)).toBe("(Active eq true) and (Code eq 'Z')");
    expect(requested).toContain("$select=Code,Price");
  });

  test("appends the exact row without changing canonical domains or cached objects", async () => {
    const base = canonical();
    const before = structuredClone(base);
    const result = await enrichLookups(queryModel(), { material: "B" }, base, async () => ({
      value: [{ Code: "B", Price: 8 }],
    }));

    expect(result.domains).toBe(base.domains);
    expect(result.domains.material).toEqual([{ value: "A", label: "A" }]);
    expect(result.tables.items!.rows).toEqual([["A", 3], ["B", 8]]);
    expect(base).toEqual(before);
    expect(result.tables.items).not.toBe(base.tables.items);
  });

  test("preserves numeric predicates and rejects a string key for a numeric selection", async () => {
    let requested = "";
    await expect(enrichLookups(queryModel("/Items", "number"), { material: 7 }, canonical(1), async (_target, path) => {
      requested = path;
      return { value: [{ Code: "7", Price: 5 }] };
    })).rejects.toThrow("Invalid lookup value for parameter 'material'");

    expect(filterOf(requested)).toBe("Code eq 7");
  });

  test("rejects missing and stale exact-query rows consistently", async () => {
    for (const value of [[], [{ Code: "OLD", Price: 8 }]]) {
      const error = await enrichLookups(queryModel(), { material: "B" }, canonical(), async () => ({
        value,
      })).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ORPCError);
      expect(error).toMatchObject({
        code: "BAD_REQUEST",
        message: "Invalid lookup value for parameter 'material': value is missing or stale",
      });
    }
  });
});

test("fetchQueryTable retains a v1 nextLink", async () => {
  const table = await fetchQueryTable(
    async () => ({ value: [{ Code: "M1" }], "odata.nextLink": "/Items?$skip=100" }),
    "b1",
    "/Items",
    ["Code"],
    false,
  );
  expect(table.nextLink).toBe("/Items?$skip=100");
});

describe("withSearch", () => {
  const filterOf = (path: string) => decodeURIComponent(/[?&]\$filter=([^&]*)/.exec(path)![1]!);

  test("adds a contains OR-group over the searched columns", () => {
    const path = withSearch("/Items?$select=ItemCode,ItemName", ["ItemCode", "ItemName"], "alu");
    expect(path.startsWith("/Items?$select=ItemCode,ItemName&$filter=")).toBe(true);
    expect(filterOf(path)).toBe("contains(ItemCode,'alu') or contains(ItemName,'alu')");
  });

  test("ANDs onto an existing $filter and keeps the other options", () => {
    const path = withSearch("/Items?$filter=Valid%20eq%20'Y'&$top=50", ["ItemCode"], "alu");
    expect(filterOf(path)).toBe("(Valid eq 'Y') and (contains(ItemCode,'alu'))");
    expect(path).toContain("$top=50");
  });

  test("escapes quotes and drops non-identifier columns", () => {
    expect(filterOf(withSearch("/Items", ["ItemCode", "a;drop"], "O'B"))).toBe("contains(ItemCode,'O''B')");
  });

  test("no search, no filter", () => {
    expect(withSearch("/Items", ["ItemCode"], "  ")).toBe("/Items");
    expect(withSearch("/Items", [], "alu")).toBe("/Items");
  });
});

describe("queryPagePath", () => {
  const model = minimalModel({
    queryTables: [{ name: "items", target: "b1", path: "/Items?$select=ItemCode,ItemName", columns: ["ItemCode"] }],
  });

  test("path comes from the model, search is compiled in", () => {
    const q = queryPagePath(model, { table: "items", search: "alu", searchCols: ["ItemCode"] });
    expect(q.target).toBe("b1");
    expect(q.columns).toEqual(["ItemCode"]);
    expect(q.path).toBe(withSearch("/Items?$select=ItemCode,ItemName", ["ItemCode"], "alu"));
  });

  test("a cursor may change paging while preserving the canonical query", () => {
    const cursor = "/Items?$skip=100&$select=ItemCode,ItemName";
    expect(queryPagePath(model, { table: "items", cursor }).path).toBe(cursor);
    const token = "/Items?$select=ItemCode,ItemName&$skiptoken=opaque%2Btoken";
    expect(queryPagePath(model, { table: "items", cursor: token }).path).toBe(token);
    // the client never gets to re-aim the page at another entity set
    expect(() => queryPagePath(model, { table: "items", cursor: "/BusinessPartners?$skip=0" })).toThrow("Cursor");
  });

  test("rejects a same-collection cursor that changes canonical query options", () => {
    expect(() => queryPagePath(model, {
      table: "items",
      cursor: "/Items?$select=ItemCode,CreditCardNumber&$skip=100",
    })).toThrow("Cursor");
    expect(() => queryPagePath(model, {
      table: "items",
      cursor: "/Items?$filter=Valid%20eq%20'Y'&$select=ItemCode,ItemName&$skip=100",
    })).toThrow("Cursor");
  });

  test("searches only declared columns and validates searched continuations", () => {
    expect(() => queryPagePath(model, {
      table: "items", search: "x", searchCols: ["CreditCardNumber"],
    })).toThrow("Search");
    const first = queryPagePath(model, { table: "items", search: "alu", searchCols: ["ItemCode"] }).path;
    const cursor = `${first}&$skip=100`;
    expect(queryPagePath(model, {
      table: "items", search: "alu", searchCols: ["ItemCode"], cursor,
    }).path).toBe(cursor);
  });

  test("unknown table is rejected, not fetched", () => {
    expect(() => queryPagePath(model, { table: "nope" })).toThrow("nope");
  });
});
