import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, FlexBox, Form, FormGroup, FormItem, Label, MessageStrip, MultiComboBox, MultiComboBoxItem,
  ObjectPageSubSection, ObjectStatus, Option, Select, StepInput, Table, TableCell, TableHeaderCell,
  TableHeaderRow, TableRow, TableRowAction, Text,
} from "@ui5/webcomponents-react";
import type { Issue, ModelDef } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";
import { issueFor } from "./useDraftModel.ts";
import { QueryEditor } from "./QueryEditor.tsx";

type Update = (fn: (d: ModelDef) => ModelDef) => void;
type History = NonNullable<ModelDef["history"]>;
const EMPTY: History = { mappings: [], display: [] };

// Same geometry as SettingsTab so the builder's tabs line up.
const FORM = { labelSpan: "S12 M4", layout: "S1 M1 L2 XL2", accessibleMode: "Edit" } as const;

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

  const errMsg = (path: string) => issueFor(issues, path)?.message;
  const strip = (msg?: string, key?: string) =>
    msg ? <MessageStrip key={key} design="Negative" hideCloseButton>{msg}</MessageStrip> : null;
  // Field-level issues render on the field itself; valueStateMessage is a slot, so it needs an element.
  const vs = (msg?: string) => ({
    valueState: (msg ? "Negative" : "None") as "Negative" | "None",
    valueStateMessage: msg ? <div>{msg}</div> : undefined,
  });

  // Steps 3–5 need the query's columns; show what's missing rather than hiding the step.
  const needsFetch = !cols.length
    ? <MessageStrip design="Information" hideCloseButton>Run Test fetch in step 2 first — this needs the query's columns.</MessageStrip>
    : null;

  return (
    <>
      <ObjectPageSubSection id="history-exact" titleText="1 · Exact help — past documents">
        <FlexBox direction="Column" gap="1rem">
          <MessageStrip design="Information" hideCloseButton>
            The customer comes from the configuration project itself; only the item code needs a parameter.
          </MessageStrip>
          <Form {...FORM}>
            <FormGroup>
              <FormItem labelContent={<Label>Parameter holding the SAP item code</Label>}>
                <Select
                  value={h.itemCodeParam ?? ""}
                  {...vs(errMsg("history.itemCodeParam"))}
                  onChange={(e) => setH({ itemCodeParam: (e.detail.selectedOption as HTMLElement).dataset.k || undefined })}>
                  <Option value="" data-k="">—</Option>
                  {draft.parameters.map((p) => <Option key={p.key} value={p.key} data-k={p.key}>{p.label} ({p.key})</Option>)}
                </Select>
              </FormItem>
            </FormGroup>
          </Form>
        </FlexBox>
      </ObjectPageSubSection>

      <ObjectPageSubSection id="history-query" titleText="2 · History query — similar configurations"
        actions={h.query
          ? <Button design="Negative" onClick={() => setH({ query: undefined, mappings: [], display: [] })}>Remove</Button>
          : undefined}>
        {h.query ? (
          <QueryEditor
            target={h.query.target} path={h.query.path} columns={h.query.columns}
            onChange={(patch) => setH({ query: { ...h.query!, ...patch } })}>
            {strip(errMsg("history.query"))}
            <Text>
              {cols.length ? `Columns (from the response): ${cols.join(", ")}.` : "Run Test fetch to take the columns from the response."}
            </Text>
          </QueryEditor>
        ) : (
          <FlexBox direction="Column" gap="1rem" alignItems="Start">
            <Button icon="add" onClick={() => setH({ query: { target: "b1", path: "", columns: [] } })}>
              Add history query
            </Button>
            {strip(errMsg("history.query"))}
          </FlexBox>
        )}
      </ObjectPageSubSection>

      <ObjectPageSubSection id="history-mappings" titleText="3 · Parameter mappings"
        actions={
          <Button icon="add" disabled={!cols.length || !draft.parameters.length}
            onClick={() => setH({ mappings: [...h.mappings, { param: draft.parameters[0]!.key, column: cols[0]!, match: "exact", weight: 1 }] })}>
            Add mapping
          </Button>
        }>
        <FlexBox direction="Column" gap="1rem">
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
          {h.mappings.map((_, i) => strip(errMsg(`history.mappings[${i}]`), `m-${i}`))}
        </FlexBox>
      </ObjectPageSubSection>

      <ObjectPageSubSection id="history-display" titleText="4 · Display columns">
        <FlexBox direction="Column" gap="1rem">
          {needsFetch}
          <Form {...FORM}>
            <FormGroup>
              <FormItem labelContent={<Label>Columns shown on each result</Label>}>
                <MultiComboBox
                  {...vs(h.display.map((_, i) => errMsg(`history.display[${i}]`)).find(Boolean))}
                  onSelectionChange={(e) => setH({ display: e.detail.items.map((i) => (i as HTMLElement).getAttribute("text")!) })}>
                  {cols.map((c) => <MultiComboBoxItem key={c} text={c} selected={h.display.includes(c)} />)}
                </MultiComboBox>
              </FormItem>
            </FormGroup>
          </Form>
        </FlexBox>
      </ObjectPageSubSection>

      <ObjectPageSubSection id="history-data" titleText="5 · Data"
        actions={
          // `!h.query` keeps the old behaviour: no query, no sync.
          <Button icon="synchronize" disabled={sync.isPending || dirty || !h.query} onClick={() => sync.mutate({ id: modelId })}>
            {sync.isPending ? "Syncing…" : "Sync now"}
          </Button>
        }>
        <FlexBox direction="Column" gap="1rem">
          {strip(sync.error?.message)}
          {!h.query
            ? <MessageStrip design="Information" hideCloseButton>Add a history query in step 2 first.</MessageStrip>
            : dirty
            ? <MessageStrip design="Critical" hideCloseButton>Save the model first — sync runs the saved query.</MessageStrip>
            : null}
          {h.query && info.data ? (
            <Form labelSpan={FORM.labelSpan} layout={FORM.layout}>
              <FormGroup>
                <FormItem labelContent={<Label>Rows</Label>}>
                  <ObjectStatus state={info.data.count ? "Positive" : "None"}>{`${info.data.count}`}</ObjectStatus>
                </FormItem>
                <FormItem labelContent={<Label>Last synced</Label>}>
                  <Text>
                    {info.data.lastSyncedAt
                      ? `${new Date(info.data.lastSyncedAt).toLocaleString()} · refreshes hourly`
                      : "Never · refreshes hourly"}
                  </Text>
                </FormItem>
              </FormGroup>
            </Form>
          ) : null}
        </FlexBox>
      </ObjectPageSubSection>
    </>
  );
}
