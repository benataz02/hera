import { useState } from "react";
import {
  Bar, Button, Dialog, IllustratedMessage, Input, Label, List, ListItemStandard, Menu, MenuItem, MessageStrip,
  MultiComboBox, MultiComboBoxItem, Option, Select, StepInput, Table, TableCell, TableHeaderCell,
  TableHeaderRow, TableRow, TableRowAction, Text, Title,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/AddColumn.js";
import { refKeyCols } from "@hera/config-engine";
import type { Issue, LookupRef, ModelDef, Option as EngineOption, Param } from "@hera/config-engine";
import { client } from "../../orpc.ts";
import { confirm } from "../confirm.ts";
import { ExprInput } from "./ExprInput.tsx";
import { issueFor } from "./useDraftModel.ts";
import { applyMove, canDrop, parseRowKey, placeParam, removeFromStructure, rowKeyOf, unplacedParams, type Placement, type RowRef } from "./structureOps.ts";

type Tables = { name: string; columns: { key: string }[] }[];
type Update = (fn: (d: ModelDef) => ModelDef) => void;

const UI_KINDS = ["input", "select", "radio", "checkbox", "multicombo", "step"] as const;

const emptyParam = (): Param => ({ key: "", label: "", type: "string", ui: "select" });

// Dashed hairline above the first formula row — the "soft visual link" tying the global
// formulas (rendered at param level) to the structure above them.
const SEP = { borderBlockStart: "1px dashed var(--sapList_BorderColor)", paddingBlockStart: "0.25rem" } as const;

export function ParamsTab({ draft, update, issues, tables }: {
  draft: ModelDef; update: Update; issues: Issue[]; tables: Tables;
}) {
  const [editing, setEditing] = useState<{ param: Param; isNew: boolean; place?: { s: number; g: number } } | null>(null);
  // Inline title edit: keep the original so Escape can revert (edits apply live per keystroke).
  const [titleEdit, setTitleEdit] = useState<{ key: string; original: string } | null>(null);
  // Loose-param placement menu: which unplaced key is being placed, and the button that opened it.
  const [placing, setPlacing] = useState<{ key: string; opener: string } | null>(null);
  // Keyed by stable section/group key (not row index) so collapse survives drag-reordering.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setCollapsed((c) => { const n = new Set(c); n.delete(id) || n.add(id); return n; });

  type StructRow = { kind: "struct"; key: string; depth: number; label: string; detail: string; ref: RowRef; collapseId?: string };
  type Row = StructRow | { kind: "formula"; key: string; idx: number };
  const rows: Row[] = [];
  draft.structure.sections.forEach((s, si) => {
    const sId = `S:${s.key}`;
    rows.push({ kind: "struct", key: `s:${si}`, depth: 0, label: s.title, detail: `section · ${s.key}`, ref: { kind: "section", s: si }, collapseId: sId });
    if (collapsed.has(sId)) return;
    s.groups.forEach((g, gi) => {
      const gId = `G:${s.key}/${g.key}`;
      rows.push({ kind: "struct", key: `g:${si}.${gi}`, depth: 1, label: g.title, detail: `group · ${g.key}`, ref: { kind: "group", s: si, g: gi }, collapseId: gId });
      if (collapsed.has(gId)) return;
      g.params.forEach((pk) => {
        const p = draft.parameters.find((x) => x.key === pk);
        rows.push({
          kind: "struct", key: `p:${pk}`, depth: 2, label: p?.label || pk,
          detail: p ? `${p.type} · ${p.ui}${p.domain ? (p.domain.kind === "range" ? " · range" : ` · ${p.domain.ref.source}`) : ""}` : "missing definition",
          ref: { kind: "param", key: pk },
        });
      });
    });
  });
  // Formulas are global (ModelDef.computed) — appended at param level, soft-linked, not a section.
  draft.computed.forEach((_, i) => rows.push({ kind: "formula", key: `c:${i}`, idx: i }));

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

  const deleteRow = (ref: RowRef) =>
    update((d) => {
      let out = removeFromStructure(d, ref);
      if (ref.kind === "param") out = { ...out, parameters: out.parameters.filter((p) => p.key !== ref.key) };
      return out;
    });

  // Confirm only when a delete is destructive: a section/group with children (cascades), or a
  // parameter (drops its whole definition). Empty sections/groups delete without a prompt.
  const confirmDelete = async (ref: RowRef) => {
    let message: string | null = null;
    if (ref.kind === "section") {
      const sec = draft.structure.sections[ref.s];
      const groups = sec?.groups.length ?? 0;
      const params = sec?.groups.reduce((n, g) => n + g.params.length, 0) ?? 0;
      if (groups > 0) message = `Delete section "${sec?.title}" with its ${groups} group${groups === 1 ? "" : "s"}${params ? ` and ${params} placed parameter${params === 1 ? "" : "s"}` : ""}?`;
    } else if (ref.kind === "group") {
      const grp = draft.structure.sections[ref.s]?.groups[ref.g];
      const params = grp?.params.length ?? 0;
      if (params > 0) message = `Delete group "${grp?.title}" and unplace its ${params} parameter${params === 1 ? "" : "s"}?`;
    } else {
      const p = draft.parameters.find((x) => x.key === ref.key);
      message = `Delete parameter "${p?.label || ref.key}"? This removes its definition from the model.`;
    }
    if (message === null || await confirm({ title: "Delete", message, actionText: "Delete", destructive: true }))
      deleteRow(ref);
  };

  const setTitle = (ref: RowRef, title: string) =>
    update((d) => ({
      ...d,
      structure: {
        sections: d.structure.sections.map((s, si) => {
          if (ref.kind === "section") return si === ref.s ? { ...s, title } : s;
          if (ref.kind === "group") return si === ref.s ? { ...s, groups: s.groups.map((g, gi) => (gi === ref.g ? { ...g, title } : g)) } : s;
          return s;
        }),
      },
    }));

  const addKey = (base: string, taken: string[]) => {
    let k = base, n = 2;
    while (taken.includes(k)) k = `${base}${n++}`;
    return k;
  };
  const addSection = () => update((d) => ({
    ...d,
    structure: { sections: [...d.structure.sections, { key: addKey("section", d.structure.sections.map((s) => s.key)), title: "New section", groups: [] }] },
  }));
  const addGroup = (s: number) => update((d) => ({
    ...d,
    structure: {
      sections: d.structure.sections.map((sec, i) => i !== s ? sec : {
        ...sec, groups: [...sec.groups, { key: addKey("group", sec.groups.map((g) => g.key)), title: "New group", params: [] }],
      }),
    },
  }));
  const addFormula = () => update((d) => ({
    ...d,
    computed: [...d.computed, { key: addKey("value", [...d.parameters.map((p) => p.key), ...d.computed.map((c) => c.key)]), expr: "0" }],
  }));
  // The group a param sits in, so its "add" action drops a sibling into the same group.
  const groupOfParam = (key: string) => {
    for (let s = 0; s < draft.structure.sections.length; s++)
      for (let g = 0; g < draft.structure.sections[s]!.groups.length; g++)
        if (draft.structure.sections[s]!.groups[g]!.params.includes(key)) return { s, g };
    return undefined;
  };
  // "add" row action: section → group, group/param → parameter (dialog targeted to the group).
  const addUnder = (ref: RowRef) => {
    if (ref.kind === "section") addGroup(ref.s);
    else if (ref.kind === "group") setEditing({ param: emptyParam(), isNew: true, place: { s: ref.s, g: ref.g } });
    else setEditing({ param: emptyParam(), isNew: true, place: groupOfParam(ref.key) });
  };

  const rowActions = (add: string) => (
    <>
      <TableRowAction icon="add" text={add} data-act="add" />
      <TableRowAction icon="delete" text="Delete" data-act="delete" />
    </>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", padding: "1rem" }}>
      {modelIssues.length ? (
        <MessageStrip design="Negative" hideCloseButton>
          {modelIssues.map((i) => i.message).join(" · ")}
        </MessageStrip>
      ) : null}
      <div style={{ display: "flex", flexDirection: "column" }}>
      <Bar design="Subheader" style={{ borderBlockEnd: "none" }}
        startContent={<Title level="H5">Form structure</Title>}
        endContent={
          <>
            <Button icon="add" onClick={addSection}>Add section</Button>
            <Button icon="add" onClick={addFormula}>Add formula</Button>
          </>
        }
      />

      <Table
        noData={
          <IllustratedMessage name="AddColumn" design="Dot" titleText="No structure yet"
            subtitleText="Add a section to start structuring the form, then add groups and parameters." />
        }
        rowActionCount={2}
        onMoveOver={(e) => {
          const src = (e.detail.source.element as HTMLElement | null)?.getAttribute("row-key");
          const dst = (e.detail.destination.element as HTMLElement | null)?.getAttribute("row-key");
          const placement = e.detail.destination.placement as Placement;
          // ponytail: formula rows (c:) share this table but aren't structure nodes — never a drag src/dst.
          if (src?.startsWith("c:") || dst?.startsWith("c:")) return;
          if (src && dst && canDrop(draft, src, dst, placement)) e.preventDefault();
        }}
        onMove={(e) => {
          const src = (e.detail.source.element as HTMLElement | null)?.getAttribute("row-key");
          const dst = (e.detail.destination.element as HTMLElement | null)?.getAttribute("row-key");
          const placement = e.detail.destination.placement as Placement;
          if (src?.startsWith("c:") || dst?.startsWith("c:")) return;
          if (src && dst) update((d) => applyMove(d, src, dst, placement));
        }}
        onRowActionClick={(e) => {
          const rowKey = ((e.detail.row as unknown) as HTMLElement).getAttribute("row-key")!;
          const act = ((e.detail.action as unknown) as HTMLElement).dataset.act;
          if (rowKey.startsWith("c:")) {
            const i = Number(rowKey.slice(2));
            if (act === "delete") update((d) => ({ ...d, computed: d.computed.filter((_, j) => j !== i) }));
            else addFormula();
            return;
          }
          const ref = parseRowKey(rowKey);
          if (act === "delete") void confirmDelete(ref);
          else addUnder(ref);
        }}
        onRowClick={(e) => {
          const ref = parseRowKey(((e.detail.row as unknown) as HTMLElement).getAttribute("row-key")!);
          if (ref.kind === "param") {
            const p = draft.parameters.find((x) => x.key === ref.key);
            if (p) setEditing({ param: structuredClone(p), isNew: false });
          } else {
            const title = ref.kind === "section"
              ? draft.structure.sections[ref.s]?.title ?? ""
              : draft.structure.sections[ref.s]?.groups[ref.g]?.title ?? "";
            setTitleEdit({ key: rowKeyOf(ref), original: title });
          }
        }}
        headerRow={
          <TableHeaderRow>
            <TableHeaderCell width="45%"><span>Structure</span></TableHeaderCell>
            <TableHeaderCell><span>Details</span></TableHeaderCell>
          </TableHeaderRow>
        }
      >
        {rows.map((r) =>
          r.kind === "formula" ? (
            <TableRow key={r.key} rowKey={r.key} actions={rowActions("Add formula")}>
              <TableCell>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", paddingInlineStart: "3rem", ...(r.idx === 0 ? SEP : {}) }}>
                  <span style={{ color: "var(--sapContent_LabelColor)", fontStyle: "italic", flex: "0 0 auto" }}>ƒ</span>
                  <Input style={{ width: "100%" }} value={draft.computed[r.idx]!.key}
                    onInput={(e) => update((d) => ({ ...d, computed: d.computed.map((x, j) => (j === r.idx ? { ...x, key: e.target.value } : x)) }))} />
                </div>
              </TableCell>
              <TableCell>
                <div style={r.idx === 0 ? SEP : undefined}>
                  <ExprInput value={draft.computed[r.idx]!.expr} model={draft} fieldId={`expr-computed[${r.idx}].expr`}
                    issue={issueFor(issues, `computed[${r.idx}].expr`)}
                    onChange={(v) => update((d) => ({ ...d, computed: d.computed.map((x, j) => (j === r.idx ? { ...x, expr: v ?? "" } : x)) }))} />
                </div>
              </TableCell>
            </TableRow>
          ) : (
            <TableRow key={r.key} rowKey={r.key} movable interactive
              actions={rowActions(r.ref.kind === "section" ? "Add group" : "Add parameter")}>
              <TableCell>
                <div style={{ display: "flex", alignItems: "center", gap: "0.25rem", paddingInlineStart: `${r.depth * 1.5}rem` }}>
                  {r.collapseId ? (
                    // Chevron is a real button, indented with the level; stopPropagation so a toggle never enters edit (onRowClick).
                    <Button design="Transparent" style={{ flex: "0 0 auto" }}
                      icon={collapsed.has(r.collapseId) ? "slim-arrow-right" : "slim-arrow-down"}
                      tooltip={collapsed.has(r.collapseId) ? "Expand" : "Collapse"}
                      onClick={(e) => { e.stopPropagation(); toggle(r.collapseId!); }} />
                  ) : null}
                  {titleEdit?.key === r.key && r.ref.kind !== "param" ? (
                    <Input
                      value={r.label}
                      onBlur={() => setTitleEdit(null)}
                      // Enter commits (edits already applied live); Escape reverts to the original title.
                      onKeyDown={(e) => {
                        if (e.key === "Enter") setTitleEdit(null);
                        else if (e.key === "Escape") { setTitle(r.ref, titleEdit.original); setTitleEdit(null); }
                      }}
                      onInput={(e) => setTitle(r.ref, e.target.value)}
                    />
                  ) : (
                    <Text style={{ fontWeight: r.depth === 0 ? "bold" : "normal" }}>{r.label}</Text>
                  )}
                </div>
              </TableCell>
              <TableCell><Text>{r.detail}</Text></TableCell>
            </TableRow>
          ),
        )}
      </Table>
      </div>

      {loose.length ? (
        <MessageStrip design="Critical" hideCloseButton>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.375rem" }}>
            <span>Not shown on the form — place each into a group (or drag it in above):</span>
            {loose.map((k) => (
              <Button key={k} id={`place-${k}`} icon="add" design="Transparent"
                onClick={() => setPlacing({ key: k, opener: `place-${k}` })}>
                {draft.parameters.find((p) => p.key === k)?.label || k}
              </Button>
            ))}
          </div>
        </MessageStrip>
      ) : null}

      {placing ? (
        <Menu open opener={placing.opener} onClose={() => setPlacing(null)}
          onItemClick={(e) => {
            const el = e.detail.item as HTMLElement;
            const s = Number(el.dataset.s);
            const g = Number(el.dataset.g);
            if (!Number.isNaN(s) && !Number.isNaN(g)) {
              const key = placing.key;
              update((d) => placeParam(d, key, s, g));
            }
            setPlacing(null);
          }}>
          {draft.structure.sections.length === 0 ? (
            <MenuItem text="Add a section first" disabled />
          ) : (
            draft.structure.sections.map((sec, si) => (
              <MenuItem key={si} text={sec.title || "(untitled section)"}>
                {sec.groups.length ? (
                  sec.groups.map((g, gi) => (
                    <MenuItem key={gi} text={g.title || "(untitled group)"} data-s={si} data-g={gi} />
                  ))
                ) : (
                  <MenuItem text="No groups — add one first" disabled />
                )}
              </MenuItem>
            ))
          )}
        </Menu>
      ) : null}

      {editing ? (
        <ParamDialog
          draft={draft} tables={tables} initial={editing.param} isNew={editing.isNew}
          onCancel={() => setEditing(null)}
          onOk={(p) => { saveParam(p, editing.isNew, editing.place); setEditing(null); }}
        />
      ) : null}
    </div>
  );
}

function ParamDialog({ draft, tables, initial, isNew, onOk, onCancel }: {
  draft: ModelDef; tables: Tables; initial: Param; isNew: boolean;
  onOk: (p: Param) => void; onCancel: () => void;
}) {
  const [p, setP] = useState<Param>(initial);
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
              onClick={() => onOk(p)}>OK</Button>
            <Button onClick={onCancel}>Cancel</Button>
          </>
        } />
      }>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem", padding: "0.5rem 0" }}>
        <Title level="H6" style={{ gridColumn: "1 / -1" }}>Basics</Title>
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
        <div>
          <Label>Unit</Label>
          <Input value={p.unit ?? ""} onInput={(e) => set({ unit: e.target.value || undefined })} />
        </div>

        <Title level="H6" style={{ gridColumn: "1 / -1" }}>Value domain</Title>
        <div style={{ gridColumn: "1 / -1" }}>
          <DomainEditor draft={draft} tables={tables} value={p.domain} onChange={(domain) => set({ domain })} />
        </div>

        <Title level="H6" style={{ gridColumn: "1 / -1" }}>Behavior</Title>
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

        <Title level="H6" style={{ gridColumn: "1 / -1" }}>Help</Title>
        <div>
          <Label>Help text</Label>
          <Input value={p.help ?? ""} onInput={(e) => set({ help: e.target.value || undefined })} />
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <Label>Extraction hint</Label>
          <Input value={p.extractionHint ?? ""}
            placeholder='Where/how this appears on drawings, e.g. "title block MATERIAL field"'
            onInput={(e) => set({ extractionHint: e.target.value || undefined })} />
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
    else onChange({ kind: "options", ref: { source: "query", table: queryNames[0] ?? "" } });
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
  const setTable = (name: string) =>
    onChange(ref_.source === "query" ? { source: "query", table: name } : { source: "table", table: name, valueCol: "" });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <Select value={ref_.table} onChange={(e) => setTable((e.detail.selectedOption as HTMLElement).dataset.v!)}>
          {names.length === 0 ? <Option value="" data-v="">— none defined —</Option> : null}
          {names.map((n) => <Option key={n} value={n} data-v={n}>{n}</Option>)}
        </Select>
        {ref_.source === "table" ? (
          <>
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
          </>
        ) : (
          <Text style={{ alignSelf: "center" }}>Key = 1st query column{cols[1] ? `, label = 2nd (${cols[0]} / ${cols[1]})` : ""}.</Text>
        )}
      </div>
      <div>
        <Label>Displayed / derived columns</Label>
        <MultiComboBox
          onSelectionChange={(e) => {
            const sel = e.detail.items.map((i) => (i as HTMLElement).getAttribute("text")!);
            onChange({ ...ref_, columns: sel.length === extra.length ? undefined : sel });
          }}>
          {extra.map((c) => (
            <MultiComboBoxItem key={c} text={c} selected={displayed.includes(c)} />
          ))}
        </MultiComboBox>
      </div>
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
    <>
      {ref_.options.map((o, i) => (
        <div key={i} style={{ display: "flex", gap: "0.5rem" }}>
          <Input placeholder="value" value={String(o.value ?? "")} onInput={(e) => setOpt(i, { value: e.target.value })} />
          <Input placeholder="label (optional)" value={o.label ?? ""} onInput={(e) => setOpt(i, { label: e.target.value })} />
          <Button icon="delete" design="Transparent" tooltip="Remove option" accessibleName="Remove option"
            onClick={() => onChange({ ...ref_, options: ref_.options.filter((_, j) => j !== i) })} />
        </div>
      ))}
      <Button icon="add" style={{ alignSelf: "start" }}
        onClick={() => onChange({ ...ref_, options: [...ref_.options, { value: "" }] })}>Add option</Button>
    </>
  );
}

function PreviewButton({ ref_, queryTables }: { ref_: LookupRef; queryTables: ModelDef["queryTables"] }) {
  const [state, setState] = useState<{ busy?: boolean; options?: EngineOption[]; error?: string }>({});
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <Button icon="show" style={{ alignSelf: "start" }} disabled={state.busy}
        onClick={async () => {
          setState({ busy: true });
          try {
            const r = await client.models.lookupPreview({ ref: ref_, queryTables, limit: 20 });
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
