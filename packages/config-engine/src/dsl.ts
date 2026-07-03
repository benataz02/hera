import type { Val } from "./model";

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
