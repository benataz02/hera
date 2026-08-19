import { describe, expect, test } from "bun:test";
import type { ModelDef, ResolvedLookups } from "@hera/config-engine";
import { validateSuggestions, validateSuggestionSet } from "../src/extraction.ts";

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
const lookups: ResolvedLookups = {
  domains: { material: [{ value: "steel", label: "steel" }, { value: "alu", label: "alu" }] },
  tables: {},
};

describe("validateSuggestions", () => {
  test("in-domain and in-range values are valid", () => {
    const s = validateSuggestions(model, lookups, {}, {
      material: { value: "steel", evidence: "title block" },
      len: { value: 50, evidence: "overall dim, front view" },
    });
    expect(s).toEqual([
      { paramKey: "material", value: "steel", evidence: "title block", valid: true, reason: undefined },
      { paramKey: "len", value: 50, evidence: "overall dim, front view", valid: true, reason: undefined },
    ]);
  });

  test("out-of-domain value is flagged, not dropped", () => {
    const [s] = validateSuggestions(model, lookups, {}, { material: { value: "copper", evidence: "note 3" } });
    expect(s).toMatchObject({ paramKey: "material", value: "copper", valid: false });
    expect(s!.reason).toContain("allowed values");
  });

  test("out-of-range number is flagged with the range", () => {
    const [s] = validateSuggestions(model, lookups, {}, { len: { value: 400, evidence: "side view" } });
    expect(s).toMatchObject({ paramKey: "len", valid: false });
    expect(s!.reason).toContain("5–100");
  });

  test("wrong-typed value is flagged and stringified", () => {
    const [s] = validateSuggestions(model, lookups, {}, { coated: { value: "yes", evidence: "note" } });
    expect(s).toMatchObject({ paramKey: "coated", value: "yes", valid: false, reason: "Expected a boolean" });
  });

  test("open string params are always valid", () => {
    const [s] = validateSuggestions(model, lookups, {}, { note: { value: "per DIN 912", evidence: "note 1" } });
    expect(s).toMatchObject({ paramKey: "note", value: "per DIN 912", valid: true });
  });

  test("nulls, unknown keys and garbage produce no suggestions", () => {
    expect(validateSuggestions(model, lookups, {}, { material: { value: null, evidence: "" }, bogus: { value: 1 } })).toEqual([]);
    expect(validateSuggestions(model, lookups, {}, null)).toEqual([]);
    expect(validateSuggestions(model, lookups, {}, "not json object")).toEqual([]);
  });

  test("missing evidence degrades to empty string", () => {
    const [s] = validateSuggestions(model, lookups, {}, { material: { value: "alu" } });
    expect(s).toMatchObject({ paramKey: "material", value: "alu", evidence: "", valid: true });
  });

  test("an eliminated option is rejected", () => {
    const constrained = structuredClone(model);
    constrained.parameters.push({
      key: "section", label: "Section", type: "number", ui: "select",
      domain: { kind: "options", ref: { source: "manual", options: [{ value: 10 }, { value: 25 }] } },
    });
    constrained.constraints.push({
      kind: "expr", assert: 'material != "alu" || section != 25', message: "Aluminium cannot use section 25",
    });
    const constrainedLookups: ResolvedLookups = {
      domains: {
        ...lookups.domains,
        section: [{ value: 10, label: "10" }, { value: 25, label: "25" }],
      },
      tables: {},
    };

    const [suggestion] = validateSuggestions(
      constrained, constrainedLookups, { section: 25 }, { material: { value: "alu", evidence: "drawing" } },
    );

    expect(suggestion).toMatchObject({ paramKey: "material", value: "alu", valid: false });
    expect(suggestion?.reason).toContain("allowed values");
  });

  test("individually valid but jointly conflicting suggestions are rejected together", () => {
    const constrained = structuredClone(model);
    constrained.parameters.push({
      key: "section", label: "Section", type: "number", ui: "select",
      domain: { kind: "options", ref: { source: "manual", options: [{ value: 10 }, { value: 25 }] } },
    });
    constrained.constraints.push({
      kind: "expr", assert: 'material != "alu" || section != 25', message: "Aluminium cannot use section 25",
    });
    const constrainedLookups: ResolvedLookups = {
      domains: {
        ...lookups.domains,
        section: [{ value: 10, label: "10" }, { value: 25, label: "25" }],
      },
      tables: {},
    };

    const result = validateSuggestionSet(constrained, constrainedLookups, {}, {
      material: { value: "alu", evidence: "drawing" },
      section: { value: 25, evidence: "drawing" },
    });

    expect(result.suggestions).toHaveLength(2);
    expect(result.suggestions.every((suggestion) => !suggestion.valid)).toBe(true);
    expect(result.nextEntries).toEqual({});
    expect(result.conflicts).toContain("Aluminium cannot use section 25");
    expect(result.canCalculate).toBe(false);
  });
});
