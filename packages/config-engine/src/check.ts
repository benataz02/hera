import { type Ast, DslError, parse } from "./dsl";
import type { ModelDef } from "./model";

export type Issue = { path: string; message: string; from?: number; to?: number };

export const FUNCS = new Set(["IF", "MIN", "MAX", "ROUND", "CEIL", "FLOOR", "ABS", "CONCAT", "HAS", "LOOKUP"]);

type Ref = { name: string; from: number; to: number; kind: "ident" | "call" };

function collectRefs(n: Ast, out: Ref[]): void {
  switch (n.t) {
    case "lit":
      return;
    case "ident":
      out.push({ name: n.name, from: n.from, to: n.to, kind: "ident" });
      return;
    case "un":
      collectRefs(n.e, out);
      return;
    case "bin":
      collectRefs(n.l, out);
      collectRefs(n.r, out);
      return;
    case "tern":
      collectRefs(n.c, out);
      collectRefs(n.a, out);
      collectRefs(n.b, out);
      return;
    case "call":
      out.push({ name: n.name, from: n.from, to: n.to, kind: "call" });
      for (const a of n.args) collectRefs(a, out);
      return;
  }
}

export function checkModel(model: ModelDef, knownTables: string[] = []): Issue[] {
  const issues: Issue[] = [];
  const paramKeys = model.parameters.map((p) => p.key);
  const computedKeys = model.computed.map((c) => c.key);

  const seen = new Set<string>();
  for (const k of [...paramKeys, ...computedKeys]) {
    if (seen.has(k)) issues.push({ path: "model", message: `duplicate key '${k}'` });
    seen.add(k);
  }

  const base = new Set([...paramKeys, ...computedKeys]);
  const withQty = new Set([...base, "qty"]);
  const pricingScope = new Set([...withQty, "unitCost"]);

  const checkExpr = (src: string | undefined, path: string, allowed: Set<string>) => {
    if (src === undefined) return;
    try {
      const refs: Ref[] = [];
      collectRefs(parse(src), refs);
      for (const r of refs) {
        if (r.kind === "call") {
          if (!FUNCS.has(r.name)) issues.push({ path, message: `unknown function '${r.name}'`, from: r.from, to: r.to });
        } else if (!allowed.has(r.name)) {
          issues.push({ path, message: `unknown identifier '${r.name}'`, from: r.from, to: r.to });
        }
      }
    } catch (e) {
      if (!(e instanceof DslError)) throw e;
      issues.push({ path, message: e.message, from: e.from, to: e.to });
    }
  };

  model.parameters.forEach((p, i) => {
    checkExpr(p.defaultExpr, `parameters[${i}].defaultExpr`, base);
    checkExpr(p.visibleWhen, `parameters[${i}].visibleWhen`, base);
    checkExpr(p.requiredWhen, `parameters[${i}].requiredWhen`, base);
  });
  model.computed.forEach((c, i) => checkExpr(c.expr, `computed[${i}].expr`, base));
  model.constraints.forEach((c, i) => {
    if (c.kind === "expr") {
      checkExpr(c.when, `constraints[${i}].when`, base);
      checkExpr(c.assert, `constraints[${i}].assert`, base);
    } else {
      c.params.forEach((pk, j) => {
        const p = model.parameters.find((x) => x.key === pk);
        if (!p) issues.push({ path: `constraints[${i}].params[${j}]`, message: `unknown parameter '${pk}'` });
        else if (p.domain?.kind !== "options" && p.type !== "boolean")
          issues.push({ path: `constraints[${i}].params[${j}]`, message: `'${pk}' has no options domain` });
      });
      c.rows.forEach((row, j) => {
        if (row.length !== c.params.length)
          issues.push({ path: `constraints[${i}].rows[${j}]`, message: `row arity ${row.length} != ${c.params.length} values` });
      });
    }
  });
  model.bom.forEach((l, i) => {
    checkExpr(l.itemCode, `bom[${i}].itemCode`, withQty);
    checkExpr(l.desc, `bom[${i}].desc`, withQty);
    checkExpr(l.condition, `bom[${i}].condition`, withQty);
    checkExpr(l.qty, `bom[${i}].qty`, withQty);
    checkExpr(l.price, `bom[${i}].price`, withQty);
  });
  model.routing.forEach((o, i) => {
    checkExpr(o.condition, `routing[${i}].condition`, withQty);
    checkExpr(o.setupMin, `routing[${i}].setupMin`, withQty);
    checkExpr(o.runMinPerUnit, `routing[${i}].runMinPerUnit`, withQty);
    checkExpr(o.ratePerHour, `routing[${i}].ratePerHour`, withQty);
  });
  checkExpr(model.pricing.priceExpr, "pricing.priceExpr", pricingScope);

  // computed dependency cycles (computed -> computed edges only)
  const compSet = new Set(computedKeys);
  const deps = new Map<string, string[]>();
  for (const c of model.computed) {
    try {
      const refs: Ref[] = [];
      collectRefs(parse(c.expr), refs);
      deps.set(c.key, refs.filter((r) => r.kind === "ident" && compSet.has(r.name)).map((r) => r.name));
    } catch {
      deps.set(c.key, []); // parse error already reported
    }
  }
  const state = new Map<string, 1 | 2>(); // 1=visiting 2=done
  const visit = (k: string, path: string[]): void => {
    if (state.get(k) === 2) return;
    if (state.get(k) === 1) {
      issues.push({ path: "computed", message: `dependency cycle: ${[...path, k].join(" -> ")}` });
      return;
    }
    state.set(k, 1);
    for (const d of deps.get(k) ?? []) visit(d, [...path, k]);
    state.set(k, 2);
  };
  for (const k of computedKeys) visit(k, []);

  // structure references
  const placed = model.structure.sections.flatMap((s) => s.groups.flatMap((g) => g.params));
  for (const pk of placed) {
    if (!base.has(pk) || compSet.has(pk))
      issues.push({ path: "structure", message: `structure references unknown parameter '${pk}'` });
  }

  // LOOKUP table names when statically known (first arg is a string literal)
  const tables = new Set([...knownTables, ...model.queryTables.map((t) => t.name)]);
  const checkLookups = (src: string | undefined, path: string) => {
    if (src === undefined) return;
    let ast: Ast;
    try {
      ast = parse(src);
    } catch {
      return;
    }
    const walk = (n: Ast): void => {
      if (n.t === "call") {
        if (n.name === "LOOKUP" && n.args[0]?.t === "lit" && typeof n.args[0].v === "string" && !tables.has(n.args[0].v))
          issues.push({ path, message: `unknown table '${n.args[0].v}'`, from: n.args[0].from, to: n.args[0].to });
        n.args.forEach(walk);
      } else if (n.t === "un") walk(n.e);
      else if (n.t === "bin") {
        walk(n.l);
        walk(n.r);
      } else if (n.t === "tern") {
        walk(n.c);
        walk(n.a);
        walk(n.b);
      }
    };
    walk(ast);
  };
  model.bom.forEach((l, i) => checkLookups(l.price, `bom[${i}].price`));
  model.routing.forEach((o, i) => checkLookups(o.ratePerHour, `routing[${i}].ratePerHour`));

  return issues;
}
