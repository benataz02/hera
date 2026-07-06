import { useState } from "react";
import {
  Bar, Button, Dialog, Icon, Input, Label, List, ListItemStandard, MessageStrip,
  Option, Select, StepInput, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow,
  TableRowAction, Text, Title,
} from "@ui5/webcomponents-react";
import type { Issue, LookupRef, ModelDef, Option as EngineOption, Param } from "@hera/config-engine";
import { client } from "../../orpc.ts";
import { ExprInput } from "./ExprInput.tsx";
import { issueFor } from "./useDraftModel.ts";
import { applyMove, canDrop, parseRowKey, placeParam, removeFromStructure, rowKeyOf, unplacedParams, type Placement } from "./structureOps.ts";

type Tables = { name: string; columns: { key: string }[] }[];
type Update = (fn: (d: ModelDef) => ModelDef) => void;

const UI_KINDS = ["input", "select", "radio", "checkbox", "multicombo", "step"] as const;

const emptyParam = (): Param => ({ key: "", label: "", type: "string", ui: "select" });

export function ParamsTab({ draft, update, issues, tables }: {
  draft: ModelDef; update: Update; issues: Issue[]; tables: Tables;
}) {
  const [editing, setEditing] = useState<{ param: Param; isNew: boolean } | null>(null);
  const [titleEdit, setTitleEdit] = useState<string | null>(null);
  // Keyed by stable section/group key (not row index) so collapse survives drag-reordering.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setCollapsed((c) => { const n = new Set(c); n.delete(id) || n.add(id); return n; });

  type Row = { key: string; depth: number; label: string; detail: string; ref: ReturnType<typeof parseRowKey>; collapseId?: string };
  const rows: Row[] = [];
  draft.structure.sections.forEach((s, si) => {
    const sId = `S:${s.key}`;
    rows.push({ key: `s:${si}`, depth: 0, label: s.title, detail: `section · ${s.key}`, ref: { kind: "section", s: si }, collapseId: sId });
    if (collapsed.has(sId)) return;
    s.groups.forEach((g, gi) => {
      const gId = `G:${s.key}/${g.key}`;
      rows.push({ key: `g:${si}.${gi}`, depth: 1, label: g.title, detail: `group · ${g.key}`, ref: { kind: "group", s: si, g: gi }, collapseId: gId });
      if (collapsed.has(gId)) return;
      g.params.forEach((pk) => {
        const p = draft.parameters.find((x) => x.key === pk);
        rows.push({
          key: `p:${pk}`, depth: 2, label: p?.label || pk,
          detail: p ? `${p.type} · ${p.ui}${p.domain ? (p.domain.kind === "range" ? " · range" : ` · ${p.domain.ref.source}`) : ""}` : "missing definition",
          ref: { kind: "param", key: pk },
        });
      });
    });
  });
  const loose = unplacedParams(draft);
  // Model-level issues have no row of their own (duplicate key, computed cycle, bad structure ref).
  const modelIssues = issues.filter((i) => i.path === "model" || i.path === "computed" || i.path === "structure");

  const saveParam = (p: Param, isNew: boolean, place?: { s: number; g: number }) =>
    update((d) => {
      const parameters = isNew
        ? [...d.parameters, p]
        : d.parameters.map((x) => (x.key === editing!.param.key || x.key === p.key ? p : x));
      let out = { ...d, parameters };
      if (isNew && place) out = placeParam(out, p.key, place.s, place.g);
      return out;
    });

  const deleteRow = (ref: ReturnType<typeof parseRowKey>) =>
    update((d) => {
      let out = removeFromStructure(d, ref);
      if (ref.kind === "param") out = { ...out, parameters: out.parameters.filter((p) => p.key !== ref.key) };
      return out;
    });

  const addKey = (base: string, taken: string[]) => {
    let k = base, n = 2;
    while (taken.includes(k)) k = `${base}${n++}`;
    return k;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", padding: "1rem" }}>
      {modelIssues.length ? (
        <MessageStrip design="Negative" hideCloseButton>
          {modelIssues.map((i) => i.message).join(" · ")}
        </MessageStrip>
      ) : null}
      <Bar design="Subheader"
        startContent={<Title level="H5">Form structure</Title>}
        endContent={
          <>
            <Button icon="add" onClick={() => update((d) => ({
              ...d,
              structure: { sections: [...d.structure.sections, { key: addKey("section", d.structure.sections.map((s) => s.key)), title: "New section", groups: [] }] },
            }))}>Add section</Button>
            <Button icon="add" disabled={!draft.structure.sections.length} onClick={() => update((d) => ({
              ...d,
              structure: {
                sections: d.structure.sections.map((s, i, arr) => i !== arr.length - 1 ? s : {
                  ...s, groups: [...s.groups, { key: addKey("group", s.groups.map((g) => g.key)), title: "New group", params: [] }],
                }),
              },
            }))}>Add group</Button>
            <Button icon="add" design="Emphasized" disabled={!draft.structure.sections.some((s) => s.groups.length)}
              onClick={() => setEditing({ param: emptyParam(), isNew: true })}>Add parameter</Button>
          </>
        }
      />

      <Table
        noDataText="Add a section to start structuring the form."
        rowActionCount={1}
        onMoveOver={(e) => {
          const src = (e.detail.source.element as HTMLElement | null)?.getAttribute("row-key");
          const dst = (e.detail.destination.element as HTMLElement | null)?.getAttribute("row-key");
          const placement = e.detail.destination.placement as Placement;
          if (src && dst && canDrop(draft, src, dst, placement)) e.preventDefault();
        }}
        onMove={(e) => {
          const src = (e.detail.source.element as HTMLElement | null)?.getAttribute("row-key");
          const dst = (e.detail.destination.element as HTMLElement | null)?.getAttribute("row-key");
          const placement = e.detail.destination.placement as Placement;
          if (src && dst) update((d) => applyMove(d, src, dst, placement));
        }}
        onRowActionClick={(e) => deleteRow(parseRowKey(((e.detail.row as unknown) as HTMLElement).getAttribute("row-key")!))}
        onRowClick={(e) => {
          const ref = parseRowKey(((e.detail.row as unknown) as HTMLElement).getAttribute("row-key")!);
          if (ref.kind === "param") {
            const p = draft.parameters.find((x) => x.key === ref.key);
            if (p) setEditing({ param: structuredClone(p), isNew: false });
          } else {
            setTitleEdit(rowKeyOf(ref));
          }
        }}
        headerRow={
          <TableHeaderRow>
            <TableHeaderCell width="45%"><span>Structure</span></TableHeaderCell>
            <TableHeaderCell><span>Details</span></TableHeaderCell>
          </TableHeaderRow>
        }
      >
        {rows.map((r) => (
          <TableRow key={r.key} rowKey={r.key} movable interactive
            actions={<TableRowAction icon="delete" text="Delete" />}>
            <TableCell>
                <span style={{ width: "1rem", display: "inline-flex", justifyContent: "center", flex: "0 0 auto" }}>
                  {r.collapseId ? (
                    <span role="button" tabIndex={0}
                      aria-label={collapsed.has(r.collapseId) ? "Expand" : "Collapse"}
                      style={{ display: "inline-flex", cursor: "pointer" }}
                      // stopPropagation so toggling collapse never enters edit (onRowClick).
                      onClick={(e) => { e.stopPropagation(); toggle(r.collapseId!); }}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); toggle(r.collapseId!); } }}
                    >
                      <Icon mode="Decorative" style={{ width: "0.75rem", height: "0.75rem" }}
                        name={collapsed.has(r.collapseId) ? "slim-arrow-right" : "slim-arrow-down"} />
                    </span>
                  ) : null}
                </span>
                {titleEdit === r.key && r.ref.kind !== "param" ? (
                  <Input
                    value={r.label}
                    onBlur={() => setTitleEdit(null)}
                    onInput={(e) => {
                      const title = e.target.value;
                      update((d) => ({
                        ...d,
                        structure: {
                          sections: d.structure.sections.map((s, si) => {
                            if (r.ref.kind === "section") return si === r.ref.s ? { ...s, title } : s;
                            return si === (r.ref as { s: number }).s
                              ? { ...s, groups: s.groups.map((g, gi) => (gi === (r.ref as { g: number }).g ? { ...g, title } : g)) }
                              : s;
                          }),
                        },
                      }));
                    }}
                  />
                ) : (
                <Text style={{ paddingInlineStart: `${r.depth * 1.5}rem`, fontWeight: r.depth === 0 ? "bold" : "normal" }}>
                  {r.label}
                </Text>
              )}
            </TableCell>
            <TableCell><Text>{r.detail}</Text></TableCell>
          </TableRow>
        ))}
      </Table>

      {loose.length ? (
        <MessageStrip design="Critical" hideCloseButton>
          Not shown on the form: {loose.join(", ")} — drag them into a group or edit them to place them.
        </MessageStrip>
      ) : null}

      <Title level="H5">Computed values</Title>
      <Table noDataText="No computed values." rowActionCount={1}
        onRowActionClick={(e) => {
          const i = Number(((e.detail.row as unknown) as HTMLElement).dataset.idx);
          update((d) => ({ ...d, computed: d.computed.filter((_, j) => j !== i) }));
        }}
        headerRow={
          <TableHeaderRow>
            <TableHeaderCell><span>Key</span></TableHeaderCell>
            <TableHeaderCell width="60%"><span>Expression</span></TableHeaderCell>
          </TableHeaderRow>
        }>
        {draft.computed.map((c, i) => (
          <TableRow key={i} rowKey={`c-${i}`} data-idx={String(i)} actions={<TableRowAction icon="delete" text="Delete" />}>
            <TableCell>
              <Input value={c.key} onInput={(e) =>
                update((d) => ({ ...d, computed: d.computed.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) }))} />
            </TableCell>
            <TableCell>
              <ExprInput value={c.expr} model={draft} fieldId={`expr-computed[${i}].expr`}
                issue={issueFor(issues, `computed[${i}].expr`)}
                onChange={(v) => update((d) => ({ ...d, computed: d.computed.map((x, j) => (j === i ? { ...x, expr: v ?? "" } : x)) }))} />
            </TableCell>
          </TableRow>
        ))}
      </Table>
      <Button icon="add" style={{ alignSelf: "start" }}
        onClick={() => update((d) => ({ ...d, computed: [...d.computed, { key: addKey("value", [...d.parameters.map((p) => p.key), ...d.computed.map((c) => c.key)]), expr: "0" }] }))}>
        Add computed value
      </Button>

      {editing ? (
        <ParamDialog
          draft={draft} tables={tables} initial={editing.param} isNew={editing.isNew}
          onCancel={() => setEditing(null)}
          onOk={(p, place) => { saveParam(p, editing.isNew, place); setEditing(null); }}
        />
      ) : null}
    </div>
  );
}

function ParamDialog({ draft, tables, initial, isNew, onOk, onCancel }: {
  draft: ModelDef; tables: Tables; initial: Param; isNew: boolean;
  onOk: (p: Param, place?: { s: number; g: number }) => void; onCancel: () => void;
}) {
  const [p, setP] = useState<Param>(initial);
  const groups = draft.structure.sections.flatMap((s, si) =>
    s.groups.map((g, gi) => ({ s: si, g: gi, label: `${s.title} / ${g.title}` })));
  const [placeIdx, setPlaceIdx] = useState(0);
  const set = (patch: Partial<Param>) => setP((x) => ({ ...x, ...patch }));
  const keyOk = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(p.key);
  const keyTaken = isNew && draft.parameters.some((x) => x.key === p.key);

  return (
    <Dialog open headerText={isNew ? "Add parameter" : `Edit ${initial.key}`} onClose={onCancel}
      style={{ width: "min(46rem, 90vw)" }}
      footer={
        <Bar design="Footer" endContent={
          <>
            <Button design="Emphasized" disabled={!keyOk || keyTaken || !p.label}
              onClick={() => onOk(p, isNew ? groups[placeIdx] : undefined)}>OK</Button>
            <Button onClick={onCancel}>Cancel</Button>
          </>
        } />
      }>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem", padding: "0.5rem 0" }}>
        <div>
          <Label required>Key</Label>
          <Input value={p.key} disabled={!isNew} valueState={keyOk && !keyTaken ? "None" : "Negative"}
            valueStateMessage={<div>{keyTaken ? "Key already exists" : "Must be a valid identifier"}</div>}
            onInput={(e) => set({ key: e.target.value })} />
        </div>
        <div>
          <Label required>Label</Label>
          <Input value={p.label} onInput={(e) => set({ label: e.target.value })} />
        </div>
        <div>
          <Label>Type</Label>
          <Select value={p.type} onChange={(e) => set({ type: (e.detail.selectedOption as HTMLElement).dataset.v as Param["type"] })}>
            {(["string", "number", "boolean"] as const).map((t) => <Option key={t} value={t} data-v={t}>{t}</Option>)}
          </Select>
        </div>
        <div>
          <Label>Control</Label>
          <Select value={p.ui} onChange={(e) => set({ ui: (e.detail.selectedOption as HTMLElement).dataset.v as Param["ui"] })}>
            {UI_KINDS.map((u) => <Option key={u} value={u} data-v={u}>{u}</Option>)}
          </Select>
        </div>
        {isNew ? (
          <div style={{ gridColumn: "1 / -1" }}>
            <Label>Place in</Label>
            <Select value={String(placeIdx)} onChange={(e) => setPlaceIdx(Number((e.detail.selectedOption as HTMLElement).dataset.v))}>
              {groups.map((g, i) => <Option key={i} value={String(i)} data-v={String(i)}>{g.label}</Option>)}
            </Select>
          </div>
        ) : null}

        <div style={{ gridColumn: "1 / -1" }}>
          <Label>Value domain</Label>
          <DomainEditor draft={draft} tables={tables} value={p.domain} onChange={(domain) => set({ domain })} />
        </div>

        <div style={{ gridColumn: "1 / -1" }}>
          <Label>Default (expression)</Label>
          <ExprInput optional value={p.defaultExpr} model={draft} onChange={(v) => set({ defaultExpr: v })} />
        </div>
        <div>
          <Label>Visible when</Label>
          <ExprInput optional value={p.visibleWhen} model={draft} onChange={(v) => set({ visibleWhen: v })} />
        </div>
        <div>
          <Label>Required when</Label>
          <ExprInput optional value={p.requiredWhen} model={draft} onChange={(v) => set({ requiredWhen: v })} />
        </div>
        <div>
          <Label>Unit</Label>
          <Input value={p.unit ?? ""} onInput={(e) => set({ unit: e.target.value || undefined })} />
        </div>
        <div>
          <Label>Help text</Label>
          <Input value={p.help ?? ""} onInput={(e) => set({ help: e.target.value || undefined })} />
        </div>
      </div>
    </Dialog>
  );
}

function DomainEditor({ draft, tables, value, onChange }: {
  draft: ModelDef; tables: Tables;
  value: Param["domain"]; onChange: (d: Param["domain"]) => void;
}) {
  const kind = value === undefined ? "none" : value.kind === "range" ? "range" : value.ref.source;
  const tableNames = [...tables.map((t) => t.name), ...draft.queryTables.map((q) => q.name)];
  const columnsOf = (name: string) =>
    tables.find((t) => t.name === name)?.columns.map((c) => c.key) ??
    draft.queryTables.find((q) => q.name === name)?.columns ?? [];

  const setKind = (k: string) => {
    if (k === "none") onChange(undefined);
    else if (k === "range") onChange({ kind: "range", min: 0, max: 100, step: 1 });
    else if (k === "manual") onChange({ kind: "options", ref: { source: "manual", options: [] } });
    else if (k === "table") onChange({ kind: "options", ref: { source: "table", table: tableNames[0] ?? "", valueCol: "" } });
    else onChange({ kind: "options", ref: { source: "query", target: "b1", path: "", valueField: "" } });
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

      {value?.kind === "options" && value.ref.source === "table" ? (
        <TableRefEditor ref_={value.ref} tableNames={tableNames} columnsOf={columnsOf}
          onChange={(ref) => onChange({ kind: "options", ref })} />
      ) : null}

      {value?.kind === "options" && value.ref.source === "query" ? (
        <QueryRefEditor ref_={value.ref} onChange={(ref) => onChange({ kind: "options", ref })} />
      ) : null}

      {value?.kind === "options" ? <PreviewButton ref_={value.ref} /> : null}
    </div>
  );
}

// Narrowed sub-editors: keeping the discriminated ref as a component prop preserves its type
// inside the onChange closures (nested-closure narrowing loss otherwise widens value.ref).
function TableRefEditor({ ref_, tableNames, columnsOf, onChange }: {
  ref_: Extract<LookupRef, { source: "table" }>;
  tableNames: string[];
  columnsOf: (name: string) => string[];
  onChange: (r: LookupRef) => void;
}) {
  return (
    <div style={{ display: "flex", gap: "0.5rem" }}>
      <Select value={ref_.table} onChange={(e) => onChange({ ...ref_, table: (e.detail.selectedOption as HTMLElement).dataset.v!, valueCol: "" })}>
        {tableNames.map((n) => <Option key={n} value={n} data-v={n}>{n}</Option>)}
      </Select>
      <Select value={ref_.valueCol} onChange={(e) => onChange({ ...ref_, valueCol: (e.detail.selectedOption as HTMLElement).dataset.v! })}>
        <Option value="" data-v="">value column…</Option>
        {columnsOf(ref_.table).map((c) => <Option key={c} value={c} data-v={c}>{c}</Option>)}
      </Select>
      <Select value={ref_.labelCol ?? ""} onChange={(e) => {
        const v = (e.detail.selectedOption as HTMLElement).dataset.v!;
        onChange({ ...ref_, labelCol: v || undefined });
      }}>
        <Option value="" data-v="">label column (optional)…</Option>
        {columnsOf(ref_.table).map((c) => <Option key={c} value={c} data-v={c}>{c}</Option>)}
      </Select>
    </div>
  );
}

function QueryRefEditor({ ref_, onChange }: {
  ref_: Extract<LookupRef, { source: "query" }>;
  onChange: (r: LookupRef) => void;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "8rem 1fr", gap: "0.5rem" }}>
      <Select value={ref_.target} onChange={(e) => onChange({ ...ref_, target: (e.detail.selectedOption as HTMLElement).dataset.v as "b1" | "beas" })}>
        <Option value="b1" data-v="b1">B1</Option>
        <Option value="beas" data-v="beas">Beas</Option>
      </Select>
      <Input placeholder="/Items?$select=ItemCode,ItemName" value={ref_.path}
        onInput={(e) => onChange({ ...ref_, path: e.target.value })} />
      <Input placeholder="value field, e.g. ItemCode" value={ref_.valueField}
        onInput={(e) => onChange({ ...ref_, valueField: e.target.value })} />
      <Input placeholder="label field (optional)" value={ref_.labelField ?? ""}
        onInput={(e) => onChange({ ...ref_, labelField: e.target.value || undefined })} />
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
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      {ref_.options.map((o, i) => (
        <div key={i} style={{ display: "flex", gap: "0.5rem" }}>
          <Input placeholder="value" value={String(o.value ?? "")} onInput={(e) => setOpt(i, { value: e.target.value })} />
          <Input placeholder="label (optional)" value={o.label ?? ""} onInput={(e) => setOpt(i, { label: e.target.value })} />
          <Button icon="delete" design="Transparent"
            onClick={() => onChange({ ...ref_, options: ref_.options.filter((_, j) => j !== i) })} />
        </div>
      ))}
      <Button icon="add" style={{ alignSelf: "start" }}
        onClick={() => onChange({ ...ref_, options: [...ref_.options, { value: "" }] })}>Add option</Button>
    </div>
  );
}

function PreviewButton({ ref_ }: { ref_: LookupRef }) {
  const [state, setState] = useState<{ busy?: boolean; options?: EngineOption[]; error?: string }>({});
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <Button icon="show" style={{ alignSelf: "start" }} disabled={state.busy}
        onClick={async () => {
          setState({ busy: true });
          try {
            const r = await client.models.lookupPreview({ ref: ref_, limit: 20 });
            setState({ options: r.options });
          } catch (e) {
            setState({ error: e instanceof Error ? e.message : String(e) });
          }
        }}>
        {state.busy ? "Loading…" : "Preview options"}
      </Button>
      {state.error ? <MessageStrip design="Negative" hideCloseButton>{state.error}</MessageStrip> : null}
      {state.options ? (
        state.options.length ? (
          <List>{state.options.map((o, i) => <ListItemStandard key={i} additionalText={String(o.value)}>{o.label}</ListItemStandard>)}</List>
        ) : <Text>No options returned.</Text>
      ) : null}
    </div>
  );
}
