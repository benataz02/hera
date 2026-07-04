# Configurator Persistence + Server Implementation Plan (Phase 2 of Configurator)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist configurator models/tables/projects/runs, expose the admin (`models`) and user (`configs`) oRPC routers with lookup resolution over the agent bridge, and teach the agent the Beas query target — spec phase 2 ("Persistence + server") of `docs/superpowers/specs/2026-07-03-configurator-design.md`. (The engine — spec phase 1 — is already done on this branch.)

**Architecture:** Four new jsonb-heavy tables in `packages/db` (house style: `tenant_id text`, no FK, uuid PKs). Two new routers in `apps/server`: `models` (adminProcedure — model/table CRUD + `lookupPreview`) and `configs` (userProcedure — project CRUD, `lookups`, `run`, `select`). Lookup resolution is one server helper that turns a `ModelDef`'s `LookupRef`s into the engine's `ResolvedLookups`, fetching `query` sources through the existing `agent_request` + `runRequest` bridge (`kind: "query"`, now with `target: "b1" | "beas"`). `configs.run` snapshots model + lookups + computed candidates into `config_run` (immutable, always-fresh lookups); `configs.select` recomputes totals server-side from stored snapshots so client numbers are never trusted.

**Tech Stack:** Bun workspaces, Drizzle + drizzle-kit (postgres), oRPC, zod ^4.4.3, `@hera/config-engine` (pure, already built), bun test. **No new dependencies.**

## Global Constraints

- Repo root: `/home/benataz02/dev/hera`. Run all commands from there. Commit after every task (style: `feat(configurator): …` / `chore(db): …`, matching `git log`).
- The engine as built is the source of truth where it diverges from the spec sketch: `pricing.priceExpr` (not `marginExpr`); `LookupRef` = `{source:"manual", options:[{value,label?}]} | {source:"table", table, valueCol, labelCol?} | {source:"query", target:"b1"|"beas", path, valueField, labelField?}`; `ModelDef.queryTables: {name,target,path,columns}[]`; `ResolvedLookups = { domains: Record<paramKey, Option[]>, tables: Record<name, {columns: string[], rows: Val[][]}> }`; `Entries = Record<string, Val>` where `Val = number|string|boolean|null|string[]`.
- Schema house style (see `packages/db/src/schema/variant.ts`, `tenant.ts`): `uuid("id").primaryKey().defaultRandom()`, `text("tenant_id").notNull()` (no FK), `timestamp(..., { withTimezone: true })`, leading-tenant indexes, typed jsonb via `.$type<T>()`.
- Agent request kind for configurator GETs is the **existing** `"query"` kind (`apps/agent/src/sync.ts` already routes it to `queryRaw`); we extend its payload with `target`, we do NOT invent a new `query.fetch` kind name.
- B1/Beas credentials stay in the agent `.env` — never in the cloud DB.
- `configs.run` resolves lookups **always fresh**; `configs.lookups` (interactive wizard preview) may serve a ~5-min in-memory cache.
- Enumeration cap stays at the engine default (200); `run` returns `{ capped, widest }` so the UI can say which parameter to close.
- Out of scope (later phases): `configs.createQuote` + agent `quote.create` Quotations POST (phase 5), all web UI (phases 3–4). Dead-remnant cleanup (orphan `config_masterdata` migration state, `mdResolveKey`) IS in scope here (spec mandate).
- Migration gotcha: the drizzle snapshot `0004` still contains the orphan `config_masterdata` table (its schema file was deleted without regenerating). Generate the DROP migration **before** adding the new schema file — drizzle-kit only asks interactive rename questions when a generate has both created and deleted tables; two passes keep it non-interactive.

## File Structure

```
packages/config-engine/src/
  model.ts                    MODIFY: export ValZ, EntriesZ
  output.ts                   MODIFY: OutputOverrides(Z) + override-aware computeOutputs
  index.ts                    MODIFY: export the new names
packages/config-engine/test/
  output.test.ts              MODIFY: override tests
packages/db/
  package.json                MODIFY: add @hera/config-engine dep
  src/schema/configurator.ts  CREATE: config_model, config_table, config_project, config_run
  src/schema/index.ts         MODIFY: export configurator
  drizzle/0005_*.sql          GENERATED: drop config_masterdata
  drizzle/0006_*.sql          GENERATED: create the four tables
apps/server/
  package.json                MODIFY: add @hera/config-engine dep
  src/lookups.ts              CREATE: resolveLookups / optionsFromRef (pure-ish, fetcher injected)
  src/orpc/routers/models.ts  CREATE: admin router (models, tables, lookupPreview)
  src/orpc/routers/configs.ts CREATE: user router (projects, lookups, run, select)
  src/orpc/router.ts          MODIFY: register both
  test/lookups.test.ts        CREATE: resolution unit tests (fake fetcher)
  test/configurator.test.ts   CREATE: DB-backed run/select integration test
apps/agent/src/
  beas-client.ts              CREATE: thin GET client
  sync.ts                     MODIFY: BeasPort + query target routing
  index.ts                    MODIFY: construct BeasClient from env, pass through
apps/agent/test/
  sync.test.ts                CREATE: query routing tests
apps/web/src/orpc.ts          MODIFY: delete dead mdResolveKey
```

---

### Task 1: Remnant cleanup (orphan migration state + dead web helper)

**Files:**
- Generated: `packages/db/drizzle/0005_drop_config_masterdata.sql`
- Modify: `apps/web/src/orpc.ts:12-14`

**Interfaces:**
- Consumes: current drizzle snapshot 0004 (contains `config_masterdata`; no schema file does).
- Produces: a DB with no `config_*` tables and a snapshot that matches the schema files, so Task 3's generate is a pure CREATE.

- [ ] **Step 1: Generate the drop migration (schema files already lack the table)**

Run: `bun run db:generate --name=drop_config_masterdata`
Expected: creates `packages/db/drizzle/0005_drop_config_masterdata.sql`. No interactive prompt (nothing is created, so no rename question).

- [ ] **Step 2: Verify the generated SQL is exactly the drop**

Read `packages/db/drizzle/0005_drop_config_masterdata.sql`. Expected content (nothing else):

```sql
DROP TABLE "config_masterdata" CASCADE;
```

If anything else appears, stop — the snapshot/schema diverged in an unexpected way; investigate before migrating.

- [ ] **Step 3: Apply it**

Run: `bun run db:migrate`
Expected: exits 0, applies 1 migration.

- [ ] **Step 4: Delete the dead `mdResolveKey` from `apps/web/src/orpc.ts`**

Remove these lines (the file's last three):

```ts
// Query key for a master-data source resolution (Configurator value-help). Shared so the editor can
// invalidate the exact entry the runtime caches with staleTime/gcTime: Infinity — keep them in sync.
export const mdResolveKey = (id: string) => ["cfg-md", id] as const;
```

- [ ] **Step 5: Verify nothing references it**

Run: `grep -rn "mdResolveKey" apps/ packages/ --include="*.ts*" | grep -v node_modules`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add packages/db/drizzle apps/web/src/orpc.ts
git commit -m "chore(configurator): drop orphan config_masterdata, remove dead mdResolveKey"
```

---

### Task 2: Engine — override-aware `computeOutputs` + zod exports for the server

Step 4 of the wizard lets users edit BOM/routing lines; `configs.select` must recompute totals server-side from those overrides, and the (phase-4) client recomputes the same numbers live. Both call the same engine, so the override math lives in `packages/config-engine` next to `computeOutputs`. Also export `ValZ`/`EntriesZ` so server input schemas don't re-declare the value union.

**Files:**
- Modify: `packages/config-engine/src/model.ts` (export ValZ, add EntriesZ)
- Modify: `packages/config-engine/src/output.ts`
- Modify: `packages/config-engine/src/index.ts`
- Test: `packages/config-engine/test/output.test.ts` (append a describe block)

**Interfaces:**
- Consumes: existing `computeOutputs(model, lookups, assignment, batchQty)` and the cable-assembly fixture (`test/fixture.ts`).
- Produces (used by Tasks 3, 6):
  - `export type OutputOverrides = { bom?: {id, qtyPerUnit?, unitPrice?, remove?}[]; ops?: {id, setupMin?, runMinPerUnit?, ratePerHour?, remove?}[]; addBom?: {id, itemCode, desc?, qtyPerUnit, unitPrice}[]; addOps?: {id, resource, setupMin, runMinPerUnit, ratePerHour}[] }` + `OutputOverridesZ`
  - `computeOutputs(model, lookups, assignment, batchQty, overrides?)` — 5th optional param, fully backwards compatible
  - `export const ValZ`, `export const EntriesZ` (from `model.ts`)
- Override semantics (fixed): `remove` skips the line; `qtyPerUnit` override replaces the expr result **before** scrap (model's `scrapPct` still applies); `addBom` lines have no scrap and no condition; overridden lines still respect their `condition`; `unitPrice` (the final one) always re-derives via `pricing.priceExpr` from the recomputed `unitCost`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/config-engine/test/output.test.ts` (inside the file, after the existing `describe`; imports at top already cover `computeOutputs`, `lookups`, `model` — add `OutputOverridesZ` to the `../src/output` import):

```ts
describe("computeOutputs overrides", () => {
  // Base (coated steel 16mm², batch 100): materialPerUnit 1.32, laborPerUnit 4.1,
  // unitCost 5.42, unitPrice 7.588 — from the hand-computed test above.

  test("price override + op removal recompute the chain", () => {
    const o = computeOutputs(model, lookups, full, 100, {
      bom: [{ id: "coating", unitPrice: 1 }],
      ops: [{ id: "coat", remove: true }],
    });
    // coating: 1 * 1.05 (scrap) * 1.0 = 1.05; conductor unchanged 0.48
    expect(o.materialPerUnit).toBeCloseTo(1.53);
    expect(o.ops.map((op) => op.id)).toEqual(["cut"]);
    expect(o.laborPerUnit).toBeCloseTo(0.6);
    expect(o.unitCost).toBeCloseTo(2.13);
    expect(o.unitPrice).toBeCloseTo(2.982); // priceExpr (×1.4) re-applied
  });

  test("qty override replaces expr result, scrap still applies", () => {
    const o = computeOutputs(model, lookups, full, 100, {
      bom: [{ id: "coating", qtyPerUnit: 2 }],
    });
    const coat = o.bom.find((l) => l.id === "coating")!;
    expect(coat.qtyPerUnit).toBeCloseTo(2);
    expect(coat.totalQty).toBeCloseTo(210); // 2 * 1.05 * 100
    expect(o.materialPerUnit).toBeCloseTo(0.48 + 2 * 1.05 * 0.8);
  });

  test("added BOM line and added op join the totals", () => {
    const o = computeOutputs(model, lookups, full, 100, {
      addBom: [{ id: "pack", itemCode: "PACK-1", qtyPerUnit: 0.1, unitPrice: 2 }],
      addOps: [{ id: "qa", resource: "QA", setupMin: 0, runMinPerUnit: 0.6, ratePerHour: 60 }],
    });
    expect(o.bom.map((l) => l.id)).toEqual(["conductor", "coating", "pack"]);
    expect(o.bom[2]!.lineTotal).toBeCloseTo(20); // 0.1 * 100 * 2
    expect(o.materialPerUnit).toBeCloseTo(1.52);
    expect(o.ops.map((op) => op.id)).toEqual(["cut", "coat", "qa"]);
    expect(o.laborPerUnit).toBeCloseTo(4.7); // +0.6/min at 60/h = +0.6
    expect(o.unitCost).toBeCloseTo(6.22);
  });

  test("removing a BOM line", () => {
    const o = computeOutputs(model, lookups, full, 100, { bom: [{ id: "coating", remove: true }] });
    expect(o.bom.map((l) => l.id)).toEqual(["conductor"]);
    expect(o.materialPerUnit).toBeCloseTo(0.48);
  });

  test("no overrides object → identical to base", () => {
    const base = computeOutputs(model, lookups, full, 100);
    const same = computeOutputs(model, lookups, full, 100, {});
    expect(same).toEqual(base);
  });

  test("OutputOverridesZ accepts the shapes above", () => {
    expect(
      OutputOverridesZ.safeParse({
        bom: [{ id: "x", qtyPerUnit: 1, remove: false }],
        addOps: [{ id: "y", resource: "R", setupMin: 0, runMinPerUnit: 1, ratePerHour: 60 }],
      }).success,
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/config-engine/test/output.test.ts`
Expected: FAIL — `OutputOverridesZ` not exported / extra argument errors.

- [ ] **Step 3: Implement**

In `packages/config-engine/src/model.ts`, export the value schemas (replace the private `const ValZ` line):

```ts
export const ValZ = z.union([z.number(), z.string(), z.boolean(), z.null()]);
/** User-entry value: scalar Val, or string[] for multicombo params. */
export const EntriesZ = z.record(z.string(), z.union([ValZ, z.array(z.string())]));
```

In `packages/config-engine/src/output.ts`, add after the existing type exports:

```ts
import { z } from "zod";

// Step-4 review edits: per-line numeric overrides + add/remove, applied inside the same
// computation so unitCost/unitPrice/priceExpr stay consistent. Server and browser share this.
export const OutputOverridesZ = z.object({
  bom: z
    .array(
      z.object({
        id: z.string(),
        qtyPerUnit: z.number().min(0).optional(), // replaces the qty expr result, BEFORE scrap
        unitPrice: z.number().min(0).optional(),
        remove: z.boolean().optional(),
      }),
    )
    .optional(),
  ops: z
    .array(
      z.object({
        id: z.string(),
        setupMin: z.number().min(0).optional(),
        runMinPerUnit: z.number().min(0).optional(),
        ratePerHour: z.number().min(0).optional(),
        remove: z.boolean().optional(),
      }),
    )
    .optional(),
  addBom: z
    .array(
      z.object({
        id: z.string(),
        itemCode: z.string(),
        desc: z.string().optional(),
        qtyPerUnit: z.number().min(0),
        unitPrice: z.number().min(0),
      }),
    )
    .optional(),
  addOps: z
    .array(
      z.object({
        id: z.string(),
        resource: z.string(),
        setupMin: z.number().min(0),
        runMinPerUnit: z.number().min(0),
        ratePerHour: z.number().min(0),
      }),
    )
    .optional(),
});
export type OutputOverrides = z.infer<typeof OutputOverridesZ>;
```

Change the `computeOutputs` signature and both loops (full replacement of the function body's BOM and routing sections; the pricing tail is unchanged):

```ts
export function computeOutputs(
  model: ModelDef,
  lookups: ResolvedLookups,
  assignment: Entries,
  batchQty: number,
  overrides?: OutputOverrides,
): Outputs {
  if (batchQty < 1) throw new RangeError(`batchQty must be >= 1, got ${batchQty}`);
  const { values } = bindings(model, lookups, assignment);
  const scope: Scope = { vars: { ...values, qty: batchQty }, tables: lookups.tables };
  const numeric = (src: string, what: string): number => {
    const v = evaluate(src, scope);
    if (typeof v !== "number") throw new DslError(`${what} did not evaluate to a number`, 0, src.length);
    return v;
  };
  const included = (condition: string | undefined) => condition === undefined || evaluate(condition, scope) === true;
  const bomOv = new Map((overrides?.bom ?? []).map((o) => [o.id, o]));
  const opOv = new Map((overrides?.ops ?? []).map((o) => [o.id, o]));

  const bom: BomResult[] = [];
  let materialPerUnit = 0;
  for (const l of model.bom) {
    const ov = bomOv.get(l.id);
    if (ov?.remove || !included(l.condition)) continue;
    const qtyPerUnit = ov?.qtyPerUnit ?? numeric(l.qty, `bom '${l.id}' qty`);
    const effQty = qtyPerUnit * (1 + l.scrapPct / 100);
    const unitPrice = ov?.unitPrice ?? numeric(l.price, `bom '${l.id}' price`);
    const itemCode = String(evaluate(l.itemCode, scope) ?? "");
    const desc = l.desc === undefined ? "" : String(evaluate(l.desc, scope) ?? "");
    const totalQty = effQty * batchQty;
    bom.push({ id: l.id, itemCode, desc, qtyPerUnit, totalQty, unitPrice, lineTotal: totalQty * unitPrice });
    materialPerUnit += effQty * unitPrice;
  }
  for (const a of overrides?.addBom ?? []) {
    const totalQty = a.qtyPerUnit * batchQty; // added lines: no scrap, no condition
    bom.push({
      id: a.id, itemCode: a.itemCode, desc: a.desc ?? "",
      qtyPerUnit: a.qtyPerUnit, totalQty, unitPrice: a.unitPrice, lineTotal: totalQty * a.unitPrice,
    });
    materialPerUnit += a.qtyPerUnit * a.unitPrice;
  }

  const ops: OpResult[] = [];
  let laborPerUnit = 0;
  const pushOp = (id: string, resource: string, setupMin: number, runMinPerUnit: number, rate: number) => {
    const totalMin = setupMin + runMinPerUnit * batchQty;
    ops.push({ id, resource, setupMin, runMinPerUnit, totalMin, cost: (totalMin / 60) * rate });
    laborPerUnit += ((setupMin / batchQty + runMinPerUnit) / 60) * rate;
  };
  for (const o of model.routing) {
    const ov = opOv.get(o.id);
    if (ov?.remove || !included(o.condition)) continue;
    pushOp(
      o.id,
      o.resource,
      ov?.setupMin ?? numeric(o.setupMin, `routing '${o.id}' setupMin`),
      ov?.runMinPerUnit ?? numeric(o.runMinPerUnit, `routing '${o.id}' runMinPerUnit`),
      ov?.ratePerHour ?? numeric(o.ratePerHour, `routing '${o.id}' ratePerHour`),
    );
  }
  for (const a of overrides?.addOps ?? []) pushOp(a.id, a.resource, a.setupMin, a.runMinPerUnit, a.ratePerHour);

  const unitCost = materialPerUnit + laborPerUnit;
  const priceScope: Scope = { vars: { ...scope.vars, unitCost }, tables: lookups.tables };
  const unitPrice = evaluate(model.pricing.priceExpr, priceScope);
  if (typeof unitPrice !== "number")
    throw new DslError("pricing.priceExpr did not evaluate to a number", 0, model.pricing.priceExpr.length);
  // ponytail: raw floats end to end; currency rounding happens at the UI/quote edge
  return { bom, ops, materialPerUnit, laborPerUnit, unitCost, unitPrice, batchTotal: unitPrice * batchQty };
}
```

In `packages/config-engine/src/index.ts`:

```ts
export { ModelDefZ, LookupRefZ, ParamZ, ConstraintZ, BomLineZ, OperationZ, ValZ, EntriesZ } from "./model";
export { computeOutputs, OutputOverridesZ } from "./output";
export type { BomResult, OpResult, Outputs, OutputOverrides } from "./output";
```

(Keep the other existing export lines; the `computeOutputs` line replaces the old one.)

- [ ] **Step 4: Run the full engine suite**

Run: `bun test packages/config-engine`
Expected: PASS, including all pre-existing tests (backwards compatibility).

- [ ] **Step 5: Commit**

```bash
git add packages/config-engine
git commit -m "feat(config-engine): override-aware computeOutputs for review-step edits"
```

---

### Task 3: DB schema — config_model, config_table, config_project, config_run

**Files:**
- Modify: `packages/db/package.json` (add `"@hera/config-engine": "workspace:*"` to `dependencies`)
- Create: `packages/db/src/schema/configurator.ts`
- Modify: `packages/db/src/schema/index.ts`
- Generated: `packages/db/drizzle/0006_configurator_tables.sql`

**Interfaces:**
- Consumes: `ModelDef`, `Entries`, `ResolvedLookups`, `Outputs`, `OutputOverrides`, `Val` types from `@hera/config-engine` (Task 2).
- Produces (used by Tasks 5–7): drizzle tables `configModel`, `configTable`, `configProject`, `configRun`; types `ConfigTableColumn`, `ProjectStatus`, `ProjectCustomer`, `RunCandidate`, `RunSelection`.

- [ ] **Step 1: Add the workspace dep**

In `packages/db/package.json` `dependencies`, add:

```json
"@hera/config-engine": "workspace:*",
```

Run: `bun install`
Expected: exits 0.

- [ ] **Step 2: Write `packages/db/src/schema/configurator.ts`**

```ts
import { index, jsonb, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { Entries, ModelDef, OutputOverrides, Outputs, ResolvedLookups, Val } from "@hera/config-engine";

// Configurator persistence: mutable model + immutable snapshot-on-run (model + lookups + computed
// outputs frozen per engine run). Spec: docs/superpowers/specs/2026-07-03-configurator-design.md.

// The whole model is one jsonb document (ModelDef), loaded/saved whole like ui_variant.definition.
export const configModel = pgTable(
  "config_model",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    definition: jsonb("definition").$type<ModelDef>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("config_model_tenant_idx").on(t.tenantId)],
);

export type ConfigTableColumn = { key: string; label: string; type: "string" | "number" | "boolean" };

// Admin-maintained lookup tables; LookupRef/LOOKUP() reference them by name.
// ponytail: jsonb rows; real table if >10k rows
export const configTable = pgTable(
  "config_table",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    columns: jsonb("columns").$type<ConfigTableColumn[]>().notNull().default([]),
    rows: jsonb("rows").$type<Val[][]>().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("config_table_tenant_name_uq").on(t.tenantId, t.name)],
);

export type ProjectStatus = "draft" | "calculated" | "quoted";
export type ProjectCustomer = { cardCode: string; cardName: string };

// The "Configurations" document: customer + model + entries + batches; runs hang off it.
export const configProject = pgTable(
  "config_project",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    modelId: uuid("model_id").notNull(),
    name: text("name").notNull(),
    customer: jsonb("customer").$type<ProjectCustomer>(),
    status: text("status").$type<ProjectStatus>().notNull().default("draft"),
    entries: jsonb("entries").$type<Entries>().notNull().default({}),
    batches: jsonb("batches").$type<number[]>().notNull().default([]),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("config_project_tenant_status_idx").on(t.tenantId, t.status)],
);

export type RunCandidate = { assignment: Entries; perBatch: { batchQty: number; outputs: Outputs }[] };
export type RunSelection = { candidateIdx: number; batchQty: number; overrides?: OutputOverrides };

// Immutable snapshot of one engine run. b1DocEntry/quotedAt are written by phase 5 (createQuote).
export const configRun = pgTable(
  "config_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    modelSnapshot: jsonb("model_snapshot").$type<ModelDef>().notNull(),
    lookupSnapshot: jsonb("lookup_snapshot").$type<ResolvedLookups>().notNull(),
    entries: jsonb("entries").$type<Entries>().notNull(),
    candidates: jsonb("candidates").$type<RunCandidate[]>().notNull(),
    selection: jsonb("selection").$type<RunSelection[]>(),
    b1DocEntry: integer("b1_doc_entry"),
    quotedAt: timestamp("quoted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("config_run_tenant_project_idx").on(t.tenantId, t.projectId)],
);
```

- [ ] **Step 3: Export it**

In `packages/db/src/schema/index.ts` append:

```ts
export * from "./configurator.ts";
```

- [ ] **Step 4: Generate + inspect + migrate**

Run: `bun run db:generate --name=configurator_tables`
Expected: `0006_configurator_tables.sql` with exactly four `CREATE TABLE` statements (`config_model`, `config_table`, `config_project`, `config_run`), three `CREATE INDEX`, one `CREATE UNIQUE INDEX`. No `DROP`, no prompt.

Run: `bun run db:migrate`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "feat(db): configurator schema (model, table, project, run)"
```

---

### Task 4: Server lookup resolution helper

One helper turns `LookupRef`s + `queryTables` into the engine's `ResolvedLookups`. The agent hop is injected as a function so tests (and the run integration test) never need an agent.

**Files:**
- Modify: `apps/server/package.json` (add `"@hera/config-engine": "workspace:*"` to `dependencies`, then `bun install`)
- Create: `apps/server/src/lookups.ts`
- Test: `apps/server/test/lookups.test.ts`

**Interfaces:**
- Consumes: engine types (`ModelDef`, `LookupRef`, `Option`, `ResolvedLookups`, `ResolvedTable`, `Val`).
- Produces (used by Tasks 5–7):
  - `type QueryFetcher = (target: "b1" | "beas", path: string) => Promise<unknown>`
  - `type TenantTable = { name: string; columns: { key: string }[]; rows: Val[][] }`
  - `resolveLookups(model: ModelDef, tenantTables: TenantTable[], fetchQuery: QueryFetcher): Promise<ResolvedLookups>`
  - `optionsFromRef(ref: LookupRef, tables: Record<string, ResolvedTable>, fetchQuery: QueryFetcher): Promise<Option[]>`
  - `tablesFromTenant(tenantTables: TenantTable[]): Record<string, ResolvedTable>`

- [ ] **Step 1: Add the dep**

In `apps/server/package.json` `dependencies` add `"@hera/config-engine": "workspace:*"`, then run `bun install`.

- [ ] **Step 2: Write the failing tests — `apps/server/test/lookups.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import type { ModelDef } from "@hera/config-engine";
import { optionsFromRef, resolveLookups, tablesFromTenant, type QueryFetcher } from "../src/lookups.ts";

const noFetch: QueryFetcher = async () => {
  throw new Error("unexpected fetch");
};

const minimalModel = (over: Partial<ModelDef>): ModelDef => ({
  name: "m",
  parameters: [],
  structure: { sections: [] },
  computed: [],
  constraints: [],
  bom: [],
  routing: [],
  queryTables: [],
  pricing: { priceExpr: "1", quoteItemCode: "X" },
  batchDefaults: [1],
  ...over,
});

describe("optionsFromRef", () => {
  test("manual: label defaults to String(value)", async () => {
    const opts = await optionsFromRef(
      { source: "manual", options: [{ value: 10 }, { value: "alu", label: "Aluminium" }] },
      {},
      noFetch,
    );
    expect(opts).toEqual([
      { value: 10, label: "10" },
      { value: "alu", label: "Aluminium" },
    ]);
  });

  test("table: projects valueCol/labelCol by name", async () => {
    const tables = tablesFromTenant([
      { name: "colors", columns: [{ key: "code" }, { key: "name" }], rows: [["R", "Red"], ["B", "Blue"]] },
    ]);
    const opts = await optionsFromRef(
      { source: "table", table: "colors", valueCol: "code", labelCol: "name" },
      tables,
      noFetch,
    );
    expect(opts).toEqual([
      { value: "R", label: "Red" },
      { value: "B", label: "Blue" },
    ]);
  });

  test("table: unknown table/column errors name the culprit", async () => {
    await expect(optionsFromRef({ source: "table", table: "nope", valueCol: "x" }, {}, noFetch)).rejects.toThrow(
      "nope",
    );
    const tables = tablesFromTenant([{ name: "t", columns: [{ key: "a" }], rows: [] }]);
    await expect(optionsFromRef({ source: "table", table: "t", valueCol: "x" }, tables, noFetch)).rejects.toThrow("'x'");
  });

  test("query: unwraps { value: [...] } and maps fields", async () => {
    const fetcher: QueryFetcher = async (target, path) => {
      expect(target).toBe("b1");
      expect(path).toBe("/Items?$select=ItemCode,ItemName");
      return { value: [{ ItemCode: "A1", ItemName: "Widget" }] };
    };
    const opts = await optionsFromRef(
      { source: "query", target: "b1", path: "/Items?$select=ItemCode,ItemName", valueField: "ItemCode", labelField: "ItemName" },
      {},
      fetcher,
    );
    expect(opts).toEqual([{ value: "A1", label: "Widget" }]);
  });

  test("query: non-array response errors with target + path", async () => {
    await expect(
      optionsFromRef({ source: "query", target: "beas", path: "/bad", valueField: "x" }, {}, async () => ({ oops: 1 })),
    ).rejects.toThrow("beas GET /bad");
  });
});

describe("resolveLookups", () => {
  test("builds domains + tables; queryTables fetched and projected; fetches deduped per (target,path)", async () => {
    let calls = 0;
    const fetcher: QueryFetcher = async () => {
      calls++;
      return { value: [{ Code: "M1", Price: 5 }, { Code: "M2", Price: 7 }] };
    };
    const model = minimalModel({
      parameters: [
        {
          key: "mat", label: "Material", type: "string", ui: "select",
          domain: { kind: "options", ref: { source: "query", target: "b1", path: "/Items", valueField: "Code" } },
        },
        {
          key: "grade", label: "Grade", type: "string", ui: "select",
          domain: { kind: "options", ref: { source: "manual", options: [{ value: "std" }] } },
        },
      ],
      queryTables: [{ name: "prices", target: "b1", path: "/Items", columns: ["Code", "Price"] }],
    });
    const lookups = await resolveLookups(model, [], fetcher);
    expect(lookups.domains.mat).toEqual([
      { value: "M1", label: "M1" },
      { value: "M2", label: "M2" },
    ]);
    expect(lookups.domains.grade).toEqual([{ value: "std", label: "std" }]);
    expect(lookups.tables.prices).toEqual({ columns: ["Code", "Price"], rows: [["M1", 5], ["M2", 7]] });
    expect(calls).toBe(1); // same (target, path) fetched once
  });

  test("tenant config_tables land in tables and are usable as a domain source", async () => {
    const model = minimalModel({
      parameters: [
        {
          key: "color", label: "Color", type: "string", ui: "select",
          domain: { kind: "options", ref: { source: "table", table: "colors", valueCol: "code" } },
        },
      ],
    });
    const lookups = await resolveLookups(
      model,
      [{ name: "colors", columns: [{ key: "code" }], rows: [["R"], ["B"]] }],
      noFetch,
    );
    expect(lookups.tables.colors).toEqual({ columns: ["code"], rows: [["R"], ["B"]] });
    expect(lookups.domains.color!.map((o) => o.value)).toEqual(["R", "B"]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test apps/server/test/lookups.test.ts`
Expected: FAIL — cannot resolve `../src/lookups.ts`.

- [ ] **Step 4: Implement `apps/server/src/lookups.ts`**

```ts
import type { LookupRef, ModelDef, Option, ResolvedLookups, ResolvedTable, Val } from "@hera/config-engine";

// Resolve a model's external references (manual lists, tenant config_tables, agent-backed
// B1/Beas GETs) into the engine's ResolvedLookups. The agent hop is injected so this stays
// testable and DB/transport-free; callers wire runRequest(tenantId, "query", ...) in.

export type QueryFetcher = (target: "b1" | "beas", path: string) => Promise<unknown>;
export type TenantTable = { name: string; columns: { key: string }[]; rows: Val[][] };

// Service Layer (and our Beas client) return collections as { value: [...] }; accept bare arrays too.
function rowsOf(json: unknown, target: string, path: string): Record<string, unknown>[] {
  const v = Array.isArray(json) ? json : (json as { value?: unknown } | null)?.value;
  if (!Array.isArray(v)) throw new Error(`Lookup ${target} GET ${path} did not return a row array`);
  return v as Record<string, unknown>[];
}

const asVal = (v: unknown): Val =>
  typeof v === "number" || typeof v === "boolean" || v === null || v === undefined ? ((v ?? null) as Val) : String(v);

export function tablesFromTenant(tenantTables: TenantTable[]): Record<string, ResolvedTable> {
  const out: Record<string, ResolvedTable> = {};
  for (const t of tenantTables) out[t.name] = { columns: t.columns.map((c) => c.key), rows: t.rows };
  return out;
}

function project(t: ResolvedTable, name: string, valueCol: string, labelCol?: string): Option[] {
  const vi = t.columns.indexOf(valueCol);
  if (vi < 0) throw new Error(`Table '${name}' has no column '${valueCol}'`);
  const li = labelCol === undefined ? vi : t.columns.indexOf(labelCol);
  if (li < 0) throw new Error(`Table '${name}' has no column '${labelCol}'`);
  return t.rows.map((r) => ({ value: r[vi] ?? null, label: String(r[li] ?? r[vi] ?? "") }));
}

export async function optionsFromRef(
  ref: LookupRef,
  tables: Record<string, ResolvedTable>,
  fetchQuery: QueryFetcher,
): Promise<Option[]> {
  switch (ref.source) {
    case "manual":
      return ref.options.map((o) => ({ value: o.value, label: o.label ?? String(o.value) }));
    case "table": {
      const t = tables[ref.table];
      if (!t) throw new Error(`Unknown lookup table '${ref.table}'`);
      return project(t, ref.table, ref.valueCol, ref.labelCol);
    }
    case "query": {
      const rows = rowsOf(await fetchQuery(ref.target, ref.path), ref.target, ref.path);
      return rows.map((r) => ({
        value: asVal(r[ref.valueField]),
        label: String(r[ref.labelField ?? ref.valueField] ?? ""),
      }));
    }
  }
}

export async function resolveLookups(
  model: ModelDef,
  tenantTables: TenantTable[],
  fetchQuery: QueryFetcher,
): Promise<ResolvedLookups> {
  // Memoize per (target, path): a query domain and a queryTable often share one GET.
  const fetched = new Map<string, Promise<unknown>>();
  const fetchOnce: QueryFetcher = (target, path) => {
    const k = `${target} ${path}`;
    let p = fetched.get(k);
    if (!p) fetched.set(k, (p = fetchQuery(target, path)));
    return p;
  };

  const tables = tablesFromTenant(tenantTables);
  for (const qt of model.queryTables) {
    const rows = rowsOf(await fetchOnce(qt.target, qt.path), qt.target, qt.path);
    tables[qt.name] = { columns: qt.columns, rows: rows.map((r) => qt.columns.map((c) => asVal(r[c]))) };
  }

  const domains: ResolvedLookups["domains"] = {};
  for (const p of model.parameters) {
    if (p.domain?.kind !== "options") continue;
    domains[p.key] = await optionsFromRef(p.domain.ref, tables, fetchOnce);
  }
  return { domains, tables };
}
```

- [ ] **Step 5: Run tests**

Run: `bun test apps/server/test/lookups.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/server
git commit -m "feat(server): lookup resolution (manual/table/query) with injected agent fetcher"
```

---

### Task 5: `models` router (admin) + registration

CRUD is deliberately thin (validated by `ModelDefZ`/`checkModel` from the already-tested engine and by Task 4's helpers); this task's verification is typecheck + registration, with the run-path integration test (Task 7) exercising the persistence for real.

**Files:**
- Create: `apps/server/src/orpc/routers/models.ts`
- Modify: `apps/server/src/orpc/router.ts`

**Interfaces:**
- Consumes: `adminProcedure` (`../base.ts`), `assertAgentReady`/`runRequest` (`./entities.ts`), `optionsFromRef`/`tablesFromTenant`/`QueryFetcher` (Task 4), `checkModel`/`ModelDefZ`/`LookupRefZ`/`ValZ` (engine), `configModel`/`configTable`/`configProject` (Task 3).
- Produces: oRPC surface `models.{list,get,save,remove}`, `models.tables.{list,save,remove}`, `models.lookupPreview` — consumed by phase-3 builder UI. `save` rejects invalid models with `ORPCError("BAD_REQUEST", { data: { issues: Issue[] } })` where `Issue = { path, message, from?, to? }`.

- [ ] **Step 1: Write `apps/server/src/orpc/routers/models.ts`**

```ts
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, configModel, configProject, configTable } from "@hera/db";
import { checkModel, LookupRefZ, ModelDefZ, ValZ } from "@hera/config-engine";
import { adminProcedure } from "../base.ts";
import { assertAgentReady, runRequest } from "./entities.ts";
import { optionsFromRef, tablesFromTenant, type QueryFetcher, type TenantTable } from "../../lookups.ts";

// Admin-only configurator model builder API. save is the gate: a model that passes
// ModelDefZ + checkModel here can never produce a parse/unknown-ref error at runtime.

const ColumnZ = z.object({
  key: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "must be a valid identifier"),
  label: z.string(),
  type: z.enum(["string", "number", "boolean"]),
});

export async function tenantTables(tenantId: string): Promise<TenantTable[]> {
  return db
    .select({ name: configTable.name, columns: configTable.columns, rows: configTable.rows })
    .from(configTable)
    .where(eq(configTable.tenantId, tenantId));
}

export function agentFetcher(tenantId: string): QueryFetcher {
  return async (target, path) => {
    await assertAgentReady(tenantId);
    return runRequest(tenantId, "query", { target, path });
  };
}

export const modelsRouter = {
  list: adminProcedure.handler(({ context }) =>
    db
      .select({ id: configModel.id, name: configModel.name, updatedAt: configModel.updatedAt })
      .from(configModel)
      .where(eq(configModel.tenantId, context.tenantId))
      .orderBy(configModel.name),
  ),

  get: adminProcedure.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
    const [row] = await db
      .select()
      .from(configModel)
      .where(and(eq(configModel.id, input.id), eq(configModel.tenantId, context.tenantId)))
      .limit(1);
    if (!row) throw new ORPCError("NOT_FOUND");
    return row;
  }),

  save: adminProcedure
    .input(z.object({ id: z.uuid().optional(), definition: ModelDefZ }))
    .handler(async ({ input, context }) => {
      const known = (await tenantTables(context.tenantId)).map((t) => t.name);
      const issues = checkModel(input.definition, known);
      if (issues.length) throw new ORPCError("BAD_REQUEST", { message: "Model has errors", data: { issues } });
      const fields = { name: input.definition.name, definition: input.definition, updatedAt: new Date() };
      if (input.id) {
        const updated = await db
          .update(configModel)
          .set(fields)
          .where(and(eq(configModel.id, input.id), eq(configModel.tenantId, context.tenantId)))
          .returning({ id: configModel.id });
        if (!updated.length) throw new ORPCError("NOT_FOUND");
        return { id: input.id };
      }
      const [ins] = await db
        .insert(configModel)
        .values({ tenantId: context.tenantId, ...fields })
        .returning({ id: configModel.id });
      return { id: ins!.id };
    }),

  remove: adminProcedure.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
    const [inUse] = await db
      .select({ id: configProject.id })
      .from(configProject)
      .where(and(eq(configProject.tenantId, context.tenantId), eq(configProject.modelId, input.id)))
      .limit(1);
    if (inUse) throw new ORPCError("BAD_REQUEST", { message: "Model is used by existing configurations" });
    await db.delete(configModel).where(and(eq(configModel.id, input.id), eq(configModel.tenantId, context.tenantId)));
    return { ok: true };
  }),

  tables: {
    list: adminProcedure.handler(({ context }) =>
      db.select().from(configTable).where(eq(configTable.tenantId, context.tenantId)).orderBy(configTable.name),
    ),

    save: adminProcedure
      .input(
        z.object({
          id: z.uuid().optional(),
          name: z.string().min(1),
          columns: z.array(ColumnZ).min(1),
          rows: z.array(z.array(ValZ)),
        }),
      )
      .handler(async ({ input, context }) => {
        for (const r of input.rows) {
          if (r.length !== input.columns.length)
            throw new ORPCError("BAD_REQUEST", { message: `Row has ${r.length} cells, expected ${input.columns.length}` });
        }
        const fields = { name: input.name, columns: input.columns, rows: input.rows, updatedAt: new Date() };
        try {
          if (input.id) {
            const updated = await db
              .update(configTable)
              .set(fields)
              .where(and(eq(configTable.id, input.id), eq(configTable.tenantId, context.tenantId)))
              .returning({ id: configTable.id });
            if (!updated.length) throw new ORPCError("NOT_FOUND");
            return { id: input.id };
          }
          const [ins] = await db
            .insert(configTable)
            .values({ tenantId: context.tenantId, ...fields })
            .returning({ id: configTable.id });
          return { id: ins!.id };
        } catch (e) {
          if ((e as { code?: string }).code === "23505")
            throw new ORPCError("BAD_REQUEST", { message: `A table named '${input.name}' already exists` });
          throw e;
        }
      }),

    // ponytail: no reference check against models (names live inside jsonb); a dangling
    // reference fails at resolve time with "Unknown lookup table '<name>'".
    remove: adminProcedure.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
      await db.delete(configTable).where(and(eq(configTable.id, input.id), eq(configTable.tenantId, context.tenantId)));
      return { ok: true };
    }),
  },

  // Builder "Preview" button: resolve any LookupRef against live sources, first N options.
  lookupPreview: adminProcedure
    .input(z.object({ ref: LookupRefZ, limit: z.number().int().min(1).max(100).default(20) }))
    .handler(async ({ input, context }) => {
      const tables = tablesFromTenant(await tenantTables(context.tenantId));
      const options = await optionsFromRef(input.ref, tables, agentFetcher(context.tenantId));
      return { options: options.slice(0, input.limit) };
    }),
};
```

- [ ] **Step 2: Register in `apps/server/src/orpc/router.ts`**

```ts
import { syncRouter } from "./routers/sync.ts";
import { entitiesRouter } from "./routers/entities.ts";
import { variantsRouter } from "./routers/variants.ts";
import { modelsRouter } from "./routers/models.ts";

export const router = {
  sync: syncRouter,
  entities: entitiesRouter,
  variants: variantsRouter,
  models: modelsRouter,
};

export type AppRouter = typeof router;
```

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit -p apps/server`
Expected: exits 0, no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/server
git commit -m "feat(server): models router — model/table CRUD, save gate, lookupPreview"
```

---

### Task 6: `configs` router (user) — projects, lookups cache, run, select

**Files:**
- Create: `apps/server/src/orpc/routers/configs.ts`
- Modify: `apps/server/src/orpc/router.ts`

**Interfaces:**
- Consumes: `userProcedure`, `assertAgentReady` (`./entities.ts`), `tenantTables`/`agentFetcher` (Task 5), `resolveLookups`/`QueryFetcher` (Task 4), engine `enumerate`/`computeOutputs`/`propagate`/`DslError`/`EntriesZ`/`OutputOverridesZ`, db tables + `RunCandidate`/`RunSelection` types (Task 3).
- Produces:
  - oRPC surface `configs.{models,list,get,create,update,remove,lookups,run,select}` — consumed by phase-4 wizard.
  - `export async function executeRun(tenantId: string, projectId: string, fetchQuery: QueryFetcher): Promise<{ runId: string; candidateCount: number; capped: boolean; widest?: { key: string; size: number } }>` — also called by the Task 7 integration test.
  - `export function applySelection(run: { modelSnapshot: ModelDef; lookupSnapshot: ResolvedLookups; candidates: RunCandidate[] }, selection: RunSelection[]): { candidateIdx: number; batchQty: number; outputs: Outputs }[]` — pure; also used by Task 7.

- [ ] **Step 1: Write `apps/server/src/orpc/routers/configs.ts`**

```ts
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db, configModel, configProject, configRun, type RunCandidate, type RunSelection } from "@hera/db";
import {
  computeOutputs, DslError, enumerate, EntriesZ, OutputOverridesZ, propagate,
  type ModelDef, type Outputs, type ResolvedLookups,
} from "@hera/config-engine";
import { userProcedure } from "../base.ts";
import { assertAgentReady } from "./entities.ts";
import { agentFetcher, tenantTables } from "./models.ts";
import { resolveLookups, type QueryFetcher } from "../../lookups.ts";

// The configuration process API: any member drives a project (draft -> calculated via run).
// Trust model: browser propagates for preview; THESE handlers compute the numbers that get
// stored. Lookups: ~5-min cache for interactive use, always fresh inside executeRun.

const needsAgent = (m: ModelDef): boolean =>
  m.queryTables.length > 0 || m.parameters.some((p) => p.domain?.kind === "options" && p.domain.ref.source === "query");

async function loadModel(tenantId: string, modelId: string) {
  const [m] = await db
    .select({ id: configModel.id, name: configModel.name, definition: configModel.definition, updatedAt: configModel.updatedAt })
    .from(configModel)
    .where(and(eq(configModel.id, modelId), eq(configModel.tenantId, tenantId)))
    .limit(1);
  if (!m) throw new ORPCError("NOT_FOUND", { message: "Model not found" });
  return m;
}

async function freshLookups(tenantId: string, model: ModelDef, fetchQuery: QueryFetcher): Promise<ResolvedLookups> {
  try {
    return await resolveLookups(model, await tenantTables(tenantId), fetchQuery);
  } catch (e) {
    if (e instanceof ORPCError) throw e; // agent offline etc. — keep the specific message
    throw new ORPCError("BAD_GATEWAY", { message: e instanceof Error ? e.message : String(e) });
  }
}

// ponytail: per-process cache keyed by model updatedAt (auto-invalidates on save);
// Redis/LRU only if the server ever scales past one Bun process.
const CACHE_TTL_MS = 5 * 60_000;
const lookupCache = new Map<string, { at: number; lookups: ResolvedLookups }>();

export async function executeRun(tenantId: string, projectId: string, fetchQuery: QueryFetcher) {
  const [project] = await db
    .select()
    .from(configProject)
    .where(and(eq(configProject.id, projectId), eq(configProject.tenantId, tenantId)))
    .limit(1);
  if (!project) throw new ORPCError("NOT_FOUND");
  if (!project.batches.length) throw new ORPCError("BAD_REQUEST", { message: "Add at least one batch quantity" });

  const model = await loadModel(tenantId, project.modelId);
  const lookups = await freshLookups(tenantId, model.definition, fetchQuery); // always fresh at run time

  try {
    const pre = propagate(model.definition, lookups, project.entries);
    if (pre.conflicts.length)
      throw new ORPCError("BAD_REQUEST", {
        message: `Configuration has conflicts: ${pre.conflicts.map((c) => c.message).join("; ")}`,
      });
    const en = enumerate(model.definition, lookups, project.entries);
    if (!en.candidates.length)
      throw new ORPCError("BAD_REQUEST", { message: "No valid configuration completes the current entries" });

    const candidates: RunCandidate[] = en.candidates.map((assignment) => ({
      assignment,
      perBatch: project.batches.map((batchQty) => ({
        batchQty,
        outputs: computeOutputs(model.definition, lookups, assignment, batchQty),
      })),
    }));

    const runId = await db.transaction(async (tx) => {
      const [run] = await tx
        .insert(configRun)
        .values({
          tenantId, projectId,
          modelSnapshot: model.definition, lookupSnapshot: lookups,
          entries: project.entries, candidates,
        })
        .returning({ id: configRun.id });
      await tx
        .update(configProject)
        .set({ status: "calculated", updatedAt: new Date() })
        .where(eq(configProject.id, projectId));
      return run!.id;
    });
    return { runId, candidateCount: candidates.length, capped: en.capped, widest: en.widest };
  } catch (e) {
    // Save-gated models shouldn't hit DSL errors, but live lookup data can (missing LOOKUP row).
    if (e instanceof DslError) throw new ORPCError("BAD_REQUEST", { message: e.message });
    throw e;
  }
}

export function applySelection(
  run: { modelSnapshot: ModelDef; lookupSnapshot: ResolvedLookups; candidates: RunCandidate[] },
  selection: RunSelection[],
): { candidateIdx: number; batchQty: number; outputs: Outputs }[] {
  return selection.map((s) => {
    const cand = run.candidates[s.candidateIdx];
    if (!cand) throw new ORPCError("BAD_REQUEST", { message: `No candidate at index ${s.candidateIdx}` });
    try {
      const outputs = computeOutputs(run.modelSnapshot, run.lookupSnapshot, cand.assignment, s.batchQty, s.overrides);
      return { candidateIdx: s.candidateIdx, batchQty: s.batchQty, outputs };
    } catch (e) {
      if (e instanceof DslError || e instanceof RangeError) throw new ORPCError("BAD_REQUEST", { message: e.message });
      throw e;
    }
  });
}

const SelectionZ = z.object({
  candidateIdx: z.number().int().min(0),
  batchQty: z.number().int().min(1),
  overrides: OutputOverridesZ.optional(),
});

export const configsRouter = {
  // Members can list models (id + name only) to start a configuration; editing stays admin-only.
  models: userProcedure.handler(({ context }) =>
    db
      .select({ id: configModel.id, name: configModel.name })
      .from(configModel)
      .where(eq(configModel.tenantId, context.tenantId))
      .orderBy(configModel.name),
  ),

  list: userProcedure.handler(({ context }) =>
    db
      .select({
        id: configProject.id, name: configProject.name, status: configProject.status,
        customer: configProject.customer, modelName: configModel.name, updatedAt: configProject.updatedAt,
      })
      .from(configProject)
      .innerJoin(configModel, eq(configModel.id, configProject.modelId))
      .where(eq(configProject.tenantId, context.tenantId))
      .orderBy(desc(configProject.updatedAt)),
  ),

  get: userProcedure.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
    const [project] = await db
      .select()
      .from(configProject)
      .where(and(eq(configProject.id, input.id), eq(configProject.tenantId, context.tenantId)))
      .limit(1);
    if (!project) throw new ORPCError("NOT_FOUND");
    const model = await loadModel(context.tenantId, project.modelId);
    const [latestRun] = await db
      .select()
      .from(configRun)
      .where(and(eq(configRun.projectId, project.id), eq(configRun.tenantId, context.tenantId)))
      .orderBy(desc(configRun.createdAt))
      .limit(1);
    return { project, model, latestRun: latestRun ?? null };
  }),

  create: userProcedure
    .input(z.object({ modelId: z.uuid(), name: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      const model = await loadModel(context.tenantId, input.modelId);
      const [ins] = await db
        .insert(configProject)
        .values({
          tenantId: context.tenantId, modelId: model.id, name: input.name,
          batches: model.definition.batchDefaults, createdBy: context.userId,
        })
        .returning({ id: configProject.id });
      return { id: ins!.id };
    }),

  update: userProcedure
    .input(
      z.object({
        id: z.uuid(),
        name: z.string().min(1).optional(),
        customer: z.object({ cardCode: z.string(), cardName: z.string() }).nullable().optional(),
        entries: EntriesZ.optional(),
        batches: z.array(z.number().int().min(1)).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const { id, ...rest } = input;
      const fields: Partial<typeof configProject.$inferInsert> = { ...rest, updatedAt: new Date() };
      // Changing what gets computed invalidates a previous run's "calculated" claim.
      if (input.entries !== undefined || input.batches !== undefined) fields.status = "draft";
      const updated = await db
        .update(configProject)
        .set(fields)
        .where(and(eq(configProject.id, id), eq(configProject.tenantId, context.tenantId)))
        .returning({ id: configProject.id });
      if (!updated.length) throw new ORPCError("NOT_FOUND");
      return { ok: true };
    }),

  remove: userProcedure.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
    await db.transaction(async (tx) => {
      await tx.delete(configRun).where(and(eq(configRun.projectId, input.id), eq(configRun.tenantId, context.tenantId)));
      await tx.delete(configProject).where(and(eq(configProject.id, input.id), eq(configProject.tenantId, context.tenantId)));
    });
    return { ok: true };
  }),

  // Resolved lookups for client-side live propagation (wizard step 1). Cached ~5 min;
  // key includes the model's updatedAt so a model save is picked up immediately.
  lookups: userProcedure.input(z.object({ modelId: z.uuid() })).handler(async ({ input, context }) => {
    const model = await loadModel(context.tenantId, input.modelId);
    const key = `${context.tenantId}:${model.id}:${model.updatedAt.getTime()}`;
    const hit = lookupCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.lookups;
    if (needsAgent(model.definition)) await assertAgentReady(context.tenantId);
    const lookups = await freshLookups(context.tenantId, model.definition, agentFetcher(context.tenantId));
    lookupCache.set(key, { at: Date.now(), lookups });
    return lookups;
  }),

  run: userProcedure.input(z.object({ projectId: z.uuid() })).handler(async ({ input, context }) => {
    const [project] = await db
      .select({ modelId: configProject.modelId })
      .from(configProject)
      .where(and(eq(configProject.id, input.projectId), eq(configProject.tenantId, context.tenantId)))
      .limit(1);
    if (!project) throw new ORPCError("NOT_FOUND");
    const model = await loadModel(context.tenantId, project.modelId);
    if (needsAgent(model.definition)) await assertAgentReady(context.tenantId);
    return executeRun(context.tenantId, input.projectId, agentFetcher(context.tenantId));
  }),

  // Store the user's candidate/batch/override picks; totals are recomputed HERE from the
  // run snapshot — client-sent numbers are never persisted.
  select: userProcedure
    .input(z.object({ runId: z.uuid(), selection: z.array(SelectionZ).min(1) }))
    .handler(async ({ input, context }) => {
      const [run] = await db
        .select()
        .from(configRun)
        .where(and(eq(configRun.id, input.runId), eq(configRun.tenantId, context.tenantId)))
        .limit(1);
      if (!run) throw new ORPCError("NOT_FOUND");
      const selections = applySelection(run, input.selection);
      await db.update(configRun).set({ selection: input.selection }).where(eq(configRun.id, run.id));
      return { selections };
    }),
};
```

- [ ] **Step 2: Register in `apps/server/src/orpc/router.ts`**

Add the import and entry:

```ts
import { configsRouter } from "./routers/configs.ts";
```

```ts
  configs: configsRouter,
```

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit -p apps/server`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add apps/server
git commit -m "feat(server): configs router — projects, cached lookups, snapshot run, server-side select"
```

---

### Task 7: Server integration test — run + select against the real DB

Exercises the whole persistence path (project → run → snapshot row → status flip → select recompute) with a fake agent fetcher. Uses the dev Postgres via root `.env` (bun auto-loads it); skips cleanly when `DATABASE_URL` is absent.

**Files:**
- Test: `apps/server/test/configurator.test.ts`

**Interfaces:**
- Consumes: `executeRun`, `applySelection` (Task 6), db tables (Task 3), engine types (Task 2).

- [ ] **Step 1: Write the test**

```ts
import { afterAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, configModel, configProject, configRun, pool } from "@hera/db";
import type { ModelDef } from "@hera/config-engine";
import { applySelection, executeRun } from "../src/orpc/routers/configs.ts";
import type { QueryFetcher } from "../src/lookups.ts";

const tenantId = `test-cfg-${crypto.randomUUID()}`;

const model: ModelDef = {
  name: "Test box",
  parameters: [
    {
      key: "size", label: "Size", type: "string", ui: "select",
      domain: { kind: "options", ref: { source: "manual", options: [{ value: "S" }, { value: "L" }] } },
    },
    {
      key: "grade", label: "Grade", type: "string", ui: "select",
      domain: { kind: "options", ref: { source: "query", target: "b1", path: "/Items?$select=ItemCode", valueField: "ItemCode" } },
    },
  ],
  structure: { sections: [{ key: "main", title: "Main", groups: [{ key: "g", title: "G", params: ["size", "grade"] }] }] },
  computed: [],
  constraints: [],
  bom: [{ id: "body", itemCode: '"BODY"', qty: 'size == "S" ? 1 : 2', price: "3", scrapPct: 0 }],
  routing: [{ id: "cut", resource: "SAW", setupMin: "10", runMinPerUnit: "1", ratePerHour: "60" }],
  queryTables: [],
  pricing: { priceExpr: "unitCost * 2", quoteItemCode: "BOX" },
  batchDefaults: [10],
};

const fakeFetch: QueryFetcher = async (target, path) => {
  expect(target).toBe("b1");
  expect(path).toBe("/Items?$select=ItemCode");
  return { value: [{ ItemCode: "A" }, { ItemCode: "B" }] };
};

describe.skipIf(!process.env.DATABASE_URL)("configurator run + select (integration)", () => {
  afterAll(async () => {
    await db.delete(configRun).where(eq(configRun.tenantId, tenantId));
    await db.delete(configProject).where(eq(configProject.tenantId, tenantId));
    await db.delete(configModel).where(eq(configModel.tenantId, tenantId));
    await pool.end();
  });

  test("run snapshots model+lookups+candidates and flips status; select recomputes overrides", async () => {
    const [m] = await db
      .insert(configModel)
      .values({ tenantId, name: model.name, definition: model })
      .returning({ id: configModel.id });
    const [p] = await db
      .insert(configProject)
      .values({ tenantId, modelId: m!.id, name: "proj", batches: [10], entries: {}, createdBy: "tester" })
      .returning({ id: configProject.id });

    const res = await executeRun(tenantId, p!.id, fakeFetch);
    // 2 sizes × 2 grades, nothing constrained away
    expect(res.candidateCount).toBe(4);
    expect(res.capped).toBe(false);

    const [run] = await db
      .select()
      .from(configRun)
      .where(and(eq(configRun.id, res.runId), eq(configRun.tenantId, tenantId)))
      .limit(1);
    expect(run).toBeDefined();
    expect(run!.modelSnapshot.name).toBe("Test box");
    expect(run!.lookupSnapshot.domains.grade).toEqual([
      { value: "A", label: "A" },
      { value: "B", label: "B" },
    ]);
    expect(run!.candidates).toHaveLength(4);

    // Hand-check one candidate (size S, batch 10): material 1×3=3;
    // labor ((10/10+1)/60)×60=2; unitCost 5; priceExpr ×2 → unitPrice 10; batchTotal 100.
    const idx = run!.candidates.findIndex((c) => c.assignment.size === "S");
    const outputs = run!.candidates[idx]!.perBatch[0]!.outputs;
    expect(run!.candidates[idx]!.perBatch[0]!.batchQty).toBe(10);
    expect(outputs.unitCost).toBeCloseTo(5);
    expect(outputs.unitPrice).toBeCloseTo(10);
    expect(outputs.batchTotal).toBeCloseTo(100);

    const [proj] = await db.select().from(configProject).where(eq(configProject.id, p!.id)).limit(1);
    expect(proj!.status).toBe("calculated");

    // select: price override 3 → 4 on the same candidate: unitCost 6, unitPrice 12.
    const selections = applySelection(run!, [
      { candidateIdx: idx, batchQty: 10, overrides: { bom: [{ id: "body", unitPrice: 4 }] } },
    ]);
    expect(selections[0]!.outputs.unitCost).toBeCloseTo(6);
    expect(selections[0]!.outputs.unitPrice).toBeCloseTo(12);

    // out-of-range candidate index is rejected
    expect(() => applySelection(run!, [{ candidateIdx: 99, batchQty: 10 }])).toThrow();
  });
});
```

- [ ] **Step 2: Run it**

Run: `bun test apps/server/test/configurator.test.ts`
Expected: PASS (1 test; or skipped if the machine has no `DATABASE_URL` — with dev `.env` present it must run, not skip).

- [ ] **Step 3: Run the whole server suite**

Run: `bun test apps/server`
Expected: PASS (lookups + configurator files).

- [ ] **Step 4: Commit**

```bash
git add apps/server/test
git commit -m "test(server): configurator run/select integration against dev Postgres"
```

---

### Task 8: Agent — Beas query target

The `"query"` request kind already exists end-to-end for B1 (`processRequest` → `queryRaw`). This adds the `target` switch and a thin Beas GET client. Credentials via agent `.env` (`BEAS_BASE_URL`, `BEAS_USER`, `BEAS_PASS`, `BEAS_INSECURE_TLS`) — same rule as B1: never in the cloud DB.

**Files:**
- Create: `apps/agent/src/beas-client.ts`
- Modify: `apps/agent/src/sync.ts` (`BeasPort`, `processRequest` 4th param, `query` case)
- Modify: `apps/agent/src/index.ts` (construct + pass through)
- Test: `apps/agent/test/sync.test.ts`

**Interfaces:**
- Consumes: existing `processRequest(req, sl, cloud)`, `SlReadPort`, `RequestCloudPort` from `apps/agent/src/sync.ts`.
- Produces: `export interface BeasPort { get(path: string): Promise<unknown> }`; `processRequest(req: RequestRow, sl: SlReadPort, cloud: RequestCloudPort, beas?: BeasPort)`; payload contract `{ target?: "b1" | "beas", path: string }` (missing target = b1). Server side (Tasks 5–6) already sends `{ target, path }`.

- [ ] **Step 1: Write the failing tests — `apps/agent/test/sync.test.ts`**

```ts
import { expect, test } from "bun:test";
import { processRequest, type RequestCloudPort, type SlReadPort } from "../src/sync.ts";

function fakes() {
  const fulfilled: unknown[] = [];
  const failed: { id: string; error: string }[] = [];
  const slPaths: string[] = [];
  const beasPaths: string[] = [];
  const sl = { queryRaw: async (p: string) => (slPaths.push(p), { value: ["b1"] }) } as unknown as SlReadPort;
  const cloud: RequestCloudPort = {
    fulfill: async (i) => void fulfilled.push(i),
    fail: async (i) => void failed.push(i),
  };
  const beas = { get: async (p: string) => (beasPaths.push(p), { value: ["beas"] }) };
  return { fulfilled, failed, slPaths, beasPaths, sl, cloud, beas };
}

test("query with target b1 (and with no target) goes to the Service Layer", async () => {
  const f = fakes();
  await processRequest({ id: "1", kind: "query", payload: { target: "b1", path: "/Items" } }, f.sl, f.cloud, f.beas);
  await processRequest({ id: "2", kind: "query", payload: { path: "/Orders" } }, f.sl, f.cloud, f.beas);
  expect(f.slPaths).toEqual(["/Items", "/Orders"]);
  expect(f.beasPaths).toEqual([]);
  expect(f.fulfilled).toHaveLength(2);
});

test("query with target beas goes to the Beas client", async () => {
  const f = fakes();
  await processRequest({ id: "3", kind: "query", payload: { target: "beas", path: "/api/x" } }, f.sl, f.cloud, f.beas);
  expect(f.beasPaths).toEqual(["/api/x"]);
  expect(f.slPaths).toEqual([]);
  expect(f.fulfilled).toHaveLength(1);
});

test("beas target without a configured client fails with the env hint", async () => {
  const f = fakes();
  await processRequest({ id: "4", kind: "query", payload: { target: "beas", path: "/api/x" } }, f.sl, f.cloud);
  expect(f.failed).toHaveLength(1);
  expect(f.failed[0]!.error).toContain("BEAS_BASE_URL");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/agent`
Expected: FAIL — `processRequest` rejects the 4th argument / beas routing missing (the third test fails because today the beas target would be sent to `queryRaw`).

- [ ] **Step 3: Implement `apps/agent/src/beas-client.ts`**

```ts
// Thin Beas web-API GET client. Same trust rule as B1: credentials live in the agent's
// local .env (BEAS_BASE_URL, BEAS_USER, BEAS_PASS, BEAS_INSECURE_TLS), never the cloud DB.
// ponytail: GET-only + basic auth; grow it if Beas writes ever land.
export class BeasClient {
  constructor(
    private cfg: { baseUrl: string; user?: string; pass?: string; insecureTls?: boolean; timeoutMs?: number },
  ) {}

  async get(path: string): Promise<unknown> {
    if (!path.startsWith("/")) throw new Error("beas path must start with /");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.cfg.user) headers.Authorization = "Basic " + btoa(`${this.cfg.user}:${this.cfg.pass ?? ""}`);
    const init: RequestInit & { tls?: { rejectUnauthorized: boolean } } = {
      headers,
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000),
    };
    if (this.cfg.insecureTls) init.tls = { rejectUnauthorized: false }; // Bun fetch extension, same as ServiceLayerClient
    const res = await fetch(this.cfg.baseUrl.replace(/\/$/, "") + path, init);
    if (!res.ok) throw new Error(`Beas GET ${path} failed: ${res.status} ${await res.text().catch(() => "")}`);
    return res.json();
  }
}
```

- [ ] **Step 4: Route the target in `apps/agent/src/sync.ts`**

Add next to `RequestCloudPort`:

```ts
export interface BeasPort {
  get(path: string): Promise<unknown>;
}
```

Change the `processRequest` signature and its `query` case:

```ts
export async function processRequest(
  req: RequestRow,
  sl: SlReadPort,
  cloud: RequestCloudPort,
  beas?: BeasPort,
): Promise<void> {
```

```ts
      case "query":
        if (p.target === "beas") {
          if (!beas) throw new Error("Beas is not configured on this agent (set BEAS_BASE_URL in .env)");
          result = await beas.get(String(p.path));
        } else {
          result = await sl.queryRaw(String(p.path));
        }
        break;
```

- [ ] **Step 5: Wire it in `apps/agent/src/index.ts`**

After the `ServiceLayerClient` construction:

```ts
import { BeasClient } from "./beas-client.ts";
```

```ts
// Optional second on-prem source; only tenants whose models use target:"beas" need it.
const beas = process.env.BEAS_BASE_URL
  ? new BeasClient({
      baseUrl: process.env.BEAS_BASE_URL,
      user: process.env.BEAS_USER,
      pass: process.env.BEAS_PASS,
      insecureTls: process.env.BEAS_INSECURE_TLS === "true",
    })
  : undefined;
```

And in the pull loop, pass it through:

```ts
          else await processRequest(row as RequestRow, sl, cloud, beas);
```

- [ ] **Step 6: Run tests + typecheck**

Run: `bun test apps/agent && bunx tsc --noEmit -p apps/agent`
Expected: PASS (3 tests), tsc exits 0.

- [ ] **Step 7: Commit**

```bash
git add apps/agent
git commit -m "feat(agent): beas query target with local-only credentials"
```

---

### Task 9: Final verification sweep

- [ ] **Step 1: Full install + test + typecheck**

Run:
```bash
bun install
bun test packages/config-engine apps/server apps/agent
bunx tsc --noEmit -p apps/server && bunx tsc --noEmit -p apps/agent && bunx tsc --noEmit -p apps/web && bunx tsc --noEmit -p packages/db
```
Expected: install clean; all suites PASS; all four typechecks exit 0.

- [ ] **Step 2: Migrations idempotent**

Run: `bun run db:migrate`
Expected: exits 0, nothing to apply.

- [ ] **Step 3: Remnant check (spec's cleanup mandate)**

Run: `grep -rn "mdResolveKey\|config_masterdata" apps/ packages/db/src/ --include="*.ts*" | grep -v node_modules`
Expected: no output. (The string still appears in `packages/db/drizzle/` history files — that's correct; migrations are append-only.)

- [ ] **Step 4: Boot smoke**

Run: `bun run dev:server` (background, kill after check)
Expected: server starts without module/registration errors. Kill it.

- [ ] **Step 5: Commit any stragglers**

```bash
git status --short
```
Expected: clean; if not, review and commit with an appropriate message.

---

## Self-review notes (spec phase 2 coverage)

- Schema: 4 tables per spec §Data model, adapted to the engine as built ✓
- `models.ts`: list/get/save (checkModel gate, span issues in `data.issues`)/remove, tables CRUD, lookupPreview ✓
- `configs.ts`: project CRUD, `lookups` (5-min cache), `run` (fresh lookups, enumerate+computeOutputs per candidate × batch, snapshot insert, status flip, cap/widest surfaced), `select` (store + server-side recompute) ✓ — `createQuote` deferred to phase 5 per the spec's phase list.
- Agent `query.fetch`: implemented as the existing `"query"` kind + `target` payload field + `BeasClient` ✓
- Cleanup: orphan `config_masterdata` dropped via forward migration, `mdResolveKey` deleted, `@hera/config-engine` link verified by install/typecheck ✓
- Error handling: agent offline → `assertAgentReady` shape; lookup failure names source + path; cap → `{ capped, widest }` for the UI message ✓
