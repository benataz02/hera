// Turn a complete assignment into outputs: derived formula values and the summed per-item price.
// Assumes the assignment is already valid (call validate() at trust boundaries first).
import type { EngineModel, Assignment, Evaluated } from "./types.ts";
import { evalExpr, truthy } from "./expr.ts";
import { fit, packRect } from "./packing.ts";

const round2 = (x: number): number => Math.round(x * 100) / 100;

// Scalar helpers callable from any model expression. Scalar-only on purpose: values flow through
// expr-eval cleanly with no object/array plumbing.
const helpers: Record<string, unknown> = {
  fit,
  packRect,
  sheetW: (f: unknown) => Number(String(f).split("x")[0]),
  sheetH: (f: unknown) => Number(String(f).split("x")[1]),
  concat: (a: unknown, b: unknown) => String(a) + String(b),
};

// Build the expression scope: the assignment, the helpers, and every formula resolved in order
// (later formulas may reference earlier ones). Shared with validate() so visibility exprs that
// reference formula values evaluate the same way.
// ponytail: a formula over a not-yet-supplied input resolves to undefined instead of throwing, so
//           validate() can score a partial/invalid assignment without crashing. Complete valid
//           assignments (the only ones evaluate() is meant to price) have every var, so this never
//           masks a real result.
export function buildScope(model: EngineModel, assignment: Assignment): Record<string, unknown> {
  const scope: Record<string, unknown> = { ...assignment, ...helpers };
  for (const f of model.formulas) {
    if (f.name in assignment) continue; // a manual override (see Configurator) wins over the formula
    try {
      scope[f.name] = evalExpr(f.expr, scope);
    } catch {
      scope[f.name] = undefined;
    }
  }
  return scope;
}

export function evaluate(model: EngineModel, assignment: Assignment): Evaluated {
  const scope = buildScope(model, assignment);

  const values: Record<string, unknown> = {};
  for (const f of model.formulas) values[f.name] = scope[f.name];

  const prices = model.prices
    .filter((pl) => pl.visibility == null || truthy(evalExpr(pl.visibility, scope)))
    .map((pl) => ({ name: pl.name, amount: round2(Number(evalExpr(pl.expr, scope))) }));
  const price = round2(prices.reduce((s, p) => s + p.amount, 0));

  return { values, prices, price };
}

// Price the same configuration across a set of quantities (the "price batches" comparison).
// ponytail: assumes the config stays valid across the batch; the runtime enumerates per batch, so
//           it only ever asks this for quantities it already proved valid.
export function priceBatches(
  model: EngineModel,
  assignment: Assignment,
  batches: number[],
  qtyParam = "qty",
): { qty: number; price: number; perPiece: number }[] {
  return batches.map((qty) => {
    const price = evaluate(model, { ...assignment, [qtyParam]: qty }).price;
    return { qty, price, perPiece: qty > 0 ? round2(price / qty) : price };
  });
}
