import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, Card, CardHeader, Label, MessageStrip, MultiComboBox, MultiComboBoxItem, Option, Select,
  StepInput, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableRowAction, Tag, Text,
} from "@ui5/webcomponents-react";
import type { Issue, ModelDef } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";
import { issueFor } from "./useDraftModel.ts";
import { QueryCard } from "./QueryEditor.tsx";

type Update = (fn: (d: ModelDef) => ModelDef) => void;
type History = NonNullable<ModelDef["history"]>;
const EMPTY: History = { mappings: [], display: [] };

const BODY = { display: "flex", flexDirection: "column", gap: "0.75rem", padding: "1rem" } as const;

// Admin config for the process page's help pane: which param is the SAP ItemCode (exact help),
// the similarity query, param↔column mappings with match type + weight, and display columns.
export function HistoryTab({ draft, update, issues, modelId, dirty }: {
  draft: ModelDef;
  update: Update;
  issues: Issue[];
  modelId: string;
  dirty: boolean;
}) {
  const qc = useQueryClient();
  const h = draft.history ?? EMPTY;
  const setH = (patch: Partial<History>) => update((d) => ({ ...d, history: { ...EMPTY, ...d.history, ...patch } }));
  const cols = h.query?.columns ?? [];

  const info = useQuery(orpc.models.historyInfo.queryOptions({ input: { id: modelId } }));
  const sync = useMutation(orpc.models.syncHistory.mutationOptions({
    onSuccess: () => qc.invalidateQueries({ queryKey: orpc.models.historyInfo.queryOptions({ input: { id: modelId } }).queryKey }),
  }));

  const err = (path: string) => {
    const i = issueFor(issues, path);
    return i ? <MessageStrip key={path} design="Negative" hideCloseButton>{i.message}</MessageStrip> : null;
  };

  // Steps 3–5 need the query's columns; show what's missing rather than hiding the step.
  const needsFetch = !cols.length
    ? <MessageStrip design="Information" hideCloseButton>Run Test fetch in step 2 first — this needs the query's columns.</MessageStrip>
    : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem", padding: "1rem", maxWidth: "56rem" }}>
      <Card
        header={
          <CardHeader titleText="1 · Exact help — past documents"
            subtitleText="The customer comes from the configuration project itself; only the item code needs a parameter." />
        }>
        <div style={BODY}>
          <div>
            <Label>Parameter holding the SAP item code</Label>
            <Select
              value={h.itemCodeParam ?? ""}
              onChange={(e) => setH({ itemCodeParam: (e.detail.selectedOption as HTMLElement).dataset.k || undefined })}>
              <Option value="" data-k="">—</Option>
              {draft.parameters.map((p) => <Option key={p.key} value={p.key} data-k={p.key}>{p.label} ({p.key})</Option>)}
            </Select>
          </div>
          {err("history.itemCodeParam")}
        </div>
      </Card>

      {h.query ? (
        <QueryCard
          title="2 · History query — similar configurations"
          target={h.query.target} path={h.query.path} columns={h.query.columns}
          onChange={(patch) => setH({ query: { ...h.query!, ...patch } })}
          headerActions={
            <Button design="Negative" onClick={() => setH({ query: undefined, mappings: [], display: [] })}>Remove</Button>
          }>
          {err("history.query")}
          <Text>
            {cols.length ? `Columns (from the response): ${cols.join(", ")}.` : "Run Test fetch to take the columns from the response."}
          </Text>
        </QueryCard>
      ) : (
        <Card header={<CardHeader titleText="2 · History query — similar configurations" subtitleText="Where past configurations are read from." />}>
          <div style={BODY}>
            <Button icon="add" style={{ alignSelf: "start" }}
              onClick={() => setH({ query: { target: "b1", path: "", columns: [] } })}>
              Add history query
            </Button>
            {err("history.query")}
          </div>
        </Card>
      )}

      <Card
        header={
          <CardHeader titleText="3 · Parameter mappings" subtitleText="How this model's parameters line up with the query's columns."
            action={
              <Button icon="add" disabled={!cols.length || !draft.parameters.length}
                onClick={() => setH({ mappings: [...h.mappings, { param: draft.parameters[0]!.key, column: cols[0]!, match: "exact", weight: 1 }] })}>
                Add mapping
              </Button>
            } />
        }>
        <div style={BODY}>
          {needsFetch}
          <Table noDataText="No mappings — add one." rowActionCount={1}
            onRowActionClick={(e) => {
              const i = Number(((e.detail.row as unknown) as HTMLElement).dataset.idx);
              setH({ mappings: h.mappings.filter((_, j) => j !== i) });
            }}
            headerRow={
              <TableHeaderRow>
                <TableHeaderCell><span>Parameter</span></TableHeaderCell>
                <TableHeaderCell><span>Column</span></TableHeaderCell>
                <TableHeaderCell><span>Match</span></TableHeaderCell>
                <TableHeaderCell><span>Weight</span></TableHeaderCell>
              </TableHeaderRow>
            }>
            {h.mappings.map((m, i) => {
              const setM = (patch: Partial<History["mappings"][number]>) =>
                setH({ mappings: h.mappings.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
              return (
                <TableRow key={i} rowKey={`m-${i}`} data-idx={String(i)} actions={<TableRowAction icon="delete" text="Delete" />}>
                  <TableCell>
                    <Select value={m.param} onChange={(e) => setM({ param: (e.detail.selectedOption as HTMLElement).dataset.k! })}>
                      {draft.parameters.map((p) => <Option key={p.key} value={p.key} data-k={p.key}>{p.key}</Option>)}
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Select value={m.column} onChange={(e) => setM({ column: (e.detail.selectedOption as HTMLElement).dataset.c! })}>
                      {cols.map((c) => <Option key={c} value={c} data-c={c}>{c}</Option>)}
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Select value={m.match} onChange={(e) => setM({ match: (e.detail.selectedOption as HTMLElement).dataset.v as History["mappings"][number]["match"] })}>
                      {(["exact", "closeness", "contains"] as const).map((t) => <Option key={t} value={t} data-v={t}>{t}</Option>)}
                    </Select>
                  </TableCell>
                  <TableCell>
                    <StepInput value={m.weight} min={0.5} step={0.5} onChange={(e) => setM({ weight: e.target.value ?? 1 })} />
                  </TableCell>
                </TableRow>
              );
            })}
          </Table>
          {h.mappings.map((_, i) => err(`history.mappings[${i}]`))}
        </div>
      </Card>

      <Card header={<CardHeader titleText="4 · Display columns" subtitleText="Shown on each result in the help pane." />}>
        <div style={BODY}>
          {needsFetch}
          <div>
            <Label>Columns shown on each result</Label>
            <MultiComboBox style={{ width: "100%" }}
              onSelectionChange={(e) => setH({ display: e.detail.items.map((i) => (i as HTMLElement).getAttribute("text")!) })}>
              {cols.map((c) => <MultiComboBoxItem key={c} text={c} selected={h.display.includes(c)} />)}
            </MultiComboBox>
          </div>
          {h.display.map((_, i) => err(`history.display[${i}]`))}
        </div>
      </Card>

      <Card
        header={
          <CardHeader titleText="5 · Data" subtitleText="The synced snapshot the help pane searches."
            action={
              // `!h.query` keeps the old behaviour now the card is always mounted: no query, no sync.
              <Button icon="synchronize" disabled={sync.isPending || dirty || !h.query} onClick={() => sync.mutate({ id: modelId })}>
                {sync.isPending ? "Syncing…" : "Sync now"}
              </Button>
            } />
        }>
        <div style={BODY}>
          {sync.error ? <MessageStrip design="Negative" hideCloseButton>{sync.error.message}</MessageStrip> : null}
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            {h.query && info.data ? <Tag design={info.data.count ? "Positive" : "Neutral"}>{`${info.data.count} rows`}</Tag> : null}
            <Text>
              {!h.query ? "Add a history query in step 2 first."
                : dirty ? "Save the model first — sync runs the saved query."
                : info.data ? `${info.data.lastSyncedAt ? `Last synced ${new Date(info.data.lastSyncedAt).toLocaleString()} · ` : ""}refreshes hourly`
                : ""}
            </Text>
          </div>
        </div>
      </Card>
    </div>
  );
}
