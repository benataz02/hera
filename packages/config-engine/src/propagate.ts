import { evaluate } from "./dsl";
import type { Entries, ModelDef, Option, ResolvedLookups, Val } from "./model";

export type Bindings = {
  values: Record<string, Val>;
  defaulted: Set<string>;
  visible: Record<string, boolean>;
};

export function domainOf(model: ModelDef, lookups: ResolvedLookups, key: string): Option[] {
  const p = model.parameters.find((x) => x.key === key);
  if (!p) return [];
  if (p.type === "boolean")
    return [
      { value: true, label: "Yes" },
      { value: false, label: "No" },
    ];
  if (p.domain?.kind === "options") return lookups.domains[key] ?? [];
  return [];
}

export function bindings(model: ModelDef, lookups: ResolvedLookups, entries: Entries): Bindings {
  const values: Record<string, Val> = { ...entries };
  const defaulted = new Set<string>();
  const visible: Record<string, boolean> = {};
  const tryEval = (src: string): Val | undefined => {
    try {
      return evaluate(src, { vars: values, tables: lookups.tables });
    } catch {
      return undefined;
    }
  };

  const maxIter = model.parameters.length + model.computed.length + 1;
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (const p of model.parameters) {
      if (!(p.key in values) && p.defaultExpr !== undefined) {
        const v = tryEval(p.defaultExpr);
        if (v !== undefined) {
          values[p.key] = v;
          defaulted.add(p.key);
          changed = true;
        }
      }
    }
    for (const c of model.computed) {
      const v = tryEval(c.expr);
      if (v !== undefined && values[c.key] !== v) {
        values[c.key] = v;
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const p of model.parameters) {
    if (p.visibleWhen === undefined) {
      visible[p.key] = true;
      continue;
    }
    const v = tryEval(p.visibleWhen);
    visible[p.key] = v === undefined ? true : v === true;
  }
  return { values, defaulted, visible };
}
