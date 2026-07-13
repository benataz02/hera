import { useMemo, useState } from "react";
import {
  CheckBox, Form, FormGroup, FormItem, Icon, Input, Label, MultiComboBox, MultiComboBoxItem,
  ObjectStatus, Option, RadioButton, Select, StepInput, Text,
} from "@ui5/webcomponents-react";
import { propagate, refColumns, type DomainOption, type Entries, type ModelDef, type ResolvedLookups, type Val } from "@hera/config-engine";
import { ValueHelpDialog } from "./ValueHelpDialog.tsx";

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
  const [vhKey, setVhKey] = useState<string | null>(null);

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

    if (dom.length) { // select (and boolean-with-select)
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
              additionalText={o.eliminatedBy ? "unavailable" : extraOf(o.value)}
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
