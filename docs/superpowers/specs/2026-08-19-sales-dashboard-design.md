# Sales dashboard: SAP B1 sales figures over HERA configuration data

Date: 2026-08-19

## Purpose

Replace the placeholder at `apps/web/src/routes/_authed/index.tsx` with the signed-in home page:
a single-scroll overview that answers "how is the business doing, and what did HERA contribute".

It must show:

- Order value generated
- Quote-to-order conversion
- Median quote turnaround time
- Gross margin
- Configuration-to-order funnel
- Open pipeline by age
- Quotes requiring attention
- Integration and configuration exceptions

Each figure is tenant-wide, with the HERA-originated slice shown as a sub-indicator. A user
mapped to a B1 sales employee can additionally switch to their own numbers.

## Verified facts

Read from the code and the connected B1 v2 Service Layer, on 2026-08-19.

- The cloud database holds no B1 sales data. Every B1 read is an `agent_request` round-trip
  fulfilled by the on-prem agent (`apps/server/src/orpc/routers/entities.ts:82`, `runRequest`).
- `Outputs` already carries `unitCost` and `unitPrice`
  (`packages/config-engine/src/output.ts:23`), and `config_run.candidates[].perBatch[].outputs`
  persists them per quote with `selection` naming the chosen candidate and batch. Margin needs
  no SAP call.
- `config_run.b1DocEntry` is the B1 Quotation `DocEntry` and is the only join between HERA and
  B1 sales documents (`apps/server/src/config-quote.ts:181`).
- `config_project` carries `status` (`draft|calculated|quoted|requested|rejected`), `source`
  (`internal|portal`), `createdBy`, and an append-only `events[]` with `at` and `kind`. The
  funnel and turnaround are derivable from these columns alone.
- `agent_request.status = 'failed'` plus `lastError` is the integration exception feed;
  `tenant_integration.lastSeenAt` is agent liveness (`AGENT_STALE_MS` in `entities.ts`).
- **`queryRaw` does not page.** `service-layer-client.ts:889` calls `request("GET", path)` with
  no body, and the `odatamaxpagesize` header at line 729 is set only inside the
  `if (body !== undefined)` branch. GETs therefore use B1 v2's default page size of 20, and
  `queryRaw` returns the raw JSON without following `@odata.nextLink`. Every `query`-kind
  request truncates at 20 rows today, including `history-sync.ts`.
- `$apply` with `groupby` is HANA-only from 9.2 PL03. Aggregation must not depend on it.
- `@ui5/webcomponents-react-charts` is not currently a dependency. `@ui5/webcomponents-react`
  2.24.1 is, and provides `HeroBanner`, `Card`, `AnalyticalCardHeader`, `NumericSideIndicator`,
  `List`, `MessageStrip`, `SegmentedButton`, `Select`, and `Toolbar`.
- SAP's own note on the charts package, verbatim: "Charts are custom-built without defined
  design specifications! They use the Fiori color palette, but functionality and especially
  accessibility may not meet standard app requirements."

## Decisions

- **No separate analytics service.** One server process already runs the exact pattern needed
  (`startHistorySync` in `apps/server/src/history-sync.ts`: in-process interval, wholesale
  refresh into a jsonb table, cache invalidation). A dashboard service would need its own
  deploy, auth, and agent connection to serve one page. Revisit when the server goes
  multi-instance, or when a tenant wants drill-down over millions of B1 rows.
- **Split read path.** App-side metrics are live SQL on tables we own. B1-side metrics come
  from an hourly snapshot. The page renders fully with the agent offline; the B1 tiles carry
  their age.
- **Aggregate in JS, not `$apply`.** Portable across HANA and MSSQL, and it makes the
  aggregation a pure function that tests can drive with fixtures.
- **Margin is engineered margin**, from `computeOutputs`, not B1 gross profit.
- **Snapshot buckets by month and by `SalesPersonCode`**, so one fetch serves every time window
  and both scopes.
- Add `@ui5/webcomponents-react-charts` for the two bar charts.

## Non-goals

Drill-down routes, custom date ranges, CSV export, per-metric caching, real-time push, and
per-configuration-step abandonment telemetry. None block the page; each is added on request.

Abandonment by configuration step was in the original list and was dropped in favour of open
pipeline by age. It remains derivable without new storage if it comes back: walk
`modelDef.structure.sections` against a stalled draft's `entries` and report the first section
with an unanswered visible-and-required parameter.

## Metric definitions

| Metric | Source | Path |
|---|---|---|
| Order value generated | B1 `Orders` headers | snapshot |
| Quote-to-order conversion | B1 `Quotations.DocumentStatus` | snapshot |
| Median quote turnaround | `config_project.events[created].at` → `config_run.quotedAt` | live SQL |
| Gross margin | `computeOutputs()`, `unitPrice − unitCost` | live, pure |
| Config → order funnel | `config_project.status` + `b1DocEntry` ∩ snapshot orders | live SQL |
| Open pipeline by age | B1 open `Quotations`; HERA slice via `b1DocEntry` | snapshot |
| Quotes requiring attention | `config_project` requested / rejected / stale | live SQL |
| Exceptions | `agent_request.status='failed'`, `tenant_integration.lastSeenAt` | live SQL |

### Two approximations

Both carry a `ponytail:` comment naming the ceiling and the upgrade path.

**Conversion counts a quotation as converted when `DocumentStatus` is closed and `Cancelled` is
false.** This over-counts manually closed quotations. Exact attribution needs
`Orders?$expand=DocumentLines($select=BaseEntry,BaseType)`, an expand-on-collection that SAP
documents a performance warning for. Upgrade when someone disputes a number.

**Tenant-wide gross profit is probed, not assumed.** The snapshot job issues
`GET /Orders?$select=DocEntry,GrossProfit&$top=1` once per run. On success it records
`grossProfitAvailable: true` and collects the field; on a 400 it records `false` and the margin
tile shows the configured-margin segment alone. No guessing at field availability.

## Architecture

### Read path

`dashboard.overview` is one oRPC call issuing two SQL queries — the app-side aggregates and the
snapshot row. No agent involvement, roughly 5 ms.

### Write path

`startDashboardSnapshot()` in `apps/server/src/dashboard-snapshot.ts`, hourly, mirroring
`startHistorySync`. Per tenant it issues three `runRequest(tenantId, "query", …)` calls — orders
and quotations over a rolling 13 months, plus all currently open quotations — followed by the
gross-profit probe, aggregates the rows in JS, and upserts one row.

The fetch window is fixed at 13 months regardless of the selected UI window. Thirteen rather
than twelve so that "last 12 months" is complete on the first day of a month, and so month-over-
month trend arrows always have a prior month to compare against.

```
┌─ Dashboard load ─────────────────────┐
│ dashboard.overview()   1 oRPC call   │
│   ├─ SQL: config_project / config_run│
│   │        / agent_request     ~5ms  │
│   └─ SQL: dashboard_snapshot   ~1ms  │
│            └─ "as of 14:05"  [↻]     │
└──────────────────────────────────────┘
             ↑ hourly, out of band
┌─ refreshB1Snapshot(tenantId) ────────┐
│ runRequest("query", /Orders?…)       │
│ runRequest("query", /Quotations?…)   │
│ runRequest("query", /Quotations?open)│
│   → aggregate in JS → upsert one row │
└──────────────────────────────────────┘
```

### Agent change

Extend `ServiceLayerClient.queryRaw` to send `Prefer: odata.maxpagesize=1000`, follow
`@odata.nextLink` while the response `value` is an array, and stop at a 20,000-row cap. Roughly
twelve lines in one method. Only page when `value` is an array, so aggregate-shaped responses
pass through untouched.

This also un-truncates `history-sync` and model `queryTables`. That is a behaviour change worth
verifying separately: a model query that has been quietly returning 20 rows will start returning
all of them.

## Schema

```ts
// packages/db/src/schema/dashboard.ts
export const dashboardSnapshot = pgTable("dashboard_snapshot", {
  tenantId:   text("tenant_id").primaryKey(),
  payload:    jsonb("payload").$type<B1Snapshot>().notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  lastError:  text("last_error"),
});
```

```ts
type Bucket = {
  orders: { count: number; value: number; grossProfit: number | null };
  quotes: { count: number; closed: number; value: number };
};

type B1Snapshot = {
  currency: string;
  months: Record<string, Record<string, Bucket>>; // "2026-08" → SalesPersonCode | "" → Bucket
  openQuotes: Array<{
    docEntry: number; docNum: number; cardCode: string; cardName: string;
    docDate: string; docTotal: number; salesPersonCode: number;
  }>;
  openQuotesTruncated: boolean;
  grossProfitAvailable: boolean;
};
```

`openQuotes` is capped at 1000 rows, newest first, and the cap is reported rather than applied
silently — the age chart footnotes it when `openQuotesTruncated` is true. The list is kept, not
pre-aggregated, because the HERA slice needs to intersect `docEntry` with `config_run.b1DocEntry`.

One new column on `tenant_integration`:

```ts
salesReps: jsonb("sales_reps").$type<Record<string, number>>().notNull().default({}),
// userId -> B1 SalesEmployeeCode
```

A jsonb map rather than a table, matching the `enabledEntities` and `writeCapabilities`
precedent: admin-maintained, tens of entries, read once per request.
`ponytail:` a real table if it ever needs to be queried by rep code.

## Server surface

New router `apps/server/src/orpc/routers/dashboard.ts`:

- `overview({ scope: "mine" | "tenant", window: "month" | "quarter" | "year12" })` —
  `userProcedure`. Falls back to `tenant` when the caller has no `salesReps` entry.
- `refresh()` — manual snapshot rebuild, no-op when `computedAt` is under 2 minutes old.
- `salesReps.get` / `salesReps.set` — admin-gated, backs the Settings screen.

`scope: "mine"` means `config_project.createdBy = session.userId` on the app side, and the
caller's `salesReps[userId]` bucket on the B1 side. The two are independent identities: a user
can create configurations without being a B1 sales employee, which is exactly why an unmapped
user is refused `"mine"` rather than shown a half-scoped page.

New pure module `apps/server/src/dashboard.ts`: rows in, overview shape out. No DB, no
transport. Median, age buckets, funnel, and margin roll-up live here.

SQL returns rows, never aggregates — the median is `percentile_cont`-free and computed in JS
alongside everything else, so the whole aggregation stays in one tested pure function.

### Sales rep mapping screen

A section in the existing `apps/web/src/routes/_authed/settings.tsx` (234 lines, already has the
member-table pattern): one row per org member, with a value help picking `SalesPersons`.

Unmapped users get tenant-wide numbers, no Mine/Everyone toggle, and a hint linking to Settings.

## UI

`apps/web/src/routes/_authed/index.tsx` renders `DashboardPage`. `HeroBanner` is documented as
non-sticky page-top, so there is no `DynamicPage` wrapper; the page scrolls inside the existing
`NavigationLayout` outlet.

| Slot | Component |
|---|---|
| Welcome and next actions | `HeroBanner` — `overlineText`, `headerText`, `actions`, default slot |
| Four KPI tiles | `Card` + `AnalyticalCardHeader` + `NumericSideIndicator` |
| Funnel, pipeline by age | `BarChart` |
| Attention and exceptions | `List` / `ListItemStandard`, `ObjectStatus`, `MessageStrip` |
| Controls | `SegmentedButton`, `Select`, `Toolbar` |

```tsx
<HeroBanner
  overlineText="Tuesday, 19 August · SAP data as of 14:05"
  headerText={`Good morning, ${firstName}`}
  actions={<Button icon="add" design="Emphasized">New configuration</Button>}
>
  <Link onClick={…}>3 configurations need you</Link>
  <Link onClick={…}>2 portal requests waiting</Link>
  <Link onClick={…}>1 sync failed</Link>
</HeroBanner>

<Toolbar>
  {mapped && <SegmentedButton>Mine · Everyone</SegmentedButton>}
  <Select>This month · This quarter · Last 12 months</Select>
  <ToolbarSpacer />
  <Text>as of 14:05</Text><Button icon="refresh" />
</Toolbar>

<div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: '1rem' }}>
  <Card>
    <AnalyticalCardHeader titleText="Order value" value="1.24" scale="M €" trend="Up"
                          subtitleText="This quarter" state="Good">
      <NumericSideIndicator titleText="via HERA" number="284" unit="k €" />
    </AnalyticalCardHeader>
  </Card>
  {/* Conversion · Turnaround · Configured margin — same shape */}
</div>

<div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(360px,1fr))', gap: '1rem' }}>
  <Card header={<CardHeader titleText="Configuration → order" />}>
    <BarChart dimensions={[{ accessor: 'stage' }]} measures={[{ accessor: 'count' }]} dataset={funnel} />
  </Card>
  <Card header={<CardHeader titleText="Open pipeline by age" />}>
    <BarChart
      dimensions={[{ accessor: 'bucket' }]}
      measures={[{ accessor: 'value', formatter: money,
                   highlightColor: (v, d) => d.bucket === '30d+' ? ThemingParameters.sapNegativeColor : undefined }]}
      dataset={ageBuckets}
      onDataPointClick={filterAttentionList}
    />
  </Card>
</div>
```

Three deliberate touches:

- **Next-action links target existing pages with filters pre-applied.** No new detail routes;
  this is what keeps the single-scroll layout cheap.
- **`onDataPointClick` on the age chart filters the attention list below it.** Without this the
  chart and the list say the same thing twice. Clicking `30d+` narrows the list to those quotes.
- **`NumericSideIndicator` carries the HERA segment inside each tenant-wide tile.** One number,
  one sub-number, no second dashboard.

### Layout

CSS grid via `grid-template-columns: repeat(auto-fit, minmax(…, 1fr))` rather than UI5 `Grid` or
`ResponsiveGridLayout`: one line, native, and the Fiori breakpoints buy nothing here.

### Degradation

In order of likelihood:

- Snapshot stale or `lastError` set → `MessageStrip design="Warning"` above the two B1 tiles
  only. The rest of the page is unaffected.
- Agent never connected → B1 tiles show `—` with a link to setup.
- No configurations yet → funnel renders zeros, and the HeroBanner action becomes
  "Create your first configuration".
- Unmapped user → no Mine/Everyone toggle, tenant numbers, hint linking to Settings.

### Files

```
apps/web/src/components/dashboard/DashboardPage.tsx        render only
apps/web/src/components/dashboard/dashboardView.ts         buckets → dataset, formatting, scope rule
apps/web/src/components/dashboard/dashboardView.test.ts
apps/web/src/routes/_authed/index.tsx                      → <DashboardPage/>
```

The split of pure logic out of the `.tsx` follows the existing `configurator/` convention
(`configProcessState.ts`, `runView.ts`, `formHelpers.ts`).

## Testing

Two test files, both pure — no database, no rendering — matching `b1Lines.test.ts` and
`configProcessState.test.ts`.

`apps/server/test/dashboard.test.ts`:

- Median turnaround over even, odd, and empty sets.
- Age bucketing at the 7, 14, and 30 day boundaries.
- Funnel counts across every `config_project.status`.
- Margin roll-up with and without `selection[].overrides`.
- The `grossProfitAvailable: false` path.

`apps/web/src/components/dashboard/dashboardView.test.ts`:

- Month and rep bucket sums for each time window and both scopes.
- Money and percent formatting.
- The unmapped-user-falls-back-to-tenant-scope rule.

## Open risks

- The `queryRaw` paging fix changes existing behaviour for `history-sync` and model
  `queryTables`. Verify those separately before shipping.
- Conversion is approximate by design. If a tenant's sales process closes quotations manually,
  the number reads high; the upgrade path is documented above.
- `Orders.GrossProfit` availability is unverified against a live sandbox and is probed at
  runtime rather than assumed.
