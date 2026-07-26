# Shared list-report: `ListReport` + `useListSpec`

Date: 2026-07-26
Branch: `claude/configurator-ui-improvements-4zjskv`

## Problem

`apps/web/src/components/EntityListPage.tsx` (393 lines) is the Fiori list-report floorplan —
DynamicPage + VariantManagement + FilterBar + AnalyticalTable + column picker + width persistence —
but it is reachable only from the B1 autodiscovery route (`_authed/_entities/$entity.tsx`).

`ModelsPage.tsx` and `ConfigsPage.tsx` each hand-roll a plain `<Table>` with fixed columns, no saved
views, no filter bar, no column personalization, and no server-shaped sorting. Users get two visibly
different list experiences in the same app.

## Goal

One list-report used by all three pages. Models and configs gain saved views, the filter bar, the
column picker, resize persistence, and multi-select bulk delete.

## Non-goals

- Server-side pagination for models/configs. Those endpoints return whole arrays; keep it that way.
- Changing the OData compilation path for B1 entities.
- Touching the object (detail) pages or `ObjectVariantDef`.
- Multi-column sort. Still single-column (the existing `// ponytail:` note in `EntityListPage` stands).

## Key constraint discovered

`EntityListPage` is coupled to B1 in exactly three places:

1. `entities.getEnabled` → `{name, keys, properties[]}` (columns + key field)
2. `entities.list` → server-paginated rows via `useInfiniteQuery`
3. row click → `navigate({ to: "/$entity/$id" })`

Everything else is source-agnostic. The migration is therefore a **state/chrome split**, not a rewrite.

## Architecture

**The spec is the query in both worlds.** A `ListVariantDef` (`select`/`filter`/`orderby`/`search`/
`filterBar`/`widths`/`labels`) already exists in `packages/db/src/schema/variant.ts`. For B1 it compiles
to OData `$select`/`$filter`/`$orderby`. For models/configs the identical `FilterCond[]` runs through a
new `applySpec(rows, spec)` over the in-memory array.

Consequence: `manualSortBy` / `manualFilters` / `manualGlobalFilter` stay `true` for **every** caller.
There is no client/server mode branch inside the table, and saved views behave identically everywhere.

### Ownership

- `useListSpec(entity)` — owns variant + live-spec state. Returned to the page.
- The **page** runs its own query using that spec (infinite for B1, plain `useQuery` + `applySpec` for local).
- `ListReport` — renders the floorplan from `spec` + `rows`. Controlled-component shape; no data fetching.

This keeps the fetch in the page (where the endpoint, its auth level, and its invalidation live) and the
chrome in one component, without render-props-that-run-hooks.

## Files

| File | Change |
| --- | --- |
| `apps/web/src/variants.ts` | **+** `useListSpec`, `applySpec`, `formatCell` |
| `apps/web/src/components/ListReport.tsx` | **new** — floorplan, moved from `EntityListPage` |
| `apps/web/src/components/EntityListPage.tsx` | 393 → ~70 lines |
| `apps/web/src/components/configurator/ModelsPage.tsx` | drop `<Table>`, keep New dialog |
| `apps/web/src/components/configurator/ConfigsPage.tsx` | drop `<Table>` + `SegmentedButton`, keep New dialog |
| `apps/web/src/variants.test.ts` | **new** — `applySpec` coverage |
| `apps/server/src/orpc/routers/variants.ts` | **+** `ensureConfiguratorVariants` |
| `apps/server/src/auth.ts` | **+** `organizationHooks.afterCreateOrganization` |
| `scripts/seed-standard.ts` | **new** — backfill (npm script `seed:standard` already declared, file missing) |
| `package.json` | **+** `"test:web": "bun test apps/web"` |

Routes (`routes/_authed/models/index.tsx`, `routes/_authed/configs/index.tsx`) are unchanged — they
already just mount the page components.

## Interfaces

### `useListSpec(entity: string)`

Moves out of `EntityListPage`: the `useVariants` call, `liveSpec`/`selectedName` state, the
default-view init effect, `dirty`, `applyVariant`, `setCond`, and the save/rename/delete handlers.

```ts
function useListSpec(entity: string): {
  spec: ListVariantDef;          // never null — see Fallback below
  setSpec: (fn: (s: ListVariantDef) => ListVariantDef) => void;
  setCond: (field: string, op: FilterOp, value: FilterCond["value"] | "") => void;
  ready: boolean;                // variants loaded and a view applied — gate the page's query on this
  variants: Variant[];
  selectedName: string;
  applyVariant: (name: string) => void;
  dirty: boolean;
  isAdmin: boolean;
  save; remove; setWidths;       // the mutations from useVariants
}
```

**Fallback (new).** `EntityListPage.tsx:112` currently returns `<BusyIndicator active />` forever when
no variant exists for the entity. `useListSpec` instead falls back to an in-memory
`{ select: [], filter: [], orderby: [], filterBar: [] }` once variants have loaded and none is present.
A missed seed then degrades to a usable page with an unnamed view (the user can Save As), not a hang.
This also closes the same latent hang for any B1 entity enabled before `ensureStandardVariants` existed.

`ready` stays false until variants have loaded, and pages gate their query on it (`enabled: ready`).
Without that gate the fallback spec would fire one query, then the real default view would fire a
second — visible as a double fetch on every page load.

### `applySpec(rows, spec, columns)`

```ts
function applySpec<T extends Record<string, unknown>>(
  rows: T[], spec: ListVariantDef, columns: ListColumn[],
): T[]
```

- `filter`: AND-combined. Supports every `FilterOp` (`eq`, `ne`, `contains`, `startswith`, `gt`, `ge`,
  `lt`, `le`). `contains`/`startswith` are case-insensitive on the stringified value, matching the
  server's OData `contains()` semantics closely enough for local arrays.
- `search`: case-insensitive substring across string-typed columns only (mirrors the server's `q`).
- `orderby`: single field; numbers compare numerically, dates by timestamp, otherwise `localeCompare`.
- Returns a new array. Never mutates the query cache's data.

### `formatCell(value, type)`

Replaces `EntityListPage.tsx:16`'s `cell()`. Same behavior for strings/numbers/objects, but a
date-typed value renders `toLocaleString()` instead of `String(v)` (today a `Date` prints as
`"Mon Jul 20 2026 10:33:21 GMT+0200 (Central European Summer Time)"`).

### `ListColumn`

Extends the existing B1 `{name, type}` property shape with three optional fields:

```ts
type ListColumn = {
  name: string;
  type: string;                                  // "Edm.String" | "string" | "date" | "number" | "boolean"
  label?: string;                                // human header; variant `labels` still overrides
  options?: { value: string; text: string }[];   // renders a Select in the FilterBar
  Cell?: ComponentType<{ value: unknown; row: { original: Record<string, unknown> } }>;
};
```

B1 pages pass `schema.properties` unchanged. `options` is how config `status` folds into the FilterBar;
`Cell` is how it still renders as an `ObjectStatus`. Both must be memoized (AnalyticalTable requirement).

### `ListReport` props

```ts
type ListReportProps = {
  listSpec: ReturnType<typeof useListSpec>;
  title: string;                                 // "Configurations"
  columns: ListColumn[];
  keyField: string;                              // "id" | "CardCode"
  rows: Record<string, unknown>[];
  total: number;                                 // B1: `count` from the first page (server-side total).
                                                 // Local: rows.length AFTER applySpec, so the count bar
                                                 // reflects the filter in both modes.
  loading: boolean;
  error?: Error | null;
  hasMore?: boolean;
  onLoadMore?: () => void;
  onRowClick: (row: Record<string, unknown>) => void;
  actions?: ReactNode;                                        // DynamicPageTitle actionsBar
  onDelete?: (rows: Record<string, unknown>[]) => Promise<void> | void;
  noData?: (reason: "Empty" | "Filtered") => ReactNode;
};
```

## Selection and bulk delete

`selectionMode="Multiple"` is already set. `onRowSelect`'s detail carries both `selectedRowIds` and
`rowsById`, so selected rows resolve to their original records without the `dataset.id`-off-the-DOM
reads in `ModelsPage.tsx:81` and `ConfigsPage.tsx:96`.

When `onDelete` is supplied, `ListReport` renders a Delete button in the existing count bar next to
Columns, disabled while nothing is selected. On click it awaits `onDelete(selected)` and then clears
selection by setting the controlled `selectedRowIds` state to a fresh `{}`.

Confirm dialog (`components/confirm.ts`) and toast stay in each page — `ListReport` never learns what a
model or a configuration is.

`// ponytail: one bulk action; swap for a render-prop slot if a second one ever lands.`

## Empty states

`AnalyticalTable` has no `noData` slot (that is `Table`'s API). It takes `NoDataComponent`, which
receives `noDataReason: "Empty" | "Filtered"`. `ListReport` wraps the `noData` prop in a memoized
component and passes the reason through. This generalizes `ConfigsPage.tsx:89-93`'s two-message case
("No configurations yet" vs "Nothing in this view") to every list.

## Status filter (replaces the SegmentedButton)

`ConfigsPage`'s `SegmentedButton` (All / Requested / In progress / Quoted / Rejected) is removed.
`status` becomes a normal column with `options` derived from `statusUi` in
`components/configurator/runView.ts`, so it appears in the FilterBar and is saved inside views.

The `rank()` requested-floats-to-top sort (`ConfigsPage.tsx:50`) becomes the seeded `Requested` view's
`orderby`. The `Requested (n)` / `Rejected (n)` count badges are dropped — the accepted trade for
folding status into views.

## Seeding

Three views per configurator entity are needed. `ensureConfiguratorVariants(tenantId, userId)` in
`routers/variants.ts` calls the existing idempotent `ensureStandardVariants` for `"models"` and
`"configs"`, then inserts one more if absent:

| entity | name | shared | isDefault | definition |
| --- | --- | --- | --- | --- |
| `models` | Standard | yes | yes | `{select:[],filter:[],orderby:[],filterBar:[]}` |
| `configs` | Standard | yes | yes | `{select:[],filter:[],orderby:[],filterBar:[]}` |
| `configs` | Requested | yes | no | `{select:[],filter:[{field:"status",op:"eq",value:"requested"}],orderby:[{field:"updatedAt",dir:"desc"}],filterBar:["status"]}` |

`ui_variant.entity` is plain `text` with no FK and no validation against enabled B1 entities
(`schema/variant.ts:57`), so `"models"` and `"configs"` are legal keys with no schema migration.

Two call sites:

- **Existing tenants** — `scripts/seed-standard.ts`, iterating every organization. `package.json:31`
  already declares `"seed:standard": "bun scripts/seed-standard.ts"`; the file was never written, so
  that command is currently broken. Follows the style of `scripts/seed-agent.ts` (direct `db` import,
  no server needed). Also backfills `ensureStandardVariants` for enabled B1 entities.
- **New tenants** — `organizationHooks.afterCreateOrganization` on the `organization()` plugin in
  `apps/server/src/auth.ts:28`. Verified present in better-auth 1.6.19; the callback receives
  `{ organization, member, user }`, and `base.ts:31` confirms `tenantId === organization.id`.
  Without this, every tenant created after this change ships with no views. The `useListSpec` fallback
  keeps that from being fatal, but the hook is what makes it correct.

Each org needs a `userId` for the variant's owner column; the script uses the org's owner member.

## Testing

`apps/web/src/variants.test.ts` (bun test, matching the `*.test.ts` convention already in
`components/configurator/`) covers `applySpec`:

- each `FilterOp` against a fixture array
- multiple conditions AND-combined
- `orderby` asc and desc, over string, number and date columns
- `search` matching string columns only, case-insensitively
- empty spec returns every row, unmutated (input array identity preserved)

`applySpec` is the only non-trivial new logic; the rest is moved JSX. `bun test apps/web` currently
passes (30 tests / 5 files) but has no npm script, so add `"test:web": "bun test apps/web"` alongside
the existing `test:engine` and `test:server`.

Manual check after implementation: `bun run dev`, open `acme.lvh.me:5173/models` and `/configs` —
verify Save As creates a view, filters persist into it, column resize survives reload, multi-select
Delete removes rows and clears selection, and that `/`-routed B1 entity lists still behave unchanged.

## Fixes carried along

| Where | Issue |
| --- | --- |
| `ModelsPage.tsx:81`, `ConfigsPage.tsx:96` | row id read from `dataset.id` on the DOM node → `row.original` |
| `EntityListPage.tsx:16` | `Date` rendered via `String(v)` → `formatCell` by type |
| `EntityListPage.tsx:112` | no variants ⇒ permanent spinner → fallback spec |
| `ModelsPage.tsx:56`, `ConfigsPage.tsx:55` | `isPending` returns before `DynamicPage`, flashing the whole title bar out on refetch → render chrome, pass `loading` to the table |
| `ConfigsPage.tsx:89-93` | bespoke two-message empty state → generic `NoDataComponent` + `noDataReason` |
| `package.json:31` | `seed:standard` pointed at a nonexistent file |

Knowingly left alone: `EntityListPage.tsx:296` binds `onColumnResizeEnd` to `onPointerUp` on the whole
Card, so every click schedules a `setTimeout(0)`. It is deduped by `sameDef` against `lastWidthsRef` and
costs nothing measurable. Revisit if a real resize event lands in the AnalyticalTable API.
