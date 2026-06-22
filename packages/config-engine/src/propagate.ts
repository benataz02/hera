// The constraint propagation engine: AC-3 generalised arc consistency over finite domains.
// Bidirectional and order-independent — assigning any parameter re-narrows every other one to the
// values that still have support under the model's constraints. This is the canonical product-
// configuration engine; it is NOT a continuous numeric solver (see plan / ceiling note).
import type { Model, Domains, Assignment, Value, Constraint } from "./types.ts";
import { evalExpr, truthy } from "./expr.ts";

const round = (x: number): number => Math.round(x * 1e6) / 1e6;

// Expand a model's parameters into starting domains. `resolved` supplies datasource-backed values
// (fetched from B1 via entities.list); input params have no finite domain and are omitted.
export function initialDomains(model: Model, resolved: Record<string, Value[]> = {}): Domains {
  const domains: Domains = {};
  for (const p of model.parameters) {
    const d = p.domain;
    if (d.kind === "static") domains[p.name] = d.values.slice();
    else if (d.kind === "range") {
      const vals: Value[] = [];
      for (let x = d.min; x <= d.max + 1e-9; x = round(x + d.step)) vals.push(round(x));
      domains[p.name] = vals;
    } else if (d.kind === "datasource") {
      // Finite only when its values are supplied (browser fetched them from B1). Server-side
      // re-validation runs without them, so a datasource param falls back to a free input there:
      // the engine checks the static-domain logic and B1 rejects any bad master-data code.
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
export function propagate(model: Model, domains0: Domains, assignment: Assignment): PropagateResult {
  const domains: Domains = {};
  for (const k of Object.keys(domains0)) domains[k] = domains0[k]!.slice();

  // Pin assigned finite params to their chosen value (a value outside its domain = inconsistent).
  for (const [k, v] of Object.entries(assignment)) {
    if (!(k in domains)) continue; // input param
    if (!domains[k]!.includes(v)) return { ok: false, conflict: k };
    domains[k] = [v];
  }

  // Only constraints whose variables are all finite-domain participate.
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
      if (kept.length !== dv.length) { domains[v] = kept; changed.push(v); }
    }
    // Re-queue every constraint touching a variable we just narrowed (incl. this one).
    if (changed.length) {
      for (const c2 of cons) {
        if (!inQueue.has(c2) && c2.vars.some((v) => changed.includes(v))) { queue.push(c2); inQueue.add(c2); }
      }
    }
  }
  return { ok: true, domains };
}

// Does value `a` for variable `v` have support? i.e. exists a combination of the constraint's other
// variables (each from its CURRENT domain) that makes the boolean expression true.
// ponytail: brute-forces the product of the other vars' domains. Constraints are local (<=3-4 vars,
//           tens of values each) so this is cheap; swap for indexed GAC if a constraint ever spans
//           many high-cardinality variables.
function hasSupport(c: Constraint, v: string, a: Value, domains: Domains): boolean {
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

// Trust boundary. A configuration is valid iff propagation is consistent, every finite parameter is
// resolved to exactly its assigned value, and every input parameter is present. The server re-runs
// this on any client-submitted configuration before it is allowed to become a quote.
export function validate(
  model: Model,
  assignment: Assignment,
  resolved: Record<string, Value[]> = {},
): { ok: true } | { ok: false; reason: string } {
  const pr = propagate(model, initialDomains(model, resolved), assignment);
  if (!pr.ok) return { ok: false, reason: `inconsistent at '${pr.conflict}'` };
  for (const p of model.parameters) {
    if (!(p.name in pr.domains)) {
      if (!(p.name in assignment)) return { ok: false, reason: `missing input '${p.name}'` };
      continue;
    }
    const dom = pr.domains[p.name]!;
    if (dom.length !== 1) return { ok: false, reason: `unresolved '${p.name}'` };
    if (assignment[p.name] !== dom[0]) return { ok: false, reason: `'${p.name}' not pinned to its resolved value` };
  }
  return { ok: true };
}
