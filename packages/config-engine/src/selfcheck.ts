// Runnable proof of the engine, assert-based (repo style — like scripts/e2e.ts, no framework).
// Fixture = the aluminium discrete-manufacturing example from prompts/MODEL.md, authored as the
// real builder tree (groups -> items) and run through flatten() + the engine. Run:
//   bun run --filter @hera/config-engine selfcheck   (or: bun packages/config-engine/src/selfcheck.ts)
import assert from "node:assert/strict";
import type { Assignment, Model, InputType, DataSource } from "./types.ts";
import { flatten, orderFormulas } from "./flatten.ts";
import { initialDomains, propagate, validate } from "./propagate.ts";
import { enumerate } from "./enumerate.ts";
import { evaluate, priceBatches } from "./evaluate.ts";
import { fit, packRect } from "./packing.ts";
import { lintModel } from "./lint.ts";
import { aluminiumModel as ALU } from "./examples.ts";

export function runEngineSelfCheck(): void {
  const M = flatten(ALU);

  // --- flatten: tree -> engine shape ---
  assert.equal(M.parameters.length, 11, "11 parameters (8 finite + width/height/engraving free), formulas excluded");
  assert.equal(M.formulas.length, 3, "perSheet / sheetsNeeded / areaM2 are formulas");
  assert.equal(M.constraints.length, 6, "six rules carried as constraints");
  assert.equal(M.prices.length, 1, "one price line (on qty)");

  // --- packing (pure) ---
  assert.equal(fit(120, 80, 1000, 500), 48, "48 pieces of 120x80 on a 1000x500 sheet");
  assert.equal(fit(120, 80, 500, 500), 24, "24 on a 500x500 sheet");
  assert.equal(fit(300, 300, 500, 500), 1, "one 300x300 per 500x500");
  assert.equal(fit(9999, 9999, 1000, 500), 0, "oversized piece fits nothing");
  assert.equal(packRect(300, 300, [[1000, 500], [500, 500]]).w, 1000, "min-waste format chosen");
  assert.equal(packRect(50, 50, [[1000, 500]]).perSheet, 200, "20x10 grid of 50mm pieces");
  assert.equal(packRect(9999, 9999, [[1000, 500]]).perSheet, 1, "no fit -> bespoke 1-up fallback");

  // --- propagation: directional narrowing ---
  const d = initialDomains(M);
  const pDigital = propagate(M, d, { printing: "digital" });
  assert.ok(pDigital.ok, "digital is consistent");
  assert.deepEqual(pDigital.domains.format, ["1000x500"], "digital -> format pinned to 1000x500");
  assert.deepEqual(pDigital.domains.qty, [100, 500], "digital -> qty 1000 removed");

  // --- propagation: BIDIRECTIONAL (the whole point) ---
  const pPunch = propagate(M, d, { machining: "punching" });
  assert.ok(pPunch.ok, "punching is consistent");
  assert.deepEqual(pPunch.domains.quality, ["standard"], "machining=punching -> quality forced standard");

  // --- propagation: qty drives printing drives format (a 2-hop chain) ---
  const pQty = propagate(M, d, { qty: 100 });
  assert.ok(pQty.ok, "qty=100 consistent");
  assert.deepEqual(pQty.domains.printing, ["digital"], "qty=100 -> serigraphy removed");
  assert.deepEqual(pQty.domains.format, ["1000x500"], "qty=100 -> format pinned via printing");

  // --- propagation: inconsistency detected ---
  const bad = propagate(M, d, { printing: "digital", format: "500x500" });
  assert.equal(bad.ok, false, "digital + 500x500 is inconsistent");

  // --- enumerate: exact solution count under a fixed quantity ---
  // qty=100 forces printing=digital, format=1000x500. Free: product(3) x thickness(7) x
  // treatment(3) x valid (quality,machining) pairs(4) = 252. width/height/engraving are free
  // inputs, not enumerated.
  const all = enumerate(M, { qty: 100 }, { cap: 1000 });
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
  const capped = enumerate(M, { qty: 100 }, { cap: 50 });
  assert.equal(capped.solutions.length, 50, "cap limits results");
  assert.equal(capped.truncated, true, "and reports truncation");

  // --- validate: trust boundary + visibility ---
  const good: Assignment = {
    product: "panel", thickness: 2, treatment: "matt", printing: "digital",
    format: "1000x500", quality: "high", machining: "laser", qty: 100, width: 120, height: 80,
  };
  assert.deepEqual(validate(M, good), { ok: true }, "complete consistent panel validates (engraving hidden)");
  assert.equal(validate(M, { ...good, format: "500x500" }).ok, false, "wrong format rejected");
  const { width: _w, ...noWidth } = good;
  assert.equal(validate(M, noWidth).ok, false, "missing mandatory input rejected");
  // visibility: engraving is required only for plaques.
  assert.equal(validate(M, { ...good, product: "plaque" }).ok, false, "plaque without engraving rejected");
  assert.deepEqual(validate(M, { ...good, product: "plaque", engraving: "Suite 200" }), { ok: true }, "plaque with engraving validates");

  // --- evaluate: formulas + price ---
  const ev = evaluate(M, good);
  assert.equal(ev.values.perSheet, 48, "perSheet from packing helper");
  assert.equal(ev.values.sheetsNeeded, 3, "ceil(100/48) = 3 sheets");
  assert.equal(ev.price, 286, "price = 200 + 3*(10+2) + 100*0.5");

  // --- pricing: economy of scale across batches ---
  const big: Assignment = { ...good, printing: "serigraphy", format: "500x500", qty: 1000 };
  const evBig = evaluate(M, big);
  assert.equal(evBig.values.sheetsNeeded, 42, "ceil(1000/24) = 42 sheets at 500x500");
  assert.ok(evBig.price / 1000 < ev.price / 100, "unit price falls as the batch grows");

  const batches = priceBatches(M, good, [100, 500, 1000]);
  assert.equal(batches.length, 3, "one price per batch");
  assert.ok(batches[0]!.perPiece > batches[2]!.perPiece, "per-piece price decreases with quantity");

  console.log("config-engine self-check: OK (aluminium fixture — flatten, propagation, enumerate, validate, evaluate, pricing, packing, visibility)");
}

// Predefined (reusable) formula library: dependency ordering, cross-reference, cycle/collision lint.
export function runFormulaSelfCheck(): void {
  // orderFormulas: a depends on b -> b emitted first; mutual reference -> cycle reported.
  const ord = orderFormulas([{ name: "a", expr: "b + 1" }, { name: "b", expr: "2" }]);
  assert.deepEqual(ord.ordered.map((f) => f.name), ["b", "a"], "b ordered before a (a uses b)");
  assert.equal(ord.cycle, null, "no cycle");
  const cyc = orderFormulas([{ name: "a", expr: "b" }, { name: "b", expr: "a" }]).cycle;
  assert.ok(cyc && cyc.includes("a") && cyc.includes("b"), "a<->b cycle reported");

  // A library formula (declared out of dependency order) is reordered and readable by an item formula.
  const m: Model = {
    name: "T", family: "", rules: [],
    formulas: [
      { id: "f2", name: "lineTotal", expr: "unit * qty" }, // uses `unit`, declared below -> reorder
      { id: "f1", name: "unit", expr: "5" },
    ],
    sections: [{ id: "s", label: "S", groups: [{ id: "g", label: "G", items: [
      { id: "i1", name: "qty", label: "Qty", input: { mandatory: true, dataSource: { kind: "normal", values: [10, 20] }, inputType: "radio", value: { kind: "manual" } } },
      { id: "i2", name: "total", label: "Total", input: { mandatory: false, dataSource: { kind: "normal" }, inputType: "input", value: { kind: "formula", expr: "lineTotal" } } },
    ] }] }],
  };
  const M = flatten(m);
  assert.deepEqual(M.formulas.map((f) => f.name), ["unit", "lineTotal", "total"], "library reordered before item formula");
  assert.equal(evaluate(M, { qty: 20 }).values.total, 100, "item formula reads library: 5 * 20");
  assert.deepEqual(lintModel(m), [], "valid model with a formula library lints clean");

  // lint rejects a cyclic library and a formula name colliding with an item name.
  assert.ok(
    lintModel({ ...m, formulas: [{ id: "x", name: "a", expr: "b" }, { id: "y", name: "b", expr: "a" }] }).some((e) => e.includes("cycle")),
    "cyclic library rejected",
  );
  assert.ok(
    lintModel({ ...m, formulas: [{ id: "z", name: "qty", expr: "1" }] }).some((e) => /duplicate/i.test(e)),
    "formula name colliding with an item rejected",
  );
  assert.ok(
    lintModel({ ...m, formulas: [{ id: "z", name: "bad name", expr: "1" }] }).some((e) => /identifier/i.test(e)),
    "non-identifier formula name rejected",
  );
  console.log("config-engine self-check: OK (formula library — ordering, cross-reference, cycle/collision/identifier lint)");
}

// The data source — not the UI element — drives a parameter's domain. A Table/Query source resolves
// to a finite (datasource) domain whatever the inputType is, so the default inputType "input" with a
// Table source still loads its options (the value-help case). checkbox/multicombo are the exceptions.
export function runDataSourceSelfCheck(): void {
  const dom = (inputType: InputType, dataSource: DataSource) =>
    flatten({
      name: "T", family: "", rules: [],
      sections: [{ id: "s", label: "S", groups: [{ id: "g", label: "G", items: [
        { id: "i", name: "p", label: "P", input: { mandatory: false, dataSource, inputType, value: { kind: "manual" } } },
      ] }] }],
    }).parameters[0]!.domain;

  const table: DataSource = { kind: "table", tableId: "t1" };
  const query: DataSource = { kind: "query", source: "b1", path: "/Items", valueField: "ItemCode" };
  assert.equal(dom("input", table).kind, "datasource", "input + Table -> datasource (was 'input': the load bug)");
  assert.equal(dom("input", query).kind, "datasource", "input + Query -> datasource");
  assert.equal(dom("radio", table).kind, "datasource", "radio + Table -> datasource (regression)");
  assert.equal(dom("input", { kind: "normal" }).kind, "input", "input + normal(no values) -> free input");
  assert.equal(dom("input", { kind: "normal", values: [1, 2] }).kind, "static", "input + normal(values) -> static");
  assert.equal(dom("checkbox", table).kind, "static", "checkbox stays boolean even with a source");
  assert.equal(dom("multicombo", table).kind, "input", "multicombo stays a free (array) value");
  console.log("config-engine self-check: OK (data source drives the domain)");
}

if (import.meta.main) {
  runEngineSelfCheck();
  runFormulaSelfCheck();
  runDataSourceSelfCheck();
}
