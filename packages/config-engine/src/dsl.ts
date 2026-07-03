import type { Val, ResolvedTable } from "./model";

export class DslError extends Error {
  constructor(
    message: string,
    public from: number,
    public to: number,
  ) {
    super(message);
  }
}

type Tok =
  | { k: "num"; v: number; from: number; to: number }
  | { k: "str"; v: string; from: number; to: number }
  | { k: "ident"; v: string; from: number; to: number }
  | { k: "op"; v: string; from: number; to: number }
  | { k: "eof"; v: ""; from: number; to: number };

// longest first so "==" wins over "="-less prefixes like "<"
const OPS = ["==", "!=", "<=", ">=", "&&", "||", "+", "-", "*", "/", "%", "<", ">", "!", "?", ":", "(", ")", ","];

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^[0-9]*\.?[0-9]+/.exec(src.slice(i))!;
      out.push({ k: "num", v: Number(m[0]), from: i, to: i + m[0].length });
      i += m[0].length;
      continue;
    }
    if (c === '"') {
      // ponytail: no escape sequences; add \" support if an author ever needs it
      const end = src.indexOf('"', i + 1);
      if (end < 0) throw new DslError("unterminated string", i, src.length);
      out.push({ k: "str", v: src.slice(i + 1, end), from: i, to: end + 1 });
      i = end + 1;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      const m = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(src.slice(i))!;
      out.push({ k: "ident", v: m[0], from: i, to: i + m[0].length });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new DslError(`unexpected character '${c}'`, i, i + 1);
    out.push({ k: "op", v: op, from: i, to: i + op.length });
    i += op.length;
  }
  out.push({ k: "eof", v: "", from: src.length, to: src.length });
  return out;
}

export type Ast =
  | { t: "lit"; v: Val; from: number; to: number }
  | { t: "ident"; name: string; from: number; to: number }
  | { t: "un"; op: "!" | "-"; e: Ast; from: number; to: number }
  | { t: "bin"; op: string; l: Ast; r: Ast; from: number; to: number }
  | { t: "tern"; c: Ast; a: Ast; b: Ast; from: number; to: number }
  | { t: "call"; name: string; args: Ast[]; from: number; to: number };

const BP: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "<": 3,
  "<=": 3,
  ">": 3,
  ">=": 3,
  "+": 4,
  "-": 4,
  "*": 5,
  "/": 5,
  "%": 5,
};

export function parse(src: string): Ast {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p]!;
  const next = () => toks[p++]!;
  const expectOp = (v: string): Tok => {
    const t = next();
    if (t.k !== "op" || t.v !== v) throw new DslError(`expected '${v}'`, t.from, t.to);
    return t;
  };

  function primary(): Ast {
    const t = next();
    if (t.k === "num" || t.k === "str") return { t: "lit", v: t.v, from: t.from, to: t.to };
    if (t.k === "ident") {
      if (t.v === "true" || t.v === "false") return { t: "lit", v: t.v === "true", from: t.from, to: t.to };
      if (t.v === "null") return { t: "lit", v: null, from: t.from, to: t.to };
      if (peek().k === "op" && peek().v === "(") {
        next();
        const args: Ast[] = [];
        if (!(peek().k === "op" && peek().v === ")")) {
          for (;;) {
            args.push(expr(0));
            if (peek().k === "op" && peek().v === ",") {
              next();
              continue;
            }
            break;
          }
        }
        const close = expectOp(")");
        return { t: "call", name: t.v, args, from: t.from, to: close.to };
      }
      return { t: "ident", name: t.v, from: t.from, to: t.to };
    }
    if (t.k === "op" && t.v === "(") {
      const e = expr(0);
      expectOp(")");
      return e;
    }
    throw new DslError("unexpected token", t.from, t.to);
  }

  function unary(): Ast {
    const t = peek();
    if (t.k === "op" && (t.v === "!" || t.v === "-")) {
      next();
      const e = unary();
      return { t: "un", op: t.v as "!" | "-", e, from: t.from, to: e.to };
    }
    return primary();
  }

  function bin(minBp: number): Ast {
    let l = unary();
    for (;;) {
      const t = peek();
      if (t.k !== "op") break;
      const bp = BP[t.v];
      if (bp === undefined || bp < minBp) break;
      next();
      const r = bin(bp + 1);
      l = { t: "bin", op: t.v, l, r, from: l.from, to: r.to };
    }
    return l;
  }

  function expr(minBp: number): Ast {
    const c = bin(minBp);
    const t = peek();
    if (t.k === "op" && t.v === "?") {
      next();
      const a = expr(0);
      expectOp(":");
      const b = expr(0);
      return { t: "tern", c, a, b, from: c.from, to: b.to };
    }
    return c;
  }

  const e = expr(0);
  const t = peek();
  if (t.k !== "eof") throw new DslError("unexpected trailing input", t.from, t.to);
  return e;
}

export type Scope = { vars: Record<string, Val>; tables?: Record<string, ResolvedTable> };

function show(v: Val): string {
  return v === null ? "null" : Array.isArray(v) ? "list" : JSON.stringify(v);
}
function num(v: Val, n: Ast): number {
  if (typeof v !== "number") throw new DslError(`expected number, got ${show(v)}`, n.from, n.to);
  return v;
}
function bool(v: Val, n: Ast): boolean {
  if (typeof v !== "boolean") throw new DslError(`expected boolean, got ${show(v)}`, n.from, n.to);
  return v;
}

export function evalAst(n: Ast, scope: Scope): Val {
  switch (n.t) {
    case "lit":
      return n.v;
    case "ident": {
      if (!(n.name in scope.vars)) throw new DslError(`unknown or unbound identifier '${n.name}'`, n.from, n.to);
      return scope.vars[n.name]!;
    }
    case "un": {
      const v = evalAst(n.e, scope);
      return n.op === "-" ? -num(v, n.e) : !bool(v, n.e);
    }
    case "bin": {
      if (n.op === "&&") return bool(evalAst(n.l, scope), n.l) ? bool(evalAst(n.r, scope), n.r) : false;
      if (n.op === "||") return bool(evalAst(n.l, scope), n.l) ? true : bool(evalAst(n.r, scope), n.r);
      const l = evalAst(n.l, scope);
      const r = evalAst(n.r, scope);
      if (n.op === "==" || n.op === "!=") {
        if (Array.isArray(l) || Array.isArray(r)) throw new DslError("cannot compare lists", n.from, n.to);
        return n.op === "==" ? l === r : l !== r;
      }
      const a = num(l, n.l);
      const b = num(r, n.r);
      switch (n.op) {
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "*":
          return a * b;
        case "/":
          if (b === 0) throw new DslError("division by zero", n.from, n.to);
          return a / b;
        case "%":
          if (b === 0) throw new DslError("modulo by zero", n.from, n.to);
          return a % b;
        case "<":
          return a < b;
        case "<=":
          return a <= b;
        case ">":
          return a > b;
        case ">=":
          return a >= b;
        default:
          throw new DslError(`unknown operator '${n.op}'`, n.from, n.to);
      }
    }
    case "tern":
      return bool(evalAst(n.c, scope), n.c) ? evalAst(n.a, scope) : evalAst(n.b, scope);
    case "call":
      return call(n, scope);
  }
}

function call(n: Extract<Ast, { t: "call" }>, scope: Scope): Val {
  const arg = (i: number) => evalAst(n.args[i]!, scope);
  const argN = (i: number) => num(arg(i), n.args[i]!);
  const arity = (min: number, max = min) => {
    if (n.args.length < min || n.args.length > max)
      throw new DslError(`${n.name} expects ${min === max ? min : `${min}-${max}`} arguments`, n.from, n.to);
  };
  switch (n.name) {
    case "IF":
      arity(3);
      return bool(arg(0), n.args[0]!) ? arg(1) : arg(2);
    case "MIN":
    case "MAX": {
      arity(1, 99);
      const vals = n.args.map((a, i) => argN(i));
      return n.name === "MIN" ? Math.min(...vals) : Math.max(...vals);
    }
    case "ROUND": {
      arity(1, 2);
      const f = 10 ** (n.args.length === 2 ? argN(1) : 0);
      return Math.round(argN(0) * f) / f;
    }
    case "CEIL":
      arity(1);
      return Math.ceil(argN(0));
    case "FLOOR":
      arity(1);
      return Math.floor(argN(0));
    case "ABS":
      arity(1);
      return Math.abs(argN(0));
    case "CONCAT":
      return n.args
        .map((a) => {
          const v = evalAst(a, scope);
          if (Array.isArray(v)) throw new DslError("cannot CONCAT a list", a.from, a.to);
          return v === null ? "" : String(v);
        })
        .join("");
    case "HAS": {
      arity(2);
      const l = arg(0);
      if (!Array.isArray(l))
        throw new DslError("HAS expects a multi-value parameter as first argument", n.args[0]!.from, n.args[0]!.to);
      return l.includes(arg(1) as string);
    }
    case "LOOKUP": {
      arity(4);
      const tn = arg(0);
      const kc = arg(1);
      const kv = arg(2);
      const vc = arg(3);
      if (typeof tn !== "string" || typeof kc !== "string" || typeof vc !== "string")
        throw new DslError("LOOKUP(table, keyCol, key, valueCol): table and columns must be strings", n.from, n.to);
      const table = scope.tables?.[tn];
      if (!table) throw new DslError(`unknown table '${tn}'`, n.args[0]!.from, n.args[0]!.to);
      const ki = table.columns.indexOf(kc);
      const vi = table.columns.indexOf(vc);
      if (ki < 0) throw new DslError(`unknown column '${kc}'`, n.args[1]!.from, n.args[1]!.to);
      if (vi < 0) throw new DslError(`unknown column '${vc}'`, n.args[3]!.from, n.args[3]!.to);
      const row = table.rows.find((r) => r[ki] === kv);
      if (!row) throw new DslError(`no '${tn}' row with ${kc} = ${show(kv)}`, n.from, n.to);
      return row[vi] ?? null;
    }
    default:
      throw new DslError(`unknown function '${n.name}'`, n.from, n.to);
  }
}

export function evaluate(src: string, scope: Scope): Val {
  return evalAst(parse(src), scope);
}
