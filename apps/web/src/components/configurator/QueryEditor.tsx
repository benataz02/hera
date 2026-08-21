import { useState, type ReactNode } from "react";
import {
  Button, Card, CardHeader, MessageStrip, Option, Panel, Select, Table, TableCell, TableHeaderCell,
  TableHeaderRow, TableRow, Tag, Text, TextArea,
} from "@ui5/webcomponents-react";
import type { Val } from "@hera/config-engine";
import { client } from "../../orpc.ts";

type Cell = Exclude<Val, string[]>;
export type Query = { target: "b1" | "beas"; path: string; columns: string[] };

// The inner textarea is `font-family: inherit`, so styling the host reaches it — no ::part needed.
// Horizon has no mono theme param (only sapFontFamily/Light/Bold/…), hence the literal stack.
const MONO = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" };
const BODY = { display: "flex", flexDirection: "column", gap: "0.75rem" } as const;

// Test fetch *is* the column definition: the response's field names become the query's columns.
// Body only — the caller supplies the container (a Card here, an ObjectPageSubSection in HistoryTab).
export function QueryEditor({ target, path, columns, onChange, children }: Query & {
  onChange: (patch: Partial<Query>) => void;
  children?: ReactNode;
}) {
  const [state, setState] = useState<{ busy?: boolean; cols?: string[]; rows?: Cell[][]; error?: string }>({});
  const [open, setOpen] = useState(false);

  return (
    <div style={BODY}>
      <TextArea growing growingMaxRows={6} rows={2} style={MONO} value={path}
        placeholder="/Items?$select=ItemCode,ItemName&$top=50"
        onInput={(e) => onChange({ path: e.target.value })} />

      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
        <Select value={target}
          onChange={(e) => onChange({ target: (e.detail.selectedOption as HTMLElement).dataset.v as Query["target"] })}>
          <Option value="b1" data-v="b1">B1</Option>
          <Option value="beas" data-v="beas">Beas</Option>
        </Select>
        <Button icon="show" disabled={state.busy || !path}
          onClick={async () => {
            setState({ busy: true });
            try {
              const r = await client.models.queryPage({ target, path });
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
          subtitleText="An OData path or a SQLQueries call — Test fetch takes the columns from the response." />
      }>
      <div style={{ padding: "1rem" }}><QueryEditor {...props} /></div>
    </Card>
  );
}
