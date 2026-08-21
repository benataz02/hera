import { useMemo, useState } from "react";
import {
  Bar, Button, CheckBox, Form, FormGroup, FormItem, Icon, Input, Label, MessageStrip,
  MultiComboBox, MultiComboBoxItem, ObjectStatus, Option, RadioButton, Select, StepInput,
  Text, Title, Token, Tokenizer,
} from "@ui5/webcomponents-react";
import {
  displayColumns, refKeyCols,
  type DomainOption, type Entries, type LookupRef, type ModelDef, type Propagation, type ResolvedLookups, type ResolvedTable, type Val,
} from "@hera/config-engine";
import { QueryValueHelp, type QuerySource } from "../ValueHelp.tsx";
import { setEntry } from "./formHelpers.ts";
import { money, paramPrices } from "./costElements.ts";

/** The ref's display columns for one option value, joined — shown next to the option. */
function extraOf(ref: LookupRef, t: ResolvedTable | undefined, val: Val): string | undefined {
  if (!t) return undefined;
  const vi = t.columns.indexOf(refKeyCols(ref, t.columns).valueCol);
  const row = vi < 0 ? undefined : t.rows.find((r) => r[vi] === val);
  if (!row) return undefined;
  const s = displayColumns(ref, t.columns).map((c) => String(row[t.columns.indexOf(c)] ?? "")).filter(Boolean).join(" · ");
  return s || undefined;
}

// The one form both the builder preview and the wizard render. Fully controlled:
// entries in, entries out; all engine work happens in propagate(). Optional batch quantities
// keep the internal Configure step together; scrolling, footers and consistency stay with the caller.

/** The signature answer to "is this consistent and how big is it?" — one component so the
 *  string stays identical in the wizard bar, the preview footer and the portal step. */
export function ConsistencyStatus({ prop }: { prop: Propagation }) {
  const conflict = prop.conflicts.length ? prop.conflicts.map((c) => c.message).join(" · ") : null;
  return (
    <ObjectStatus state={conflict ? "Negative" : "Positive"}>
      {conflict ?? `✓ Consistent · ${prop.open.length} open · ~${prop.candidateEstimate} candidate${prop.candidateEstimate === 1 ? "" : "s"}`}
    </ObjectStatus>
  );
}

// labelSpan 12 everywhere = labels on top of their fields (natively left-aligned), field takes the full column.
const FORM_PROPS = { labelSpan: "S12 M12 L12 XL12", layout: "S1 M2 L2 XL2", headerLevel: "H5" } as const;

export function ConfiguratorForm({ model, lookups, lk, prop, entries, onChange, onQueryPick, section, aiMarks, disabled, querySource }: {
  model: ModelDef;
  /** Canonical first-page snapshot — seeds query value help. */
  lookups: ResolvedLookups;
  /** Canonical tables plus the current off-page row per query param. */
  lk: ResolvedLookups;
  prop: Propagation;
  entries: Entries;
  onChange: (next: Entries) => void;
  onQueryPick: (paramKey: string, table: string, selected: ResolvedTable | undefined) => void;
  /** render only this section, without its own Form header — the caller shows the title (e.g. an ObjectPageSection) */
  section?: string;
  /** paramKey → evidence tooltip, for values Chati just set — renders an "AI" chip next to the field */
  aiMarks?: Map<string, string>;
  /** disables every control while Chati is running a turn; manual edits stay blocked until it settles */
  disabled?: boolean;
  /** where a query field fetches its pages — nothing is fetched until the user opens or types */
  querySource: QuerySource;
}) {
  // Same source the rail's Costs card reads, so a badge and the card can never disagree.
  const priceOf = useMemo(
    () => new Map(paramPrices(model, prop, lk.tables).map((c) => [c.key, c.amount])),
    [model, prop, lk],
  );

  const set = (key: string, v: Val | undefined) => {
    if (v === undefined) {
      const ref = model.parameters.find((x) => x.key === key)?.domain;
      if (ref?.kind === "options" && ref.ref.source === "query") onQueryPick(key, ref.ref.table, undefined);
    }
    const next = setEntry(entries, key, v);
    if (next === entries) return;
    onChange(next);
  };

  const control = (key: string) => {
    const p = model.parameters.find((x) => x.key === key)!;
    const dom: DomainOption[] = prop.domains[key] ?? [];
    const v = prop.values[key];
    // readonly, not disabled: a read-only field stays focusable, copyable and screen-reader
    // announced — and these fields exist precisely to be read.
    const ro = !!p.readonly;

    const ref = p.domain?.kind === "options" ? p.domain.ref : undefined;

    if (p.ui === "radio")
      return (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem 1rem" }}>
          {dom.map((o, i) => (
            <RadioButton key={i} name={`cfg-${key}`} text={o.label} checked={v === o.value} readonly={ro}
              disabled={disabled || !!o.eliminatedBy}
              // tooltip is a runtime ui5 prop the React typing omits (like Option's disabled).
              {...(o.eliminatedBy ? ({ tooltip: `Unavailable: ${o.eliminatedBy}` } as Record<string, unknown>) : {})}
              onChange={() => set(key, o.value)} />
          ))}
        </div>
      );

    if (p.ui === "checkbox" || (p.type === "boolean" && p.ui !== "select")) {
      // a checkbox can only be toggled if flipping it isn't eliminated — that reason is also the tooltip.
      const blocked = dom.find((o) => o.value === (v !== true))?.eliminatedBy;
      return (
        <CheckBox checked={v === true} readonly={ro} disabled={disabled || !!blocked}
          // tooltip is a runtime ui5 prop the React typing omits.
          {...(blocked ? ({ tooltip: `Unavailable: ${blocked}` } as Record<string, unknown>) : {})}
          onChange={(e) => set(key, e.target.checked)} />
      );
    }

    if (p.ui === "multicombo")
      return (
        // MultiComboBoxItem has no disabled prop -> eliminated options are filtered out.
        <MultiComboBox style={{ width: "100%" }} disabled={disabled} readonly={ro}
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
          style={{ width: "100%" }} disabled={disabled} readonly={ro}
          onChange={(e) => set(key, e.target.value ?? undefined)} />
      );
    }

    if (p.domain?.kind === "options" && p.domain.ref.source === "query") {
      const ref: LookupRef = p.domain.ref;
      return (
        <QueryValueHelp source={querySource} queryTable={model.queryTables.find((q) => q.name === ref.table)}
          canonicalTable={lookups.tables[ref.table]} lookupRef={ref}
          value={v} onChange={(nv) => set(key, nv)} headerText={p.label}
          disabled={disabled} readonly={ro}
          onPick={(t) => onQueryPick(key, ref.table, t)} />
      );
    }

    if (dom.length) { // select (and boolean-with-select)
      const tref = p.domain?.kind === "options" && p.domain.ref.source === "table" ? p.domain.ref : undefined;
      const tbl = tref ? lk.tables[tref.table] : undefined;
      return (
        <Select value={v === undefined ? "" : JSON.stringify(v)} style={{ width: "100%" }} disabled={disabled} readonly={ro}
          onChange={(e) => {
            const j = (e.detail.selectedOption as HTMLElement).dataset.j;
            set(key, j === undefined || j === "" ? undefined : (JSON.parse(j) as Val));
          }}>
          <Option value="" data-j="">—</Option>
          {dom.map((o, i) => (
            <Option key={i} value={JSON.stringify(o.value)} data-j={JSON.stringify(o.value)}
              tooltip={o.eliminatedBy ? `Unavailable: ${o.eliminatedBy}` : undefined}
              additionalText={o.eliminatedBy ? "unavailable" : tref ? extraOf(tref, tbl, o.value) : undefined}
              // Option supports disabled at runtime (ListItemBase); the React typing omits it.
              {...(o.eliminatedBy ? ({ disabled: true } as Record<string, unknown>) : {})}>
              {o.label}
            </Option>
          ))}
        </Select>
      );
    }

    return (
      <Input type={p.type === "number" ? "Number" : "Text"} value={v === undefined || v === null ? "" : String(v)}
        style={{ width: "100%" }} disabled={disabled} readonly={ro}
        onChange={(e) => {
          const raw = e.target.value ?? "";
          set(key, raw === "" ? undefined : p.type === "number" ? Number(raw) : raw);
        }} />
    );
  };

  // One Form per model section. UI5's Form is the layout container and supports exactly one level
  // of grouping (Form > FormGroup), so section→Form / group→FormGroup is the only mapping that keeps
  // both titles; a single Form for everything would flatten sections away. In the ObjectPage each
  // section already gets its own ObjectPageSubSection (which supplies the title and the anchor), so
  // headerText is only needed when we stack the whole model ourselves (builder preview, portal wizard).
  const shown = model.structure.sections.filter((s) => !section || s.key === section);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {shown.map((s, si) => (
        <Form key={`${s.key}:${si}`} headerText={section ? undefined : s.title} {...FORM_PROPS}>
          {s.groups.map((g, gi) => (
            <FormGroup key={`${g.key}:${gi}`} headerText={g.title}>
              {g.params.filter((k) => prop.visible[k]).map((k) => {
                const p = model.parameters.find((x) => x.key === k);
                if (!p) return null;
                const dom: DomainOption[] = prop.domains[k] ?? [];
                const eliminated = dom.filter((o) => o.eliminatedBy).length;
                // MultiComboBox filters eliminated options out (no per-item disabled in UI5 v2), so
                // unlike Select/Radio it can't show them greyed — explain the gap with a count instead.
                const showEliminatedNote = p.ui === "multicombo" && eliminated > 0;
                return (
                  <FormItem key={k} labelContent={
                    // labelSpan is 12, so the label owns a full-width row above its control — its
                    // right end IS the input's top-right corner, which is where the price belongs.
                    <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", width: "100%" }}>
                      <Label>
                        {p.label + (p.unit ? ` (${p.unit})` : "")}
                        {p.help ? <Icon name="message-information" accessibleName={p.help} title={p.help}
                          style={{ marginInlineStart: "0.375rem", cursor: "help", color: "var(--sapContent_IconColor)" }} /> : null}
                        {aiMarks?.has(k) ? <Icon name="ai" accessibleName={aiMarks.get(k)} title={aiMarks.get(k)}
                          style={{ marginInlineStart: "0.375rem", color: "var(--sapInformativeColor)" }} /> : null}
                      </Label>
                      {priceOf.has(k) ? (
                        <ObjectStatus style={{ marginInlineStart: "auto" }}>
                          {money(priceOf.get(k)!, model.pricing.currency)}
                        </ObjectStatus>
                      ) : null}
                    </div>
                  }>
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.125rem", width: "100%" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", width: "100%" }}>
                        {control(k)}
                        {prop.defaulted.has(k) ? <ObjectStatus state="Information">auto</ObjectStatus> : null}
                      </div>
                      {showEliminatedNote ? (
                        <Text style={{ fontSize: "0.75rem", color: "var(--sapContent_LabelColor)" }}>
                          {eliminated} option{eliminated === 1 ? "" : "s"} unavailable due to rules
                        </Text>
                      ) : null}
                    </div>
                  </FormItem>
                );
              })}
            </FormGroup>
          ))}
        </Form>
      ))}
    </div>
  );
}

// The batch-quantity list editor shared by the internal Configure step and the portal wizard.
export function BatchEditor({ batches, onChange, disabled }: {
  batches: number[];
  onChange: (next: number[]) => void;
  disabled?: boolean;
}) {
  const [qty, setQty] = useState(1);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", width: "100%" }}>
      <Tokenizer accessibleName="Batch quantities" disabled={disabled}
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
          <StepInput id="new-batch-qty" min={1} value={qty} disabled={disabled} onChange={(e) => setQty(e.target.value ?? 1)} />
        </div>
        <Button icon="add" disabled={disabled}
          onClick={() => { if (!batches.includes(qty)) onChange([...batches, qty].sort((a, b) => a - b)); }}>
          Add quantity
        </Button>
      </div>
    </div>
  );
}

// Portal wizard "Quantities" step: BatchEditor plus the step's own copy and Calculate footer.
// Each quantity becomes a column in the candidates matrix; setup cost is amortized by the engine.
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
