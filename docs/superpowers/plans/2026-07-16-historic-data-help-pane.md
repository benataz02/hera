# Historic Data Help Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A right-hand help pane on the configurator process page that shows (1) the customer's/item's latest SAP Orders & Quotations live, and (2) past configurations ranked by weighted similarity to the current entries, copyable into the form — plus the admin "History" tab in the model builder that configures it.

**Architecture:** `ModelDef` grows an optional `history` block (item-code param, similarity query, param↔column mappings, display columns). A `config_history` Postgres table caches the query rows (hourly interval + "Sync now"); `configs.similar` scores them in TypeScript per request. `configs.docHistory` hits B1 live through the existing agent `query` channel. The web pane is a `SplitterLayout` twin of the ModelBuilder preview with a two-tab `TabContainer`.

**Tech Stack:** Bun workspaces, Drizzle/Postgres, oRPC (`userProcedure`/`adminProcedure`), TanStack Query, UI5 Web Components React (`TabContainer`, `Table`, `Card`, `Tag`, `SplitterLayout`), SAP B1 Service Layer b1s/v2 (OData v4).

## Global Constraints

- Use **bun** for everything (installs, tests, scripts). No new dependencies.
- The agent is the only thing that talks to B1; server reaches it via `runRequest(tenantId, "query", { target, path })` behind `assertAgentReady`.
- Copy semantics: fill **only empty** params, then the normal `onChange`/`propagate()` flow.
- Doc history merge: one list, docs matching customer OR item, rows matching **both first**, then `DocDate` desc.
- Pane spans **all wizard steps**; toggle in the wizard header; open by default only when the model has `history` config.
- Mark deliberate shortcuts with `// ponytail:` comments naming the ceiling + upgrade path.
- Tests: `bun test packages/config-engine`, `bun test apps/server`. Web gate: `bun --cwd apps/web build`.
- b1s/v2 is OData v4 — `DocumentLines/any(d: d/ItemCode eq '…')` is the intended filter; **verify against the sandbox early** (Task 4 note) and fall back to `$crossjoin` only if the lambda is rejected.

## Design notes (web)

Stay native Fiori — no custom CSS beyond flex layout. The one signature element is the **explainable similarity card**: score in the `CardHeader`, one `Tag` chip per mapped param (Positive = full match, Critical = partial, Neutral = miss) so the user sees *why* a result ranked. Everything else is quiet: compact `Table` for documents, `MessageStrip` Information (not Negative) for agent-offline, copy that names the action — "Use values", "Sync now", "Refresh".

---

### Task 1: Engine — `history` schema + validation

**Files:**
- Modify: `packages/config-engine/src/model.ts` (after `queryTables` in `ModelDefZ`)
- Modify: `packages/config-engine/src/check.ts` (end of `checkModel`, before `return issues`)
- Test: `packages/config-engine/test/check.test.ts`

**Interfaces:**
- Produces: `ModelDef["history"]` =
  ```ts
  {
    itemCodeParam?: string;
    query?: { target: "b1" | "beas"; path: string; columns: string[] };
    mappings: { param: string; column: string; match: "exact" | "closeness" | "contains"; weight: number }[];
    display: string[];
  } | undefined
  ```
  All later tasks consume this exact shape.

- [ ] **Step 1: Write the failing tests** — append to `packages/config-engine/test/check.test.ts` inside the `describe`:

```ts
test("history: valid config is clean", () => {
  const m = structuredClone(model);
  m.history = {
    itemCodeParam: "material",
    query: { target: "b1", path: "/x", columns: ["mat", "sec", "price"] },
    mappings: [
      { param: "material", column: "mat", match: "exact", weight: 2 },
      { param: "section", column: "sec", match: "closeness", weight: 1 },
    ],
    display: ["price"],
  };
  expect(checkModel(m, PRICES)).toEqual([]);
});

test("history: unknown param, closeness on non-number, unknown columns", () => {
  const m = structuredClone(model);
  m.history = {
    itemCodeParam: "nope",
    query: { target: "b1", path: "/x", columns: ["mat"] },
    mappings: [
      { param: "ghost", column: "mat", match: "exact", weight: 1 },
      { param: "material", column: "mat", match: "closeness", weight: 1 },
      { param: "section", column: "missing", match: "exact", weight: 1 },
    ],
    display: ["also_missing"],
  };
  const issues = checkModel(m, PRICES);
  expect(issues.some((i) => i.path === "history.itemCodeParam")).toBe(true);
  expect(issues.some((i) => i.path === "history.mappings[0]" && i.message.includes("ghost"))).toBe(true);
  expect(issues.some((i) => i.path === "history.mappings[1]" && i.message.includes("closeness"))).toBe(true);
  expect(issues.some((i) => i.path === "history.mappings[2]" && i.message.includes("missing"))).toBe(true);
  expect(issues.some((i) => i.path === "history.display[0]")).toBe(true);
});

test("history: mappings without a query flagged", () => {
  const m = structuredClone(model);
  m.history = { mappings: [{ param: "material", column: "mat", match: "exact", weight: 1 }], display: [] };
  expect(checkModel(m, PRICES).some((i) => i.path === "history.query")).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/config-engine`
Expected: the 3 new tests FAIL (`history` not in ModelDefZ type → compile error is also an acceptable failure mode).

- [ ] **Step 3: Implement the schema** — in `packages/config-engine/src/model.ts`, add above `ModelDefZ`:

```ts
export const HistoryMappingZ = z.object({
  param: KeyZ,
  column: z.string().min(1),
  match: z.enum(["exact", "closeness", "contains"]),
  weight: z.number().positive().default(1),
});
export type HistoryMapping = z.infer<typeof HistoryMappingZ>;
```

and inside `ModelDefZ` after the `queryTables` entry:

```ts
history: z
  .object({
    itemCodeParam: KeyZ.optional(),
    query: z
      .object({ target: z.enum(["b1", "beas"]), path: z.string(), columns: z.array(z.string()) })
      .optional(),
    mappings: z.array(HistoryMappingZ),
    display: z.array(z.string()),
  })
  .optional(),
```

- [ ] **Step 4: Implement the validation** — in `packages/config-engine/src/check.ts`, before `return issues;`:

```ts
// history: mapped params exist, closeness only on numbers, columns ⊆ query.columns
if (model.history) {
  const h = model.history;
  const paramOf = (k: string) => model.parameters.find((p) => p.key === k);
  if (h.itemCodeParam && !paramOf(h.itemCodeParam))
    issues.push({ path: "history.itemCodeParam", message: `unknown parameter '${h.itemCodeParam}'` });
  if (h.mappings.length && !h.query)
    issues.push({ path: "history.query", message: "similarity mappings need a history query" });
  const qCols = h.query?.columns ?? [];
  h.mappings.forEach((m, i) => {
    const p = paramOf(m.param);
    if (!p) issues.push({ path: `history.mappings[${i}]`, message: `unknown parameter '${m.param}'` });
    else if (m.match === "closeness" && p.type !== "number")
      issues.push({ path: `history.mappings[${i}]`, message: `closeness needs a number parameter ('${m.param}' is ${p.type})` });
    if (qCols.length && !qCols.includes(m.column))
      issues.push({ path: `history.mappings[${i}]`, message: `query has no column '${m.column}'` });
  });
  h.display.forEach((c, i) => {
    if (qCols.length && !qCols.includes(c))
      issues.push({ path: `history.display[${i}]`, message: `query has no column '${c}'` });
  });
}
```

- [ ] **Step 5: Run tests**

Run: `bun test packages/config-engine`
Expected: all PASS (existing + 3 new).

- [ ] **Step 6: Commit**

```bash
git add packages/config-engine/src/model.ts packages/config-engine/src/check.ts packages/config-engine/test/check.test.ts
git commit -m "feat(engine): history config on ModelDef + checkModel validation"
```

---

### Task 2: DB — `config_history` table

**Files:**
- Modify: `packages/db/src/schema/configurator.ts` (append)
- Generated: `packages/db/drizzle/0003_*.sql` via drizzle-kit

**Interfaces:**
- Produces: `configHistory` table export — columns `id`, `tenantId`, `modelId`, `row: Record<string, Val>` (jsonb), `syncedAt`. Consumed by Tasks 5–6.

- [ ] **Step 1: Add the table** — append to `packages/db/src/schema/configurator.ts`:

```ts
// Historic configuration rows pulled from the model's history query; wholesale-replaced per sync.
// ponytail: jsonb row per record, ~tens of thousands of rows per model; real columns/pgvector if
// a tenant outgrows in-process scoring.
export const configHistory = pgTable(
  "config_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    modelId: uuid("model_id").notNull(),
    row: jsonb("row").$type<Record<string, Val>>().notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("config_history_tenant_model_idx").on(t.tenantId, t.modelId)],
);
```

Check `packages/db/src/schema/index.ts` re-exports `./configurator` (it exports the other config tables already; add nothing if it's `export *`).

- [ ] **Step 2: Generate + run the migration**

Run: `bun run db:generate` then `bun run db:migrate`
Expected: a new `packages/db/drizzle/0003_*.sql` containing `CREATE TABLE "config_history"`, migration applies cleanly.

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/schema/configurator.ts packages/db/drizzle
git commit -m "feat(db): config_history table"
```

---

### Task 3: Server — similarity scorer (pure)

**Files:**
- Create: `apps/server/src/similarity.ts`
- Test: `apps/server/test/similarity.test.ts`

**Interfaces:**
- Consumes: `ModelDef["history"]` (Task 1).
- Produces:
  ```ts
  type ParamMatch = { param: string; column: string; match: "exact" | "closeness" | "contains"; weight: number; score: number; value: Val };
  type Scored = { row: Record<string, Val>; score: number; matches: ParamMatch[] };
  function scoreRows(history: NonNullable<ModelDef["history"]>, entries: Entries, rows: Record<string, Val>[], top?: number): Scored[]
  ```

- [ ] **Step 1: Write the failing test** — `apps/server/test/similarity.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { scoreRows } from "../src/similarity.ts";
import type { ModelDef } from "@hera/config-engine";

const history: NonNullable<ModelDef["history"]> = {
  mappings: [
    { param: "material", column: "mat", match: "exact", weight: 2 },
    { param: "section", column: "sec", match: "closeness", weight: 1 },
    { param: "note", column: "descr", match: "contains", weight: 1 },
  ],
  display: [],
};
const rows = [
  { mat: "steel", sec: 10, descr: "Steel cable coated" },
  { mat: "steel", sec: 20, descr: "plain" },
  { mat: "alu", sec: 30, descr: "aluminium special" },
];

describe("scoreRows", () => {
  test("empty entries → no results", () => {
    expect(scoreRows(history, {}, rows)).toEqual([]);
  });

  test("weights only filled params; exact is case-insensitive", () => {
    const r = scoreRows(history, { material: "Steel" }, rows);
    expect(r[0]!.score).toBe(1); // 2/2 — section & note unfilled, excluded from denominator
    expect(r[0]!.matches).toHaveLength(1);
    expect(r.filter((x) => x.score === 1)).toHaveLength(2);
  });

  test("closeness normalizes over the observed range", () => {
    const r = scoreRows(history, { section: 10 }, rows);
    // range 10..30: sec=10 → 1, sec=20 → 0.5, sec=30 → 0
    expect(r.map((x) => x.score)).toEqual([1, 0.5, 0]);
  });

  test("contains is case-insensitive substring on the historic value", () => {
    const r = scoreRows(history, { note: "CABLE" }, rows);
    expect(r[0]!.row.mat).toBe("steel");
    expect(r[0]!.score).toBe(1);
    expect(r[1]!.score).toBe(0);
  });

  test("combined score = Σ(weight·match)/Σ(weight of filled)", () => {
    const r = scoreRows(history, { material: "steel", section: 30 }, rows);
    // row alu/30: exact 0·2 + closeness 1·1 = 1/3; row steel/20: 2·1 + 0.5·1 = 2.5/3
    expect(r[0]!.score).toBeCloseTo(2.5 / 3);
    expect(r[0]!.row.sec).toBe(20);
  });

  test("top caps results", () => {
    expect(scoreRows(history, { material: "steel" }, rows, 1)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/server/test/similarity.test.ts`
Expected: FAIL — module `../src/similarity.ts` not found.

- [ ] **Step 3: Implement** — `apps/server/src/similarity.ts`:

```ts
import type { Entries, ModelDef, Val } from "@hera/config-engine";

// Weighted per-param similarity over cached historic rows. Pure — no DB, no agent — so it has
// a network-free test. Score = Σ(weight × match) / Σ(weight of params the user filled).

export type HistoryDef = NonNullable<ModelDef["history"]>;
export type ParamMatch = {
  param: string; column: string; match: "exact" | "closeness" | "contains";
  weight: number; score: number; value: Val;
};
export type Scored = { row: Record<string, Val>; score: number; matches: ParamMatch[] };

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();
const filled = (v: Entries[string] | undefined): v is NonNullable<Entries[string]> =>
  v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);

export function scoreRows(history: HistoryDef, entries: Entries, rows: Record<string, Val>[], top = 10): Scored[] {
  const active = history.mappings.filter((m) => filled(entries[m.param]));
  if (!active.length || !rows.length) return [];
  const totalWeight = active.reduce((s, m) => s + m.weight, 0);

  // closeness auto-normalization: observed numeric range of the column in the historic data
  const ranges = new Map<string, { min: number; max: number }>();
  for (const m of active) {
    if (m.match !== "closeness") continue;
    let min = Infinity, max = -Infinity;
    for (const r of rows) {
      const n = Number(r[m.column]);
      if (Number.isFinite(n)) { min = Math.min(min, n); max = Math.max(max, n); }
    }
    if (min <= max) ranges.set(m.column, { min, max });
  }

  const one = (m: HistoryDef["mappings"][number], entry: Val, hist: Val): number => {
    if (m.match === "exact") return norm(entry) === norm(hist) ? 1 : 0;
    if (m.match === "contains") return norm(entry) && norm(hist).includes(norm(entry)) ? 1 : 0;
    const a = Number(entry), b = Number(hist), rg = ranges.get(m.column);
    if (!Number.isFinite(a) || !Number.isFinite(b) || !rg) return 0;
    if (rg.max === rg.min) return a === b ? 1 : 0;
    return Math.max(0, Math.min(1, 1 - Math.abs(a - b) / (rg.max - rg.min)));
  };

  const scored = rows.map((row) => {
    const matches = active.map((m) => {
      const e = entries[m.param]!;
      // multicombo entries: best match across the selected values
      const vals: Val[] = Array.isArray(e) ? e : [e];
      const score = Math.max(...vals.map((v) => one(m, v, row[m.column] ?? null)));
      return { param: m.param, column: m.column, match: m.match, weight: m.weight, score, value: row[m.column] ?? null };
    });
    return { row, score: matches.reduce((s, x) => s + x.weight * x.score, 0) / totalWeight, matches };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, top);
}
```

- [ ] **Step 4: Run tests**

Run: `bun test apps/server/test/similarity.test.ts`
Expected: 6 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/similarity.ts apps/server/test/similarity.test.ts
git commit -m "feat(server): weighted similarity scorer"
```

---

### Task 4: Server — doc history (path builder, flatten, endpoint)

**Files:**
- Create: `apps/server/src/doc-history.ts`
- Modify: `apps/server/src/orpc/routers/configs.ts` (add `docHistory` to `configsRouter`)
- Test: `apps/server/test/doc-history.test.ts`

**Interfaces:**
- Produces (pure, in `doc-history.ts`):
  ```ts
  function docHistoryPath(entity: "Orders" | "Quotations", opts: { itemCode?: string; cardCode?: string; top?: number }): string
  type DocRow = { docType: "order" | "quotation"; docNum: number; docDate: string; cardCode: string; cardName: string;
                  itemCode: string; itemDescription: string; quantity: number; unitPrice: number;
                  matched: "both" | "customer" | "item" };
  function flattenDocs(docType: "order" | "quotation", json: unknown, opts: { itemCode?: string; cardCode?: string }): DocRow[]
  function sortDocRows(rows: DocRow[]): DocRow[]  // both-matches first, then DocDate desc
  ```
- Produces (oRPC): `configs.docHistory({ id, itemCode? }) → { itemCode: string | null; cardCode: string | null; rows: DocRow[] }`. Agent offline → `SERVICE_UNAVAILABLE` ORPCError (web shows it as a hint).

- [ ] **Step 1: Write the failing test** — `apps/server/test/doc-history.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { docHistoryPath, flattenDocs, sortDocRows } from "../src/doc-history.ts";

describe("docHistoryPath", () => {
  test("both criteria OR'd, quotes escaped, ordered by DocDate desc", () => {
    const p = docHistoryPath("Orders", { itemCode: "IT'M", cardCode: "C001" });
    expect(p.startsWith("/Orders?")).toBe(true);
    expect(decodeURIComponent(p)).toContain("CardCode eq 'C001' or DocumentLines/any(d: d/ItemCode eq 'IT''M')");
    expect(decodeURIComponent(p)).toContain("$orderby=DocDate desc");
    expect(p).toContain("$top=10");
    expect(p).toContain("$expand=DocumentLines(");
  });

  test("throws without criteria", () => {
    expect(() => docHistoryPath("Quotations", {})).toThrow();
  });
});

const docs = {
  value: [
    {
      DocNum: 7, DocDate: "2026-06-01", CardCode: "C001", CardName: "Acme",
      DocumentLines: [
        { ItemCode: "A", ItemDescription: "item A", Quantity: 5, UnitPrice: 10 },
        { ItemCode: "B", ItemDescription: "item B", Quantity: 1, UnitPrice: 99 },
      ],
    },
    {
      DocNum: 8, DocDate: "2026-07-01", CardCode: "C777", CardName: "Other",
      DocumentLines: [{ ItemCode: "A", ItemDescription: "item A", Quantity: 2, UnitPrice: 12 }],
    },
  ],
};

describe("flattenDocs + sortDocRows", () => {
  test("customer-matched docs keep all lines; item-only docs keep matching lines", () => {
    const rows = flattenDocs("order", docs, { itemCode: "A", cardCode: "C001" });
    expect(rows).toHaveLength(3); // doc 7: both lines (customer match), doc 8: line A only
    expect(rows.find((r) => r.docNum === 7 && r.itemCode === "A")!.matched).toBe("both");
    expect(rows.find((r) => r.docNum === 7 && r.itemCode === "B")!.matched).toBe("customer");
    expect(rows.find((r) => r.docNum === 8)!.matched).toBe("item");
  });

  test("sort: both first, then date desc", () => {
    const rows = sortDocRows(flattenDocs("order", docs, { itemCode: "A", cardCode: "C001" }));
    expect(rows[0]!.matched).toBe("both");
    expect(rows[1]!.docDate >= rows[2]!.docDate).toBe(true);
  });

  test("tolerates a bare-array response and missing lines", () => {
    expect(flattenDocs("quotation", [{ DocNum: 1, CardCode: "C1" }], { cardCode: "C1" })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/server/test/doc-history.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `apps/server/src/doc-history.ts`:

```ts
// Exact help: latest Orders/Quotations for the configured item and/or the project customer,
// fetched live through the agent's read-only "query" channel. Pure helpers here (testable);
// the oRPC handler in configs.ts wires runRequest.
// OData: b1s/v2 (v4) lambda — DocumentLines/any(). If a B1 patch level rejects it, swap
// docHistoryPath's item clause for a $crossjoin (see sap-b1-service-layer skill) — callers
// only see the path string.

export type DocRow = {
  docType: "order" | "quotation";
  docNum: number; docDate: string; cardCode: string; cardName: string;
  itemCode: string; itemDescription: string; quantity: number; unitPrice: number;
  matched: "both" | "customer" | "item";
};

const esc = (s: string) => s.replace(/'/g, "''");

export function docHistoryPath(
  entity: "Orders" | "Quotations",
  opts: { itemCode?: string; cardCode?: string; top?: number },
): string {
  const clauses: string[] = [];
  if (opts.cardCode) clauses.push(`CardCode eq '${esc(opts.cardCode)}'`);
  if (opts.itemCode) clauses.push(`DocumentLines/any(d: d/ItemCode eq '${esc(opts.itemCode)}')`);
  if (!clauses.length) throw new Error("docHistoryPath needs an itemCode or a cardCode");
  return (
    `/${entity}?$select=DocEntry,DocNum,DocDate,CardCode,CardName` +
    `&$expand=DocumentLines($select=ItemCode,ItemDescription,Quantity,UnitPrice)` +
    `&$filter=${encodeURIComponent(clauses.join(" or "))}` +
    `&$orderby=${encodeURIComponent("DocDate desc")}&$top=${opts.top ?? 10}`
  );
}

export function flattenDocs(
  docType: "order" | "quotation",
  json: unknown,
  opts: { itemCode?: string; cardCode?: string },
): DocRow[] {
  const docs = Array.isArray(json) ? json : ((json as { value?: unknown } | null)?.value ?? []);
  if (!Array.isArray(docs)) return [];
  const out: DocRow[] = [];
  for (const d of docs as Record<string, unknown>[]) {
    const custMatch = !!opts.cardCode && d.CardCode === opts.cardCode;
    const lines = Array.isArray(d.DocumentLines) ? (d.DocumentLines as Record<string, unknown>[]) : [];
    for (const l of lines) {
      const itemMatch = !!opts.itemCode && l.ItemCode === opts.itemCode;
      if (!itemMatch && !custMatch) continue; // item-matched doc: only its matching lines are relevant
      out.push({
        docType,
        docNum: Number(d.DocNum ?? 0), docDate: String(d.DocDate ?? ""),
        cardCode: String(d.CardCode ?? ""), cardName: String(d.CardName ?? ""),
        itemCode: String(l.ItemCode ?? ""), itemDescription: String(l.ItemDescription ?? ""),
        quantity: Number(l.Quantity ?? 0), unitPrice: Number(l.UnitPrice ?? 0),
        matched: itemMatch && custMatch ? "both" : itemMatch ? "item" : "customer",
      });
    }
  }
  return out;
}

/** Both-matches first, then newest first. */
export function sortDocRows(rows: DocRow[]): DocRow[] {
  return [...rows].sort(
    (a, b) => (a.matched === "both" ? 0 : 1) - (b.matched === "both" ? 0 : 1) || b.docDate.localeCompare(a.docDate),
  );
}
```

- [ ] **Step 4: Run tests**

Run: `bun test apps/server/test/doc-history.test.ts`
Expected: 5 PASS.

- [ ] **Step 5: Add the endpoint** — in `apps/server/src/orpc/routers/configs.ts`:

Add imports:

```ts
import { assertAgentReady, runRequest } from "./entities.ts"; // assertAgentReady already imported — extend that line
import { docHistoryPath, flattenDocs, sortDocRows } from "../../doc-history.ts";
```

Add to `configsRouter` (after `lookups`):

```ts
// Exact help: live B1 Orders + Quotations for the project customer and/or the item-code param.
// itemCode comes from the client (current unsaved entry); it is only ever a quoted filter value.
docHistory: userProcedure
  .input(z.object({ id: z.uuid(), itemCode: z.string().optional() }))
  .handler(async ({ input, context }) => {
    const [project] = await db
      .select({ customer: configProject.customer })
      .from(configProject)
      .where(and(eq(configProject.id, input.id), eq(configProject.tenantId, context.tenantId)))
      .limit(1);
    if (!project) throw new ORPCError("NOT_FOUND");
    const itemCode = input.itemCode?.trim() || undefined;
    const cardCode = project.customer?.cardCode;
    if (!itemCode && !cardCode) return { itemCode: null, cardCode: null, rows: [] };
    await assertAgentReady(context.tenantId);
    const fetchDocs = (entity: "Orders" | "Quotations") =>
      runRequest(context.tenantId, "query", { target: "b1", path: docHistoryPath(entity, { itemCode, cardCode }) });
    const [orders, quotations] = await Promise.all([fetchDocs("Orders"), fetchDocs("Quotations")]);
    return {
      itemCode: itemCode ?? null,
      cardCode: cardCode ?? null,
      rows: sortDocRows([
        ...flattenDocs("order", orders, { itemCode, cardCode }),
        ...flattenDocs("quotation", quotations, { itemCode, cardCode }),
      ]),
    };
  }),
```

- [ ] **Step 6: Full server test run + commit**

Run: `bun test apps/server`
Expected: all PASS.

```bash
git add apps/server/src/doc-history.ts apps/server/test/doc-history.test.ts apps/server/src/orpc/routers/configs.ts
git commit -m "feat(server): configs.docHistory — live B1 order/quotation history"
```

> **Sandbox note (do once the agent is up, before building the doc UI in Task 8):** run the lambda path through the existing Test-fetch machinery — in the model builder Tables tab, Test-fetch `/Orders?$top=1&$filter=DocumentLines/any(d: d/ItemCode eq 'X')`. If B1 rejects it, switch `docHistoryPath`'s item clause to the `$crossjoin` form and adjust the test.

---

### Task 5: Server — history sync (table fill, mutation, interval) + `configs.similar`

**Files:**
- Create: `apps/server/src/history-sync.ts`
- Modify: `apps/server/src/orpc/routers/models.ts` (add `syncHistory`, `historyInfo`)
- Modify: `apps/server/src/orpc/routers/configs.ts` (add `similar`)
- Modify: `apps/server/src/index.ts` (start the interval)

**Interfaces:**
- Consumes: `scoreRows` (Task 3), `configHistory` (Task 2), `fetchQueryTable`/`QueryFetcher` (`apps/server/src/lookups.ts`), `assertAgentReady`/`runRequest` (`entities.ts`), `agentFetcher` (`models.ts`).
- Produces:
  ```ts
  // history-sync.ts
  function syncModelHistory(tenantId: string, modelId: string, def: ModelDef, fetchQuery: QueryFetcher): Promise<{ count: number }>
  function loadHistoryRows(tenantId: string, modelId: string): Promise<Record<string, Val>[]>  // 5-min in-process cache
  function startHistorySync(): void
  // oRPC
  models.syncHistory({ id }) → { count: number }
  models.historyInfo({ id }) → { count: number; lastSyncedAt: Date | null }
  configs.similar({ id, entries }) → { results: { score: number; matches: ParamMatch[]; display: Record<string, Val>; values: Record<string, Val> }[] }
  ```

- [ ] **Step 1: Implement `apps/server/src/history-sync.ts`**

```ts
import { and, eq, sql } from "drizzle-orm";
import { db, configHistory, configModel } from "@hera/db";
import type { ModelDef, Val } from "@hera/config-engine";
import { fetchQueryTable, type QueryFetcher } from "./lookups.ts";
import { assertAgentReady, runRequest } from "./orpc/routers/entities.ts";

// Pull a model's history query rows into config_history, wholesale (delete + insert, one tx).
// The query is the source of truth — no dedup/merge. Read side (configs.similar) goes through
// loadHistoryRows' 5-min cache, invalidated on every sync.

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; rows: Record<string, Val>[] }>();
const keyOf = (tenantId: string, modelId: string) => `${tenantId}:${modelId}`;

export async function loadHistoryRows(tenantId: string, modelId: string): Promise<Record<string, Val>[]> {
  const key = keyOf(tenantId, modelId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;
  const rows = (
    await db
      .select({ row: configHistory.row })
      .from(configHistory)
      .where(and(eq(configHistory.tenantId, tenantId), eq(configHistory.modelId, modelId)))
  ).map((r) => r.row);
  cache.set(key, { at: Date.now(), rows });
  return rows;
}

export async function syncModelHistory(
  tenantId: string,
  modelId: string,
  def: ModelDef,
  fetchQuery: QueryFetcher,
): Promise<{ count: number }> {
  const q = def.history?.query;
  if (!q?.path) throw new Error("Model has no history query");
  const t = await fetchQueryTable(fetchQuery, q.target, q.path, q.columns);
  const rows = t.rows.map((r) => Object.fromEntries(t.columns.map((c, i) => [c, r[i] ?? null])));
  await db.transaction(async (tx) => {
    await tx.delete(configHistory).where(and(eq(configHistory.tenantId, tenantId), eq(configHistory.modelId, modelId)));
    for (let i = 0; i < rows.length; i += 1000) {
      await tx.insert(configHistory).values(rows.slice(i, i + 1000).map((row) => ({ tenantId, modelId, row })));
    }
  });
  cache.delete(keyOf(tenantId, modelId));
  return { count: rows.length };
}

const SYNC_INTERVAL_MS = 60 * 60_000;

// ponytail: single in-process hourly interval, sequential per model; move to a jobs table if the
// server ever runs multi-instance or a tenant's sync gets slow enough to matter.
export function startHistorySync(): void {
  const tick = async () => {
    const models = await db
      .select({ id: configModel.id, tenantId: configModel.tenantId, definition: configModel.definition })
      .from(configModel)
      .where(sql`${configModel.definition} -> 'history' -> 'query' is not null`);
    for (const m of models) {
      try {
        await assertAgentReady(m.tenantId);
        const { count } = await syncModelHistory(m.tenantId, m.id, m.definition, (target, path) =>
          runRequest(m.tenantId, "query", { target, path }));
        console.log(`[history-sync] ${m.tenantId}/${m.id}: ${count} rows`);
      } catch (e) {
        console.error(`[history-sync] ${m.tenantId}/${m.id} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  };
  setInterval(() => void tick(), SYNC_INTERVAL_MS);
}
```

- [ ] **Step 2: Add `models.syncHistory` + `models.historyInfo`** — in `apps/server/src/orpc/routers/models.ts`:

Imports: add `configHistory` to the `@hera/db` import, `count, max` to the `drizzle-orm` import, and:

```ts
import { syncModelHistory } from "../../history-sync.ts";
```

Add to `modelsRouter` (after `queryPreview`):

```ts
// "Sync now": run the model's history query through the agent and wholesale-replace config_history.
syncHistory: adminProcedure.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
  const [m] = await db
    .select({ id: configModel.id, definition: configModel.definition })
    .from(configModel)
    .where(and(eq(configModel.id, input.id), eq(configModel.tenantId, context.tenantId)))
    .limit(1);
  if (!m) throw new ORPCError("NOT_FOUND");
  if (!m.definition.history?.query?.path)
    throw new ORPCError("BAD_REQUEST", { message: "Save a history query first" });
  await assertAgentReady(context.tenantId);
  return syncModelHistory(context.tenantId, m.id, m.definition, agentFetcher(context.tenantId));
}),

historyInfo: adminProcedure.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
  const [r] = await db
    .select({ count: count(), lastSyncedAt: max(configHistory.syncedAt) })
    .from(configHistory)
    .where(and(eq(configHistory.tenantId, context.tenantId), eq(configHistory.modelId, input.id)));
  return { count: r?.count ?? 0, lastSyncedAt: r?.lastSyncedAt ?? null };
}),
```

- [ ] **Step 3: Add `configs.similar`** — in `apps/server/src/orpc/routers/configs.ts`:

Imports: add:

```ts
import { loadHistoryRows } from "../../history-sync.ts";
import { scoreRows } from "../../similarity.ts";
```

Add to `configsRouter` (after `docHistory`):

```ts
// Similarity help: rank cached historic rows against the live (unsaved) entries. `values` are
// the row's mapped param values, coerced to each param's type — what the Copy button applies.
similar: userProcedure
  .input(z.object({ id: z.uuid(), entries: EntriesZ }))
  .handler(async ({ input, context }) => {
    const [project] = await db
      .select({ modelId: configProject.modelId })
      .from(configProject)
      .where(and(eq(configProject.id, input.id), eq(configProject.tenantId, context.tenantId)))
      .limit(1);
    if (!project) throw new ORPCError("NOT_FOUND");
    const model = await loadModel(context.tenantId, project.modelId);
    const h = model.definition.history;
    if (!h?.mappings.length) return { results: [] };
    const rows = await loadHistoryRows(context.tenantId, model.id);
    const typeOf = new Map(model.definition.parameters.map((p) => [p.key, p.type]));
    const coerce = (param: string, v: Val): Val =>
      v === null ? null
      : typeOf.get(param) === "number" ? (Number.isFinite(Number(v)) ? Number(v) : null)
      : typeOf.get(param) === "boolean" ? (typeof v === "boolean" ? v : String(v).toLowerCase() === "true")
      : String(v);
    return {
      results: scoreRows(h, input.entries, rows).map((s) => ({
        score: s.score,
        matches: s.matches,
        display: Object.fromEntries(h.display.map((c) => [c, s.row[c] ?? null])),
        values: Object.fromEntries(h.mappings.map((m) => [m.param, coerce(m.param, s.row[m.column] ?? null)])),
      })),
    };
  }),
```

Also add `Val` to the `@hera/config-engine` type import in configs.ts.

- [ ] **Step 4: Start the interval** — in `apps/server/src/index.ts`, after the imports:

```ts
import { startHistorySync } from "./history-sync.ts";

startHistorySync();
```

- [ ] **Step 5: Verify**

Run: `bun test apps/server` — all PASS (nothing regressed; new code is exercised via Task 3/4 units + e2e later).
Run: `bun run dev:server` briefly — starts without errors, no immediate sync tick (interval only).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/history-sync.ts apps/server/src/orpc/routers/models.ts apps/server/src/orpc/routers/configs.ts apps/server/src/index.ts
git commit -m "feat(server): history sync loop + configs.similar scoring endpoint"
```

---

### Task 6: Web — "History" tab in the model builder

**Files:**
- Create: `apps/web/src/components/configurator/HistoryTab.tsx`
- Modify: `apps/web/src/components/configurator/useDraftModel.ts` (TabKey + tabOf)
- Modify: `apps/web/src/components/configurator/TablesTab.tsx` (export `QueryTestFetch`)
- Modify: `apps/web/src/components/configurator/ModelBuilderPage.tsx` (new section)

**Interfaces:**
- Consumes: `ModelDef["history"]` (Task 1), `orpc.models.syncHistory` / `orpc.models.historyInfo` (Task 5), `QueryTestFetch` (TablesTab), `issueFor`/`Update` patterns.
- Produces: `HistoryTab({ draft, update, issues, modelId, dirty })` React component.

- [ ] **Step 1: Extend the tab plumbing** — `apps/web/src/components/configurator/useDraftModel.ts`:

```ts
export type TabKey = "params" | "rules" | "bom" | "routing" | "tables" | "history" | "settings";
```

and in `tabOf`, before the `return "settings"` fallback:

```ts
if (path.startsWith("history")) return "history";
```

- [ ] **Step 2: Export the test-fetch editor** — in `TablesTab.tsx` change `function QueryTestFetch(` to `export function QueryTestFetch(`.

- [ ] **Step 3: Create `HistoryTab.tsx`**

```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, Input, Label, MessageStrip, MultiComboBox, MultiComboBoxItem, Option, Select, StepInput,
  Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableRowAction, Text, Title,
} from "@ui5/webcomponents-react";
import type { Issue, ModelDef } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";
import { issueFor } from "./useDraftModel.ts";

type Update = (fn: (d: ModelDef) => ModelDef) => void;
type History = NonNullable<ModelDef["history"]>;
const EMPTY: History = { mappings: [], display: [] };

// Admin config for the process page's help pane: which param is the SAP ItemCode (exact help),
// the similarity query, param↔column mappings with match type + weight, and display columns.
export function HistoryTab({ draft, update, issues, modelId, dirty }: {
  draft: ModelDef;
  update: Update;
  issues: Issue[];
  modelId: string;
  dirty: boolean;
}) {
  const qc = useQueryClient();
  const h = draft.history ?? EMPTY;
  const setH = (patch: Partial<History>) => update((d) => ({ ...d, history: { ...EMPTY, ...d.history, ...patch } }));
  const cols = h.query?.columns ?? [];

  const info = useQuery(orpc.models.historyInfo.queryOptions({ input: { id: modelId } }));
  const sync = useMutation(orpc.models.syncHistory.mutationOptions({
    onSuccess: () => qc.invalidateQueries({ queryKey: orpc.models.historyInfo.queryOptions({ input: { id: modelId } }).queryKey }),
  }));

  const err = (path: string) => {
    const i = issueFor(issues, path);
    return i ? <MessageStrip design="Negative" hideCloseButton>{i.message}</MessageStrip> : null;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem", padding: "1rem", maxWidth: "56rem" }}>
      <Title level="H5">Exact help — past documents</Title>
      <div>
        <Label>Parameter holding the SAP item code</Label>
        <Select
          value={h.itemCodeParam ?? ""}
          onChange={(e) => setH({ itemCodeParam: (e.detail.selectedOption as HTMLElement).dataset.k || undefined })}>
          <Option value="" data-k="">—</Option>
          {draft.parameters.map((p) => <Option key={p.key} value={p.key} data-k={p.key}>{p.label} ({p.key})</Option>)}
        </Select>
        {err("history.itemCodeParam")}
      </div>
      <Text>The customer comes from the configuration project itself; only the item code needs a parameter.</Text>

      <Title level="H5">Similarity help — historic configurations</Title>
      {!h.query ? (
        <Button icon="add" style={{ alignSelf: "start" }}
          onClick={() => setH({ query: { target: "b1", path: "", columns: [] } })}>
          Add history query
        </Button>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "8rem 1fr auto", gap: "0.5rem" }}>
            <Select value={h.query.target}
              onChange={(e) => setH({ query: { ...h.query!, target: (e.detail.selectedOption as HTMLElement).dataset.v as "b1" | "beas" } })}>
              <Option value="b1" data-v="b1">B1</Option>
              <Option value="beas" data-v="beas">Beas</Option>
            </Select>
            <Input placeholder="/SQLQueries('cfg_history')/List or an OData path" value={h.query.path}
              onInput={(e) => setH({ query: { ...h.query!, path: e.target.value } })} />
            <Button design="Negative" onClick={() => setH({ query: undefined, mappings: [], display: [] })}>Remove</Button>
          </div>
          {err("history.query")}
          <Text>
            {cols.length
              ? `Columns (from the response): ${cols.join(", ")}.`
              : "Run Test fetch to take the columns from the response."}
          </Text>
          <QueryTestFetch qt={{ name: "history", ...h.query }} onColumns={(columns) => setH({ query: { ...h.query!, columns } })} />

          <Title level="H6">Parameter mappings</Title>
          <Table noDataText="No mappings — add one." rowActionCount={1}
            onRowActionClick={(e) => {
              const i = Number(((e.detail.row as unknown) as HTMLElement).dataset.idx);
              setH({ mappings: h.mappings.filter((_, j) => j !== i) });
            }}
            headerRow={
              <TableHeaderRow>
                <TableHeaderCell><span>Parameter</span></TableHeaderCell>
                <TableHeaderCell><span>Column</span></TableHeaderCell>
                <TableHeaderCell><span>Match</span></TableHeaderCell>
                <TableHeaderCell><span>Weight</span></TableHeaderCell>
              </TableHeaderRow>
            }>
            {h.mappings.map((m, i) => {
              const setM = (patch: Partial<History["mappings"][number]>) =>
                setH({ mappings: h.mappings.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
              return (
                <TableRow key={i} rowKey={`m-${i}`} data-idx={String(i)} actions={<TableRowAction icon="delete" text="Delete" />}>
                  <TableCell>
                    <Select value={m.param} onChange={(e) => setM({ param: (e.detail.selectedOption as HTMLElement).dataset.k! })}>
                      {draft.parameters.map((p) => <Option key={p.key} value={p.key} data-k={p.key}>{p.key}</Option>)}
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Select value={m.column} onChange={(e) => setM({ column: (e.detail.selectedOption as HTMLElement).dataset.c! })}>
                      {cols.map((c) => <Option key={c} value={c} data-c={c}>{c}</Option>)}
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Select value={m.match} onChange={(e) => setM({ match: (e.detail.selectedOption as HTMLElement).dataset.v as History["mappings"][number]["match"] })}>
                      {(["exact", "closeness", "contains"] as const).map((t) => <Option key={t} value={t} data-v={t}>{t}</Option>)}
                    </Select>
                  </TableCell>
                  <TableCell>
                    <StepInput value={m.weight} min={0.5} step={0.5} onChange={(e) => setM({ weight: e.target.value ?? 1 })} />
                  </TableCell>
                </TableRow>
              );
            })}
          </Table>
          {h.mappings.map((_, i) => err(`history.mappings[${i}]`))}
          <Button icon="add" style={{ alignSelf: "start" }} disabled={!cols.length || !draft.parameters.length}
            onClick={() => setH({ mappings: [...h.mappings, { param: draft.parameters[0]!.key, column: cols[0]!, match: "exact", weight: 1 }] })}>
            Add mapping
          </Button>

          <Title level="H6">Columns shown on each result</Title>
          <MultiComboBox
            onSelectionChange={(e) => setH({ display: e.detail.items.map((i) => (i as HTMLElement).getAttribute("text")!) })}>
            {cols.map((c) => <MultiComboBoxItem key={c} text={c} selected={h.display.includes(c)} />)}
          </MultiComboBox>
          {h.display.map((_, i) => err(`history.display[${i}]`))}

          <Title level="H6">Data</Title>
          {sync.error ? <MessageStrip design="Negative" hideCloseButton>{sync.error.message}</MessageStrip> : null}
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <Button icon="synchronize" disabled={sync.isPending || dirty} onClick={() => sync.mutate({ id: modelId })}>
              {sync.isPending ? "Syncing…" : "Sync now"}
            </Button>
            <Text>
              {dirty ? "Save the model first — sync runs the saved query."
                : info.data ? `${info.data.count} rows${info.data.lastSyncedAt ? ` · last synced ${new Date(info.data.lastSyncedAt).toLocaleString()}` : ""} · refreshes hourly`
                : ""}
            </Text>
          </div>
        </>
      )}
    </div>
  );
}
```

Add the `QueryTestFetch` import at the top:

```tsx
import { QueryTestFetch } from "./TablesTab.tsx";
```

- [ ] **Step 4: Mount the section** — in `ModelBuilderPage.tsx`, import `HistoryTab` and add after the `tables` section:

```tsx
<ObjectPageSection id="history" titleText={secTitle("History", "history")}>
  <HistoryTab draft={draft} update={m.update} issues={allIssues} modelId={id} dirty={m.dirty} />
</ObjectPageSection>
```

- [ ] **Step 5: Verify**

Run: `bun --cwd apps/web build`
Expected: build succeeds. Then `bun run dev`, open a model → History tab: pick an item-code param, add a query, Test fetch fills columns, add mappings, Save (0 issues), Sync now reports a row count.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/configurator/HistoryTab.tsx apps/web/src/components/configurator/useDraftModel.ts apps/web/src/components/configurator/TablesTab.tsx apps/web/src/components/configurator/ModelBuilderPage.tsx
git commit -m "feat(web): model builder History tab"
```

---

### Task 7: Web — process-page splitter + HistoryPane with doc-history tab

**Files:**
- Create: `apps/web/src/components/configurator/HistoryPane.tsx`
- Modify: `apps/web/src/components/configurator/ConfigProcessPage.tsx`

**Interfaces:**
- Consumes: `configs.docHistory` (Task 4), splitter pattern from `ModelBuilderPage.tsx`.
- Produces: `HistoryPane({ projectId, model, entries, onCopy })`; ConfigProcessPage owns `paneOpen` and the only-empty merge:
  ```ts
  onCopy: (values: Record<string, Val>) => void  // fills only empty entries, then setEntries → propagate
  ```

- [ ] **Step 1: Create `HistoryPane.tsx`** (doc tab now; similar tab is a stub filled by Task 8):

```tsx
import { useQuery } from "@tanstack/react-query";
import {
  BusyIndicator, Button, MessageStrip, Tab, TabContainer, Table, TableCell, TableHeaderCell,
  TableHeaderRow, TableRow, Tag, Text, Toolbar, ToolbarButton, ToolbarSpacer,
} from "@ui5/webcomponents-react";
import type { Entries, ModelDef, Val } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";

// The process page's right-hand help pane: live B1 doc history + similar past configurations.
export function HistoryPane({ projectId, model, entries, onCopy }: {
  projectId: string;
  model: ModelDef;
  entries: Entries;
  onCopy: (values: Record<string, Val>) => void;
}) {
  const h = model.history;
  const rawItem = h?.itemCodeParam ? entries[h.itemCodeParam] : undefined;
  const itemCode = typeof rawItem === "string" && rawItem ? rawItem : undefined;
  return (
    <TabContainer style={{ height: "100%" }}>
      <Tab text="Customer & item history" icon="history" selected>
        <DocHistory projectId={projectId} itemCode={itemCode} />
      </Tab>
      <Tab text="Similar configurations" icon="detail-view">
        <Similar projectId={projectId} model={model} entries={entries} onCopy={onCopy} />
      </Tab>
    </TabContainer>
  );
}

const matchTag = {
  both: { design: "Positive", text: "customer + item" },
  item: { design: "Information", text: "item" },
  customer: { design: "Neutral", text: "customer" },
} as const;

function DocHistory({ projectId, itemCode }: { projectId: string; itemCode?: string }) {
  const q = useQuery({
    ...orpc.configs.docHistory.queryOptions({ input: { id: projectId, itemCode } }),
    staleTime: 5 * 60_000,
    retry: false, // agent-offline should show its message, not spin
  });
  if (q.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "2rem" }} />;
  if (q.error)
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <MessageStrip design="Information" hideCloseButton>{q.error.message}</MessageStrip>
        <Button style={{ alignSelf: "start" }} onClick={() => void q.refetch()}>Retry</Button>
      </div>
    );
  const { rows, cardCode, itemCode: usedItem } = q.data;
  if (!cardCode && !usedItem)
    return <Text>Assign a customer to this configuration or fill the item parameter to see past documents.</Text>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <Toolbar design="Transparent">
        <Text>{[cardCode && `customer ${cardCode}`, usedItem && `item ${usedItem}`].filter(Boolean).join(" · ")}</Text>
        <ToolbarSpacer />
        <ToolbarButton icon="refresh" disabled={q.isFetching} onClick={() => void q.refetch()} />
      </Toolbar>
      <Table overflowMode="Popin" noDataText="No recent orders or quotations."
        headerRow={
          <TableHeaderRow>
            <TableHeaderCell width="7rem"><span>Doc</span></TableHeaderCell>
            <TableHeaderCell width="6.5rem"><span>Date</span></TableHeaderCell>
            <TableHeaderCell><span>Customer</span></TableHeaderCell>
            <TableHeaderCell><span>Item</span></TableHeaderCell>
            <TableHeaderCell width="4rem"><span>Qty</span></TableHeaderCell>
            <TableHeaderCell width="6rem"><span>Unit price</span></TableHeaderCell>
            <TableHeaderCell width="8rem"><span>Match</span></TableHeaderCell>
          </TableHeaderRow>
        }>
        {rows.map((r, i) => (
          <TableRow key={i} rowKey={`d-${i}`}>
            <TableCell><Text>{r.docType === "order" ? "SO" : "SQ"} {r.docNum}</Text></TableCell>
            <TableCell><Text>{r.docDate.slice(0, 10)}</Text></TableCell>
            <TableCell><Text>{r.cardName || r.cardCode}</Text></TableCell>
            <TableCell><Text>{r.itemCode}</Text></TableCell>
            <TableCell><Text>{r.quantity}</Text></TableCell>
            <TableCell><Text>{r.unitPrice}</Text></TableCell>
            <TableCell><Tag design={matchTag[r.matched].design} hideStateIcon>{matchTag[r.matched].text}</Tag></TableCell>
          </TableRow>
        ))}
      </Table>
    </div>
  );
}

// Filled in by the "similar configurations" task.
function Similar(_props: { projectId: string; model: ModelDef; entries: Entries; onCopy: (v: Record<string, Val>) => void }) {
  return <Text>Coming next.</Text>;
}
```

- [ ] **Step 2: Wrap `ConfigProcessPage` in the splitter** — mirror the ModelBuilderPage pattern exactly (animated flex-basis, both panes mounted). In `ConfigProcessPage.tsx`:

Imports: add `SplitterElement, SplitterLayout, ToggleButton` to the `@ui5/webcomponents-react` import, plus:

```tsx
import type { Val } from "@hera/config-engine";
import { HistoryPane } from "./HistoryPane.tsx";
```

State (with the other overrides):

```tsx
// Slide the help pane like the builder preview: open by default only when the model asks for it.
const [paneOverride, setPaneOverride] = useState<boolean | null>(null);
const [animating, setAnimating] = useState(false);
```

After `const { project, model, latestRun, createdByEmail } = q.data;`:

```tsx
const paneOpen = paneOverride ?? !!model.definition.history;
const PANE_ANIM = "flex-basis 0.28s cubic-bezier(0.2, 0, 0, 1)";
const copyValues = (values: Record<string, Val>) => {
  const next = { ...entries };
  for (const [k, v] of Object.entries(values)) {
    const cur = next[k];
    if ((cur === undefined || cur === null || cur === "") && v !== null && v !== undefined) next[k] = v;
  }
  setEntries(next); // fills only empty params; ConfiguratorForm's propagate() takes it from here
};
```

(note: `entries` is computed above the early returns' current position — keep the existing order: this block goes right after the existing `const entries = …` lines.)

Replace the outer return wrapper: the current root `<div style={{ height: "100%", … }}>` becomes the **first** `SplitterElement`'s child, and the whole thing is wrapped:

```tsx
return (
  <SplitterLayout style={{ height: "100%", width: "100%" }}
    onTransitionEnd={(e) => { if (e.propertyName === "flex-basis") setAnimating(false); }}>
    <SplitterElement size={paneOpen ? "62%" : "100%"} minSize={480}
      style={{ transition: animating ? PANE_ANIM : undefined }}>
      {/* …existing page content div, unchanged… */}
    </SplitterElement>
    <SplitterElement size={paneOpen ? "38%" : "0%"} minSize={paneOpen ? 320 : 0} resizable={paneOpen}
      style={{ transition: animating ? PANE_ANIM : undefined }}>
      <div style={{ flex: 1, minWidth: 0, height: "100%", display: "flex", flexDirection: "column", minHeight: 0,
        overflowY: "auto", padding: "0 0.5rem", opacity: paneOpen ? 1 : 0, transition: "opacity 0.28s ease" }}>
        <HistoryPane projectId={id} model={model.definition} entries={entries} onCopy={copyValues} />
      </div>
    </SplitterElement>
  </SplitterLayout>
);
```

And add the toggle to the existing header (`.hera-wizard-header` div), after the `ObjectStatus`:

```tsx
<ToggleButton icon="history" pressed={paneOpen} style={{ marginLeft: "auto" }}
  onClick={() => { setAnimating(true); setPaneOverride(!paneOpen); }}>
  History
</ToggleButton>
```

- [ ] **Step 3: Verify**

Run: `bun --cwd apps/web build` — succeeds.
Then `bun run dev` (agent running): open a configuration whose project has a customer → pane shows recent SO/SQ line rows, both-match rows first; stop the agent → Information strip with the offline message + Retry; toggle slides the pane.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/configurator/HistoryPane.tsx apps/web/src/components/configurator/ConfigProcessPage.tsx
git commit -m "feat(web): process-page help pane with live doc history"
```

---

### Task 8: Web — similar-configurations tab + copy

**Files:**
- Modify: `apps/web/src/components/configurator/HistoryPane.tsx` (replace the `Similar` stub)

**Interfaces:**
- Consumes: `configs.similar` (Task 5) — `results: { score, matches, display, values }[]`; `onCopy` (Task 7).

- [ ] **Step 1: Implement the tab** — in `HistoryPane.tsx`, add imports `Card, CardHeader` (from `@ui5/webcomponents-react`), `keepPreviousData` (from `@tanstack/react-query`), `useEffect, useState` (from `react`), and replace the `Similar` stub:

```tsx
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const chipDesign = (score: number) => (score >= 0.99 ? "Positive" : score > 0 ? "Critical" : "Neutral");

function Similar({ projectId, model, entries, onCopy }: {
  projectId: string;
  model: ModelDef;
  entries: Entries;
  onCopy: (v: Record<string, Val>) => void;
}) {
  const h = model.history;
  const debounced = useDebounced(entries, 500);
  const anyFilled = !!h?.mappings.some((m) => {
    const v = debounced[m.param];
    return v !== undefined && v !== null && v !== "";
  });
  const q = useQuery({
    ...orpc.configs.similar.queryOptions({ input: { id: projectId, entries: debounced } }),
    enabled: anyFilled,
    placeholderData: keepPreviousData, // re-rank without flashing while typing
    staleTime: 30_000,
  });
  const labelOf = (key: string) => model.parameters.find((p) => p.key === key)?.label ?? key;

  if (!h?.mappings.length)
    return <Text>No similarity mappings configured for this model (model builder → History).</Text>;
  if (!anyFilled) return <Text>Fill a mapped parameter to find similar past configurations.</Text>;
  if (q.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "2rem" }} />;
  if (q.error) return <MessageStrip design="Information" hideCloseButton>{q.error.message}</MessageStrip>;
  if (!q.data.results.length)
    return <Text>No historic rows yet — an admin can press "Sync now" in the model's History tab.</Text>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", opacity: q.isFetching ? 0.6 : 1 }}>
      {q.data.results.map((r, i) => (
        <Card key={i}
          header={
            <CardHeader
              titleText={`${Math.round(r.score * 100)}% match`}
              subtitleText={Object.entries(r.display).map(([k, v]) => `${k}: ${String(v ?? "—")}`).join(" · ")}
              action={<Button design="Emphasized" icon="copy" onClick={() => onCopy(r.values)}>Use values</Button>}
            />
          }>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem", padding: "0 1rem 1rem" }}>
            {r.matches.map((m) => (
              <Tag key={m.param} design={chipDesign(m.score)} hideStateIcon>
                {labelOf(m.param)}: {String(m.value ?? "—")}
              </Tag>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Verify**

Run: `bun --cwd apps/web build` — succeeds.
Manual: fill mapped params → cards appear ~500ms after typing stops, ranked with score + chips (green full match, yellow partial, grey miss); "Use values" fills only the still-empty fields (watch a pre-filled field stay untouched) and the consistency line recomputes.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/configurator/HistoryPane.tsx
git commit -m "feat(web): similar-configurations ranking with one-click copy"
```

---

### Task 9: End-to-end verification (manual, agent + B1 sandbox)

- [ ] **Step 1: Full automated pass**

Run: `bun test packages/config-engine && bun test apps/server && bun --cwd apps/web build`
Expected: everything green.

- [ ] **Step 2: Manual checklist** (`bun run dev`, agent connected to the sandbox)

1. Model builder → History: set item-code param, add a B1 history query, Test fetch → columns appear, add 2–3 mappings (one `closeness` on a number param), pick display columns, Save.
2. "Sync now" → row count appears, `historyInfo` shows last-synced; `select count(*) from config_history` matches.
3. Open a configuration for that model with a customer assigned: pane is open by default; doc tab lists recent SO/SQ lines, both-match rows first; Refresh works.
4. Fill the item-code param → doc list refetches with the item filter.
5. Similar tab: fill mapped params → ranked cards; Copy fills only empty fields; propagate/consistency reacts normally.
6. Stop the agent → doc tab shows the offline hint (Information, not a crash); Sync now fails with the offline message; restart agent → Retry recovers.
7. `DocumentLines/any` sanity (first time only): if B1 rejected the lambda in step 3, apply the `$crossjoin` fallback noted in Task 4 and re-run.

- [ ] **Step 3: Final commit if anything was adjusted**

```bash
git add -A && git commit -m "fix: historic-data e2e adjustments"
```

---

## Out of scope (this iteration)

Auto-prefill/ghost suggestions, pgvector embeddings, per-param tolerance override, jobs table, incremental sync/merge, exact-help caching, doc-history for Beas.
