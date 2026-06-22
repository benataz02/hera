// Static checks for an authored model: every expression parses, constraint vars are real
// parameters, and constraints reference only finite-domain params (free inputs belong in formulas).
// Used by config.save (reject bad models) and the builder (show errors live).
import type { Model } from "./types.ts";
import { compile } from "./expr.ts";

export function lintModel(model: Model): string[] {
  const errs: string[] = [];
  const names = new Set(model.parameters.map((p) => p.name));
  const inputs = new Set(
    model.parameters.filter((p) => p.domain.kind === "input" || p.domain.kind === "datasource").map((p) => p.name),
  );
  const tryParse = (expr: string, where: string): void => {
    try { compile(expr); } catch (e) { errs.push(`${where}: ${(e as Error).message}`); }
  };

  if (!model.parameters.length) errs.push("model has no parameters");

  for (const c of model.constraints) {
    tryParse(c.expr, `constraint "${c.expr}"`);
    for (const v of c.vars) {
      if (!names.has(v)) errs.push(`constraint references unknown parameter '${v}'`);
      else if (inputs.has(v)) errs.push(`constraint uses '${v}', but free-input/datasource params can't be propagated — use a formula`);
    }
  }
  for (const f of model.formulas) tryParse(f.expr, `formula '${f.name}'`);
  for (const l of model.bom) {
    tryParse(l.item, "bom item");
    tryParse(l.qtyExpr, "bom qty");
    if (l.condition) tryParse(l.condition, "bom condition");
  }
  for (const o of model.routing) {
    tryParse(o.timeExpr, `routing '${o.operation}' time`);
    if (o.condition) tryParse(o.condition, `routing '${o.operation}' condition`);
  }
  tryParse(model.pricing.costExpr, "pricing cost");
  tryParse(model.pricing.markupExpr, "pricing markup");
  return errs;
}
