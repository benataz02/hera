import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, Input, Label, MessageStrip, MultiComboBox, MultiComboBoxItem, Option, Select, StepInput,
  Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableRowAction, Text, Title,
} from "@ui5/webcomponents-react";
import type { Issue, ModelDef } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";
import { issueFor } from "./useDraftModel.ts";
import { QueryTestFetch } from "./TablesTab.tsx";

type Update = (fn: (d: ModelDef) => ModelDef) => void;
type History = NonNullable<ModelDef["history"]>;
const EMPTY: History = { mappings: [], display: [] };

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
    return i ? <MessageStrip design="Negative" hideCloseButton>{i.message}</MessageStrip> : null;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem", padding: "1rem", maxWidth: "56rem" }}>
      <Title level="H5">Exact help — past documents</Title>
      <div>
        <Label>Parameter holding the SAP item code</Label>
        <Select
          value={h.itemCodeParam ?? ""}
          onChange={(e) => setH({ itemCodeParam: (e.detail.selectedOption as HTMLElement).dataset.k || undefined })}>
          <Option value="" data-k="">—</Option>
          {draft.parameters.map((p) => <Option key={p.key} value={p.key} data-k={p.key}>{p.label} ({p.key})</Option>)}
        </Select>
        {err("history.itemCodeParam")}
      </div>
      <Text>The customer comes from the configuration project itself; only the item code needs a parameter.</Text>

      <Title level="H5">Similarity help — historic configurations</Title>
      {!h.query ? (
        <Button icon="add" style={{ alignSelf: "start" }}
          onClick={() => setH({ query: { target: "b1", path: "", columns: [] } })}>
          Add history query
        </Button>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "8rem 1fr auto", gap: "0.5rem" }}>
            <Select value={h.query.target}
              onChange={(e) => setH({ query: { ...h.query!, target: (e.detail.selectedOption as HTMLElement).dataset.v as "b1" | "beas" } })}>
              <Option value="b1" data-v="b1">B1</Option>
              <Option value="beas" data-v="beas">Beas</Option>
            </Select>
            <Input placeholder="/SQLQueries('cfg_history')/List or an OData path" value={h.query.path}
              onInput={(e) => setH({ query: { ...h.query!, path: e.target.value } })} />
            <Button design="Negative" onClick={() => setH({ query: undefined, mappings: [], display: [] })}>Remove</Button>
          </div>
          {err("history.query")}
          <Text>
            {cols.length
              ? `Columns (from the response): ${cols.join(", ")}.`
              : "Run Test fetch to take the columns from the response."}
          </Text>
          <QueryTestFetch qt={{ name: "history", ...h.query }} onColumns={(columns) => setH({ query: { ...h.query!, columns } })} />

          <Title level="H6">Parameter mappings</Title>
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
          <Button icon="add" style={{ alignSelf: "start" }} disabled={!cols.length || !draft.parameters.length}
            onClick={() => setH({ mappings: [...h.mappings, { param: draft.parameters[0]!.key, column: cols[0]!, match: "exact", weight: 1 }] })}>
            Add mapping
          </Button>

          <Title level="H6">Columns shown on each result</Title>
          <MultiComboBox
            onSelectionChange={(e) => setH({ display: e.detail.items.map((i) => (i as HTMLElement).getAttribute("text")!) })}>
            {cols.map((c) => <MultiComboBoxItem key={c} text={c} selected={h.display.includes(c)} />)}
          </MultiComboBox>
          {h.display.map((_, i) => err(`history.display[${i}]`))}

          <Title level="H6">Data</Title>
          {sync.error ? <MessageStrip design="Negative" hideCloseButton>{sync.error.message}</MessageStrip> : null}
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <Button icon="synchronize" disabled={sync.isPending || dirty} onClick={() => sync.mutate({ id: modelId })}>
              {sync.isPending ? "Syncing…" : "Sync now"}
            </Button>
            <Text>
              {dirty ? "Save the model first — sync runs the saved query."
                : info.data ? `${info.data.count} rows${info.data.lastSyncedAt ? ` · last synced ${new Date(info.data.lastSyncedAt).toLocaleString()}` : ""} · refreshes hourly`
                : ""}
            </Text>
          </div>
        </>
      )}
    </div>
  );
}
