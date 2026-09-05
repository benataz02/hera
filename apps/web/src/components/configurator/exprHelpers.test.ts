import { describe, expect, it, test } from "bun:test";
import type { ModelDef } from "@hera/config-engine";
import { complete, matches, scopeSuggestions, trailingIdent, modelWithParam } from "./exprHelpers.ts";

const model = {
  name: "m",
  parameters: [
    { key: "material", label: "Material", type: "string", ui: "select" },
    { key: "length_mm", label: "Length", type: "number", ui: "input" },
  ],
  structure: { sections: [] },
  computed: [{ key: "area", expr: "1" }],
  constraints: [], bom: [], routing: [],
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

  it("suggests derived query columns from the tenant masterdata", () => {
    const m = structuredClone(model);
    m.parameters.push({
      key: "item", label: "Item", type: "string", ui: "select",
      domain: { kind: "options", ref: { source: "query", table: "items", valueCol: "Code" } },
    });
    const tables = [{ name: "items", kind: "query" as const, columns: ["Code", "Name"] }];
    expect(scopeSuggestions(m, [], tables).map((s) => s.text)).toContain("item_Name");
  });

  it("suggests every extra tenant-table column even when display is a subset", () => {
    const m = structuredClone(model);
    m.parameters.push({
      key: "item", label: "Item", type: "string", ui: "select",
      domain: { kind: "options", ref: { source: "table", table: "items", valueCol: "Code", columns: ["Name"] } },
    });
    const texts = scopeSuggestions(m, [], [{ name: "items", kind: "table", columns: ["Code", "Name", "Price"] }]).map((s) => s.text);
    expect(texts).toContain("item_Name");
    expect(texts).toContain("item_Price");
  });

  it("includes an in-progress table param that is not on the model yet", () => {
    const p = {
      key: "mat", label: "Material", type: "string" as const, ui: "select" as const,
      domain: { kind: "options" as const, ref: { source: "table" as const, table: "mats", valueCol: "code" } },
    };
    const texts = scopeSuggestions(modelWithParam(model, p), [], [{ name: "mats", columns: ["code", "density"] }]).map((s) => s.text);
    expect(texts).toContain("mat_density");
  });

  it("matches a derived key by its column fragment", () => {
    const m = structuredClone(model);
    m.parameters.push({
      key: "mat", label: "Material", type: "string", ui: "select",
      domain: { kind: "options", ref: { source: "table", table: "mats", valueCol: "code" } },
    });
    const all = scopeSuggestions(m, [], [{ name: "mats", columns: ["code", "density"] }]);
    expect(matches(all, "dens").map((s) => s.text)).toContain("mat_density");
    expect(matches(all, "mat_").map((s) => s.text)).toContain("mat_density");
  });
});
