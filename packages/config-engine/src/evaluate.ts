// Turn a complete assignment into outputs: derived values, BOM lines, routing ops, and price.
// Assumes the assignment is already valid (call validate() at trust boundaries first).
import type { Model, Assignment, Value, Evaluated } from "./types.ts";
import { evalExpr, truthy } from "./expr.ts";
import { fit } from "./packing.ts";

const round2 = (x: number): number => Math.round(x * 100) / 100;

// Scalar helpers callable from any model expression. Scalar-only on purpose: values flow through
// expr-eval cleanly with no object/array plumbing. packRect stays a JS export for tests/future use.
const helpers: Record<string, unknown> = {
  fit,
  sheetW: (f: unknown) => Number(String(f).split("x")[0]),
  sheetH: (f: unknown) => Number(String(f).split("x")[1]),
  concat: (a: unknown, b: unknown) => String(a) + String(b),
};

export function evaluate(model: Model, assignment: Assignment): Evaluated {
  const scope: Record<string, unknown> = { ...assignment, ...helpers };
  for (const f of model.formulas) scope[f.name] = evalExpr(f.expr, scope);

  const cond = (c?: string): boolean => c == null || truthy(evalExpr(c, scope));
  const num = (e: string): number => Number(evalExpr(e, scope));

  const bom = model.bom
    .filter((l) => cond(l.condition))
    .map((l) => ({ item: evalExpr(l.item, scope) as Value, qty: num(l.qtyExpr) }));
  const routing = model.routing
    .filter((o) => cond(o.condition))
    .map((o) => ({ operation: o.operation, time: num(o.timeExpr) }));

  const cost = num(model.pricing.costExpr);
  const markup = num(model.pricing.markupExpr);
  const price = round2(cost * (1 + markup));

  const values: Record<string, unknown> = {};
  for (const f of model.formulas) values[f.name] = scope[f.name];

  return { values, bom, routing, cost: round2(cost), markup, price };
}

// Price the same configuration across a set of quantities (the "price batches" comparison).
// ponytail: assumes the config stays valid across the batch; the runtime enumerates per batch, so
//           it only ever asks this for quantities it already proved valid.
export function priceBatches(
  model: Model,
  assignment: Assignment,
  batches: number[],
  qtyParam = "qty",
): { qty: number; price: number; perPiece: number }[] {
  return batches.map((qty) => {
    const price = evaluate(model, { ...assignment, [qtyParam]: qty }).price;
    return { qty, price, perPiece: qty > 0 ? round2(price / qty) : price };
  });
}
