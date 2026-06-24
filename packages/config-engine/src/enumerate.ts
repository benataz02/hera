// "Visualize the possible configurations": backtracking search that maintains arc consistency.
// Returns every complete, consistent assignment (capped) given the current partial assignment.
import type { EngineModel, Assignment, Value } from "./types.ts";
import { initialDomains, propagate } from "./propagate.ts";

export interface EnumerateResult {
  solutions: Assignment[];
  truncated: boolean;
}

export function enumerate(
  model: EngineModel,
  assignment: Assignment = {},
  opts: { resolved?: Record<string, Value[]>; cap?: number } = {},
): EnumerateResult {
  const cap = opts.cap ?? 200;
  const domains = initialDomains(model, opts.resolved ?? {});
  const finite = model.parameters.filter((p) => p.name in domains).map((p) => p.name);
  const solutions: Assignment[] = [];
  let truncated = false;

  const search = (asg: Assignment): void => {
    if (truncated) return;
    const pr = propagate(model, domains, asg);
    if (!pr.ok) return;
    const open = finite.find((n) => pr.domains[n]!.length > 1);
    if (open === undefined) {
      // Every finite param is a singleton -> a complete solution (input params ride along).
      const sol: Assignment = { ...asg };
      for (const n of finite) sol[n] = pr.domains[n]![0]!;
      solutions.push(sol);
      if (solutions.length >= cap) truncated = true;
      return;
    }
    for (const val of pr.domains[open]!) {
      if (truncated) return;
      search({ ...asg, [open]: val });
    }
  };

  search({ ...assignment });
  return { solutions, truncated };
}
