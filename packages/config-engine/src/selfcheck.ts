// Runnable proof of the engine, assert-based (repo style — like scripts/e2e.ts, no framework).
// Fixture = the aluminium discrete-manufacturing example from the spec. Run:
//   bun run test:engine     (or: bun packages/config-engine/src/selfcheck.ts)
import assert from "node:assert/strict";
import type { Model, Assignment } from "./types.ts";
import { initialDomains, propagate, validate } from "./propagate.ts";
import { enumerate } from "./enumerate.ts";
import { evaluate, priceBatches } from "./evaluate.ts";
import { fit, packRect } from "./packing.ts";
import { buildPushDoc } from "./push.ts";

// Panels / plaques / button boxes from aluminium sheet. Demonstrates: datasource-free static and
// range domains, bidirectional constraints (printing<->qty<->format, quality<->machining),
// formulas using the packing helper, BOM + routing templates, and quantity-driven pricing.
const ALU: Model = {
  name: "Aluminium panel",
  family: "panels",
  parameters: [
    { name: "product", label: "Product", type: "enum", domain: { kind: "static", values: ["panel", "plaque", "buttonbox"] } },
    { name: "thickness", label: "Thickness (mm)", type: "number", domain: { kind: "static", values: [0.5, 1, 2, 3, 5, 8, 10] } },
    { name: "treatment", label: "Treatment", type: "enum", domain: { kind: "static", values: ["anodizing", "matt", "color"] } },
    { name: "printing", label: "Printing", type: "enum", domain: { kind: "static", values: ["serigraphy", "digital"] } },
    { name: "format", label: "Sheet format", type: "enum", domain: { kind: "static", values: ["1000x500", "500x500"] } },
    { name: "quality", label: "Quality", type: "enum", domain: { kind: "static", values: ["standard", "high"] } },
    { name: "machining", label: "Machining", type: "enum", domain: { kind: "static", values: ["punching", "laser", "milling"] } },
    { name: "qty", label: "Quantity", type: "number", domain: { kind: "static", values: [100, 500, 1000] } },
    { name: "width", label: "Piece width (mm)", type: "number", domain: { kind: "input" } },
    { name: "height", label: "Piece height (mm)", type: "number", domain: { kind: "input" } },
  ],
  constraints: [
    // Printing depends on quantity: serigraphy needs a run >= 500, digital is for runs <= 500.
    { expr: `printing != "serigraphy" or qty >= 500`, vars: ["printing", "qty"] },
    { expr: `printing != "digital" or qty <= 500`, vars: ["printing", "qty"] },
    // Sheet format depends on the printing method.
    { expr: `printing != "digital" or format == "1000x500"`, vars: ["printing", "format"] },
    { expr: `printing != "serigraphy" or format == "500x500"`, vars: ["printing", "format"] },
    // Machining depends on quality: high quality forbids punching; standard quality forbids milling.
    { expr: `quality != "high" or (machining == "laser" or machining == "milling")`, vars: ["quality", "machining"] },
    { expr: `quality != "standard" or (machining == "punching" or machining == "laser")`, vars: ["quality", "machining"] },
  ],
  formulas: [
    { name: "perSheet", expr: `fit(width, height, sheetW(format), sheetH(format))` },
    { name: "sheetsNeeded", expr: `perSheet > 0 ? ceil(qty / perSheet) : qty` },
    { name: "areaM2", expr: `width * height / 1000000` },
  ],
  bom: [
    { item: `concat("ALU-SHEET-", thickness)`, qtyExpr: "sheetsNeeded" },
    { item: `concat("TREAT-", treatment)`, qtyExpr: "areaM2 * qty" },
    { item: `concat("PRINT-", printing)`, qtyExpr: "qty" },
  ],
  routing: [
    { operation: "treatment", timeExpr: "areaM2 * qty * 3" },
    { operation: "printing", timeExpr: `printing == "serigraphy" ? 30 + qty * 0.05 : 5 + qty * 0.1` },
    { operation: "machining", timeExpr: `qty * (machining == "milling" ? 0.5 : machining == "laser" ? 0.3 : 0.1)` },
  ],
  // Fixed setup + per-sheet material (thicker = dearer) + per-piece handling. Setup amortises over
  // quantity, so unit price must fall as the batch grows.
  pricing: { costExpr: "200 + sheetsNeeded * (10 + thickness) + qty * 0.5", markupExpr: "0.3" },
};

export function runEngineSelfCheck(): void {
  // --- packing (pure) ---
  assert.equal(fit(120, 80, 1000, 500), 48, "48 pieces of 120x80 on a 1000x500 sheet");
  assert.equal(fit(120, 80, 500, 500), 24, "24 on a 500x500 sheet");
  assert.equal(fit(300, 300, 500, 500), 1, "one 300x300 per 500x500");
  assert.equal(fit(9999, 9999, 1000, 500), 0, "oversized piece fits nothing");
  assert.equal(packRect(300, 300, [[1000, 500], [500, 500]]).w, 1000, "min-waste format chosen");
  assert.equal(packRect(50, 50, [[1000, 500]]).perSheet, 200, "20x10 grid of 50mm pieces");
  assert.equal(packRect(9999, 9999, [[1000, 500]]).perSheet, 1, "no fit -> bespoke 1-up fallback");

  // --- propagation: directional narrowing ---
  const d = initialDomains(ALU);
  const pDigital = propagate(ALU, d, { printing: "digital" });
  assert.ok(pDigital.ok, "digital is consistent");
  assert.deepEqual(pDigital.domains.format, ["1000x500"], "digital -> format pinned to 1000x500");
  assert.deepEqual(pDigital.domains.qty, [100, 500], "digital -> qty 1000 removed");

  // --- propagation: BIDIRECTIONAL (the whole point) ---
  // Picking a machining option re-narrows quality, the opposite direction to how it was authored.
  const pPunch = propagate(ALU, d, { machining: "punching" });
  assert.ok(pPunch.ok, "punching is consistent");
  assert.deepEqual(pPunch.domains.quality, ["standard"], "machining=punching -> quality forced standard");

  // --- propagation: qty drives printing drives format (a 2-hop chain) ---
  const pQty = propagate(ALU, d, { qty: 100 });
  assert.ok(pQty.ok, "qty=100 consistent");
  assert.deepEqual(pQty.domains.printing, ["digital"], "qty=100 -> serigraphy removed");
  assert.deepEqual(pQty.domains.format, ["1000x500"], "qty=100 -> format pinned via printing");

  // --- propagation: inconsistency detected ---
  const bad = propagate(ALU, d, { printing: "digital", format: "500x500" });
  assert.equal(bad.ok, false, "digital + 500x500 is inconsistent");

  // --- enumerate: exact solution count under a fixed quantity ---
  // qty=100 forces printing=digital, format=1000x500. Free: product(3) x thickness(7) x
  // treatment(3) x valid (quality,machining) pairs(4) = 252.
  const all = enumerate(ALU, { qty: 100 }, { cap: 1000 });
  assert.equal(all.truncated, false, "252 < cap, not truncated");
  assert.equal(all.solutions.length, 252, "exact enumerated count");
  for (const s of all.solutions) {
    assert.equal(s.printing, "digital", "every solution: digital");
    assert.equal(s.format, "1000x500", "every solution: 1000x500");
    const pair = `${s.quality}/${s.machining}`;
    assert.ok(
      ["standard/punching", "standard/laser", "high/laser", "high/milling"].includes(pair),
      `valid quality/machining pair, got ${pair}`,
    );
  }
  // cap is honoured
  const capped = enumerate(ALU, { qty: 100 }, { cap: 50 });
  assert.equal(capped.solutions.length, 50, "cap limits results");
  assert.equal(capped.truncated, true, "and reports truncation");

  // --- validate: trust boundary ---
  const good: Assignment = {
    product: "panel", thickness: 2, treatment: "matt", printing: "digital",
    format: "1000x500", quality: "high", machining: "laser", qty: 100, width: 120, height: 80,
  };
  assert.deepEqual(validate(ALU, good), { ok: true }, "complete consistent config validates");
  assert.equal(validate(ALU, { ...good, format: "500x500" }).ok, false, "wrong format rejected");
  const { width: _w, ...noWidth } = good;
  assert.equal(validate(ALU, noWidth).ok, false, "missing input rejected");

  // --- evaluate: BOM / routing / formulas ---
  const ev = evaluate(ALU, good);
  assert.equal(ev.values.perSheet, 48, "perSheet from packing helper");
  assert.equal(ev.values.sheetsNeeded, 3, "ceil(100/48) = 3 sheets");
  assert.equal(ev.bom.length, 3, "three BOM lines");
  assert.equal(ev.bom[0]!.item, "ALU-SHEET-2", "sheet item code built from thickness");
  assert.equal(ev.bom[0]!.qty, 3, "sheet qty = sheetsNeeded");
  assert.equal(ev.routing.length, 3, "three routing ops");
  assert.ok(ev.price > 0, "priced");

  // --- pricing: economy of scale across batches ---
  const big: Assignment = { ...good, printing: "serigraphy", format: "500x500", qty: 1000 };
  const evBig = evaluate(ALU, big);
  assert.equal(evBig.values.sheetsNeeded, 42, "ceil(1000/24) = 42 sheets at 500x500");
  assert.ok(evBig.price / 1000 < ev.price / 100, "unit price falls as the batch grows");

  const batches = priceBatches(ALU, good, [100, 500, 1000]);
  assert.equal(batches.length, 3, "one price per batch");
  assert.ok(batches[0]!.perPiece > batches[2]!.perPiece, "per-piece price decreases with quantity");

  // --- B1 push document shaping (slice 5) ---
  const doc = buildPushDoc(
    { entity: "ProductTrees", map: { item: "ItemCode", qty: "Quantity" }, linesField: "ProductTreeLines", header: { TreeType: "iProductionTree" }, keyField: "TreeCode" },
    ev.bom as unknown as Record<string, unknown>[],
    "Q-123",
  );
  assert.deepEqual(
    doc,
    { TreeType: "iProductionTree", TreeCode: "Q-123", ProductTreeLines: [
      { ItemCode: "ALU-SHEET-2", Quantity: 3 },
      { ItemCode: "TREAT-matt", Quantity: ev.bom[1]!.qty },
      { ItemCode: "PRINT-digital", Quantity: 100 },
    ] },
    "BOM lines mapped into a B1 ProductTrees document",
  );

  console.log("config-engine self-check: OK (aluminium fixture — propagation, enumerate, validate, evaluate, pricing, packing)");
}

if (import.meta.main) runEngineSelfCheck();
