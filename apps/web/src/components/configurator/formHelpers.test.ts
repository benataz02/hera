import { describe, expect, test } from "bun:test";
import type { DomainOption, ModelDef } from "@hera/config-engine";
import { clientBaseLookups, resolveEntry } from "./formHelpers.ts";

const model = (over: Partial<ModelDef>): ModelDef => ({
  name: "m", parameters: [], structure: { sections: [] }, computed: [], constraints: [],
  bom: [], routing: [], queryTables: [], pricing: { priceExpr: "1", quoteItemCode: "X" }, batchDefaults: [1],
  ...over,
});

describe("clientBaseLookups", () => {
  test("resolves manual domains inline, leaves server-backed ones out, no tables", () => {
    const lk = clientBaseLookups(model({
      parameters: [
        { key: "a", label: "A", type: "string", ui: "select",
          domain: { kind: "options", ref: { source: "manual", options: [{ value: 1 }, { value: "x", label: "Ex" }] } } },
        { key: "b", label: "B", type: "string", ui: "select",
          domain: { kind: "options", ref: { source: "query", table: "items" } } },
        { key: "c", label: "C", type: "number", ui: "step", domain: { kind: "range", min: 0, max: 9 } },
      ],
    }));
    expect(lk.tables).toEqual({});
    expect(lk.domains.a).toEqual([{ value: 1, label: "1" }, { value: "x", label: "Ex" }]);
    expect(lk.domains.b).toBeUndefined(); // query source needs the server
    expect(lk.domains.c).toBeUndefined(); // range isn't an options domain
  });
});

describe("resolveEntry", () => {
  const dom: DomainOption[] = [
    { value: "A1", label: "Widget" },
    { value: "B2", label: "Gadget" },
  ];
  test("empty -> clear", () => expect(resolveEntry(dom, "  ")).toEqual({ kind: "clear" }));
  test("exact label (case-insensitive) -> set", () =>
    expect(resolveEntry(dom, "widget")).toEqual({ kind: "set", value: "A1" }));
  test("exact value -> set", () => expect(resolveEntry(dom, "B2")).toEqual({ kind: "set", value: "B2" }));
  test("unknown text -> reject", () => expect(resolveEntry(dom, "nope")).toEqual({ kind: "reject" }));
});
