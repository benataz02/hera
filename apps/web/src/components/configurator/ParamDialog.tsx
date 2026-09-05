import { useState } from "react";
import {
  Bar, Button, CheckBox, Dialog, FlexBox, Form, FormGroup, FormItem, Icon, Input, Label,
  MessageStrip, MultiComboBox, MultiComboBoxItem, ObjectPage, ObjectPageSection, ObjectPageTitle,
  Option, SegmentedButton, SegmentedButtonItem, Select, StepInput, Text, TextArea, Title,
} from "@ui5/webcomponents-react";
import { refKeyCols } from "@hera/config-engine";
import type { LookupRef, ModelDef, Param } from "@hera/config-engine";
import { ExprInput } from "./ExprInput.tsx";
import { modelWithParam, type TableCols } from "./exprHelpers.ts";

type Tables = TableCols[];

// labelSpan 12 = labels on top, the shape ConfiguratorForm uses, so a field looks identical here
// and on the real form. A group flows its items across the columns it spans, so PAIRS puts two
// fields per row and FULL one — that is the only way to give a field the whole width.
const PAIRS = { labelSpan: "S12 M12 L12 XL12", layout: "S1 M2 L2 XL2", headerLevel: "H5" } as const;
const FULL = { labelSpan: "S12 M12 L12 XL12", layout: "S1 M1 L1 XL1", headerLevel: "H5" } as const;
const W = { width: "100%" } as const;
const ICON = { marginInlineStart: "0.375rem", cursor: "help", color: "var(--sapContent_NonInteractiveIconColor)" } as const;

// The ObjectPage brings its own padding and needs a height to scroll in — the dialog's own padding
// would double up on it.
if (typeof document !== "undefined") {
  let el = document.getElementById("hera-pd-style");
  if (!el) { el = document.createElement("style"); el.id = "hera-pd-style"; document.head.appendChild(el); }
  el.textContent = `.hera-pd::part(content){padding:0;}`;
}

/** Label + the ⓘ carrying the field's explanation — the only help a field gets. */
const lbl = (text: string, help: string, required?: boolean) => (
  <Label required={required}>
    {text}
    <Icon name="message-information" title={help} accessibleName={help} style={ICON} />
  </Label>
);

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

/** Doesn't block Save — the model still checks out, the type/control pairing just won't behave. */
function controlIssue(p: Param): string | undefined {
  if (p.ui === "checkbox" && p.type !== "boolean") return "A checkbox stores true or false — set the type to boolean.";
  if (p.ui === "step" && p.type !== "number") return "A stepper counts — set the type to number.";
  if ((p.ui === "select" || p.ui === "radio" || p.ui === "multicombo") && !p.domain && p.type !== "boolean")
    return "This control needs something to list — give it a manual list, a table or a query under Value domain.";
  return undefined;
}

export function ParamDialog({ draft, tables, initial, isNew, onOk, onCancel }: {
  draft: ModelDef; tables: Tables; initial: Param; isNew: boolean;
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
    <Dialog open onClose={onCancel} className="hera-pd"
      accessibleName={isNew ? "Add parameter" : `Edit parameter ${initial.key}`}
      style={{ width: "min(76rem, 96vw)" }}
      footer={
        <Bar design="Footer" endContent={
          <>
            <Button design="Emphasized" disabled={!keyOk || keyTaken || !p.label || !!dIssue}
              onClick={() => onOk(p)}>Save</Button>
            <Button onClick={onCancel}>Cancel</Button>
          </>
        } />
      }>
      {/* Sections MUST be flat children — ObjectPage walks them with React.Children, which skips
          fragments. Default mode: one scroll, the anchor bar jumps between the three. */}
      <ObjectPage hidePinButton style={{ height: "min(42rem, 74vh)" }}
        titleArea={
          <ObjectPageTitle header={<Title level="H4">{p.label || (isNew ? "New parameter" : initial.key)}</Title>}
            subHeader={<Text>{[p.key, p.type, UI_META[p.ui].text.toLowerCase()].filter(Boolean).join(" · ")}</Text>} />
        }>

        <ObjectPageSection id="definition" titleText="Definition">
          {cIssue ? <MessageStrip design="Critical" hideCloseButton>{cIssue}</MessageStrip> : null}

          <Form {...PAIRS}>
            <FormGroup accessibleName="Definition">
              <FormItem labelContent={lbl("Key", "The name formulas use to refer to this parameter. Fixed once the parameter exists: renaming it would break every formula that mentions it.", true)}>
                {/* An untouched new dialog isn't an error yet — only complain once something is typed. */}
                <Input value={p.key} disabled={!isNew} style={W}
                  valueState={!p.key || (keyOk && !keyTaken) ? "None" : "Negative"}
                  valueStateMessage={<div>{keyTaken ? "A parameter with this key already exists." : "Letters, digits and underscore only, and it cannot start with a digit."}</div>}
                  onInput={(e) => set({ key: e.target.value })} />
              </FormItem>

              <FormItem labelContent={lbl("Label", "What the salesperson sees above the field on the configuration form. The unit, if set, is appended in brackets.", true)}>
                <Input value={p.label} style={W} onInput={(e) => set({ label: e.target.value })} />
              </FormItem>

              <FormItem labelContent={lbl("Type", "How the value is stored and compared. Numbers compare and add up in formulas; text does not.")}>
                <Select value={p.type} style={W}
                  onChange={(e) => set({ type: (e.detail.selectedOption as HTMLElement).dataset.v as Param["type"] })}>
                  {(["string", "number", "boolean"] as const).map((t) => <Option key={t} value={t} data-v={t}>{t}</Option>)}
                </Select>
              </FormItem>

              <FormItem labelContent={lbl("Unit", "Appended to the label in brackets. Display only — it never converts anything.")}>
                <Input value={p.unit ?? ""} placeholder="mm, kg, pcs…" style={W}
                  onInput={(e) => set({ unit: e.target.value || undefined })} />
              </FormItem>
            </FormGroup>
          </Form>

          <Form {...FULL}>
            <FormGroup accessibleName="Control">
              <FormItem labelContent={lbl("Control", `Which input the salesperson gets on the configuration form. ${UI_META[p.ui].hint}`)}>
                <SegmentedButton accessibleName="Control" style={W}
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
              </FormItem>
            </FormGroup>
          </Form>

          <Form {...PAIRS}>
            <FormGroup accessibleName="On the form">
              <FormItem labelContent={lbl("Default value", "Filled in automatically and marked “auto”, recalculating whenever its inputs change, until the salesperson edits it by hand.")}>
                <ExprInput optional rows={3} value={p.defaultExpr} model={scope} tables={tables}
                  onChange={(v) => set({ defaultExpr: v })} />
              </FormItem>

              <FormItem labelContent={lbl("Help text", "Becomes the information icon next to this field’s label on the form. One sentence is plenty.")}>
                <TextArea rows={3} value={p.help ?? ""} style={W}
                  onInput={(e) => set({ help: e.target.value || undefined })} />
              </FormItem>

              <FormItem labelContent={lbl("Extraction hint", "Tells the assistant where to look for this value on a customer drawing.")}>
                <TextArea rows={3} value={p.extractionHint ?? ""} style={W}
                  placeholder="Where and how this appears on drawings, e.g. title block MATERIAL field"
                  onInput={(e) => set({ extractionHint: e.target.value || undefined })} />
              </FormItem>

              <FormItem labelContent={lbl("Options", "Read-only: the salesperson sees the value but cannot change it — right for anything a default formula owns. Exclude from domains: this parameter stops narrowing other parameters’ options, for when it is an outcome rather than a choice.")}>
                <FlexBox direction="Column" gap="0.5rem">
                  <CheckBox text="Read-only" checked={!!p.readonly}
                    onChange={(e) => set({ readonly: e.target.checked || undefined })} />
                  <CheckBox text="Exclude from domains" checked={!!p.excludeFromDomains}
                    onChange={(e) => set({ excludeFromDomains: e.target.checked || undefined })} />
                </FlexBox>
              </FormItem>
            </FormGroup>
          </Form>
        </ObjectPageSection>

        <ObjectPageSection id="domain" titleText="Value domain">
          <Form {...PAIRS}>
            <FormGroup accessibleName="Value domain">
              <DomainEditor tables={tables} value={p.domain} onChange={(domain) => set({ domain })} />
            </FormGroup>
          </Form>
        </ObjectPageSection>

        <ObjectPageSection id="behavior" titleText="Behavior">
          <Form {...PAIRS}>
            <FormGroup accessibleName="Behavior">
              <FormItem labelContent={lbl("Price formula", "This parameter’s contribution to the quote line. The result appears at the top right of the field, in the model currency.")}>
                <ExprInput optional rows={3} value={p.priceExpr} model={scope} tables={tables}
                  onChange={(v) => set({ priceExpr: v })} />
              </FormItem>

              <FormItem labelContent={lbl("Visible when", "Hides the field when this is false; a hidden field keeps the value it already had. Empty means always visible.")}>
                <ExprInput optional rows={3} placeholder="always visible" value={p.visibleWhen} model={scope}
                  tables={tables} onChange={(v) => set({ visibleWhen: v })} />
              </FormItem>

              <FormItem labelContent={lbl("Required when", "Blocks the quote until the field has a value. Never fires while the field is hidden; empty means never required.")}>
                <ExprInput optional rows={3} placeholder="never required" value={p.requiredWhen} model={scope}
                  tables={tables} onChange={(v) => set({ requiredWhen: v })} />
              </FormItem>
            </FormGroup>
          </Form>
        </ObjectPageSection>

      </ObjectPage>
    </Dialog>
  );
}

// Bare FormItems: the caller owns the Form and its group, so the domain fields flow in the same
// two columns as every other field.
function DomainEditor({ tables, value, onChange }: {
  tables: Tables; value: Param["domain"]; onChange: (d: Param["domain"]) => void;
}) {
  const kind = value === undefined ? "none" : value.kind === "range" ? "range" : value.ref.source;
  // One masterdata namespace, split by kind: a "table" ref reads maintained rows, a "query" ref
  // pages a live read.
  const tenantNames = tables.filter((t) => t.kind === "table").map((t) => t.name);
  const queryNames = tables.filter((t) => t.kind === "query").map((t) => t.name);
  const columnsOf = (name: string) => tables.find((t) => t.name === name)?.columns ?? [];

  const setKind = (k: string) => {
    if (k === "none") onChange(undefined);
    else if (k === "range") onChange({ kind: "range", min: 0, max: 100, step: 1 });
    else if (k === "manual") onChange({ kind: "options", ref: { source: "manual", options: [] } });
    else if (k === "table") onChange({ kind: "options", ref: { source: "table", table: tenantNames[0] ?? "", valueCol: "" } });
    else onChange({ kind: "options", ref: { source: "query", table: queryNames[0] ?? "" } });
  };

  return (
    <>
      <FormItem labelContent={lbl("Where the values come from", "The set of values this parameter may take before any rule narrows it. Free entry constrains nothing — combination rules on the Rules tab still apply.")}>
        <SegmentedButton accessibleName="Value domain" style={W}
          onSelectionChange={(e) => {
            const v = (e.detail.selectedItems[0] as HTMLElement | undefined)?.dataset.v;
            if (v && v !== kind) setKind(v);
          }}>
          {DOMAIN_KINDS.map(([v, l]) => (
            <SegmentedButtonItem key={v} data-v={v} selected={kind === v}>{l}</SegmentedButtonItem>
          ))}
        </SegmentedButton>
      </FormItem>

      {value?.kind === "range" ? (
        <>
          <FormItem labelContent={lbl("Minimum", "A range only makes sense on a number type. The stepper enforces the bounds; a “required when” formula can still narrow them.")}>
            <StepInput style={W} value={value.min} onChange={(e) => onChange({ ...value, min: e.target.value ?? 0 })} />
          </FormItem>
          <FormItem labelContent={<Label>Maximum</Label>}>
            <StepInput style={W} value={value.max} onChange={(e) => onChange({ ...value, max: e.target.value ?? 0 })} />
          </FormItem>
          <FormItem labelContent={<Label>Step</Label>}>
            <StepInput style={W} value={value.step ?? 1} min={0} onChange={(e) => onChange({ ...value, step: e.target.value || undefined })} />
          </FormItem>
        </>
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
    </>
  );
}

// One editor for both named sources: pick the source and which extra columns to expose
// (default: all). Query refs take their key/label columns by convention (refKeyCols).
function SourceRefEditor({ ref_, names, columnsOf, onChange }: {
  ref_: Extract<LookupRef, { source: "table" | "query" }>;
  names: string[];
  columnsOf: (name: string) => string[];
  onChange: (r: LookupRef) => void;
}) {
  const cols = columnsOf(ref_.table);
  const { valueCol } = refKeyCols(ref_, cols);
  const extra = cols.filter((c) => c !== valueCol);
  const displayed = ref_.columns ?? extra;
  const isTable = ref_.source === "table";
  const setTable = (name: string) =>
    onChange(ref_.source === "query" ? { source: "query", table: name } : { source: "table", table: name, valueCol: "" });

  return (
    <>
      <FormItem labelContent={lbl(isTable ? "Table" : "Query",
        isTable
          ? "Rows maintained in HERA, on the Masterdata page."
          : `A live read from B1/Beas, paged on demand. Key = 1st query column${cols[1] ? `, label = 2nd (${cols[0]} / ${cols[1]})` : ""}.`,
        true)}>
        <Select style={W} value={ref_.table}
          valueState={!ref_.table ? "Negative" : "None"}
          valueStateMessage={<div>{names.length === 0
            ? `No ${isTable ? "tables" : "queries"} are defined yet — add one on the Masterdata page.`
            : `Choose a ${isTable ? "table" : "query"}.`}</div>}
          onChange={(e) => setTable((e.detail.selectedOption as HTMLElement).dataset.v!)}>
          {names.length === 0 ? <Option value="" data-v="">— none defined —</Option> : null}
          {names.map((n) => <Option key={n} value={n} data-v={n}>{n}</Option>)}
        </Select>
      </FormItem>

      {ref_.source === "table" ? (
        <>
          <FormItem labelContent={lbl("Value column", "The column holding the value this parameter takes.", true)}>
            <Select style={W} value={ref_.valueCol}
              valueState={ref_.table && !ref_.valueCol ? "Negative" : "None"}
              valueStateMessage={<div>Pick the column holding the value this parameter takes.</div>}
              onChange={(e) => onChange({ ...ref_, valueCol: (e.detail.selectedOption as HTMLElement).dataset.v! })}>
              <Option value="" data-v="">value column…</Option>
              {cols.map((c) => <Option key={c} value={c} data-v={c}>{c}</Option>)}
            </Select>
          </FormItem>
          <FormItem labelContent={lbl("Label column", "Shown instead of the value where there is room for it.")}>
            <Select style={W} value={ref_.labelCol ?? ""} onChange={(e) => {
              const v = (e.detail.selectedOption as HTMLElement).dataset.v!;
              onChange({ ...ref_, labelCol: v || undefined });
            }}>
              <Option value="" data-v="">label column (optional)…</Option>
              {cols.map((c) => <Option key={c} value={c} data-v={c}>{c}</Option>)}
            </Select>
          </FormItem>
        </>
      ) : null}

      <FormItem labelContent={lbl("Columns shown in the picker",
        `Only changes what the salesperson sees: every column of ${ref_.table || "this source"} stays usable in formulas as <param>_<column>.`)}>
        <MultiComboBox style={W}
          onSelectionChange={(e) => {
            const sel = e.detail.items.map((i) => (i as HTMLElement).getAttribute("text")!);
            onChange({ ...ref_, columns: sel.length === extra.length ? undefined : sel });
          }}>
          {extra.map((c) => (
            <MultiComboBoxItem key={c} text={c} selected={displayed.includes(c)} />
          ))}
        </MultiComboBox>
      </FormItem>
    </>
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
    <FormItem labelContent={lbl("Options", "The list this parameter offers. Numeric-looking values stay numbers, so table constraints still compare them correctly.")}>
      <FlexBox direction="Column" gap="0.5rem" style={W}>
        {ref_.options.map((o, i) => (
          <FlexBox key={i} gap="0.5rem" alignItems="Center">
            <Input placeholder="value" style={{ flex: 1 }} value={String(o.value ?? "")}
              onInput={(e) => setOpt(i, { value: e.target.value })} />
            <Input placeholder="label (optional)" style={{ flex: 1 }} value={o.label ?? ""}
              onInput={(e) => setOpt(i, { label: e.target.value })} />
            <Button icon="delete" design="Transparent" tooltip="Remove option" accessibleName="Remove option"
              onClick={() => onChange({ ...ref_, options: ref_.options.filter((_, j) => j !== i) })} />
          </FlexBox>
        ))}
        <Button icon="add" style={{ alignSelf: "start" }}
          onClick={() => onChange({ ...ref_, options: [...ref_.options, { value: "" }] })}>Add option</Button>
      </FlexBox>
    </FormItem>
  );
}
