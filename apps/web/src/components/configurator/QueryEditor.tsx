import { useState, type ReactNode } from "react";
import {
  Button, Card, CardHeader, Input, Label, MessageStrip, Option, Panel, Select, Table, TableCell,
  TableHeaderCell, TableHeaderRow, TableRow, Tag, Text, TextArea,
} from "@ui5/webcomponents-react";
import type { ODataQuery, QuerySource, Val } from "@hera/config-engine";
import { client } from "../../orpc.ts";

type Cell = Exclude<Val, string[]>;
export type Query = QuerySource;

// The inner textarea is `font-family: inherit`, so styling the host reaches it — no ::part needed.
// Horizon has no mono theme param (only sapFontFamily/Light/Bold/…), hence the literal stack.
const MONO = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" };
const BODY = { display: "flex", flexDirection: "column", gap: "0.75rem" } as const;
const ROW = { display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" } as const;
const FIELD = { display: "flex", flexDirection: "column", gap: "0.25rem" } as const;

// Test fetch *is* the column definition: the response's field names become the query's columns.
// A query is fields, not a URL string: $select comes from `columns` and the path is built on the
// server (packages/b1/src/query.ts), so nothing typed here can become an arbitrary OData call.
// Body only — the caller supplies the container (a Card on Tables, a padded column on History).
export function QueryEditor({ target, query, columns, onChange, children }: Query & {
  onChange: (patch: Partial<Query>) => void;
  children?: ReactNode;
}) {
  const [state, setState] = useState<{ busy?: boolean; cols?: string[]; rows?: Cell[][]; error?: string }>({});
  const [open, setOpen] = useState(false);
  const setQ = (patch: Partial<ODataQuery>) => onChange({ query: { ...query, ...patch } });

  return (
    <div style={BODY}>
      <div style={ROW}>
        <div style={FIELD}>
          <Label required>Entity set</Label>
          <Input value={query.entitySet} placeholder="Items" style={MONO}
            onInput={(e) => setQ({ entitySet: e.target.value.trim() })} />
        </div>
        <div style={FIELD}>
          <Label>Order by</Label>
          <Input value={query.orderby ?? ""} placeholder="ItemName" style={MONO}
            onInput={(e) => setQ({ orderby: e.target.value || undefined })} />
        </div>
        <div style={FIELD}>
          <Label>Rows per page</Label>
          <Input type="Number" value={query.top === undefined ? "" : String(query.top)} placeholder="100"
            onInput={(e) => {
              const n = Number(e.target.value);
              setQ({ top: Number.isInteger(n) && n > 0 ? n : undefined });
            }} />
        </div>
        <div style={FIELD}>
          <Label>Source</Label>
          <Select value={target}
            onChange={(e) => onChange({ target: (e.detail.selectedOption as HTMLElement).dataset.v as Query["target"] })}>
            <Option value="b1" data-v="b1">B1</Option>
            <Option value="beas" data-v="beas">Beas</Option>
          </Select>
        </div>
      </div>

      <div style={FIELD}>
        <Label>Filter</Label>
        <TextArea growing growingMaxRows={4} rows={1} style={MONO} value={query.filter ?? ""}
          placeholder="ItemType eq 'itItems' and Frozen eq 'tNO'"
          onInput={(e) => setQ({ filter: e.target.value || undefined })} />
      </div>

      <div style={ROW}>
        <Button icon="show" disabled={state.busy || !query.entitySet}
          onClick={async () => {
            setState({ busy: true });
            try {
              const r = await client.models.queryPage({ target, query });
              onChange({ columns: r.columns });
              setState({ cols: r.columns, rows: r.rows.slice(0, 10) as Cell[][] });
            } catch (e) {
              setState({ error: e instanceof Error ? e.message : String(e) });
            }
          }}>
          {state.busy ? "Loading…" : "Test fetch"}
        </Button>
        {columns.length
          ? <Tag design="Positive">{`${columns.length} columns`}</Tag>
          : <Tag design="Neutral">No columns yet</Tag>}
      </div>

      {state.error ? <MessageStrip design="Negative" hideCloseButton>{state.error}</MessageStrip> : null}

      {state.rows?.length ? (
        <Panel headerText={`Preview — ${state.rows.length} rows`} collapsed={!open} onToggle={() => setOpen((o) => !o)}>
          <Table
            headerRow={
              <TableHeaderRow>
                {state.cols!.map((c) => <TableHeaderCell key={c}><span>{c}</span></TableHeaderCell>)}
              </TableHeaderRow>
            }>
            {state.rows.map((row, ri) => (
              <TableRow key={ri} rowKey={`q-${ri}`}>
                {row.map((cell, ci) => <TableCell key={ci}><Text>{String(cell ?? "")}</Text></TableCell>)}
              </TableRow>
            ))}
          </Table>
        </Panel>
      ) : state.rows ? <Text>No rows returned.</Text> : null}

      {children}
    </div>
  );
}

export function QueryCard(props: Parameters<typeof QueryEditor>[0]) {
  return (
    <Card
      header={
        <CardHeader titleText="Query"
          subtitleText="An entity set with an optional filter — Test fetch takes the columns from the response." />
      }>
      <div style={{ padding: "1rem" }}><QueryEditor {...props} /></div>
    </Card>
  );
}

export const emptyQuery = (): ODataQuery => ({ entitySet: "" });
