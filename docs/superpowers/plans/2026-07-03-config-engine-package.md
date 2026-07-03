# Config Engine Package Implementation Plan (Phase 1 of Configurator)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `packages/config-engine` — the pure, isomorphic TypeScript configurator engine (DSL, model schema, constraint propagation, enumeration, BOM/routing computation) with a full `bun test` suite.

**Architecture:** One workspace package with zero I/O and a single dependency (zod). Everything is a pure function of `(ModelDef, ResolvedLookups, Entries)`. Browser will call it for live propagation previews; server will call the same code for authoritative runs (Phase 2). Spec: `docs/superpowers/specs/2026-07-03-configurator-design.md`.

**Tech Stack:** TypeScript (strict, ESM), zod ^4.4.3, bun test. No other deps.

## Global Constraints

- Package name `@hera/config-engine`; exports TS source directly like `@hera/db` (`"." : "./src/index.ts"`).
- `dependencies`: exactly `{ "zod": "^4.4.3" }`. Nothing else. No I/O, no `fetch`, no DB imports anywhere in the package.
- All DSL errors are `DslError` carrying `{ from, to }` character spans into the source string.
- DSL value type: `number | string | boolean | null | string[]` (`string[]` only for multicombo params; usable only in `HAS`).
- Semantics (fixed): strict equality without coercion (`==` on different types → `false`); arithmetic/comparison on non-numbers → error; `&&`/`||` boolean-only, short-circuit; division/modulo by zero → error; no string escapes in literals (`// ponytail:` it).
- Units (fixed): `setupMin` = minutes per batch, `runMinPerUnit` = minutes per finished unit, `ratePerHour` = cost per hour, BOM `qty` expr = quantity per finished unit, `scrapPct` = percent. Batch quantity is exposed to expressions as identifier `qty`; computed unit cost as `unitCost` (pricing only).
- Enumeration cap default = 200.
- Naming note vs spec: the spec's `pricing.marginExpr` is implemented as `pricing.priceExpr` (it computes the unit price, with `unitCost` in scope).
- Commit after every task. Run commands from the repo root `/home/benataz02/dev/hera`.

## File Structure

```
packages/config-engine/
  package.json
  tsconfig.json
  src/
    model.ts       zod schemas + types (ModelDef, LookupRef, ResolvedLookups, Entries, Val)
    dsl.ts         tokenizer + Pratt parser + evaluator + DslError (one focused file; parts change together)
    check.ts       checkModel(): static validation with span-accurate issues
    propagate.ts   bindings() (defaults/computed/visibility) + propagate() (domain fixpoint)
    enumerate.ts   DFS enumeration with cap
    output.ts      computeOutputs(): BOM/routing/cost/price per candidate × batch
    index.ts       re-exports (public API)
  test/
    fixture.ts     shared demo model (cable assembly) + resolved lookups
    model.test.ts  dsl.test.ts  check.test.ts  propagate.test.ts  enumerate.test.ts  output.test.ts
```

Pre-existing workspace facts (verified): root `package.json` and `apps/web/package.json` already declare `"@hera/config-engine": "workspace:*"` (stale refs healed by Task 1); root script `"test:engine": "bun packages/config-engine/src/selfcheck.ts"` is stale and gets rewritten in Task 1; `packages/db/tsconfig.json` is `{ "extends": "../../tsconfig.base.json", "include": ["src", "drizzle.config.ts"] }`.

---

### Task 1: Package scaffold + model schema + fixture

**Files:**
- Create: `packages/config-engine/package.json`
- Create: `packages/config-engine/tsconfig.json`
- Create: `packages/config-engine/src/model.ts`
- Create: `packages/config-engine/test/fixture.ts`
- Test: `packages/config-engine/test/model.test.ts`
- Modify: root `package.json` (fix `test:engine` script)

**Interfaces:**
- Produces: `ModelDefZ` (zod), types `ModelDef`, `Val`, `Option`, `ResolvedTable`, `ResolvedLookups`, `Entries`; fixture exports `model: ModelDef`, `lookups: ResolvedLookups`.
- Consumed by every later task.

- [ ] **Step 1: Create package files**

`packages/config-engine/package.json`:

```json
{
  "name": "@hera/config-engine",
  "type": "module",
  "private": true,
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/bun": "^1.3.14"
  }
}
```

`packages/config-engine/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

Update root `package.json` script (line ~31): replace
`"test:engine": "bun packages/config-engine/src/selfcheck.ts"` with
`"test:engine": "bun test packages/config-engine"`.

- [ ] **Step 2: Write the failing schema test**

`packages/config-engine/test/model.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { ModelDefZ } from "../src/model";
import { model } from "./fixture";

describe("ModelDefZ", () => {
  test("accepts the fixture model", () => {
    expect(() => ModelDefZ.parse(model)).not.toThrow();
  });

  test("rejects a parameter with a bad key", () => {
    const bad = structuredClone(model);
    bad.parameters[0]!.key = "1bad key";
    expect(() => ModelDefZ.parse(bad)).toThrow();
  });

  test("rejects unknown constraint kind", () => {
    const bad = structuredClone(model) as any;
    bad.constraints.push({ kind: "magic" });
    expect(() => ModelDefZ.parse(bad)).toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun install && bun test packages/config-engine`
Expected: FAIL — cannot resolve `../src/model` / `./fixture`.

- [ ] **Step 4: Write `src/model.ts`**

```ts
import { z } from "zod";

export type Val = number | string | boolean | null | string[];

const ValZ = z.union([z.number(), z.string(), z.boolean(), z.null()]);

export const LookupRefZ = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("manual"),
    options: z.array(z.object({ value: ValZ, label: z.string().optional() })),
  }),
  z.object({
    source: z.literal("table"),
    table: z.string(),
    valueCol: z.string(),
    labelCol: z.string().optional(),
  }),
  z.object({
    source: z.literal("query"),
    target: z.enum(["b1", "beas"]),
    path: z.string(),
    valueField: z.string(),
    labelField: z.string().optional(),
  }),
]);
export type LookupRef = z.infer<typeof LookupRefZ>;

const KeyZ = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "must be a valid identifier");

export const ParamZ = z.object({
  key: KeyZ,
  label: z.string(),
  type: z.enum(["string", "number", "boolean"]),
  ui: z.enum(["input", "select", "radio", "checkbox", "multicombo", "step"]),
  domain: z
    .union([
      z.object({ kind: z.literal("options"), ref: LookupRefZ }),
      z.object({ kind: z.literal("range"), min: z.number(), max: z.number(), step: z.number().optional() }),
    ])
    .optional(),
  defaultExpr: z.string().optional(),
  visibleWhen: z.string().optional(),
  requiredWhen: z.string().optional(),
  unit: z.string().optional(),
  help: z.string().optional(),
});
export type Param = z.infer<typeof ParamZ>;

export const ConstraintZ = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("expr"),
    when: z.string().optional(),
    assert: z.string(),
    message: z.string(),
  }),
  z.object({
    kind: z.literal("table"),
    params: z.array(KeyZ).min(2),
    rows: z.array(z.array(ValZ)),
    mode: z.enum(["allow", "forbid"]),
  }),
]);
export type Constraint = z.infer<typeof ConstraintZ>;

export const BomLineZ = z.object({
  id: z.string(),
  itemCode: z.string(), // expr
  desc: z.string().optional(), // expr
  condition: z.string().optional(), // expr -> boolean
  qty: z.string(), // expr, per finished unit; batch qty available as `qty`
  price: z.string(), // expr, cost per item unit
  scrapPct: z.number().default(0),
});

export const OperationZ = z.object({
  id: z.string(),
  resource: z.string(),
  condition: z.string().optional(),
  setupMin: z.string(), // expr, minutes per batch
  runMinPerUnit: z.string(), // expr, minutes per unit
  ratePerHour: z.string(), // expr, cost per hour
});

export const ModelDefZ = z.object({
  name: z.string(),
  parameters: z.array(ParamZ),
  structure: z.object({
    sections: z.array(
      z.object({
        key: KeyZ,
        title: z.string(),
        groups: z.array(z.object({ key: KeyZ, title: z.string(), params: z.array(KeyZ) })),
      }),
    ),
  }),
  computed: z.array(z.object({ key: KeyZ, expr: z.string() })),
  constraints: z.array(ConstraintZ),
  bom: z.array(BomLineZ),
  routing: z.array(OperationZ),
  queryTables: z.array(
    z.object({ name: z.string(), target: z.enum(["b1", "beas"]), path: z.string(), columns: z.array(z.string()) }),
  ),
  pricing: z.object({ priceExpr: z.string(), quoteItemCode: z.string().min(1) }),
  batchDefaults: z.array(z.number().int().positive()),
});
export type ModelDef = z.infer<typeof ModelDefZ>;

export type Option = { value: Val; label: string };
export type ResolvedTable = { columns: string[]; rows: Val[][] };
/** Everything external, already fetched: engine never sees source kinds. */
export type ResolvedLookups = {
  domains: Record<string, Option[]>;
  tables: Record<string, ResolvedTable>;
};
/** User-entered values only; absent key = open parameter. */
export type Entries = Record<string, Val>;
```

- [ ] **Step 5: Write `test/fixture.ts` (shared demo model)**

```ts
import type { ModelDef, ResolvedLookups } from "../src/model";

/** Cable assembly demo: exercises options/boolean/visibility, expr + table
 *  constraints, computed params, LOOKUP, scrap, setup amortization. */
export const model: ModelDef = {
  name: "Cable assembly",
  parameters: [
    {
      key: "material",
      label: "Conductor material",
      type: "string",
      ui: "select",
      domain: { kind: "options", ref: { source: "manual", options: [{ value: "steel" }, { value: "alu" }] } },
    },
    {
      key: "section",
      label: "Cross-section",
      type: "number",
      ui: "radio",
      unit: "mm²",
      domain: { kind: "options", ref: { source: "manual", options: [{ value: 10 }, { value: 16 }, { value: 25 }] } },
    },
    { key: "coated", label: "Coated", type: "boolean", ui: "checkbox", defaultExpr: "false" },
    {
      key: "color",
      label: "Coating color",
      type: "string",
      ui: "select",
      visibleWhen: "coated",
      domain: {
        kind: "options",
        ref: { source: "manual", options: [{ value: "red" }, { value: "black" }, { value: "blue" }] },
      },
    },
  ],
  structure: {
    sections: [
      {
        key: "main",
        title: "Cable",
        groups: [
          { key: "conductor", title: "Conductor", params: ["material", "section"] },
          { key: "coating", title: "Coating", params: ["coated", "color"] },
        ],
      },
    ],
  },
  computed: [{ key: "weight", expr: 'section * (material == "steel" ? 7.85 : 2.7) * 0.1' }],
  constraints: [
    { kind: "expr", assert: '!(material == "alu" && section == 25)', message: "25mm² not available in aluminium" },
    {
      kind: "table",
      params: ["material", "color"],
      rows: [
        ["steel", "red"],
        ["steel", "black"],
        ["alu", "black"],
        ["alu", "blue"],
      ],
      mode: "allow",
    },
  ],
  bom: [
    {
      id: "conductor",
      itemCode: 'CONCAT("COND-", material)',
      desc: 'CONCAT(material, " conductor")',
      qty: "section * 0.02",
      price: 'LOOKUP("prices", "code", CONCAT("COND-", material), "price")',
      scrapPct: 0,
    },
    {
      id: "coating",
      itemCode: '"COAT-1"',
      condition: "coated",
      qty: "1",
      price: "0.8",
      scrapPct: 5,
    },
  ],
  routing: [
    { id: "cut", resource: "SAW", setupMin: "10", runMinPerUnit: "0.5", ratePerHour: "60" },
    { id: "coat", resource: "COATER", condition: "coated", setupMin: "30", runMinPerUnit: "0.2 * section", ratePerHour: "60" },
  ],
  queryTables: [],
  pricing: { priceExpr: "unitCost * 1.4", quoteItemCode: "CABLE-CFG" },
  batchDefaults: [100, 500, 1000],
};

export const lookups: ResolvedLookups = {
  domains: {
    material: [
      { value: "steel", label: "steel" },
      { value: "alu", label: "alu" },
    ],
    section: [
      { value: 10, label: "10" },
      { value: 16, label: "16" },
      { value: 25, label: "25" },
    ],
    color: [
      { value: "red", label: "red" },
      { value: "black", label: "black" },
      { value: "blue", label: "blue" },
    ],
  },
  tables: {
    prices: {
      columns: ["code", "price"],
      rows: [
        ["COND-steel", 1.5],
        ["COND-alu", 2.5],
      ],
    },
  },
};
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test packages/config-engine`
Expected: 3 pass, 0 fail.

- [ ] **Step 7: Commit**

```bash
git add packages/config-engine package.json bun.lock
git commit -m "feat(config-engine): package scaffold, model schema, demo fixture"
```

---

### Task 2: DSL tokenizer + parser

**Files:**
- Create: `packages/config-engine/src/dsl.ts`
- Test: `packages/config-engine/test/dsl.test.ts`

**Interfaces:**
- Produces: `class DslError extends Error { from: number; to: number }`; `type Ast` (nodes `lit | ident | un | bin | tern | call`, all with `from`/`to`); `parse(src: string): Ast`; `tokenize(src: string)` (internal but exported for tests).
- Consumes: `Val` from `./model`.

- [ ] **Step 1: Write the failing parser tests** (`test/dsl.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import { DslError, parse } from "../src/dsl";

describe("parse", () => {
  test("precedence: 1 + 2 * 3 groups as 1 + (2*3)", () => {
    const ast = parse("1 + 2 * 3");
    expect(ast.t).toBe("bin");
    if (ast.t === "bin") {
      expect(ast.op).toBe("+");
      expect(ast.r.t).toBe("bin");
    }
  });

  test("comparison binds looser than arithmetic, && looser than ==", () => {
    const ast = parse('a + 1 > 2 && b == "x"');
    expect(ast.t).toBe("bin");
    if (ast.t === "bin") expect(ast.op).toBe("&&");
  });

  test("ternary", () => {
    const ast = parse("a > 1 ? 2 : 3");
    expect(ast.t).toBe("tern");
  });

  test("call with args and spans covering the whole call", () => {
    const src = 'LOOKUP("t", "k", x, "v")';
    const ast = parse(src);
    expect(ast.t).toBe("call");
    expect(ast.from).toBe(0);
    expect(ast.to).toBe(src.length);
  });

  test("true/false/null are literals", () => {
    expect(parse("true").t).toBe("lit");
    expect(parse("null").t).toBe("lit");
  });

  test("error carries span: unterminated string", () => {
    try {
      parse('CONCAT("abc');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DslError);
      expect((e as DslError).from).toBe(7);
    }
  });

  test("error carries span: trailing garbage", () => {
    try {
      parse("1 + 2 )");
      expect.unreachable();
    } catch (e) {
      expect((e as DslError).from).toBe(6);
      expect((e as DslError).to).toBe(7);
    }
  });

  test("unexpected character", () => {
    expect(() => parse("a $ b")).toThrow(DslError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/config-engine/test/dsl.test.ts`
Expected: FAIL — cannot resolve `../src/dsl`.

- [ ] **Step 3: Implement tokenizer + parser in `src/dsl.ts`**

```ts
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
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test packages/config-engine/test/dsl.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/config-engine/src/dsl.ts packages/config-engine/test/dsl.test.ts
git commit -m "feat(config-engine): DSL tokenizer and Pratt parser with span errors"
```

---

### Task 3: DSL evaluator

**Files:**
- Modify: `packages/config-engine/src/dsl.ts` (append evaluator)
- Test: `packages/config-engine/test/dsl.test.ts` (append)

**Interfaces:**
- Produces: `type Scope = { vars: Record<string, Val>; tables?: Record<string, ResolvedTable> }`; `evalAst(n: Ast, scope: Scope): Val`; `evaluate(src: string, scope: Scope): Val` (= `evalAst(parse(src), scope)`).
- Functions available in the DSL: `IF, MIN, MAX, ROUND, CEIL, FLOOR, ABS, CONCAT, HAS, LOOKUP`.

- [ ] **Step 1: Append failing evaluator tests to `test/dsl.test.ts`**

```ts
import { evaluate } from "../src/dsl";
import { lookups } from "./fixture";

describe("evaluate", () => {
  const scope = { vars: { a: 2, s: "steel", flag: true, empty: null as null }, tables: lookups.tables };

  test("arithmetic and precedence", () => {
    expect(evaluate("1 + a * 3", scope)).toBe(7);
    expect(evaluate("-a + 10", scope)).toBe(8);
    expect(evaluate("7 % 4", scope)).toBe(3);
  });

  test("strict equality without coercion", () => {
    expect(evaluate('s == "steel"', scope)).toBe(true);
    expect(evaluate('a == "2"', scope)).toBe(false);
    expect(evaluate("empty == null", scope)).toBe(true);
    expect(evaluate("empty != null", scope)).toBe(false);
  });

  test("boolean ops are strict and short-circuit", () => {
    expect(evaluate("flag && a > 1", scope)).toBe(true);
    expect(evaluate("!flag || a > 1", scope)).toBe(true);
    // short-circuit: RHS would error (unknown ident), but LHS decides
    expect(evaluate("!flag && nosuch > 1", scope)).toBe(false);
    expect(() => evaluate("a && flag", scope)).toThrow(DslError); // number as boolean
  });

  test("type errors carry the offending span", () => {
    try {
      evaluate('1 + "x"', scope);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DslError);
      expect((e as DslError).from).toBe(4); // the "x" literal
    }
  });

  test("division by zero errors", () => {
    expect(() => evaluate("1 / 0", scope)).toThrow(DslError);
    expect(() => evaluate("1 % 0", scope)).toThrow(DslError);
  });

  test("unknown identifier errors with span", () => {
    try {
      evaluate("a + nosuch", scope);
      expect.unreachable();
    } catch (e) {
      expect((e as DslError).from).toBe(4);
      expect((e as DslError).to).toBe(10);
    }
  });

  test("functions", () => {
    expect(evaluate("IF(a > 1, 10, 20)", scope)).toBe(10);
    expect(evaluate("MIN(3, 1, 2)", scope)).toBe(1);
    expect(evaluate("MAX(3, 1, 2)", scope)).toBe(3);
    expect(evaluate("ROUND(2.345, 2)", scope)).toBe(2.35);
    expect(evaluate("ROUND(2.5)", scope)).toBe(3);
    expect(evaluate("CEIL(1.01)", scope)).toBe(2);
    expect(evaluate("FLOOR(1.99)", scope)).toBe(1);
    expect(evaluate("ABS(0 - a)", scope)).toBe(2);
    expect(evaluate('CONCAT("x-", s, "-", a)', scope)).toBe("x-steel-2");
    expect(evaluate('CONCAT("n=", empty)', scope)).toBe("n=");
  });

  test("LOOKUP hits fixture table", () => {
    expect(evaluate('LOOKUP("prices", "code", "COND-alu", "price")', scope)).toBe(2.5);
  });

  test("LOOKUP errors: unknown table, column, missing row", () => {
    expect(() => evaluate('LOOKUP("nope", "code", "x", "price")', scope)).toThrow(DslError);
    expect(() => evaluate('LOOKUP("prices", "nope", "x", "price")', scope)).toThrow(DslError);
    expect(() => evaluate('LOOKUP("prices", "code", "MISSING", "price")', scope)).toThrow(DslError);
  });

  test("HAS on multi-value params; lists rejected elsewhere", () => {
    const s2 = { vars: { opts: ["a", "b"] as string[] } };
    expect(evaluate('HAS(opts, "a")', s2)).toBe(true);
    expect(evaluate('HAS(opts, "z")', s2)).toBe(false);
    expect(() => evaluate("opts + 1", s2)).toThrow(DslError);
    expect(() => evaluate('CONCAT(opts, "x")', s2)).toThrow(DslError);
  });

  test("unknown function errors", () => {
    expect(() => evaluate("NOPE(1)", scope)).toThrow(DslError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/config-engine/test/dsl.test.ts`
Expected: FAIL — `evaluate` not exported.

- [ ] **Step 3: Append evaluator to `src/dsl.ts`**

```ts
import type { ResolvedTable } from "./model";

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
```

Note: keep the existing `import type { Val } from "./model";` — merge the `ResolvedTable` import into it.

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test packages/config-engine/test/dsl.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/config-engine/src/dsl.ts packages/config-engine/test/dsl.test.ts
git commit -m "feat(config-engine): DSL evaluator with strict typed semantics"
```

---

### Task 4: Static model check (`check.ts`)

**Files:**
- Create: `packages/config-engine/src/check.ts`
- Test: `packages/config-engine/test/check.test.ts`

**Interfaces:**
- Produces: `type Issue = { path: string; message: string; from?: number; to?: number }`; `checkModel(model: ModelDef, knownTables?: string[]): Issue[]`. Empty array = model is valid. `knownTables` = names of tenant `config_table`s (server passes them in Phase 2); `model.queryTables[].name` and fixture-style resolved table names are added internally.
- Consumes: `parse`, `DslError`, `Ast` from `./dsl`; `ModelDef` from `./model`.

Context rules (fixed):
- Params/computed/constraints exprs may reference: parameter keys + computed keys.
- BOM and routing exprs may additionally reference `qty`.
- `pricing.priceExpr` may additionally reference `qty` and `unitCost`.
- Checks: expr parse errors; unknown identifiers; unknown functions; duplicate param/computed keys; computed dependency cycles; table constraints (params exist, have options domains, row arity = params length); structure references existing params.

- [ ] **Step 1: Write failing tests** (`test/check.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import { checkModel } from "../src/check";
import { model } from "./fixture";

describe("checkModel", () => {
  test("fixture model is clean", () => {
    expect(checkModel(model, ["prices"])).toEqual([]);
  });

  test("unknown identifier in a bom expr, with span and path", () => {
    const bad = structuredClone(model);
    bad.bom[0]!.qty = "sektion * 2";
    const issues = checkModel(bad, ["prices"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe("bom[0].qty");
    expect(issues[0]!.message).toContain("sektion");
    expect(issues[0]!.from).toBe(0);
    expect(issues[0]!.to).toBe(7);
  });

  test("qty allowed in bom but not in constraints", () => {
    const bad = structuredClone(model);
    bad.constraints.push({ kind: "expr", assert: "qty > 0", message: "x" });
    const issues = checkModel(bad, ["prices"]);
    expect(issues.some((i) => i.path === "constraints[2].assert")).toBe(true);
  });

  test("unitCost allowed only in pricing", () => {
    const bad = structuredClone(model);
    bad.bom[0]!.qty = "unitCost";
    expect(checkModel(bad, ["prices"]).length).toBe(1);
    expect(checkModel(model, ["prices"])).toEqual([]); // priceExpr uses unitCost and is fine
  });

  test("parse error surfaces with span", () => {
    const bad = structuredClone(model);
    bad.computed[0]!.expr = "1 + ";
    const issues = checkModel(bad, ["prices"]);
    expect(issues[0]!.path).toBe("computed[0].expr");
    expect(typeof issues[0]!.from).toBe("number");
  });

  test("computed cycle detected", () => {
    const bad = structuredClone(model);
    bad.computed = [
      { key: "a", expr: "b + 1" },
      { key: "b", expr: "a + 1" },
    ];
    const issues = checkModel(bad, ["prices"]);
    expect(issues.some((i) => i.message.includes("cycle"))).toBe(true);
  });

  test("duplicate keys detected", () => {
    const bad = structuredClone(model);
    bad.computed.push({ key: "material", expr: "1" });
    expect(checkModel(bad, ["prices"]).some((i) => i.message.includes("duplicate"))).toBe(true);
  });

  test("table constraint: bad arity and unknown param", () => {
    const bad = structuredClone(model);
    bad.constraints.push({ kind: "table", params: ["material", "nosuch"], rows: [["steel"]], mode: "allow" });
    const issues = checkModel(bad, ["prices"]);
    expect(issues.some((i) => i.message.includes("nosuch"))).toBe(true);
    expect(issues.some((i) => i.message.includes("arity") || i.message.includes("values"))).toBe(true);
  });

  test("structure referencing a missing param", () => {
    const bad = structuredClone(model);
    bad.structure.sections[0]!.groups[0]!.params.push("ghost");
    expect(checkModel(bad, ["prices"]).some((i) => i.message.includes("ghost"))).toBe(true);
  });

  test("unknown function reported", () => {
    const bad = structuredClone(model);
    bad.computed[0]!.expr = "NOPE(1)";
    expect(checkModel(bad, ["prices"]).some((i) => i.message.includes("NOPE"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/config-engine/test/check.test.ts`
Expected: FAIL — cannot resolve `../src/check`.

- [ ] **Step 3: Implement `src/check.ts`**

```ts
import { type Ast, DslError, parse } from "./dsl";
import type { ModelDef } from "./model";

export type Issue = { path: string; message: string; from?: number; to?: number };

const FUNCS = new Set(["IF", "MIN", "MAX", "ROUND", "CEIL", "FLOOR", "ABS", "CONCAT", "HAS", "LOOKUP"]);

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
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test packages/config-engine/test/check.test.ts`
Expected: all pass. (If the "table constraint" test's second assertion fails on wording, the message must contain either "arity" or "values" — adjust the implementation message, not the test.)

- [ ] **Step 5: Commit**

```bash
git add packages/config-engine/src/check.ts packages/config-engine/test/check.test.ts
git commit -m "feat(config-engine): static model checker with span-accurate issues"
```

---

### Task 5: Bindings — defaults, computed values, visibility

**Files:**
- Create: `packages/config-engine/src/propagate.ts`
- Test: `packages/config-engine/test/propagate.test.ts`

**Interfaces:**
- Produces: `type Bindings = { values: Record<string, Val>; defaulted: Set<string>; visible: Record<string, boolean> }`; `bindings(model: ModelDef, lookups: ResolvedLookups, entries: Entries): Bindings`; helper `domainOf(model, lookups, key): Option[]` (boolean params get `[{value:true,label:"Yes"},{value:false,label:"No"}]`; option params get `lookups.domains[key] ?? []`).
- Consumes: `evaluate`, `DslError` from `./dsl`.

Fixed rules:
- `values` = entries, then `defaultExpr` for absent params (evaluated with current values; skipped silently if it throws, e.g. references an unbound param), then computed (in array order, iterated to fixpoint so later-declared deps resolve; skipped silently while unevaluable).
- `visibleWhen`: `false` result ⇒ hidden; evaluation error (unbound refs) ⇒ visible. Hidden params keep any entered value in `values` (documented simplification) but are excluded from `open` later.
- Iterate the default/computed/visibility pass until `values` stops changing (bounded by `parameters.length + computed.length + 1` iterations).

- [ ] **Step 1: Write failing tests** (`test/propagate.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import { bindings, domainOf } from "../src/propagate";
import { lookups, model } from "./fixture";

describe("bindings", () => {
  test("entries pass through; defaults fill absent params", () => {
    const b = bindings(model, lookups, { material: "steel" });
    expect(b.values.material).toBe("steel");
    expect(b.values.coated).toBe(false); // defaultExpr "false"
    expect(b.defaulted.has("coated")).toBe(true);
    expect(b.values.section).toBeUndefined();
  });

  test("computed evaluates when deps bound, stays absent otherwise", () => {
    const b1 = bindings(model, lookups, { material: "steel", section: 16 });
    expect(b1.values.weight).toBeCloseTo(12.56);
    const b2 = bindings(model, lookups, { material: "steel" });
    expect(b2.values.weight).toBeUndefined();
  });

  test("visibility: color hidden when coated=false, visible when true", () => {
    expect(bindings(model, lookups, {}).visible.color).toBe(false); // coated defaults to false
    expect(bindings(model, lookups, { coated: true }).visible.color).toBe(true);
  });

  test("entry beats default", () => {
    const b = bindings(model, lookups, { coated: true });
    expect(b.values.coated).toBe(true);
    expect(b.defaulted.has("coated")).toBe(false);
  });

  test("domainOf: boolean synthesized, options from lookups", () => {
    expect(domainOf(model, lookups, "coated").map((o) => o.value)).toEqual([true, false]);
    expect(domainOf(model, lookups, "material")).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/config-engine/test/propagate.test.ts`
Expected: FAIL — cannot resolve `../src/propagate`.

- [ ] **Step 3: Implement `bindings` + `domainOf` in `src/propagate.ts`**

```ts
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
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test packages/config-engine/test/propagate.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/config-engine/src/propagate.ts packages/config-engine/test/propagate.test.ts
git commit -m "feat(config-engine): bindings (defaults, computed, visibility)"
```

---

### Task 6: Domain propagation fixpoint

**Files:**
- Modify: `packages/config-engine/src/propagate.ts` (append)
- Test: `packages/config-engine/test/propagate.test.ts` (append)

**Interfaces:**
- Produces:

```ts
export type DomainOption = { value: Val; label: string; eliminatedBy?: string };
export type Propagation = {
  values: Record<string, Val>;
  defaulted: Set<string>;
  visible: Record<string, boolean>;
  domains: Record<string, DomainOption[]>; // every option/boolean param, incl. bound ones
  conflicts: { message: string; path: string }[];
  open: string[]; // visible option/boolean params with no entry and no default
  candidateEstimate: number; // product of live domain sizes over `open` (1 if none)
};
export function propagate(model: ModelDef, lookups: ResolvedLookups, entries: Entries): Propagation;
```

Fixed algorithm:
1. `b = bindings(...)`. Domains initialized from `domainOf` for every param with an options domain or boolean type.
2. Fixpoint loop (bounded 50 iterations): for each constraint, try to eliminate values from domains of *unbound* member params (bound = key in `b.values`). Elimination sets `eliminatedBy` (constraint message for expr; `"combination table (<params>)"` for table); eliminated options stay in the array. Candidate testing re-runs `bindings` with the candidate entry merged, so computed values downstream of the candidate are fresh.
   - `table/allow`: keep rows matching all bound members; unbound member value survives iff it appears in a kept row (all-members check for rows also uses live domains of other unbound members — simple projection, no row elimination across constraints).
   - `table/forbid`: only when exactly 1 member unbound — value eliminated iff some row matches all bound values + it.
   - `expr`: active when `when` is absent, or fully evaluable and `true`. Referenced unbound option-params: 0 unbound → evaluate; `false` ⇒ conflict `{message, path:"constraints[i]"}`, eval error ⇒ ignore (unbound non-option refs). 1 unbound (p) → candidate v eliminated if assert is `false` OR throws with v bound. 2 unbound (p,q) → v∈dom(p) survives iff ∃ live w∈dom(q) with assert true; symmetric for q. ≥3 unbound → skip. `// ponytail: bounded propagation, full GAC if real models demand it`
3. Empty live domain of a visible unbound param ⇒ conflict `no valid values remain for '<key>'`.
4. `open`, `candidateEstimate` per the type doc above.

- [ ] **Step 1: Append failing tests**

```ts
import { propagate } from "../src/propagate";

describe("propagate", () => {
  test("expr constraint narrows section when material=alu", () => {
    const p = propagate(model, lookups, { material: "alu" });
    const sec = p.domains.section!;
    const s25 = sec.find((o) => o.value === 25)!;
    expect(s25.eliminatedBy).toBe("25mm² not available in aluminium");
    expect(sec.filter((o) => !o.eliminatedBy).map((o) => o.value)).toEqual([10, 16]);
  });

  test("reverse direction: section=25 eliminates alu", () => {
    const p = propagate(model, lookups, { section: 25 });
    const alu = p.domains.material!.find((o) => o.value === "alu")!;
    expect(alu.eliminatedBy).toBeTruthy();
  });

  test("table constraint filters color by material", () => {
    const p = propagate(model, lookups, { material: "alu", coated: true });
    const live = p.domains.color!.filter((o) => !o.eliminatedBy).map((o) => o.value);
    expect(live).toEqual(["black", "blue"]);
    expect(p.domains.color!.find((o) => o.value === "red")!.eliminatedBy).toContain("combination table");
  });

  test("fully bound violation becomes a conflict", () => {
    const p = propagate(model, lookups, { material: "alu", section: 25 });
    expect(p.conflicts.some((c) => c.message === "25mm² not available in aluminium")).toBe(true);
  });

  test("open excludes bound, defaulted and hidden params", () => {
    const p = propagate(model, lookups, { material: "steel" });
    // coated is defaulted(false) -> not open; color hidden -> not open
    expect(p.open).toEqual(["section"]);
    expect(p.candidateEstimate).toBe(3);
  });

  test("candidateEstimate multiplies live domains", () => {
    const p = propagate(model, lookups, { coated: true });
    // open: material(2) × section(3) × color(3) = 18 before narrowing;
    // no narrowing applies while material unbound (2-unbound support check keeps all)
    expect(p.open.sort()).toEqual(["color", "material", "section"]);
    expect(p.candidateEstimate).toBe(18);
  });

  test("2-unbound support check keeps values that have some support", () => {
    const p = propagate(model, lookups, { coated: true });
    // every color has a supporting material in the allow table except none -> red survives via steel
    expect(p.domains.color!.filter((o) => !o.eliminatedBy)).toHaveLength(3);
  });

  test("consistent full assignment: no conflicts, nothing open", () => {
    const p = propagate(model, lookups, { material: "steel", section: 16, coated: true, color: "black" });
    expect(p.conflicts).toEqual([]);
    expect(p.open).toEqual([]);
    expect(p.candidateEstimate).toBe(1);
  });

  test("undecidable constraint (domainless free-text ref) must NOT over-prune", () => {
    const m2 = structuredClone(model);
    m2.parameters.push({ key: "note", label: "Note", type: "string", ui: "input" });
    m2.structure.sections[0]!.groups[0]!.params.push("note");
    m2.constraints.push({ kind: "expr", assert: 'note != "x" || material == "steel"', message: "note rule" });
    const p = propagate(m2, lookups, {});
    // note is unbound and has no domain -> constraint undecidable -> material keeps both values
    expect(p.domains.material!.filter((o) => !o.eliminatedBy)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/config-engine/test/propagate.test.ts`
Expected: FAIL — `propagate` not exported.

- [ ] **Step 3: Append implementation to `src/propagate.ts`**

```ts
import { evaluate } from "./dsl";

export type DomainOption = { value: Val; label: string; eliminatedBy?: string };
export type Propagation = {
  values: Record<string, Val>;
  defaulted: Set<string>;
  visible: Record<string, boolean>;
  domains: Record<string, DomainOption[]>;
  conflicts: { message: string; path: string }[];
  open: string[];
  candidateEstimate: number;
};

const live = (d: DomainOption[]) => d.filter((o) => !o.eliminatedBy);

export function propagate(model: ModelDef, lookups: ResolvedLookups, entries: Entries): Propagation {
  const b = bindings(model, lookups, entries);
  const conflicts: Propagation["conflicts"] = [];
  const domains: Record<string, DomainOption[]> = {};
  for (const p of model.parameters) {
    const d = domainOf(model, lookups, p.key);
    if (d.length) domains[p.key] = d.map((o) => ({ ...o }));
  }
  const isBound = (k: string) => k in b.values;
  /** evaluate expr with a candidate binding merged in; recomputes defaults/computed */
  const evalWith = (src: string, extra: Entries): Val => {
    const v = bindings(model, lookups, { ...entries, ...extra }).values;
    return evaluate(src, { vars: v, tables: lookups.tables });
  };

  for (let iter = 0; iter < 50; iter++) {
    let changed = false;
    const kill = (key: string, value: Val, by: string) => {
      const o = domains[key]?.find((x) => x.value === value && !x.eliminatedBy);
      if (o) {
        o.eliminatedBy = by;
        changed = true;
      }
    };

    model.constraints.forEach((c, ci) => {
      if (c.kind === "table") {
        const by = `combination table (${c.params.join(", ")})`;
        const unbound = c.params.filter((k) => !isBound(k) && domains[k]);
        if (c.mode === "allow") {
          // rows compatible with bound values and live domains of other unbound params
          const rowOk = (row: Val[]) =>
            c.params.every((k, i) =>
              isBound(k) ? b.values[k] === row[i] : (live(domains[k] ?? []).some((o) => o.value === row[i]) ?? false),
            );
          const kept = c.rows.filter(rowOk);
          for (const k of unbound) {
            const i = c.params.indexOf(k);
            for (const o of live(domains[k]!)) {
              if (!kept.some((row) => row[i] === o.value)) kill(k, o.value, by);
            }
          }
          if (unbound.length === 0 && c.rows.length > 0 && !c.rows.some((row) => c.params.every((k, i) => b.values[k] === row[i])))
            conflicts.push({ message: by + " violated", path: `constraints[${ci}]` });
        } else if (unbound.length === 1) {
          const k = unbound[0]!;
          const i = c.params.indexOf(k);
          for (const o of live(domains[k]!)) {
            if (c.rows.some((row) => c.params.every((pk, j) => (j === i ? row[j] === o.value : b.values[pk] === row[j]))))
              kill(k, o.value, by);
          }
        } else if (unbound.length === 0) {
          if (c.rows.some((row) => c.params.every((k, i) => b.values[k] === row[i])))
            conflicts.push({ message: by + " violated", path: `constraints[${ci}]` });
        }
        return;
      }

      // expr constraint
      if (c.when !== undefined) {
        try {
          if (evaluate(c.when, { vars: b.values, tables: lookups.tables }) !== true) return;
        } catch {
          return; // when not yet decidable -> inactive
        }
      }
      let refNames: string[];
      try {
        const refs: { name: string }[] = [];
        const walk = (n: import("./dsl").Ast): void => {
          if (n.t === "ident") refs.push({ name: n.name });
          else if (n.t === "un") walk(n.e);
          else if (n.t === "bin") {
            walk(n.l);
            walk(n.r);
          } else if (n.t === "tern") {
            walk(n.c);
            walk(n.a);
            walk(n.b);
          } else if (n.t === "call") n.args.forEach(walk);
        };
        walk(parse(c.assert));
        refNames = [...new Set(refs.map((r) => r.name))];
      } catch {
        return; // parse error is check.ts's job
      }
      const unbound = refNames.filter((k) => !isBound(k) && domains[k]);
      if (unbound.length === 0) {
        try {
          if (evaluate(c.assert, { vars: b.values, tables: lookups.tables }) === false)
            conflicts.push({ message: c.message, path: `constraints[${ci}]` });
        } catch {
          /* references something unbound & domainless -> not decidable */
        }
        return;
      }
      if (unbound.length === 1) {
        const k = unbound[0]!;
        for (const o of live(domains[k]!)) {
          try {
            if (evalWith(c.assert, { [k]: o.value }) === false) kill(k, o.value, c.message);
          } catch {
            // undecidable for this value (other unbound refs) -> keep it;
            // only provably inconsistent values are eliminated
          }
        }
        return;
      }
      if (unbound.length === 2) {
        const [p1, p2] = [unbound[0]!, unbound[1]!];
        const support = (a: string, av: Val, z: string) =>
          live(domains[z]!).some((o) => {
            try {
              return evalWith(c.assert, { [a]: av, [z]: o.value }) !== false;
            } catch {
              return true; // undecidable counts as support (conservative)
            }
          });
        for (const o of live(domains[p1]!)) if (!support(p1, o.value, p2)) kill(p1, o.value, c.message);
        for (const o of live(domains[p2]!)) if (!support(p2, o.value, p1)) kill(p2, o.value, c.message);
      }
      // ponytail: >2 unbound refs not propagated (validated once bound); full GAC if real models demand it
    });

    if (!changed) break;
  }

  const open = model.parameters
    .filter((p) => domains[p.key] && !(p.key in b.values) && b.visible[p.key])
    .map((p) => p.key);
  for (const k of open) {
    if (live(domains[k]!).length === 0)
      conflicts.push({ message: `no valid values remain for '${k}'`, path: `parameters.${k}` });
  }
  const candidateEstimate = open.reduce((acc, k) => acc * Math.max(live(domains[k]!).length, 1), 1);
  return { ...b, domains, conflicts, open, candidateEstimate };
}
```

Also add `parse` to the existing dsl import at the top of the file: `import { evaluate, parse } from "./dsl";` (single import statement — remove the duplicate added above).

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test packages/config-engine/test/propagate.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/config-engine/src/propagate.ts packages/config-engine/test/propagate.test.ts
git commit -m "feat(config-engine): constraint propagation fixpoint over finite domains"
```

---

### Task 7: Enumeration

**Files:**
- Create: `packages/config-engine/src/enumerate.ts`
- Test: `packages/config-engine/test/enumerate.test.ts`

**Interfaces:**
- Produces: `type Enumeration = { candidates: Entries[]; capped: boolean; widest?: { key: string; size: number } }`; `enumerate(model: ModelDef, lookups: ResolvedLookups, entries: Entries, cap?: number): Enumeration` (cap default 200). Candidates contain `entries` + assigned open-param choices only (no defaults/computed — they recompute deterministically).
- Consumes: `propagate` from `./propagate`.

- [ ] **Step 1: Write failing tests** (`test/enumerate.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import { enumerate } from "../src/enumerate";
import { lookups, model } from "./fixture";

describe("enumerate", () => {
  test("closed entries -> exactly one candidate equal to entries", () => {
    const e = enumerate(model, lookups, { material: "steel", section: 16 }); // coated defaults false, color hidden
    expect(e.capped).toBe(false);
    expect(e.candidates).toEqual([{ material: "steel", section: 16 }]);
  });

  test("one open param -> one candidate per live value", () => {
    const e = enumerate(model, lookups, { material: "alu" }); // section open, 25 eliminated
    expect(e.candidates.map((c) => c.section).sort()).toEqual([10, 16]);
  });

  test("full open space respects both constraints", () => {
    const e = enumerate(model, lookups, { coated: true });
    // material×section×color minus (alu,25,*) minus disallowed color combos:
    // steel: sections 10,16,25 × colors red,black = 6
    // alu:   sections 10,16    × colors black,blue = 4
    expect(e.candidates).toHaveLength(10);
    expect(e.capped).toBe(false);
    for (const c of e.candidates) {
      expect(!(c.material === "alu" && c.section === 25)).toBe(true);
    }
  });

  test("cap stops early and reports widest open param", () => {
    const e = enumerate(model, lookups, { coated: true }, 4);
    expect(e.candidates).toHaveLength(4);
    expect(e.capped).toBe(true);
    expect(e.widest?.key).toBeDefined();
    expect(e.widest!.size).toBeGreaterThanOrEqual(3);
  });

  test("contradictory entries -> zero candidates", () => {
    const e = enumerate(model, lookups, { material: "alu", section: 25 });
    expect(e.candidates).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/config-engine/test/enumerate.test.ts`
Expected: FAIL — cannot resolve `../src/enumerate`.

- [ ] **Step 3: Implement `src/enumerate.ts`**

```ts
import type { Entries, ModelDef, ResolvedLookups } from "./model";
import { type DomainOption, propagate } from "./propagate";

export type Enumeration = {
  candidates: Entries[];
  capped: boolean;
  widest?: { key: string; size: number };
};

const live = (d: DomainOption[]) => d.filter((o) => !o.eliminatedBy);

export function enumerate(model: ModelDef, lookups: ResolvedLookups, entries: Entries, cap = 200): Enumeration {
  const candidates: Entries[] = [];
  let capped = false;

  const first = propagate(model, lookups, entries);
  let widest: Enumeration["widest"];
  for (const k of first.open) {
    const size = live(first.domains[k]!).length;
    if (!widest || size > widest.size) widest = { key: k, size };
  }

  const dfs = (cur: Entries): void => {
    if (capped) return;
    const p = propagate(model, lookups, cur);
    if (p.conflicts.length) return;
    if (p.open.length === 0) {
      if (candidates.length >= cap) {
        capped = true;
        return;
      }
      candidates.push(cur);
      return;
    }
    // smallest live domain first: fail fast, shallow tree
    const key = [...p.open].sort((a, b) => live(p.domains[a]!).length - live(p.domains[b]!).length)[0]!;
    for (const o of live(p.domains[key]!)) {
      if (capped) return;
      dfs({ ...cur, [key]: o.value });
    }
  };
  dfs(entries);
  return { candidates, capped, widest: capped ? widest : undefined };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test packages/config-engine/test/enumerate.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/config-engine/src/enumerate.ts packages/config-engine/test/enumerate.test.ts
git commit -m "feat(config-engine): candidate enumeration with cap"
```

---

### Task 8: Outputs — BOM, routing, costs, price

**Files:**
- Create: `packages/config-engine/src/output.ts`
- Test: `packages/config-engine/test/output.test.ts`

**Interfaces:**
- Produces:

```ts
export type BomResult = { id: string; itemCode: string; desc: string; qtyPerUnit: number; totalQty: number; unitPrice: number; lineTotal: number };
export type OpResult = { id: string; resource: string; setupMin: number; runMinPerUnit: number; totalMin: number; cost: number };
export type Outputs = {
  bom: BomResult[]; ops: OpResult[];
  materialPerUnit: number; laborPerUnit: number; unitCost: number; unitPrice: number; batchTotal: number;
};
export function computeOutputs(model: ModelDef, lookups: ResolvedLookups, assignment: Entries, batchQty: number): Outputs;
```

- Consumes: `bindings` from `./propagate`, `evaluate`/`DslError` from `./dsl`.
- Errors: throws `DslError` (server wraps it in Phase 2). `batchQty < 1` throws `RangeError`.

Fixed math (all per Global Constraints units):
- Line included iff `condition` absent or evaluates exactly `true`.
- `qtyPerUnit = eval(qty)`; scrap-adjusted `effQty = qtyPerUnit * (1 + scrapPct / 100)`; `totalQty = effQty * batchQty`; `unitPrice = eval(price)`; `lineTotal = totalQty * unitPrice`; `materialPerUnit = Σ effQty * unitPrice`.
- Op included iff condition passes. `setupMin = eval(setupMin)`, `runMinPerUnit = eval(runMinPerUnit)`, `rate = eval(ratePerHour)`; `totalMin = setupMin + runMinPerUnit * batchQty`; `cost = totalMin / 60 * rate`; `laborPerUnit = Σ (setupMin / batchQty + runMinPerUnit) / 60 * rate`.
- `unitCost = materialPerUnit + laborPerUnit`; `unitPrice = eval(pricing.priceExpr)` with `unitCost` and `qty` in scope; `batchTotal = unitPrice * batchQty`. No rounding — UI formats. `// ponytail: raw floats; currency rounding at the edge`

- [ ] **Step 1: Write failing tests with hand-computed fixture numbers** (`test/output.test.ts`)

Hand computation for `{material:"steel", section:16, coated:true, color:"black"}`, batch 100:
conductor: qty/unit 0.32, price 1.5 → 0.48/unit; coating: qty 1, scrap 5% → 1.05 × 0.8 = 0.84/unit → material 1.32/unit.
cut: (10/100 + 0.5)/60×60 = 0.6/unit; coat: run 3.2 min → (30/100 + 3.2)/60×60 = 3.5/unit → labor 4.1/unit.
unitCost 5.42; price ×1.4 = 7.588; batch total 758.8.

```ts
import { describe, expect, test } from "bun:test";
import { DslError } from "../src/dsl";
import { computeOutputs } from "../src/output";
import { lookups, model } from "./fixture";

const full = { material: "steel", section: 16, coated: true, color: "black" };

describe("computeOutputs", () => {
  test("coated steel 16mm² at batch 100 — hand-computed", () => {
    const o = computeOutputs(model, lookups, full, 100);
    expect(o.bom.map((l) => l.id)).toEqual(["conductor", "coating"]);
    const [cond, coat] = o.bom;
    expect(cond!.itemCode).toBe("COND-steel");
    expect(cond!.desc).toBe("steel conductor");
    expect(cond!.qtyPerUnit).toBeCloseTo(0.32);
    expect(cond!.totalQty).toBeCloseTo(32);
    expect(cond!.unitPrice).toBeCloseTo(1.5);
    expect(cond!.lineTotal).toBeCloseTo(48);
    expect(coat!.totalQty).toBeCloseTo(105); // scrap 5%
    expect(o.materialPerUnit).toBeCloseTo(1.32);

    expect(o.ops.map((op) => op.id)).toEqual(["cut", "coat"]);
    const coatOp = o.ops[1]!;
    expect(coatOp.runMinPerUnit).toBeCloseTo(3.2);
    expect(coatOp.totalMin).toBeCloseTo(350);
    expect(coatOp.cost).toBeCloseTo(350);
    expect(o.laborPerUnit).toBeCloseTo(4.1);

    expect(o.unitCost).toBeCloseTo(5.42);
    expect(o.unitPrice).toBeCloseTo(7.588);
    expect(o.batchTotal).toBeCloseTo(758.8);
  });

  test("uncoated: conditional line and op drop out", () => {
    const o = computeOutputs(model, lookups, { material: "steel", section: 16, coated: false }, 100);
    expect(o.bom.map((l) => l.id)).toEqual(["conductor"]);
    expect(o.ops.map((op) => op.id)).toEqual(["cut"]);
  });

  test("setup amortization: bigger batch -> lower unit price", () => {
    const small = computeOutputs(model, lookups, full, 100);
    const big = computeOutputs(model, lookups, full, 1000);
    expect(big.unitPrice).toBeLessThan(small.unitPrice);
    expect(big.batchTotal).toBeGreaterThan(small.batchTotal);
  });

  test("missing lookup row surfaces as DslError", () => {
    const badLookups = structuredClone(lookups);
    badLookups.tables.prices!.rows = [];
    expect(() => computeOutputs(model, badLookups, full, 100)).toThrow(DslError);
  });

  test("batchQty must be >= 1", () => {
    expect(() => computeOutputs(model, lookups, full, 0)).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/config-engine/test/output.test.ts`
Expected: FAIL — cannot resolve `../src/output`.

- [ ] **Step 3: Implement `src/output.ts`**

```ts
import { evaluate, type Scope } from "./dsl";
import type { Entries, ModelDef, ResolvedLookups } from "./model";
import { bindings } from "./propagate";

export type BomResult = {
  id: string;
  itemCode: string;
  desc: string;
  qtyPerUnit: number;
  totalQty: number;
  unitPrice: number;
  lineTotal: number;
};
export type OpResult = {
  id: string;
  resource: string;
  setupMin: number;
  runMinPerUnit: number;
  totalMin: number;
  cost: number;
};
export type Outputs = {
  bom: BomResult[];
  ops: OpResult[];
  materialPerUnit: number;
  laborPerUnit: number;
  unitCost: number;
  unitPrice: number;
  batchTotal: number;
};

export function computeOutputs(
  model: ModelDef,
  lookups: ResolvedLookups,
  assignment: Entries,
  batchQty: number,
): Outputs {
  if (batchQty < 1) throw new RangeError(`batchQty must be >= 1, got ${batchQty}`);
  const { values } = bindings(model, lookups, assignment);
  const scope: Scope = { vars: { ...values, qty: batchQty }, tables: lookups.tables };
  const numeric = (src: string, what: string): number => {
    const v = evaluate(src, scope);
    if (typeof v !== "number") throw new TypeError(`${what} did not evaluate to a number`);
    return v;
  };
  const included = (condition: string | undefined) => condition === undefined || evaluate(condition, scope) === true;

  const bom: BomResult[] = [];
  let materialPerUnit = 0;
  for (const l of model.bom) {
    if (!included(l.condition)) continue;
    const qtyPerUnit = numeric(l.qty, `bom '${l.id}' qty`);
    const effQty = qtyPerUnit * (1 + l.scrapPct / 100);
    const unitPrice = numeric(l.price, `bom '${l.id}' price`);
    const itemCode = String(evaluate(l.itemCode, scope) ?? "");
    const desc = l.desc === undefined ? "" : String(evaluate(l.desc, scope) ?? "");
    const totalQty = effQty * batchQty;
    bom.push({ id: l.id, itemCode, desc, qtyPerUnit, totalQty, unitPrice, lineTotal: totalQty * unitPrice });
    materialPerUnit += effQty * unitPrice;
  }

  const ops: OpResult[] = [];
  let laborPerUnit = 0;
  for (const o of model.routing) {
    if (!included(o.condition)) continue;
    const setupMin = numeric(o.setupMin, `routing '${o.id}' setupMin`);
    const runMinPerUnit = numeric(o.runMinPerUnit, `routing '${o.id}' runMinPerUnit`);
    const rate = numeric(o.ratePerHour, `routing '${o.id}' ratePerHour`);
    const totalMin = setupMin + runMinPerUnit * batchQty;
    ops.push({ id: o.id, resource: o.resource, setupMin, runMinPerUnit, totalMin, cost: (totalMin / 60) * rate });
    laborPerUnit += ((setupMin / batchQty + runMinPerUnit) / 60) * rate;
  }

  const unitCost = materialPerUnit + laborPerUnit;
  const priceScope: Scope = { vars: { ...scope.vars, unitCost }, tables: lookups.tables };
  const unitPrice = evaluate(model.pricing.priceExpr, priceScope);
  if (typeof unitPrice !== "number") throw new TypeError("pricing.priceExpr did not evaluate to a number");
  // ponytail: raw floats end to end; currency rounding happens at the UI/quote edge
  return { bom, ops, materialPerUnit, laborPerUnit, unitCost, unitPrice, batchTotal: unitPrice * batchQty };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test packages/config-engine/test/output.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/config-engine/src/output.ts packages/config-engine/test/output.test.ts
git commit -m "feat(config-engine): BOM/routing outputs with batch amortization"
```

---

### Task 9: Public API + full-suite verification

**Files:**
- Create: `packages/config-engine/src/index.ts`

**Interfaces:**
- Produces the package's public surface, consumed by Phase 2 (server) and Phase 3/4 (web):

```ts
export { ModelDefZ, LookupRefZ, ParamZ, ConstraintZ, BomLineZ, OperationZ } from "./model";
export type { Entries, LookupRef, ModelDef, Option, Param, ResolvedLookups, ResolvedTable, Val } from "./model";
export { DslError, evaluate, parse } from "./dsl";
export type { Ast, Scope } from "./dsl";
export { checkModel } from "./check";
export type { Issue } from "./check";
export { bindings, domainOf, propagate } from "./propagate";
export type { Bindings, DomainOption, Propagation } from "./propagate";
export { enumerate } from "./enumerate";
export type { Enumeration } from "./enumerate";
export { computeOutputs } from "./output";
export type { BomResult, OpResult, Outputs } from "./output";
```

- [ ] **Step 1: Write `src/index.ts`** (content above, verbatim)

- [ ] **Step 2: Full suite + import smoke test**

Run: `bun test packages/config-engine`
Expected: all tests pass, 0 fail.

Run: `bun -e 'import { propagate, ModelDefZ } from "@hera/config-engine"; console.log(typeof propagate, typeof ModelDefZ.parse)'`
Expected: `function function`

- [ ] **Step 3: Typecheck**

Run: `bunx tsc -p packages/config-engine/tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/config-engine/src/index.ts
git commit -m "feat(config-engine): public API surface"
```

---

## Self-review notes (already applied)

- Spec coverage: DSL ✓ (Tasks 2–3), check ✓ (4), propagate incl. `values`/eliminatedBy/estimate ✓ (5–6), enumerate + cap + widest ✓ (7), outputs incl. scrap/amortization/priceExpr ✓ (8), exports ✓ (9). ModelDef covers parameters/structure/computed/constraints/bom/routing/queryTables/pricing/batchDefaults ✓ (1). Deliberately out of this plan (later phases): lookup *resolution* (server), `config_*` tables, routers, UI, B1 write. `requiredWhen` is schema-only here; enforcement is a UI concern (Phase 4).
- Type consistency: `Entries`/`ResolvedLookups`/`Propagation`/`Enumeration`/`Outputs` names match across tasks; `pricing.priceExpr` used consistently (spec's `marginExpr`, renamed — noted in Global Constraints).
- The stale root `test:engine` script is fixed in Task 1; `bun install` in Task 1 heals the pre-existing `workspace:*` refs.

## Next plans (not this document)

Phase 2 (db schema + models/configs routers + agent `query.fetch`), Phase 3 (model builder UI), Phase 4 (process wizard UI), Phase 5 (B1 `quote.create`). Each gets its own plan once this package's API is merged.
