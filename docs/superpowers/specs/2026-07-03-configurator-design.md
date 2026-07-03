# HERA Product Configurator — Design Spec (2026-07-03)

## Context

HERA's backbone (auth → tenancy → agent bridge → B1 sync) is proven. This milestone adds the CPQ core: a **Teamcenter-concept product configurator** — parameters with domains, constraint propagation, a formula layer, 150% BOM + routing outputs with calculated quantities/times/costs — plus a **model builder** for admins and a **configuration process** page that ends in a real B1 Sales Quotation. Emphasis: solid engine design + exceptional UI/UX (UI5 Web Components, verified against @ui5/webcomponents-react 2.23).

Designed from scratch per user instruction; dead config-engine remnants (broken `@hera/config-engine` symlink, orphan migrations `config_*` in `packages/db/drizzle/`, `mdResolveKey` in `apps/web/src/orpc.ts`) are ignored and must be cleaned up during implementation.

## Decisions (settled in brainstorming)

| Axis | Decision |
|---|---|
| Engine core | Hybrid: live constraint propagation over finite domains + formula dependency DAG |
| Rule authoring | One expression DSL everywhere + combination tables (allow/forbid rows) for compatibility constraints |
| Outputs | 150% BOM + 150% routing: superset lines/ops with condition + formulas, filtered per configuration |
| Data sources | Unified lookup concept: Manual list \| DB table \| Query (agent-backed GET to **B1 and Beas**, both in v1) |
| B1 output | Sales Quotation only (one line per selected candidate); BOM/routing stay in HERA as costing evidence |
| Lifecycle | Mutable model + immutable **snapshot-on-run** (model + lookups + outputs frozen per engine run) |
| Enumeration | Valid completions of **open parameters × batches**, hard cap (default 200) |
| Process anchor | New "Configurations" document (project): customer + model + entries + batches + runs → one B1 quotation |
| Placement | Isomorphic pure-TS `packages/config-engine`: browser = live preview, server = authoritative runs |

## Architecture

```
packages/config-engine   pure TS + zod only; no I/O
apps/server              routers: models (admin), configs (user); lookup resolution; snapshots
apps/agent               new request kinds: query.fetch (b1|beas GET), quote.create (Quotations POST)
apps/web                 routes: models/, models/$id (builder), configs/, configs/$id (wizard)
packages/db              schema/configurator.ts: config_model, config_table, config_project, config_run
```

Trust model mirrors the existing platform: client computes previews, server computes the numbers that get stored/quoted. Client never talks to the agent; Query lookups ride the existing `agent_request` + `runRequest` request/reply bridge (`apps/server/src/orpc/routers/entities.ts` helpers).

## packages/config-engine

Files (all pure functions; zod for schemas):

- `model.ts` — `ModelDefZ` (whole model = one JSON doc) exported like `ListVariantDefZ` in `packages/db/src/schema/variant.ts`. Shape:
  - `parameters[]`: `{ key, label, type: "string"|"number"|"boolean", ui: "input"|"select"|"radio"|"checkbox"|"multicombo"|"step", domain?: LookupRef | {min,max,step}, defaultExpr?, visibleWhen?, requiredWhen?, unit?, help? }`
  - `structure`: `sections[] → groups[] → paramKeys[]` (ordering lives here)
  - `computed[]`: `{ key, expr }` (derived values; topo-sorted, cycles rejected at save)
  - `constraints[]`: `{ kind:"expr", when?, assert, message }` | `{ kind:"table", params[], rows[][], mode:"allow"|"forbid" }`
  - `bom[]`: `{ id, item: {code,desc} | LookupRef, condition?, qtyExpr, price: number | LookupRef | expr, scrapPct? }`
  - `routing[]`: `{ id, resource: string | LookupRef, condition?, setupExpr, runPerUnitExpr, rate: number | LookupRef | expr }`
  - `pricing`: `{ marginExpr, quoteItemCode }` (B1 item code used on quotation lines), `batchDefaults: number[]`
  - `LookupRef`: `{ source:"manual", values[] } | { source:"table", tableId, keyCol, valueCol?, labelCol?, extraCols? } | { source:"query", target:"b1"|"beas", path, valueField, labelField?, extraFields? }`
- `dsl/` — tokenizer + Pratt parser + evaluator, hand-rolled, zero deps. Values `number|string|boolean|null`; ops arith/compare/`&&`/`||`/`!`/ternary; functions `IF MIN MAX ROUND CEIL FLOOR ABS CONCAT LOOKUP(table,keyCol,key,valueCol)`. All errors carry `{from,to,message}` spans.
- `check.ts` — `checkModel(model)`: parse all exprs, unknown-ref detection, computed-cycle detection. Used by builder (squiggles) and server (save gate).
- `propagate.ts` — `propagate(model, lookups, entries)` → `{ domains: Map<key, {value, eliminatedBy?}[]>, values (computed params, topo-order), conflicts[], openParams[], candidateEstimate }`. Fixpoint filtering: table constraints propagate exactly (row filter + project); expr constraints propagate with ≤2 unbound inputs, validate-only otherwise. `// ponytail: bounded propagation, full GAC if real models demand it`
- `enumerate.ts` — DFS + propagation over open finite-domain params; hard cap (default 200); on cap overflow returns partial + `widestOpenParam`.
- `output.ts` — `computeOutputs(model, lookups, assignment, batchQty)` → `{ bomLines[], ops[], materialCost, laborCost, unitCost, unitPrice, total }`. Setup cost amortized: `(setup/batchQty + runPerUnit) × rate`. Scrap applied to qty. Margin via `pricing.marginExpr`.

## Data model (`packages/db/src/schema/configurator.ts`)

House style: `uuid` PK `defaultRandom()`, `tenant_id text` (no FK), timestamps `withTimezone`, leading-tenant indexes.

- `config_model`: `id, tenant_id, name, definition jsonb (ModelDef), created_at, updated_at`. Index `(tenant_id)`.
- `config_table`: `id, tenant_id, name, columns jsonb ({key,label,type}[]), rows jsonb (values[][]) , updated_at`. `// ponytail: jsonb rows; real table if >10k rows`
- `config_project`: `id, tenant_id, model_id, name, customer jsonb ({cardCode,cardName}?), status text enum draft|calculated|quoted, entries jsonb, batches jsonb (number[]), created_by, created_at, updated_at`. Index `(tenant_id, status)`.
- `config_run`: `id, tenant_id, project_id, model_snapshot jsonb, lookup_snapshot jsonb, entries jsonb, candidates jsonb ({assignment, perBatch: {batchQty, outputs}[]}[]), selection jsonb ({candidateIdx, batchQty, overrides}[] | null), b1_doc_entry int?, quoted_at?, created_at`. Index `(tenant_id, project_id)`.

## Server (`apps/server/src/orpc/routers/`)

- `models.ts` (adminProcedure): `list/get/save/remove` for models (save runs `checkModel`, rejects with span errors); `tables.list/save/remove`; `lookupPreview` (resolve any LookupRef, return first N rows — powers the builder's Preview button).
- `configs.ts` (userProcedure): `list/get/create/update/remove` projects; `run`: resolve all lookups (Query via `runRequest` `query.fetch`; ~5-min in-memory cache for interactive use, **always fresh at run time**), execute `enumerate` + `computeOutputs` per candidate × batch, insert `config_run` snapshot, flip project to `calculated`; `select` (store selection + overrides, recompute totals server-side); `createQuote`: build Quotations payload (one line per selected candidate: item/free-text description of assignment, batch qty, computed unit price), enqueue `quote.create` with `dedupKey = runId + hash(selection)`, park until fulfilled, store `b1_doc_entry`, flip to `quoted`. Quotation lines use `pricing.quoteItemCode` with the candidate's assignment serialized into the line description.
- Register both in `router.ts`.

## Agent (`apps/agent/src/`)

- `query.fetch` kind: `{ target: "b1"|"beas", path }` → GET via `ServiceLayerClient` (b1) or new thin `BeasClient` (base URL + auth from agent `.env` — credentials never in cloud DB, same rule as B1).
- `quote.create` kind: POST `/Quotations` with `NumAtCard = "HERA-" + shortRunId`. Retry discipline identical to BP flow: attempts==1 → POST; attempts>1 → GET filter by NumAtCard, ack if found. `// ponytail: NumAtCard anchor; U_CpqExtId UDF when real docs need it`

## Web (`apps/web/src/routes/_authed/`)

New nav items (SideNavigation in `AppShell.tsx`): **Configurator Models** (admin), **Configurations**.

### Model builder — `models/$id`
`DynamicPage` → `SplitterLayout`: **editor left, live preview right**. Preview renders the same `ConfiguratorForm` component the wizard uses, bound to the unsaved draft with client-side `propagate()` — instant test-drive of every edit.

Editor = `TabContainer`:
- **Parameters**: single UI5 `Table`, section/group/param hierarchy as indented rows; native drag-reorder + re-parent via `TableRow movable` + `onMoveOver`/`onMove`; `TableRowAction` edit/delete. Param edit `Dialog`: key/label/type/ui element/domain source (Manual editor | Table picker + column map | Query target+path+field map with **Preview** via `models.lookupPreview`) /default/visible/required exprs.
- **Rules**: expression constraints (condition + message) + combination tables (pick params → allow/forbid grid dialog).
- **BOM**: 150% lines — item (ValueHelp from lookup), condition, qtyExpr, price source, scrap%.
- **Routing**: resource, condition, setupExpr, runPerUnitExpr, rate source.
- **Tables**: `config_table` designer (columns + grid, clipboard paste).

Shared **`ExprInput`**: monospace input, parse-on-change against draft model, `valueState=Negative` + span-accurate message, param-key/function suggestion `Popover`. Save blocked while invalid; header `MessageView` aggregates errors and jumps to fields. `// ponytail: suggestions list keys; semantic autocomplete later`

### Configuration process — `configs/$id`
`Wizard` (MultipleSteps, height-constrained container), 5 steps:
1. **Configure** — model rendered as `ObjectPageSection → FormGroup → FormItem`; live propagation: eliminated options disabled with tooltip naming the constraint; visible auto-defaults; computed params as live read-only fields; sticky status bar `✓ consistent · 3 open · ~24 candidates`.
2. **Batches** — `Token` list + `StepInput`, prefilled from model defaults.
3. **Candidates** — after `configs.run`: matrix rows=candidates (labeled by open-param values), cols=batches, cells=unit price, per-column best highlighted; multi-select; row detail panel: cost breakdown (material/labor/margin), price-vs-batch `LineChart`, read-only BOM/routing.
4. **Review outputs** — per selected candidate: editable BOM/routing tables (qty/time overrides, add/remove, `ObjectStatus` "edited"), totals recomputed live client-side; overrides → `configs.select`.
5. **Create quote** — summary cards, customer picker (BP via existing `entities.list`), Create in SAP B1 → progress → DocNum shown; project `quoted`.

`configs/` and `models/` lists: plain `DynamicPage` + `Table` + status. `// ponytail: no VariantManagement on local lists yet`

## Error handling

- DSL errors blocked at save (client + server `checkModel`); can't reach runtime.
- Agent offline → existing `assertAgentReady` message shape.
- Lookup fetch failure → names source + path, retry action.
- Enumeration cap → "stopped at 200 — leave fewer parameters open (X is widest with N values)".
- Quote creation idempotent (dedupKey + NumAtCard GET-before-POST); duplicate physically impossible, same guarantee as backbone.

## Testing / Verification

- `bun test` in `packages/config-engine`: parser goldens incl. error spans; propagation fixtures (table + expr constraints); enumeration (cap, completeness on small models); output math vs hand-computed fixtures (batch amortization, scrap, margin).
- Server integration test: project → run → snapshot persisted → createQuote enqueues with stable dedupKey.
- Manual e2e: seed a demo model (e.g. cable assembly: material × cross-section × coating, 2 constraints, 1 combination table, 5 BOM lines, 3 ops), run `bun dev`, walk builder live-preview loop, then wizard through to a real B1 Quotation in the sandbox; verify retry produces no duplicate (kill agent mid-POST).
- Cleanup check: dead `@hera/config-engine` references removed; `bun install && bun run build` green.

## Implementation phases

1. **Engine** — package skeleton, ModelDefZ, DSL, check, propagate, enumerate, output + full test suite. (Pure; no app changes.)
2. **Persistence + server** — schema + migration, models/configs routers, lookup resolution, agent `query.fetch`.
3. **Builder UI** — tabs, drag-drop hierarchy, ExprInput, live preview, tables designer.
4. **Process UI** — wizard steps 1–4 (through review) with client propagation.
5. **B1 quote** — `quote.create` agent kind, step 5, idempotency verification against sandbox.

## Out of scope (explicit)

Draft/publish model versions; writing production BOMs/routings to B1/Beas; full GAC propagation; semantic autocomplete; VariantManagement on configurator lists; n8n/automation. Each has a marked upgrade path.
