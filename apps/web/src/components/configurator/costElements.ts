import { evaluate, type ModelDef, type Propagation, type ResolvedLookups } from "@hera/config-engine";

// The single source both the per-field price badges and the rail's Costs card read, so they
// cannot disagree. These figures are informational only — see the spec's non-goals: the
// calculated price still comes from computeOutputs (BOM + routing), untouched by any of this.

export type CostElement = { key: string; label: string; amount: number };

export function money(n: number, currency = "EUR"): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(n);
  } catch {
    // currency is free text a user typed in Settings — never let it throw the form away
    return `${n.toFixed(2)} ${currency}`;
  }
}

/** Priced, visible parameters with an evaluable numeric priceExpr, in model order. */
export function paramPrices(
  model: ModelDef,
  prop: Propagation,
  tables: ResolvedLookups["tables"],
): CostElement[] {
  const out: CostElement[] = [];
  for (const p of model.parameters) {
    // a field the rules have switched off must not bill for itself
    if (!p.priceExpr || !prop.visible[p.key]) continue;
    try {
      const v = evaluate(p.priceExpr, { vars: prop.values, tables });
      if (typeof v === "number" && Number.isFinite(v)) out.push({ key: p.key, label: p.label, amount: v });
    } catch {
      // undecidable while inputs are open — same silence as bindings() gives an unbound formula
    }
  }
  return out;
}
