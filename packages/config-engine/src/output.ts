import { DslError, evaluate, type Scope } from "./dsl";
import type { Entries, ModelDef, ResolvedLookups } from "./model";
import { bindings } from "./propagate";

export type BomResult = {
  id: string;
  itemCode: string;
  desc: string;
  qtyPerUnit: number;
  totalQty: number;
  unitPrice: number;
  lineTotal: number;
};
export type OpResult = {
  id: string;
  resource: string;
  setupMin: number;
  runMinPerUnit: number;
  totalMin: number;
  cost: number;
};
export type Outputs = {
  bom: BomResult[];
  ops: OpResult[];
  materialPerUnit: number;
  laborPerUnit: number;
  unitCost: number;
  unitPrice: number;
  batchTotal: number;
};

export function computeOutputs(
  model: ModelDef,
  lookups: ResolvedLookups,
  assignment: Entries,
  batchQty: number,
): Outputs {
  if (batchQty < 1) throw new RangeError(`batchQty must be >= 1, got ${batchQty}`);
  const { values } = bindings(model, lookups, assignment);
  const scope: Scope = { vars: { ...values, qty: batchQty }, tables: lookups.tables };
  const numeric = (src: string, what: string): number => {
    const v = evaluate(src, scope);
    if (typeof v !== "number") throw new DslError(`${what} did not evaluate to a number`, 0, src.length);
    return v;
  };
  const included = (condition: string | undefined) => condition === undefined || evaluate(condition, scope) === true;

  const bom: BomResult[] = [];
  let materialPerUnit = 0;
  for (const l of model.bom) {
    if (!included(l.condition)) continue;
    const qtyPerUnit = numeric(l.qty, `bom '${l.id}' qty`);
    const effQty = qtyPerUnit * (1 + l.scrapPct / 100);
    const unitPrice = numeric(l.price, `bom '${l.id}' price`);
    const itemCode = String(evaluate(l.itemCode, scope) ?? "");
    const desc = l.desc === undefined ? "" : String(evaluate(l.desc, scope) ?? "");
    const totalQty = effQty * batchQty;
    bom.push({ id: l.id, itemCode, desc, qtyPerUnit, totalQty, unitPrice, lineTotal: totalQty * unitPrice });
    materialPerUnit += effQty * unitPrice;
  }

  const ops: OpResult[] = [];
  let laborPerUnit = 0;
  for (const o of model.routing) {
    if (!included(o.condition)) continue;
    const setupMin = numeric(o.setupMin, `routing '${o.id}' setupMin`);
    const runMinPerUnit = numeric(o.runMinPerUnit, `routing '${o.id}' runMinPerUnit`);
    const rate = numeric(o.ratePerHour, `routing '${o.id}' ratePerHour`);
    const totalMin = setupMin + runMinPerUnit * batchQty;
    ops.push({ id: o.id, resource: o.resource, setupMin, runMinPerUnit, totalMin, cost: (totalMin / 60) * rate });
    laborPerUnit += ((setupMin / batchQty + runMinPerUnit) / 60) * rate;
  }

  const unitCost = materialPerUnit + laborPerUnit;
  const priceScope: Scope = { vars: { ...scope.vars, unitCost }, tables: lookups.tables };
  const unitPrice = evaluate(model.pricing.priceExpr, priceScope);
  if (typeof unitPrice !== "number") throw new DslError("pricing.priceExpr did not evaluate to a number", 0, model.pricing.priceExpr.length);
  // ponytail: raw floats end to end; currency rounding happens at the UI/quote edge
  return { bom, ops, materialPerUnit, laborPerUnit, unitCost, unitPrice, batchTotal: unitPrice * batchQty };
}
