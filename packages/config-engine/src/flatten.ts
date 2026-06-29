// Turn the authored tree (groups -> items) into the flat shape the engine algorithm walks:
// finite/free parameters, derived formulas, the rule list, and per-item price lines. This is the
// bridge between MODEL.md's UI model and the proven parameter/constraint/formula engine.
import type { Model, EngineModel, Parameter, Formula, PriceLine, ParamDomain, FormItem, GuidedRule, GuidedCond, Value } from "./types.ts";

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
  // The data source — not the UI element — drives the domain (so the default inputType "input" with a
  // master-data source still resolves its options, e.g. for value help). Master data is finite once
  // resolved at runtime; a normal list with values is static; anything else is a free input.
  if (ds.kind === "masterdata") return { kind: "datasource", source: ds };
  return ds.kind === "normal" && ds.values?.length ? { kind: "static", values: ds.values } : { kind: "input" };
}

// Identifiers referenced in an expression (formula->formula deps, rule vars-completeness lint, the
// builder's varsOf). Returns function names (fit/ceil/…) too — callers intersect with known names.
export const idsIn = (expr: string): string[] => expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];

// Compile a guided when⇒then rule to one boolean expr (material implication): no `when` ⇒ the `then`
// conds hold unconditionally; otherwise not(all when) or (all then). The `expr` is authoritative —
// the builder derives `vars` from it (varsOf) and clears `guided` on a raw edit, so they can't drift.
// ponytail: emits a flat conjunction; no simplification (the engine caches the parse, so it's free).
const lit = (v: Value): string => (typeof v === "string" ? JSON.stringify(v) : String(v)); // strings quoted; engine string-compares
const condExpr = (c: GuidedCond): string => `${c.field} ${c.op} ${lit(c.value)}`;
export function compileGuided(g: GuidedRule): string {
  const thenExpr = g.then.length ? g.then.map((c) => `(${condExpr(c)})`).join(" and ") : "true";
  if (!g.when.length) return thenExpr;
  const whenExpr = g.when.map((c) => `(${condExpr(c)})`).join(" and ");
  return `not(${whenExpr}) or (${thenExpr})`;
}

// Dependency-order predefined formulas so `buildScope` (which resolves in array order) can read a
// formula's dependencies first. A depends on B when B's name appears in A's expr. Kahn's algorithm;
// the leftover on a cycle is returned so lint can report it (flatten still emits a best-effort order).
export function orderFormulas(
  formulas: { name: string; expr: string }[],
): { ordered: { name: string; expr: string }[]; cycle: string[] | null } {
  const names = new Set(formulas.map((f) => f.name));
  const deps = new Map(formulas.map((f) => [f.name, new Set(idsIn(f.expr).filter((d) => d !== f.name && names.has(d)))]));
  const byName = new Map(formulas.map((f) => [f.name, f]));
  const ordered: { name: string; expr: string }[] = [];
  const ready = formulas.filter((f) => deps.get(f.name)!.size === 0).map((f) => f.name);
  const emitted = new Set<string>();
  while (ready.length) {
    const n = ready.shift()!;
    if (emitted.has(n)) continue;
    emitted.add(n);
    ordered.push(byName.get(n)!);
    for (const [m, ds] of deps) {
      if (ds.delete(n) && ds.size === 0 && !emitted.has(m)) ready.push(m);
    }
  }
  const cycle = formulas.filter((f) => !emitted.has(f.name)).map((f) => f.name);
  return { ordered: [...ordered, ...formulas.filter((f) => !emitted.has(f.name))], cycle: cycle.length ? cycle : null };
}

export function flatten(model: Model): EngineModel {
  const parameters: Parameter[] = [];
  // Predefined (reusable) formulas first, in dependency order, so item-derived formulas below can
  // reference them. ponytail: a predefined formula referencing an *item* formula won't resolve (items
  // come after); cycles are surfaced by lint, not here. Promote to a single combined topo-sort if so.
  const formulas: Formula[] = orderFormulas(
    (model.formulas ?? []).map((f) => ({ name: f.name, expr: f.expr })),
  ).ordered;
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
