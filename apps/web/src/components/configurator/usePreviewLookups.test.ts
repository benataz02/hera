import { expect, test } from "bun:test";
import type { ModelDef } from "@hera/config-engine";

// The module transitively imports the browser oRPC client, which reads window.location at load.
globalThis.window = { location: { origin: "http://test" } } as never;
const { commitKey, lookupSkeleton } = await import("./usePreviewLookups.ts");

const model = (queryTables: ModelDef["queryTables"]) => ({
  name: "m",
  parameters: [{ key: "item", label: "Item", type: "string", ui: "select", domain: { kind: "options", ref: { table: "items" } } }],
  structure: { sections: [] },
  computed: [], constraints: [], bom: [], routing: [],
  queryTables,
  pricing: { priceExpr: "0", quoteItemCode: "X" },
  batchDefaults: [1],
} as ModelDef);

test("typing a query path does not change the commit key", () => {
  const a = model([{ name: "items", target: "b1", path: "/Ite", columns: [] }]);
  const b = model([{ name: "items", target: "b1", path: "/Items", columns: [] }]);
  expect(commitKey(b)).toBe(commitKey(a));
});

test("Test fetch (columns from the response) changes the commit key", () => {
  const before = model([{ name: "items", target: "b1", path: "/Items", columns: [] }]);
  const after = model([{ name: "items", target: "b1", path: "/Items", columns: ["ItemCode"] }]);
  expect(commitKey(after)).not.toBe(commitKey(before));
});

test("changing a parameter domain changes the commit key", () => {
  const a = model([]);
  const b = model([]);
  b.parameters[0]!.domain = { kind: "options", ref: { table: "other" } };
  expect(commitKey(b)).not.toBe(commitKey(a));
});

test("skeleton drops path-less queries so a new one can't error the resolve", () => {
  const skel = lookupSkeleton(model([
    { name: "items", target: "b1", path: "/Items", columns: ["ItemCode"] },
    { name: "query2", target: "b1", path: "", columns: [] },
  ]));
  expect(skel.queryTables.map((q) => q.name)).toEqual(["items"]);
});
