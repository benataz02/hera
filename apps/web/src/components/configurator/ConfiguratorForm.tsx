import { useMemo } from "react";
import {
  Bar, CheckBox, Form, FormGroup, FormItem, Input, Label, MessageStrip, MultiComboBox,
  MultiComboBoxItem, ObjectPage, ObjectPageSection, ObjectStatus, Option, Panel, RadioButton,
  Select, StepInput, Text,
} from "@ui5/webcomponents-react";
import { propagate, type DomainOption, type Entries, type ModelDef, type ResolvedLookups, type Val } from "@hera/config-engine";

// The one form both the builder preview and the phase-4 wizard render. Fully controlled:
// entries in, entries out; all engine work happens in propagate().

export function ConfiguratorForm({ model, lookups, entries, onChange, layout = "flow" }: {
  model: ModelDef;
  lookups: ResolvedLookups;
  entries: Entries;
  onChange: (next: Entries) => void;
  // "page" -> ObjectPage/ObjectPageSection (builder preview); "flow" -> Panels (wizard step).
  layout?: "flow" | "page";
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

  // Groups/params render identically in both layouts (FormGroup = model group, FormItem = param);
  // only the section wrapper (Panel vs ObjectPageSection) and status placement differ.
  const groups = (s: ModelDef["structure"]["sections"][number]) => (
    <Form labelSpan="S12 M4" layout="S1 M1 L1 XL1">
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
  );

  const computed = model.computed.length ? (
    <Form labelSpan="S12 M4" layout="S1 M1 L1 XL1">
      <FormGroup>
        {model.computed.map((c) => (
          <FormItem key={c.key} labelContent={<Label>{c.key}</Label>}>
            <Text>{String(prop.values[c.key] ?? "—")}</Text>
          </FormItem>
        ))}
      </FormGroup>
    </Form>
  ) : null;

  // The signature answer to "is this consistent and how big is it?"
  const conflict = prop.conflicts.length ? prop.conflicts.map((c) => c.message).join(" · ") : null;
  const consistent = `✓ Consistent · ${prop.open.length} open · ~${prop.candidateEstimate} candidate${prop.candidateEstimate === 1 ? "" : "s"}`;

  if (layout === "page")
    return (
      <ObjectPage
        style={{ height: "100%" }}
        footerArea={
          <Bar design="FloatingFooter"
            startContent={<ObjectStatus state={conflict ? "Negative" : "Positive"}>{conflict ?? consistent}</ObjectStatus>} />
        }
      >
        {[
          ...model.structure.sections.map((s) => (
            <ObjectPageSection key={s.key} id={s.key} titleText={s.title}>{groups(s)}</ObjectPageSection>
          )),
          ...(computed ? [<ObjectPageSection key="__computed" id="__computed" titleText="Computed">{computed}</ObjectPageSection>] : []),
        ]}
      </ObjectPage>
    );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: "0.75rem", padding: "1rem" }}>
        {model.structure.sections.map((s) => (
          <Panel key={s.key} headerText={s.title}>{groups(s)}</Panel>
        ))}
        {computed ? <Panel headerText="Computed" collapsed>{computed}</Panel> : null}
      </div>
      {conflict ? (
        <MessageStrip design="Negative" hideCloseButton style={{ margin: "0 1rem 0.5rem" }}>{conflict}</MessageStrip>
      ) : (
        <Bar design="Footer" startContent={<Text>{consistent}</Text>} />
      )}
    </div>
  );
}
