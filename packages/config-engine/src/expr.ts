import { Parser } from "expr-eval";

// One safe expression evaluator for the whole engine — no `eval`, no code execution.
// propagate() re-checks the same rule thousands of times during its support search, so the parsed
// form is cached; helper functions (fit/concat/...) are supplied per-call in `scope`, which keeps
// the parse independent of the data and safe to cache.
const parser = new Parser();
type Compiled = { evaluate(scope: Record<string, unknown>): unknown };
const cache = new Map<string, Compiled>();

export function compile(expr: string): Compiled {
  let c = cache.get(expr);
  if (!c) {
    c = parser.parse(expr) as unknown as Compiled;
    cache.set(expr, c);
  }
  return c;
}

export function evalExpr(expr: string, scope: Record<string, unknown>): unknown {
  return compile(expr).evaluate(scope);
}

// Rules/conditions/visibility must evaluate to a real boolean true. Anything else is "not satisfied".
export const truthy = (v: unknown): boolean => v === true;
