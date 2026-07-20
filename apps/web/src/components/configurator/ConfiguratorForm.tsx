import { useMemo, useState, type ComponentProps } from "react";
import {
  BusyIndicator, CheckBox, Form, FormGroup, FormItem, Icon, Input, Label, MultiComboBox, MultiComboBoxItem,
  ObjectStatus, Option, RadioButton, Select, StepInput, SuggestionItem, Text,
} from "@ui5/webcomponents-react";
import {
  propagate, refColumns, refKeyCols,
  type DomainOption, type Entries, type LookupRef, type ModelDef, type Param, type ResolvedLookups, type ResolvedTable, type Val,
} from "@hera/config-engine";
import { ValueHelpDialog } from "./ValueHelpDialog.tsx";
import { BatchEditor } from "./BatchEditor.tsx";
import { clientBaseLookups, resolveEntry } from "./formHelpers.ts";

/** The ref's display columns for one option value, joined — shown next to the option. */
function extraOf(ref: LookupRef, t: ResolvedTable | undefined, val: Val): string | undefined {
  if (!t) return undefined;
  const vi = t.columns.indexOf(refKeyCols(ref, t.columns).valueCol);
  const row = vi < 0 ? undefined : t.rows.find((r) => r[vi] === val);
  if (!row) return undefined;
  const s = refColumns(ref, t.columns).map((c) => String(row[t.columns.indexOf(c)] ?? "")).filter(Boolean).join(" · ");
  return s || undefined;
}

// Value-help input for a query-sourced param. Local `typed` state lets you filter as you type
// without committing; on blur/Enter an unknown value is rejected (reverts to the last valid one).
function QueryValueInput({ p, refDef, dom, value, table, onCommit }: {
  p: Param;
  refDef: LookupRef;
  dom: DomainOption[];
  value: Val | undefined;
  table: ResolvedTable | undefined;
  onCommit: (v: Val | undefined) => void;
}) {
  const [typed, setTyped] = useState<string | null>(null);
  const [vhOpen, setVhOpen] = useState(false);
  const key = value === undefined || value === null ? "" : String(value);
  const shown = typed ?? key;
  // filter="None" on the Input; we filter here so both key and label are searchable.
  const q = (typed ?? "").trim().toLowerCase();
  const items = dom.filter(
    (o) => !o.eliminatedBy && (!q || String(o.value ?? "").toLowerCase().includes(q) || o.label.toLowerCase().includes(q)),
  );

  const commit = (raw: string) => {
    const r = resolveEntry(dom, raw);
    if (r.kind === "clear") onCommit(undefined);
    else if (r.kind === "set") onCommit(r.value);
    // reject: keep the last committed value
    setTyped(null); // snap the field back to the committed key
  };

  return (
    <>
      <Input showSuggestions filter="None" value={shown} placeholder="Type or pick…" showClearIcon
        style={{ width: "100%" }}
        icon={<Icon name="value-help" style={{ cursor: "pointer" }} onClick={() => setVhOpen(true)} />}
        onInput={(e) => setTyped(e.target.value ?? "")}
        onChange={(e) => commit(e.target.value ?? "")}>
        {items.map((o, i) => (
          <SuggestionItem key={i} text={String(o.value ?? "")} additionalText={o.label} />
        ))}
      </Input>
      {vhOpen && table ? (
        <ValueHelpDialog open headerText={p.label} table={table} valueCol={refKeyCols(refDef, table.columns).valueCol}
          columns={refColumns(refDef, table.columns)}
          hiddenValues={new Set(dom.filter((o) => o.eliminatedBy).map((o) => o.value))}
          onSelect={(nv) => { onCommit(nv); setTyped(null); }} onClose={() => setVhOpen(false)} />
      ) : null}
    </>
  );
}

// The one form both the builder preview and the wizard render. Fully controlled:
// entries in, entries out; all engine work happens in propagate(). Optional batch quantities
// keep the internal Configure step together; scrolling, footers and consistency stay with the caller.

/** The signature answer to "is this consistent and how big is it?" — one component so the
 *  string stays identical in the wizard bar, the preview footer and the portal step.
 *  ponytail: recomputes propagate() alongside the form's own call; memoized, fine at this scale. */
export function ConsistencyStatus({ model, lookups, entries }: {
  model: ModelDef;
  lookups?: ResolvedLookups;
  entries: Entries;
}) {
  const lk = useMemo(() => lookups ?? clientBaseLookups(model), [lookups, model]);
  const prop = useMemo(() => propagate(model, lk, entries), [model, lk, entries]);
  const conflict = prop.conflicts.length ? prop.conflicts.map((c) => c.message).join(" · ") : null;
  return (
    <ObjectStatus state={conflict ? "Negative" : "Positive"}>
      {conflict ?? `✓ Consistent · ${prop.open.length} open · ~${prop.candidateEstimate} candidate${prop.candidateEstimate === 1 ? "" : "s"}`}
    </ObjectStatus>
  );
}

// labelSpan 12 everywhere = labels on top of their fields (natively left-aligned), field takes the full column.
const FORM_PROPS = { labelSpan: "S12 M12 L12 XL12", layout: "S1 M2 L2 XL2", headerLevel: "H5" } as const;

export function ConfiguratorForm({ model, lookups, entries, onChange, loading, batch, section }: {
  model: ModelDef;
  lookups?: ResolvedLookups;
  entries: Entries;
  onChange: (next: Entries) => void;
  /** the single lookups fetch is still in flight — table/query fields show a spinner until it lands */
  loading?: boolean;
  batch?: ComponentProps<typeof BatchEditor>;
  /** render only this section, without its own Form header — the caller shows the title (e.g. an ObjectPageSection) */
  section?: string;
}) {
  const lk = useMemo(() => lookups ?? clientBaseLookups(model), [lookups, model]);
  const prop = useMemo(() => propagate(model, lk, entries), [model, lk, entries]);

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

    // Server-backed options (config table / query) arrive with the single lookups fetch; spin
    // just this field until it lands. Manual/range/plain fields resolve client-side and stay usable.
    const ref = p.domain?.kind === "options" ? p.domain.ref : undefined;
    if (loading && (ref?.source === "table" || ref?.source === "query") && dom.length === 0)
      return <BusyIndicator active delay={0} />;

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
        <MultiComboBox style={{ width: "100%" }}
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
          style={{ width: "100%" }}
          onChange={(e) => set(key, e.target.value ?? undefined)} />
      );
    }

    if (p.domain?.kind === "options" && p.domain.ref.source === "query") {
      // ponytail: every option is rendered as a suggestion child and filtered natively;
      // cap or virtualize if a query ever returns thousands of rows.
      return (
        <QueryValueInput p={p} refDef={p.domain.ref} dom={dom} value={v}
          table={lk.tables[p.domain.ref.table]} onCommit={(nv) => set(key, nv)} />
      );
    }

    if (dom.length) { // select (and boolean-with-select)
      const tref = p.domain?.kind === "options" && p.domain.ref.source === "table" ? p.domain.ref : undefined;
      const tbl = tref ? lk.tables[tref.table] : undefined;
      return (
        <Select value={v === undefined ? "" : JSON.stringify(v)} style={{ width: "100%" }}
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
        style={{ width: "100%" }}
        onChange={(e) => {
          const raw = e.target.value ?? "";
          set(key, raw === "" ? undefined : p.type === "number" ? Number(raw) : raw);
        }} />
    );
  };

  const sections = section ? model.structure.sections.filter((s) => s.key === section) : model.structure.sections;
  const lastKey = model.structure.sections.at(-1)?.key;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {sections.map((s) => (
        <Form key={s.key} headerText={section ? undefined : s.title} {...FORM_PROPS}>
          {s.groups.map((g) => (
            <FormGroup key={g.key} headerText={g.title}>
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
                    <Label>
                      {p.label + (p.unit ? ` (${p.unit})` : "")}
                      {p.help ? <Icon name="message-information" accessibleName={p.help} title={p.help}
                        style={{ marginInlineStart: "0.375rem", cursor: "help", color: "var(--sapContent_IconColor)" }} /> : null}
                    </Label>
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
          {batch && s.key === lastKey ? (
            <FormGroup headerText="Batch quantities">
              <FormItem labelContent={<Label>Quantities</Label>}>
                <BatchEditor {...batch} />
              </FormItem>
            </FormGroup>
          ) : null}
        </Form>
      ))}
    </div>
  );
}
