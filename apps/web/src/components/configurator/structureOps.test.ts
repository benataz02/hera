import { describe, expect, test } from "bun:test";
import type { ModelDef } from "@hera/config-engine";
import { applyMove, canDrop, parseRowKey, placeParam, removeFromStructure, unplacedParams } from "./structureOps.ts";

const def = {
  name: "m",
  parameters: [
    { key: "a", label: "A", type: "string", ui: "input" },
    { key: "b", label: "B", type: "string", ui: "input" },
    { key: "c", label: "C", type: "string", ui: "input" },
    { key: "loose", label: "L", type: "string", ui: "input" },
  ],
  structure: {
    sections: [
      { key: "s1", title: "S1", groups: [{ key: "g1", title: "G1", params: ["a", "b"] }] },
      { key: "s2", title: "S2", groups: [{ key: "g2", title: "G2", params: ["c"] }] },
    ],
  },
  computed: [], constraints: [], bom: [], routing: [], queryTables: [],
  pricing: { priceExpr: "unitCost", quoteItemCode: "X" }, batchDefaults: [1],
} as ModelDef;

describe("structureOps", () => {
  test("parseRowKey round-trips", () => {
    expect(parseRowKey("s:1")).toEqual({ kind: "section", s: 1 });
    expect(parseRowKey("g:0.0")).toEqual({ kind: "group", s: 0, g: 0 });
    expect(parseRowKey("p:a")).toEqual({ kind: "param", key: "a" });
  });

  test("canDrop: param On group yes, param On section no, group Before group yes", () => {
    expect(canDrop(def, "p:a", "g:1.0", "On")).toBe(true);
    expect(canDrop(def, "p:a", "s:1", "On")).toBe(false);
    expect(canDrop(def, "g:0.0", "g:1.0", "Before")).toBe(true);
    expect(canDrop(def, "s:0", "s:1", "After")).toBe(true);
    expect(canDrop(def, "s:0", "g:1.0", "On")).toBe(false);
  });

  test("param dropped On another group moves across", () => {
    const out = applyMove(def, "p:a", "g:1.0", "On");
    expect(out.structure.sections[0]!.groups[0]!.params).toEqual(["b"]);
    expect(out.structure.sections[1]!.groups[0]!.params).toEqual(["c", "a"]);
  });

  test("param dropped Before a param in another group inserts there", () => {
    const out = applyMove(def, "p:b", "p:c", "Before");
    expect(out.structure.sections[1]!.groups[0]!.params).toEqual(["b", "c"]);
    expect(out.structure.sections[0]!.groups[0]!.params).toEqual(["a"]);
  });

  test("section reorder", () => {
    const out = applyMove(def, "s:1", "s:0", "Before");
    expect(out.structure.sections.map((s) => s.key)).toEqual(["s2", "s1"]);
  });

  test("removing a group keeps its params as unplaced", () => {
    const out = removeFromStructure(def, { kind: "group", s: 0, g: 0 });
    expect(out.structure.sections[0]!.groups).toEqual([]);
    expect(out.parameters.map((p) => p.key)).toContain("a"); // defs stay
    expect(unplacedParams(out)).toEqual(expect.arrayContaining(["a", "b", "loose"]));
  });

  test("placeParam appends and removes from any previous spot", () => {
    const out = placeParam(def, "loose", 1, 0);
    expect(out.structure.sections[1]!.groups[0]!.params).toEqual(["c", "loose"]);
    expect(unplacedParams(out)).toEqual([]);
  });
});
