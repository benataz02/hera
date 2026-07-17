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
const BODY = { display: "flex", flexDirection: "column", gap: "0.75rem", padding: "1rem" } as const;

// Test fetch *is* the column definition: the response's field names become the query's columns.
export function QueryCard({ target, path, columns, onChange, title = "Query", headerActions, children }: Query & {
  onChange: (patch: Partial<Query>) => void;
  title?: string;
  headerActions?: ReactNode;
  children?: ReactNode;
}) {
  const [state, setState] = useState<{ busy?: boolean; cols?: string[]; rows?: Cell[][]; error?: string }>({});
  const [open, setOpen] = useState(false);

  return (
    <Card
      header={
        <CardHeader
          titleText={title}
          subtitleText="An OData path or a SQLQueries call — Test fetch takes the columns from the response."
          action={
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <Select value={target}
                onChange={(e) => onChange({ target: (e.detail.selectedOption as HTMLElement).dataset.v as Query["target"] })}>
                <Option value="b1" data-v="b1">B1</Option>
                <Option value="beas" data-v="beas">Beas</Option>
              </Select>
              {headerActions}
            </div>
          }
        />
      }>
      <div style={BODY}>
        <TextArea growing growingMaxRows={6} rows={2} style={MONO} value={path}
          placeholder="/Items?$select=ItemCode,ItemName&$top=50"
          onInput={(e) => onChange({ path: e.target.value })} />

        <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
          <Button icon="show" disabled={state.busy || !path}
            onClick={async () => {
              setState({ busy: true });
              try {
                const r = await client.models.queryPreview({ target, path });
                onChange({ columns: r.columns });
                setState({ cols: r.columns, rows: r.rows as Cell[][] });
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
    </Card>
  );
}
