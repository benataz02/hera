import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, BusyIndicator, Card, CardHeader, Form, FormItem, Icon, IllustratedMessage, Input, Label,
  List, ListItemCustom, ListItemGroup, ListItemStandard, Menu, MenuItem, MessageStrip, ObjectStatus,
  Option, Select, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableRowAction,
  TableVirtualizer, Text, Title,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import type { ModelDef, Val } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";
import { QueryCard } from "./QueryEditor.tsx";
import { colMinWidth } from "./tableWidths.ts";
import { confirm } from "../confirm.ts";
import { toast } from "../toast.ts";

type Col = { key: string; label: string; type: "string" | "number" | "boolean" };
// config_table cells are scalar (ValZ), unlike the full Val union which includes string[].
type Cell = Exclude<Val, string[]>;
type Draft = { id?: string; name: string; columns: Col[]; rows: Cell[][] };

type Update = (fn: (d: ModelDef) => ModelDef) => void;

const empty = (): Draft => ({ name: "", columns: [{ key: "key", label: "Key", type: "string" }], rows: [] });

const EDITOR = { flex: 1, maxWidth: "64rem", display: "flex", flexDirection: "column", gap: "1rem" } as const;
// Same geometry as SettingsTab/HistoryTab so the builder's tabs line up.
const FORM = { labelSpan: "S12 M4", layout: "S1 M1 L2 XL2" } as const;
const CARD_BODY = { padding: "0 1rem 1rem" } as const;

// Rows are virtualised, so the grid needs a bounded scroll container and a row height it can trust.
// 44px = sapElement_LineHeight (2.75rem, cozy); the Input inside a cell doesn't grow the row past it.
// ponytail: hard-coded because nothing measures it — if rows ever overlap or gap, this is the number.
const ROW_HEIGHT = 44;
const ROWS_VIEWPORT = { maxHeight: "32rem", overflow: "auto" } as const;

export function TablesTab({ draft: model, update }: { draft: ModelDef; update: Update }) {
  const qc = useQueryClient();
  const listQ = useQuery(orpc.models.tables.list.queryOptions());
  const invalidate = () => qc.invalidateQueries({ queryKey: orpc.models.tables.list.queryOptions().queryKey });
  const [draft, setDraft] = useState<Draft | null>(null); // tenant-table editor
  const [qIdx, setQIdx] = useState<number | null>(null); // queryTables editor
  // Lookup tables save on their own button, so ModelBuilderPage's useBlocker doesn't cover them.
  // Track edits here so the status shows and a selection change can't silently discard them.
  const [dirty, setDirty] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const save = useMutation(orpc.models.tables.save.mutationOptions({
    onSuccess: () => { invalidate(); setDirty(false); toast("Table saved"); },
  }));
  const remove = useMutation(
    orpc.models.tables.remove.mutationOptions({
      onSuccess: () => {
        invalidate();
        setDraft(null);
        setDirty(false);
        toast("Table deleted");
      },
    }),
  );
  const confirmRemoveTable = async (id: string, name: string) => {
    // Lookup tables are their own server rows shared across models — deletion is immediate and irreversible.
    if (await confirm({ title: "Delete lookup table", message: `Delete table "${name}"? Models that reference it by name will fail their lookups. This can't be undone.`, actionText: "Delete", destructive: true }))
      remove.mutate({ id });
  };
  const confirmRemoveQuery = async (name: string, run: () => void) => {
    if (await confirm({ title: "Delete query", message: `Delete query "${name}" from this model? It won't persist until you save the model.`, actionText: "Delete", destructive: true }))
      run();
  };

  const tables = listQ.data ?? [];

  // Every editor mutation goes through here: the updater form (so two fast edits can't drop one)
  // plus the dirty flag that drives the status and the discard guard.
  const edit = (fn: (d: Draft) => Draft) => { setDraft((d) => (d ? fn(d) : d)); setDirty(true); };

  const discardOk = async () =>
    !dirty || await confirm({
      title: "Discard changes?",
      message: `"${draft?.name || "This table"}" has unsaved changes that the model's Save button won't keep. Leave without saving?`,
      actionText: "Discard",
      destructive: true,
    });

  const openTable = async (id: string) => {
    if (!(await discardOk())) return;
    const t = tables.find((x) => x.id === id);
    if (!t) return;
    setDraft({ id: t.id, name: t.name, columns: t.columns as Col[], rows: t.rows as Cell[][] });
    setDirty(false);
    setQIdx(null);
  };
  const openQuery = async (i: number) => {
    if (!(await discardOk())) return;
    setQIdx(i);
    setDraft(null);
    setDirty(false);
  };
  const newTable = async () => {
    if (!(await discardOk())) return;
    setDraft(empty());
    setDirty(false);
    setQIdx(null);
  };
  const addQuery = async () => {
    if (!(await discardOk())) return;
    update((d) => ({
      ...d,
      queryTables: [...d.queryTables, { name: `query${d.queryTables.length + 1}`, target: "b1", path: "", columns: [] }],
    }));
    setQIdx(model.queryTables.length);
    setDraft(null);
    setDirty(false);
  };

  if (listQ.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "2rem" }} />;

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

  return (
    <div style={{ display: "flex", gap: "1rem", padding: "1rem", alignItems: "flex-start" }}>
      <div style={{ width: "17rem", flexShrink: 0 }}>
        <List
          selectionMode="SingleEnd"
          onItemClick={(e) => {
            const el = e.detail.item as HTMLElement;
            if (el.dataset.id) void openTable(el.dataset.id);
            else if (el.dataset.idx) void openQuery(Number(el.dataset.idx));
          }}>
          {/* ListItemGroup's header slot only takes a list item, so the + button rides inside one.
              Inlined rather than extracted: a wrapper component would swallow the injected `slot`. */}
          <ListItemGroup
            header={
              <ListItemCustom type="Inactive">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
                  <Title level="H6">Lookup tables</Title>
                  <Button icon="add" design="Transparent" tooltip="New table" onClick={() => void newTable()} />
                </div>
              </ListItemCustom>
            }>
            {tables.map((t) => (
              <ListItemStandard key={t.id} data-id={t.id} selected={!!draft?.id && draft.id === t.id}
                text={t.name}
                additionalText={`${(t.columns as Col[]).length} cols · ${(t.rows as Val[][]).length} rows`} />
            ))}
            {/* An unsaved new table has no row on the server yet — without this the list shows
                nothing selected while its editor is open. */}
            {draft && !draft.id ? (
              <ListItemStandard type="Inactive" selected text={draft.name || "New table"} additionalText="Unsaved" />
            ) : null}
            {!tables.length && !(draft && !draft.id) ? emptyItem("None yet — use + to add one.") : null}
          </ListItemGroup>

          <ListItemGroup
            header={
              <ListItemCustom type="Inactive">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
                  <Title level="H6">Queries — this model</Title>
                  <Button icon="add" design="Transparent" tooltip="New query" onClick={() => void addQuery()} />
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
          {save.error ? <MessageStrip design="Negative" hideCloseButton>{save.error.message}</MessageStrip> : null}

          <Card
            header={
              <CardHeader
                titleText={draft.name || "New lookup table"}
                subtitleText="Its own server row, shared across models — the model's Save button doesn't cover it."
                action={
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    {dirty ? <ObjectStatus state="Critical">Unsaved changes</ObjectStatus> : null}
                    <Button design="Emphasized" disabled={!draft.name.trim() || !draft.columns.length || save.isPending}
                      onClick={() => save.mutate({ id: draft.id, name: draft.name.trim(), columns: draft.columns, rows: draft.rows })}>
                      {save.isPending ? "Saving…" : "Save table"}
                    </Button>
                    {draft.id ? (
                      <Button id="tables-more" icon="overflow" design="Transparent" tooltip="More actions"
                        disabled={remove.isPending} onClick={() => setMenuOpen(true)} />
                    ) : null}
                  </div>
                } />
            }>
            <div style={CARD_BODY}>
              <Form {...FORM}>
                <FormItem labelContent={<Label required>Name</Label>}>
                  <Input value={draft.name} placeholder="Referenced by LOOKUP and by table domains"
                    onInput={(e) => edit((d) => ({ ...d, name: e.target.value }))} />
                </FormItem>
              </Form>
            </div>
          </Card>

          {menuOpen && draft.id ? (
            <Menu open opener="tables-more" onClose={() => setMenuOpen(false)}
              onItemClick={() => { setMenuOpen(false); void confirmRemoveTable(draft.id!, draft.name); }}>
              <MenuItem icon="delete" text="Delete table" />
            </Menu>
          ) : null}

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
            const setQt = (patch: Partial<ModelDef["queryTables"][number]>) =>
              update((d) => ({ ...d, queryTables: d.queryTables.map((q, i) => (i === qIdx ? { ...q, ...patch } : q)) }));
            return (
              <>
                <Card
                  header={
                    <CardHeader
                      titleText={qt.name || "New query"}
                      subtitleText="Part of the model — saved with the model's Save button, not on its own."
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

                <QueryCard key={qIdx} target={qt.target} path={qt.path} columns={qt.columns} onChange={setQt} />

                {/* QueryEditor already shows the column count as a Tag — this only adds the mapping. */}
                <Text>
                  {qt.columns.length
                    ? `key = ${qt.columns[0]}${qt.columns[1] ? `, label = ${qt.columns[1]}` : ""}`
                    : "Run Test fetch to take the columns from the response."}
                </Text>
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
