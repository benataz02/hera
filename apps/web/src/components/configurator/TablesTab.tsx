import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar, Button, BusyIndicator, Input, Label, List, ListItemStandard, MessageStrip, Option, Select,
  Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableRowAction, Text, Title,
} from "@ui5/webcomponents-react";
import type { ModelDef, Val } from "@hera/config-engine";
import { client, orpc } from "../../orpc.ts";

type Col = { key: string; label: string; type: "string" | "number" | "boolean" };
// config_table cells are scalar (ValZ), unlike the full Val union which includes string[].
type Cell = Exclude<Val, string[]>;
type Draft = { id?: string; name: string; columns: Col[]; rows: Cell[][] };

type Update = (fn: (d: ModelDef) => ModelDef) => void;

const empty = (): Draft => ({ name: "", columns: [{ key: "key", label: "Key", type: "string" }], rows: [] });

export function TablesTab({ draft: model, update }: { draft: ModelDef; update: Update }) {
  const qc = useQueryClient();
  const listQ = useQuery(orpc.models.tables.list.queryOptions());
  const invalidate = () => qc.invalidateQueries({ queryKey: orpc.models.tables.list.queryOptions().queryKey });
  const [draft, setDraft] = useState<Draft | null>(null); // tenant-table editor (existing)
  const [qIdx, setQIdx] = useState<number | null>(null); // queryTables editor

  const save = useMutation(orpc.models.tables.save.mutationOptions({ onSuccess: invalidate }));
  const remove = useMutation(
    orpc.models.tables.remove.mutationOptions({
      onSuccess: () => {
        invalidate();
        setDraft(null);
      },
    }),
  );

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

  return (
    <div style={{ display: "flex", gap: "1rem", padding: "1rem", alignItems: "flex-start" }}>
      <div style={{ width: "16rem", flexShrink: 0 }}>
        <Bar design="Subheader" startContent={<Title level="H5">Lookup tables</Title>}
          endContent={<Button icon="add" onClick={() => setDraft(empty())} tooltip="New table" />} />
        <List
          onItemClick={(e) => {
            const id = (e.detail.item as HTMLElement).dataset.id!;
            const t = (listQ.data ?? []).find((x) => x.id === id);
            if (t) setDraft({ id: t.id, name: t.name, columns: t.columns as Col[], rows: t.rows as Cell[][] });
            setQIdx(null);
          }}>
          {(listQ.data ?? []).map((t) => (
            <ListItemStandard key={t.id} data-id={t.id} additionalText={`${(t.rows as Val[][]).length} rows`}>{t.name}</ListItemStandard>
          ))}
        </List>

        <Bar design="Subheader" startContent={<Title level="H5">Queries (this model)</Title>}
          endContent={
            <Button icon="add" tooltip="New query" onClick={() => {
              update((d) => ({
                ...d,
                queryTables: [...d.queryTables, { name: `query${d.queryTables.length + 1}`, target: "b1", path: "", columns: [] }],
              }));
              setQIdx(model.queryTables.length);
              setDraft(null);
            }} />
          } />
        <List onItemClick={(e) => {
          setQIdx(Number((e.detail.item as HTMLElement).dataset.idx));
          setDraft(null);
        }}>
          {model.queryTables.map((qt, i) => (
            <ListItemStandard key={i} data-idx={String(i)} additionalText={qt.target}>{qt.name}</ListItemStandard>
          ))}
        </List>
      </div>

      {draft ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {save.error ? <MessageStrip design="Negative" hideCloseButton>{save.error.message}</MessageStrip> : null}
          {save.isSuccess ? <MessageStrip design="Positive" hideCloseButton>Saved.</MessageStrip> : null}
          <div style={{ display: "flex", gap: "0.75rem", alignItems: "end" }}>
            <div style={{ flex: 1 }}>
              <Label required>Name (referenced by LOOKUP and table domains)</Label>
              <Input value={draft.name} onInput={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <Button design="Emphasized" disabled={!draft.name.trim() || !draft.columns.length || save.isPending}
              onClick={() => save.mutate({ id: draft.id, name: draft.name.trim(), columns: draft.columns, rows: draft.rows })}>
              {save.isPending ? "Saving…" : "Save table"}
            </Button>
            {draft.id ? (
              <Button design="Negative" disabled={remove.isPending} onClick={() => remove.mutate({ id: draft.id! })}>Delete</Button>
            ) : null}
          </div>

          <Title level="H6">Columns</Title>
          {draft.columns.map((c, i) => (
            <div key={i} style={{ display: "flex", gap: "0.5rem" }}>
              <Input placeholder="key" value={c.key} onInput={(e) => setDraft({ ...draft, columns: draft.columns.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })} />
              <Input placeholder="label" value={c.label} onInput={(e) => setDraft({ ...draft, columns: draft.columns.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
              <Select value={c.type} onChange={(e) => setDraft({ ...draft, columns: draft.columns.map((x, j) => (j === i ? { ...x, type: (e.detail.selectedOption as HTMLElement).dataset.v as Col["type"] } : x)) })}>
                {(["string", "number", "boolean"] as const).map((t) => <Option key={t} value={t} data-v={t}>{t}</Option>)}
              </Select>
              <Button icon="delete" design="Transparent" onClick={() =>
                setDraft({ ...draft, columns: draft.columns.filter((_, j) => j !== i), rows: draft.rows.map((r) => r.filter((_, j) => j !== i)) })} />
            </div>
          ))}
          <Button icon="add" style={{ alignSelf: "start" }} onClick={() =>
            setDraft({ ...draft, columns: [...draft.columns, { key: `col${draft.columns.length + 1}`, label: "", type: "string" }], rows: draft.rows.map((r) => [...r, null]) })}>
            Add column
          </Button>

          <Title level="H6">Rows</Title>
          <Text>Tip: paste cells from a spreadsheet anywhere in the grid below.</Text>
          <div onPaste={(e) => { e.preventDefault(); pasteRows(e.clipboardData.getData("text")); }}>
            <Table noDataText="No rows — add one or paste from a spreadsheet." rowActionCount={1}
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
          <Button icon="add" style={{ alignSelf: "start" }}
            onClick={() => setDraft({ ...draft, rows: [...draft.rows, draft.columns.map(() => null as Cell)] })}>Add row</Button>
        </div>
      ) : qIdx !== null && model.queryTables[qIdx] ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {(() => {
            const qt = model.queryTables[qIdx]!;
            const setQt = (patch: Partial<ModelDef["queryTables"][number]>) =>
              update((d) => ({ ...d, queryTables: d.queryTables.map((q, i) => (i === qIdx ? { ...q, ...patch } : q)) }));
            return (
              <>
                <div style={{ display: "flex", gap: "0.75rem", alignItems: "end" }}>
                  <div style={{ flex: 1 }}>
                    <Label required>Name (referenced by parameter domains and LOOKUP)</Label>
                    <Input value={qt.name} onInput={(e) => setQt({ name: e.target.value })} />
                  </div>
                  <Button design="Negative" onClick={() => {
                    update((d) => ({ ...d, queryTables: d.queryTables.filter((_, i) => i !== qIdx) }));
                    setQIdx(null);
                  }}>Delete</Button>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "8rem 1fr", gap: "0.5rem" }}>
                  <Select value={qt.target} onChange={(e) => setQt({ target: (e.detail.selectedOption as HTMLElement).dataset.v as "b1" | "beas" })}>
                    <Option value="b1" data-v="b1">B1</Option>
                    <Option value="beas" data-v="beas">Beas</Option>
                  </Select>
                  <Input placeholder="/Items?$select=ItemCode,ItemName" value={qt.path}
                    onInput={(e) => setQt({ path: e.target.value })} />
                </div>
                <Text>
                  {qt.columns.length
                    ? `Columns (from the response): ${qt.columns.join(", ")} — key = ${qt.columns[0]}${qt.columns[1] ? `, label = ${qt.columns[1]}` : ""}.`
                    : "Run Test fetch to take the columns from the response."}
                </Text>
                <QueryTestFetch key={qIdx} qt={qt} onColumns={(columns) => setQt({ columns })} />
              </>
            );
          })()}
        </div>
      ) : (
        <Text style={{ marginTop: "2rem" }}>Select a table or create a new one.</Text>
      )}
    </div>
  );
}

// Test fetch *is* the column definition: the response's field names become the query's columns.
function QueryTestFetch({ qt, onColumns }: {
  qt: ModelDef["queryTables"][number];
  onColumns: (columns: string[]) => void;
}) {
  const [state, setState] = useState<{ busy?: boolean; cols?: string[]; rows?: Cell[][]; error?: string }>({});
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <Button icon="show" style={{ alignSelf: "start" }} disabled={state.busy || !qt.path}
        onClick={async () => {
          setState({ busy: true });
          try {
            const r = await client.models.queryPreview({ target: qt.target, path: qt.path });
            onColumns(r.columns);
            setState({ cols: r.columns, rows: r.rows as Cell[][] });
          } catch (e) {
            setState({ error: e instanceof Error ? e.message : String(e) });
          }
        }}>
        {state.busy ? "Loading…" : "Test fetch"}
      </Button>
      {state.error ? <MessageStrip design="Negative" hideCloseButton>{state.error}</MessageStrip> : null}
      {state.rows?.length ? (
        <Table noDataText="No rows returned."
          headerRow={<TableHeaderRow>{state.cols!.map((c) => <TableHeaderCell key={c}><span>{c}</span></TableHeaderCell>)}</TableHeaderRow>}>
          {state.rows.map((row, ri) => (
            <TableRow key={ri} rowKey={`q-${ri}`}>
              {row.map((cell, ci) => <TableCell key={ci}><Text>{String(cell ?? "")}</Text></TableCell>)}
            </TableRow>
          ))}
        </Table>
      ) : state.rows ? <Text>No rows returned.</Text> : null}
    </div>
  );
}
