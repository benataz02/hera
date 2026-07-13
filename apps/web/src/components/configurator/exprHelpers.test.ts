import { describe, expect, it, test } from "bun:test";
import type { ModelDef } from "@hera/config-engine";
import { complete, matches, scopeSuggestions, trailingIdent } from "./exprHelpers.ts";

const model = {
  name: "m",
  parameters: [
    { key: "material", label: "Material", type: "string", ui: "select" },
    { key: "length_mm", label: "Length", type: "number", ui: "input" },
  ],
  structure: { sections: [] },
  computed: [{ key: "area", expr: "1" }],
  constraints: [], bom: [], routing: [], queryTables: [],
  pricing: { priceExpr: "unitCost", quoteItemCode: "X" },
  batchDefaults: [1],
} as ModelDef;

describe("exprHelpers", () => {
  test("scopeSuggestions: params + computed + extras + functions", () => {
    const all = scopeSuggestions(model, ["qty"]);
    const names = all.map((s) => s.text);
    expect(names).toContain("material");
    expect(names).toContain("area");
    expect(names).toContain("qty");
    expect(names).toContain("LOOKUP");
    expect(all.find((s) => s.text === "area")!.kind).toBe("computed");
  });

  test("trailingIdent grabs the fragment being typed", () => {
    expect(trailingIdent("len")).toBe("len");
    expect(trailingIdent("material == mat")).toBe("mat");
    expect(trailingIdent("1 + ")).toBe("");
    expect(trailingIdent("ROUND(le")).toBe("le");
  });

  test("matches filters case-insensitively and drops exact hits", () => {
    const all = scopeSuggestions(model, []);
    expect(matches(all, "material == mat").map((s) => s.text)).toEqual(["material"]);
    expect(matches(all, "material").map((s) => s.text)).toEqual([]); // already complete
    expect(matches(all, "look").map((s) => s.text)).toEqual(["LOOKUP"]);
    expect(matches(all, "1 + ")).toEqual([]); // no fragment -> no noise
  });

  test("complete replaces the fragment; functions get an open paren", () => {
    const all = scopeSuggestions(model, []);
    const mat = all.find((s) => s.text === "material")!;
    const lookup = all.find((s) => s.text === "LOOKUP")!;
    expect(complete("material == mat", mat)).toBe("material == material");
    expect(complete("look", lookup)).toBe("LOOKUP(");
  });

  it("suggests derived lookup columns when statically known", () => {
    const m = structuredClone(model); // the test file's existing ModelDef fixture; if none, build a minimal one as in propagate.test.ts
    m.queryTables = [{ name: "items", target: "b1", path: "/Items", columns: ["Code", "Name"] }];
    m.parameters.push({
      key: "item", label: "Item", type: "string", ui: "select",
      domain: { kind: "options", ref: { source: "query", table: "items", valueCol: "Code" } },
    });
    const texts = scopeSuggestions(m).map((s) => s.text);
    expect(texts).toContain("item_Name");
  });
});
