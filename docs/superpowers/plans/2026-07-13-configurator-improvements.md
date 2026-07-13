# Configurator Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the internal configurator wizard to 3 full-height steps, and give table/query lookups named sources with extra columns that flow into formulas and a real value-help dialog.

**Architecture:** Phase 1 (Tasks 1–5) is pure web UI: `ConfiguratorForm` becomes Form/FormGroup/FormItem-only, the 5-step wizard merges into 3 steps with a CSS-overlay header and sticky step bars. Phase 2 (Tasks 6–14) changes the engine's `LookupRef` schema (query refs name a `queryTables` entry; both table/query refs carry display columns), derives `<param>_<column>` values inside `bindings()` so every expression environment gets them, and rebuilds the builder's Tables tab / param dialog / runtime controls around named sources.

**Tech Stack:** Bun workspaces, React 19 + `@ui5/webcomponents-react` 2.x, TanStack Query/Router, oRPC, Zod 4, Drizzle. Engine is `packages/config-engine` (pure TS, `bun test`).

**Spec:** `docs/superpowers/specs/2026-07-13-configurator-improvements-design.md`

## Global Constraints

- Use **bun** for everything (`bun install`, `bun test`); never npm. No new dependencies.
- Icons are registered globally via `AllIcons.js` in `apps/web/src/main.tsx` — no per-icon imports needed.
- Engine tests: `bun run test:engine` (root). Server tests: `bun run test:server` (root). Web typecheck: `bunx tsc --noEmit -p apps/web/tsconfig.json` (root). There is no web unit-test harness; UI tasks verify by typecheck + dev server (`bun run dev`, apex `http://lvh.me:5173`, tenant `http://acme.lvh.me:5173`).
- Derived value naming is exactly `<paramKey>_<column>` (underscore; the DSL has no dot notation).
- The `LookupRef` query-variant change is **breaking with no migration** — pre-production; existing models with inline query refs must be re-edited by hand.
- Mark deliberate shortcuts with `// ponytail:` comments naming the ceiling and upgrade path.
- Do not touch the portal wizard flow (`PortalRequestPage` keeps its 4 steps); it consumes shared components (`StepConfigure`, `StepBatches`, `StepCandidates`) whose public props must keep working.
- UI copy: buttons name the action outcome ("Calculate", "Save selection"); keep existing strings unless a task says otherwise.

---

### Task 1: ConfiguratorForm → Form-only rendering + ConsistencyStatus

**Files:**
- Modify: `apps/web/src/components/configurator/ConfiguratorForm.tsx` (full rewrite below)
- Modify: `apps/web/src/components/configurator/PreviewPane.tsx:26-36` (body + footer)
- Modify: `apps/web/src/components/configurator/StepConfigure.tsx:29-40` (footer)

**Interfaces:**
- Consumes: `propagate`, engine types (unchanged).
- Produces: `ConfiguratorForm({ model, lookups, entries, onChange })` — **no `layout` prop anymore**; renders sections only, no scroll container, no footer. `ConsistencyStatus({ model, lookups, entries })` — renders the one consistency/conflict `ObjectStatus` used by every caller. Tasks 5 and 10 rely on both names exactly.

- [ ] **Step 1: Rewrite ConfiguratorForm.tsx**

Replace the entire file content with:

```tsx
import { useMemo } from "react";
import {
  CheckBox, Form, FormGroup, FormItem, Input, Label, MultiComboBox, MultiComboBoxItem,
  ObjectStatus, Option, RadioButton, Select, StepInput, Text,
} from "@ui5/webcomponents-react";
import { propagate, type DomainOption, type Entries, type ModelDef, type ResolvedLookups, type Val } from "@hera/config-engine";

// The one form both the builder preview and the wizard render. Fully controlled:
// entries in, entries out; all engine work happens in propagate(). Renders sections
// only — scrolling, footers and the consistency line belong to the caller.

/** The signature answer to "is this consistent and how big is it?" — one component so the
 *  string stays identical in the wizard bar, the preview footer and the portal step.
 *  ponytail: recomputes propagate() alongside the form's own call; memoized, fine at this scale. */
export function ConsistencyStatus({ model, lookups, entries }: {
  model: ModelDef;
  lookups: ResolvedLookups;
  entries: Entries;
}) {
  const prop = useMemo(() => propagate(model, lookups, entries), [model, lookups, entries]);
  const conflict = prop.conflicts.length ? prop.conflicts.map((c) => c.message).join(" · ") : null;
  return (
    <ObjectStatus state={conflict ? "Negative" : "Positive"}>
      {conflict ?? `✓ Consistent · ${prop.open.length} open · ~${prop.candidateEstimate} candidate${prop.candidateEstimate === 1 ? "" : "s"}`}
    </ObjectStatus>
  );
}

const FORM_PROPS = { labelSpan: "S12 M4", layout: "S1 M1 L1 XL1", headerLevel: "H5" } as const;

export function ConfiguratorForm({ model, lookups, entries, onChange }: {
  model: ModelDef;
  lookups: ResolvedLookups;
  entries: Entries;
  onChange: (next: Entries) => void;
}) {
  const prop = useMemo(() => propagate(model, lookups, entries), [model, lookups, entries]);

  const set = (key: string, v: Val | undefined) => {
    const next = { ...entries };
    if (v === undefined) delete next[key];
    else next[key] = v;
    onChange(next);
  };

  const control = (key: string) => {
    const p = model.parameters.find((x) => x.key === key)!;
    const dom: DomainOption[] = prop.domains[key] ?? [];
    const v = prop.values[key];

    if (p.ui === "radio")
      return (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem 1rem" }}>
          {dom.map((o, i) => (
            <RadioButton key={i} name={`cfg-${key}`} text={o.label} checked={v === o.value}
              disabled={!!o.eliminatedBy}
              // tooltip is a runtime ui5 prop the React typing omits (like Option's disabled).
              {...(o.eliminatedBy ? ({ tooltip: `Unavailable: ${o.eliminatedBy}` } as Record<string, unknown>) : {})}
              onChange={() => set(key, o.value)} />
          ))}
        </div>
      );

    if (p.ui === "checkbox" || (p.type === "boolean" && p.ui !== "select"))
      return (
        <CheckBox checked={v === true}
          disabled={!!dom.find((o) => o.value === (v !== true))?.eliminatedBy}
          {...(() => {
            const t = dom.find((o) => !!o.eliminatedBy)?.eliminatedBy;
            return t ? ({ tooltip: t } as Record<string, unknown>) : {};
          })()}
          onChange={(e) => set(key, e.target.checked)} />
      );

    if (p.ui === "multicombo")
      return (
        // MultiComboBoxItem has no disabled prop -> eliminated options are filtered out.
        <MultiComboBox
          onSelectionChange={(e) => {
            const texts = e.detail.items.map((i) => (i as HTMLElement).getAttribute("text")!);
            set(key, texts.length ? texts : undefined);
          }}>
          {dom.filter((o) => !o.eliminatedBy).map((o, i) => (
            <MultiComboBoxItem key={i} text={String(o.value)} selected={Array.isArray(v) && v.includes(String(o.value))} />
          ))}
        </MultiComboBox>
      );

    if (p.ui === "step") {
      const r = p.domain?.kind === "range" ? p.domain : undefined;
      return (
        <StepInput value={typeof v === "number" ? v : undefined} min={r?.min} max={r?.max} step={r?.step ?? 1}
          onChange={(e) => set(key, e.target.value ?? undefined)} />
      );
    }

    if (dom.length) // select (and boolean-with-select)
      return (
        <Select value={v === undefined ? "" : JSON.stringify(v)}
          onChange={(e) => {
            const j = (e.detail.selectedOption as HTMLElement).dataset.j;
            set(key, j === undefined || j === "" ? undefined : (JSON.parse(j) as Val));
          }}>
          <Option value="" data-j="">—</Option>
          {dom.map((o, i) => (
            <Option key={i} value={JSON.stringify(o.value)} data-j={JSON.stringify(o.value)}
              tooltip={o.eliminatedBy ? `Unavailable: ${o.eliminatedBy}` : undefined}
              additionalText={o.eliminatedBy ? "unavailable" : undefined}
              // Option supports disabled at runtime (ListItemBase); the React typing omits it.
              {...(o.eliminatedBy ? ({ disabled: true } as Record<string, unknown>) : {})}>
              {o.label}
            </Option>
          ))}
        </Select>
      );

    return (
      <Input type={p.type === "number" ? "Number" : "Text"} value={v === undefined || v === null ? "" : String(v)}
        onChange={(e) => {
          const raw = e.target.value ?? "";
          set(key, raw === "" ? undefined : p.type === "number" ? Number(raw) : raw);
        }} />
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {model.structure.sections.map((s) => (
        <Form key={s.key} headerText={s.title} {...FORM_PROPS}>
          {s.groups.map((g) => (
            <FormGroup key={g.key} headerText={g.title}>
              {g.params.filter((k) => prop.visible[k]).map((k) => {
                const p = model.parameters.find((x) => x.key === k);
                if (!p) return null;
                return (
                  <FormItem key={k} labelContent={<Label>{p.label + (p.unit ? ` (${p.unit})` : "")}</Label>}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", width: "100%" }}>
                      {control(k)}
                      {prop.defaulted.has(k) ? <ObjectStatus state="Information">auto</ObjectStatus> : null}
                    </div>
                  </FormItem>
                );
              })}
            </FormGroup>
          ))}
        </Form>
      ))}
      {model.computed.length ? (
        <Form headerText="Computed" {...FORM_PROPS}>
          <FormGroup>
            {model.computed.map((c) => (
              <FormItem key={c.key} labelContent={<Label>{c.key}</Label>}>
                <Text>{String(prop.values[c.key] ?? "—")}</Text>
              </FormItem>
            ))}
          </FormGroup>
        </Form>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 2: Update PreviewPane.tsx**

The form no longer scrolls or renders a footer itself. Replace the `else { try { body = ... } }` block (lines 26–36) with:

```tsx
  else {
    try {
      body = (
        <>
          <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "0 1rem 1rem" }}>
            <ConfiguratorForm model={model} lookups={lookups.data} entries={entries} onChange={setEntries} />
          </div>
          <Bar design="Footer"
            startContent={<ConsistencyStatus model={model} lookups={lookups.data} entries={entries} />} />
        </>
      );
    } catch (e) {
      body = (
        <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>
          {e instanceof DslError ? e.message : String(e)}
        </MessageStrip>
      );
    }
  }
```

Update the import line: `import { ConfiguratorForm, ConsistencyStatus } from "./ConfiguratorForm.tsx";`

- [ ] **Step 3: Update StepConfigure.tsx**

Replace the final `return` (lines 29–40) with:

```tsx
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <ExtractPanel modelId={modelId} model={model} entries={entries} onChange={onChange} extract={extract} />
      <ConfiguratorForm model={model} lookups={lookups.data} entries={entries} onChange={onChange} />
      <Bar design="FloatingFooter"
        startContent={<ConsistencyStatus model={model} lookups={lookups.data} entries={entries} />}
        endContent={
          <Button design="Emphasized" disabled={conflicted || saving} onClick={onNext}
            tooltip={conflicted ? "Resolve the conflicts above first" : undefined}>
            {saving ? "Saving…" : "Next: batches"}
          </Button>
        } />
    </div>
  );
```

Update the import: `import { ConfiguratorForm, ConsistencyStatus } from "./ConfiguratorForm.tsx";`

- [ ] **Step 4: Typecheck**

Run: `bunx tsc --noEmit -p apps/web/tsconfig.json`
Expected: no errors. (`ConfigProcessPage` still compiles: it never passed `layout`.)

- [ ] **Step 5: Verify in dev server**

Run `bun run dev`, open `http://acme.lvh.me:5173` (log in, tenant with a model). Check: builder → model → Live preview shows sections as Form headers with grouped fields and the consistency line in the footer; a configuration's Configure step renders the same and the portal request wizard (if a portal model exists) still works.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/configurator/ConfiguratorForm.tsx apps/web/src/components/configurator/PreviewPane.tsx apps/web/src/components/configurator/StepConfigure.tsx
git commit -m "refactor(web): ConfiguratorForm renders Form/FormGroup/FormItem only; ConsistencyStatus extracted"
```

---

### Task 2: Extract BatchEditor from StepBatches

**Files:**
- Create: `apps/web/src/components/configurator/BatchEditor.tsx`
- Modify: `apps/web/src/components/configurator/StepBatches.tsx`

**Interfaces:**
- Produces: `BatchEditor({ batches, onChange }: { batches: number[]; onChange: (next: number[]) => void })` — Tokenizer + quantity StepInput + Add button. Task 5's merged Configure step uses it.

- [ ] **Step 1: Create BatchEditor.tsx**

```tsx
import { useState } from "react";
import { Button, Label, StepInput, Text, Token, Tokenizer } from "@ui5/webcomponents-react";

// The batch-quantity list editor shared by the internal Configure step and the portal wizard.
export function BatchEditor({ batches, onChange }: {
  batches: number[];
  onChange: (next: number[]) => void;
}) {
  const [qty, setQty] = useState(1);
  const add = () => {
    if (!batches.includes(qty)) onChange([...batches, qty].sort((a, b) => a - b));
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", width: "100%" }}>
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
    </div>
  );
}
```

- [ ] **Step 2: Rewrite StepBatches.tsx to use it**

```tsx
import { Bar, Button, MessageStrip, Text, Title } from "@ui5/webcomponents-react";
import { BatchEditor } from "./BatchEditor.tsx";

// Portal wizard "Quantities" step: the batch quantities to price. Each quantity becomes a
// column in the candidates matrix; setup cost is amortized across the batch by the engine.
export function StepBatches({ batches, onChange, onCalculate, running, error, staleRun }: {
  batches: number[];
  onChange: (next: number[]) => void;
  onCalculate: () => void;
  running: boolean;
  error: string | null;
  staleRun: boolean;
}) {
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
      <BatchEditor batches={batches} onChange={onChange} />
      <Bar design="FloatingFooter" endContent={
        <Button design="Emphasized" disabled={batches.length === 0 || running} onClick={onCalculate}>
          {running ? "Calculating…" : "Calculate"}
        </Button>
      } />
    </div>
  );
}
```

- [ ] **Step 3: Typecheck + commit**

Run: `bunx tsc --noEmit -p apps/web/tsconfig.json` — expected: no errors.

```bash
git add apps/web/src/components/configurator/BatchEditor.tsx apps/web/src/components/configurator/StepBatches.tsx
git commit -m "refactor(web): extract BatchEditor from StepBatches"
```

---

### Task 3: Extract CandidatesMatrix from StepCandidates

**Files:**
- Create: `apps/web/src/components/configurator/CandidatesMatrix.tsx`
- Modify: `apps/web/src/components/configurator/StepCandidates.tsx`

**Interfaces:**
- Produces: `CandidatesMatrix({ model, runEntries, candidates, selection, onToggle, capped, widest, onRowClick? })` where `candidates: PricedCandidate[]`, `onToggle: (candidateIdx: number, batchQty: number) => void`, `onRowClick?: (idx: number) => void`. Task 4's merged step uses it.

- [ ] **Step 1: Create CandidatesMatrix.tsx**

```tsx
import {
  MessageStrip, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, Text, ToggleButton,
} from "@ui5/webcomponents-react";
import type { Entries, ModelDef } from "@hera/config-engine";
import { bestByBatch, candidateLabel, fmt, isSelected, openKeys, type PricedCandidate, type Sel } from "./runView.ts";

// The signature view: rows = candidates (labeled by their open-parameter values), columns =
// batch quantities, every price cell IS the selection control. One pressed cell = one future
// quotation line. Green marks the lowest price per column.
export function CandidatesMatrix({ model, runEntries, candidates, selection, onToggle, capped, widest, onRowClick }: {
  model: ModelDef;
  runEntries: Entries;
  candidates: PricedCandidate[];
  selection: Sel[];
  onToggle: (candidateIdx: number, batchQty: number) => void;
  capped: boolean;
  widest?: { key: string; size: number };
  onRowClick?: (idx: number) => void;
}) {
  const keys = openKeys(model, runEntries, candidates);
  const best = bestByBatch(candidates);
  const batches = candidates[0]?.perBatch.map((b) => b.batchQty) ?? [];

  return (
    <>
      {capped ? (
        <MessageStrip design="Critical" hideCloseButton>
          Stopped at {candidates.length} candidates — go back and set more parameters
          {widest ? ` (${model.parameters.find((p) => p.key === widest.key)?.label ?? widest.key} is widest with ${widest.size} options)` : ""}.
        </MessageStrip>
      ) : null}
      <Table
        onRowClick={onRowClick ? (e) => onRowClick(Number((e.detail.row as HTMLElement).dataset.idx)) : undefined}
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
          <TableRow key={i} rowKey={String(i)} data-idx={String(i)} interactive={!!onRowClick}>
            <TableCell><Text>{candidateLabel(keys, c.assignment)}</Text></TableCell>
            {c.perBatch.map((b) => (
              <TableCell key={b.batchQty} horizontalAlign="End">
                <ToggleButton pressed={isSelected(selection, i, b.batchQty)}
                  design={best[b.batchQty] === i ? "Positive" : "Default"}
                  tooltip={best[b.batchQty] === i ? "Lowest price for this quantity" : undefined}
                  onClick={(e) => { e.stopPropagation(); onToggle(i, b.batchQty); }}>
                  {fmt(b.unitPrice)}
                </ToggleButton>
              </TableCell>
            ))}
          </TableRow>
        ))}
      </Table>
    </>
  );
}
```

- [ ] **Step 2: Rewrite StepCandidates.tsx around it**

```tsx
import { useState, type ReactNode } from "react";
import { Bar, Button, Text, Title } from "@ui5/webcomponents-react";
import type { Entries, ModelDef } from "@hera/config-engine";
import { candidateLabel, openKeys, type PricedCandidate, type Sel } from "./runView.ts";
import { CandidatesMatrix } from "./CandidatesMatrix.tsx";

// Portal wizard "Prices" step: the candidates matrix plus a read-only row-click detail.
export function StepCandidates({ model, runEntries, candidates, selection, onToggle, onNext, capped, widest, renderDetail, nextLabel }: {
  model: ModelDef;
  runEntries: Entries;
  candidates: PricedCandidate[];
  selection: Sel[];
  onToggle: (candidateIdx: number, batchQty: number) => void;
  onNext: () => void;
  capped: boolean;
  widest?: { key: string; size: number };
  renderDetail: (idx: number, label: string) => ReactNode;
  nextLabel?: string;
}) {
  const [detailIdx, setDetailIdx] = useState<number | null>(null);
  const keys = openKeys(model, runEntries, candidates);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <Title level="H5">Candidates</Title>
      <Text>
        Unit prices per batch quantity. Pick one or more cells to take into review — each picked
        cell becomes one quotation line. The green price is the lowest in its column.
      </Text>
      <CandidatesMatrix model={model} runEntries={runEntries} candidates={candidates}
        selection={selection} onToggle={onToggle} capped={capped} widest={widest}
        onRowClick={(i) => setDetailIdx(i === detailIdx ? null : i)} />
      {detailIdx !== null && candidates[detailIdx]
        ? renderDetail(detailIdx, candidateLabel(keys, candidates[detailIdx].assignment))
        : <Text style={{ opacity: 0.7 }}>Click a row to see its details.</Text>}
      <Bar design="FloatingFooter" endContent={
        <Button design="Emphasized" disabled={selection.length === 0} onClick={onNext}>
          {nextLabel ?? "Review selection"} ({selection.length})
        </Button>
      } />
    </div>
  );
}
```

- [ ] **Step 3: Typecheck + commit**

Run: `bunx tsc --noEmit -p apps/web/tsconfig.json` — expected: no errors.

```bash
git add apps/web/src/components/configurator/CandidatesMatrix.tsx apps/web/src/components/configurator/StepCandidates.tsx
git commit -m "refactor(web): extract CandidatesMatrix from StepCandidates"
```

---

### Task 4: StepCandidatesReview (merged candidates + editable outputs)

**Files:**
- Create: `apps/web/src/components/configurator/StepCandidatesReview.tsx`

**Interfaces:**
- Consumes: `CandidatesMatrix` (Task 3), `runView.ts` helpers, `computeOutputs` (engine).
- Produces: `StepCandidatesReview({ model, lookups, runEntries, candidates, selection, onToggle, onChange, capped, widest, onSave, saving, error, saved })` where `candidates: Candidate[]` (raw run candidates), `onToggle: (candidateIdx, batchQty) => void`, `onChange: (next: Sel[]) => void`. Task 5 mounts it.

- [ ] **Step 1: Create StepCandidatesReview.tsx**

The panel-rendering body is moved verbatim from `StepReview.tsx` (`panels` map, `rowStatus`, `rowActions`, `onAction`, `dim`, `rate`); only the wrapper and footer change. Full file:

```tsx
import {
  Bar, Button, Input, MessageStrip, ObjectStatus, Panel, StepInput, Table, TableCell,
  TableHeaderCell, TableHeaderRow, TableRow, TableRowAction, Text, Title,
} from "@ui5/webcomponents-react";
import { computeOutputs, type Entries, type ModelDef, type OutputOverrides, type Outputs, type ResolvedLookups } from "@hera/config-engine";
import {
  addBomLine, addOpLine, candidateLabel, fmt, isEdited, isRemoved, openKeys, patchAddedBom,
  patchAddedOp, patchBom, patchOp, removeAddedBom, removeAddedOp, resetLine, toPriced, withoutRemovals,
  type Candidate, type Sel,
} from "./runView.ts";
import { CandidatesMatrix } from "./CandidatesMatrix.tsx";

// Internal wizard step 2: the price matrix on top; each selected cell renders its editable
// output panel below. Two computeOutputs passes per panel: the display pass ignores remove
// flags (removed rows stay visible, struck through) and the totals pass applies everything —
// the numbers shown are exactly what the server will recompute and store on Save selection.
export function StepCandidatesReview({ model, lookups, runEntries, candidates, selection, onToggle, onChange, capped, widest, onSave, saving, error, saved }: {
  model: ModelDef;
  lookups: ResolvedLookups;
  runEntries: Entries;
  candidates: Candidate[];
  selection: Sel[];
  onToggle: (candidateIdx: number, batchQty: number) => void;
  onChange: (next: Sel[]) => void;
  capped: boolean;
  widest?: { key: string; size: number };
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
      <Text>
        Unit prices per batch quantity — pick one or more cells; each picked cell becomes one
        quotation line and can be adjusted below. Totals recompute as you type; saving stores the
        selection and the server recomputes every number from the run snapshot.
      </Text>
      <CandidatesMatrix model={model} runEntries={runEntries} candidates={candidates.map(toPriced)}
        selection={selection} onToggle={onToggle} capped={capped} widest={widest} />
      {error ? <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip> : null}
      {saved ? <MessageStrip design="Positive" hideCloseButton>Selection saved — totals recomputed on the server.</MessageStrip> : null}
      {panels}
      <Bar design="FloatingFooter" className="hera-step-bar"
        startContent={
          <Text>
            Total across {selection.length} line{selection.length === 1 ? "" : "s"}: <span style={{ fontWeight: 700 }}>{fmt(grand)}</span>
          </Text>
        }
        endContent={
          <Button design="Emphasized" disabled={saving || selection.length === 0} onClick={onSave}>
            {saving ? "Saving…" : "Save selection"}
          </Button>
        } />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `bunx tsc --noEmit -p apps/web/tsconfig.json` — expected: no errors (component not yet mounted; that's Task 5).

```bash
git add apps/web/src/components/configurator/StepCandidatesReview.tsx
git commit -m "feat(web): merged candidates+review step component"
```

---

### Task 5: ConfigProcessPage — 3 steps, full height, header overlay

**Files:**
- Modify: `apps/web/src/components/configurator/ConfigProcessPage.tsx` (full rewrite below)
- Create: `apps/web/src/components/configurator/ConfigProcessPage.css`
- Delete: `apps/web/src/components/configurator/StepReview.tsx`, `apps/web/src/components/configurator/CandidateDetail.tsx`

**Interfaces:**
- Consumes: `ConfiguratorForm`/`ConsistencyStatus` (Task 1), `BatchEditor` (Task 2), `StepCandidatesReview` (Task 4), `ExtractPanel`, `runView` helpers.
- Produces: nothing consumed later; this is the page.

- [ ] **Step 1: Create ConfigProcessPage.css**

```css
/* Full-height wizard: the wrapper owns the header overlay; step bars stick to the bottom
   of the wizard scroll area. */
.hera-wizard-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.hera-wizard {
  flex: 1;
  min-height: 0;
}
/* Reserve room on the right of the steps bar for the overlay header. */
.hera-wizard::part(navigator) {
  padding-inline-end: 24rem;
}
.hera-wizard-header {
  position: absolute;
  top: 0;
  right: 1rem;
  height: 4rem; /* matches the rendered navigator height; tune if the theme changes it */
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.hera-step-bar {
  position: sticky;
  bottom: 0;
  z-index: 2;
}
```

- [ ] **Step 2: Rewrite ConfigProcessPage.tsx**

```tsx
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar, Button, BusyIndicator, Dialog, Form, FormGroup, FormItem, Label, MessageStrip,
  ObjectStatus, Text, TextArea, Title, Wizard, WizardStep,
} from "@ui5/webcomponents-react";
import { propagate, type Entries } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";
import { cleanOverrides, statusUi, toggleSelection, type Sel } from "./runView.ts";
import { ConfiguratorForm, ConsistencyStatus } from "./ConfiguratorForm.tsx";
import { ExtractPanel } from "./ExtractPanel.tsx";
import { BatchEditor } from "./BatchEditor.tsx";
import { StepCandidatesReview } from "./StepCandidatesReview.tsx";
import "./ConfigProcessPage.css";

// The configuration process: 3 steps, gated left to right. Step 1 (Configure) works on live
// model + lookups and includes the batch quantities; step 2 (Candidates) renders ONLY from the
// immutable run snapshot, with the editable outputs of every selected cell inline. Local state
// overlays server state (override ?? server value) until a mutation persists it.
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
  const [rejectOpen, setRejectOpen] = useState(false);
  const [note, setNote] = useState("");

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: orpc.configs.get.queryOptions({ input: { id } }).queryKey });
  const update = useMutation(orpc.configs.update.mutationOptions({ onSuccess: invalidate }));
  const reject = useMutation(orpc.configs.reject.mutationOptions({
    onSuccess: () => { setRejectOpen(false); invalidate(); },
  }));
  const run = useMutation(
    orpc.configs.run.mutationOptions({
      onSuccess: (r) => {
        setRunMeta({ capped: r.capped, widest: r.widest });
        setSel([]); // a new run invalidates any previous candidate picks
        invalidate();
        setStep(1);
      },
    }),
  );
  const select = useMutation(orpc.configs.select.mutationOptions({ onSuccess: invalidate }));

  if (q.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;
  if (q.error)
    return <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>{q.error.message}</MessageStrip>;
  const { project, model, latestRun, createdByEmail } = q.data;

  const entries = entriesOverride ?? project.entries;
  const batches = batchesOverride ?? project.batches;
  const selection = selOverride ?? latestRun?.selection ?? [];
  const runReady = !!latestRun && project.status !== "draft";
  const step = stepOverride ?? (project.status === "draft" ? 0 : 1);

  // ConsistencyStatus renders the message; prop here only gates Calculate/navigation.
  const prop = lookups.data ? propagate(model.definition, lookups.data, entries) : null;
  const conflicted = !!prop && prop.conflicts.length > 0;
  const entriesDirty = JSON.stringify(entries) !== JSON.stringify(project.entries);
  const batchesDirty = JSON.stringify(batches) !== JSON.stringify(project.batches);
  const staleRun = !!latestRun && (project.status === "draft" || entriesDirty || batchesDirty);

  const goto = (i: number) => {
    if (step === 0 && i !== 0 && (entriesDirty || batchesDirty)) update.mutate({ id, entries, batches });
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

  const configureBody = lookups.isPending ? (
    <BusyIndicator active delay={200} style={{ width: "100%", marginTop: "3rem" }} />
  ) : lookups.error ? (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <MessageStrip design="Negative" hideCloseButton>{lookups.error.message}</MessageStrip>
      <Button style={{ alignSelf: "start" }} onClick={() => lookups.refetch()}>Retry</Button>
    </div>
  ) : (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <ExtractPanel modelId={project.modelId} model={model.definition} entries={entries} onChange={setEntries} />
      <ConfiguratorForm model={model.definition} lookups={lookups.data} entries={entries} onChange={setEntries} />
      <Form headerText="Batch quantities" headerLevel="H5" labelSpan="S12 M4" layout="S1 M1 L1 XL1">
        <FormGroup>
          <FormItem labelContent={<Label>Quantities</Label>}>
            <BatchEditor batches={batches} onChange={setBatches} />
          </FormItem>
        </FormGroup>
      </Form>
      {update.error || run.error ? (
        <MessageStrip design="Negative" hideCloseButton>{update.error?.message ?? run.error?.message}</MessageStrip>
      ) : null}
      <Bar design="FloatingFooter" className="hera-step-bar"
        startContent={
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <ConsistencyStatus model={model.definition} lookups={lookups.data} entries={entries} />
            {staleRun ? <ObjectStatus state="Critical">inputs changed — calculate again</ObjectStatus> : null}
          </div>
        }
        endContent={
          <Button design="Emphasized"
            disabled={conflicted || batches.length === 0 || update.isPending || run.isPending}
            onClick={() => void calculate()}>
            {update.isPending || run.isPending ? "Calculating…" : "Calculate"}
          </Button>
        } />
    </div>
  );

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {project.status === "requested" ? (
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", margin: "0.5rem 1rem" }}>
          <MessageStrip design="Critical" hideCloseButton style={{ flex: 1 }}>
            Requested by {createdByEmail ?? "a portal user"} for {project.customer?.cardName ?? "—"} —
            review the configuration, then create the quotation or reject with a note.
          </MessageStrip>
          <Button design="Negative" onClick={() => setRejectOpen(true)}>Reject</Button>
        </div>
      ) : null}
      <div className="hera-wizard-wrap">
        <div className="hera-wizard-header">
          <Title level="H5">{project.name}</Title>
          <Text>{model.name}</Text>
          <ObjectStatus state={statusUi[project.status].state}>{statusUi[project.status].text}</ObjectStatus>
        </div>
        <Wizard className="hera-wizard" contentLayout="SingleStep"
          onStepChange={(e) => goto(Number((e.detail.step as HTMLElement).dataset.idx))}>
          <WizardStep titleText="Configure" icon="settings" data-idx="0" selected={step === 0}>
            {configureBody}
          </WizardStep>
          <WizardStep titleText="Candidates" icon="grid" data-idx="1" selected={step === 1} disabled={!runReady}>
            {runReady && latestRun ? (
              <StepCandidatesReview model={latestRun.modelSnapshot} lookups={latestRun.lookupSnapshot}
                runEntries={latestRun.entries} candidates={latestRun.candidates}
                selection={selection}
                onToggle={(i, b) => setSel(toggleSelection(selection, i, b))}
                onChange={setSel}
                capped={runMeta?.capped ?? latestRun.candidates.length >= 200}
                widest={runMeta?.widest}
                onSave={saveSelection} saving={select.isPending}
                error={select.error?.message ?? null} saved={select.isSuccess} />
            ) : null}
          </WizardStep>
          <WizardStep titleText="Create quote" icon="sales-quote" data-idx="2" disabled>
            <Text>Available after review — coming in phase 5.</Text>
          </WizardStep>
        </Wizard>
      </div>

      <Dialog open={rejectOpen} headerText="Reject request" onClose={() => setRejectOpen(false)}
        footer={
          <Bar design="Footer" endContent={
            <>
              <Button design="Negative" disabled={!note.trim() || reject.isPending}
                onClick={() => reject.mutate({ id, note: note.trim() })}>
                {reject.isPending ? "Rejecting…" : "Reject with note"}
              </Button>
              <Button onClick={() => setRejectOpen(false)}>Cancel</Button>
            </>
          } />
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", padding: "0.5rem 0" }}>
          {reject.error ? <MessageStrip design="Negative" hideCloseButton>{reject.error.message}</MessageStrip> : null}
          <Label for="reject-note" required>What should the client change?</Label>
          <TextArea id="reject-note" rows={4} value={note} onInput={(e) => setNote(e.target.value)} />
        </div>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 3: Delete dead files**

```bash
git rm apps/web/src/components/configurator/StepReview.tsx apps/web/src/components/configurator/CandidateDetail.tsx
```

(`CandidateDetail` was only used by this page; the portal has `PortalCandidateDetail`. Verify with a grep before deleting: `grep -r "CandidateDetail\b" apps/web/src --include="*.tsx" -l` should list only `PortalCandidateDetail.tsx`, `PortalRequestPage.tsx` (its own detail) and the two files being deleted.)

- [ ] **Step 4: Typecheck**

Run: `bunx tsc --noEmit -p apps/web/tsconfig.json` — expected: no errors.

- [ ] **Step 5: Verify in dev server**

`bun run dev`, open a configuration on the tenant host. Check: 3 steps; project name/model/status visible at the top-right inside the steps bar row; Configure shows form + batch quantities with the consistency line + Calculate in one sticky bottom bar; Calculate lands on Candidates; toggling a price cell shows its editable panel below the matrix; Save selection persists; the grand total sits left in the sticky bar; the requested-status banner + Reject dialog still work; step content scrolls under the sticky bar.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/configurator/ConfigProcessPage.tsx apps/web/src/components/configurator/ConfigProcessPage.css
git commit -m "feat(web): 3-step full-height config wizard with overlay header and sticky step bars"
```

---

### Task 6: Engine — LookupRef schema change + column helpers

**Files:**
- Modify: `packages/config-engine/src/model.ts:9-27` (LookupRefZ) + append helpers
- Modify: `packages/config-engine/src/index.ts` (export helpers)
- Test: `packages/config-engine/test/model.test.ts` (additions)

**Interfaces:**
- Produces: `LookupRef` query variant is now `{ source: "query"; table: string; valueCol: string; labelCol?: string; columns?: string[] }`; table variant gains `columns?: string[]`. Helpers `refColumns(ref: LookupRef, all: string[] | undefined): string[]` and `derivedKey(paramKey: string, col: string): string`. Tasks 7, 8, 9, 10, 12, 13 use these names exactly.

- [ ] **Step 1: Write failing tests**

Append to `packages/config-engine/test/model.test.ts`:

```ts
import { LookupRefZ, refColumns, derivedKey } from "../src/model";

describe("LookupRef columns", () => {
  it("accepts named-source query refs and rejects the old inline shape", () => {
    expect(LookupRefZ.safeParse({ source: "query", table: "items", valueCol: "ItemCode" }).success).toBe(true);
    expect(LookupRefZ.safeParse({ source: "query", target: "b1", path: "/Items", valueField: "ItemCode" }).success).toBe(false);
    expect(LookupRefZ.safeParse({ source: "table", table: "mats", valueCol: "code", columns: ["density"] }).success).toBe(true);
  });

  it("refColumns defaults to all source columns except valueCol", () => {
    const ref = { source: "table", table: "mats", valueCol: "code" } as const;
    expect(refColumns(ref, ["code", "density", "name"])).toEqual(["density", "name"]);
    expect(refColumns({ ...ref, columns: ["density"] }, ["code", "density", "name"])).toEqual(["density"]);
    expect(refColumns({ ...ref, columns: ["density"] }, undefined)).toEqual(["density"]);
    expect(refColumns(ref, undefined)).toEqual([]);
    expect(refColumns({ source: "manual", options: [] }, ["x"])).toEqual([]);
  });

  it("derivedKey joins with underscore", () => {
    expect(derivedKey("material", "density")).toBe("material_density");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test:engine`
Expected: FAIL — `refColumns` not exported / old query shape still accepted.

- [ ] **Step 3: Implement**

In `model.ts`, replace the query variant of `LookupRefZ` and add `columns` to the table variant:

```ts
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
    /** extra columns exposed as `<param>_<col>` and shown in pickers; absent = all except valueCol */
    columns: z.array(z.string()).optional(),
  }),
  z.object({
    source: z.literal("query"),
    /** names a ModelDef.queryTables entry — the query itself is defined there */
    table: z.string(),
    valueCol: z.string(),
    labelCol: z.string().optional(),
    columns: z.array(z.string()).optional(),
  }),
]);
```

Append after the `Entries` type at the bottom of `model.ts`:

```ts
/** The source columns a ref exposes (display + derived values). */
export function refColumns(ref: LookupRef, all: string[] | undefined): string[] {
  if (ref.source === "manual") return [];
  if (ref.columns) return ref.columns;
  return (all ?? []).filter((c) => c !== ref.valueCol);
}

/** Derived value key for a param's source column, e.g. material_density. */
export const derivedKey = (paramKey: string, col: string) => `${paramKey}_${col}`;
```

In `index.ts`, add `refColumns` and `derivedKey` to the exports from `./model`.

- [ ] **Step 4: Run tests**

Run: `bun run test:engine`
Expected: model.test.ts PASSES. Other engine tests still pass (no fixture uses a query ref). If any fail, fix before committing.

- [ ] **Step 5: Commit**

```bash
git add packages/config-engine/src/model.ts packages/config-engine/src/index.ts packages/config-engine/test/model.test.ts
git commit -m "feat(engine): query refs name a queryTable; table/query refs carry display columns"
```

---

### Task 7: Engine — derived values in bindings()

**Files:**
- Modify: `packages/config-engine/src/propagate.ts:22-65` (bindings)
- Test: `packages/config-engine/test/propagate.test.ts` (additions)

**Interfaces:**
- Consumes: `refColumns`, `derivedKey` (Task 6).
- Produces: `bindings()` (and therefore `propagate`, `enumerate`, `computeOutputs`) exposes `<param>_<col>` in `values` whenever the param is set and its value's row exists in the source table. Missing row / unset param → key absent (undecidable, like an unbound param).

- [ ] **Step 1: Write failing tests**

Append to `packages/config-engine/test/propagate.test.ts`:

```ts
import type { ModelDef, ResolvedLookups } from "../src/model";
import { bindings } from "../src/propagate";

const dModel: ModelDef = {
  name: "derived",
  parameters: [
    {
      key: "mat", label: "Material", type: "string", ui: "select",
      domain: { kind: "options", ref: { source: "table", table: "mats", valueCol: "code" } },
    },
  ],
  structure: { sections: [{ key: "s", title: "S", groups: [{ key: "g", title: "G", params: ["mat"] }] }] },
  computed: [{ key: "dbl", expr: "mat_density * 2" }],
  constraints: [], bom: [], routing: [], queryTables: [],
  pricing: { priceExpr: "0", quoteItemCode: "X" },
  batchDefaults: [1],
};
const dLookups: ResolvedLookups = {
  domains: { mat: [{ value: "ST", label: "Steel" }, { value: "AL", label: "Alu" }] },
  tables: { mats: { columns: ["code", "density", "name"], rows: [["ST", 7.9, "Steel"], ["AL", 2.7, "Alu"]] } },
};

describe("derived lookup columns", () => {
  it("exposes <param>_<col> for the selected row and feeds computed values", () => {
    const b = bindings(dModel, dLookups, { mat: "ST" });
    expect(b.values.mat_density).toBe(7.9);
    expect(b.values.mat_name).toBe("Steel");
    expect(b.values.dbl).toBe(15.8);
  });

  it("leaves derived keys absent while the param is unset or the row is missing", () => {
    expect("mat_density" in bindings(dModel, dLookups, {}).values).toBe(false);
    expect("mat_density" in bindings(dModel, dLookups, { mat: "NOPE" }).values).toBe(false);
  });

  it("honours an explicit columns subset", () => {
    const m: ModelDef = structuredClone(dModel);
    (m.parameters[0]!.domain as { kind: "options"; ref: { source: "table"; table: string; valueCol: string; columns?: string[] } }).ref.columns = ["density"];
    m.computed = [];
    const b = bindings(m, dLookups, { mat: "AL" });
    expect(b.values.mat_density).toBe(2.7);
    expect("mat_name" in b.values).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test:engine`
Expected: FAIL — `mat_density` undefined.

- [ ] **Step 3: Implement in bindings()**

In `propagate.ts`, import the helpers: `import { refColumns, derivedKey } from "./model";` (adjust the existing type-only import so `refColumns`/`derivedKey` are value imports). Then inside the fixpoint loop of `bindings()` (after the `for (const c of model.computed)` block, still inside `for (let iter...)`), add a third pass:

```ts
    // derived lookup columns: <param>_<col> from the selected value's source row
    for (const p of model.parameters) {
      const ref = p.domain?.kind === "options" ? p.domain.ref : undefined;
      if (!ref || ref.source === "manual" || !(p.key in values)) continue;
      const t = lookups.tables[ref.table];
      if (!t) continue;
      const vi = t.columns.indexOf(ref.valueCol);
      const row = vi < 0 ? undefined : t.rows.find((r) => r[vi] === values[p.key]);
      if (!row) continue; // unset/stale value: derived keys stay absent (undecidable, like unbound)
      for (const col of refColumns(ref, t.columns)) {
        const ci = t.columns.indexOf(col);
        const v = ci < 0 ? null : (row[ci] ?? null);
        const dk = derivedKey(p.key, col);
        if (values[dk] !== v) {
          values[dk] = v;
          changed = true;
        }
      }
    }
```

Also widen the iteration bound so a default → derived → computed chain converges — replace `const maxIter = model.parameters.length + model.computed.length + 1;` with:

```ts
  const maxIter = model.parameters.length * 2 + model.computed.length + 2;
```

- [ ] **Step 4: Run tests**

Run: `bun run test:engine`
Expected: all PASS (including existing propagate/enumerate/output tests — derived pass is a no-op for manual-source fixtures).

- [ ] **Step 5: Commit**

```bash
git add packages/config-engine/src/propagate.ts packages/config-engine/test/propagate.test.ts
git commit -m "feat(engine): derive <param>_<col> values from table/query lookups in bindings"
```

---

### Task 8: Engine — checkModel validates refs and derived keys

**Files:**
- Modify: `packages/config-engine/src/check.ts:36-50` (signature + scope) and `:139-167` (LOOKUP tables set)
- Modify: `packages/config-engine/test/check.test.ts` (signature updates + new tests)
- Modify: `apps/web/src/components/configurator/useDraftModel.ts:41` (caller)
- Modify: `apps/server/src/orpc/routers/models.ts:60` (caller)

**Interfaces:**
- Produces: `checkModel(model: ModelDef, knownTables: KnownTable[] = [])` with `export type KnownTable = { name: string; columns: string[] }`. New issue paths: `parameters[i].domain` (unknown table / unknown column), `model` (derived-key collision). Derived keys join the expression scope. Task 12/13 rely on `KnownTable`.

- [ ] **Step 1: Update existing tests + add new ones**

In `check.test.ts`, replace every `["prices"]` argument with `[{ name: "prices", columns: ["code", "price"] }]` (7 call sites). Then append:

```ts
import type { ModelDef } from "../src/model";

describe("lookup ref validation", () => {
  const withRef = (ref: object, extra: Partial<ModelDef> = {}): ModelDef => ({
    ...structuredClone(model),
    parameters: [
      ...structuredClone(model).parameters,
      { key: "pick", label: "Pick", type: "string", ui: "select", domain: { kind: "options", ref: ref as never } },
    ],
    ...extra,
  });

  it("flags a ref to an unknown table", () => {
    const issues = checkModel(withRef({ source: "table", table: "ghost", valueCol: "x" }), [{ name: "prices", columns: ["code", "price"] }]);
    expect(issues.some((i) => i.message.includes("unknown table 'ghost'"))).toBe(true);
  });

  it("flags unknown columns in a ref", () => {
    const issues = checkModel(withRef({ source: "table", table: "prices", valueCol: "nope", columns: ["alsoNope"] }), [{ name: "prices", columns: ["code", "price"] }]);
    expect(issues.some((i) => i.message.includes("no column 'nope'"))).toBe(true);
    expect(issues.some((i) => i.message.includes("no column 'alsoNope'"))).toBe(true);
  });

  it("puts derived keys in scope and flags collisions", () => {
    const ok = checkModel(
      withRef({ source: "table", table: "prices", valueCol: "code" }, { computed: [{ key: "p2", expr: "pick_price * 2" }] }),
      [{ name: "prices", columns: ["code", "price"] }],
    );
    expect(ok).toEqual([]);
    const collide = checkModel(
      withRef({ source: "table", table: "prices", valueCol: "code" }, { computed: [{ key: "pick_price", expr: "1" }] }),
      [{ name: "prices", columns: ["code", "price"] }],
    );
    expect(collide.some((i) => i.message.includes("collides"))).toBe(true);
  });

  it("resolves query refs against model.queryTables", () => {
    const m = withRef({ source: "query", table: "items", valueCol: "ItemCode" });
    m.queryTables = [{ name: "items", target: "b1", path: "/Items", columns: ["ItemCode", "ItemName"] }];
    expect(checkModel(m, [{ name: "prices", columns: ["code", "price"] }])).toEqual([]);
  });
});
```

(`withRef` extends the fixture's `model` — `pick` must also be placed in structure or the structure check fires; the fixture only checks placed params, unplaced is fine. If `checkModel` returns a "not placed" style issue — it does not today — adjust; unplaced params are allowed.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test:engine`
Expected: FAIL — type error on the new `knownTables` shape / missing validations.

- [ ] **Step 3: Implement**

In `check.ts`:

```ts
import { refColumns, derivedKey, type ModelDef } from "./model";

export type KnownTable = { name: string; columns: string[] };

export function checkModel(model: ModelDef, knownTables: KnownTable[] = []): Issue[] {
```

After the duplicate-key loop and **before** `const base = new Set(...)` (line ~47), insert:

```ts
  // lookup refs: table/query names, columns, and the derived keys they add to scope
  const tableCols = new Map<string, string[]>([
    ...knownTables.map((t) => [t.name, t.columns] as const),
    ...model.queryTables.map((t) => [t.name, t.columns] as const),
  ]);
  const derived: string[] = [];
  const baseKeys = new Set([...paramKeys, ...computedKeys]);
  model.parameters.forEach((p, i) => {
    const ref = p.domain?.kind === "options" ? p.domain.ref : undefined;
    if (!ref || ref.source === "manual") return;
    const cols = tableCols.get(ref.table);
    if (!cols) {
      issues.push({ path: `parameters[${i}].domain`, message: `unknown table '${ref.table}'` });
      return;
    }
    for (const c of [ref.valueCol, ...(ref.labelCol ? [ref.labelCol] : []), ...(ref.columns ?? [])]) {
      if (!cols.includes(c)) issues.push({ path: `parameters[${i}].domain`, message: `table '${ref.table}' has no column '${c}'` });
    }
    for (const col of refColumns(ref, cols)) {
      const dk = derivedKey(p.key, col);
      if (baseKeys.has(dk)) issues.push({ path: "model", message: `derived value '${dk}' collides with an existing key` });
      derived.push(dk);
    }
  });
```

Then change the scope line to include derived keys:

```ts
  const base = new Set([...paramKeys, ...computedKeys, ...derived]);
```

And in the LOOKUP static check (line ~140), update: `const tables = new Set([...knownTables.map((t) => t.name), ...model.queryTables.map((t) => t.name)]);`

- [ ] **Step 4: Update the two callers**

`apps/web/src/components/configurator/useDraftModel.ts:41`:

```ts
  const issues = useMemo(
    () => (draft ? checkModel(draft, tables.map((t) => ({ name: t.name, columns: (t.columns as { key: string }[]).map((c) => c.key) }))) : []),
    [draft, tables],
  );
```

`apps/server/src/orpc/routers/models.ts:60`:

```ts
      const known = (await tenantTables(context.tenantId)).map((t) => ({ name: t.name, columns: t.columns.map((c) => c.key) }));
```

- [ ] **Step 5: Run engine + server tests, typecheck web**

Run: `bun run test:engine` — expected: PASS.
Run: `bun run test:server` — expected: PASS except any test using the **old inline query ref shape** (`lookups.test.ts`, `configurator.test.ts`) which Task 9 fixes — if they fail only on the ref shape, proceed; Task 9 lands immediately after.
Run: `bunx tsc --noEmit -p apps/web/tsconfig.json` — expected: errors only in `ParamsTab.tsx` (old `QueryRefEditor` shape). **Do not fix here** — Task 12 rewrites that file; if you need a green typecheck for the commit, leave `ParamsTab.tsx` untouched only if it compiles; otherwise apply the minimal shim: change `setKind`'s query branch (ParamsTab.tsx:341) to `onChange({ kind: "options", ref: { source: "query", table: "", valueCol: "" } })` and change `QueryRefEditor` to render nothing:

```tsx
function QueryRefEditor(_: { ref_: Extract<LookupRef, { source: "query" }>; onChange: (r: LookupRef) => void }) {
  return <Text>Define the query under Tables, then pick it here (editor lands with the Tables rework).</Text>;
}
```

- [ ] **Step 6: Commit**

```bash
git add packages/config-engine/src/check.ts packages/config-engine/test/check.test.ts apps/web/src/components/configurator/useDraftModel.ts apps/web/src/components/configurator/ParamsTab.tsx apps/server/src/orpc/routers/models.ts
git commit -m "feat(engine): checkModel validates lookup refs, columns and derived-key collisions"
```

---

### Task 9: Server — unified lookup resolution + lookupPreview with queryTables

**Files:**
- Modify: `apps/server/src/lookups.ts` (optionsFromRef sync; addQueryTables export)
- Modify: `apps/server/src/orpc/routers/models.ts:146-152` (lookupPreview)
- Test: `apps/server/test/lookups.test.ts`, `apps/server/test/configurator.test.ts` (fixture updates)

**Interfaces:**
- Produces: `optionsFromRef(ref: LookupRef, tables: Record<string, ResolvedTable>): Option[]` (now **sync**, no fetcher). `addQueryTables(tables, queryTables, fetchQuery): Promise<void>` mutates `tables` in place. `models.lookupPreview` input gains `queryTables?: ModelDef["queryTables"]`. Tasks 11/12 call `client.models.lookupPreview({ ref, queryTables, limit })`.

- [ ] **Step 1: Update server tests first**

In `apps/server/test/lookups.test.ts`, replace the query-ref cases (lines ~60-95) with the named-source equivalents:

```ts
  it("resolves query domains from a fetched queryTable", async () => {
    const tables: Record<string, ResolvedTable> = {};
    await addQueryTables(tables, [{ name: "items", target: "b1", path: "/Items?$select=ItemCode,ItemName", columns: ["ItemCode", "ItemName"] }],
      async () => ({ value: [{ ItemCode: "A1", ItemName: "Widget" }] }));
    const opts = optionsFromRef({ source: "query", table: "items", valueCol: "ItemCode", labelCol: "ItemName" }, tables);
    expect(opts).toEqual([{ value: "A1", label: "Widget" }]);
  });

  it("throws on a non-array query payload", async () => {
    await expect(
      addQueryTables({}, [{ name: "bad", target: "beas", path: "/bad", columns: ["x"] }], async () => ({ oops: 1 })),
    ).rejects.toThrow("did not return a row array");
  });
```

Update the `resolveLookups` test's model (line ~91) so the domain ref is `{ source: "query", table: "items", valueCol: "Code" }` and the model's `queryTables` contains `{ name: "items", target: "b1", path: "/Items", columns: ["Code"] }`. Keep the assertion that a query domain and a queryTable sharing one path issue **one** fetch (the memoization) — with the ref now reading from the fetched table this is inherent; keep or simplify the assertion accordingly.

In `apps/server/test/configurator.test.ts:19`, change the param domain to `{ kind: "options", ref: { source: "query", table: "items", valueCol: "ItemCode" } }` and add to that model `queryTables: [{ name: "items", target: "b1", path: "/Items?$select=ItemCode", columns: ["ItemCode"] }]`.

- [ ] **Step 2: Run to verify failure**

Run: `bun run test:server`
Expected: FAIL — `addQueryTables` not exported; `optionsFromRef` arity.

- [ ] **Step 3: Implement lookups.ts**

Replace `optionsFromRef` and `resolveLookups`:

```ts
export function optionsFromRef(ref: LookupRef, tables: Record<string, ResolvedTable>): Option[] {
  if (ref.source === "manual") return ref.options.map((o) => ({ value: o.value, label: o.label ?? String(o.value) }));
  const t = tables[ref.table];
  if (!t) throw new Error(`Unknown lookup table '${ref.table}'`);
  return project(t, ref.table, ref.valueCol, ref.labelCol);
}

/** Fetch each queryTable and add it to `tables` (mutates in place). */
export async function addQueryTables(
  tables: Record<string, ResolvedTable>,
  queryTables: ModelDef["queryTables"],
  fetchQuery: QueryFetcher,
): Promise<void> {
  for (const qt of queryTables) {
    const rows = rowsOf(await fetchQuery(qt.target, qt.path), qt.target, qt.path);
    tables[qt.name] = { columns: qt.columns, rows: rows.map((r) => qt.columns.map((c) => asVal(r[c]))) };
  }
}

export async function resolveLookups(
  model: ModelDef,
  tenantTables: TenantTable[],
  fetchQuery: QueryFetcher,
): Promise<ResolvedLookups> {
  // Memoize per (target, path): two queryTables may share one GET.
  const fetched = new Map<string, Promise<unknown>>();
  const fetchOnce: QueryFetcher = (target, path) => {
    const k = `${target} ${path}`;
    let p = fetched.get(k);
    if (!p) fetched.set(k, (p = fetchQuery(target, path)));
    return p;
  };

  const tables = tablesFromTenant(tenantTables);
  await addQueryTables(tables, model.queryTables, fetchOnce);

  const domains: ResolvedLookups["domains"] = {};
  for (const p of model.parameters) {
    if (p.domain?.kind !== "options") continue;
    domains[p.key] = optionsFromRef(p.domain.ref, tables);
  }
  return { domains, tables };
}
```

- [ ] **Step 4: Update models.lookupPreview**

```ts
  // Builder "Preview" button: resolve any LookupRef against live sources, first N options.
  // Query refs read from queryTables, so the (unsaved) draft's queryTables ride along.
  lookupPreview: adminProcedure
    .input(z.object({
      ref: LookupRefZ,
      queryTables: ModelDefZ.shape.queryTables.optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }))
    .handler(async ({ input, context }) => {
      const tables = tablesFromTenant(await tenantTables(context.tenantId));
      await addQueryTables(tables, input.queryTables ?? [], agentFetcher(context.tenantId));
      const options = optionsFromRef(input.ref, tables);
      return { options: options.slice(0, input.limit) };
    }),
```

Update the import line to include `addQueryTables`.

- [ ] **Step 5: Run server tests**

Run: `bun run test:server`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/lookups.ts apps/server/src/orpc/routers/models.ts apps/server/test/lookups.test.ts apps/server/test/configurator.test.ts
git commit -m "feat(server): named-source lookup resolution; lookupPreview accepts draft queryTables"
```

---

### Task 10: Web — ValueHelpDialog + runtime controls per source

**Files:**
- Create: `apps/web/src/components/configurator/ValueHelpDialog.tsx`
- Modify: `apps/web/src/components/configurator/ConfiguratorForm.tsx` (query control + table Select columns)

**Interfaces:**
- Consumes: `refColumns` (Task 6), resolved `lookups.tables` (rows available client-side for both sources).
- Produces: `ValueHelpDialog({ open, headerText, table, valueCol, columns, hiddenValues, onSelect, onClose })` — `onSelect(v: Val | undefined)`; row click picks, footer has Clear + Cancel.

- [ ] **Step 1: Create ValueHelpDialog.tsx**

```tsx
import { useMemo, useState } from "react";
import {
  Bar, Button, Dialog, Icon, Input, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, Text,
} from "@ui5/webcomponents-react";
import type { ResolvedTable, Val } from "@hera/config-engine";

// Fiori-style value help for query-sourced parameters: search across every displayed column,
// click a row to pick it. ponytail: client-side filter over already-resolved rows; move the
// search server-side if a query ever returns thousands of rows.
export function ValueHelpDialog({ open, headerText, table, valueCol, columns, hiddenValues, onSelect, onClose }: {
  open: boolean;
  headerText: string;
  table: ResolvedTable;
  valueCol: string;
  /** extra display columns (without valueCol) */
  columns: string[];
  /** values eliminated by constraints — not offered */
  hiddenValues?: Set<Val>;
  onSelect: (v: Val | undefined) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const shown = [valueCol, ...columns];
  const idx = shown.map((c) => table.columns.indexOf(c));
  const vi = table.columns.indexOf(valueCol);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return table.rows.filter((r) => {
      if (vi < 0 || (hiddenValues?.has(r[vi] ?? null) ?? false)) return false;
      return !needle || idx.some((i) => i >= 0 && String(r[i] ?? "").toLowerCase().includes(needle));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, q, hiddenValues]);

  return (
    <Dialog open={open} headerText={headerText} onClose={onClose} style={{ width: "min(52rem, 95vw)" }}
      footer={
        <Bar design="Footer" endContent={
          <>
            <Button onClick={() => { onSelect(undefined); onClose(); }}>Clear</Button>
            <Button onClick={onClose}>Cancel</Button>
          </>
        } />
      }>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", padding: "0.25rem 0" }}>
        <Input icon={<Icon name="search" />} placeholder="Search" value={q} showClearIcon
          onInput={(e) => setQ(e.target.value ?? "")} style={{ width: "100%" }} />
        <Table noDataText="No matching rows."
          onRowClick={(e) => {
            const i = Number((e.detail.row as HTMLElement).dataset.idx);
            const r = rows[i];
            if (r && vi >= 0) {
              onSelect(r[vi] ?? null);
              onClose();
            }
          }}
          headerRow={
            <TableHeaderRow sticky>
              {shown.map((c) => <TableHeaderCell key={c}><span>{c}</span></TableHeaderCell>)}
            </TableHeaderRow>
          }>
          {rows.map((r, i) => (
            <TableRow key={i} rowKey={String(i)} data-idx={String(i)} interactive>
              {idx.map((ci, j) => (
                <TableCell key={j}><Text>{ci < 0 ? "" : String(r[ci] ?? "")}</Text></TableCell>
              ))}
            </TableRow>
          ))}
        </Table>
      </div>
    </Dialog>
  );
}
```

- [ ] **Step 2: Wire query + table sources into ConfiguratorForm**

In `ConfiguratorForm.tsx`:

1. Add imports: `Icon` from `@ui5/webcomponents-react`, `refColumns` from `@hera/config-engine`, `useState` from react, `ValueHelpDialog` from `./ValueHelpDialog.tsx`.
2. Add state at the top of `ConfiguratorForm`: `const [vhKey, setVhKey] = useState<string | null>(null);`
3. Inside `control(key)`, insert **before** the `if (dom.length)` select branch:

```tsx
    if (p.domain?.kind === "options" && p.domain.ref.source === "query") {
      const ref = p.domain.ref;
      const t = lookups.tables[ref.table];
      const label = dom.find((o) => o.value === v)?.label ?? (v === undefined || v === null ? "" : String(v));
      return (
        <>
          <Input readonly value={label} placeholder="Select…"
            icon={<Icon name="value-help" onClick={() => setVhKey(key)} />}
            onClick={() => setVhKey(key)} />
          {vhKey === key && t ? (
            <ValueHelpDialog open headerText={p.label} table={t} valueCol={ref.valueCol}
              columns={refColumns(ref, t.columns)}
              hiddenValues={new Set(dom.filter((o) => o.eliminatedBy).map((o) => o.value))}
              onSelect={(nv) => set(key, nv)} onClose={() => setVhKey(null)} />
          ) : null}
        </>
      );
    }
```

4. In the `if (dom.length)` select branch, show the extra columns of **table**-sourced params as `additionalText` (eliminated keeps showing "unavailable"). Before the `return`, compute:

```tsx
      const tref = p.domain?.kind === "options" && p.domain.ref.source === "table" ? p.domain.ref : undefined;
      const tbl = tref ? lookups.tables[tref.table] : undefined;
      const extraOf = (val: Val): string | undefined => {
        if (!tref || !tbl) return undefined;
        const vi2 = tbl.columns.indexOf(tref.valueCol);
        const row = vi2 < 0 ? undefined : tbl.rows.find((r) => r[vi2] === val);
        if (!row) return undefined;
        const cols = refColumns(tref, tbl.columns);
        const s = cols.map((c) => String(row[tbl.columns.indexOf(c)] ?? "")).filter(Boolean).join(" · ");
        return s || undefined;
      };
```

and change the Option's `additionalText` to:

```tsx
              additionalText={o.eliminatedBy ? "unavailable" : extraOf(o.value)}
```

- [ ] **Step 3: Typecheck + verify**

Run: `bunx tsc --noEmit -p apps/web/tsconfig.json` — expected: no errors.
Dev server: a param with a query domain shows a read-only input with a value-help icon; the dialog searches and picks; a table-sourced Select shows extra column values next to each option.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/configurator/ValueHelpDialog.tsx apps/web/src/components/configurator/ConfiguratorForm.tsx
git commit -m "feat(web): value-help dialog for query params; table selects show source columns"
```

---

### Task 11: Web — TablesTab edits the model's queryTables

**Files:**
- Modify: `apps/web/src/components/configurator/TablesTab.tsx`
- Modify: `apps/web/src/components/configurator/ModelBuilderPage.tsx:95`

**Interfaces:**
- Consumes: `client.models.lookupPreview({ ref, queryTables, limit })` (Task 9).
- Produces: `TablesTab({ draft, update })` with `draft: ModelDef`, `update: (fn: (d: ModelDef) => ModelDef) => void`. Task 12's param dialog assumes queries are defined here.

- [ ] **Step 1: Change the TablesTab signature and left rail**

Update `TablesTab` to accept props and manage which editor shows:

```tsx
import type { ModelDef, Val, Option as EngineOption } from "@hera/config-engine";
import { client } from "../../orpc.ts";

type Update = (fn: (d: ModelDef) => ModelDef) => void;

export function TablesTab({ draft: model, update }: { draft: ModelDef; update: Update }) {
  // ...existing state...
  const [draft, setDraft] = useState<Draft | null>(null);        // tenant-table editor (existing)
  const [qIdx, setQIdx] = useState<number | null>(null);          // queryTables editor
```

In the left rail (the `width: "16rem"` div), below the existing tables `List`, add:

```tsx
        <Bar design="Subheader" startContent={<Title level="H5">Queries (this model)</Title>}
          endContent={
            <Button icon="add" tooltip="New query" onClick={() => {
              update((d) => ({
                ...d,
                queryTables: [...d.queryTables, { name: `query${d.queryTables.length + 1}`, target: "b1", path: "", columns: ["Code"] }],
              }));
              setQIdx(model.queryTables.length);
              setDraft(null);
            }} />
          } />
        <List onItemClick={(e) => {
          setQIdx(Number((e.detail.item as HTMLElement).dataset.idx));
          setDraft(null);
        }}>
          {model.queryTables.map((qt, i) => (
            <ListItemStandard key={i} data-idx={String(i)} additionalText={qt.target}>{qt.name}</ListItemStandard>
          ))}
        </List>
```

Make selecting a tenant table also `setQIdx(null)` (in the existing tables `List` onItemClick).

- [ ] **Step 2: Add the query editor pane**

In the right pane, extend the ternary: `draft ? (existing table editor) : qIdx !== null && model.queryTables[qIdx] ? (query editor) : (placeholder)`. Query editor:

```tsx
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {(() => {
            const qt = model.queryTables[qIdx]!;
            const setQt = (patch: Partial<ModelDef["queryTables"][number]>) =>
              update((d) => ({ ...d, queryTables: d.queryTables.map((q, i) => (i === qIdx ? { ...q, ...patch } : q)) }));
            return (
              <>
                <div style={{ display: "flex", gap: "0.75rem", alignItems: "end" }}>
                  <div style={{ flex: 1 }}>
                    <Label required>Name (referenced by parameter domains and LOOKUP)</Label>
                    <Input value={qt.name} onInput={(e) => setQt({ name: e.target.value })} />
                  </div>
                  <Button design="Negative" onClick={() => {
                    update((d) => ({ ...d, queryTables: d.queryTables.filter((_, i) => i !== qIdx) }));
                    setQIdx(null);
                  }}>Delete</Button>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "8rem 1fr", gap: "0.5rem" }}>
                  <Select value={qt.target} onChange={(e) => setQt({ target: (e.detail.selectedOption as HTMLElement).dataset.v as "b1" | "beas" })}>
                    <Option value="b1" data-v="b1">B1</Option>
                    <Option value="beas" data-v="beas">Beas</Option>
                  </Select>
                  <Input placeholder="/Items?$select=ItemCode,ItemName" value={qt.path}
                    onInput={(e) => setQt({ path: e.target.value })} />
                </div>
                <Title level="H6">Columns (response fields, first is the natural key)</Title>
                {qt.columns.map((c, i) => (
                  <div key={i} style={{ display: "flex", gap: "0.5rem" }}>
                    <Input value={c} onInput={(e) =>
                      setQt({ columns: qt.columns.map((x, j) => (j === i ? e.target.value : x)) })} />
                    <Button icon="delete" design="Transparent" disabled={qt.columns.length === 1}
                      onClick={() => setQt({ columns: qt.columns.filter((_, j) => j !== i) })} />
                  </div>
                ))}
                <Button icon="add" style={{ alignSelf: "start" }}
                  onClick={() => setQt({ columns: [...qt.columns, ""] })}>Add column</Button>
                <QueryTestFetch qt={qt} />
              </>
            );
          })()}
        </div>
```

And the test-fetch helper at the bottom of the file (mirrors `PreviewButton` in ParamsTab):

```tsx
function QueryTestFetch({ qt }: { qt: ModelDef["queryTables"][number] }) {
  const [state, setState] = useState<{ busy?: boolean; options?: EngineOption[]; error?: string }>({});
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <Button icon="show" style={{ alignSelf: "start" }} disabled={state.busy || !qt.path || !qt.columns[0]}
        onClick={async () => {
          setState({ busy: true });
          try {
            const r = await client.models.lookupPreview({
              ref: { source: "query", table: qt.name, valueCol: qt.columns[0]!, labelCol: qt.columns[1] },
              queryTables: [qt], limit: 10,
            });
            setState({ options: r.options });
          } catch (e) {
            setState({ error: e instanceof Error ? e.message : String(e) });
          }
        }}>
        {state.busy ? "Loading…" : "Test fetch"}
      </Button>
      {state.error ? <MessageStrip design="Negative" hideCloseButton>{state.error}</MessageStrip> : null}
      {state.options ? (
        state.options.length ? (
          <List>{state.options.map((o, i) => <ListItemStandard key={i} additionalText={String(o.value)}>{o.label}</ListItemStandard>)}</List>
        ) : <Text>No rows returned.</Text>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 3: Wire ModelBuilderPage**

`ModelBuilderPage.tsx:95`: `<ObjectPageSection id="tables" titleText="Tables"><TablesTab draft={draft} update={m.update} /></ObjectPageSection>` (the surrounding code already has `draft` and `m.update` in scope — see line 84).

- [ ] **Step 4: Typecheck + verify + commit**

Run: `bunx tsc --noEmit -p apps/web/tsconfig.json` — expected: no errors.
Dev server: Tables tab shows both rails; adding/editing a query marks the model dirty; Save model persists; Test fetch hits the agent (or shows the agent-offline message verbatim).

```bash
git add apps/web/src/components/configurator/TablesTab.tsx apps/web/src/components/configurator/ModelBuilderPage.tsx
git commit -m "feat(web): queryTables editor in the Tables tab"
```

---

### Task 12: Web — ParamDialog reorganization + named-source DomainEditor

**Files:**
- Modify: `apps/web/src/components/configurator/ParamsTab.tsx:234-480` (ParamDialog, DomainEditor, TableRefEditor, QueryRefEditor, PreviewButton)

**Interfaces:**
- Consumes: `refColumns` (Task 6), `client.models.lookupPreview({ ref, queryTables })` (Task 9), `draft.queryTables` (Task 11 provides the editor).
- Produces: nothing new consumed later.

- [ ] **Step 1: Reorganize ParamDialog into titled sections**

Replace the dialog's single grid (lines 258-321) with four titled blocks inside the same grid (a `Title` spanning both columns before each block):

```tsx
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem", padding: "0.5rem 0" }}>
        <Title level="H6" style={{ gridColumn: "1 / -1" }}>Basics</Title>
        {/* Key, Label, Type, Control, Unit, Place-in — exactly the existing fields */}
        ...
        <Title level="H6" style={{ gridColumn: "1 / -1" }}>Value domain</Title>
        <div style={{ gridColumn: "1 / -1" }}>
          <DomainEditor draft={draft} tables={tables} value={p.domain} onChange={(domain) => set({ domain })} />
        </div>
        <Title level="H6" style={{ gridColumn: "1 / -1" }}>Behavior</Title>
        {/* Default (expression), Visible when, Required when — existing fields */}
        ...
        <Title level="H6" style={{ gridColumn: "1 / -1" }}>Help</Title>
        {/* Help text, Extraction hint — existing fields */}
        ...
      </div>
```

Move `Unit` up into Basics (it describes the parameter, not behavior). Field markup itself is unchanged — only order and the section titles.

- [ ] **Step 2: Rewrite DomainEditor for named sources**

Replace `DomainEditor`, `TableRefEditor`, and delete `QueryRefEditor`:

```tsx
function DomainEditor({ draft, tables, value, onChange }: {
  draft: ModelDef; tables: Tables;
  value: Param["domain"]; onChange: (d: Param["domain"]) => void;
}) {
  const kind = value === undefined ? "none" : value.kind === "range" ? "range" : value.ref.source;
  const tenantNames = tables.map((t) => t.name);
  const queryNames = draft.queryTables.map((q) => q.name);
  const columnsOf = (name: string) =>
    tables.find((t) => t.name === name)?.columns.map((c) => c.key) ??
    draft.queryTables.find((q) => q.name === name)?.columns ?? [];

  const setKind = (k: string) => {
    if (k === "none") onChange(undefined);
    else if (k === "range") onChange({ kind: "range", min: 0, max: 100, step: 1 });
    else if (k === "manual") onChange({ kind: "options", ref: { source: "manual", options: [] } });
    else if (k === "table") onChange({ kind: "options", ref: { source: "table", table: tenantNames[0] ?? "", valueCol: "" } });
    else onChange({ kind: "options", ref: { source: "query", table: queryNames[0] ?? "", valueCol: "" } });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <Select value={kind} onChange={(e) => setKind((e.detail.selectedOption as HTMLElement).dataset.v!)}>
        {[["none", "None (free entry)"], ["manual", "Manual list"], ["table", "Table"], ["query", "Query (B1/Beas)"], ["range", "Number range"]]
          .map(([v, l]) => <Option key={v} value={v} data-v={v}>{l}</Option>)}
      </Select>

      {value?.kind === "range" ? (
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <StepInput value={value.min} onChange={(e) => onChange({ ...value, min: e.target.value ?? 0 })} />
          <StepInput value={value.max} onChange={(e) => onChange({ ...value, max: e.target.value ?? 0 })} />
          <StepInput value={value.step ?? 1} min={0} onChange={(e) => onChange({ ...value, step: e.target.value || undefined })} />
        </div>
      ) : null}

      {value?.kind === "options" && value.ref.source === "manual" ? (
        <ManualOptions ref_={value.ref} onChange={(ref) => onChange({ kind: "options", ref })} />
      ) : null}

      {value?.kind === "options" && (value.ref.source === "table" || value.ref.source === "query") ? (
        <SourceRefEditor ref_={value.ref}
          names={value.ref.source === "table" ? tenantNames : queryNames}
          columnsOf={columnsOf}
          onChange={(ref) => onChange({ kind: "options", ref })} />
      ) : null}

      {value?.kind === "options" ? <PreviewButton ref_={value.ref} queryTables={draft.queryTables} /> : null}
      {value?.kind === "options" && (value.ref.source === "table" || value.ref.source === "query") ? (
        <Text>Define tables and queries under the Tables tab; extra columns become <code>{"<param>_<column>"}</code> values usable in formulas.</Text>
      ) : null}
    </div>
  );
}

// One editor for both named sources: pick the source, the value/label columns, and which
// extra columns to expose (default: all).
function SourceRefEditor({ ref_, names, columnsOf, onChange }: {
  ref_: Extract<LookupRef, { source: "table" | "query" }>;
  names: string[];
  columnsOf: (name: string) => string[];
  onChange: (r: LookupRef) => void;
}) {
  const cols = columnsOf(ref_.table);
  const displayed = ref_.columns ?? cols.filter((c) => c !== ref_.valueCol);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <Select value={ref_.table} onChange={(e) =>
          onChange({ ...ref_, table: (e.detail.selectedOption as HTMLElement).dataset.v!, valueCol: "", labelCol: undefined, columns: undefined })}>
          {names.length === 0 ? <Option value="" data-v="">— none defined —</Option> : null}
          {names.map((n) => <Option key={n} value={n} data-v={n}>{n}</Option>)}
        </Select>
        <Select value={ref_.valueCol} onChange={(e) => onChange({ ...ref_, valueCol: (e.detail.selectedOption as HTMLElement).dataset.v! })}>
          <Option value="" data-v="">value column…</Option>
          {cols.map((c) => <Option key={c} value={c} data-v={c}>{c}</Option>)}
        </Select>
        <Select value={ref_.labelCol ?? ""} onChange={(e) => {
          const v = (e.detail.selectedOption as HTMLElement).dataset.v!;
          onChange({ ...ref_, labelCol: v || undefined });
        }}>
          <Option value="" data-v="">label column (optional)…</Option>
          {cols.map((c) => <Option key={c} value={c} data-v={c}>{c}</Option>)}
        </Select>
      </div>
      <div>
        <Label>Displayed / derived columns</Label>
        <MultiComboBox
          onSelectionChange={(e) => {
            const sel = e.detail.items.map((i) => (i as HTMLElement).getAttribute("text")!);
            const all = cols.filter((c) => c !== ref_.valueCol);
            onChange({ ...ref_, columns: sel.length === all.length ? undefined : sel });
          }}>
          {cols.filter((c) => c !== ref_.valueCol).map((c) => (
            <MultiComboBoxItem key={c} text={c} selected={displayed.includes(c)} />
          ))}
        </MultiComboBox>
      </div>
    </div>
  );
}
```

Update `PreviewButton` to take and forward `queryTables`:

```tsx
function PreviewButton({ ref_, queryTables }: { ref_: LookupRef; queryTables: ModelDef["queryTables"] }) {
  // ...unchanged except the call:
  const r = await client.models.lookupPreview({ ref: ref_, queryTables, limit: 20 });
```

Add `MultiComboBox, MultiComboBoxItem, Title` to the ui5 import in ParamsTab.tsx and `ModelDef` usage stays. Delete `QueryRefEditor` (including any Task 8 shim).

- [ ] **Step 3: Typecheck + verify + commit**

Run: `bunx tsc --noEmit -p apps/web/tsconfig.json` — expected: no errors.
Dev server: param dialog shows Basics / Value domain / Behavior / Help; picking Query lists only the model's queryTables; the column MultiComboBox defaults to everything except the value column; Preview options works for both sources.

```bash
git add apps/web/src/components/configurator/ParamsTab.tsx
git commit -m "feat(web): param dialog sections + named-source domain editor with display columns"
```

---

### Task 13: Web — flush structure toolbar + derived-key suggestions

**Files:**
- Modify: `apps/web/src/components/configurator/ParamsTab.tsx:84-104` (bar) and `:106` (table)
- Modify: `apps/web/src/components/configurator/exprHelpers.ts:9-16` (scopeSuggestions)
- Test: `apps/web/src/components/configurator/exprHelpers.test.ts` (addition)

**Interfaces:**
- Consumes: `refColumns`, `derivedKey` (Task 6).
- Produces: `Suggestion.kind` union gains `"derived"`.

- [ ] **Step 1: Flush toolbar**

UI5 `Table` has no toolbar slot, so keep the `Bar` a sibling but visually attach it: wrap the `Bar design="Subheader"` and the structure `Table` in one container with no gap:

```tsx
      <div style={{ display: "flex", flexDirection: "column" }}>
        <Bar design="Subheader" style={{ borderBlockEnd: "none" }}
          startContent={<Title level="H5">Form structure</Title>}
          endContent={/* existing three Add buttons unchanged */}
        />
        <Table ... /* existing table unchanged */ >
      </div>
```

(The parent column's `gap: 0.75rem` no longer separates them.)

- [ ] **Step 2: Failing test for derived suggestions**

Append to `exprHelpers.test.ts` (match its existing import style):

```ts
it("suggests derived lookup columns when statically known", () => {
  const m = structuredClone(model); // the test file's existing ModelDef fixture; if none, build a minimal one as in propagate.test.ts
  m.queryTables = [{ name: "items", target: "b1", path: "/Items", columns: ["Code", "Name"] }];
  m.parameters.push({
    key: "item", label: "Item", type: "string", ui: "select",
    domain: { kind: "options", ref: { source: "query", table: "items", valueCol: "Code" } },
  });
  const texts = scopeSuggestions(m).map((s) => s.text);
  expect(texts).toContain("item_Name");
});
```

Run: `bun test apps/web/src/components/configurator/exprHelpers.test.ts` — expected: FAIL.

- [ ] **Step 3: Implement**

In `exprHelpers.ts`, extend `Suggestion`'s `kind` union with `"derived"` and update:

```ts
import { FUNCS, refColumns, derivedKey, type ModelDef } from "@hera/config-engine";

export function scopeSuggestions(model: ModelDef, extraVars: string[] = []): Suggestion[] {
  // ponytail: tenant-table columns aren't available here, so default-all tenant refs get no
  // derived suggestions (checkModel still validates them); pass tables through if it ever matters.
  const colsOf = (name: string) => model.queryTables.find((q) => q.name === name)?.columns;
  const derived = model.parameters.flatMap((p) => {
    const ref = p.domain?.kind === "options" ? p.domain.ref : undefined;
    if (!ref || ref.source === "manual") return [];
    return refColumns(ref, colsOf(ref.table)).map((c) => ({ text: derivedKey(p.key, c), kind: "derived" as const }));
  });
  return [
    ...model.parameters.map((p) => ({ text: p.key, kind: "param" as const })),
    ...derived,
    ...model.computed.map((c) => ({ text: c.key, kind: "computed" as const })),
    ...extraVars.map((v) => ({ text: v, kind: "var" as const })),
    ...[...FUNCS].map((f) => ({ text: f, kind: "function" as const })),
  ];
}
```

- [ ] **Step 4: Run tests + typecheck + commit**

Run: `bun test apps/web/src/components/configurator` — expected: PASS (runView, structureOps, exprHelpers).
Run: `bunx tsc --noEmit -p apps/web/tsconfig.json` — expected: no errors.

```bash
git add apps/web/src/components/configurator/ParamsTab.tsx apps/web/src/components/configurator/exprHelpers.ts apps/web/src/components/configurator/exprHelpers.test.ts
git commit -m "feat(web): flush structure toolbar; expression suggestions include derived columns"
```

---

### Task 14: End-to-end verification

**Files:** none (verification only; fix regressions where found).

- [ ] **Step 1: Full test pass**

Run: `bun run test:engine && bun run test:server && bun test apps/web/src && bunx tsc --noEmit -p apps/web/tsconfig.json`
Expected: everything green.

- [ ] **Step 2: Manual walkthrough (dev server + agent running)**

1. Builder: create/edit a model — define a tenant table and a query in Tables; give one param a table domain and one a query domain; reference a `<param>_<col>` in a computed value and in a BOM price; confirm 0 issues and Save succeeds.
2. Live preview: table param shows column values in the Select; query param opens the value help; computed value updates from the derived column.
3. Runtime: new configuration → 3-step wizard; header overlay top-right; Configure has form + batches + one sticky bar; Calculate → Candidates; pick cells → editable panels; adjust a line; Save selection; grand total matches; reload and confirm persistence.
4. Portal (if a portal model exists): request wizard still walks Configure → Quantities → Prices → Submit.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A && git commit -m "fix(web): configurator improvements verification fixes"
```

(Skip if nothing changed.)
