# Configurator Process UI Implementation Plan (Phase 4 of Configurator)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The "Configurations" user flow — list page plus the 5-step wizard (Configure → Batches → Candidates → Review outputs → Create quote) with steps 1–4 live and step 5 a disabled placeholder — spec phase 4 ("Process UI") of `docs/superpowers/specs/2026-07-03-configurator-design.md`. Phases 1–3 (engine, persistence + server, builder UI) are done on this branch.

**Architecture:** Pure web-app phase: no server, agent, db, or engine changes. The wizard reuses the phase-3 `ConfiguratorForm` (live client-side `propagate`) for step 1; steps 3–4 render **only** from the immutable run snapshot (`latestRun.modelSnapshot` / `lookupSnapshot` / `candidates`) so what the user reviews is exactly what the server computed. Local state overlays server state (`override ?? server value`); `configs.update` persists entries/batches **before** `configs.run` because `executeRun` reads them from the DB, and `configs.select` recomputes totals server-side — client numbers are never persisted. A small pure-helper module (`runView.ts`) carries all testable logic (candidate labels, best-price-per-column, cell selection toggling, override editing) with bun tests.

**Tech Stack:** React 19, UI5 Web Components React 2.23 (components verified against the 2.23.2 API via the UI5 MCP), TanStack Router (file-based) + TanStack Query + oRPC client, `@hera/config-engine` (browser side), bun test. **No new dependencies.**

**Design stance (frontend-design):** The visual system is fixed — Fiori themes, user-switchable in the shell — so the design investment goes into interaction and information design. The signature element is the **candidates price matrix**: rows are candidates labeled by their open-parameter values, columns are batch quantities, every cell is a price that is *itself the selection control* (a `ToggleButton`), and the lowest price per column is highlighted. The matrix visually **is** the `RunSelection[]` data shape — one selected cell = one future quotation line. Copy: sentence case, verbs name outcomes and stay consistent through the flow ("Calculate", "Review selection (n)", "Save selection").

## Global Constraints

- Repo root: `/home/benataz02/dev/hera`. Run all commands from there. Commit after every task (style: `feat(web): …`, matching `git log`).
- **No new dependencies.** Deliberate divergence from the spec sketch: the price-vs-batch chart is an inline SVG micro-chart (≤ ~6 points), not `@ui5/webcomponents-react-charts` `LineChart` — the charts package's own docs warn "custom-built **without** defined design specifications … especially accessibility may not meet standard app requirements", and it would drag recharts in for one tiny curve. Marked `// ponytail:` with the swap path. Do not "fix" this by adding the package.
- The engine/server **as built** is the source of truth where the spec sketch differs. Exact shapes tasks rely on:
  - `propagate(model, lookups, entries)` → `{ domains: Record<key, DomainOption[]>, values: Record<key, Val>, visible: Record<key, boolean>, defaulted: Set<string>, conflicts: {message: string}[], open: string[], candidateEstimate: number }`.
  - `computeOutputs(model, lookups, assignment, batchQty, overrides?)` → `Outputs = { bom: BomResult[], ops: OpResult[], materialPerUnit, laborPerUnit, unitCost, unitPrice, batchTotal }`; `BomResult = { id, itemCode, desc, qtyPerUnit, totalQty, unitPrice, lineTotal }`; `OpResult = { id, resource, setupMin, runMinPerUnit, totalMin, cost }` (note: **no** `ratePerHour` on `OpResult` — derive `rate = cost * 60 / totalMin`). Throws `DslError`/`RangeError` on bad data — wrap render-time calls in try/catch.
  - `OutputOverrides = { bom?: {id, qtyPerUnit?, unitPrice?, remove?}[], ops?: {id, setupMin?, runMinPerUnit?, ratePerHour?, remove?}[], addBom?: {id, itemCode, desc?, qtyPerUnit, unitPrice}[], addOps?: {id, resource, setupMin, runMinPerUnit, ratePerHour}[] }`.
  - Step-1 form renders `Panel → Form → FormGroup` (as `ConfiguratorForm` shipped in phase 3), not the spec's ObjectPageSection sketch.
- Server API (all `orpc.configs.*`, `userProcedure`, already implemented — **do not modify `apps/server`**):
  - `models` → `{id, name}[]` · `list` → `{id, name, status, customer, modelName, updatedAt}[]` · `get {id}` → `{ project, model: {id, name, definition, updatedAt}, latestRun | null }` where run rows carry `{ id, modelSnapshot: ModelDef, lookupSnapshot: ResolvedLookups, entries: Entries, candidates: {assignment: Entries, perBatch: {batchQty, outputs: Outputs}[]}[], selection: {candidateIdx, batchQty, overrides?}[] | null }`.
  - `create {modelId, name}` → `{id}` (batches prefilled from the model's `batchDefaults` server-side) · `update {id, name?, customer?, entries?, batches?}` (sending entries/batches flips status back to `draft`) · `remove {id}`.
  - `lookups {modelId}` → `ResolvedLookups` (server-cached ~5 min; needs the agent only when the model uses query sources — error message comes from `assertAgentReady`, show it verbatim with a Retry).
  - `run {projectId}` → `{runId, candidateCount, capped, widest?: {key, size}}` — reads entries/batches **from the DB**, so persist local edits via `update` first. Errors are `BAD_REQUEST` with speakable messages ("Configuration has conflicts: …", "Add at least one batch quantity").
  - `select {runId, selection}` (min 1 entry) → recomputes and stores server-side.
- `apps/web` does **not** depend on `@hera/db`: mirror `RunCandidate`/`RunSelection` structurally in `runView.ts` (`Candidate`, `Sel`).
- Web house style (match phase-3 files): double quotes, 2-space indent, function components, inline `style={{}}`, `orpc.X.queryOptions()/mutationOptions()`, dates over the wire are strings (`new Date(x).toLocaleString()`), UI5 typing gaps patched via `data-*` + `dataset` (see `ModelsPage` Select/row patterns).
- UI5 components verified against 2.23.2 via MCP: `Wizard` (`contentLayout="MultipleSteps"`, needs a height-constrained parent, steps advance by setting `selected` on `WizardStep`, `onStepChange` detail `{step, previousStep, withScroll}`), `Tokenizer`/`Token` (`onTokenDelete` detail `{tokens: Token[]}`), `ToggleButton` (`pressed`, `design`), `Table`/`TableRow rowKey`/`TableRowAction`. Number formatting: `fmt()` helper (locale, ≤2 decimals) — no currency symbol, models don't carry a currency.
- Copy rules: sentence case everywhere; actions keep their names through the flow: **Calculate** (step 2), **Review selection (n)** (step 3), **Save selection** (step 4). Errors state what happened and what to do next; empty states invite the action.

## File Structure

```
apps/web/src/components/configurator/
  runView.ts            CREATE  pure helpers: labels, best-per-batch, selection toggle, override edits, fmt, statusUi
  runView.test.ts       CREATE  bun tests for every helper
  ConfigsPage.tsx       CREATE  configurations list (mirrors ModelsPage)
  ConfigProcessPage.tsx CREATE  wizard shell: data loading, step gating, mutations, state overlays
  StepConfigure.tsx     CREATE  step 1: ConfiguratorForm + lookups pending/error + next
  StepBatches.tsx       CREATE  step 2: Tokenizer + StepInput + Calculate
  StepCandidates.tsx    CREATE  step 3: price matrix + cap warning + detail toggle
  CandidateDetail.tsx   CREATE  breakdown, SVG price curve, read-only BOM/ops
  StepReview.tsx        CREATE  step 4: editable BOM/ops with overrides, live totals, Save selection
apps/web/src/routes/_authed/configs/
  index.tsx             CREATE  route → ConfigsPage
  $id.tsx               CREATE  route → ConfigProcessPage
apps/web/src/components/AppShell.tsx   MODIFY  add "Configurations" nav item (all members)
```

---

### Task 1: Run-view helpers (pure, TDD)

**Files:**
- Create: `apps/web/src/components/configurator/runView.ts`
- Test: `apps/web/src/components/configurator/runView.test.ts`

**Interfaces:**
- Consumes: `Entries`, `ModelDef`, `Outputs`, `OutputOverrides` types from `@hera/config-engine`.
- Produces (used by Tasks 2–6, exact signatures):
  - `type Candidate = { assignment: Entries; perBatch: { batchQty: number; outputs: Outputs }[] }`
  - `type Sel = { candidateIdx: number; batchQty: number; overrides?: OutputOverrides }`
  - `fmt(n: number): string` · `statusUi: Record<"draft"|"calculated"|"quoted", {state, text}>`
  - `openKeys(model: ModelDef, runEntries: Entries, candidates: Candidate[]): string[]`
  - `candidateLabel(keys: string[], assignment: Entries): string`
  - `bestByBatch(candidates: Candidate[]): Record<number, number>`
  - `isSelected(sel: Sel[], candidateIdx: number, batchQty: number): boolean`
  - `toggleSelection(sel: Sel[], candidateIdx: number, batchQty: number): Sel[]`
  - `patchBom / patchOp (ov, id, patch): OutputOverrides` · `resetLine(ov, "bom"|"ops", id)` · `isEdited(ov, "bom"|"ops", id)` · `isRemoved(ov, "bom"|"ops", id)`
  - `addBomLine(ov) / addOpLine(ov)` · `patchAddedBom / patchAddedOp (ov, id, patch)` · `removeAddedBom / removeAddedOp (ov, id)`
  - `withoutRemovals(ov?): OutputOverrides | undefined` · `cleanOverrides(ov?): OutputOverrides | undefined`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/configurator/runView.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { ModelDef, Outputs } from "@hera/config-engine";
import {
  bestByBatch, candidateLabel, cleanOverrides, isEdited, isRemoved, isSelected, openKeys,
  patchBom, resetLine, toggleSelection, withoutRemovals, type Candidate, type Sel,
} from "./runView.ts";

const param = (key: string) => ({ key, label: key, type: "string" as const, ui: "select" as const });
const model: ModelDef = {
  name: "m", computed: [], constraints: [], bom: [], routing: [], queryTables: [],
  structure: { sections: [] }, pricing: { priceExpr: "0", quoteItemCode: "X" }, batchDefaults: [1],
  parameters: [param("material"), param("size"), param("coating")],
};
const out = (unitPrice: number): Outputs =>
  ({ bom: [], ops: [], materialPerUnit: 0, laborPerUnit: 0, unitCost: 0, unitPrice, batchTotal: unitPrice });
const cands: Candidate[] = [
  { assignment: { size: 1, material: "steel" }, perBatch: [{ batchQty: 10, outputs: out(5) }, { batchQty: 100, outputs: out(3) }] },
  { assignment: { size: 1, material: "alu" }, perBatch: [{ batchQty: 10, outputs: out(4) }, { batchQty: 100, outputs: out(3.5) }] },
];

describe("openKeys / candidateLabel", () => {
  test("excludes params fixed in the run's entries", () => {
    expect(openKeys(model, { size: 1 }, cands)).toEqual(["material"]);
  });
  test("orders by model parameter order, not assignment key order", () => {
    expect(openKeys(model, {}, cands)).toEqual(["material", "size"]);
  });
  test("label joins open values with a dot separator", () => {
    expect(candidateLabel(["material", "size"], cands[0]!.assignment)).toBe("steel · 1");
    expect(candidateLabel([], cands[0]!.assignment)).toBe("Configuration");
  });
});

describe("bestByBatch", () => {
  test("lowest unit price per batch column wins", () => {
    expect(bestByBatch(cands)).toEqual({ 10: 1, 100: 0 });
  });
});

describe("selection toggling", () => {
  test("toggle adds, toggles off only the exact cell, preserves other overrides", () => {
    let sel: Sel[] = [{ candidateIdx: 0, batchQty: 10, overrides: { bom: [{ id: "l1", qtyPerUnit: 2 }] } }];
    sel = toggleSelection(sel, 1, 10);
    expect(sel).toHaveLength(2);
    expect(isSelected(sel, 1, 10)).toBe(true);
    sel = toggleSelection(sel, 1, 10);
    expect(sel).toEqual([{ candidateIdx: 0, batchQty: 10, overrides: { bom: [{ id: "l1", qtyPerUnit: 2 }] } }]);
  });
});

describe("override editing", () => {
  test("patchBom creates the entry, then merges later patches", () => {
    let ov = patchBom({}, "l1", { qtyPerUnit: 3 });
    ov = patchBom(ov, "l1", { unitPrice: 9 });
    expect(ov.bom).toEqual([{ id: "l1", qtyPerUnit: 3, unitPrice: 9 }]);
    expect(isEdited(ov, "bom", "l1")).toBe(true);
    expect(isEdited(ov, "bom", "nope")).toBe(false);
  });
  test("resetLine drops the entry", () => {
    const ov = resetLine(patchBom({}, "l1", { qtyPerUnit: 3 }), "bom", "l1");
    expect(ov.bom).toEqual([]);
    expect(isEdited(ov, "bom", "l1")).toBe(false);
  });
  test("withoutRemovals strips remove flags but keeps value edits", () => {
    const ov = patchBom(patchBom({}, "l1", { remove: true }), "l2", { qtyPerUnit: 7 });
    expect(isRemoved(ov, "bom", "l1")).toBe(true);
    expect(withoutRemovals(ov)!.bom).toEqual([{ id: "l1" }, { id: "l2", qtyPerUnit: 7 }]);
  });
  test("cleanOverrides drops empty objects so payloads stay minimal", () => {
    expect(cleanOverrides({})).toBeUndefined();
    expect(cleanOverrides(undefined)).toBeUndefined();
    expect(cleanOverrides({ bom: [{ id: "l1", qtyPerUnit: 1 }] })).toEqual({ bom: [{ id: "l1", qtyPerUnit: 1 }] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/web/src/components/configurator/runView.test.ts`
Expected: FAIL — `Cannot find module './runView.ts'`.

- [ ] **Step 3: Write the implementation**

Create `apps/web/src/components/configurator/runView.ts`:

```ts
import type { Entries, ModelDef, OutputOverrides, Outputs } from "@hera/config-engine";

// Pure view logic for the configuration wizard. Client-side mirrors of the server's
// RunCandidate/RunSelection jsonb shapes (web doesn't depend on @hera/db; structural match).
export type Candidate = { assignment: Entries; perBatch: { batchQty: number; outputs: Outputs }[] };
export type Sel = { candidateIdx: number; batchQty: number; overrides?: OutputOverrides };

export const fmt = (n: number): string => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

export const statusUi = {
  draft: { state: "None", text: "Draft" },
  calculated: { state: "Information", text: "Calculated" },
  quoted: { state: "Positive", text: "Quoted" },
} as const;

// Params the run left open (assigned per candidate, not fixed in the run's entries),
// in model parameter order so labels are stable across candidates.
export function openKeys(model: ModelDef, runEntries: Entries, candidates: Candidate[]): string[] {
  const assigned = new Set<string>();
  for (const c of candidates) for (const k of Object.keys(c.assignment)) if (!(k in runEntries)) assigned.add(k);
  return model.parameters.map((p) => p.key).filter((k) => assigned.has(k));
}

export const candidateLabel = (keys: string[], assignment: Entries): string =>
  keys.length ? keys.map((k) => String(assignment[k] ?? "—")).join(" · ") : "Configuration";

// Lowest unit price per batch column -> candidate index (first wins on ties).
export function bestByBatch(candidates: Candidate[]): Record<number, number> {
  const best: Record<number, { idx: number; price: number }> = {};
  candidates.forEach((c, idx) => {
    for (const b of c.perBatch) {
      const cur = best[b.batchQty];
      if (!cur || b.outputs.unitPrice < cur.price) best[b.batchQty] = { idx, price: b.outputs.unitPrice };
    }
  });
  return Object.fromEntries(Object.entries(best).map(([q, v]) => [q, v.idx]));
}

export const isSelected = (sel: Sel[], candidateIdx: number, batchQty: number): boolean =>
  sel.some((s) => s.candidateIdx === candidateIdx && s.batchQty === batchQty);

export const toggleSelection = (sel: Sel[], candidateIdx: number, batchQty: number): Sel[] =>
  isSelected(sel, candidateIdx, batchQty)
    ? sel.filter((s) => !(s.candidateIdx === candidateIdx && s.batchQty === batchQty))
    : [...sel, { candidateIdx, batchQty }];

type BomOv = NonNullable<OutputOverrides["bom"]>[number];
type OpOv = NonNullable<OutputOverrides["ops"]>[number];
type AddedBom = NonNullable<OutputOverrides["addBom"]>[number];
type AddedOp = NonNullable<OutputOverrides["addOps"]>[number];

const upsert = <T extends { id: string }>(list: T[] | undefined, id: string, patch: Partial<T>): T[] => {
  const next = [...(list ?? [])];
  const i = next.findIndex((o) => o.id === id);
  if (i >= 0) next[i] = { ...next[i]!, ...patch };
  else next.push({ id, ...patch } as T);
  return next;
};

export const patchBom = (ov: OutputOverrides, id: string, patch: Partial<BomOv>): OutputOverrides =>
  ({ ...ov, bom: upsert(ov.bom, id, patch) });
export const patchOp = (ov: OutputOverrides, id: string, patch: Partial<OpOv>): OutputOverrides =>
  ({ ...ov, ops: upsert(ov.ops, id, patch) });
export const resetLine = (ov: OutputOverrides, kind: "bom" | "ops", id: string): OutputOverrides =>
  ({ ...ov, [kind]: (ov[kind] ?? []).filter((o) => o.id !== id) });
export const isEdited = (ov: OutputOverrides, kind: "bom" | "ops", id: string): boolean =>
  (ov[kind] ?? []).some((o) => o.id === id);
export const isRemoved = (ov: OutputOverrides, kind: "bom" | "ops", id: string): boolean =>
  (ov[kind] ?? []).some((o) => o.id === id && o.remove === true);

export const addBomLine = (ov: OutputOverrides): OutputOverrides =>
  ({ ...ov, addBom: [...(ov.addBom ?? []), { id: crypto.randomUUID(), itemCode: "NEW", qtyPerUnit: 1, unitPrice: 0 }] });
export const addOpLine = (ov: OutputOverrides): OutputOverrides =>
  ({ ...ov, addOps: [...(ov.addOps ?? []), { id: crypto.randomUUID(), resource: "NEW", setupMin: 0, runMinPerUnit: 0, ratePerHour: 0 }] });
export const patchAddedBom = (ov: OutputOverrides, id: string, patch: Partial<AddedBom>): OutputOverrides =>
  ({ ...ov, addBom: (ov.addBom ?? []).map((o) => (o.id === id ? { ...o, ...patch } : o)) });
export const patchAddedOp = (ov: OutputOverrides, id: string, patch: Partial<AddedOp>): OutputOverrides =>
  ({ ...ov, addOps: (ov.addOps ?? []).map((o) => (o.id === id ? { ...o, ...patch } : o)) });
export const removeAddedBom = (ov: OutputOverrides, id: string): OutputOverrides =>
  ({ ...ov, addBom: (ov.addBom ?? []).filter((o) => o.id !== id) });
export const removeAddedOp = (ov: OutputOverrides, id: string): OutputOverrides =>
  ({ ...ov, addOps: (ov.addOps ?? []).filter((o) => o.id !== id) });

// Same overrides with remove flags dropped: the display pass keeps removed rows visible
// (struck through) while the totals pass uses the full overrides.
export const withoutRemovals = (ov: OutputOverrides | undefined): OutputOverrides | undefined =>
  ov && {
    ...ov,
    bom: ov.bom?.map(({ remove: _remove, ...rest }) => rest),
    ops: ov.ops?.map(({ remove: _remove, ...rest }) => rest),
  };

export const cleanOverrides = (ov: OutputOverrides | undefined): OutputOverrides | undefined =>
  ov && (ov.bom?.length || ov.ops?.length || ov.addBom?.length || ov.addOps?.length) ? ov : undefined;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/web/src/components/configurator/runView.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/configurator/runView.ts apps/web/src/components/configurator/runView.test.ts
git commit -m "feat(web): run-view helpers for the configuration wizard"
```

---

### Task 2: Configurations list page, route, nav item

**Files:**
- Create: `apps/web/src/components/configurator/ConfigsPage.tsx`
- Create: `apps/web/src/routes/_authed/configs/index.tsx`
- Modify: `apps/web/src/components/AppShell.tsx` (nav items, around line 180–205)

**Interfaces:**
- Consumes: `orpc.configs.list / models / create / remove`; `statusUi` from Task 1.
- Produces: `/configs` route; "Configurations" nav for every member (not admin-gated — spec: any member drives a project).

- [ ] **Step 1: Create the list page**

Create `apps/web/src/components/configurator/ConfigsPage.tsx` (mirrors `ModelsPage.tsx` — keep the two visually parallel):

```tsx
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar, Button, BusyIndicator, Dialog, DynamicPage, DynamicPageTitle, Input, Label, MessageStrip,
  ObjectStatus, Option, Select, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow,
  TableRowAction, Text, Title,
} from "@ui5/webcomponents-react";
import { orpc } from "../../orpc.ts";
import { statusUi } from "./runView.ts";

export function ConfigsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const configs = useQuery(orpc.configs.list.queryOptions());
  const models = useQuery(orpc.configs.models.queryOptions());
  const invalidate = () => qc.invalidateQueries({ queryKey: orpc.configs.list.queryOptions().queryKey });

  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [modelId, setModelId] = useState("");
  const create = useMutation(
    orpc.configs.create.mutationOptions({
      onSuccess: (r) => {
        invalidate();
        navigate({ to: "/configs/$id", params: { id: r.id } });
      },
    }),
  );
  const remove = useMutation(orpc.configs.remove.mutationOptions({ onSuccess: invalidate }));

  if (configs.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;

  return (
    <DynamicPage
      titleArea={
        <DynamicPageTitle
          heading={<Title level="H3">Configurations</Title>}
          actionsBar={
            <Bar design="Header" endContent={
              <Button design="Emphasized" disabled={!models.data?.length}
                tooltip={models.data?.length ? undefined : "No configurator models yet — an admin creates those first."}
                onClick={() => { setNewName(""); setModelId(models.data?.[0]?.id ?? ""); setNewOpen(true); }}>
                New configuration
              </Button>
            } />
          }
        />
      }
    >
      {configs.error ? <MessageStrip design="Negative" hideCloseButton>{configs.error.message}</MessageStrip> : null}
      {remove.error ? <MessageStrip design="Negative" hideCloseButton>{remove.error.message}</MessageStrip> : null}

      <Table
        noDataText="No configurations yet — create one to start."
        rowActionCount={1}
        onRowClick={(e) => {
          const id = (e.detail.row as HTMLElement).dataset.id;
          if (id) navigate({ to: "/configs/$id", params: { id } });
        }}
        onRowActionClick={(e) => {
          const id = ((e.detail.row as unknown) as HTMLElement).dataset.id;
          // ponytail: no confirm dialog, matching ModelsPage
          if (id) remove.mutate({ id });
        }}
        headerRow={
          <TableHeaderRow sticky>
            <TableHeaderCell><span>Name</span></TableHeaderCell>
            <TableHeaderCell><span>Model</span></TableHeaderCell>
            <TableHeaderCell><span>Customer</span></TableHeaderCell>
            <TableHeaderCell><span>Status</span></TableHeaderCell>
            <TableHeaderCell><span>Last changed</span></TableHeaderCell>
          </TableHeaderRow>
        }
      >
        {(configs.data ?? []).map((c) => (
          <TableRow key={c.id} rowKey={c.id} data-id={c.id} interactive
            actions={<TableRowAction icon="delete" text="Delete" />}>
            <TableCell><Text>{c.name}</Text></TableCell>
            <TableCell><Text>{c.modelName}</Text></TableCell>
            <TableCell><Text>{c.customer?.cardName ?? "—"}</Text></TableCell>
            <TableCell><ObjectStatus state={statusUi[c.status].state}>{statusUi[c.status].text}</ObjectStatus></TableCell>
            <TableCell><Text>{new Date(c.updatedAt).toLocaleString()}</Text></TableCell>
          </TableRow>
        ))}
      </Table>

      <Dialog
        open={newOpen}
        headerText="New configuration"
        onClose={() => setNewOpen(false)}
        footer={
          <Bar design="Footer" endContent={
            <>
              <Button design="Emphasized" disabled={!newName.trim() || !modelId || create.isPending}
                onClick={() => create.mutate({ modelId, name: newName.trim() })}>
                {create.isPending ? "Creating…" : "Create"}
              </Button>
              <Button onClick={() => setNewOpen(false)}>Cancel</Button>
            </>
          } />
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", padding: "0.5rem 0" }}>
          {create.error ? <MessageStrip design="Negative" hideCloseButton>{create.error.message}</MessageStrip> : null}
          <Label for="new-config-name" required>Name</Label>
          <Input id="new-config-name" value={newName} onInput={(e) => setNewName(e.target.value)} />
          <Label required>Model</Label>
          <Select onChange={(e) => setModelId((e.detail.selectedOption as HTMLElement).dataset.id ?? "")}>
            {(models.data ?? []).map((m) => (
              <Option key={m.id} data-id={m.id} selected={m.id === modelId}>{m.name}</Option>
            ))}
          </Select>
        </div>
      </Dialog>
    </DynamicPage>
  );
}
```

- [ ] **Step 2: Create the route**

Create `apps/web/src/routes/_authed/configs/index.tsx`:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { ConfigsPage } from "../../../components/configurator/ConfigsPage.tsx";

export const Route = createFileRoute("/_authed/configs/")({ component: ConfigsPage });
```

- [ ] **Step 3: Add the nav item**

In `apps/web/src/components/AppShell.tsx`, after the `enabled.map(...)` entity items and **before** the `{isAdmin ? (` block (Configurations is for every member), insert:

```tsx
          <SideNavigationItem
            text="Configurations"
            icon="sales-quote"
            data-to="/configs"
            selected={pathname === "/configs" || pathname.startsWith("/configs/")}
          />
```

- [ ] **Step 4: Verify**

Run: `bun run dev:web` (server can stay down for this check) and open `http://acme.lvh.me:5173/configs` after signing in — or, minimally, `bun run build:web`.
Expected: build green; nav shows Configurations; empty state text renders; New configuration dialog lists models when the API is up.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/configurator/ConfigsPage.tsx apps/web/src/routes/_authed/configs/index.tsx apps/web/src/components/AppShell.tsx
git commit -m "feat(web): configurations list, route, member nav item"
```

---

### Task 3: Wizard shell + step 1 (Configure) + `$id` route

**Files:**
- Create: `apps/web/src/components/configurator/ConfigProcessPage.tsx`
- Create: `apps/web/src/components/configurator/StepConfigure.tsx`
- Create: `apps/web/src/routes/_authed/configs/$id.tsx`

**Interfaces:**
- Consumes: `orpc.configs.get / lookups / update / run / select`; `ConfiguratorForm` (phase 3, props `{model, lookups, entries, onChange}`); `propagate` from `@hera/config-engine`; `statusUi`, `Sel`, `toggleSelection`, `cleanOverrides` from Task 1.
- Produces (Tasks 4–6 replace the placeholder step contents inside this file):
  - `ConfigProcessPage({ id }: { id: string })` holding: `entries` (`entriesOverride ?? project.entries`), `batches` (`batchesOverride ?? project.batches`), `selection` (`selOverride ?? latestRun?.selection ?? []`), `step` (`stepOverride ?? status-derived default`), `runMeta` (`{capped, widest} | null` from the last run mutation), mutations `update`, `run`, `select`, helpers `goto(i)`, `saveEntries()`, `calculate()`, `saveSelection()`, flags `conflicted`, `runReady`, `entriesDirty`, `batchesDirty`.
  - `StepConfigure` props: `{ model: ModelDef, lookups: UseQueryResult<ResolvedLookups, Error>, entries: Entries, onChange, onNext, saving, conflicted }`.

- [ ] **Step 1: Create StepConfigure**

Create `apps/web/src/components/configurator/StepConfigure.tsx`:

```tsx
import type { UseQueryResult } from "@tanstack/react-query";
import { Bar, BusyIndicator, Button, MessageStrip } from "@ui5/webcomponents-react";
import type { Entries, ModelDef, ResolvedLookups } from "@hera/config-engine";
import { ConfiguratorForm } from "./ConfiguratorForm.tsx";

// Wizard step 1: the same form the builder preview uses, over server-resolved lookups.
// Lookup errors (agent offline, source unreachable) surface verbatim with a retry.
export function StepConfigure({ model, lookups, entries, onChange, onNext, saving, conflicted }: {
  model: ModelDef;
  lookups: UseQueryResult<ResolvedLookups, Error>;
  entries: Entries;
  onChange: (next: Entries) => void;
  onNext: () => void;
  saving: boolean;
  conflicted: boolean;
}) {
  if (lookups.isPending) return <BusyIndicator active delay={200} style={{ width: "100%", marginTop: "3rem" }} />;
  if (lookups.error)
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <MessageStrip design="Negative" hideCloseButton>{lookups.error.message}</MessageStrip>
        <Button style={{ alignSelf: "start" }} onClick={() => lookups.refetch()}>Retry</Button>
      </div>
    );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <ConfiguratorForm model={model} lookups={lookups.data} entries={entries} onChange={onChange} />
      <Bar design="FloatingFooter" endContent={
        <Button design="Emphasized" disabled={conflicted || saving} onClick={onNext}
          tooltip={conflicted ? "Resolve the conflicts above first" : undefined}>
          {saving ? "Saving…" : "Next: batches"}
        </Button>
      } />
    </div>
  );
}
```

Note: `ConfiguratorForm`'s root uses `height: 100%` + inner scroll; inside a wizard step (auto-height content) the percentage collapses to natural height, which is what we want here — the wizard owns scrolling. If the form renders collapsed instead, wrap it in `<div style={{ minHeight: "24rem" }}>` — check visually in Step 4.

- [ ] **Step 2: Create the wizard shell**

Create `apps/web/src/components/configurator/ConfigProcessPage.tsx`:

```tsx
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar, BusyIndicator, MessageStrip, ObjectStatus, Text, Title, Wizard, WizardStep,
} from "@ui5/webcomponents-react";
import { propagate, type Entries } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";
import { cleanOverrides, statusUi, toggleSelection, type Sel } from "./runView.ts";
import { StepConfigure } from "./StepConfigure.tsx";

// The configuration process: 5 steps, gated left to right. Steps 1–2 work on live model +
// lookups; steps 3–4 render ONLY from the immutable run snapshot. Local state overlays
// server state (override ?? server value) until a mutation persists it.
export function ConfigProcessPage({ id }: { id: string }) {
  const qc = useQueryClient();
  const q = useQuery(orpc.configs.get.queryOptions({ input: { id } }));
  const modelId = q.data?.project.modelId;
  const lookups = useQuery({
    ...orpc.configs.lookups.queryOptions({ input: { modelId: modelId! } }),
    enabled: !!modelId,
    staleTime: 5 * 60_000, // matches the server-side cache window
    retry: false, // agent-offline should show its message, not spin
  });

  const [stepOverride, setStep] = useState<number | null>(null);
  const [entriesOverride, setEntries] = useState<Entries | null>(null);
  const [batchesOverride, setBatches] = useState<number[] | null>(null);
  const [selOverride, setSel] = useState<Sel[] | null>(null);
  const [runMeta, setRunMeta] = useState<{ capped: boolean; widest?: { key: string; size: number } } | null>(null);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: orpc.configs.get.queryOptions({ input: { id } }).queryKey });
  const update = useMutation(orpc.configs.update.mutationOptions({ onSuccess: invalidate }));
  const run = useMutation(
    orpc.configs.run.mutationOptions({
      onSuccess: (r) => {
        setRunMeta({ capped: r.capped, widest: r.widest });
        setSel([]); // a new run invalidates any previous candidate picks
        invalidate();
        setStep(2);
      },
    }),
  );
  const select = useMutation(orpc.configs.select.mutationOptions({ onSuccess: invalidate }));

  if (q.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;
  if (q.error)
    return <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>{q.error.message}</MessageStrip>;
  const { project, model, latestRun } = q.data;

  const entries = entriesOverride ?? project.entries;
  const batches = batchesOverride ?? project.batches;
  const selection = selOverride ?? latestRun?.selection ?? [];
  const runReady = !!latestRun && project.status !== "draft";
  const step = stepOverride ?? (project.status === "draft" ? 0 : 2);

  const prop = lookups.data ? propagate(model.definition, lookups.data, entries) : null;
  const conflicted = !!prop && prop.conflicts.length > 0;
  const entriesDirty = JSON.stringify(entries) !== JSON.stringify(project.entries);
  const batchesDirty = JSON.stringify(batches) !== JSON.stringify(project.batches);

  const saveEntries = () => {
    if (entriesDirty) update.mutate({ id, entries });
  };
  const goto = (i: number) => {
    if (step === 0 && i !== 0) saveEntries(); // leaving Configure persists (and re-drafts) the project
    setStep(i);
  };
  const calculate = async () => {
    try {
      if (entriesDirty || batchesDirty) await update.mutateAsync({ id, entries, batches });
      run.mutate({ projectId: id });
    } catch {
      /* update.error renders below */
    }
  };
  const saveSelection = () => {
    if (!latestRun || selection.length === 0) return;
    select.mutate({
      runId: latestRun.id,
      selection: selection.map((s) => ({
        candidateIdx: s.candidateIdx, batchQty: s.batchQty, overrides: cleanOverrides(s.overrides),
      })),
    });
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Bar design="Header"
        startContent={
          <>
            <Title level="H4">{project.name}</Title>
            <Text>{model.name}</Text>
          </>
        }
        endContent={<ObjectStatus state={statusUi[project.status].state}>{statusUi[project.status].text}</ObjectStatus>}
      />
      <Wizard contentLayout="MultipleSteps" style={{ flex: 1, minHeight: 0 }}
        onStepChange={(e) => goto(Number((e.detail.step as HTMLElement).dataset.idx))}>
        <WizardStep titleText="Configure" icon="settings" data-idx="0" selected={step === 0}>
          <StepConfigure model={model.definition} lookups={lookups} entries={entries}
            onChange={setEntries} onNext={() => goto(1)} saving={update.isPending} conflicted={conflicted} />
        </WizardStep>
        <WizardStep titleText="Batches" icon="multiselect-all" data-idx="1" selected={step === 1} disabled={conflicted}>
          <Text>Batch quantities — Task 4 replaces this.</Text>
        </WizardStep>
        <WizardStep titleText="Candidates" icon="grid" data-idx="2" selected={step === 2} disabled={!runReady}>
          <Text>Candidates — Task 5 replaces this.</Text>
        </WizardStep>
        <WizardStep titleText="Review outputs" icon="activity-items" data-idx="3" selected={step === 3}
          disabled={!runReady || selection.length === 0}>
          <Text>Review — Task 6 replaces this.</Text>
        </WizardStep>
        <WizardStep titleText="Create quote" icon="sales-quote" data-idx="4" disabled>
          <Text>Available after review — coming in phase 5.</Text>
        </WizardStep>
      </Wizard>
    </div>
  );
}
```

Unused-for-now pieces (`batches`, `batchesDirty`, `calculate`, `saveSelection`, `run`, `select`, `runMeta`, `toggleSelection` import) are wired by Tasks 4–6; if the linter/tsconfig complains about unused locals in this interim state, prefix them with `void` references in a single `void calculate;`-style line and remove it in Task 4 — or just accept editor warnings; `vite build` does not fail on them.

- [ ] **Step 3: Create the route**

Create `apps/web/src/routes/_authed/configs/$id.tsx` (keyed like `models/$id.tsx` so switching projects resets wizard state):

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { ConfigProcessPage } from "../../../components/configurator/ConfigProcessPage.tsx";

export const Route = createFileRoute("/_authed/configs/$id")({ component: Process });

function Process() {
  const { id } = Route.useParams();
  return <ConfigProcessPage key={id} id={id} />;
}
```

- [ ] **Step 4: Verify in the running app**

Run: `bun run dev` (needs Postgres; agent only for query-lookup models). Create a configuration from `/configs`, land on the wizard.
Expected: header shows name, model, Draft status; step 1 renders the form with live propagation, eliminated options disabled with constraint tooltips, computed values, the sticky `✓ consistent · N open · ~M candidates` bar; "Next: batches" saves entries (status stays Draft) and moves to the placeholder step 2; steps 3–5 are grayed out; with the agent stopped and a query-lookup model, step 1 shows the agent-offline message with Retry.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/configurator/ConfigProcessPage.tsx apps/web/src/components/configurator/StepConfigure.tsx apps/web/src/routes/_authed/configs/\$id.tsx
git commit -m "feat(web): configuration wizard shell with live Configure step"
```

---

### Task 4: Step 2 — Batches + Calculate

**Files:**
- Create: `apps/web/src/components/configurator/StepBatches.tsx`
- Modify: `apps/web/src/components/configurator/ConfigProcessPage.tsx` (replace the step-2 placeholder)

**Interfaces:**
- Consumes: `batches`, `setBatches`, `calculate`, `run`/`update` mutation state, `latestRun`, dirty flags from Task 3.
- Produces: `StepBatches` props `{ batches: number[], onChange(next: number[]), onCalculate(), running: boolean, error: string | null, staleRun: boolean }`.

- [ ] **Step 1: Create StepBatches**

Create `apps/web/src/components/configurator/StepBatches.tsx`:

```tsx
import { useState } from "react";
import { Bar, Button, Label, MessageStrip, StepInput, Text, Title, Token, Tokenizer } from "@ui5/webcomponents-react";

// Wizard step 2: the batch quantities to price. Each quantity becomes a column in the
// candidates matrix; setup cost is amortized across the batch by the engine.
export function StepBatches({ batches, onChange, onCalculate, running, error, staleRun }: {
  batches: number[];
  onChange: (next: number[]) => void;
  onCalculate: () => void;
  running: boolean;
  error: string | null;
  staleRun: boolean;
}) {
  const [qty, setQty] = useState(1);
  const add = () => {
    if (!batches.includes(qty)) onChange([...batches, qty].sort((a, b) => a - b));
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <Title level="H5">Batch quantities</Title>
      <Text>Each quantity gets its own price column — setup cost is spread across the batch.</Text>
      {staleRun ? (
        <MessageStrip design="Critical" hideCloseButton>
          Inputs changed since the last calculation — calculate again to refresh candidates.
        </MessageStrip>
      ) : null}
      {error ? <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip> : null}
      <Tokenizer accessibleName="Batch quantities"
        onTokenDelete={(e) => {
          const gone = new Set(e.detail.tokens.map((t) => Number((t as HTMLElement).getAttribute("text"))));
          onChange(batches.filter((b) => !gone.has(b)));
        }}>
        {batches.map((b) => <Token key={b} text={String(b)} />)}
      </Tokenizer>
      {batches.length === 0 ? <Text>Add at least one quantity to calculate.</Text> : null}
      <div style={{ display: "flex", alignItems: "flex-end", gap: "0.5rem" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          <Label for="new-batch-qty">Quantity</Label>
          <StepInput id="new-batch-qty" min={1} value={qty} onChange={(e) => setQty(e.target.value ?? 1)} />
        </div>
        <Button icon="add" onClick={add}>Add quantity</Button>
      </div>
      <Bar design="FloatingFooter" endContent={
        <Button design="Emphasized" disabled={batches.length === 0 || running} onClick={onCalculate}>
          {running ? "Calculating…" : "Calculate"}
        </Button>
      } />
    </div>
  );
}
```

- [ ] **Step 2: Wire it into the wizard**

In `ConfigProcessPage.tsx`, add the import and replace the step-2 placeholder `<Text>` with:

```tsx
          <StepBatches batches={batches} onChange={setBatches} onCalculate={() => void calculate()}
            running={update.isPending || run.isPending}
            error={update.error?.message ?? run.error?.message ?? null}
            staleRun={!!latestRun && (project.status === "draft" || entriesDirty || batchesDirty)} />
```

with `import { StepBatches } from "./StepBatches.tsx";` at the top.

- [ ] **Step 3: Verify in the running app**

Run: `bun run dev`, walk a project to step 2.
Expected: tokens prefilled from the model's batch defaults; delete via token ✕ or Backspace; add sorted, no duplicates; Calculate persists dirty entries/batches, runs, lands on the (placeholder) Candidates step with status now Calculated; with zero batches Calculate is disabled; a `run` error (e.g. conflicts, agent offline) shows its server message in the strip; editing step-1 entries afterwards flips status back to Draft, disables steps 3–4, and step 2 shows the "calculate again" hint.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/configurator/StepBatches.tsx apps/web/src/components/configurator/ConfigProcessPage.tsx
git commit -m "feat(web): batches step with persist-then-calculate flow"
```

---

### Task 5: Step 3 — Candidates matrix + detail panel

**Files:**
- Create: `apps/web/src/components/configurator/StepCandidates.tsx`
- Create: `apps/web/src/components/configurator/CandidateDetail.tsx`
- Modify: `apps/web/src/components/configurator/ConfigProcessPage.tsx` (replace the step-3 placeholder)

**Interfaces:**
- Consumes: `latestRun.modelSnapshot / entries / candidates`, `selection`, `setSel`, `toggleSelection`, `runMeta`; helpers `openKeys`, `candidateLabel`, `bestByBatch`, `isSelected`, `fmt` from Task 1.
- Produces:
  - `StepCandidates` props `{ model: ModelDef, runEntries: Entries, candidates: Candidate[], selection: Sel[], onToggle(candidateIdx, batchQty), onNext(), capped: boolean, widest?: {key, size} }`.
  - `CandidateDetail` props `{ label: string, candidate: Candidate }`.

- [ ] **Step 1: Create CandidateDetail (breakdown, price curve, read-only outputs)**

Create `apps/web/src/components/configurator/CandidateDetail.tsx`:

```tsx
import { useState } from "react";
import {
  Option, Panel, Select, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, Text, Title,
} from "@ui5/webcomponents-react";
import { fmt, type Candidate } from "./runView.ts";

const row = (label: string, value: string) => (
  <div style={{ display: "flex", justifyContent: "space-between", gap: "1.5rem" }}>
    <Text>{label}</Text>
    <Text style={{ fontWeight: 600 }}>{value}</Text>
  </div>
);

// ponytail: inline SVG micro-chart (≤ ~6 points); swap for @ui5/webcomponents-react-charts
// LineChart only if charts multiply — that package documents no design spec and weak a11y.
function PriceCurve({ points }: { points: { batchQty: number; unitPrice: number }[] }) {
  if (points.length < 2) return null;
  const W = 380, H = 150, P = 30;
  const prices = points.map((p) => p.unitPrice);
  const lo = Math.min(...prices), hi = Math.max(...prices);
  const x = (i: number) => P + (i * (W - 2 * P)) / (points.length - 1);
  const y = (v: number) => (hi === lo ? H / 2 : P + ((hi - v) * (H - 2 * P)) / (hi - lo));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} role="img" aria-label="Unit price by batch quantity">
      <polyline fill="none" stroke="var(--sapChart_OrderedColor_1, #0070f2)" strokeWidth="2"
        points={points.map((p, i) => `${x(i)},${y(p.unitPrice)}`).join(" ")} />
      {points.map((p, i) => (
        <g key={p.batchQty}>
          <circle cx={x(i)} cy={y(p.unitPrice)} r="3.5" fill="var(--sapChart_OrderedColor_1, #0070f2)" />
          <text x={x(i)} y={y(p.unitPrice) - 8} textAnchor="middle" fontSize="11"
            fill="var(--sapTextColor, #223)">{fmt(p.unitPrice)}</text>
          <text x={x(i)} y={H - 8} textAnchor="middle" fontSize="11"
            fill="var(--sapContent_LabelColor, #556)">{fmt(p.batchQty)}</text>
        </g>
      ))}
    </svg>
  );
}

// Everything the price is made of, for one candidate: per-batch breakdown, the price curve,
// and the run's frozen BOM/operations. Read-only — edits happen in Review.
export function CandidateDetail({ label, candidate }: { label: string; candidate: Candidate }) {
  const [batchIdx, setBatchIdx] = useState(0);
  const pb = candidate.perBatch[batchIdx] ?? candidate.perBatch[0];
  if (!pb) return null;
  const o = pb.outputs;
  return (
    <Panel headerText={label} fixed>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "2rem", alignItems: "flex-start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", minWidth: "17rem" }}>
          <Select onChange={(e) => setBatchIdx(Number((e.detail.selectedOption as HTMLElement).dataset.idx))}>
            {candidate.perBatch.map((b, i) => (
              <Option key={b.batchQty} data-idx={String(i)} selected={i === batchIdx}>Qty {fmt(b.batchQty)}</Option>
            ))}
          </Select>
          {row("Material / unit", fmt(o.materialPerUnit))}
          {row("Labor / unit", fmt(o.laborPerUnit))}
          {row("Unit cost", fmt(o.unitCost))}
          {row("Margin / unit", fmt(o.unitPrice - o.unitCost))}
          {row("Unit price", fmt(o.unitPrice))}
          {row("Batch total", fmt(o.batchTotal))}
        </div>
        <PriceCurve points={candidate.perBatch.map((b) => ({ batchQty: b.batchQty, unitPrice: b.outputs.unitPrice }))} />
      </div>

      <Title level="H6" style={{ margin: "1rem 0 0.25rem" }}>Bill of materials</Title>
      <Table noDataText="No BOM lines apply to this configuration." headerRow={
        <TableHeaderRow>
          <TableHeaderCell><span>Item</span></TableHeaderCell>
          <TableHeaderCell><span>Description</span></TableHeaderCell>
          <TableHeaderCell horizontalAlign="End"><span>Qty / unit</span></TableHeaderCell>
          <TableHeaderCell horizontalAlign="End"><span>Total qty</span></TableHeaderCell>
          <TableHeaderCell horizontalAlign="End"><span>Unit price</span></TableHeaderCell>
          <TableHeaderCell horizontalAlign="End"><span>Line total</span></TableHeaderCell>
        </TableHeaderRow>
      }>
        {o.bom.map((l) => (
          <TableRow key={l.id} rowKey={l.id}>
            <TableCell><Text>{l.itemCode}</Text></TableCell>
            <TableCell><Text>{l.desc}</Text></TableCell>
            <TableCell horizontalAlign="End"><Text>{fmt(l.qtyPerUnit)}</Text></TableCell>
            <TableCell horizontalAlign="End"><Text>{fmt(l.totalQty)}</Text></TableCell>
            <TableCell horizontalAlign="End"><Text>{fmt(l.unitPrice)}</Text></TableCell>
            <TableCell horizontalAlign="End"><Text>{fmt(l.lineTotal)}</Text></TableCell>
          </TableRow>
        ))}
      </Table>

      <Title level="H6" style={{ margin: "1rem 0 0.25rem" }}>Operations</Title>
      <Table noDataText="No operations apply to this configuration." headerRow={
        <TableHeaderRow>
          <TableHeaderCell><span>Resource</span></TableHeaderCell>
          <TableHeaderCell horizontalAlign="End"><span>Setup min</span></TableHeaderCell>
          <TableHeaderCell horizontalAlign="End"><span>Run min / unit</span></TableHeaderCell>
          <TableHeaderCell horizontalAlign="End"><span>Total min</span></TableHeaderCell>
          <TableHeaderCell horizontalAlign="End"><span>Cost</span></TableHeaderCell>
        </TableHeaderRow>
      }>
        {o.ops.map((l) => (
          <TableRow key={l.id} rowKey={l.id}>
            <TableCell><Text>{l.resource}</Text></TableCell>
            <TableCell horizontalAlign="End"><Text>{fmt(l.setupMin)}</Text></TableCell>
            <TableCell horizontalAlign="End"><Text>{fmt(l.runMinPerUnit)}</Text></TableCell>
            <TableCell horizontalAlign="End"><Text>{fmt(l.totalMin)}</Text></TableCell>
            <TableCell horizontalAlign="End"><Text>{fmt(l.cost)}</Text></TableCell>
          </TableRow>
        ))}
      </Table>
    </Panel>
  );
}
```

- [ ] **Step 2: Create StepCandidates (the price matrix)**

Create `apps/web/src/components/configurator/StepCandidates.tsx`:

```tsx
import { useState } from "react";
import {
  Bar, Button, MessageStrip, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, Text,
  Title, ToggleButton,
} from "@ui5/webcomponents-react";
import type { Entries, ModelDef } from "@hera/config-engine";
import { bestByBatch, candidateLabel, fmt, isSelected, openKeys, type Candidate, type Sel } from "./runView.ts";
import { CandidateDetail } from "./CandidateDetail.tsx";

// Wizard step 3, the signature view: rows = candidates (labeled by their open-parameter
// values), columns = batch quantities, every price cell IS the selection control. One
// pressed cell = one future quotation line. Green marks the lowest price per column.
export function StepCandidates({ model, runEntries, candidates, selection, onToggle, onNext, capped, widest }: {
  model: ModelDef;
  runEntries: Entries;
  candidates: Candidate[];
  selection: Sel[];
  onToggle: (candidateIdx: number, batchQty: number) => void;
  onNext: () => void;
  capped: boolean;
  widest?: { key: string; size: number };
}) {
  const [detailIdx, setDetailIdx] = useState<number | null>(null);
  const keys = openKeys(model, runEntries, candidates);
  const best = bestByBatch(candidates);
  const batches = candidates[0]?.perBatch.map((b) => b.batchQty) ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <Title level="H5">Candidates</Title>
      <Text>
        Unit prices per batch quantity. Pick one or more cells to take into review — each picked
        cell becomes one quotation line. The green price is the lowest in its column.
      </Text>
      {capped ? (
        <MessageStrip design="Critical" hideCloseButton>
          Stopped at {candidates.length} candidates — go back and set more parameters
          {widest ? ` (${widest.key} is widest with ${widest.size} options)` : ""}.
        </MessageStrip>
      ) : null}

      <Table
        onRowClick={(e) => {
          const i = Number((e.detail.row as HTMLElement).dataset.idx);
          setDetailIdx(i === detailIdx ? null : i);
        }}
        headerRow={
          <TableHeaderRow sticky>
            <TableHeaderCell minWidth="14rem"><span>Configuration ({keys.join(" · ") || "fixed"})</span></TableHeaderCell>
            {batches.map((b) => (
              <TableHeaderCell key={b} horizontalAlign="End"><span>Qty {fmt(b)}</span></TableHeaderCell>
            ))}
          </TableHeaderRow>
        }
      >
        {candidates.map((c, i) => (
          <TableRow key={i} rowKey={String(i)} data-idx={String(i)} interactive>
            <TableCell><Text>{candidateLabel(keys, c.assignment)}</Text></TableCell>
            {c.perBatch.map((b) => (
              <TableCell key={b.batchQty} horizontalAlign="End">
                <ToggleButton pressed={isSelected(selection, i, b.batchQty)}
                  design={best[b.batchQty] === i ? "Positive" : "Default"}
                  tooltip={best[b.batchQty] === i ? "Lowest price for this quantity" : undefined}
                  onClick={(e) => { e.stopPropagation(); onToggle(i, b.batchQty); }}>
                  {fmt(b.outputs.unitPrice)}
                </ToggleButton>
              </TableCell>
            ))}
          </TableRow>
        ))}
      </Table>

      {detailIdx !== null && candidates[detailIdx] ? (
        <CandidateDetail label={candidateLabel(keys, candidates[detailIdx].assignment)}
          candidate={candidates[detailIdx]} />
      ) : (
        <Text style={{ opacity: 0.7 }}>Click a row to see its cost breakdown, price curve, BOM and operations.</Text>
      )}

      <Bar design="FloatingFooter" endContent={
        <Button design="Emphasized" disabled={selection.length === 0} onClick={onNext}>
          Review selection ({selection.length})
        </Button>
      } />
    </div>
  );
}
```

If `e.stopPropagation()` on the ToggleButton doesn't stop the UI5 row-click (composed-event edge case), guard in `onRowClick` instead: ignore the event when `(e.nativeEvent?.composedPath?.() ?? []).some((el) => (el as HTMLElement).tagName === "UI5-TOGGLE-BUTTON")` — verify by clicking a cell and checking the detail panel doesn't toggle.

- [ ] **Step 3: Wire it into the wizard**

In `ConfigProcessPage.tsx`, add imports (`StepCandidates`, `toggleSelection` is already imported) and replace the step-3 placeholder `<Text>` with:

```tsx
          {runReady && latestRun ? (
            <StepCandidates model={latestRun.modelSnapshot} runEntries={latestRun.entries}
              candidates={latestRun.candidates} selection={selection}
              onToggle={(i, b) => setSel(toggleSelection(selection, i, b))}
              onNext={() => goto(3)}
              capped={runMeta?.capped ?? latestRun.candidates.length >= 200}
              widest={runMeta?.widest} />
          ) : null}
```

(`capped` falls back to the engine's default cap when the page is reloaded and the run-mutation metadata is gone; `widest` is session-only — acceptable.)

- [ ] **Step 4: Verify in the running app**

Run: `bun run dev`, calculate a project with ≥1 open parameter and ≥2 batches.
Expected: matrix renders with per-column lowest price green; clicking a price toggles it pressed without opening the detail; clicking the row toggles the detail panel with breakdown (including margin), the SVG price curve falling as quantity rises, and read-only BOM/ops per batch selector; "Review selection (n)" counts cells and enables step 4; reopening a project with a stored selection shows those cells pressed (selection restores from `latestRun.selection`).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/configurator/StepCandidates.tsx apps/web/src/components/configurator/CandidateDetail.tsx apps/web/src/components/configurator/ConfigProcessPage.tsx
git commit -m "feat(web): candidates price matrix with cell selection and detail panel"
```

---

### Task 6: Step 4 — Review outputs with overrides + Save selection

**Files:**
- Create: `apps/web/src/components/configurator/StepReview.tsx`
- Modify: `apps/web/src/components/configurator/ConfigProcessPage.tsx` (replace the step-4 placeholder)

**Interfaces:**
- Consumes: `computeOutputs` (browser side, over the run **snapshots**); Task 1 override helpers; `saveSelection`, `select` mutation state, `selection`, `setSel` from Task 3.
- Produces: `StepReview` props `{ model: ModelDef, lookups: ResolvedLookups, runEntries: Entries, candidates: Candidate[], selection: Sel[], onChange(next: Sel[]), onSave(), saving: boolean, error: string | null, saved: boolean }`.

- [ ] **Step 1: Create StepReview**

Create `apps/web/src/components/configurator/StepReview.tsx`:

```tsx
import {
  Bar, Button, Input, MessageStrip, ObjectStatus, Panel, StepInput, Table, TableCell,
  TableHeaderCell, TableHeaderRow, TableRow, TableRowAction, Text, Title,
} from "@ui5/webcomponents-react";
import { computeOutputs, type Entries, type ModelDef, type OutputOverrides, type Outputs, type ResolvedLookups } from "@hera/config-engine";
import {
  addBomLine, addOpLine, candidateLabel, fmt, isEdited, isRemoved, openKeys, patchAddedBom,
  patchAddedOp, patchBom, patchOp, removeAddedBom, removeAddedOp, resetLine, withoutRemovals,
  type Candidate, type Sel,
} from "./runView.ts";

// Wizard step 4: per selected cell, the outputs become editable. Two computeOutputs passes:
// the display pass ignores remove flags (so removed rows stay visible, struck through) and
// the totals pass applies everything — the numbers shown are exactly what the server will
// recompute and store on Save selection.
export function StepReview({ model, lookups, runEntries, candidates, selection, onChange, onSave, saving, error, saved }: {
  model: ModelDef;
  lookups: ResolvedLookups;
  runEntries: Entries;
  candidates: Candidate[];
  selection: Sel[];
  onChange: (next: Sel[]) => void;
  onSave: () => void;
  saving: boolean;
  error: string | null;
  saved: boolean;
}) {
  const keys = openKeys(model, runEntries, candidates);
  const setOv = (i: number, ov: OutputOverrides) =>
    onChange(selection.map((s, j) => (j === i ? { ...s, overrides: ov } : s)));

  let grand = 0;
  const panels = selection.map((s, i) => {
    const cand = candidates[s.candidateIdx];
    if (!cand) return null;
    const ov = s.overrides ?? {};
    const addedBom = new Set((ov.addBom ?? []).map((a) => a.id));
    const addedOps = new Set((ov.addOps ?? []).map((a) => a.id));

    let display: Outputs, totals: Outputs;
    try {
      display = computeOutputs(model, lookups, cand.assignment, s.batchQty, withoutRemovals(ov));
      totals = computeOutputs(model, lookups, cand.assignment, s.batchQty, ov);
    } catch (e) {
      return (
        <MessageStrip key={i} design="Negative" hideCloseButton>
          {candidateLabel(keys, cand.assignment)} — {e instanceof Error ? e.message : String(e)}
        </MessageStrip>
      );
    }
    grand += totals.batchTotal;

    const rowStatus = (kind: "bom" | "ops", id: string, added: boolean) =>
      added ? <ObjectStatus state="Information">added</ObjectStatus>
        : isRemoved(ov, kind, id) ? <ObjectStatus state="Negative">removed</ObjectStatus>
        : isEdited(ov, kind, id) ? <ObjectStatus state="Information">edited</ObjectStatus>
        : null;
    const rowActions = (kind: "bom" | "ops", id: string, added: boolean) =>
      added ? <TableRowAction icon="delete" text="Remove" />
        : isRemoved(ov, kind, id) ? <TableRowAction icon="refresh" text="Restore" />
        : (
          <>
            {isEdited(ov, kind, id) ? <TableRowAction icon="reset" text="Reset" /> : null}
            <TableRowAction icon="delete" text="Remove" />
          </>
        );
    const onAction = (kind: "bom" | "ops", e: Parameters<NonNullable<React.ComponentProps<typeof Table>["onRowActionClick"]>>[0]) => {
      const id = (e.detail.row as HTMLElement).dataset.lineId!;
      const action = (e.detail.action as HTMLElement).getAttribute("text");
      const added = kind === "bom" ? addedBom.has(id) : addedOps.has(id);
      if (added) setOv(i, kind === "bom" ? removeAddedBom(ov, id) : removeAddedOp(ov, id));
      else if (action === "Reset") setOv(i, resetLine(ov, kind, id));
      else if (action === "Restore") setOv(i, kind === "bom" ? patchBom(ov, id, { remove: false }) : patchOp(ov, id, { remove: false }));
      else setOv(i, kind === "bom" ? patchBom(ov, id, { remove: true }) : patchOp(ov, id, { remove: true }));
    };
    const dim = (kind: "bom" | "ops", id: string) => (isRemoved(ov, kind, id) ? { opacity: 0.55 } : undefined);
    const rate = (l: Outputs["ops"][number]) =>
      ov.ops?.find((o) => o.id === l.id)?.ratePerHour
      ?? (ov.addOps ?? []).find((o) => o.id === l.id)?.ratePerHour
      ?? (l.totalMin > 0 ? (l.cost * 60) / l.totalMin : 0);

    return (
      <Panel key={`${s.candidateIdx}-${s.batchQty}`} fixed
        headerText={`${candidateLabel(keys, cand.assignment)} — qty ${fmt(s.batchQty)}`}>
        <Title level="H6" style={{ margin: "0 0 0.25rem" }}>Bill of materials</Title>
        <Table rowActionCount={2} noDataText="No BOM lines."
          onRowActionClick={(e) => onAction("bom", e)}
          headerRow={
            <TableHeaderRow>
              <TableHeaderCell minWidth="9rem"><span>Item</span></TableHeaderCell>
              <TableHeaderCell minWidth="9rem"><span>Description</span></TableHeaderCell>
              <TableHeaderCell><span>Qty / unit</span></TableHeaderCell>
              <TableHeaderCell><span>Unit price</span></TableHeaderCell>
              <TableHeaderCell horizontalAlign="End"><span>Line total</span></TableHeaderCell>
              <TableHeaderCell><span></span></TableHeaderCell>
            </TableHeaderRow>
          }>
          {display.bom.map((l) => {
            const added = addedBom.has(l.id);
            return (
              <TableRow key={l.id} rowKey={l.id} data-line-id={l.id}
                actions={rowActions("bom", l.id, added)}>
                <TableCell>
                  {added
                    ? <Input value={l.itemCode} onInput={(e) => setOv(i, patchAddedBom(ov, l.id, { itemCode: e.target.value }))} />
                    : <Text style={dim("bom", l.id)}>{l.itemCode}</Text>}
                </TableCell>
                <TableCell>
                  {added
                    ? <Input value={l.desc} onInput={(e) => setOv(i, patchAddedBom(ov, l.id, { desc: e.target.value }))} />
                    : <Text style={dim("bom", l.id)}>{l.desc}</Text>}
                </TableCell>
                <TableCell>
                  <StepInput min={0} step={0.5} value={l.qtyPerUnit} disabled={isRemoved(ov, "bom", l.id)}
                    onChange={(e) => setOv(i, added
                      ? patchAddedBom(ov, l.id, { qtyPerUnit: e.target.value ?? 0 })
                      : patchBom(ov, l.id, { qtyPerUnit: e.target.value ?? 0 }))} />
                </TableCell>
                <TableCell>
                  <StepInput min={0} step={0.5} value={l.unitPrice} disabled={isRemoved(ov, "bom", l.id)}
                    onChange={(e) => setOv(i, added
                      ? patchAddedBom(ov, l.id, { unitPrice: e.target.value ?? 0 })
                      : patchBom(ov, l.id, { unitPrice: e.target.value ?? 0 }))} />
                </TableCell>
                <TableCell horizontalAlign="End"><Text style={dim("bom", l.id)}>{fmt(l.lineTotal)}</Text></TableCell>
                <TableCell>{rowStatus("bom", l.id, added)}</TableCell>
              </TableRow>
            );
          })}
        </Table>
        <Button icon="add" design="Transparent" onClick={() => setOv(i, addBomLine(ov))}>Add line</Button>

        <Title level="H6" style={{ margin: "0.75rem 0 0.25rem" }}>Operations</Title>
        <Table rowActionCount={2} noDataText="No operations."
          onRowActionClick={(e) => onAction("ops", e)}
          headerRow={
            <TableHeaderRow>
              <TableHeaderCell minWidth="9rem"><span>Resource</span></TableHeaderCell>
              <TableHeaderCell><span>Setup min</span></TableHeaderCell>
              <TableHeaderCell><span>Run min / unit</span></TableHeaderCell>
              <TableHeaderCell><span>Rate / hour</span></TableHeaderCell>
              <TableHeaderCell horizontalAlign="End"><span>Cost</span></TableHeaderCell>
              <TableHeaderCell><span></span></TableHeaderCell>
            </TableHeaderRow>
          }>
          {display.ops.map((l) => {
            const added = addedOps.has(l.id);
            // typed so it satisfies both Partial<OpOv> and Partial<AddedOp>
            const patch = (p: { setupMin?: number; runMinPerUnit?: number; ratePerHour?: number }) =>
              setOv(i, added ? patchAddedOp(ov, l.id, p) : patchOp(ov, l.id, p));
            return (
              <TableRow key={l.id} rowKey={l.id} data-line-id={l.id}
                actions={rowActions("ops", l.id, added)}>
                <TableCell>
                  {added
                    ? <Input value={l.resource} onInput={(e) => setOv(i, patchAddedOp(ov, l.id, { resource: e.target.value }))} />
                    : <Text style={dim("ops", l.id)}>{l.resource}</Text>}
                </TableCell>
                <TableCell>
                  <StepInput min={0} value={l.setupMin} disabled={isRemoved(ov, "ops", l.id)}
                    onChange={(e) => patch({ setupMin: e.target.value ?? 0 })} />
                </TableCell>
                <TableCell>
                  <StepInput min={0} step={0.1} value={l.runMinPerUnit} disabled={isRemoved(ov, "ops", l.id)}
                    onChange={(e) => patch({ runMinPerUnit: e.target.value ?? 0 })} />
                </TableCell>
                <TableCell>
                  <StepInput min={0} value={rate(l)} disabled={isRemoved(ov, "ops", l.id)}
                    onChange={(e) => patch({ ratePerHour: e.target.value ?? 0 })} />
                </TableCell>
                <TableCell horizontalAlign="End"><Text style={dim("ops", l.id)}>{fmt(l.cost)}</Text></TableCell>
                <TableCell>{rowStatus("ops", l.id, added)}</TableCell>
              </TableRow>
            );
          })}
        </Table>
        <Button icon="add" design="Transparent" onClick={() => setOv(i, addOpLine(ov))}>Add operation</Button>

        <Bar design="Footer" style={{ marginTop: "0.5rem" }}
          startContent={
            <Text>
              Material {fmt(totals.materialPerUnit)} · labor {fmt(totals.laborPerUnit)} · unit cost {fmt(totals.unitCost)}
            </Text>
          }
          endContent={<Text style={{ fontWeight: 600 }}>Unit price {fmt(totals.unitPrice)} · batch total {fmt(totals.batchTotal)}</Text>}
        />
      </Panel>
    );
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <Title level="H5">Review outputs</Title>
      <Text>Adjust quantities, times, prices and rates line by line — totals recompute as you type. Saving stores the selection; the server recomputes every number from the run snapshot.</Text>
      {error ? <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip> : null}
      {saved ? <MessageStrip design="Positive" hideCloseButton>Selection saved — totals recomputed on the server.</MessageStrip> : null}
      {panels}
      <Bar design="FloatingFooter"
        startContent={<Text>Total across {selection.length} line{selection.length === 1 ? "" : "s"}: <span style={{ fontWeight: 700 }}>{fmt(grand)}</span></Text>}
        endContent={
          <Button design="Emphasized" disabled={saving || selection.length === 0} onClick={onSave}>
            {saving ? "Saving…" : "Save selection"}
          </Button>
        } />
    </div>
  );
}
```

(The `onAction` prop type via `Parameters<...>` is a mouthful; if it fights the compiler, type the event as `{ detail: { row: HTMLElement; action: HTMLElement } }` — that is the runtime shape.)

- [ ] **Step 2: Wire it into the wizard**

In `ConfigProcessPage.tsx`, import `StepReview` and replace the step-4 placeholder `<Text>` with:

```tsx
          {runReady && latestRun ? (
            <StepReview model={latestRun.modelSnapshot} lookups={latestRun.lookupSnapshot}
              runEntries={latestRun.entries} candidates={latestRun.candidates}
              selection={selection} onChange={setSel}
              onSave={saveSelection} saving={select.isPending}
              error={select.error?.message ?? null} saved={select.isSuccess} />
          ) : null}
```

- [ ] **Step 3: Verify in the running app**

Run: `bun run dev`, select ≥2 cells in step 3, continue to review.
Expected: one panel per selected cell titled `label — qty N`; editing qty/price/time/rate updates the line, panel totals, and the grand total immediately; edited lines show "edited" with a Reset action; Remove strikes the line (dimmed, excluded from totals) with Restore; Add line/Add operation append editable rows ("added") that flow into totals; Save selection persists, shows the confirmation strip, and reloading the page restores both pressed cells (step 3) and overrides (step 4) from `latestRun.selection`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/configurator/StepReview.tsx apps/web/src/components/configurator/ConfigProcessPage.tsx
git commit -m "feat(web): review step with output overrides and server-verified save"
```

---

### Task 7: Verification gates + end-to-end walkthrough

**Files:** none (verification only).

- [ ] **Step 1: Automated gates**

```bash
bun test apps/web packages/config-engine
bun run build:web
bunx tsc --noEmit -p apps/web/tsconfig.json
```

Expected: all tests pass (9 new in `runView.test.ts` plus the existing web + engine suites); vite build green; tsc clean (if tsc reports pre-existing errors on files this plan didn't touch, note them and only fix new ones).

- [ ] **Step 2: Full wizard walkthrough against the dev stack**

Prereqs: Postgres up, `bun run dev`, signed in at `http://acme.lvh.me:5173`, a demo model present (seed with `bun run seed:config` if the models list is empty). Walk:

1. Configurations → New configuration → pick model, name it → wizard opens, status Draft.
2. Step 1: set some parameters, leave ≥1 open; watch eliminations + status bar; Next: batches.
3. Step 2: adjust quantities; Calculate → status Calculated, lands on Candidates.
4. Step 3: pick 2 cells incl. one best-price; open a detail row; check curve + BOM/ops.
5. Step 4: override a qty and a rate, remove a line, add a line; totals move; Save selection.
6. Reload the page — pressed cells and overrides come back; status still Calculated.
7. Back to step 1, change an entry → status Draft, steps 3–4 gray out, step 2 shows the recalculate hint; Calculate again → fresh candidates, empty selection.
8. Agent-offline path (query-lookup model only): stop the agent, reload → step 1 shows the agent message with Retry; `configs.run` refuses with the same message.

Expected: every point above behaves as written; no console errors.

- [ ] **Step 3: Commit any fixes from the walkthrough**

```bash
git add -A apps/web
git commit -m "fix(web): configuration wizard polish from e2e walkthrough"
```

(Skip the commit if the walkthrough was clean.)

---

## Out of scope (phase 5 and later)

Step 5 (customer picker via `entities.list`, `configs.createQuote`, agent `quote.create`, DocNum display, `quoted` flip) — the disabled "Create quote" step is its landing site. VariantManagement on the lists, `AnalyticalTable`, charts package — all marked with their upgrade paths.
