import { useEffect, useState, type ReactNode } from "react";
import {
  Bar, Button, Card, CheckBox, Dialog, Form, FormGroup, FormItem, Icon, IllustratedMessage, Input, Label,
  MessageStrip, MultiComboBox, MultiComboBoxItem, ObjectStatus, Option, RadioButton,
  SegmentedButton, SegmentedButtonItem, Select, StepInput, Tab, TabContainer, Text, TextArea, Title,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/AddColumn.js";
import { refKeyCols } from "@hera/config-engine";
import type { LookupRef, ModelDef, Option as EngineOption, Param } from "@hera/config-engine";
import { client } from "../../orpc.ts";
import { ExprInput } from "./ExprInput.tsx";
import { modelWithParam } from "./exprHelpers.ts";

type Tables = { name: string; columns: string[] }[];

// The dialog's own paddings go so the preview rail can reach its edges; the tab strip and the
// rail bring their own. Same one-shot <style> trick the rest of the builder uses.
if (typeof document !== "undefined" && !document.getElementById("hera-param-dialog")) {
  const el = document.createElement("style");
  el.id = "hera-param-dialog";
  el.textContent = `.hera-param-dialog::part(content){padding:0}`;
  document.head.appendChild(el);
}

const HINT = { fontSize: "0.75rem", color: "var(--sapContent_LabelColor)" } as const;
const KEY_CHIP = {
  fontSize: "0.75rem", color: "var(--sapContent_LabelColor)", background: "var(--sapNeutralBackground)",
  border: "1px solid var(--sapList_BorderColor)", borderRadius: "0.25rem", padding: "0 0.375rem",
} as const;
// Same shape ConfiguratorForm uses, so a field looks identical here and on the real form.
const FORM_PROPS = { labelSpan: "S12 M12 L12 XL12", layout: "S1 M2 L2 XL2" } as const;
const TAB_BODY = { padding: "1rem", minHeight: "24rem" } as const;

// Friendly name, glyph, and the one-line rule that decides when each control is the right one.
const UI_META: Record<Param["ui"], { text: string; icon: string; hint: string }> = {
  input: { text: "Text field", icon: "edit", hint: "A plain field. Anything typed is accepted unless a rule rejects it." },
  select: { text: "Dropdown", icon: "slim-arrow-down", hint: "One value from the list — the safest default whenever a domain exists." },
  radio: { text: "Radio", icon: "circle-task-2", hint: "One value with every option on screen; best for three or four choices." },
  checkbox: { text: "Checkbox", icon: "accept", hint: "A single true/false. Needs a boolean type." },
  multicombo: { text: "Multi-select", icon: "multiselect-all", hint: "Several values at once. Options ruled out are hidden rather than greyed." },
  step: { text: "Stepper", icon: "number-sign", hint: "A number with plus and minus. Needs a number type, and honours a range." },
};

const DOMAIN_KINDS = [
  ["none", "Free entry"], ["manual", "Manual list"], ["table", "Table"],
  ["query", "Query · B1/Beas"], ["range", "Number range"],
] as const;

/** Blocks Save: the domain is half-built and would resolve to no options at all. */
export function domainIssue(p: Param): string | undefined {
  if (p.domain?.kind !== "options") return undefined;
  const ref = p.domain.ref;
  if (ref.source === "manual") return undefined;
  if (!ref.table) return ref.source === "table" ? "Choose a table." : "Choose a query.";
  if (ref.source === "table" && !ref.valueCol) return "Choose the value column.";
  return undefined;
}

/** Doesn't block Save — the model still checks out, the pairing just won't behave as expected. */
function controlIssue(p: Param): string | undefined {
  if (p.ui === "checkbox" && p.type !== "boolean") return "A checkbox stores true or false — set the type to boolean.";
  if (p.ui === "step" && p.type !== "number") return "A stepper counts — set the type to number.";
  if ((p.ui === "select" || p.ui === "radio" || p.ui === "multicombo") && !p.domain && p.type !== "boolean")
    return "This control needs something to list. Give it a manual list, a table or a query.";
  return undefined;
}

/** Label + the ⓘ carrying the field's explanation, over the control, over an optional hint line. */
function Field({ label, help, hint, required, span, children }: {
  label: string; help: string; hint?: string; required?: boolean; span?: number; children: ReactNode;
}) {
  return (
    <FormItem columnSpan={span} labelContent={
      <Label required={required}>
        {label}
        <Icon name="message-information" title={help} accessibleName={help}
          style={{ marginInlineStart: "0.375rem", cursor: "help", color: "var(--sapContent_NonInteractiveIconColor)" }} />
      </Label>
    }>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.125rem", width: "100%" }}>
        {children}
        {hint ? <Text style={HINT}>{hint}</Text> : null}
      </div>
    </FormItem>
  );
}

export function ParamDialog({ draft, tables, suggestTables, initial, isNew, onOk, onCancel }: {
  draft: ModelDef; tables: Tables; suggestTables: Tables; initial: Param; isNew: boolean;
  onOk: (p: Param) => void; onCancel: () => void;
}) {
  const [p, setP] = useState<Param>(initial);
  const set = (patch: Partial<Param>) => setP((x) => ({ ...x, ...patch }));
  const keyOk = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(p.key);
  const keyTaken = isNew && draft.parameters.some((x) => x.key === p.key);
  const dIssue = domainIssue(p);
  const cIssue = controlIssue(p);
  const scope = modelWithParam(draft, p);

  return (
    <Dialog open draggable resizable className="hera-param-dialog" onClose={onCancel}
      accessibleName={isNew ? "Add parameter" : `Edit parameter ${initial.key}`}
      style={{ width: "min(68rem, 94vw)" }}
      header={
        <div style={{ display: "flex", flexDirection: "column", gap: "0.125rem", width: "100%", padding: "0.75rem 1rem", minWidth: 0 }}>
          <Title level="H4">{p.label || (isNew ? "New parameter" : initial.key)}</Title>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            {p.key ? <code style={KEY_CHIP}>{p.key}</code> : null}
            <Text style={HINT}>{`${p.type} · ${UI_META[p.ui].text.toLowerCase()}`}</Text>
          </div>
        </div>
      }
      footer={
        <Bar design="Footer" endContent={
          <>
            <Button design="Emphasized" disabled={!keyOk || keyTaken || !p.label || !!dIssue}
              onClick={() => onOk(p)}>Save</Button>
            <Button onClick={onCancel}>Cancel</Button>
          </>
        } />
      }>
      <div style={{ display: "flex", alignItems: "stretch" }}>
        <TabContainer style={{ flex: "1 1 auto", minWidth: 0 }}>

          <Tab text="General" selected design={cIssue ? "Critical" : "Default"} additionalText={cIssue ? "1" : undefined}>
            <div style={TAB_BODY}>
              <Form {...FORM_PROPS}>
                <FormGroup>
                  <Field label="Key" required
                    help="The name formulas use to refer to this parameter. Fixed once the parameter exists."
                    hint={isNew ? "Letters, digits and underscore; it cannot start with a digit." : "Locked — renaming it would break every formula that mentions it."}>
                    <Input value={p.key} disabled={!isNew} style={{ width: "100%" }}
                      valueState={keyOk && !keyTaken ? "None" : "Negative"}
                      valueStateMessage={<div>{keyTaken ? "Key already exists" : "Must be a valid identifier"}</div>}
                      onInput={(e) => set({ key: e.target.value })} />
                  </Field>

                  <Field label="Label" required
                    help="What the salesperson sees above the field on the configuration form."
                    hint="A unit, if set, is appended in brackets: “Material (mm)”.">
                    <Input value={p.label} style={{ width: "100%" }} onInput={(e) => set({ label: e.target.value })} />
                  </Field>

                  <Field label="Type"
                    help="How the value is stored and compared: text, number, or true/false."
                    hint="Numbers compare and add up in formulas; text does not.">
                    <Select value={p.type} style={{ width: "100%" }}
                      onChange={(e) => set({ type: (e.detail.selectedOption as HTMLElement).dataset.v as Param["type"] })}>
                      {(["string", "number", "boolean"] as const).map((t) => <Option key={t} value={t} data-v={t}>{t}</Option>)}
                    </Select>
                  </Field>

                  <Field label="Unit"
                    help="Appended to the label in brackets. Cosmetic — it never converts anything."
                    hint="Display only; no conversion is applied anywhere.">
                    <Input value={p.unit ?? ""} placeholder="mm, kg, pcs…" style={{ width: "100%" }}
                      onInput={(e) => set({ unit: e.target.value || undefined })} />
                  </Field>

                  <Field label="Control" span={2}
                    help="Which input the salesperson gets. The panel on the right shows the result."
                    hint={UI_META[p.ui].hint}>
                    <SegmentedButton accessibleName="Control"
                      onSelectionChange={(e) => {
                        const v = (e.detail.selectedItems[0] as HTMLElement | undefined)?.dataset.v;
                        if (v) set({ ui: v as Param["ui"] });
                      }}>
                      {(Object.keys(UI_META) as Param["ui"][]).map((u) => (
                        <SegmentedButtonItem key={u} data-v={u} icon={UI_META[u].icon} selected={p.ui === u}
                          tooltip={UI_META[u].hint}>
                          {UI_META[u].text}
                        </SegmentedButtonItem>
                      ))}
                    </SegmentedButton>
                  </Field>

                  <Field label="Help text" span={2}
                    help="Becomes the information icon next to this field’s label on the form."
                    hint="One sentence is plenty — it shows on hover, not on the page.">
                    <TextArea rows={2} growing growingMaxRows={5} value={p.help ?? ""} style={{ width: "100%" }}
                      onInput={(e) => set({ help: e.target.value || undefined })} />
                  </Field>

                  <Field label="Extraction hint" span={2}
                    help="Tells the assistant where to look for this value on a customer drawing.">
                    <TextArea rows={2} growing growingMaxRows={5} value={p.extractionHint ?? ""} style={{ width: "100%" }}
                      placeholder='Where and how this appears on drawings, e.g. "title block MATERIAL field"'
                      onInput={(e) => set({ extractionHint: e.target.value || undefined })} />
                  </Field>
                </FormGroup>
              </Form>
            </div>
          </Tab>

          <Tab text="Value domain" design={dIssue ? "Negative" : "Default"} additionalText={dIssue ? "1" : undefined}>
            <div style={TAB_BODY}>
              <DomainEditor draft={draft} tables={tables} value={p.domain} issue={dIssue}
                onChange={(domain) => set({ domain })} />
            </div>
          </Tab>

          <Tab text="Behavior">
            <div style={TAB_BODY}>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                <MessageStrip design="Information" hideCloseButton>
                  Each box takes one expression. It can reference any parameter key, any computed value, and any
                  table column as <code>{"<param>_<column>"}</code>. Leaving a box empty switches that behavior off.
                </MessageStrip>
                <Form {...FORM_PROPS}>
                  <FormGroup>
                    <Field label="Default value"
                      help="Filled in automatically and marked “auto” until the salesperson overrides it."
                      hint="Recalculates whenever its inputs change, until edited by hand.">
                      <ExprInput optional rows={3} value={p.defaultExpr} model={scope} tables={suggestTables}
                        onChange={(v) => set({ defaultExpr: v })} />
                    </Field>
                    <Field label="Price formula"
                      help="This parameter’s contribution to the quote line, shown next to the field."
                      hint="The result appears at the top right of the field, in the model currency.">
                      <ExprInput optional rows={3} value={p.priceExpr} model={scope} tables={suggestTables}
                        onChange={(v) => set({ priceExpr: v })} />
                    </Field>
                    <Field label="Visible when"
                      help="Hides the field when this is false. A hidden field keeps the value it already had."
                      hint="Empty means always visible.">
                      <ExprInput optional rows={3} placeholder="always visible" value={p.visibleWhen} model={scope}
                        tables={suggestTables} onChange={(v) => set({ visibleWhen: v })} />
                    </Field>
                    <Field label="Required when"
                      help="Blocks the quote until the field has a value. Never fires while the field is hidden."
                      hint="Empty means never required.">
                      <ExprInput optional rows={3} placeholder="never required" value={p.requiredWhen} model={scope}
                        tables={suggestTables} onChange={(v) => set({ requiredWhen: v })} />
                    </Field>
                  </FormGroup>
                </Form>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "1rem",
                  paddingBlockStart: "0.75rem", borderBlockStart: "1px solid var(--sapList_BorderColor)" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.125rem" }}>
                    <CheckBox text="Read-only" checked={!!p.readonly}
                      onChange={(e) => set({ readonly: e.target.checked || undefined })} />
                    <Text style={HINT}>The salesperson sees the value but cannot change it. Right for anything a default formula owns.</Text>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.125rem" }}>
                    <CheckBox text="Exclude from domains" checked={!!p.excludeFromDomains}
                      onChange={(e) => set({ excludeFromDomains: e.target.checked || undefined })} />
                    <Text style={HINT}>This parameter stops narrowing other parameters’ options. Turn it on when it is an outcome, not a choice.</Text>
                  </div>
                </div>
              </div>
            </div>
          </Tab>

        </TabContainer>

        <div style={{ flex: "0 0 20rem", display: "flex", flexDirection: "column", gap: "0.75rem", padding: "1rem",
          borderInlineStart: "1px solid var(--sapList_BorderColor)", background: "var(--sapBackgroundColor)" }}>
          <ParamPreview p={p} queryTables={draft.queryTables} issue={dIssue} warning={cIssue} />
        </div>
      </div>
    </Dialog>
  );
}

/** The field as the salesperson will meet it. Same branch order as ConfiguratorForm's `control()`,
 *  so the preview and the real form can never disagree about which widget a parameter gets. */
function ParamPreview({ p, queryTables, issue, warning }: {
  p: Param; queryTables: ModelDef["queryTables"]; issue?: string; warning?: string;
}) {
  const ref = p.domain?.kind === "options" ? p.domain.ref : undefined;
  // Only the fields that decide *which* options come back — refetching when the picker's display
  // columns change would be pure waste. JSON in/out keeps the effect deps primitive.
  const fetchKey = !ref || ref.source === "manual" ? ""
    : JSON.stringify(ref.source === "table"
      ? { source: "table", table: ref.table, valueCol: ref.valueCol, labelCol: ref.labelCol }
      : { source: "query", table: ref.table });
  const qtKey = JSON.stringify(queryTables);
  const [state, setState] = useState<{ busy?: boolean; options?: EngineOption[]; error?: string }>({});

  useEffect(() => {
    if (!fetchKey) return setState({});
    const r = JSON.parse(fetchKey) as LookupRef;
    if (domainIssue({ ...p, domain: { kind: "options", ref: r } })) return setState({});
    let live = true;
    setState({ busy: true });
    // ponytail: fires on every source/column change — the pickers are discrete clicks, so no debounce.
    client.models.lookupPreview({ ref: r, queryTables: JSON.parse(qtKey) as ModelDef["queryTables"], limit: 20 })
      .then((res) => { if (live) setState({ options: res.options }); })
      .catch((e) => { if (live) setState({ error: e instanceof Error ? e.message : String(e) }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchKey/qtKey are the serialised deps
  }, [fetchKey, qtKey]);

  const range = p.domain?.kind === "range" ? p.domain : undefined;
  const options: EngineOption[] = p.type === "boolean"
    ? [{ value: true, label: "Yes" }, { value: false, label: "No" }]
    : ref?.source === "manual"
      ? ref.options.map((o) => ({ value: o.value, label: o.label ?? String(o.value) }))
      : (state.options ?? []);
  const first = options[0];

  const control = () => {
    if (p.ui === "radio")
      return (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem 1rem" }}>
          {options.slice(0, 4).map((o, i) => (
            <RadioButton key={i} name="hera-preview" text={o.label} checked={i === 0} readonly />
          ))}
        </div>
      );
    if (p.ui === "checkbox" || (p.type === "boolean" && p.ui !== "select"))
      return <CheckBox text={p.label} readonly />;
    if (p.ui === "multicombo")
      return (
        <MultiComboBox style={{ width: "100%" }} readonly>
          {options.slice(0, 8).map((o, i) => (
            <MultiComboBoxItem key={i} text={String(o.value)} selected={i < 2} />
          ))}
        </MultiComboBox>
      );
    if (p.ui === "step")
      return <StepInput style={{ width: "100%" }} readonly value={range?.min ?? 0} min={range?.min} max={range?.max} step={range?.step ?? 1} />;
    if (options.length)
      return (
        <Select style={{ width: "100%" }} readonly>
          {options.slice(0, 20).map((o, i) => (
            <Option key={i} selected={i === 0}>{o.label}</Option>
          ))}
        </Select>
      );
    return <Input style={{ width: "100%" }} readonly type={p.type === "number" ? "Number" : "Text"}
      value={first === undefined ? "" : String(first.value)} />;
  };

  const status = (): { state: "Positive" | "Negative" | "Information" | "None"; text: string } => {
    if (issue) return { state: "Negative", text: issue };
    if (state.error) return { state: "Negative", text: state.error };
    if (state.busy) return { state: "Information", text: "Resolving options…" };
    if (range) return { state: "Positive", text: `Any number from ${range.min} to ${range.max}, in steps of ${range.step ?? 1}.` };
    if (!p.domain && p.type !== "boolean") return { state: "None", text: "Free entry — whatever the salesperson types is accepted." };
    if (!options.length) return { state: "Information", text: "No options resolved from this source." };
    const src = ref?.source === "table" ? ` from ${ref.table}.${ref.valueCol}`
      : ref?.source === "query" ? ` loaded from ${ref.table} on demand`
        : ref?.source === "manual" ? " from the manual list" : "";
    return { state: "Positive", text: `${options.length} option${options.length === 1 ? "" : "s"}${src}.` };
  };
  const s = status();

  return (
    <>
      <Title level="H6" style={{ paddingBlockEnd: "0.375rem", borderBlockEnd: "1px solid var(--sapGroup_TitleBorderColor)" }}>
        On the form
      </Title>

      {p.label ? (
        <Card>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", padding: "1rem" }}>
            <Label>
              {p.label + (p.unit ? ` (${p.unit})` : "")}
              {p.help ? <Icon name="message-information" title={p.help} accessibleName={p.help}
                style={{ marginInlineStart: "0.375rem", cursor: "help", color: "var(--sapContent_IconColor)" }} /> : null}
            </Label>
            {control()}
          </div>
        </Card>
      ) : (
        <IllustratedMessage name="AddColumn" design="Dot" titleText="Name it first"
          subtitleText="Give the parameter a label and it appears here as the salesperson will see it." />
      )}

      <ObjectStatus state={s.state} style={{ whiteSpace: "normal" }}>{s.text}</ObjectStatus>
      {warning ? <MessageStrip design="Critical" hideCloseButton>{warning}</MessageStrip> : null}

      <Text style={{ ...HINT, marginBlockStart: "auto" }}>
        Rules can still remove options at runtime — this is the field before any rule fires.
      </Text>
    </>
  );
}

function DomainEditor({ draft, tables, value, issue, onChange }: {
  draft: ModelDef; tables: Tables; value: Param["domain"]; issue?: string;
  onChange: (d: Param["domain"]) => void;
}) {
  const kind = value === undefined ? "none" : value.kind === "range" ? "range" : value.ref.source;
  const tenantNames = tables.map((t) => t.name);
  const queryNames = draft.queryTables.map((q) => q.name);
  const columnsOf = (name: string) =>
    tables.find((t) => t.name === name)?.columns ??
    draft.queryTables.find((q) => q.name === name)?.columns ?? [];

  const setKind = (k: string) => {
    if (k === "none") onChange(undefined);
    else if (k === "range") onChange({ kind: "range", min: 0, max: 100, step: 1 });
    else if (k === "manual") onChange({ kind: "options", ref: { source: "manual", options: [] } });
    else if (k === "table") onChange({ kind: "options", ref: { source: "table", table: tenantNames[0] ?? "", valueCol: "" } });
    else onChange({ kind: "options", ref: { source: "query", table: queryNames[0] ?? "" } });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <Label>
          Where the values come from
          <Icon name="message-information" style={{ marginInlineStart: "0.375rem", cursor: "help", color: "var(--sapContent_NonInteractiveIconColor)" }}
            title="The set of values this parameter may take before any rule narrows it."
            accessibleName="The set of values this parameter may take before any rule narrows it." />
        </Label>
        <SegmentedButton accessibleName="Value domain"
          onSelectionChange={(e) => {
            const v = (e.detail.selectedItems[0] as HTMLElement | undefined)?.dataset.v;
            if (v && v !== kind) setKind(v);
          }}>
          {DOMAIN_KINDS.map(([v, l]) => (
            <SegmentedButtonItem key={v} data-v={v} selected={kind === v}>{l}</SegmentedButtonItem>
          ))}
        </SegmentedButton>
      </div>

      <div style={{ border: "1px solid var(--sapList_BorderColor)", borderRadius: "var(--sapElement_BorderCornerRadius)", padding: "1rem" }}>
        {value === undefined ? (
          <IllustratedMessage name="AddColumn" design="Dialog" titleText="Free entry"
            subtitleText="The salesperson types whatever they like. Nothing constrains the value here — combination rules on the Rules tab still apply." />
        ) : null}

        {value?.kind === "range" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <div style={{ display: "flex", gap: "0.75rem", maxWidth: "30rem" }}>
              <div style={{ flex: 1 }}>
                <Label>Minimum</Label>
                <StepInput style={{ width: "100%" }} value={value.min} onChange={(e) => onChange({ ...value, min: e.target.value ?? 0 })} />
              </div>
              <div style={{ flex: 1 }}>
                <Label>Maximum</Label>
                <StepInput style={{ width: "100%" }} value={value.max} onChange={(e) => onChange({ ...value, max: e.target.value ?? 0 })} />
              </div>
              <div style={{ flex: 1 }}>
                <Label>Step</Label>
                <StepInput style={{ width: "100%" }} value={value.step ?? 1} min={0} onChange={(e) => onChange({ ...value, step: e.target.value || undefined })} />
              </div>
            </div>
            <Text style={HINT}>A range only makes sense on a number type. The stepper enforces the bounds; a “required when” formula can still narrow them further.</Text>
          </div>
        ) : null}

        {value?.kind === "options" && value.ref.source === "manual" ? (
          <ManualOptions ref_={value.ref} onChange={(ref) => onChange({ kind: "options", ref })} />
        ) : null}

        {value?.kind === "options" && (value.ref.source === "table" || value.ref.source === "query") ? (
          <SourceRefEditor ref_={value.ref} issue={issue}
            names={value.ref.source === "table" ? tenantNames : queryNames}
            columnsOf={columnsOf}
            onChange={(ref) => onChange({ kind: "options", ref })} />
        ) : null}
      </div>
    </div>
  );
}

// One editor for both named sources: pick the source and which extra columns to expose
// (default: all). Query refs take their key/label columns by convention (refKeyCols).
function SourceRefEditor({ ref_, names, columnsOf, issue, onChange }: {
  ref_: Extract<LookupRef, { source: "table" | "query" }>;
  names: string[];
  columnsOf: (name: string) => string[];
  issue?: string;
  onChange: (r: LookupRef) => void;
}) {
  const cols = columnsOf(ref_.table);
  const { valueCol } = refKeyCols(ref_, cols);
  const extra = cols.filter((c) => c !== valueCol);
  const displayed = ref_.columns ?? extra;
  const setTable = (name: string) =>
    onChange(ref_.source === "query" ? { source: "query", table: name } : { source: "table", table: name, valueCol: "" });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "0.75rem" }}>
        <div>
          <Label>{ref_.source === "table" ? "Table" : "Query"}</Label>
          <Select style={{ width: "100%" }} value={ref_.table}
            onChange={(e) => setTable((e.detail.selectedOption as HTMLElement).dataset.v!)}>
            {names.length === 0 ? <Option value="" data-v="">— none defined —</Option> : null}
            {names.map((n) => <Option key={n} value={n} data-v={n}>{n}</Option>)}
          </Select>
        </div>
        {ref_.source === "table" ? (
          <>
            <div>
              <Label required>Value column</Label>
              <Select style={{ width: "100%" }} value={ref_.valueCol} valueState={issue && !ref_.valueCol ? "Negative" : "None"}
                onChange={(e) => onChange({ ...ref_, valueCol: (e.detail.selectedOption as HTMLElement).dataset.v! })}>
                <Option value="" data-v="">value column…</Option>
                {cols.map((c) => <Option key={c} value={c} data-v={c}>{c}</Option>)}
              </Select>
            </div>
            <div>
              <Label>Label column</Label>
              <Select style={{ width: "100%" }} value={ref_.labelCol ?? ""} onChange={(e) => {
                const v = (e.detail.selectedOption as HTMLElement).dataset.v!;
                onChange({ ...ref_, labelCol: v || undefined });
              }}>
                <Option value="" data-v="">label column (optional)…</Option>
                {cols.map((c) => <Option key={c} value={c} data-v={c}>{c}</Option>)}
              </Select>
            </div>
          </>
        ) : (
          <Text style={{ alignSelf: "center", gridColumn: "span 2" }}>
            Key = 1st query column{cols[1] ? `, label = 2nd (${cols[0]} / ${cols[1]})` : ""}.
          </Text>
        )}
      </div>

      <div>
        <Label>
          Columns shown in the picker
          <Icon name="message-information" style={{ marginInlineStart: "0.375rem", cursor: "help", color: "var(--sapContent_NonInteractiveIconColor)" }}
            title="Only changes what the salesperson sees. Every column stays usable in formulas."
            accessibleName="Only changes what the salesperson sees. Every column stays usable in formulas." />
        </Label>
        <MultiComboBox style={{ width: "100%" }}
          onSelectionChange={(e) => {
            const sel = e.detail.items.map((i) => (i as HTMLElement).getAttribute("text")!);
            onChange({ ...ref_, columns: sel.length === extra.length ? undefined : sel });
          }}>
          {extra.map((c) => (
            <MultiComboBoxItem key={c} text={c} selected={displayed.includes(c)} />
          ))}
        </MultiComboBox>
      </div>

      <MessageStrip design="Information" hideCloseButton>
        Every column of {ref_.table || "this source"} is already usable in formulas as{" "}
        <code>{"<param>_<column>"}</code>. Tables and queries themselves are defined on the Tables tab.
      </MessageStrip>
    </div>
  );
}

function ManualOptions({ ref_, onChange }: {
  ref_: Extract<LookupRef, { source: "manual" }>;
  onChange: (r: LookupRef) => void;
}) {
  const setOpt = (i: number, patch: { value?: string; label?: string }) =>
    onChange({
      ...ref_,
      options: ref_.options.map((o, j) => {
        if (j !== i) return o;
        const raw = patch.value;
        // numbers stay numbers so table constraints compare correctly
        const value = raw === undefined ? o.value : raw !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
        return { value, label: patch.label !== undefined ? patch.label || undefined : o.label };
      }),
    });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      {ref_.options.map((o, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.7fr) 2.25rem", gap: "0.5rem" }}>
          <Input placeholder="value" value={String(o.value ?? "")} onInput={(e) => setOpt(i, { value: e.target.value })} />
          <Input placeholder="label (optional)" value={o.label ?? ""} onInput={(e) => setOpt(i, { label: e.target.value })} />
          <Button icon="delete" design="Transparent" tooltip="Remove option" accessibleName="Remove option"
            onClick={() => onChange({ ...ref_, options: ref_.options.filter((_, j) => j !== i) })} />
        </div>
      ))}
      <Button icon="add" style={{ alignSelf: "start" }}
        onClick={() => onChange({ ...ref_, options: [...ref_.options, { value: "" }] })}>Add option</Button>
      <Text style={HINT}>Numeric-looking values stay numbers, so table constraints still compare them correctly.</Text>
    </div>
  );
}
