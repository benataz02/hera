// The constraint propagation engine: AC-3 generalised arc consistency over finite domains.
// Bidirectional and order-independent — assigning any parameter re-narrows every other one to the
// values that still have support under the model's rules. This is the canonical product-
// configuration engine; it is NOT a continuous numeric solver.
import type { EngineModel, Domains, Assignment, Value, Rule } from "./types.ts";
import { evalExpr, truthy } from "./expr.ts";
import { buildScope } from "./evaluate.ts";

// Expand a model's parameters into starting domains. `resolved` supplies datasource-backed values
// (fetched from a Table or a B1 Query at runtime); input params have no finite domain and are omitted.
export function initialDomains(model: EngineModel, resolved: Record<string, Value[]> = {}): Domains {
  const domains: Domains = {};
  for (const p of model.parameters) {
    const d = p.domain;
    if (d.kind === "static") domains[p.name] = d.values.slice();
    else if (d.kind === "datasource") {
      // Finite only when its values are supplied (resolved at runtime). Server-side re-validation
      // runs without them, so a datasource param falls back to a free input there: the engine checks
      // the static-rule logic and B1 rejects any bad master-data code downstream.
      const r = resolved[p.name];
      if (r && r.length) domains[p.name] = r.slice();
    }
    // kind === "input" (or unresolved datasource): free value carried in the assignment.
  }
  return domains;
}

export type PropagateResult =
  | { ok: true; domains: Domains }
  | { ok: false; conflict: string };

// Narrow `domains` given the current `assignment`, to a fixpoint. Returns the reduced domains, or
// the first variable whose domain went empty (the configuration is inconsistent).
export function propagate(model: EngineModel, domains0: Domains, assignment: Assignment): PropagateResult {
  const domains: Domains = {};
  for (const k of Object.keys(domains0)) domains[k] = domains0[k]!.slice();

  // Pin assigned finite params to their chosen value (a value outside its domain = inconsistent).
  for (const [k, v] of Object.entries(assignment)) {
    if (!(k in domains)) continue; // input param
    if (!domains[k]!.includes(v)) return { ok: false, conflict: k };
    domains[k] = [v];
  }

  // Only rules whose variables are all finite-domain participate.
  const cons = model.constraints.filter((c) => c.vars.every((v) => v in domains));
  const queue = [...cons];
  const inQueue = new Set(cons);

  while (queue.length) {
    const c = queue.shift()!;
    inQueue.delete(c);
    const changed: string[] = [];
    for (const v of c.vars) {
      const dv = domains[v]!;
      const kept = dv.filter((a) => hasSupport(c, v, a, domains));
      if (kept.length === 0) return { ok: false, conflict: v };
      if (kept.length !== dv.length) {
        domains[v] = kept;
        changed.push(v);
      }
    }
    // Re-queue every rule touching a variable we just narrowed (incl. this one).
    if (changed.length) {
      for (const c2 of cons) {
        if (!inQueue.has(c2) && c2.vars.some((v) => changed.includes(v))) {
          queue.push(c2);
          inQueue.add(c2);
        }
      }
    }
  }
  return { ok: true, domains };
}

// Does value `a` for variable `v` have support? i.e. exists a combination of the rule's other
// variables (each from its CURRENT domain) that makes the boolean expression true.
// ponytail: brute-forces the product of the other vars' domains. Rules are local (<=3-4 vars, tens
//           of values each) so this is cheap; swap for indexed GAC if a rule ever spans many
//           high-cardinality variables.
function hasSupport(c: Rule, v: string, a: Value, domains: Domains): boolean {
  const others = c.vars.filter((x) => x !== v);
  const scope: Record<string, unknown> = { [v]: a };
  return combo(others, 0, scope, c.expr, domains);
}

function combo(others: string[], i: number, scope: Record<string, unknown>, expr: string, domains: Domains): boolean {
  if (i === others.length) return truthy(evalExpr(expr, scope));
  const name = others[i]!;
  for (const val of domains[name]!) {
    scope[name] = val;
    if (combo(others, i + 1, scope, expr, domains)) return true;
  }
  return false;
}

// Trust boundary. A configuration is valid iff propagation is consistent, every *visible* finite
// parameter is resolved to exactly its assigned value, and every *visible mandatory* input is
// present. The server re-runs this on any client-submitted configuration before it becomes a quote.
// ponytail: visibility is judged on the complete assignment (deterministic). A hidden field is
//           neither required nor pinned — gate participation with a rule if a hidden field must
//           still constrain others.
export function validate(
  model: EngineModel,
  assignment: Assignment,
  resolved: Record<string, Value[]> = {},
): { ok: true } | { ok: false; reason: string; rule?: Rule } {
  const initial = initialDomains(model, resolved);
  const pr = propagate(model, initial, assignment);
  if (!pr.ok) return { ok: false, reason: `inconsistent at '${pr.conflict}'` };

  const scope = buildScope(model, assignment);
  // If a visibility expr can't be evaluated yet (references a value not supplied), treat the field
  // as shown — the conservative trust-boundary choice (it then gets required/pinned-checked).
  const visible = (expr?: string): boolean => {
    if (expr == null) return true;
    try {
      return truthy(evalExpr(expr, scope));
    } catch {
      return true;
    }
  };

  // CHECK rules: a rule with ≥1 free/numeric/multicombo/formula var can't narrow a finite domain (you
  // can't enumerate an infinite domain), so propagate() skipped it. It's enforced HERE as a boolean
  // post-condition, once all its vars have values. Checked before completeness so a violated numeric
  // rule surfaces in the live preview as soon as its inputs are filled (not gated behind every radio).
  // ponytail: numeric/free rules are post-checks, never propagated; add interval/linear propagation
  //           only if a numeric rule must narrow a picker.
  for (const c of model.constraints) {
    if (c.vars.every((v) => v in initial)) continue; // propagating rule — already enforced by propagate()
    if (!c.vars.every((v) => scope[v] !== undefined)) continue; // not all inputs present yet
    try {
      if (!truthy(evalExpr(c.expr, scope))) return { ok: false, reason: `rule not satisfied: ${c.label ?? c.expr}`, rule: c };
    } catch {
      /* unresolvable (type mismatch / mid-edit) -> not-yet-judgeable, stay conservative */
    }
  }

  for (const p of model.parameters) {
    const shown = visible(p.visibility);
    if (!(p.name in initial)) {
      // input param (free value)
      if (shown && p.mandatory && !(p.name in assignment)) return { ok: false, reason: `missing input '${p.name}'` };
      continue;
    }
    if (!shown) continue; // hidden finite param: not required
    const dom = pr.domains[p.name]!;
    if (dom.length !== 1) return { ok: false, reason: `unresolved '${p.name}'` };
    if (assignment[p.name] !== dom[0]) return { ok: false, reason: `'${p.name}' not pinned to its resolved value` };
  }
  return { ok: true };
}

// "Why is `value` unavailable for `param`?" Re-propagate with the OTHER picks (param's own pick
// excluded), then find the single rule under which `value` has no support — the rule that eliminated
// it. Reuses the private GAC `hasSupport`. The runtime computes this lazily (on a "why?" click) over
// the values it already knows were dropped — never per-option per-render.
// ponytail: single-rule attribution only; a transitive/multi-hop elimination returns null and the
//           caller shows a generic message. Chain via the conflict var if multi-hop ever matters.
export function explain(
  model: EngineModel,
  base: Domains,
  assignment: Assignment,
  param: string,
  value: Value,
): { rule: Rule; conflictVars: string[] } | null {
  const others = { ...assignment };
  delete others[param];
  const pr = propagate(model, base, others);
  if (!pr.ok) return null;
  for (const c of model.constraints) {
    if (!c.vars.includes(param)) continue;
    if (!c.vars.every((v) => v in pr.domains)) continue; // a check rule, not a finite eliminator
    if (!hasSupport(c, param, value, pr.domains)) return { rule: c, conflictVars: c.vars };
  }
  return null;
}
