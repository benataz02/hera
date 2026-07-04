import { describe, expect, test } from "bun:test";
import type { ModelDef, Outputs } from "@hera/config-engine";
import {
  bestByBatch, candidateLabel, cleanOverrides, isEdited, isRemoved, isSelected, openKeys,
  patchBom, resetLine, toggleSelection, withoutRemovals, type Candidate, type Sel,
} from "./runView.ts";

const param = (key: string) => ({ key, label: key, type: "string" as const, ui: "select" as const });
const model: ModelDef = {
  name: "m", computed: [], constraints: [], bom: [], routing: [], queryTables: [],
  structure: { sections: [] }, pricing: { priceExpr: "0", quoteItemCode: "X" }, batchDefaults: [1],
  parameters: [param("material"), param("size"), param("coating")],
};
const out = (unitPrice: number): Outputs =>
  ({ bom: [], ops: [], materialPerUnit: 0, laborPerUnit: 0, unitCost: 0, unitPrice, batchTotal: unitPrice });
const cands: Candidate[] = [
  { assignment: { size: 1, material: "steel" }, perBatch: [{ batchQty: 10, outputs: out(5) }, { batchQty: 100, outputs: out(3) }] },
  { assignment: { size: 1, material: "alu" }, perBatch: [{ batchQty: 10, outputs: out(4) }, { batchQty: 100, outputs: out(3.5) }] },
];

describe("openKeys / candidateLabel", () => {
  test("excludes params fixed in the run's entries", () => {
    expect(openKeys(model, { size: 1 }, cands)).toEqual(["material"]);
  });
  test("orders by model parameter order, not assignment key order", () => {
    expect(openKeys(model, {}, cands)).toEqual(["material", "size"]);
  });
  test("label joins open values with a dot separator", () => {
    expect(candidateLabel(["material", "size"], cands[0]!.assignment)).toBe("steel · 1");
    expect(candidateLabel([], cands[0]!.assignment)).toBe("Configuration");
  });
});

describe("bestByBatch", () => {
  test("lowest unit price per batch column wins", () => {
    expect(bestByBatch(cands)).toEqual({ 10: 1, 100: 0 });
  });
});

describe("selection toggling", () => {
  test("toggle adds, toggles off only the exact cell, preserves other overrides", () => {
    let sel: Sel[] = [{ candidateIdx: 0, batchQty: 10, overrides: { bom: [{ id: "l1", qtyPerUnit: 2 }] } }];
    sel = toggleSelection(sel, 1, 10);
    expect(sel).toHaveLength(2);
    expect(isSelected(sel, 1, 10)).toBe(true);
    sel = toggleSelection(sel, 1, 10);
    expect(sel).toEqual([{ candidateIdx: 0, batchQty: 10, overrides: { bom: [{ id: "l1", qtyPerUnit: 2 }] } }]);
  });
});

describe("override editing", () => {
  test("patchBom creates the entry, then merges later patches", () => {
    let ov = patchBom({}, "l1", { qtyPerUnit: 3 });
    ov = patchBom(ov, "l1", { unitPrice: 9 });
    expect(ov.bom).toEqual([{ id: "l1", qtyPerUnit: 3, unitPrice: 9 }]);
    expect(isEdited(ov, "bom", "l1")).toBe(true);
    expect(isEdited(ov, "bom", "nope")).toBe(false);
  });
  test("resetLine drops the entry", () => {
    const ov = resetLine(patchBom({}, "l1", { qtyPerUnit: 3 }), "bom", "l1");
    expect(ov.bom).toEqual([]);
    expect(isEdited(ov, "bom", "l1")).toBe(false);
  });
  test("withoutRemovals strips remove flags but keeps value edits", () => {
    const ov = patchBom(patchBom({}, "l1", { remove: true }), "l2", { qtyPerUnit: 7 });
    expect(isRemoved(ov, "bom", "l1")).toBe(true);
    expect(withoutRemovals(ov)!.bom).toEqual([{ id: "l1" }, { id: "l2", qtyPerUnit: 7 }]);
  });
  test("cleanOverrides drops empty objects so payloads stay minimal", () => {
    expect(cleanOverrides({})).toBeUndefined();
    expect(cleanOverrides(undefined)).toBeUndefined();
    expect(cleanOverrides({ bom: [{ id: "l1", qtyPerUnit: 1 }] })).toEqual({ bom: [{ id: "l1", qtyPerUnit: 1 }] });
  });
});
