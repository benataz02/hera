# Sales Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder home page with a single-scroll sales dashboard combining SAP B1 order/quotation figures with HERA configuration data.

**Architecture:** App-side metrics are live SQL over `config_project` / `config_run` / `agent_request`. B1-side metrics come from one `dashboard_snapshot` row per tenant, refreshed hourly by an in-process interval that pulls rows through the existing on-prem agent and aggregates them in JS. No separate analytics service; no `$apply`.

**Tech Stack:** Bun, Hono, oRPC, Drizzle + Postgres, React 19, TanStack Router/Query, UI5 Web Components React 2.24, `@ui5/webcomponents-react-charts` (new).

**Spec:** `docs/superpowers/specs/2026-08-19-sales-dashboard-design.md`

## Global Constraints

- Package manager is **bun**, never npm. Install with `bun add --cwd apps/web <pkg>`.
- This monorepo uses bun isolated installs: anything imported from `src/` must be a **direct** dependency of that workspace's `package.json`.
- Schema changes are applied with `bun run db:push` (drizzle-kit). There are no migration files.
- Tests are `bun:test` (`import { describe, expect, test } from "bun:test"`). Run with `bun test <path>`.
- Server tests that need a tenant use `apps/server/test/harness.ts` (`call`, `makeTenant`, `makeUser`, `tenantHeaders`).
- Pure logic lives in a `.ts` beside the `.tsx` and is tested directly — follow `b1Lines.ts` / `configProcessState.ts`.
- Deliberate simplifications get a `// ponytail:` comment naming the ceiling and the upgrade path.
- Money is stored and aggregated as `number`; Drizzle `numeric` columns come back as `string` and must be `Number(...)`-ed at the boundary.
- Never `ack` without a confirmed result; never re-POST without a GET. Task 3 touches the ack transaction — do not change its fencing.

---

### Task 1: Agent — make `queryRaw` follow OData paging

`queryRaw` currently issues a bare GET with no `Prefer` header and returns the first page only. B1 v2 defaults to 20 rows per page, so every `query`-kind request — including `history-sync` — silently truncates at 20 rows. Fix before anything depends on it.

**Files:**
- Modify: `apps/agent/src/service-layer-client.ts` (add `nextLinkPath` near the other exported helpers, ~line 512; rewrite `queryRaw` at line 889)
- Test: `apps/agent/test/service-layer-fetch.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export function nextLinkPath(link: unknown, baseUrl: string): string | undefined`. `queryRaw(path: string): Promise<unknown>` keeps its signature; a collection response now carries every row in `value`.

- [ ] **Step 1: Write the failing test**

Append to `apps/agent/test/service-layer-fetch.test.ts`:

```ts
describe("nextLinkPath", () => {
  const base = "https://b1.example.com:50000/b1s/v2";

  test("returns undefined when there is no next link", () => {
    expect(nextLinkPath(undefined, base)).toBeUndefined();
    expect(nextLinkPath("", base)).toBeUndefined();
    expect(nextLinkPath(42, base)).toBeUndefined();
  });

  test("prefixes a relative link with a slash", () => {
    expect(nextLinkPath("Orders?$skip=20", base)).toBe("/Orders?$skip=20");
  });

  test("keeps an already-rooted relative link", () => {
    expect(nextLinkPath("/Orders?$skip=20", base)).toBe("/Orders?$skip=20");
  });

  test("strips the service root from an absolute link", () => {
    expect(nextLinkPath(`${base}/Orders?$skip=20&$top=5`, base)).toBe("/Orders?$skip=20&$top=5");
  });

  test("keeps the path when an absolute link does not share the service root", () => {
    expect(nextLinkPath("https://other.example.com/Orders?$skip=20", base)).toBe("/Orders?$skip=20");
  });
});
```

Add `nextLinkPath` to the existing import block at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/agent/test/service-layer-fetch.test.ts`
Expected: FAIL — `nextLinkPath` is not exported from `../src/service-layer-client.ts`.

- [ ] **Step 3: Add the pure helper**

In `apps/agent/src/service-layer-client.ts`, beside the other exported path helpers:

```ts
/** B1 returns @odata.nextLink either relative ("Orders?$skip=20") or absolute. Normalize to a
 *  rawFetch path (rawFetch does baseUrl + path, so the service root must be stripped). */
export function nextLinkPath(link: unknown, baseUrl: string): string | undefined {
  if (typeof link !== "string" || link === "") return undefined;
  if (!/^https?:\/\//i.test(link)) return link.startsWith("/") ? link : `/${link}`;
  const u = new URL(link);
  const root = new URL(baseUrl).pathname.replace(/\/$/, "");
  const path = root && u.pathname.startsWith(root) ? u.pathname.slice(root.length) : u.pathname;
  return `${path}${u.search}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/agent/test/service-layer-fetch.test.ts`
Expected: PASS — all five `nextLinkPath` cases, plus the pre-existing path-builder tests still green.

- [ ] **Step 5: Rewrite `queryRaw` to page**

Replace the body of `queryRaw` (line ~889):

```ts
  /** Generic read-only OData GET for the configurator "Query" data source and the dashboard
   *  snapshot. The path is server- or admin-authored and GET-only. Collection responses are
   *  paged to exhaustion; anything else (aggregates, single entities) passes straight through.
   *  ponytail: 20k-row ceiling with a console warning — raise it, or push the aggregation into
   *  B1 with $apply, only if a real tenant hits it. */
  async queryRaw(path: string): Promise<unknown> {
    if (!path.startsWith("/")) throw new SlError(400, "BAD_PATH", "query path must start with /");
    const MAX_ROWS = 20_000;
    let next: string | undefined = path;
    let envelope: Record<string, unknown> | undefined;
    const rows: unknown[] = [];

    while (next) {
      const res = await this.request("GET", next, undefined, { Prefer: "odata.maxpagesize=1000" });
      if (!res.ok) throw await this.toError(res);
      const json = (await res.json()) as Record<string, unknown>;
      if (!Array.isArray(json.value)) return json;
      envelope ??= json;
      rows.push(...json.value);
      if (rows.length >= MAX_ROWS) {
        console.warn(`[sl] queryRaw hit the ${MAX_ROWS}-row cap for ${path}; result is truncated`);
        break;
      }
      next = nextLinkPath(json["@odata.nextLink"], this.cfg.baseUrl);
    }

    return { ...envelope, value: rows, "@odata.nextLink": undefined };
  }
```

- [ ] **Step 6: Run the agent suite**

Run: `bun test apps/agent`
Expected: PASS. Nothing else stubs `queryRaw`, so no other test should move.

- [ ] **Step 7: Commit**

```bash
git add apps/agent/src/service-layer-client.ts apps/agent/test/service-layer-fetch.test.ts
git commit -m "fix: page queryRaw results instead of returning only the first 20 rows"
```

- [ ] **Step 8: Note the side effect for the reviewer**

`history-sync` and model `queryTables` were also capped at 20 rows and will now return full result sets. Say so in the PR description; a model whose history query returns many thousands of rows will start storing all of them in `config_history`.

---

### Task 2: Schema — snapshot table, sales-rep map, quoted margin columns

**Files:**
- Create: `packages/db/src/schema/dashboard.ts`
- Modify: `packages/db/src/schema/index.ts`
- Modify: `packages/db/src/schema/tenant.ts` (add `salesReps` to `tenantIntegration`)
- Modify: `packages/db/src/schema/configurator.ts` (add `quotedValue` / `quotedCost` to `configRun`)

**Interfaces:**
- Consumes: nothing.
- Produces: `dashboardSnapshot` table; types `Bucket`, `OpenQuote`, `B1Snapshot`; `tenantIntegration.salesReps: Record<string, number>`; `configRun.quotedValue` / `configRun.quotedCost` (nullable `numeric`, read back as `string | null`).

- [ ] **Step 1: Create the snapshot schema file**

`packages/db/src/schema/dashboard.ts`:

```ts
import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** One month × sales-employee cell of the B1 snapshot. */
export type Bucket = {
  orders: { count: number; value: number; grossProfit: number | null };
  quotes: { count: number; closed: number; value: number };
};

export type OpenQuote = {
  docEntry: number;
  docNum: number;
  cardCode: string;
  cardName: string;
  docDate: string; // ISO date, B1 DocDate
  docTotal: number;
  salesPersonCode: number;
};

/** Everything the dashboard needs from B1, aggregated. months: "YYYY-MM" -> SalesPersonCode
 *  (or "" when the document has none) -> Bucket. Bucketing by month AND rep is what lets one
 *  hourly fetch serve every time window and both the "mine" and "tenant" scopes. */
export type B1Snapshot = {
  currency: string;
  months: Record<string, Record<string, Bucket>>;
  openQuotes: OpenQuote[];
  openQuotesTruncated: boolean;
  grossProfitAvailable: boolean;
};

// One row per tenant, replaced wholesale — same posture as config_history.
// ponytail: jsonb blob, not modelled tables; real tables only if the dashboard needs drill-down.
export const dashboardSnapshot = pgTable("dashboard_snapshot", {
  tenantId: text("tenant_id").primaryKey(),
  payload: jsonb("payload").$type<B1Snapshot>().notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  lastError: text("last_error"),
});
```

- [ ] **Step 2: Export it**

In `packages/db/src/schema/index.ts`, append:

```ts
export * from "./dashboard.ts";
```

- [ ] **Step 3: Add `salesReps` to `tenantIntegration`**

In `packages/db/src/schema/tenant.ts`, inside the `tenantIntegration` table definition, after `writeCapabilitiesCheckedAt`:

```ts
  // Maps a HERA user id to a B1 SalesEmployeeCode so the dashboard can scope to "my numbers".
  // ponytail: jsonb map like enabledEntities — tens of entries, read once per request.
  //           A real table only if this ever needs to be queried BY rep code.
  salesReps: jsonb("sales_reps").$type<Record<string, number>>().notNull().default({}),
```

- [ ] **Step 4: Add the quoted margin columns**

In `packages/db/src/schema/configurator.ts`, add `numeric` to the `drizzle-orm/pg-core` import, then inside `configRun` after `quotedAt`:

```ts
    // Engineered value/cost of the selected candidates, captured once when the quotation is
    // confirmed. Stored rather than recomputed: recomputing needs modelSnapshot + lookupSnapshot
    // per run, which is megabytes of jsonb for a 12-month dashboard window.
    // ponytail: no backfill — runs quoted before this shipped stay null and are excluded from
    //           the margin roll-up rather than counted as zero margin.
    quotedValue: numeric("quoted_value", { precision: 18, scale: 4 }),
    quotedCost: numeric("quoted_cost", { precision: 18, scale: 4 }),
```

- [ ] **Step 5: Push the schema**

Run: `bun run db:push`
Expected: drizzle-kit reports the new `dashboard_snapshot` table and three added columns, and applies them. Accept the prompts.

- [ ] **Step 6: Verify the types compile**

Run: `bun test apps/server`
Expected: PASS — the existing suite still compiles against the widened schema.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema/dashboard.ts packages/db/src/schema/index.ts \
        packages/db/src/schema/tenant.ts packages/db/src/schema/configurator.ts
git commit -m "feat: schema for dashboard snapshot, sales-rep map, and quoted margin"
```

---

### Task 3: Capture quoted value and cost at quote time

`completeWriteOrigin` already updates `config_run` with `b1DocEntry` and `quotedAt` inside the attempt-fenced ack transaction. Add the margin numbers to that same update, computed the same way `buildQuoteSeed` computes prices — so the stored margin always matches the quotation actually sent.

**Files:**
- Modify: `apps/server/src/config-quote.ts` (add `quotedTotals`; extend the `configRun` update in `completeWriteOrigin`)
- Test: `apps/server/test/config-quote.test.ts` (exists — append a `describe`)

**Interfaces:**
- Consumes: `configRun.quotedValue` / `quotedCost` from Task 2.
- Produces: `export function quotedTotals(run: ConfigRunRow): { value: number; cost: number }`.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/test/config-quote.test.ts`, adding these imports at the top of the file if
they are not already there:

```ts
import { quotedTotals, type ConfigRunRow } from "../src/config-quote.ts";
import { computeOutputs } from "@hera/config-engine";
import { TEST_MODEL } from "./harness.ts";
```

```ts
/** A configRun row with only the fields quotedTotals reads. lookupSnapshot is empty because
 *  TEST_MODEL's price expression does not reference lookup tables. */
function makeRun(over: Partial<ConfigRunRow>): ConfigRunRow {
  return {
    id: "r1", tenantId: "t1", projectId: "p1",
    modelSnapshot: TEST_MODEL,
    lookupSnapshot: { domains: {}, tables: {} },
    entries: {},
    candidates: [{ assignment: { coated: false }, perBatch: [{ batchQty: 10, outputs: {} as never }] }],
    selection: [{ candidateIdx: 0, batchQty: 10 }],
    selectionVersion: 0, b1DocEntry: null, quotedAt: null,
    quotedValue: null, quotedCost: null,
    createdAt: new Date(),
    ...over,
  } as ConfigRunRow;
}

describe("quotedTotals", () => {
  test("sums value and cost across every selected candidate and batch", () => {
    const run = makeRun({
      candidates: [
        { assignment: { coated: false }, perBatch: [{ batchQty: 10, outputs: {} as never }] },
        { assignment: { coated: true }, perBatch: [{ batchQty: 5, outputs: {} as never }] },
      ],
      selection: [
        { candidateIdx: 0, batchQty: 10 },
        { candidateIdx: 1, batchQty: 5 },
      ],
    });
    const { value, cost } = quotedTotals(run);
    // computeOutputs is re-run per selection; totals are unitPrice*qty and unitCost*qty summed.
    expect(value).toBeGreaterThan(cost);
    expect(value).toBeCloseTo(
      computeOutputs(run.modelSnapshot, run.lookupSnapshot, { coated: false }, 10).unitPrice * 10 +
        computeOutputs(run.modelSnapshot, run.lookupSnapshot, { coated: true }, 5).unitPrice * 5,
      6,
    );
  });

  test("returns zeros when nothing is selected", () => {
    expect(quotedTotals(makeRun({ selection: [] }))).toEqual({ value: 0, cost: 0 });
    expect(quotedTotals(makeRun({ selection: null }))).toEqual({ value: 0, cost: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/server/test/config-quote.test.ts`
Expected: FAIL — `quotedTotals` is not exported from `../src/config-quote.ts`.

- [ ] **Step 3: Implement `quotedTotals`**

In `apps/server/src/config-quote.ts`, after `buildQuoteSeed`:

```ts
/** Engineered value and cost of the selected candidates, using the same computation
 *  buildQuoteSeed prices from — so the stored margin matches the quotation that was sent. */
export function quotedTotals(run: ConfigRunRow): { value: number; cost: number } {
  let value = 0;
  let cost = 0;
  for (const s of run.selection ?? []) {
    const cand = run.candidates[s.candidateIdx];
    if (!cand) continue;
    const out = computeOutputs(run.modelSnapshot, run.lookupSnapshot, cand.assignment, s.batchQty, s.overrides);
    value += out.unitPrice * s.batchQty;
    cost += out.unitCost * s.batchQty;
  }
  return { value, cost };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/server/test/config-quote.test.ts`
Expected: PASS.

- [ ] **Step 5: Store the totals in the ack transaction**

In `completeWriteOrigin`, replace the `configRun` update:

```ts
  const totals = quotedTotals(run);
  await tx
    .update(configRun)
    .set({
      b1DocEntry: docEntry,
      quotedAt: new Date(),
      quotedValue: String(totals.value),
      quotedCost: String(totals.cost),
    })
    .where(and(eq(configRun.id, run.id), eq(configRun.tenantId, tenantId)));
```

Do not touch the `mismatch` check, the `run.b1DocEntry != null` idempotency guard, or the attempt fencing above it.

`computeOutputs` throws `DslError` on a malformed snapshot. Wrap the `quotedTotals` call so a bad model can never fail an otherwise-confirmed ack:

```ts
  let totals = { value: 0, cost: 0 };
  try {
    totals = quotedTotals(run);
  } catch {
    // ponytail: margin is reporting-only — never fail a confirmed SAP write over it.
    //           Nulls here just exclude the run from the margin roll-up.
  }
```

and write `totals.value ? String(totals.value) : null` (same for cost) so a failed computation stores null rather than a misleading zero.

- [ ] **Step 6: Run the full server suite**

Run: `bun test apps/server`
Expected: PASS — in particular `transitions.test.ts` and `entity-writes.test.ts`, which exercise the ack path.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/config-quote.ts apps/server/test/config-quote.test.ts
git commit -m "feat: capture engineered quote value and cost on config_run at ack"
```

---

### Task 4: Pure aggregation module

The whole dashboard computation: rows in, overview shape out. No database, no transport, no dates from `Date.now()` passed implicitly — `now` is an argument so the tests are deterministic.

**Files:**
- Create: `apps/server/src/dashboard.ts`
- Test: `apps/server/test/dashboard.test.ts`

**Interfaces:**
- Consumes: `B1Snapshot`, `Bucket`, `OpenQuote` from `@hera/db` (Task 2).
- Produces:

```ts
export type Window = "month" | "quarter" | "year12";
export type Scope = "mine" | "tenant";

export type ProjectRow = {
  id: string; name: string; status: ProjectStatus; source: ProjectSource;
  createdBy: string; createdAt: Date; customerName: string | null;
  quotedAt: Date | null; b1DocEntry: number | null;
  quotedValue: number | null; quotedCost: number | null;
};

export type ExceptionRow = {
  id: string; kind: string; lastError: string | null; updatedAt: Date;
};

export type Overview = {
  window: Window; scope: Scope; currency: string;
  computedAt: string | null; snapshotError: string | null;
  orderValue: { total: number; hera: number; prevTotal: number };
  conversion: { rate: number; prevRate: number; quotes: number; converted: number };
  turnaround: { medianDays: number | null; sampled: number };
  margin: { pct: number | null; value: number; cost: number; covered: number; of: number };
  funnel: Array<{ stage: string; count: number }>;
  pipeline: Array<{ bucket: string; value: number; count: number; docEntries: number[] }>;
  pipelineTruncated: boolean;
  attention: Array<{ id: string; name: string; customer: string | null; docEntry: number | null; reason: string; ageDays: number }>;
  exceptions: { failed: ExceptionRow[]; agentStale: boolean; agentLastSeen: string | null };
};

export function monthKeys(window: Window, now: Date): string[];
export function medianDays(durationsMs: number[]): number | null;
export function ageBuckets(quotes: OpenQuote[], now: Date, heraDocEntries: Set<number>):
  Overview["pipeline"];
export function buildOverview(input: {
  window: Window; scope: Scope; now: Date;
  snapshot: { payload: B1Snapshot; computedAt: Date; lastError: string | null } | null;
  salesPersonCode: number | null;
  projects: ProjectRow[];
  failed: ExceptionRow[];
  agentLastSeen: Date | null;
}): Overview;
```

- [ ] **Step 1: Write the failing tests**

`apps/server/test/dashboard.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { ageBuckets, buildOverview, medianDays, monthKeys, type ProjectRow } from "../src/dashboard.ts";
import type { B1Snapshot, OpenQuote } from "@hera/db";

const NOW = new Date("2026-08-19T12:00:00Z");
const day = 24 * 60 * 60 * 1000;

describe("monthKeys", () => {
  test("month window is the current month only", () => {
    expect(monthKeys("month", NOW)).toEqual(["2026-08"]);
  });
  test("quarter window is the three months of the calendar quarter to date", () => {
    expect(monthKeys("quarter", NOW)).toEqual(["2026-07", "2026-08"]);
  });
  test("year12 window is twelve months ending with the current one", () => {
    const keys = monthKeys("year12", NOW);
    expect(keys).toHaveLength(12);
    expect(keys[0]).toBe("2025-09");
    expect(keys[11]).toBe("2026-08");
  });
});

describe("medianDays", () => {
  test("odd count takes the middle value", () => {
    expect(medianDays([1 * day, 5 * day, 3 * day])).toBeCloseTo(3, 6);
  });
  test("even count averages the two middle values", () => {
    expect(medianDays([2 * day, 4 * day, 6 * day, 8 * day])).toBeCloseTo(5, 6);
  });
  test("empty sample is null, not zero", () => {
    expect(medianDays([])).toBeNull();
  });
});

describe("ageBuckets", () => {
  const q = (docEntry: number, daysAgo: number, total: number): OpenQuote => ({
    docEntry, docNum: docEntry, cardCode: "C1", cardName: "Acme",
    docDate: new Date(NOW.getTime() - daysAgo * day).toISOString().slice(0, 10),
    docTotal: total, salesPersonCode: 1,
  });

  test("assigns each quote to exactly one bucket at the boundaries", () => {
    const out = ageBuckets([q(1, 0, 10), q(2, 7, 20), q(3, 8, 40), q(4, 14, 80),
                            q(5, 15, 160), q(6, 30, 320), q(7, 31, 640)], NOW, new Set());
    expect(out.map((b) => [b.bucket, b.count, b.value])).toEqual([
      ["0-7d", 2, 30],
      ["8-14d", 2, 120],
      ["15-30d", 2, 480],
      ["30d+", 1, 640],
    ]);
  });

  test("records the HERA-originated doc entries per bucket", () => {
    const out = ageBuckets([q(1, 0, 10), q(2, 40, 20)], NOW, new Set([2]));
    expect(out[0]!.docEntries).toEqual([]);
    expect(out[3]!.docEntries).toEqual([2]);
  });
});

describe("buildOverview", () => {
  const emptySnapshot: B1Snapshot = {
    currency: "EUR", months: {}, openQuotes: [], openQuotesTruncated: false,
    grossProfitAvailable: false,
  };
  const project = (over: Partial<ProjectRow>): ProjectRow => ({
    id: "p1", name: "Pump", status: "draft", source: "internal", createdBy: "u1",
    createdAt: new Date(NOW.getTime() - 3 * day), customerName: "Acme",
    quotedAt: null, b1DocEntry: null, quotedValue: null, quotedCost: null, ...over,
  });
  const base = {
    window: "month" as const, scope: "tenant" as const, now: NOW,
    snapshot: { payload: emptySnapshot, computedAt: NOW, lastError: null },
    salesPersonCode: null, projects: [], failed: [], agentLastSeen: NOW,
  };

  test("funnel counts every stage, ordered draft to ordered", () => {
    const out = buildOverview({
      ...base,
      projects: [
        project({ id: "a", status: "draft" }),
        project({ id: "b", status: "calculated" }),
        project({ id: "c", status: "requested" }),
        project({ id: "d", status: "quoted", quotedAt: NOW, b1DocEntry: 10 }),
        project({ id: "e", status: "quoted", quotedAt: NOW, b1DocEntry: 11 }),
      ],
    });
    // Both quoted runs have a b1DocEntry that is absent from openQuotes, so the
    // "not open ⇒ converted" approximation counts them as ordered.
    expect(out.funnel).toEqual([
      { stage: "Draft", count: 1 },
      { stage: "Calculated", count: 2 },
      { stage: "Quoted", count: 2 },
      { stage: "Ordered", count: 2 },
    ]);
  });

  test("nothing counts as ordered without a snapshot to check against", () => {
    const out = buildOverview({
      ...base, snapshot: null,
      projects: [project({ status: "quoted", quotedAt: NOW, b1DocEntry: 10 })],
    });
    expect(out.funnel[3]).toEqual({ stage: "Ordered", count: 0 });
  });

  test("a quotation still open in B1 is quoted, not ordered", () => {
    const openQuote = {
      docEntry: 10, docNum: 10, cardCode: "C1", cardName: "Acme",
      docDate: "2026-08-01", docTotal: 500, salesPersonCode: 1,
    };
    const out = buildOverview({
      ...base,
      snapshot: { payload: { ...emptySnapshot, openQuotes: [openQuote] }, computedAt: NOW, lastError: null },
      projects: [project({ status: "quoted", quotedAt: NOW, b1DocEntry: 10 })],
    });
    expect(out.funnel[3]).toEqual({ stage: "Ordered", count: 0 });
  });

  test("margin excludes runs with no captured value and reports the coverage", () => {
    const out = buildOverview({
      ...base,
      projects: [
        project({ id: "a", status: "quoted", quotedAt: NOW, quotedValue: 1000, quotedCost: 700 }),
        project({ id: "b", status: "quoted", quotedAt: NOW, quotedValue: null, quotedCost: null }),
      ],
    });
    expect(out.margin.pct).toBeCloseTo(0.3, 6);
    expect(out.margin.covered).toBe(1);
    expect(out.margin.of).toBe(2);
  });

  test("margin is null rather than zero when nothing is covered", () => {
    const out = buildOverview({ ...base, projects: [project({ status: "quoted", quotedAt: NOW })] });
    expect(out.margin.pct).toBeNull();
  });

  test("missing snapshot yields zeroed B1 figures and a null computedAt", () => {
    const out = buildOverview({ ...base, snapshot: null });
    expect(out.orderValue.total).toBe(0);
    expect(out.computedAt).toBeNull();
  });

  test("mine scope with a rep code sums only that rep's buckets", () => {
    const months = {
      "2026-08": {
        "1": { orders: { count: 1, value: 100, grossProfit: null }, quotes: { count: 2, closed: 1, value: 200 } },
        "2": { orders: { count: 1, value: 900, grossProfit: null }, quotes: { count: 1, closed: 0, value: 50 } },
      },
    };
    const snapshot = { payload: { ...emptySnapshot, months }, computedAt: NOW, lastError: null };
    expect(buildOverview({ ...base, snapshot }).orderValue.total).toBe(1000);
    expect(buildOverview({ ...base, snapshot, scope: "mine", salesPersonCode: 1 }).orderValue.total).toBe(100);
  });

  test("conversion divides closed quotes by total quotes in the window", () => {
    const months = {
      "2026-08": {
        "": { orders: { count: 0, value: 0, grossProfit: null }, quotes: { count: 4, closed: 1, value: 400 } },
      },
    };
    const out = buildOverview({ ...base, snapshot: { payload: { ...emptySnapshot, months }, computedAt: NOW, lastError: null } });
    expect(out.conversion.rate).toBeCloseTo(0.25, 6);
  });

  test("a stale agent is flagged without failing the rest of the overview", () => {
    const out = buildOverview({ ...base, agentLastSeen: new Date(NOW.getTime() - 10 * 60_000) });
    expect(out.exceptions.agentStale).toBe(true);
    expect(out.funnel).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/server/test/dashboard.test.ts`
Expected: FAIL — cannot resolve `../src/dashboard.ts`.

- [ ] **Step 3: Implement the module**

`apps/server/src/dashboard.ts`:

```ts
import type { B1Snapshot, Bucket, OpenQuote, ProjectSource, ProjectStatus } from "@hera/db";

export type Window = "month" | "quarter" | "year12";
export type Scope = "mine" | "tenant";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Matches AGENT_STALE_MS in orpc/routers/entities.ts. */
const AGENT_STALE_MS = 90_000;
/** A quoted configuration nobody has moved in this long wants a human. */
const STALE_QUOTE_DAYS = 7;

export type ProjectRow = {
  id: string; name: string; status: ProjectStatus; source: ProjectSource;
  createdBy: string; createdAt: Date; customerName: string | null;
  quotedAt: Date | null; b1DocEntry: number | null;
  quotedValue: number | null; quotedCost: number | null;
};

export type ExceptionRow = { id: string; kind: string; lastError: string | null; updatedAt: Date };

export type Overview = {
  window: Window; scope: Scope; currency: string;
  computedAt: string | null; snapshotError: string | null;
  orderValue: { total: number; hera: number; prevTotal: number };
  conversion: { rate: number; prevRate: number; quotes: number; converted: number };
  turnaround: { medianDays: number | null; sampled: number };
  margin: { pct: number | null; value: number; cost: number; covered: number; of: number };
  funnel: Array<{ stage: string; count: number }>;
  pipeline: Array<{ bucket: string; value: number; count: number; docEntries: number[] }>;
  pipelineTruncated: boolean;
  attention: Array<{ id: string; name: string; customer: string | null; docEntry: number | null; reason: string; ageDays: number }>;
  exceptions: { failed: ExceptionRow[]; agentStale: boolean; agentLastSeen: string | null };
};

const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

/** The "YYYY-MM" keys a window covers, oldest first. */
export function monthKeys(window: Window, now: Date): string[] {
  if (window === "month") return [monthKey(now)];
  const out: string[] = [];
  if (window === "quarter") {
    const firstMonth = Math.floor(now.getUTCMonth() / 3) * 3;
    for (let m = firstMonth; m <= now.getUTCMonth(); m++) {
      out.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), m, 1))));
    }
    return out;
  }
  for (let i = 11; i >= 0; i--) {
    out.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
  }
  return out;
}

/** The month keys immediately preceding a window, same length — for the trend arrow. */
function priorKeys(keys: string[], now: Date, window: Window): string[] {
  const span = keys.length;
  const first = window === "month" ? now.getUTCMonth() : now.getUTCMonth() - span + 1;
  const out: string[] = [];
  for (let i = span; i >= 1; i--) {
    out.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), first - i, 1))));
  }
  return out;
}

export function medianDays(durationsMs: number[]): number | null {
  if (durationsMs.length === 0) return null;
  const s = [...durationsMs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  const ms = s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  return ms / DAY_MS;
}

const EMPTY: Bucket = {
  orders: { count: 0, value: 0, grossProfit: null },
  quotes: { count: 0, closed: 0, value: 0 },
};

/** Sum the cells a (window, scope) selects. rep === null means every rep. */
function sumBuckets(months: B1Snapshot["months"], keys: string[], rep: number | null): Bucket {
  const acc: Bucket = structuredClone(EMPTY);
  for (const k of keys) {
    const byRep = months[k];
    if (!byRep) continue;
    for (const [code, b] of Object.entries(byRep)) {
      if (rep !== null && code !== String(rep)) continue;
      acc.orders.count += b.orders.count;
      acc.orders.value += b.orders.value;
      if (b.orders.grossProfit !== null) {
        acc.orders.grossProfit = (acc.orders.grossProfit ?? 0) + b.orders.grossProfit;
      }
      acc.quotes.count += b.quotes.count;
      acc.quotes.closed += b.quotes.closed;
      acc.quotes.value += b.quotes.value;
    }
  }
  return acc;
}

const BUCKET_EDGES: Array<[label: string, maxDays: number]> = [
  ["0-7d", 7], ["8-14d", 14], ["15-30d", 30], ["30d+", Infinity],
];

export function ageBuckets(
  quotes: OpenQuote[], now: Date, heraDocEntries: Set<number>,
): Overview["pipeline"] {
  const out = BUCKET_EDGES.map(([bucket]) => ({ bucket, value: 0, count: 0, docEntries: [] as number[] }));
  // Compare date-to-date, not instant-to-instant: B1 DocDate has no time, so a quote raised
  // today must read as 0 days old regardless of what time the dashboard is loaded.
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (const q of quotes) {
    const ageDays = (today - Date.parse(`${q.docDate}T00:00:00Z`)) / DAY_MS;
    const i = BUCKET_EDGES.findIndex(([, max]) => ageDays <= max);
    const slot = out[i === -1 ? out.length - 1 : i]!;
    slot.value += q.docTotal;
    slot.count += 1;
    if (heraDocEntries.has(q.docEntry)) slot.docEntries.push(q.docEntry);
  }
  return out;
}

export function buildOverview(input: {
  window: Window; scope: Scope; now: Date;
  snapshot: { payload: B1Snapshot; computedAt: Date; lastError: string | null } | null;
  salesPersonCode: number | null;
  projects: ProjectRow[];
  failed: ExceptionRow[];
  agentLastSeen: Date | null;
}): Overview {
  const { window, scope, now, snapshot, salesPersonCode, projects, failed, agentLastSeen } = input;
  const rep = scope === "mine" ? salesPersonCode : null;
  const payload = snapshot?.payload;
  const keys = monthKeys(window, now);
  const cur = payload ? sumBuckets(payload.months, keys, rep) : structuredClone(EMPTY);
  const prev = payload ? sumBuckets(payload.months, priorKeys(keys, now, window), rep) : structuredClone(EMPTY);

  const heraDocEntries = new Set(
    projects.filter((p) => p.b1DocEntry !== null).map((p) => p.b1DocEntry!),
  );

  const quoted = projects.filter((p) => p.quotedAt !== null);
  const turnaroundMs = quoted.map((p) => p.quotedAt!.getTime() - p.createdAt.getTime());

  const withMargin = quoted.filter((p) => p.quotedValue !== null && p.quotedCost !== null);
  const marginValue = withMargin.reduce((s, p) => s + p.quotedValue!, 0);
  const marginCost = withMargin.reduce((s, p) => s + p.quotedCost!, 0);

  // A HERA quotation absent from openQuotes counts as converted.
  // ponytail: "not open" stands in for "ordered" — exact attribution needs
  //           Orders?$expand=DocumentLines($select=BaseEntry,BaseType). Upgrade on dispute.
  // null, not an empty set: with no snapshot we cannot tell converted from open, and claiming
  // every HERA quotation converted would be the worst possible default.
  const open = payload ? new Set(payload.openQuotes.map((q) => q.docEntry)) : null;
  const isOrdered = (p: ProjectRow) => open !== null && p.b1DocEntry !== null && !open.has(p.b1DocEntry);

  const ordered = projects.filter(isOrdered);
  const stage = (...s: ProjectStatus[]) => projects.filter((p) => s.includes(p.status)).length;

  const attention = projects
    .filter((p) => p.status === "requested" || p.status === "rejected" ||
      (p.status === "quoted" && p.quotedAt !== null &&
        (now.getTime() - p.quotedAt.getTime()) / DAY_MS > STALE_QUOTE_DAYS))
    .map((p) => ({
      id: p.id, name: p.name, customer: p.customerName, docEntry: p.b1DocEntry,
      reason: p.status === "requested" ? "Portal request waiting"
        : p.status === "rejected" ? "Rejected — needs rework"
        : `No movement for ${STALE_QUOTE_DAYS}+ days`,
      ageDays: Math.floor((now.getTime() - (p.quotedAt ?? p.createdAt).getTime()) / DAY_MS),
    }))
    .sort((a, b) => b.ageDays - a.ageDays);

  const heraOrderValue = withMargin.filter(isOrdered).reduce((s, p) => s + p.quotedValue!, 0);

  return {
    window, scope,
    currency: payload?.currency ?? "EUR",
    computedAt: snapshot?.computedAt.toISOString() ?? null,
    snapshotError: snapshot?.lastError ?? null,
    orderValue: { total: cur.orders.value, hera: heraOrderValue, prevTotal: prev.orders.value },
    conversion: {
      rate: cur.quotes.count ? cur.quotes.closed / cur.quotes.count : 0,
      prevRate: prev.quotes.count ? prev.quotes.closed / prev.quotes.count : 0,
      quotes: cur.quotes.count, converted: cur.quotes.closed,
    },
    turnaround: { medianDays: medianDays(turnaroundMs), sampled: turnaroundMs.length },
    margin: {
      pct: marginValue > 0 ? (marginValue - marginCost) / marginValue : null,
      value: marginValue, cost: marginCost, covered: withMargin.length, of: quoted.length,
    },
    funnel: [
      { stage: "Draft", count: stage("draft") },
      { stage: "Calculated", count: stage("calculated", "requested", "rejected") },
      { stage: "Quoted", count: stage("quoted") },
      { stage: "Ordered", count: ordered.length },
    ],
    pipeline: ageBuckets(payload?.openQuotes ?? [], now, heraDocEntries),
    pipelineTruncated: payload?.openQuotesTruncated ?? false,
    attention,
    exceptions: {
      failed,
      agentStale: !agentLastSeen || now.getTime() - agentLastSeen.getTime() > AGENT_STALE_MS,
      agentLastSeen: agentLastSeen?.toISOString() ?? null,
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/server/test/dashboard.test.ts`
Expected: PASS — all 13 cases.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/dashboard.ts apps/server/test/dashboard.test.ts
git commit -m "feat: pure dashboard aggregation over snapshot and configuration rows"
```

---

### Task 5: B1 snapshot job

**Files:**
- Create: `apps/server/src/dashboard-snapshot.ts`
- Modify: `apps/server/src/index.ts` (start the interval)
- Test: `apps/server/test/dashboard-snapshot.test.ts`

**Interfaces:**
- Consumes: `dashboardSnapshot`, `B1Snapshot`, `Bucket`, `OpenQuote` (Task 2); `runRequest` / `assertAgentReady` from `orpc/routers/entities.ts`.
- Produces:
```ts
export function snapshotPaths(now: Date): { orders: string; quotes: string; open: string; probe: string };
export function foldRows(input: {
  orders: Record<string, unknown>[]; quotes: Record<string, unknown>[];
  open: Record<string, unknown>[]; grossProfitAvailable: boolean;
}): B1Snapshot;
export async function refreshB1Snapshot(tenantId: string, fetchQuery: (path: string) => Promise<unknown>, now?: Date): Promise<void>;
export function startDashboardSnapshot(): void;
```

- [ ] **Step 1: Write the failing test**

`apps/server/test/dashboard-snapshot.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { foldRows, snapshotPaths } from "../src/dashboard-snapshot.ts";

const NOW = new Date("2026-08-19T12:00:00Z");

describe("snapshotPaths", () => {
  test("windows orders and quotations over a rolling 13 months", () => {
    const p = snapshotPaths(NOW);
    expect(p.orders).toContain("/Orders?");
    expect(p.orders).toContain("DocDate ge '2025-08-01'");
    expect(p.quotes).toContain("/Quotations?");
    expect(p.quotes).toContain("DocDate ge '2025-08-01'");
  });

  test("open quotations are filtered on status and cancellation, not on date", () => {
    const p = snapshotPaths(NOW);
    expect(p.open).toContain("DocumentStatus eq 'bost_Open'");
    expect(p.open).toContain("Cancelled eq 'tNO'");
    expect(p.open).not.toContain("DocDate ge");
  });

  test("the gross-profit probe asks for a single row", () => {
    expect(snapshotPaths(NOW).probe).toBe("/Orders?$select=DocEntry,GrossProfit&$top=1");
  });
});

describe("foldRows", () => {
  const order = (o: Record<string, unknown>) => ({
    DocDate: "2026-08-03", DocTotal: 100, SalesPersonCode: 1, GrossProfit: 30, ...o,
  });
  const quote = (o: Record<string, unknown>) => ({
    DocDate: "2026-08-03", DocTotal: 50, SalesPersonCode: 1,
    DocumentStatus: "bost_Open", Cancelled: "tNO", ...o,
  });

  test("buckets by month and sales employee", () => {
    const s = foldRows({
      orders: [order({}), order({ SalesPersonCode: 2, DocTotal: 900 }), order({ DocDate: "2026-07-01" })],
      quotes: [], open: [], grossProfitAvailable: true,
    });
    expect(s.months["2026-08"]!["1"]!.orders).toEqual({ count: 1, value: 100, grossProfit: 30 });
    expect(s.months["2026-08"]!["2"]!.orders.value).toBe(900);
    expect(s.months["2026-07"]!["1"]!.orders.count).toBe(1);
  });

  test("a document with no sales employee lands in the empty-string bucket", () => {
    const s = foldRows({ orders: [order({ SalesPersonCode: -1 })], quotes: [], open: [], grossProfitAvailable: true });
    expect(s.months["2026-08"]![""]!.orders.count).toBe(1);
  });

  test("closed and not cancelled counts as converted", () => {
    const s = foldRows({
      orders: [],
      quotes: [
        quote({ DocumentStatus: "bost_Close" }),
        quote({ DocumentStatus: "bost_Close", Cancelled: "tYES" }),
        quote({}),
      ],
      open: [], grossProfitAvailable: false,
    });
    expect(s.months["2026-08"]!["1"]!.quotes).toEqual({ count: 3, closed: 1, value: 150 });
  });

  test("gross profit is null throughout when the probe failed", () => {
    const s = foldRows({ orders: [order({})], quotes: [], open: [], grossProfitAvailable: false });
    expect(s.months["2026-08"]!["1"]!.orders.grossProfit).toBeNull();
    expect(s.grossProfitAvailable).toBe(false);
  });

  test("open quotes are capped and the truncation is reported", () => {
    const many = Array.from({ length: 1200 }, (_, i) => quote({ DocEntry: i, DocNum: i }));
    const s = foldRows({ orders: [], quotes: [], open: many, grossProfitAvailable: false });
    expect(s.openQuotes).toHaveLength(1000);
    expect(s.openQuotesTruncated).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/server/test/dashboard-snapshot.test.ts`
Expected: FAIL — cannot resolve `../src/dashboard-snapshot.ts`.

- [ ] **Step 3: Implement the module**

`apps/server/src/dashboard-snapshot.ts`:

```ts
import { eq, sql } from "drizzle-orm";
import { db, dashboardSnapshot, tenantIntegration, type B1Snapshot, type Bucket, type OpenQuote } from "@hera/db";
import { assertAgentReady, runRequest } from "./orpc/routers/entities.ts";

const OPEN_QUOTE_CAP = 1000;
const SYNC_INTERVAL_MS = 60 * 60_000;

/** Rolling 13 months: twelve so "last 12 months" is whole on the 1st, plus one prior month so
 *  the trend arrows always have something to compare against. */
export function snapshotPaths(now: Date): { orders: string; quotes: string; open: string; probe: string } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 12, 1))
    .toISOString().slice(0, 10);
  const docFields = "DocEntry,DocNum,DocDate,DocTotal,CardCode,CardName,SalesPersonCode";
  return {
    orders: `/Orders?$select=${docFields},GrossProfit&$filter=DocDate ge '${from}'&$orderby=DocEntry`,
    quotes: `/Quotations?$select=${docFields},DocumentStatus,Cancelled&$filter=DocDate ge '${from}'&$orderby=DocEntry`,
    open: `/Quotations?$select=${docFields}&$filter=DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO'&$orderby=DocEntry desc`,
    probe: "/Orders?$select=DocEntry,GrossProfit&$top=1",
  };
}

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0)) || 0;
const str = (v: unknown): string => (v == null ? "" : String(v));
const monthOf = (docDate: unknown): string => str(docDate).slice(0, 7);
/** B1 uses -1 for "no sales employee"; bucket those under "". */
const repOf = (code: unknown): string => (num(code) > 0 ? String(num(code)) : "");

const emptyBucket = (): Bucket => ({
  orders: { count: 0, value: 0, grossProfit: null },
  quotes: { count: 0, closed: 0, value: 0 },
});

export function foldRows(input: {
  orders: Record<string, unknown>[]; quotes: Record<string, unknown>[];
  open: Record<string, unknown>[]; grossProfitAvailable: boolean;
}): B1Snapshot {
  const months: B1Snapshot["months"] = {};
  const cell = (row: Record<string, unknown>): Bucket => {
    const m = (months[monthOf(row.DocDate)] ??= {});
    return (m[repOf(row.SalesPersonCode)] ??= emptyBucket());
  };

  for (const o of input.orders) {
    const b = cell(o);
    b.orders.count += 1;
    b.orders.value += num(o.DocTotal);
    if (input.grossProfitAvailable) b.orders.grossProfit = (b.orders.grossProfit ?? 0) + num(o.GrossProfit);
  }
  for (const q of input.quotes) {
    const b = cell(q);
    b.quotes.count += 1;
    b.quotes.value += num(q.DocTotal);
    // ponytail: closed-and-not-cancelled stands in for converted. Exact attribution needs
    //           Orders?$expand=DocumentLines($select=BaseEntry,BaseType). Upgrade on dispute.
    if (str(q.DocumentStatus) === "bost_Close" && str(q.Cancelled) !== "tYES") b.quotes.closed += 1;
  }

  const openQuotes: OpenQuote[] = input.open.slice(0, OPEN_QUOTE_CAP).map((q) => ({
    docEntry: num(q.DocEntry), docNum: num(q.DocNum),
    cardCode: str(q.CardCode), cardName: str(q.CardName),
    docDate: str(q.DocDate).slice(0, 10), docTotal: num(q.DocTotal),
    salesPersonCode: num(q.SalesPersonCode),
  }));

  return {
    currency: "EUR", // ponytail: tenant default; per-document DocCurrency when a tenant is multi-currency.
    months,
    openQuotes,
    openQuotesTruncated: input.open.length > OPEN_QUOTE_CAP,
    grossProfitAvailable: input.grossProfitAvailable,
  };
}

const rowsOf = (json: unknown): Record<string, unknown>[] => {
  const v = Array.isArray(json) ? json : (json as { value?: unknown } | null)?.value;
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
};

export async function refreshB1Snapshot(
  tenantId: string,
  fetchQuery: (path: string) => Promise<unknown>,
  now: Date = new Date(),
): Promise<void> {
  const paths = snapshotPaths(now);

  // Probe once per run rather than assuming Orders exposes GrossProfit on this B1 version.
  let grossProfitAvailable = true;
  try {
    await fetchQuery(paths.probe);
  } catch {
    grossProfitAvailable = false;
  }

  const ordersPath = grossProfitAvailable
    ? paths.orders
    : paths.orders.replace(",GrossProfit", "");
  const [orders, quotes, open] = await Promise.all([
    fetchQuery(ordersPath), fetchQuery(paths.quotes), fetchQuery(paths.open),
  ]);

  const payload = foldRows({
    orders: rowsOf(orders), quotes: rowsOf(quotes), open: rowsOf(open), grossProfitAvailable,
  });

  await db
    .insert(dashboardSnapshot)
    .values({ tenantId, payload, computedAt: now, lastError: null })
    .onConflictDoUpdate({
      target: dashboardSnapshot.tenantId,
      set: { payload, computedAt: now, lastError: null },
    });
}

// ponytail: one in-process hourly interval, sequential per tenant — the same posture as
// startHistorySync. Move both to a jobs table if the server ever runs multi-instance.
export function startDashboardSnapshot(): void {
  const tick = async () => {
    try {
      const tenants = await db.select({ tenantId: tenantIntegration.tenantId }).from(tenantIntegration);
      for (const t of tenants) {
        try {
          await assertAgentReady(t.tenantId);
          await refreshB1Snapshot(t.tenantId, (path) => runRequest(t.tenantId, "query", { target: "b1", path }));
          console.log(`[dashboard-snapshot] ${t.tenantId}: ok`);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.error(`[dashboard-snapshot] ${t.tenantId} failed: ${message}`);
          await db
            .insert(dashboardSnapshot)
            .values({ tenantId: t.tenantId, payload: foldRows({ orders: [], quotes: [], open: [], grossProfitAvailable: false }), lastError: message })
            .onConflictDoUpdate({ target: dashboardSnapshot.tenantId, set: { lastError: message } });
        }
      }
    } catch (e) {
      console.error(`[dashboard-snapshot] tick failed: ${e instanceof Error ? e.message : e}`);
    }
  };
  setInterval(() => void tick(), SYNC_INTERVAL_MS);
}
```

Note the failure branch keeps any existing `payload` (the `set` clause touches only `lastError`), so a transient agent outage ages the numbers instead of blanking them.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/server/test/dashboard-snapshot.test.ts`
Expected: PASS — all 8 cases.

- [ ] **Step 5: Start the job**

In `apps/server/src/index.ts`, next to the existing `startHistorySync()`:

```ts
import { startDashboardSnapshot } from "./dashboard-snapshot.ts";
// ...
startHistorySync();
startDashboardSnapshot();
```

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/dashboard-snapshot.ts apps/server/test/dashboard-snapshot.test.ts apps/server/src/index.ts
git commit -m "feat: hourly B1 snapshot job for the dashboard"
```

---

### Task 6: Dashboard router

**Files:**
- Create: `apps/server/src/orpc/routers/dashboard.ts`
- Modify: `apps/server/src/orpc/router.ts`
- Test: `apps/server/test/dashboard-router.test.ts`

**Interfaces:**
- Consumes: `buildOverview`, `Window`, `Scope`, `ProjectRow`, `ExceptionRow` (Task 4); `refreshB1Snapshot` (Task 5); `userProcedure` / `adminProcedure` from `../base.ts`.
- Produces: `dashboardRouter` with `overview`, `refresh`, `salesReps.get`, `salesReps.set`, mounted as `dashboard` on `AppRouter`.

- [ ] **Step 1: Write the failing test**

`apps/server/test/dashboard-router.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { db, tenantIntegration } from "@hera/db";
import { call, makeTenant, makeUser, tenantHeaders } from "./harness.ts";
import { router } from "../src/orpc/router.ts";

const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");

async function tenantWithAgent() {
  const { tenantId, slug } = await makeTenant();
  await db.insert(tenantIntegration).values({ tenantId, agentTokenHash: `h-${tenantId}`, lastSeenAt: new Date() });
  return { tenantId, slug };
}

describe("dashboard.overview", () => {
  test("returns a zeroed overview for a tenant with no data", async () => {
    const { tenantId, slug } = await tenantWithAgent();
    const u = await makeUser("member", tenantId);
    const out = await call(router.dashboard.overview, { window: "month", scope: "tenant" },
      { context: { headers: tenantHeaders(slug, u.cookie) } });
    expect(out.orderValue.total).toBe(0);
    expect(out.funnel).toHaveLength(4);
    expect(out.computedAt).toBeNull();
  });

  test("falls back to tenant scope when the caller has no sales-employee mapping", async () => {
    const { tenantId, slug } = await tenantWithAgent();
    const u = await makeUser("member", tenantId);
    const out = await call(router.dashboard.overview, { window: "month", scope: "mine" },
      { context: { headers: tenantHeaders(slug, u.cookie) } });
    expect(out.scope).toBe("tenant");
  });

  test("honours mine scope once the user is mapped", async () => {
    const { tenantId, slug } = await tenantWithAgent();
    const u = await makeUser("member", tenantId);
    await db.update(tenantIntegration).set({ salesReps: { [u.userId]: 3 } })
      .where(eq(tenantIntegration.tenantId, tenantId));
    const out = await call(router.dashboard.overview, { window: "month", scope: "mine" },
      { context: { headers: tenantHeaders(slug, u.cookie) } });
    expect(out.scope).toBe("mine");
  });
});

describe("dashboard.salesReps", () => {
  test("a member cannot write the mapping", async () => {
    const { tenantId, slug } = await tenantWithAgent();
    const u = await makeUser("member", tenantId);
    expect(await code(call(router.dashboard.salesReps.set, { userId: u.userId, salesPersonCode: 1 },
      { context: { headers: tenantHeaders(slug, u.cookie) } }))).toBe("FORBIDDEN");
  });

  test("an admin sets and clears a mapping", async () => {
    const { tenantId, slug } = await tenantWithAgent();
    const a = await makeUser("admin", tenantId);
    const ctx = { context: { headers: tenantHeaders(slug, a.cookie) } };
    await call(router.dashboard.salesReps.set, { userId: a.userId, salesPersonCode: 7 }, ctx);
    expect((await call(router.dashboard.salesReps.get, {}, ctx)).reps[a.userId]).toBe(7);
    await call(router.dashboard.salesReps.set, { userId: a.userId, salesPersonCode: null }, ctx);
    expect((await call(router.dashboard.salesReps.get, {}, ctx)).reps[a.userId]).toBeUndefined();
  });
});
```

Add `import { eq } from "drizzle-orm";` at the top.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/server/test/dashboard-router.test.ts`
Expected: FAIL — `router.dashboard` is undefined.

- [ ] **Step 3: Implement the router**

`apps/server/src/orpc/routers/dashboard.ts`:

```ts
import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db, agentRequest, configProject, configRun, dashboardSnapshot, tenantIntegration } from "@hera/db";
import { adminProcedure, userProcedure } from "../base.ts";
import { buildOverview, type ExceptionRow, type ProjectRow } from "../../dashboard.ts";
import { refreshB1Snapshot } from "../../dashboard-snapshot.ts";
import { assertAgentReady, runRequest } from "./entities.ts";

const REFRESH_COOLDOWN_MS = 2 * 60_000;
const FAILED_LIMIT = 20;

async function loadProjects(tenantId: string, userId: string | null): Promise<ProjectRow[]> {
  const rows = await db
    .select({
      id: configProject.id, name: configProject.name, status: configProject.status,
      source: configProject.source, createdBy: configProject.createdBy,
      createdAt: configProject.createdAt, customer: configProject.customer,
      quotedAt: configRun.quotedAt, b1DocEntry: configRun.b1DocEntry,
      quotedValue: configRun.quotedValue, quotedCost: configRun.quotedCost,
    })
    .from(configProject)
    .leftJoin(configRun, eq(configRun.projectId, configProject.id))
    .where(
      userId
        ? and(eq(configProject.tenantId, tenantId), eq(configProject.createdBy, userId))
        : eq(configProject.tenantId, tenantId),
    );
  // numeric comes back as string; a project with several runs keeps the quoted one.
  const byProject = new Map<string, ProjectRow>();
  for (const r of rows) {
    const row: ProjectRow = {
      id: r.id, name: r.name, status: r.status, source: r.source,
      createdBy: r.createdBy, createdAt: r.createdAt,
      customerName: r.customer?.cardName ?? null,
      quotedAt: r.quotedAt, b1DocEntry: r.b1DocEntry,
      quotedValue: r.quotedValue === null ? null : Number(r.quotedValue),
      quotedCost: r.quotedCost === null ? null : Number(r.quotedCost),
    };
    const prev = byProject.get(r.id);
    if (!prev || (row.quotedAt && !prev.quotedAt)) byProject.set(r.id, row);
  }
  return [...byProject.values()];
}

export const dashboardRouter = {
  overview: userProcedure
    .input(z.object({
      window: z.enum(["month", "quarter", "year12"]).default("month"),
      scope: z.enum(["mine", "tenant"]).default("tenant"),
    }))
    .handler(async ({ input, context }) => {
      const { tenantId, userId } = context;
      const [ti] = await db
        .select({ salesReps: tenantIntegration.salesReps, lastSeenAt: tenantIntegration.lastSeenAt })
        .from(tenantIntegration)
        .where(eq(tenantIntegration.tenantId, tenantId))
        .limit(1);
      const salesPersonCode = ti?.salesReps?.[userId] ?? null;
      // Unmapped users get tenant numbers rather than a half-scoped page.
      const scope = input.scope === "mine" && salesPersonCode !== null ? "mine" : "tenant";

      const [snap] = await db
        .select({ payload: dashboardSnapshot.payload, computedAt: dashboardSnapshot.computedAt, lastError: dashboardSnapshot.lastError })
        .from(dashboardSnapshot)
        .where(eq(dashboardSnapshot.tenantId, tenantId))
        .limit(1);

      const failed: ExceptionRow[] = await db
        .select({ id: agentRequest.id, kind: agentRequest.kind, lastError: agentRequest.lastError, updatedAt: agentRequest.updatedAt })
        .from(agentRequest)
        .where(and(eq(agentRequest.tenantId, tenantId), eq(agentRequest.status, "failed")))
        .orderBy(desc(agentRequest.updatedAt))
        .limit(FAILED_LIMIT);

      return buildOverview({
        window: input.window, scope, now: new Date(),
        snapshot: snap ?? null,
        salesPersonCode,
        projects: await loadProjects(tenantId, scope === "mine" ? userId : null),
        failed,
        agentLastSeen: ti?.lastSeenAt ?? null,
      });
    }),

  refresh: userProcedure.handler(async ({ context }) => {
    const { tenantId } = context;
    const [snap] = await db
      .select({ computedAt: dashboardSnapshot.computedAt })
      .from(dashboardSnapshot)
      .where(eq(dashboardSnapshot.tenantId, tenantId))
      .limit(1);
    if (snap && Date.now() - snap.computedAt.getTime() < REFRESH_COOLDOWN_MS) return { refreshed: false };
    await assertAgentReady(tenantId);
    await refreshB1Snapshot(tenantId, (path) => runRequest(tenantId, "query", { target: "b1", path }));
    return { refreshed: true };
  }),

  salesReps: {
    get: userProcedure.handler(async ({ context }) => {
      const [ti] = await db
        .select({ salesReps: tenantIntegration.salesReps })
        .from(tenantIntegration)
        .where(eq(tenantIntegration.tenantId, context.tenantId))
        .limit(1);
      return { reps: ti?.salesReps ?? {} };
    }),

    set: adminProcedure
      .input(z.object({ userId: z.string().min(1), salesPersonCode: z.number().int().positive().nullable() }))
      .handler(async ({ input, context }) => {
        const [ti] = await db
          .select({ salesReps: tenantIntegration.salesReps })
          .from(tenantIntegration)
          .where(eq(tenantIntegration.tenantId, context.tenantId))
          .limit(1);
        if (!ti) throw new ORPCError("NOT_FOUND", { message: "No integration is configured for this workspace" });
        const reps = { ...ti.salesReps };
        if (input.salesPersonCode === null) delete reps[input.userId];
        else reps[input.userId] = input.salesPersonCode;
        await db.update(tenantIntegration).set({ salesReps: reps })
          .where(eq(tenantIntegration.tenantId, context.tenantId));
        return { reps };
      }),
  },
};
```

Remove the unused `inArray` import if the linter flags it.

- [ ] **Step 4: Mount the router**

In `apps/server/src/orpc/router.ts`, add the import and the key:

```ts
import { dashboardRouter } from "./routers/dashboard.ts";
// ...
  dashboard: dashboardRouter,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test apps/server/test/dashboard-router.test.ts`
Expected: PASS — all 5 cases.

- [ ] **Step 6: Run the full server suite**

Run: `bun test apps/server`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/orpc/routers/dashboard.ts apps/server/src/orpc/router.ts apps/server/test/dashboard-router.test.ts
git commit -m "feat: dashboard router with scoped overview, refresh, and sales-rep mapping"
```

---

### Task 7: Sales-employee mapping in Settings

**Files:**
- Modify: `apps/web/src/routes/_authed/settings.tsx`

**Interfaces:**
- Consumes: `dashboard.salesReps.get` / `.set` (Task 6); the existing `orpc` client from `../../orpc.ts`.
- Produces: no new exports.

- [ ] **Step 1: Read the file to match its conventions**

Run: `sed -n 1,60p apps/web/src/routes/_authed/settings.tsx`
Note how it lists members, how it invalidates queries after a mutation, and how it renders `Table` / `TableRow`. Follow that shape exactly rather than inventing a new one.

- [ ] **Step 2: Add the section**

Below the existing portal-client table, add:

```tsx
function SalesRepMapping() {
  const qc = useQueryClient();
  const reps = useQuery(orpc.dashboard.salesReps.get.queryOptions({ input: {} }));
  const members = useQuery({
    queryKey: ["org-members"],
    queryFn: async () => (await authClient.organization.listMembers()).data?.members ?? [],
  });
  const save = useMutation(orpc.dashboard.salesReps.set.mutationOptions({
    onSuccess: () => void qc.invalidateQueries({ queryKey: orpc.dashboard.salesReps.get.key() }),
  }));

  return (
    <>
      <Title level="H4">SAP sales employees</Title>
      <Text>
        Link a workspace member to their SAP sales employee so the dashboard can show their own
        figures. Members left unlinked see workspace-wide figures.
      </Text>
      <Table>
        <TableHeaderRow slot="headerRow">
          <TableHeaderCell><span>Member</span></TableHeaderCell>
          <TableHeaderCell><span>SalesEmployeeCode</span></TableHeaderCell>
        </TableHeaderRow>
        {(members.data ?? []).map((m) => (
          <TableRow key={m.userId} rowKey={m.userId}>
            <TableCell><Text>{m.user?.email ?? m.userId}</Text></TableCell>
            <TableCell>
              <Input
                type="Number"
                value={String(reps.data?.reps[m.userId] ?? "")}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  save.mutate({ userId: m.userId, salesPersonCode: raw === "" ? null : Number(raw) });
                }}
              />
            </TableCell>
          </TableRow>
        ))}
      </Table>
    </>
  );
}
```

Add `Input`, `Table`, `TableCell`, `TableHeaderCell`, `TableHeaderRow`, `TableRow`, `Text`, `Title` to the existing `@ui5/webcomponents-react` import if any are missing, and `useMutation` / `useQueryClient` to the TanStack import.

`ponytail:` a plain number input rather than a `SalesPersons` value help — the code is a small integer an admin already knows, and a value help needs the entity enabled. Swap in `EntityValueHelp` if admins start guessing.

- [ ] **Step 3: Render it**

Add `<SalesRepMapping />` inside the settings page body, after the existing portal-client section.

- [ ] **Step 4: Verify by hand**

Run: `bun run dev`
Open `http://<slug>.lvh.me:5173/settings` as an admin. Type a number into a member's field, reload the page, confirm it persisted. Clear the field, reload, confirm it cleared.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/_authed/settings.tsx
git commit -m "feat: map workspace members to SAP sales employees in settings"
```

---

### Task 8: Web view module

**Files:**
- Create: `apps/web/src/components/dashboard/dashboardView.ts`
- Test: `apps/web/src/components/dashboard/dashboardView.test.ts`

**Interfaces:**
- Consumes: the `Overview` type from the server router's inferred output.
- Produces:

```ts
export function money(value: number, currency: string): string;
export function percent(value: number | null): string;
export function trendOf(current: number, previous: number): "Up" | "Down" | "None";
export function scaled(value: number): { value: string; scale: string };
export function greeting(now: Date, name: string): string;
export function nextActions(o: Overview): Array<{ text: string; to: string }>;
```

- [ ] **Step 1: Write the failing tests**

`apps/web/src/components/dashboard/dashboardView.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { greeting, money, nextActions, percent, scaled, trendOf } from "./dashboardView.ts";

describe("formatting", () => {
  test("money renders whole units with the currency", () => {
    expect(money(1234.5, "EUR")).toBe("€1,235");
  });
  test("percent renders one decimal, and a dash for null", () => {
    expect(percent(0.3155)).toBe("31.6%");
    expect(percent(null)).toBe("—");
  });
  test("scaled abbreviates thousands and millions", () => {
    expect(scaled(950)).toEqual({ value: "950", scale: "" });
    expect(scaled(12_400)).toEqual({ value: "12.4", scale: "k" });
    expect(scaled(1_240_000)).toEqual({ value: "1.24", scale: "M" });
  });
});

describe("trendOf", () => {
  test("compares against the previous period", () => {
    expect(trendOf(10, 5)).toBe("Up");
    expect(trendOf(5, 10)).toBe("Down");
    expect(trendOf(5, 5)).toBe("None");
  });
  test("no previous period is not a trend", () => {
    expect(trendOf(10, 0)).toBe("None");
  });
});

describe("greeting", () => {
  test("changes with the time of day", () => {
    expect(greeting(new Date("2026-08-19T08:00:00"), "Ben")).toBe("Good morning, Ben");
    expect(greeting(new Date("2026-08-19T14:00:00"), "Ben")).toBe("Good afternoon, Ben");
    expect(greeting(new Date("2026-08-19T20:00:00"), "Ben")).toBe("Good evening, Ben");
  });
});

describe("nextActions", () => {
  const base = {
    attention: [], exceptions: { failed: [], agentStale: false, agentLastSeen: null },
  } as never;

  test("is empty when nothing needs a human", () => {
    expect(nextActions(base)).toEqual([]);
  });

  test("pluralises and links each kind of work", () => {
    const o = {
      attention: [{ reason: "Portal request waiting" }, { reason: "Portal request waiting" }, { reason: "Rejected — needs rework" }],
      exceptions: { failed: [{ id: "x" }], agentStale: true, agentLastSeen: null },
    } as never;
    expect(nextActions(o)).toEqual([
      { text: "3 configurations need you", to: "/configs" },
      { text: "1 sync failed", to: "/settings" },
      { text: "The on-prem agent is offline", to: "/settings" },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/web/src/components/dashboard/dashboardView.test.ts`
Expected: FAIL — cannot resolve `./dashboardView.ts`.

- [ ] **Step 3: Implement the module**

`apps/web/src/components/dashboard/dashboardView.ts`:

```ts
import type { RouterOutputs } from "../../orpc.ts";

export type Overview = RouterOutputs["dashboard"]["overview"];

export function money(value: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency", currency, maximumFractionDigits: 0,
  }).format(value);
}

export function percent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

export function trendOf(current: number, previous: number): "Up" | "Down" | "None" {
  if (previous === 0) return "None";
  if (current > previous) return "Up";
  if (current < previous) return "Down";
  return "None";
}

/** AnalyticalCardHeader wants the number and its scaling prefix separately. */
export function scaled(value: number): { value: string; scale: string } {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return { value: (value / 1_000_000).toFixed(2), scale: "M" };
  if (abs >= 1_000) return { value: (value / 1_000).toFixed(1), scale: "k" };
  return { value: String(Math.round(value)), scale: "" };
}

export function greeting(now: Date, name: string): string {
  const h = now.getHours();
  const part = h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
  return `Good ${part}, ${name}`;
}

export function nextActions(o: Overview): Array<{ text: string; to: string }> {
  const out: Array<{ text: string; to: string }> = [];
  const n = o.attention.length;
  if (n) out.push({ text: `${n} configuration${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} you`, to: "/configs" });
  const f = o.exceptions.failed.length;
  if (f) out.push({ text: `${f} sync${f === 1 ? "" : "s"} failed`, to: "/settings" });
  if (o.exceptions.agentStale) out.push({ text: "The on-prem agent is offline", to: "/settings" });
  return out;
}
```

If `RouterOutputs` is not already exported from `apps/web/src/orpc.ts`, add it there:

```ts
import type { InferRouterOutputs } from "@orpc/server";
export type RouterOutputs = InferRouterOutputs<AppRouter>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/web/src/components/dashboard/dashboardView.test.ts`
Expected: PASS — all 9 cases. If `money` disagrees on the separator, pin the locale to `"en-GB"` in the formatter and re-run rather than loosening the assertion.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/dashboard/dashboardView.ts apps/web/src/components/dashboard/dashboardView.test.ts apps/web/src/orpc.ts
git commit -m "feat: dashboard view formatting and next-action helpers"
```

---

### Task 9: Dashboard page

**Files:**
- Create: `apps/web/src/components/dashboard/DashboardPage.tsx`
- Modify: `apps/web/src/routes/_authed/index.tsx`
- Modify: `apps/web/package.json` (new dependency)

**Interfaces:**
- Consumes: `orpc.dashboard.overview` / `.refresh` (Task 6); every helper from `dashboardView.ts` (Task 8).
- Produces: `export function DashboardPage(): JSX.Element`.

- [ ] **Step 1: Add the charts dependency**

Run: `bun add --cwd apps/web @ui5/webcomponents-react-charts`
Expected: `apps/web/package.json` gains `@ui5/webcomponents-react-charts`. It must be a direct dependency — isolated installs do not resolve it transitively.

- [ ] **Step 2: Write the page**

`apps/web/src/components/dashboard/DashboardPage.tsx`:

```tsx
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AnalyticalCardHeader, Button, Card, CardHeader, FlexBox, HeroBanner, Link, List,
  ListItemStandard, MessageStrip, NumericSideIndicator, ObjectStatus, SegmentedButton,
  SegmentedButtonItem, Select, Option, Text, Title, Toolbar, ToolbarSpacer,
} from "@ui5/webcomponents-react";
import { BarChart } from "@ui5/webcomponents-react-charts";
import { ThemingParameters } from "@ui5/webcomponents-react-base";
import { authClient } from "../../auth-client.ts";
import { orpc } from "../../orpc.ts";
import { greeting, money, nextActions, percent, scaled, trendOf } from "./dashboardView.ts";

const WINDOWS = [
  { key: "month", label: "This month" },
  { key: "quarter", label: "This quarter" },
  { key: "year12", label: "Last 12 months" },
] as const;

const cards = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: "1rem" };
const panels = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(360px,1fr))", gap: "1rem" };

export function DashboardPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [window, setWindow] = useState<"month" | "quarter" | "year12">("month");
  const [scope, setScope] = useState<"mine" | "tenant">("tenant");
  const [ageFilter, setAgeFilter] = useState<string | null>(null);

  const { data: session } = useQuery<Awaited<ReturnType<typeof authClient.getSession>>["data"]>({ queryKey: ["session"] });
  const reps = useQuery(orpc.dashboard.salesReps.get.queryOptions({ input: {} }));
  const o = useQuery(orpc.dashboard.overview.queryOptions({ input: { window, scope } }));
  const refresh = useMutation(orpc.dashboard.refresh.mutationOptions({
    onSuccess: () => void qc.invalidateQueries({ queryKey: orpc.dashboard.overview.key() }),
  }));

  const userId = session?.user?.id ?? "";
  const mapped = reps.data?.reps[userId] !== undefined;
  const firstName = (session?.user?.name ?? session?.user?.email ?? "there").split(/[ @]/)[0]!;

  if (!o.data) return <Card loading style={{ height: "12rem" }} />;
  const d = o.data;
  const cur = d.currency;
  const orderValue = scaled(d.orderValue.total);
  const heraValue = scaled(d.orderValue.hera);
  const bucketDocEntries = new Set(d.pipeline.find((p) => p.bucket === ageFilter)?.docEntries ?? []);
  const attention = ageFilter
    ? d.attention.filter((a) => a.docEntry !== null && bucketDocEntries.has(a.docEntry))
    : d.attention;

  return (
    <FlexBox direction="Column" style={{ gap: "1rem", padding: "1rem" }}>
      <HeroBanner
        overlineText={`${new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}${
          d.computedAt ? ` · SAP data as of ${new Date(d.computedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : ""
        }`}
        headerText={greeting(new Date(), firstName)}
        actions={<Button icon="add" design="Emphasized" onClick={() => navigate({ to: "/configs" })}>New configuration</Button>}
      >
        <FlexBox direction="Column" style={{ gap: "0.25rem" }}>
          {nextActions(d).map((a) => (
            <Link key={a.text} onClick={() => navigate({ to: a.to })}>{a.text}</Link>
          ))}
        </FlexBox>
      </HeroBanner>

      <Toolbar>
        {mapped && (
          <SegmentedButton onSelectionChange={(e) => setScope((e.detail.selectedItems[0] as HTMLElement).dataset.scope as "mine" | "tenant")}>
            <SegmentedButtonItem data-scope="tenant" selected={scope === "tenant"}>Everyone</SegmentedButtonItem>
            <SegmentedButtonItem data-scope="mine" selected={scope === "mine"}>Mine</SegmentedButtonItem>
          </SegmentedButton>
        )}
        <Select onChange={(e) => setWindow((e.detail.selectedOption as HTMLElement).dataset.key as typeof window)}>
          {WINDOWS.map((w) => <Option key={w.key} data-key={w.key} selected={w.key === window}>{w.label}</Option>)}
        </Select>
        <ToolbarSpacer />
        <Button icon="refresh" disabled={refresh.isPending} onClick={() => refresh.mutate({})} />
      </Toolbar>

      {(d.snapshotError || !d.computedAt) && (
        <MessageStrip design="Warning" hideCloseButton>
          {d.snapshotError
            ? `SAP figures could not be refreshed: ${d.snapshotError}`
            : "SAP figures have not been collected yet. They appear after the first hourly sync."}
        </MessageStrip>
      )}

      <div style={cards}>
        <Card>
          <AnalyticalCardHeader
            titleText="Order value" subtitleText={WINDOWS.find((w) => w.key === window)!.label}
            value={orderValue.value} scale={`${orderValue.scale} ${cur}`}
            trend={trendOf(d.orderValue.total, d.orderValue.prevTotal)} state="Good"
          >
            <NumericSideIndicator titleText="via HERA" number={heraValue.value} unit={`${heraValue.scale} ${cur}`} />
          </AnalyticalCardHeader>
        </Card>
        <Card>
          <AnalyticalCardHeader
            titleText="Quote-to-order" subtitleText={`${d.conversion.converted} of ${d.conversion.quotes} quotations`}
            value={percent(d.conversion.rate)} trend={trendOf(d.conversion.rate, d.conversion.prevRate)}
          />
        </Card>
        <Card>
          <AnalyticalCardHeader
            titleText="Quote turnaround" subtitleText={`median of ${d.turnaround.sampled}`}
            value={d.turnaround.medianDays === null ? "—" : d.turnaround.medianDays.toFixed(1)} scale="days"
          />
        </Card>
        <Card>
          <AnalyticalCardHeader
            titleText="Configured margin" subtitleText={`${d.margin.covered} of ${d.margin.of} quotes`}
            value={percent(d.margin.pct)}
            state={d.margin.pct !== null && d.margin.pct < 0.15 ? "Critical" : "Good"}
          />
        </Card>
      </div>

      <div style={panels}>
        <Card header={<CardHeader titleText="Configuration → order" />}>
          <BarChart
            dimensions={[{ accessor: "stage" }]}
            measures={[{ accessor: "count", label: "Configurations" }]}
            dataset={d.funnel}
            noLegend
          />
        </Card>
        <Card header={<CardHeader titleText="Open pipeline by age" />}>
          <BarChart
            dimensions={[{ accessor: "bucket" }]}
            measures={[{
              accessor: "value", label: `Open value (${cur})`,
              formatter: (v: number) => money(v, cur),
              highlightColor: (_v: unknown, d: { bucket: string }) =>
                d.bucket === "30d+" ? ThemingParameters.sapNegativeColor : undefined,
            }]}
            dataset={d.pipeline}
            noLegend
            onDataPointClick={(e) => {
              const bucket = (e.detail as { payload?: { bucket?: string } }).payload?.bucket ?? null;
              setAgeFilter((prev) => (prev === bucket ? null : bucket));
            }}
          />
          {d.pipelineTruncated && (
            <Text style={{ padding: "0 1rem 0.5rem" }}>
              Showing the 1,000 most recent open quotations; older ones are not counted.
            </Text>
          )}
        </Card>
      </div>

      <div style={panels}>
        <Card header={<CardHeader titleText={ageFilter ? `Needs attention · ${ageFilter}` : "Needs attention"} />}>
          <List>
            {attention.length === 0 && <ListItemStandard>Nothing waiting on you</ListItemStandard>}
            {attention.map((a) => (
              <ListItemStandard
                key={a.id} description={a.customer ?? undefined} additionalText={`${a.ageDays}d`}
                additionalTextState="Critical" onClick={() => navigate({ to: "/configs/$id", params: { id: a.id } })}
              >
                {a.name} — {a.reason}
              </ListItemStandard>
            ))}
          </List>
        </Card>
        <Card header={<CardHeader titleText="Exceptions" />}>
          <List>
            {d.exceptions.agentStale && (
              <ListItemStandard><ObjectStatus state="Critical">The on-prem agent is offline</ObjectStatus></ListItemStandard>
            )}
            {d.exceptions.failed.length === 0 && !d.exceptions.agentStale && (
              <ListItemStandard>No integration errors</ListItemStandard>
            )}
            {d.exceptions.failed.map((f) => (
              <ListItemStandard key={f.id} description={f.lastError ?? undefined}
                                additionalText={new Date(f.updatedAt).toLocaleDateString()}>
                {f.kind} failed
              </ListItemStandard>
            ))}
          </List>
        </Card>
      </div>
    </FlexBox>
  );
}
```

`ponytail:` `ageFilter` narrows the list rather than refetching — the overview already carries every attention row, so a second round-trip would buy nothing.

- [ ] **Step 3: Wire the route**

Replace `apps/web/src/routes/_authed/index.tsx` entirely:

```tsx
import { createFileRoute } from '@tanstack/react-router'
import { DashboardPage } from '../../components/dashboard/DashboardPage.tsx'

export const Route = createFileRoute('/_authed/')({
  component: DashboardPage,
})
```

- [ ] **Step 4: Verify it builds**

Run: `bun run build:web`
Expected: a clean build. Fix any import-name mismatch against the real 2.24 exports — `SegmentedButtonItem` and `Option` in particular are the names to check first if the build complains.

- [ ] **Step 5: Verify it renders**

Run: `bun run dev`
Open `http://<slug>.lvh.me:5173/`. Confirm: the HeroBanner greets by name; four KPI cards render (zeros are fine on a fresh tenant); both charts render; the warning strip appears when no snapshot exists; clicking a pipeline bar filters the attention list and clicking it again clears the filter.

- [ ] **Step 6: Run the web suite**

Run: `bun test apps/web`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/dashboard/DashboardPage.tsx apps/web/src/routes/_authed/index.tsx \
        apps/web/package.json bun.lock
git commit -m "feat: sales dashboard home page"
```

---

## Verification

- [ ] `bun test` across `apps/server`, `apps/web`, `apps/agent` — all green.
- [ ] `bun run build:web` — clean.
- [ ] With the agent stopped: the dashboard still renders, the B1 tiles show zeros, and the warning strip explains why.
- [ ] With the agent running: `refresh` populates the snapshot, and the order-value and pipeline tiles change.
- [ ] Quote a configuration end to end and confirm `config_run.quoted_value` and `quoted_cost` are non-null afterwards.
- [ ] Confirm `config_history` row counts grew for any model with a history query — that is Task 1's side effect landing.
