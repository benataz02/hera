import { describe, expect, test } from "bun:test";
import type { ModelDef, Option } from "@hera/config-engine";
import { validateSuggestions } from "../src/extraction.ts";

const model: ModelDef = {
  name: "m",
  parameters: [
    {
      key: "material", label: "Material", type: "string", ui: "select",
      domain: { kind: "options", ref: { source: "manual", options: [{ value: "steel" }, { value: "alu" }] } },
    },
    { key: "len", label: "Length", type: "number", ui: "input", domain: { kind: "range", min: 5, max: 100 } },
    { key: "coated", label: "Coated", type: "boolean", ui: "checkbox" },
    { key: "note", label: "Note", type: "string", ui: "input" },
  ],
  structure: { sections: [] },
  computed: [], constraints: [], bom: [], routing: [], queryTables: [],
  pricing: { priceExpr: "1", quoteItemCode: "X" },
  batchDefaults: [1],
};
const domains: Record<string, Option[]> = {
  material: [{ value: "steel", label: "steel" }, { value: "alu", label: "alu" }],
};

describe("validateSuggestions", () => {
  test("in-domain and in-range values are valid", () => {
    const s = validateSuggestions(model, domains, {
      material: { value: "steel", evidence: "title block" },
      len: { value: 50, evidence: "overall dim, front view" },
    });
    expect(s).toEqual([
      { paramKey: "material", value: "steel", evidence: "title block", valid: true, reason: undefined },
      { paramKey: "len", value: 50, evidence: "overall dim, front view", valid: true, reason: undefined },
    ]);
  });

  test("out-of-domain value is flagged, not dropped", () => {
    const [s] = validateSuggestions(model, domains, { material: { value: "copper", evidence: "note 3" } });
    expect(s).toMatchObject({ paramKey: "material", value: "copper", valid: false });
    expect(s!.reason).toContain("allowed values");
  });

  test("out-of-range number is flagged with the range", () => {
    const [s] = validateSuggestions(model, domains, { len: { value: 400, evidence: "side view" } });
    expect(s).toMatchObject({ paramKey: "len", valid: false });
    expect(s!.reason).toContain("5–100");
  });

  test("wrong-typed value is flagged and stringified", () => {
    const [s] = validateSuggestions(model, domains, { coated: { value: "yes", evidence: "note" } });
    expect(s).toMatchObject({ paramKey: "coated", value: "yes", valid: false, reason: "Expected a boolean" });
  });

  test("open string params are always valid", () => {
    const [s] = validateSuggestions(model, domains, { note: { value: "per DIN 912", evidence: "note 1" } });
    expect(s).toMatchObject({ paramKey: "note", value: "per DIN 912", valid: true });
  });

  test("nulls, unknown keys and garbage produce no suggestions", () => {
    expect(validateSuggestions(model, domains, { material: { value: null, evidence: "" }, bogus: { value: 1 } })).toEqual([]);
    expect(validateSuggestions(model, domains, null)).toEqual([]);
    expect(validateSuggestions(model, domains, "not json object")).toEqual([]);
  });

  test("missing evidence degrades to empty string", () => {
    const [s] = validateSuggestions(model, domains, { material: { value: "alu" } });
    expect(s).toMatchObject({ paramKey: "material", value: "alu", evidence: "", valid: true });
  });
});
