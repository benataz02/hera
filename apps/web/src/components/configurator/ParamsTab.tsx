import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  Bar, Button, BusyIndicator, DynamicSideContent, IllustratedMessage, Input,
  Menu, MenuItem, MessageStrip, Table, TableCell, TableHeaderCell,
  TableHeaderRow, TableRow, TableRowAction, Text, Title,
  type TableHeaderRowDomRef,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/AddColumn.js";
import { propagate, type Entries, type ResolvedLookups } from "@hera/config-engine";
import type { Issue, ModelDef, Param } from "@hera/config-engine";
import { confirm } from "../confirm.ts";
import { ExprInput } from "./ExprInput.tsx";
import { ParamDialog } from "./ParamDialog.tsx";
import type { TableCols } from "./exprHelpers.ts";
import { ConfiguratorForm, ConsistencyStatus } from "./ConfiguratorForm.tsx";
import { mergeQueryPicks, setQueryPick, type QueryPicks } from "./formHelpers.ts";
import { issueFor } from "./useDraftModel.ts";
import { applyMove, canDrop, duplicateParam, parseRowKey, placeParam, removeFromStructure, rowKeyOf, unplacedParams, type Placement, type RowRef } from "./structureOps.ts";

type Tables = TableCols[];
type Update = (fn: (d: ModelDef) => ModelDef) => void;

const emptyParam = (): Param => ({ key: "", label: "", type: "string", ui: "select" });

// Dashed hairline above the first formula row — the "soft visual link" tying the global
// formulas (rendered at param level) to the structure above them.
const SEP = { borderBlockStart: "1px dashed var(--sapList_BorderColor)", paddingBlockStart: "0.25rem" } as const;
// UI5 cozy icon-button min width — reserved so leaf labels indent past group labels.
const TOGGLE = "2.25rem";

function Gutter({ depth, children, collapse, style }: {
  depth: number;
  children: ReactNode;
  collapse?: { collapsed: boolean; onToggle: () => void };
  style?: CSSProperties;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.25rem", paddingInlineStart: `${depth * 1.5}rem`, ...style }}>
      {collapse ? (
        // Chevron is a real button, indented with the level; stopPropagation so a toggle never enters edit (onRowClick).
        <Button design="Transparent" style={{ flex: "0 0 auto" }}
          icon={collapse.collapsed ? "slim-arrow-right" : "slim-arrow-down"}
          tooltip={collapse.collapsed ? "Expand" : "Collapse"}
          accessibilityAttributes={{ expanded: collapse.collapsed ? "false" : "true" }}
          onClick={(e) => { e.stopPropagation(); collapse.onToggle(); }} />
      ) : (
        <span style={{ flex: `0 0 ${TOGGLE}`, inlineSize: TOGGLE }} aria-hidden />
      )}
      {children}
    </div>
  );
}

// Param-row actions only: section/group/formula stay visible. Touch keeps param actions
// visible — no hover, and opacity:0 would make delete/dup untappable.
if (typeof document !== "undefined" && !document.getElementById("hera-params-row-actions")) {
  const el = document.createElement("style");
  el.id = "hera-params-row-actions";
  el.textContent = `@media (hover: hover){.hera-params-struct [ui5-table-row][row-key^="p:"] [ui5-table-row-action]{opacity:0;pointer-events:none}.hera-params-struct [ui5-table-row][row-key^="p:"]:hover [ui5-table-row-action],.hera-params-struct [ui5-table-row][row-key^="p:"]:focus-within [ui5-table-row-action]{opacity:1;pointer-events:auto}}`;
  document.head.appendChild(el);
}

// UI5 clips the actions-column header (a11y-only "Row Actions") inside the header-row shadow.
function revealActionsHeader(el: TableHeaderRowDomRef | null) {
  const sr = el?.shadowRoot;
  if (!sr || sr.getElementById("hera-actions-hdr")) return;
  const style = document.createElement("style");
  style.id = "hera-actions-hdr";
  style.textContent = `#actions-cell-content{position:static;clip:auto;font-size:0}#actions-cell-content::after{content:"Actions";font-size:var(--sapFontSize);font-family:var(--sapFontSemiboldDuplexFamily);color:var(--sapList_HeaderTextColor)}`;
  sr.appendChild(style);
}

export function ParamsTab({ modelId, draft, update, issues, tables, lookups, lookupsError, onRetryLookups }: {
  modelId: string; draft: ModelDef; update: Update; issues: Issue[]; tables: Tables;
  lookups?: ResolvedLookups; lookupsError?: Error | null; onRetryLookups: () => void;
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
          detail: p ? `${p.type} · ${p.ui}${p.domain ? (p.domain.kind === "range" ? " · range" : ` · ${p.domain.ref.source}`) : ""}${p.excludeFromDomains ? " · excluded" : ""}` : "missing definition",
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
  const lastGroup = () => {
    for (let s = draft.structure.sections.length - 1; s >= 0; s--) {
      const g = draft.structure.sections[s]!.groups.length - 1;
      if (g >= 0) return { s, g };
    }
  };
  // "add" row action: section → group, group → parameter (dialog targeted to the group).
  const addUnder = (ref: RowRef) => {
    if (ref.kind === "section") addGroup(ref.s);
    else if (ref.kind === "group") setEditing({ param: emptyParam(), isNew: true, place: { s: ref.s, g: ref.g } });
  };

  const rowActions = (text: string, act: "add" | "dup" = "add") => (
    <>
      <TableRowAction icon={act === "dup" ? "copy" : "add"} text={text} data-act={act} />
      <TableRowAction icon="delete" text="Delete" data-act="delete" />
    </>
  );

  return (
    <DynamicSideContent equalSplit sideContentVisibility="AlwaysShow" style={{ height: "100%", minHeight: "28rem" }}
      sideContent={
        <PreviewPane modelId={modelId} draft={draft} issues={issues} lookups={lookups}
          lookupsError={lookupsError} onRetryLookups={onRetryLookups} />
      }>
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
            <Button icon="add" onClick={() => setEditing({ param: emptyParam(), isNew: true, place: lastGroup() })}>Add parameter</Button>
            <Button icon="add" onClick={addFormula}>Add formula</Button>
          </>
        }
      />

      <Table
        className="hera-params-struct"
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
          else if (act === "dup" && ref.kind === "param") update((d) => duplicateParam(d, ref.key));
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
          <TableHeaderRow ref={revealActionsHeader}>
            <TableHeaderCell width="45%"><span>Structure</span></TableHeaderCell>
            <TableHeaderCell><span>Details</span></TableHeaderCell>
          </TableHeaderRow>
        }
      >
        {rows.map((r) =>
          r.kind === "formula" ? (
            <TableRow key={r.key} rowKey={r.key} actions={rowActions("Add formula")}>
              <TableCell>
                <Gutter depth={2} style={r.idx === 0 ? SEP : undefined}>
                  <span style={{ color: "var(--sapContent_LabelColor)", fontStyle: "italic", flex: "0 0 auto" }}>ƒ</span>
                  <Input style={{ width: "100%" }} value={draft.computed[r.idx]!.key}
                    onInput={(e) => update((d) => ({ ...d, computed: d.computed.map((x, j) => (j === r.idx ? { ...x, key: e.target.value } : x)) }))} />
                </Gutter>
              </TableCell>
              <TableCell>
                <div style={r.idx === 0 ? SEP : undefined}>
                  <ExprInput value={draft.computed[r.idx]!.expr} model={draft} tables={tables} fieldId={`expr-computed[${r.idx}].expr`}
                    issue={issueFor(issues, `computed[${r.idx}].expr`)}
                    onChange={(v) => update((d) => ({ ...d, computed: d.computed.map((x, j) => (j === r.idx ? { ...x, expr: v ?? "" } : x)) }))} />
                </div>
              </TableCell>
            </TableRow>
          ) : (
            <TableRow key={r.key} rowKey={r.key} movable interactive
              actions={r.ref.kind === "param" ? rowActions("Duplicate parameter", "dup")
                : rowActions(r.ref.kind === "section" ? "Add group" : "Add parameter")}>
              <TableCell>
                <Gutter depth={r.depth} collapse={r.collapseId
                  ? { collapsed: collapsed.has(r.collapseId), onToggle: () => toggle(r.collapseId!) }
                  : undefined}>
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
                </Gutter>
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
    </DynamicSideContent>
  );
}

function PreviewPane({ slot, modelId, draft, issues, lookups, lookupsError, onRetryLookups }: {
  slot?: string; modelId: string; draft: ModelDef; issues: Issue[];
  lookups?: ResolvedLookups; lookupsError?: Error | null; onRetryLookups: () => void;
}) {
  const [entries, setEntries] = useState<Entries>({});
  const [picks, setPicks] = useState<QueryPicks>({});
  const lastGood = useRef(draft);
  if (issues.length === 0) lastGood.current = draft;
  const previewModel = issues.length === 0 ? draft : lastGood.current;
  const lk = lookups ? mergeQueryPicks(lookups, picks) : undefined;
  const prop = lk ? propagate(previewModel, lk, entries) : null;

  return (
    <div slot={slot} style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      {issues.length > 0 ? (
        <MessageStrip design="Critical" hideCloseButton>
          Showing the last valid version — fix {issues.length} error{issues.length === 1 ? "" : "s"} to preview the current draft.
        </MessageStrip>
      ) : null}
      {lookupsError ? (
        <div style={{ padding: "0 1rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <MessageStrip design="Negative" hideCloseButton style={{ flex: 1 }}>{lookupsError.message}</MessageStrip>
          <Button onClick={onRetryLookups}>Retry</Button>
        </div>
      ) : null}
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "0 1rem 1rem" }}>
        {lookups && lk && prop ? (
          <ConfiguratorForm model={previewModel} lookups={lookups} lk={lk} prop={prop} entries={entries} onChange={setEntries}
            onQueryPick={(k, t, sel) => setPicks((p) => setQueryPick(p, k, t, sel))}
            querySource={{ kind: "project", modelId }} />
        ) : lookupsError ? null : <BusyIndicator active delay={0} />}
      </div>
      <Bar design="Footer" startContent={prop ? <ConsistencyStatus prop={prop} /> : undefined} />
    </div>
  );
}
