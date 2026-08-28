import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, BusyIndicator, Card, CardHeader, CheckBox, Form, FormItem, Icon, IllustratedMessage, Input, Label,
  List, ListItemCustom, ListItemGroup, ListItemStandard, MessageStrip, ObjectStatus,
  Option, Select, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableRowAction,
  TableVirtualizer, Text, Title,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import type { ModelDef, Val } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";
import { QueryCard, emptyQuery } from "./QueryEditor.tsx";
import { colMinWidth } from "./tableWidths.ts";
import { NEW_TABLE_KEY, type TableCell as Cell, type TableCol as Col, type TableDraft as Draft } from "./useDraftModel.ts";
import { confirm } from "../confirm.ts";
import { toast } from "../toast.ts";

type Update = (fn: (d: ModelDef) => ModelDef) => void;

const empty = (): Draft => ({ name: "", columns: [{ key: "key", label: "Key", type: "string" }], rows: [] });

type QueryTable = ModelDef["queryTables"][number];

// Drop labels/hidden for keys Test fetch no longer returns; omit empty bags so the model stays sparse.
function pruneColUi(columns: string[], labels?: Record<string, string>, hidden?: string[]): Pick<QueryTable, "labels" | "hidden"> {
  const keys = new Set(columns);
  const nextLabels = Object.fromEntries(Object.entries(labels ?? {}).filter(([k, v]) => keys.has(k) && v.trim() !== ""));
  const nextHidden = (hidden ?? []).filter((k) => keys.has(k));
  return {
    labels: Object.keys(nextLabels).length ? nextLabels : undefined,
    hidden: nextHidden.length ? nextHidden : undefined,
  };
}

const EDITOR = { flex: 1, maxWidth: "64rem", display: "flex", flexDirection: "column", gap: "1rem" } as const;
// Same geometry as SettingsTab/HistoryTab so the builder's tabs line up.
const FORM = { labelSpan: "S12 M4", layout: "S1 M1 L2 XL2" } as const;
const CARD_BODY = { padding: "0 1rem 1rem" } as const;

// Rows are virtualised, so the grid needs a bounded scroll container and a row height it can trust.
// 44px = sapElement_LineHeight (2.75rem, cozy); the Input inside a cell doesn't grow the row past it.
// ponytail: hard-coded because nothing measures it — if rows ever overlap or gap, this is the number.
const ROW_HEIGHT = 44;
const ROWS_VIEWPORT = { maxHeight: "32rem", overflow: "auto" } as const;

export function TablesTab({ draft: model, update, tableEdits, editTable }: {
  draft: ModelDef;
  update: Update;
  // Lookup-table edits live in useDraftModel so the model's Save button commits them; this tab
  // only picks what's open and edits through `editTable`.
  tableEdits: Record<string, Draft>;
  editTable: (key: string, d: Draft | null) => void;
}) {
  const qc = useQueryClient();
  const listQ = useQuery(orpc.models.tables.list.queryOptions());
  const [selKey, setSelKey] = useState<string | null>(null); // open lookup table (server id, or NEW_TABLE_KEY)
  const [qIdx, setQIdx] = useState<number | null>(null); // queryTables editor

  const remove = useMutation(
    orpc.models.tables.remove.mutationOptions({
      onSuccess: (_res, vars) => {
        qc.invalidateQueries({ queryKey: orpc.models.tables.list.queryOptions().queryKey });
        editTable(vars.id, null);
        setSelKey(null);
        toast("Table deleted");
      },
    }),
  );
  const confirmRemoveTable = async (id: string, name: string) => {
    // Lookup tables are their own server rows shared across models — unlike edits, deletion is
    // immediate and irreversible, so it doesn't wait for the model's Save button.
    if (await confirm({ title: "Delete lookup table", message: `Delete table "${name}"? Models that reference it by name will fail their lookups. This happens immediately and can't be undone.`, actionText: "Delete", destructive: true }))
      remove.mutate({ id });
  };
  const confirmRemoveQuery = async (name: string, run: () => void) => {
    if (await confirm({ title: "Delete query", message: `Delete query "${name}" from this model? It won't persist until you save the model.`, actionText: "Delete", destructive: true }))
      run();
  };

  if (listQ.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "2rem" }} />;

  const tables = listQ.data ?? [];

  const fromServer = (id: string): Draft | null => {
    const t = tables.find((x) => x.id === id);
    return t ? { id: t.id, name: t.name, columns: t.columns as Col[], rows: t.rows as Cell[][] } : null;
  };
  // A pending edit wins over the server row; NEW_TABLE_KEY only ever exists as a pending edit.
  const draft = selKey ? (tableEdits[selKey] ?? fromServer(selKey)) : null;
  const edit = (fn: (d: Draft) => Draft) => { if (selKey && draft) editTable(selKey, fn(draft)); };

  const newTable = () => {
    editTable(NEW_TABLE_KEY, empty());
    setSelKey(NEW_TABLE_KEY);
    setQIdx(null);
  };
  const addQuery = () => {
    update((d) => ({
      ...d,
      queryTables: [...d.queryTables, { name: `query${d.queryTables.length + 1}`, target: "b1", query: emptyQuery(), columns: [] }],
    }));
    setQIdx(model.queryTables.length);
    setSelKey(null);
  };

  const typed = (col: Col, raw: string): Cell =>
    col.type === "number" ? (raw === "" ? null : Number(raw)) : col.type === "boolean" ? raw === "true" : raw;

  // Excel/Sheets clipboard = TSV. Types applied per column.
  const pasteRows = (text: string) => {
    const parsed = text.split(/\r?\n/).filter((l) => l.trim() !== "")
      .map((l) => l.split("\t"));
    if (!parsed.length) return;
    edit((d) => ({
      ...d,
      rows: [...d.rows, ...parsed.map((cells) => d.columns.map((c, i) => typed(c, cells[i] ?? "")))],
    }));
    // A big paste lands below the fold; without this it looks like nothing happened.
    toast(`${parsed.length} row${parsed.length === 1 ? "" : "s"} added`);
  };

  const emptyItem = (text: string) => (
    <ListItemCustom type="Inactive">
      <Text style={{ color: "var(--sapContent_LabelColor)", fontStyle: "italic", padding: "0 1rem" }}>{text}</Text>
    </ListItemCustom>
  );
  const rowSummary = (d: { columns: unknown[]; rows: unknown[] }) =>
    `${d.columns.length} cols · ${d.rows.length} rows`;

  const pendingNew = tableEdits[NEW_TABLE_KEY];

  return (
    <div style={{ display: "flex", gap: "1rem", padding: "1rem", alignItems: "flex-start" }}>
      <div style={{ width: "17rem", flexShrink: 0 }}>
        <List
          selectionMode="SingleEnd"
          onItemClick={(e) => {
            const el = e.detail.item as HTMLElement;
            if (el.dataset.id) { setSelKey(el.dataset.id); setQIdx(null); }
            else if (el.dataset.idx) { setQIdx(Number(el.dataset.idx)); setSelKey(null); }
          }}>
          {/* ListItemGroup's header slot only takes a list item, so the + button rides inside one.
              Inlined rather than extracted: a wrapper component would swallow the injected `slot`. */}
          <ListItemGroup
            header={
              <ListItemCustom type="Inactive">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
                  <Title level="H6">Lookup tables</Title>
                  <Button icon="add" design="Transparent" tooltip="New table" onClick={newTable} />
                </div>
              </ListItemCustom>
            }>
            {tables.map((t) => {
              const pending = tableEdits[t.id];
              return (
                <ListItemStandard key={t.id} data-id={t.id} selected={selKey === t.id}
                  text={pending?.name || t.name}
                  additionalText={pending
                    ? `${rowSummary(pending)} · edited`
                    : rowSummary({ columns: t.columns as unknown[], rows: t.rows as unknown[] })} />
              );
            })}
            {/* An unsaved new table has no server row yet — without this the list shows nothing
                selected while its editor is open. */}
            {pendingNew ? (
              <ListItemStandard data-id={NEW_TABLE_KEY} selected={selKey === NEW_TABLE_KEY}
                text={pendingNew.name || "New table"} additionalText={`${rowSummary(pendingNew)} · new`} />
            ) : null}
            {!tables.length && !pendingNew ? emptyItem("None yet — use + to add one.") : null}
          </ListItemGroup>

          <ListItemGroup
            header={
              <ListItemCustom type="Inactive">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
                  <Title level="H6">Queries — this model</Title>
                  <Button icon="add" design="Transparent" tooltip="New query" onClick={addQuery} />
                </div>
              </ListItemCustom>
            }>
            {model.queryTables.length ? model.queryTables.map((qt, i) => (
              <ListItemStandard key={i} data-idx={String(i)} selected={qIdx === i} text={qt.name}
                additionalText={qt.columns.length ? `${qt.target} · ${qt.columns.length} cols` : qt.target} />
            )) : emptyItem("None yet — use + to add one.")}
          </ListItemGroup>
        </List>
      </div>

      {draft ? (
        <div style={EDITOR}>
          <Card
            header={
              <CardHeader
                titleText={draft.name || "New lookup table"}
                subtitleText="Its own server row, shared across every model that references it by name."
                action={
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    {selKey && tableEdits[selKey] ? <ObjectStatus state="Critical">Unsaved</ObjectStatus> : null}
                    {draft.id ? (
                      <Button icon="delete" design="Transparent" tooltip="Delete table"
                        disabled={remove.isPending} onClick={() => void confirmRemoveTable(draft.id!, draft.name)} />
                    ) : null}
                  </div>
                } />
            }>
            <div style={CARD_BODY}>
              <MessageStrip design="Information" hideCloseButton style={{ marginBottom: "1rem" }}>
                Saved with the model — use the Save button at the top of the page.
              </MessageStrip>
              <Form {...FORM}>
                <FormItem labelContent={<Label required>Name</Label>}>
                  <Input value={draft.name} placeholder="Referenced by LOOKUP and by table domains"
                    onInput={(e) => edit((d) => ({ ...d, name: e.target.value }))} />
                </FormItem>
              </Form>
            </div>
          </Card>

          <Card
            header={
              <CardHeader titleText="Columns" subtitleText="The first column is the lookup key."
                additionalText={`${draft.columns.length} column${draft.columns.length === 1 ? "" : "s"}`}
                action={
                  <Button icon="add" onClick={() => edit((d) => ({
                    ...d,
                    columns: [...d.columns, { key: `col${d.columns.length + 1}`, label: "", type: "string" }],
                    rows: d.rows.map((r) => [...r, null]),
                  }))}>
                    Add column
                  </Button>
                } />
            }>
            {/* Popin rather than Scroll: three short columns that must stay readable when the
                builder is narrow. */}
            <Table
              overflowMode="Popin"
              rowActionCount={1}
              onRowActionClick={(e) => {
                const i = Number(((e.detail.row as unknown) as HTMLElement).dataset.idx);
                edit((d) => ({
                  ...d,
                  columns: d.columns.filter((_, j) => j !== i),
                  rows: d.rows.map((r) => r.filter((_, j) => j !== i)),
                }));
              }}
              headerRow={
                <TableHeaderRow>
                  <TableHeaderCell minWidth="12rem"><span>Key</span></TableHeaderCell>
                  <TableHeaderCell minWidth="10rem"><span>Label</span></TableHeaderCell>
                  <TableHeaderCell width="9rem"><span>Type</span></TableHeaderCell>
                </TableHeaderRow>
              }>
              {draft.columns.map((c, i) => (
                <TableRow key={i} rowKey={`col-${i}`} data-idx={String(i)}
                  // Deleting the last column leaves a table that can't be saved, with nothing on
                  // screen saying why — so the action hides (but keeps its slot) at one column.
                  actions={<TableRowAction icon="delete" text="Delete" invisible={draft.columns.length === 1} />}>
                  <TableCell>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", width: "100%" }}>
                      {i === 0 ? <Icon name="key" design="Neutral" accessibleName="Lookup key" /> : null}
                      <Input placeholder="key" value={c.key}
                        onInput={(e) => edit((d) => ({ ...d, columns: d.columns.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) }))} />
                    </div>
                  </TableCell>
                  <TableCell>
                    <Input placeholder="label" value={c.label}
                      onInput={(e) => edit((d) => ({ ...d, columns: d.columns.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) }))} />
                  </TableCell>
                  <TableCell>
                    <Select value={c.type}
                      onChange={(e) => edit((d) => ({ ...d, columns: d.columns.map((x, j) => (j === i ? { ...x, type: (e.detail.selectedOption as HTMLElement).dataset.v as Col["type"] } : x)) }))}>
                      {(["string", "number", "boolean"] as const).map((t) => <Option key={t} value={t} data-v={t}>{t}</Option>)}
                    </Select>
                  </TableCell>
                </TableRow>
              ))}
            </Table>
          </Card>

          <Card
            header={
              <CardHeader titleText="Rows" subtitleText="Paste cells straight from a spreadsheet anywhere in the grid."
                additionalText={`${draft.rows.length} row${draft.rows.length === 1 ? "" : "s"}`}
                action={
                  <Button icon="add" onClick={() => edit((d) => ({ ...d, rows: [...d.rows, d.columns.map(() => null as Cell)] }))}>
                    Add row
                  </Button>
                } />
            }>
            <div style={ROWS_VIEWPORT} onPaste={(e) => { e.preventDefault(); pasteRows(e.clipboardData.getData("text")); }}>
              {/* Stays overflowMode="Scroll" (the default): TableVirtualizer only virtualises in
                  Scroll mode, and a wide lookup table is worth more than popin here. */}
              <Table
                noData={
                  <IllustratedMessage name="NoData" design="Dot" titleText="No rows yet"
                    subtitleText="Add one, or paste a block of cells straight from a spreadsheet." />
                }
                rowActionCount={1}
                features={<TableVirtualizer rowCount={draft.rows.length} rowHeight={ROW_HEIGHT} />}
                onRowActionClick={(e) => {
                  const i = Number(((e.detail.row as unknown) as HTMLElement).dataset.idx);
                  edit((d) => ({ ...d, rows: d.rows.filter((_, j) => j !== i) }));
                }}
                headerRow={
                  <TableHeaderRow>
                    {draft.columns.map((c, i) => (
                      <TableHeaderCell key={c.key} minWidth={colMinWidth(c.label || c.key, draft.rows, i)}>
                        <span>{c.label || c.key}</span>
                      </TableHeaderCell>
                    ))}
                  </TableHeaderRow>
                }>
                {draft.rows.map((row, ri) => (
                  <TableRow key={ri} rowKey={`row-${ri}`} data-idx={String(ri)} actions={<TableRowAction icon="delete" text="Delete" />}>
                    {draft.columns.map((c, ci) => (
                      <TableCell key={ci}>
                        <Input value={String(row[ci] ?? "")} onInput={(e) =>
                          edit((d) => ({ ...d, rows: d.rows.map((r, j) => (j === ri ? r.map((cell, cj) => (cj === ci ? typed(c, e.target.value) : cell)) : r)) }))} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </Table>
            </div>
          </Card>
        </div>
      ) : qIdx !== null && model.queryTables[qIdx] ? (
        <div style={EDITOR}>
          {(() => {
            const qt = model.queryTables[qIdx]!;
            const setQt = (patch: Partial<QueryTable>) =>
              update((d) => ({ ...d, queryTables: d.queryTables.map((q, i) => (i === qIdx ? { ...q, ...patch } : q)) }));
            const setLabel = (key: string, raw: string) => {
              const labels = { ...qt.labels };
              if (raw.trim()) labels[key] = raw;
              else delete labels[key];
              setQt({ labels: Object.keys(labels).length ? labels : undefined });
            };
            const setVisible = (key: string, visible: boolean) => {
              const hidden = new Set(qt.hidden ?? []);
              if (visible) hidden.delete(key);
              else hidden.add(key);
              setQt({ hidden: hidden.size ? [...hidden] : undefined });
            };
            return (
              <>
                <Card
                  header={
                    <CardHeader
                      titleText={qt.name || "New query"}
                      subtitleText="Part of the model — saved with the model's Save button."
                      action={
                        <Button icon="delete" design="Transparent" tooltip="Delete query"
                          onClick={() => void confirmRemoveQuery(qt.name, () => {
                            update((d) => ({ ...d, queryTables: d.queryTables.filter((_, i) => i !== qIdx) }));
                            setQIdx(null);
                          })} />
                      } />
                  }>
                  <div style={CARD_BODY}>
                    <Form {...FORM}>
                      <FormItem labelContent={<Label required>Name</Label>}>
                        <Input value={qt.name} placeholder="Referenced by parameter domains and LOOKUP"
                          onInput={(e) => setQt({ name: e.target.value })} />
                      </FormItem>
                    </Form>
                  </div>
                </Card>

                <QueryCard key={qIdx} target={qt.target} query={qt.query} columns={qt.columns}
                  onChange={(patch) => {
                    if (patch.columns) setQt({ ...patch, ...pruneColUi(patch.columns, qt.labels, qt.hidden) });
                    else setQt(patch);
                  }} />

                {/* QueryEditor already shows the column count as a Tag — this only adds the mapping. */}
                <Text>
                  {qt.columns.length
                    ? `key = ${qt.columns[0]}${qt.columns[1] ? `, label = ${qt.columns[1]}` : ""}`
                    : "Run Test fetch to take the columns from the response."}
                </Text>

                {qt.columns.length ? (
                  <Card
                    header={
                      <CardHeader titleText="Columns"
                        subtitleText="Labels and visibility apply to the value-help dialog only; every column still binds as a derived parameter."
                        additionalText={`${qt.columns.length} column${qt.columns.length === 1 ? "" : "s"}`} />
                    }>
                    <Table overflowMode="Popin"
                      headerRow={
                        <TableHeaderRow>
                          <TableHeaderCell minWidth="10rem"><span>Key</span></TableHeaderCell>
                          <TableHeaderCell minWidth="12rem"><span>Label</span></TableHeaderCell>
                          <TableHeaderCell width="7rem"><span>Value help</span></TableHeaderCell>
                        </TableHeaderRow>
                      }>
                      {qt.columns.map((c) => (
                        <TableRow key={c} rowKey={c}>
                          <TableCell><Text>{c}</Text></TableCell>
                          <TableCell>
                            <Input placeholder={c} value={qt.labels?.[c] ?? ""}
                              onInput={(e) => setLabel(c, e.target.value)} />
                          </TableCell>
                          <TableCell>
                            <CheckBox checked={!qt.hidden?.includes(c)} accessibleName="Show in value help"
                              onChange={(e) => setVisible(c, e.target.checked)} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </Table>
                  </Card>
                ) : null}
              </>
            );
          })()}
        </div>
      ) : (
        <div style={{ flex: 1, display: "flex", justifyContent: "center", paddingTop: "2rem" }}>
          <IllustratedMessage name="NoData" titleText="Nothing selected"
            subtitleText="Pick a lookup table or a query on the left, or use + to create one." />
        </div>
      )}
    </div>
  );
}
