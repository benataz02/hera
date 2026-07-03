import { z } from "zod";
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

// Step-4 review edits: per-line numeric overrides + add/remove, applied inside the same
// computation so unitCost/unitPrice/priceExpr stay consistent. Server and browser share this.
export const OutputOverridesZ = z.object({
  bom: z
    .array(
      z.object({
        id: z.string(),
        qtyPerUnit: z.number().min(0).optional(), // replaces the qty expr result, BEFORE scrap
        unitPrice: z.number().min(0).optional(),
        remove: z.boolean().optional(),
      }),
    )
    .optional(),
  ops: z
    .array(
      z.object({
        id: z.string(),
        setupMin: z.number().min(0).optional(),
        runMinPerUnit: z.number().min(0).optional(),
        ratePerHour: z.number().min(0).optional(),
        remove: z.boolean().optional(),
      }),
    )
    .optional(),
  addBom: z
    .array(
      z.object({
        id: z.string(),
        itemCode: z.string(),
        desc: z.string().optional(),
        qtyPerUnit: z.number().min(0),
        unitPrice: z.number().min(0),
      }),
    )
    .optional(),
  addOps: z
    .array(
      z.object({
        id: z.string(),
        resource: z.string(),
        setupMin: z.number().min(0),
        runMinPerUnit: z.number().min(0),
        ratePerHour: z.number().min(0),
      }),
    )
    .optional(),
});
export type OutputOverrides = z.infer<typeof OutputOverridesZ>;

export function computeOutputs(
  model: ModelDef,
  lookups: ResolvedLookups,
  assignment: Entries,
  batchQty: number,
  overrides?: OutputOverrides,
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
  const bomOv = new Map((overrides?.bom ?? []).map((o) => [o.id, o]));
  const opOv = new Map((overrides?.ops ?? []).map((o) => [o.id, o]));

  const bom: BomResult[] = [];
  let materialPerUnit = 0;
  for (const l of model.bom) {
    const ov = bomOv.get(l.id);
    if (ov?.remove || !included(l.condition)) continue;
    const qtyPerUnit = ov?.qtyPerUnit ?? numeric(l.qty, `bom '${l.id}' qty`);
    const effQty = qtyPerUnit * (1 + l.scrapPct / 100);
    const unitPrice = ov?.unitPrice ?? numeric(l.price, `bom '${l.id}' price`);
    const itemCode = String(evaluate(l.itemCode, scope) ?? "");
    const desc = l.desc === undefined ? "" : String(evaluate(l.desc, scope) ?? "");
    const totalQty = effQty * batchQty;
    bom.push({ id: l.id, itemCode, desc, qtyPerUnit, totalQty, unitPrice, lineTotal: totalQty * unitPrice });
    materialPerUnit += effQty * unitPrice;
  }
  for (const a of overrides?.addBom ?? []) {
    const totalQty = a.qtyPerUnit * batchQty; // added lines: no scrap, no condition
    bom.push({
      id: a.id, itemCode: a.itemCode, desc: a.desc ?? "",
      qtyPerUnit: a.qtyPerUnit, totalQty, unitPrice: a.unitPrice, lineTotal: totalQty * a.unitPrice,
    });
    materialPerUnit += a.qtyPerUnit * a.unitPrice;
  }

  const ops: OpResult[] = [];
  let laborPerUnit = 0;
  const pushOp = (id: string, resource: string, setupMin: number, runMinPerUnit: number, rate: number) => {
    const totalMin = setupMin + runMinPerUnit * batchQty;
    ops.push({ id, resource, setupMin, runMinPerUnit, totalMin, cost: (totalMin / 60) * rate });
    laborPerUnit += ((setupMin / batchQty + runMinPerUnit) / 60) * rate;
  };
  for (const o of model.routing) {
    const ov = opOv.get(o.id);
    if (ov?.remove || !included(o.condition)) continue;
    pushOp(
      o.id,
      o.resource,
      ov?.setupMin ?? numeric(o.setupMin, `routing '${o.id}' setupMin`),
      ov?.runMinPerUnit ?? numeric(o.runMinPerUnit, `routing '${o.id}' runMinPerUnit`),
      ov?.ratePerHour ?? numeric(o.ratePerHour, `routing '${o.id}' ratePerHour`),
    );
  }
  for (const a of overrides?.addOps ?? []) pushOp(a.id, a.resource, a.setupMin, a.runMinPerUnit, a.ratePerHour);

  const unitCost = materialPerUnit + laborPerUnit;
  const priceScope: Scope = { vars: { ...scope.vars, unitCost }, tables: lookups.tables };
  const unitPrice = evaluate(model.pricing.priceExpr, priceScope);
  if (typeof unitPrice !== "number")
    throw new DslError("pricing.priceExpr did not evaluate to a number", 0, model.pricing.priceExpr.length);
  // ponytail: raw floats end to end; currency rounding happens at the UI/quote edge
  return { bom, ops, materialPerUnit, laborPerUnit, unitCost, unitPrice, batchTotal: unitPrice * batchQty };
}
