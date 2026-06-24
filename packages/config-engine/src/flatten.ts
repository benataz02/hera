// Turn the authored tree (groups -> items) into the flat shape the engine algorithm walks:
// finite/free parameters, derived formulas, the rule list, and per-item price lines. This is the
// bridge between MODEL.md's UI model and the proven parameter/constraint/formula engine.
import type { Model, EngineModel, Parameter, Formula, PriceLine, ParamDomain, FormItem } from "./types.ts";

// Visibility is inherited down the tree: an item shows only if its section, group, and own
// visibility all hold. AND the present predicates so the engine/UI evaluate one expr per item.
function combineVis(...exprs: (string | undefined)[]): string | undefined {
  const present = exprs.filter((e): e is string => !!e);
  if (!present.length) return undefined;
  if (present.length === 1) return present[0];
  return present.map((e) => `(${e})`).join(" and ");
}

// How an item's pick is enumerated. Formula items are derived (handled as formulas, not params).
function itemDomain(it: FormItem): ParamDomain {
  const ds = it.input.dataSource;
  const t = it.input.inputType;
  if (t === "checkbox") return { kind: "static", values: [false, true] };
  // ponytail: multi-select rides as a free (array) value, not enumerated/propagated. Rules can't
  //           sensibly constrain a set; promote to per-option booleans if that ever changes.
  if (t === "multicombo") return { kind: "input" };
  if (t === "input") {
    return ds.kind === "normal" && ds.values?.length ? { kind: "static", values: ds.values } : { kind: "input" };
  }
  // radio
  if (ds.kind === "normal") return ds.values?.length ? { kind: "static", values: ds.values } : { kind: "input" };
  return { kind: "datasource", source: ds }; // table/query -> finite once resolved at runtime
}

export function flatten(model: Model): EngineModel {
  const parameters: Parameter[] = [];
  const formulas: Formula[] = [];
  const prices: PriceLine[] = [];

  // `?? []` tolerates a legacy/empty definition instead of throwing (returns no parameters).
  for (const s of model.sections ?? []) {
    for (const g of s.groups ?? []) {
      for (const it of g.items) {
        const visibility = combineVis(s.visibility, g.visibility, it.visibility);
        if (it.input.value.kind === "formula") {
          formulas.push({ name: it.name, expr: it.input.value.expr });
        } else {
          parameters.push({ name: it.name, label: it.label, domain: itemDomain(it), mandatory: it.input.mandatory, visibility });
        }
        if (it.price) prices.push({ name: it.name, expr: it.price, visibility });
      }
    }
  }

  return { parameters, constraints: model.rules, formulas, prices };
}
