// Static checks for an authored model: every expression parses, item names are unique, rule vars
// are real finite-domain items (free inputs belong in formulas/values, not rules). Used by
// models.save (reject bad models) and the builder (show errors live).
import type { Model } from "./types.ts";
import { compile } from "./expr.ts";
import { flatten } from "./flatten.ts";

export function lintModel(model: Model): string[] {
  const errs: string[] = [];
  const em = flatten(model);
  const names = new Set<string>([...em.parameters.map((p) => p.name), ...em.formulas.map((f) => f.name)]);
  const finite = new Set(
    em.parameters.filter((p) => p.domain.kind === "static" || p.domain.kind === "datasource").map((p) => p.name),
  );
  const tryParse = (expr: string, where: string): void => {
    try {
      compile(expr);
    } catch (e) {
      errs.push(`${where}: ${(e as Error).message}`);
    }
  };

  if (!em.parameters.length && !em.formulas.length) errs.push("model has no items");

  const seen = new Set<string>();
  for (const s of model.sections ?? []) {
    if (s.visibility) tryParse(s.visibility, `section "${s.label}" visibility`);
    for (const g of s.groups ?? []) {
      if (g.visibility) tryParse(g.visibility, `group "${g.label}" visibility`);
      for (const it of g.items) {
        if (!it.name) errs.push(`item "${it.label}" has no name`);
        else if (seen.has(it.name)) errs.push(`duplicate item name '${it.name}'`);
        seen.add(it.name);
        if (it.visibility) tryParse(it.visibility, `item '${it.name}' visibility`);
        if (it.input.value.kind === "formula") tryParse(it.input.value.expr, `item '${it.name}' value`);
        if (it.price) tryParse(it.price, `item '${it.name}' price`);
      }
    }
  }

  for (const c of model.rules) {
    tryParse(c.expr, `rule "${c.expr}"`);
    for (const v of c.vars) {
      if (!names.has(v)) errs.push(`rule references unknown item '${v}'`);
      else if (!finite.has(v))
        errs.push(`rule uses '${v}', but only finite-domain items (radio/checkbox/static) can be propagated — use a formula`);
    }
  }

  return errs;
}
