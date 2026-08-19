import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, BusyIndicator, Card, CardHeader, IllustratedMessage, Input, Label, List, ListItemCustom,
  ListItemGroup, ListItemStandard, MessageStrip, Option, Select, Table, TableCell, TableHeaderCell,
  TableHeaderRow, TableRow, TableRowAction, Text, Title,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import type { ModelDef, Val } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";
import { QueryCard } from "./QueryEditor.tsx";
import { confirm } from "../confirm.ts";
import { toast } from "../toast.ts";

type Col = { key: string; label: string; type: "string" | "number" | "boolean" };
// config_table cells are scalar (ValZ), unlike the full Val union which includes string[].
type Cell = Exclude<Val, string[]>;
type Draft = { id?: string; name: string; columns: Col[]; rows: Cell[][] };

type Update = (fn: (d: ModelDef) => ModelDef) => void;

const empty = (): Draft => ({ name: "", columns: [{ key: "key", label: "Key", type: "string" }], rows: [] });

const BODY = { display: "flex", flexDirection: "column", gap: "0.75rem", padding: "1rem" } as const;
const EDITOR = { flex: 1, maxWidth: "64rem", display: "flex", flexDirection: "column", gap: "1rem" } as const;

export function TablesTab({ draft: model, update }: { draft: ModelDef; update: Update }) {
  const qc = useQueryClient();
  const listQ = useQuery(orpc.models.tables.list.queryOptions());
  const invalidate = () => qc.invalidateQueries({ queryKey: orpc.models.tables.list.queryOptions().queryKey });
  const [draft, setDraft] = useState<Draft | null>(null); // tenant-table editor (existing)
  const [qIdx, setQIdx] = useState<number | null>(null); // queryTables editor

  const save = useMutation(orpc.models.tables.save.mutationOptions({
    onSuccess: () => { invalidate(); toast("Table saved"); },
  }));
  const remove = useMutation(
    orpc.models.tables.remove.mutationOptions({
      onSuccess: () => {
        invalidate();
        setDraft(null);
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

  if (listQ.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "2rem" }} />;

  const typed = (col: Col, raw: string): Cell =>
    col.type === "number" ? (raw === "" ? null : Number(raw)) : col.type === "boolean" ? raw === "true" : raw;

  // Excel/Sheets clipboard = TSV. Types applied per column.
  const pasteRows = (text: string) => {
    const parsed = text.split(/\r?\n/).filter((l) => l.trim() !== "")
      .map((l) => l.split("\t"));
    setDraft((d) => d && ({
      ...d,
      rows: [...d.rows, ...parsed.map((cells) => d.columns.map((c, i) => typed(c, cells[i] ?? "")))],
    }));
  };

  const tables = listQ.data ?? [];

  const addQuery = () => {
    update((d) => ({
      ...d,
      queryTables: [...d.queryTables, { name: `query${d.queryTables.length + 1}`, target: "b1", path: "", columns: [] }],
    }));
    setQIdx(model.queryTables.length);
    setDraft(null);
  };

  return (
    <div style={{ display: "flex", gap: "1rem", padding: "1rem", alignItems: "flex-start" }}>
      <div style={{ width: "17rem", flexShrink: 0 }}>
        <List
          selectionMode="SingleEnd"
          onItemClick={(e) => {
            const el = e.detail.item as HTMLElement;
            if (el.dataset.id) {
              const t = tables.find((x) => x.id === el.dataset.id);
              if (t) setDraft({ id: t.id, name: t.name, columns: t.columns as Col[], rows: t.rows as Cell[][] });
              setQIdx(null);
            } else if (el.dataset.idx) {
              setQIdx(Number(el.dataset.idx));
              setDraft(null);
            }
          }}>
          {/* ListItemGroup's header slot only takes a list item, so the + button rides inside one.
              Inlined rather than extracted: a wrapper component would swallow the injected `slot`. */}
          <ListItemGroup
            header={
              <ListItemCustom type="Inactive">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
                  <Title level="H6">Lookup tables</Title>
                  <Button icon="add" design="Transparent" tooltip="New table" onClick={() => { setDraft(empty()); setQIdx(null); }} />
                </div>
              </ListItemCustom>
            }>
            {tables.length ? tables.map((t) => (
              <ListItemStandard key={t.id} data-id={t.id} selected={!!draft?.id && draft.id === t.id}
                text={t.name} additionalText={`${(t.rows as Val[][]).length} rows`} />
            )) : <ListItemStandard type="Inactive" text="None yet — use + to add one." />}
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
              <ListItemStandard key={i} data-idx={String(i)} selected={qIdx === i} text={qt.name} additionalText={qt.target} />
            )) : <ListItemStandard type="Inactive" text="None yet — use + to add one." />}
          </ListItemGroup>
        </List>
      </div>

      {draft ? (
        <div style={EDITOR}>
          {save.error ? <MessageStrip design="Negative" hideCloseButton>{save.error.message}</MessageStrip> : null}
          <MessageStrip design="Information" hideCloseButton>
            Lookup tables are stored on their own and save immediately — the model's Save button doesn't cover them.
          </MessageStrip>

          <div style={{ display: "flex", gap: "0.75rem", alignItems: "end" }}>
            <div style={{ flex: 1 }}>
              <Label required>Name (referenced by LOOKUP and table domains)</Label>
              <Input style={{ width: "100%" }} value={draft.name} onInput={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <Button design="Emphasized" disabled={!draft.name.trim() || !draft.columns.length || save.isPending}
              onClick={() => save.mutate({ id: draft.id, name: draft.name.trim(), columns: draft.columns, rows: draft.rows })}>
              {save.isPending ? "Saving…" : "Save table"}
            </Button>
            {draft.id ? (
              <Button design="Negative" disabled={remove.isPending} onClick={() => void confirmRemoveTable(draft.id!, draft.name)}>Delete</Button>
            ) : null}
          </div>

          <Card
            header={
              <CardHeader titleText="Columns" subtitleText="The first column is the lookup key."
                action={
                  <Button icon="add" onClick={() =>
                    setDraft({ ...draft, columns: [...draft.columns, { key: `col${draft.columns.length + 1}`, label: "", type: "string" }], rows: draft.rows.map((r) => [...r, null]) })}>
                    Add column
                  </Button>
                } />
            }>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 9rem 2.5rem", gap: "0.5rem", alignItems: "center", padding: "1rem" }}>
              <Label>Key</Label><Label>Label</Label><Label>Type</Label><span />
              {draft.columns.map((c, i) => (
                <Fragment key={i}>
                  <Input placeholder="key" value={c.key} onInput={(e) => setDraft({ ...draft, columns: draft.columns.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })} />
                  <Input placeholder="label" value={c.label} onInput={(e) => setDraft({ ...draft, columns: draft.columns.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
                  <Select value={c.type} onChange={(e) => setDraft({ ...draft, columns: draft.columns.map((x, j) => (j === i ? { ...x, type: (e.detail.selectedOption as HTMLElement).dataset.v as Col["type"] } : x)) })}>
                    {(["string", "number", "boolean"] as const).map((t) => <Option key={t} value={t} data-v={t}>{t}</Option>)}
                  </Select>
                  <Button icon="delete" design="Transparent" tooltip="Remove column" onClick={() =>
                    setDraft({ ...draft, columns: draft.columns.filter((_, j) => j !== i), rows: draft.rows.map((r) => r.filter((_, j) => j !== i)) })} />
                </Fragment>
              ))}
            </div>
          </Card>

          <Card
            header={
              <CardHeader titleText="Rows" subtitleText="Paste cells straight from a spreadsheet anywhere in the grid."
                additionalText={`${draft.rows.length} rows`}
                action={
                  <Button icon="add" onClick={() => setDraft({ ...draft, rows: [...draft.rows, draft.columns.map(() => null as Cell)] })}>
                    Add row
                  </Button>
                } />
            }>
            <div style={{ padding: "1rem" }} onPaste={(e) => { e.preventDefault(); pasteRows(e.clipboardData.getData("text")); }}>
              <Table noDataText="No rows yet — add one, or paste from a spreadsheet." rowActionCount={1}
                onRowActionClick={(e) => {
                  const i = Number(((e.detail.row as unknown) as HTMLElement).dataset.idx);
                  setDraft({ ...draft, rows: draft.rows.filter((_, j) => j !== i) });
                }}
                headerRow={
                  <TableHeaderRow>
                    {draft.columns.map((c) => <TableHeaderCell key={c.key}><span>{c.key}</span></TableHeaderCell>)}
                  </TableHeaderRow>
                }>
                {draft.rows.map((row, ri) => (
                  <TableRow key={ri} rowKey={`row-${ri}`} data-idx={String(ri)} actions={<TableRowAction icon="delete" text="Delete" />}>
                    {draft.columns.map((c, ci) => (
                      <TableCell key={ci}>
                        <Input value={String(row[ci] ?? "")} onInput={(e) =>
                          setDraft({ ...draft, rows: draft.rows.map((r, j) => (j === ri ? r.map((cell, cj) => (cj === ci ? typed(c, e.target.value) : cell)) : r)) })} />
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
                <MessageStrip design="Information" hideCloseButton>
                  Queries are part of the model — edits here are saved with the model's Save button.
                </MessageStrip>
                <div style={{ display: "flex", gap: "0.75rem", alignItems: "end" }}>
                  <div style={{ flex: 1 }}>
                    <Label required>Name (referenced by parameter domains and LOOKUP)</Label>
                    <Input style={{ width: "100%" }} value={qt.name} onInput={(e) => setQt({ name: e.target.value })} />
                  </div>
                  <Button design="Negative" onClick={() => void confirmRemoveQuery(qt.name, () => {
                    update((d) => ({ ...d, queryTables: d.queryTables.filter((_, i) => i !== qIdx) }));
                    setQIdx(null);
                  })}>Delete</Button>
                </div>

                <QueryCard key={qIdx} target={qt.target} path={qt.path} columns={qt.columns} onChange={setQt} />

                <Text>
                  {qt.columns.length
                    ? `Columns (from the response): ${qt.columns.join(", ")} — key = ${qt.columns[0]}${qt.columns[1] ? `, label = ${qt.columns[1]}` : ""}.`
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
