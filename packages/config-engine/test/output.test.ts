import { describe, expect, test } from "bun:test";
import { DslError } from "../src/dsl";
import { computeOutputs, OutputOverridesZ } from "../src/output";
import { lookups, model } from "./fixture";

const full = { material: "steel", section: 16, coated: true, color: "black" };

describe("computeOutputs", () => {
  test("coated steel 16mm² at batch 100 — hand-computed", () => {
    const o = computeOutputs(model, lookups, full, 100);
    expect(o.bom.map((l) => l.id)).toEqual(["conductor", "coating"]);
    const [cond, coat] = o.bom;
    expect(cond!.itemCode).toBe("COND-steel");
    expect(cond!.desc).toBe("steel conductor");
    expect(cond!.qtyPerUnit).toBeCloseTo(0.32);
    expect(cond!.totalQty).toBeCloseTo(32);
    expect(cond!.unitPrice).toBeCloseTo(1.5);
    expect(cond!.lineTotal).toBeCloseTo(48);
    expect(coat!.totalQty).toBeCloseTo(105); // scrap 5%
    expect(o.materialPerUnit).toBeCloseTo(1.32);

    expect(o.ops.map((op) => op.id)).toEqual(["cut", "coat"]);
    const coatOp = o.ops[1]!;
    expect(coatOp.runMinPerUnit).toBeCloseTo(3.2);
    expect(coatOp.totalMin).toBeCloseTo(350);
    expect(coatOp.cost).toBeCloseTo(350);
    expect(o.laborPerUnit).toBeCloseTo(4.1);

    expect(o.unitCost).toBeCloseTo(5.42);
    expect(o.unitPrice).toBeCloseTo(7.588);
    expect(o.batchTotal).toBeCloseTo(758.8);
  });

  test("uncoated: conditional line and op drop out", () => {
    const o = computeOutputs(model, lookups, { material: "steel", section: 16, coated: false }, 100);
    expect(o.bom.map((l) => l.id)).toEqual(["conductor"]);
    expect(o.ops.map((op) => op.id)).toEqual(["cut"]);
  });

  test("setup amortization: bigger batch -> lower unit price", () => {
    const small = computeOutputs(model, lookups, full, 100);
    const big = computeOutputs(model, lookups, full, 1000);
    expect(big.unitPrice).toBeLessThan(small.unitPrice);
    expect(big.batchTotal).toBeGreaterThan(small.batchTotal);
  });

  test("missing lookup row surfaces as DslError", () => {
    const badLookups = structuredClone(lookups);
    badLookups.tables.prices!.rows = [];
    expect(() => computeOutputs(model, badLookups, full, 100)).toThrow(DslError);
  });

  test("batchQty must be >= 1", () => {
    expect(() => computeOutputs(model, lookups, full, 0)).toThrow(RangeError);
  });

  test("non-numeric expr result throws DslError", () => {
    const bad = structuredClone(model);
    bad.bom[0]!.qty = '"5"';
    expect(() => computeOutputs(bad, lookups, full, 100)).toThrow(DslError);
  });
});

describe("computeOutputs overrides", () => {
  // Base (coated steel 16mm², batch 100): materialPerUnit 1.32, laborPerUnit 4.1,
  // unitCost 5.42, unitPrice 7.588 — from the hand-computed test above.

  test("price override + op removal recompute the chain", () => {
    const o = computeOutputs(model, lookups, full, 100, {
      bom: [{ id: "coating", unitPrice: 1 }],
      ops: [{ id: "coat", remove: true }],
    });
    // coating: 1 * 1.05 (scrap) * 1.0 = 1.05; conductor unchanged 0.48
    expect(o.materialPerUnit).toBeCloseTo(1.53);
    expect(o.ops.map((op) => op.id)).toEqual(["cut"]);
    expect(o.laborPerUnit).toBeCloseTo(0.6);
    expect(o.unitCost).toBeCloseTo(2.13);
    expect(o.unitPrice).toBeCloseTo(2.982); // priceExpr (×1.4) re-applied
  });

  test("qty override replaces expr result, scrap still applies", () => {
    const o = computeOutputs(model, lookups, full, 100, {
      bom: [{ id: "coating", qtyPerUnit: 2 }],
    });
    const coat = o.bom.find((l) => l.id === "coating")!;
    expect(coat.qtyPerUnit).toBeCloseTo(2);
    expect(coat.totalQty).toBeCloseTo(210); // 2 * 1.05 * 100
    expect(o.materialPerUnit).toBeCloseTo(0.48 + 2 * 1.05 * 0.8);
  });

  test("added BOM line and added op join the totals", () => {
    const o = computeOutputs(model, lookups, full, 100, {
      addBom: [{ id: "pack", itemCode: "PACK-1", qtyPerUnit: 0.1, unitPrice: 2 }],
      addOps: [{ id: "qa", resource: "QA", setupMin: 0, runMinPerUnit: 0.6, ratePerHour: 60 }],
    });
    expect(o.bom.map((l) => l.id)).toEqual(["conductor", "coating", "pack"]);
    expect(o.bom[2]!.lineTotal).toBeCloseTo(20); // 0.1 * 100 * 2
    expect(o.materialPerUnit).toBeCloseTo(1.52);
    expect(o.ops.map((op) => op.id)).toEqual(["cut", "coat", "qa"]);
    expect(o.laborPerUnit).toBeCloseTo(4.7); // +0.6/min at 60/h = +0.6
    expect(o.unitCost).toBeCloseTo(6.22);
  });

  test("removing a BOM line", () => {
    const o = computeOutputs(model, lookups, full, 100, { bom: [{ id: "coating", remove: true }] });
    expect(o.bom.map((l) => l.id)).toEqual(["conductor"]);
    expect(o.materialPerUnit).toBeCloseTo(0.48);
  });

  test("no overrides object → identical to base", () => {
    const base = computeOutputs(model, lookups, full, 100);
    const same = computeOutputs(model, lookups, full, 100, {});
    expect(same).toEqual(base);
  });

  test("OutputOverridesZ accepts the shapes above", () => {
    expect(
      OutputOverridesZ.safeParse({
        bom: [{ id: "x", qtyPerUnit: 1, remove: false }],
        addOps: [{ id: "y", resource: "R", setupMin: 0, runMinPerUnit: 1, ratePerHour: 60 }],
      }).success,
    ).toBe(true);
  });
});
