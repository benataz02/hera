import { useEffect, useState } from "react";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar, BusyIndicator, Button, CheckBox, Form, FormGroup, FormItem, Icon, IllustratedMessage, Input,
  Label, MessageStrip, ObjectPage, ObjectPageSection, ObjectPageTitle, ObjectStatus, Option, Select,
  Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableRowAction, Text, TextArea,
  Title, Toolbar, ToolbarButton,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import type { ODataQuery, QuerySource, Val } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";
import { colMinWidth } from "../configurator/tableWidths.ts";
import { confirm } from "../confirm.ts";
import { toast } from "../toast.ts";

// One editor for both kinds. The kind is picked once, on create: a saved row keeps it, because
// switching would throw away either the maintained rows or the query behind it.

type Col = { key: string; label: string; type: "string" | "number" | "boolean" };
type Cell = Exclude<Val, string[]>;
type QueryDef = QuerySource & { labels?: Record<string, string>; hidden?: string[] };
type Draft = { name: string; kind: "table" | "query"; columns: Col[]; rows: Cell[][]; query: QueryDef };

const emptyDraft = (): Draft => ({
  name: "",
  kind: "table",
  columns: [{ key: "", label: "", type: "string" }],
  rows: [],
  query: { target: "b1", query: { entitySet: "" }, columns: [] },
});

// Details is one group of short pairs, so its two columns hold Name | Kind. The query form's two
// columns are its two groups — Clauses | Preview — each stacking its own content.
const PAIRS = { labelSpan: "S12 M3 L3 XL3", layout: "S1 M2 L2 XL2", accessibleMode: "Edit" } as const;
const FIELDS = { labelSpan: "S12 M3 L3 XL3", layout: "S1 M1 L2 XL2", accessibleMode: "Edit" } as const;
// A table is one full-width group at every breakpoint — nothing to put beside it.
const FULL = { layout: "S1 M1 L1 XL1", accessibleMode: "Edit" } as const;

// A preview is a shape check, not a data browse — five rows read as $top=5, server-side.
const PREVIEW_TOP = 5;

// Mirrors the Form's own `.ui5-form-group-heading` (height token + 0.25rem indent) so a group
// heading we draw ourselves sits on the same line as one the Form draws.
const HEADING = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.5rem",
  height: "var(--_ui5-form-group-heading-height, 2.75rem)",
  paddingInlineStart: "0.25rem",
} as const;

const CELL = { display: "flex", alignItems: "center", gap: "0.5rem" } as const;

// Toolbar draws a border-bottom on its host and has no prop to turn it off; sitting on a table it
// doubles up with the header row's own line. Inline beats the `:host` rule.
const NO_RULE = { borderBottom: "none" } as const;

/** Keeps the text of a row that has no icon aligned with the text of the rows that do. */
const iconSlot = <span style={{ width: "1rem", flex: "none" }} />;

/** `col-3` / `row-12` -> 3 / 12. The row key is the index; there is nothing else to key on. */
const rowIndex = (row: unknown) => Number((row as { rowKey: string }).rowKey.split("-")[1]);

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

// Drop labels/hidden for keys the Select clause no longer names; omit empty bags so the row
// stays sparse.
function pruneColUi(q: QueryDef): QueryDef {
  const keys = new Set(q.columns);
  const labels = Object.fromEntries(Object.entries(q.labels ?? {}).filter(([k, v]) => keys.has(k) && v.trim() !== ""));
  const hidden = (q.hidden ?? []).filter((k) => keys.has(k));
  return {
    ...q,
    labels: Object.keys(labels).length ? labels : undefined,
    hidden: hidden.length ? hidden : undefined,
  };
}

/** The same rules masterdata.save enforces, in words a person can act on — the server's are zod's. */
function issueOf(d: Draft): string | null {
  if (!d.name.trim()) return "The table needs a name.";
  if (d.kind === "query") return d.query.query.entitySet ? null : "The query needs an entity set.";
  if (!d.columns.length) return "The table needs at least one column.";
  if (d.columns.some((c) => !c.key.trim())) return "Every column needs a key.";
  return null;
}

export function MasterdataEditor({ id }: { id?: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const list = useQuery(orpc.masterdata.list.queryOptions());
  const row = id ? list.data?.find((t) => t.id === id) : undefined;

  const [draft, setDraft] = useState<Draft | null>(id ? null : emptyDraft());
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState<{ cols: string[]; rows: Cell[][] } | null>(null);
  const edit = (fn: (d: Draft) => Draft) => { setDraft((d) => (d ? fn(d) : d)); setDirty(true); };
  const testFetch = useMutation(orpc.masterdata.queryPage.mutationOptions({
    onSuccess: (r) => {
      edit((x) => ({ ...x, query: pruneColUi({ ...x.query, columns: r.columns }) }));
      setPreview({ cols: r.columns, rows: r.rows as Cell[][] });
    },
    onError: () => setPreview(null),
  }));

  useEffect(() => {
    if (!row || draft) return;
    setDraft({
      name: row.name,
      kind: row.kind,
      columns: row.kind === "table" ? (row.columns as Col[]) : emptyDraft().columns,
      rows: row.rows as Cell[][],
      query: row.query ?? emptyDraft().query,
    });
  }, [row, draft]);

  const invalidate = () => qc.invalidateQueries({ queryKey: orpc.masterdata.list.queryOptions().queryKey });
  const saveOpts = orpc.masterdata.save.mutationOptions({
    onSuccess: (r) => {
      setDirty(false);
      invalidate();
      toast("Masterdata saved");
      if (!id) void navigate({ to: "/masterdata/$id", params: { id: r.id }, replace: true });
    },
  });
  const save = useMutation({
    ...saveOpts,
    // The client rules run *as part of* the mutation rather than gating it, so a local problem and
    // a server one land in the same place: `save.error`. That is also what makes the mutation's own
    // state enough to say whether Save has been pressed — no second flag beside it.
    mutationFn: (...args: Parameters<NonNullable<typeof saveOpts.mutationFn>>) => {
      const i = issueOf(draft!);
      if (i) throw new Error(i);
      return saveOpts.mutationFn!(...args);
    },
  });
  // `isError`, not `submittedAt`: a submit stamp outlives the save that succeeded, so clearing a
  // field afterwards would light it up again — the very thing this was meant to stop.
  const submitted = save.isError;
  const remove = useMutation(orpc.masterdata.remove.mutationOptions({
    onSuccess: () => { setDirty(false); invalidate(); toast("Table deleted"); void navigate({ to: "/masterdata" }); },
  }));

  useBlocker({
    shouldBlockFn: async () => {
      if (!dirty || save.isPending) return false;
      return !(await confirm({
        title: "Discard changes?",
        message: "This table has unsaved changes. Leave without saving?",
        actionText: "Discard",
        destructive: true,
      }));
    },
    enableBeforeUnload: () => dirty,
  });

  if (!draft) {
    if (list.error)
      return <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>{list.error.message}</MessageStrip>;
    if (list.data && !row)
      return <IllustratedMessage name="NoData" design="Auto" titleText="Table not found" subtitleText="It may have been deleted." />;
    return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;
  }
  const d = draft;
  const error = save.error ?? remove.error;
  // Both title states: a delete the server refuses has to be readable without scrolling the
  // header shut first.
  const errorStrip = error
    ? <MessageStrip design="Negative" hideCloseButton style={{ paddingBlockStart: "0.5rem" }}>{error.message}</MessageStrip>
    : null;

  const typed = (col: Col, raw: string): Cell =>
    col.type === "number" ? (raw === "" ? null : Number(raw)) : col.type === "boolean" ? raw === "true" : raw;

  // Excel/Sheets clipboard = TSV. Types applied per column.
  const pasteRows = (text: string) => {
    const parsed = text.split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => l.split("\t"));
    if (!parsed.length) return;
    edit((x) => ({ ...x, rows: [...x.rows, ...parsed.map((cells) => x.columns.map((c, i) => typed(c, cells[i] ?? "")))] }));
    // A big paste lands below the fold; without this it looks like nothing happened.
    toast(`${plural(parsed.length, "row")} added`);
  };

  const setQuery = (patch: Partial<QueryDef>) => edit((x) => ({ ...x, query: pruneColUi({ ...x.query, ...patch }) }));
  const setOData = (patch: Partial<ODataQuery>) => edit((x) => ({ ...x, query: { ...x.query, query: { ...x.query.query, ...patch } } }));
  const setCell = (ri: number, ci: number, v: Cell) =>
    edit((x) => ({ ...x, rows: x.rows.map((y, j) => (j === ri ? y.map((cell, cj) => (cj === ci ? v : cell)) : y)) }));

  return (
    <ObjectPage
      titleArea={
        <ObjectPageTitle
          header={
              <Title level="H4">{"Master data: " + (d.name || (id ? "Untitled" : "New table"))}</Title>

          }
          snappedContent={errorStrip}
          expandedContent={errorStrip}
          actionsBar={
            <Toolbar design="Transparent" accessibleName="Table actions">
              {id ? (
                <ToolbarButton text="Delete" icon="delete" tooltip="Delete table" accessibleName="Delete table" disabled={remove.isPending}
                  onClick={async () => {
                    if (await confirm({
                      title: "Delete table",
                      message: `Delete "${d.name}"? A table used by a model can't be deleted. This cannot be undone.`,
                      actionText: "Delete", destructive: true,
                    })) remove.mutate({ id });
                  }} />
              ) : null}
            </Toolbar>
          }
        />
      }
      footerArea={
        <Bar design="FloatingFooter" endContent={
          <Button design="Emphasized" disabled={save.isPending}
            onClick={() => save.mutate(
              d.kind === "table"
                ? { id, name: d.name.trim(), kind: "table", columns: d.columns, rows: d.rows }
                : { id, name: d.name.trim(), kind: "query", query: d.query },
            )}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        } />
      }
    >
      <ObjectPageSection id="details" titleText="Details">
        <Form {...PAIRS}>
          <FormItem labelContent={<Label required>Name</Label>}>
            <Input value={d.name} placeholder="prices" required
              valueState={submitted && !d.name.trim() ? "Negative" : "None"}
              onInput={(e) => edit((x) => ({ ...x, name: e.target.value }))} />
          </FormItem>
          <FormItem labelContent={<Label required>Kind</Label>}>
            {/* Fixed once saved: the two kinds store different things, and a flip would throw
                away either the maintained rows or the query. Read-only rather than disabled —
                the choice still has to be readable after saving. */}
            <Select readonly={!!id} required value={d.kind} accessibleName="Kind"
              onChange={(e) => edit((x) => ({ ...x, kind: e.detail.selectedOption.value as Draft["kind"] }))}>
              <Option value="table" additionalText="Maintained here">Table</Option>
              <Option value="query" additionalText="Read live from SAP">Query</Option>
            </Select>
          </FormItem>
        </Form>
      </ObjectPageSection>

      {d.kind === "table" ? (
        <ObjectPageSection id="columns" titleText={`Columns (${d.columns.length})`}>
          <Form {...FULL}>
            <FormGroup accessibleName="Columns">
              <Toolbar design="Transparent" accessibleName="Column actions" style={NO_RULE}>
                <ToolbarButton icon="add" design="Transparent" text="Add column" onClick={() => edit((x) => ({
                  ...x,
                  columns: [...x.columns, { key: "", label: "", type: "string" }],
                  rows: x.rows.map((r) => [...r, null]),
                }))} />
              </Toolbar>
              {/* Popin rather than Scroll: three short columns that must stay readable when the
                  window is narrow. */}
              <Table
                overflowMode="Popin"
                rowActionCount={1}
                onRowActionClick={(e) => {
                  const i = rowIndex(e.detail.row);
                  edit((x) => ({
                    ...x,
                    columns: x.columns.filter((_, j) => j !== i),
                    rows: x.rows.map((r) => r.filter((_, j) => j !== i)),
                  }));
                }}
                headerRow={
                  <TableHeaderRow>
                    <TableHeaderCell minWidth="12rem">Key</TableHeaderCell>
                    <TableHeaderCell minWidth="10rem">Label</TableHeaderCell>
                    <TableHeaderCell width="9rem">Type</TableHeaderCell>
                  </TableHeaderRow>
                }>
                {d.columns.map((c, i) => (
                  <TableRow key={i} rowKey={`col-${i}`}
                    actions={<TableRowAction icon="delete" text="Delete" />}>
                    <TableCell>
                      <div style={{ ...CELL, width: "100%" }}>
                        {i === 0 ? <Icon name="key" design="Neutral" accessibleName="Lookup key" /> : iconSlot}
                        <Input placeholder="key" value={c.key} style={{ width: "100%" }}
                          valueState={submitted && !c.key.trim() ? "Negative" : "None"}
                          onInput={(e) => edit((x) => ({ ...x, columns: x.columns.map((y, j) => (j === i ? { ...y, key: e.target.value } : y)) }))} />
                      </div>
                    </TableCell>
                    <TableCell>
                      <Input placeholder={c.key || "label"} value={c.label} style={{ width: "100%" }}
                        onInput={(e) => edit((x) => ({ ...x, columns: x.columns.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)) }))} />
                    </TableCell>
                    <TableCell>
                      <Select style={{ width: "100%" }} value={c.type} accessibleName="Column type"
                        onChange={(e) => edit((x) => ({ ...x, columns: x.columns.map((y, j) => (j === i ? { ...y, type: e.detail.selectedOption.value as Col["type"] } : y)) }))}>
                        {(["string", "number", "boolean"] as const).map((t) => <Option key={t} value={t}>{t}</Option>)}
                      </Select>
                    </TableCell>
                  </TableRow>
                ))}
              </Table>
            </FormGroup>
          </Form>
        </ObjectPageSection>
      ) : (
        <ObjectPageSection id="query" titleText="Query">
          {/* Two groups, one form: clauses left, the rows they produce right, so editing a
              filter and reading the effect needs no scrolling. The Form's own grid stacks them
              at M and below. */}
          <Form {...FIELDS}>
            <FormGroup headerText="Clauses">
              <FormItem labelContent={<Label>Source</Label>}>
                <Select value={d.query.target} accessibleName="Source"
                  onChange={(e) => setQuery({ target: e.detail.selectedOption.value as QueryDef["target"] })}>
                  <Option value="b1">B1</Option>
                  <Option value="beas">Beas</Option>
                </Select>
              </FormItem>
              <FormItem labelContent={<Label required>Entity set</Label>}>
                <Input value={d.query.query.entitySet} placeholder="Items" required
                  valueState={submitted && !d.query.query.entitySet ? "Negative" : "None"}
                  onInput={(e) => setOData({ entitySet: e.target.value.trim() })} />
              </FormItem>
              <FormItem labelContent={<Label>Select</Label>}>
                {/* Committed on change (Enter/focus-out), not on input: `columns` drives $select
                    *and* the label/visibility bags, which would be pruned mid-word on every keystroke. */}
                <Input value={d.query.columns.join(", ")} placeholder="ItemCode, ItemName"
                  onChange={(e) => setQuery({ columns: [...new Set(e.target.value.split(/[,\s]+/).filter(Boolean))] })} />
              </FormItem>
              <FormItem labelContent={<Label>Filter</Label>}>
                <TextArea growing growingMaxRows={4} rows={1} value={d.query.query.filter ?? ""}
                  placeholder="ItemType eq 'itItems' and Frozen eq 'tNO'"
                  onInput={(e) => setOData({ filter: e.target.value || undefined })} />
              </FormItem>
              <FormItem labelContent={<Label>Sort</Label>}>
                <Input value={d.query.query.orderby ?? ""} placeholder="ItemName"
                  onInput={(e) => setOData({ orderby: e.target.value || undefined })} />
              </FormItem>
            </FormGroup>

            {/* The panel goes in the group directly, not through a FormItem: a FormItem always
                reserves its label track, and a table has no business being indented into 8/12
                of half a section. */}
            <FormGroup accessibleName="Preview">
              {/* The heading is hand-rolled rather than `headerText` because FormGroup has no
                  header slot, and Test fetch belongs on the heading line. HEADING copies what
                  the Form gives its own group headings so the two line up. */}
              <div style={HEADING}>
                <Title level="H5" size="H6">Preview</Title>
                <Button design="Transparent" icon="refresh"
                  disabled={testFetch.isPending || !d.query.query.entitySet}
                  onClick={() => testFetch.mutate({
                    target: d.query.target,
                    query: d.query.query,
                    columns: d.query.columns,
                    top: PREVIEW_TOP,
                  })}>
                  {testFetch.isPending ? "Loading…" : "Test fetch"}
                </Button>
              </div>
              {testFetch.error ? <MessageStrip design="Negative" hideCloseButton>{testFetch.error.message}</MessageStrip> : null}
              {preview ? (
                // Scroll, not Popin: popped-in columns stack *inside* the row, which is the row
                // growing taller. Long values truncate (maxLines) and the table scrolls instead.
                <Table noDataText="No rows returned."
                  headerRow={
                    <TableHeaderRow>
                      {preview.cols.map((c) => (
                        <TableHeaderCell key={c} minWidth="8rem"><span>{d.query.labels?.[c] || c}</span></TableHeaderCell>
                      ))}
                    </TableHeaderRow>
                  }>
                  {preview.rows.map((r, ri) => (
                    <TableRow key={ri} rowKey={`q-${ri}`}>
                      {r.map((cell, ci) => (
                        <TableCell key={ci}>
                          <Text maxLines={1} title={String(cell ?? "")}>{String(cell ?? "")}</Text>
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </Table>
              ) : (
                <IllustratedMessage name="NoData" design="Dot" titleText="No preview yet"
                  subtitleText={`Run Test fetch to read the first ${PREVIEW_TOP} rows from SAP.`} />
              )}
            </FormGroup>
          </Form>
        </ObjectPageSection>
      )}

      {d.kind === "table" ? (
        <ObjectPageSection id="rows" titleText={`Rows (${d.rows.length})`}>
          <Form {...FULL}>
            <FormGroup accessibleName="Rows">
              <Toolbar design="Transparent" accessibleName="Row actions" style={NO_RULE}>
                <ToolbarButton icon="add" design="Transparent" text="Add row" disabled={!d.columns.length}
                  onClick={() => edit((x) => ({ ...x, rows: [...x.rows, x.columns.map(() => null as Cell)] }))} />
              </Toolbar>
              <div
                onPaste={(e) => {
                  const text = e.clipboardData.getData("text");
                  // Only a grid becomes new rows; a single value belongs in the cell being pasted into.
                  if (!/[\t\n]/.test(text) || !d.columns.length) return;
                  e.preventDefault();
                  pasteRows(text);
                }}>
                <Table
                  noData={
                    <IllustratedMessage name="NoData" design="Dot" titleText="No rows yet"
                      subtitleText="Add one, or paste a block of cells straight from a spreadsheet." />
                  }
                  rowActionCount={1}
                  onRowActionClick={(e) => {
                    const i = rowIndex(e.detail.row);
                    edit((x) => ({ ...x, rows: x.rows.filter((_, j) => j !== i) }));
                  }}
                  headerRow={
                    <TableHeaderRow>
                      {d.columns.map((c, i) => (
                        <TableHeaderCell key={i} minWidth={colMinWidth(c.label || c.key, d.rows, i)}>
                          <span>{c.label || c.key}</span>
                        </TableHeaderCell>
                      ))}
                    </TableHeaderRow>
                  }>
                  {d.rows.map((r, ri) => (
                    <TableRow key={ri} rowKey={`row-${ri}`} actions={<TableRowAction icon="delete" text="Delete" />}>
                      {d.columns.map((c, ci) => (
                        <TableCell key={ci}>
                          {/* The column's own type rather than a text box for everything: a boolean
                              reads as a checkbox, a number gets the numeric keypad. */}
                          {c.type === "boolean" ? (
                            <CheckBox checked={r[ci] === true} accessibleName={c.label || c.key}
                              onChange={(e) => setCell(ri, ci, e.target.checked)} />
                          ) : (
                            <Input style={{ width: "100%" }} type={c.type === "number" ? "Number" : "Text"}
                              accessibleName={c.label || c.key} value={String(r[ci] ?? "")}
                              onInput={(e) => setCell(ri, ci, typed(c, e.target.value))} />
                          )}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </Table>
              </div>
            </FormGroup>
          </Form>
        </ObjectPageSection>
      ) : (
        <ObjectPageSection id="qcolumns" titleText={`Columns (${d.query.columns.length})`}>
          <Form {...FULL}>
            <FormGroup accessibleName="Query columns">
              <MessageStrip design="Information" hideCloseButton>
                Labels and visibility apply to the value-help dialog only; every column still binds as a derived parameter.
              </MessageStrip>
              <Table
                noData={
                  <IllustratedMessage name="NoData" design="Dot" titleText="No columns yet"
                    subtitleText="Name them in the query's Select clause, or run Test fetch to read them from SAP." />
                }
                headerRow={
                  <TableHeaderRow>
                    <TableHeaderCell minWidth="10rem"><span>Key</span></TableHeaderCell>
                    <TableHeaderCell minWidth="12rem"><span>Label</span></TableHeaderCell>
                    <TableHeaderCell width="7rem"><span>Value help</span></TableHeaderCell>
                  </TableHeaderRow>
                }>
                {/* The first two columns of the Select clause are the key and the label by
                    convention (refKeyCols) — the icons say so instead of a line of prose. */}
                {d.query.columns.map((c, i) => (
                  <TableRow key={c} rowKey={c}>
                    <TableCell>
                      <div style={CELL}>
                        {i < 2
                          ? <Icon name={i === 0 ? "key" : "text"} design="Neutral" accessibleName={i === 0 ? "Key column" : "Label column"} />
                          : iconSlot}
                        <Text>{c}</Text>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Input placeholder={c} value={d.query.labels?.[c] ?? ""} style={{ width: "100%" }}
                        accessibleName={`Label for ${c}`}
                        onInput={(e) => setQuery({ labels: { ...d.query.labels, [c]: e.target.value } })} />
                    </TableCell>
                    <TableCell>
                      <CheckBox checked={!d.query.hidden?.includes(c)} accessibleName="Show in value help"
                        onChange={(e) => setQuery({
                          hidden: e.target.checked
                            ? (d.query.hidden ?? []).filter((k) => k !== c)
                            : [...(d.query.hidden ?? []), c],
                        })} />
                    </TableCell>
                  </TableRow>
                ))}
              </Table>
            </FormGroup>
          </Form>
        </ObjectPageSection>
      )}
    </ObjectPage>
  );
}
