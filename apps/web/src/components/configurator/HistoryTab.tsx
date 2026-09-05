import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, Form, FormGroup, FormItem, Input, Label, MessageStrip, MultiComboBox, MultiComboBoxItem,
  ObjectStatus, Option, Select, StepInput, Table, TableCell, TableHeaderCell,
  TableHeaderRow, TableRow, TableRowAction, Text, TextArea,
} from "@ui5/webcomponents-react";
import type { Issue, ModelDef, QuerySource, Val } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";
import { issueFor } from "./useDraftModel.ts";

type Update = (fn: (d: ModelDef) => ModelDef) => void;
type History = NonNullable<ModelDef["history"]>;
const EMPTY: History = { mappings: [], display: [] };

// Label span matches SettingsTab; one column so query/table groups aren't squeezed side-by-side.
const FORM = { labelSpan: "S12 M4", layout: "S1 M1 L1 XL1", accessibleMode: "Edit" } as const;

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
  const [preview, setPreview] = useState<{ cols: string[]; rows: Val[][] } | null>(null);
  const h = draft.history ?? EMPTY;
  const setH = (patch: Partial<History>) => update((d) => ({ ...d, history: { ...EMPTY, ...d.history, ...patch } }));
  const cols = h.query?.columns ?? [];
  const testFetch = useMutation(orpc.masterdata.queryPage.mutationOptions({
    onSuccess: (r) => {
      setH({ query: { ...h.query!, columns: r.columns } });
      setPreview({ cols: r.columns, rows: r.rows.slice(0, 10) });
    },
    onError: () => setPreview(null),
  }));

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

  return (
    <div style={{ padding: "1rem" }}>
      <Form {...FORM}>
        <FormGroup headerText="1 · Exact help — past documents">
          <FormItem>
            <MessageStrip design="Information" hideCloseButton>
              The customer comes from the configuration project itself; only the item code needs a parameter.
            </MessageStrip>
          </FormItem>
          <FormItem labelContent={<Label>Parameter holding the SAP item code</Label>}>
            <Select
              value={h.itemCodeParam ?? ""}
              {...vs(errMsg("history.itemCodeParam"))}
              onChange={(e) => setH({ itemCodeParam: e.detail.selectedOption.value || undefined })}>
              <Option value="">—</Option>
              {draft.parameters.map((p) => <Option key={p.key} value={p.key}>{p.label} ({p.key})</Option>)}
            </Select>
          </FormItem>
        </FormGroup>

        <FormGroup headerText="2 · History query — similar configurations">
          {h.query ? (
            <>
              <FormItem>
                <Button design="Negative" onClick={() => { setPreview(null); setH({ query: undefined, mappings: [], display: [] }); }}>
                  Remove query
                </Button>
              </FormItem>
              <FormItem labelContent={<Label>Source</Label>}>
                <Select value={h.query.target}
                  onChange={(e) => setH({ query: { ...h.query!, target: (e.detail.selectedOption as HTMLElement).dataset.v as QuerySource["target"] } })}>
                  <Option value="b1" data-v="b1" selected={h.query.target === "b1"}>B1</Option>
                  <Option value="beas" data-v="beas" selected={h.query.target === "beas"}>Beas</Option>
                </Select>
              </FormItem>
              <FormItem labelContent={<Label required>Entity set</Label>}>
                <Input value={h.query.query.entitySet} placeholder="Items"
                  onInput={(e) => setH({ query: { ...h.query!, query: { ...h.query!.query, entitySet: e.target.value.trim() } } })} />
              </FormItem>
              <FormItem labelContent={<Label>Select</Label>}>
                <Input value={h.query.columns.join(", ")} placeholder="ItemCode, ItemName"
                  onChange={(e) => setH({ query: { ...h.query!, columns: [...new Set(e.target.value.split(/[,\s]+/).filter(Boolean))] } })} />
              </FormItem>
              <FormItem labelContent={<Label>Filter</Label>}>
                <TextArea growing growingMaxRows={4} rows={1} value={h.query.query.filter ?? ""}
                  placeholder="ItemType eq 'itItems' and Frozen eq 'tNO'"
                  onInput={(e) => setH({ query: { ...h.query!, query: { ...h.query!.query, filter: e.target.value || undefined } } })} />
              </FormItem>
              <FormItem labelContent={<Label>Sort</Label>}>
                <Input value={h.query.query.orderby ?? ""} placeholder="ItemName"
                  onInput={(e) => setH({ query: { ...h.query!, query: { ...h.query!.query, orderby: e.target.value || undefined } } })} />
              </FormItem>
              <FormItem>
                <Button icon="show" loading={testFetch.isPending} disabled={!h.query.query.entitySet}
                  onClick={() => testFetch.mutate({ target: h.query!.target, query: h.query!.query, columns: h.query!.columns })}>
                  Test fetch
                </Button>
              </FormItem>
              {testFetch.error ? <FormItem><MessageStrip design="Negative" hideCloseButton>{testFetch.error.message}</MessageStrip></FormItem> : null}
              {preview ? (
                <FormItem>
                  <Table noDataText="No rows returned."
                    headerRow={
                      <TableHeaderRow>
                        {preview.cols.map((c) => <TableHeaderCell key={c}><span>{c}</span></TableHeaderCell>)}
                      </TableHeaderRow>
                    }>
                    {preview.rows.map((row, ri) => (
                      <TableRow key={ri} rowKey={`q-${ri}`}>
                        {row.map((cell, ci) => <TableCell key={ci}><Text>{String(cell ?? "")}</Text></TableCell>)}
                      </TableRow>
                    ))}
                  </Table>
                </FormItem>
              ) : null}
              {errMsg("history.query") ? <FormItem>{strip(errMsg("history.query"))}</FormItem> : null}
            </>
          ) : (
            <>
              <FormItem>
                <Button icon="add" onClick={() => setH({ query: { target: "b1", query: { entitySet: "" }, columns: [] } })}>
                  Add history query
                </Button>
              </FormItem>
              {errMsg("history.query") ? <FormItem>{strip(errMsg("history.query"))}</FormItem> : null}
            </>
          )}
        </FormGroup>

        <FormGroup headerText="3 · Parameter mappings">
          {h.query && !cols.length ? (
            <FormItem>
              <MessageStrip design="Information" hideCloseButton>Run Test fetch first — this needs the query's columns.</MessageStrip>
            </FormItem>
          ) : null}
          <FormItem>
            <Button icon="add" disabled={!cols.length || !draft.parameters.length}
              onClick={() => setH({ mappings: [...h.mappings, { param: draft.parameters[0]!.key, column: cols[0]!, match: "exact", weight: 1 }] })}>
              Add mapping
            </Button>
          </FormItem>
          <FormItem>
            <Table noDataText="No mappings — add one." rowActionCount={1}
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
                  <TableRow key={i} rowKey={`m-${i}`}
                    actions={<TableRowAction icon="delete" text="Delete" onClick={() => setH({ mappings: h.mappings.filter((_, j) => j !== i) })} />}>
                    <TableCell>
                      <Select value={m.param} onChange={(e) => setM({ param: e.detail.selectedOption.value })}>
                        {draft.parameters.map((p) => <Option key={p.key} value={p.key}>{p.key}</Option>)}
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Select value={m.column} onChange={(e) => setM({ column: e.detail.selectedOption.value })}>
                        {cols.map((c) => <Option key={c} value={c}>{c}</Option>)}
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Select value={m.match} onChange={(e) => setM({ match: e.detail.selectedOption.value as History["mappings"][number]["match"] })}>
                        {(["exact", "closeness", "contains"] as const).map((t) => <Option key={t} value={t}>{t}</Option>)}
                      </Select>
                    </TableCell>
                    <TableCell>
                      <StepInput value={m.weight} min={0.5} step={0.5} valuePrecision={1} onChange={(e) => setM({ weight: e.target.value ?? 1 })} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </Table>
          </FormItem>
          {h.mappings.map((_, i) => {
            const msg = errMsg(`history.mappings[${i}]`);
            return msg ? <FormItem key={`m-${i}`}>{strip(msg)}</FormItem> : null;
          })}
        </FormGroup>

        <FormGroup headerText="4 · Display columns">
          <FormItem labelContent={<Label>Columns shown on each result</Label>}>
            <MultiComboBox
              selectedValues={h.display}
              {...vs(h.display.map((_, i) => errMsg(`history.display[${i}]`)).find(Boolean))}
              onSelectionChange={(e) => setH({ display: e.detail.items.flatMap((i) => i.value ? [i.value] : []) })}>
              {cols.map((c) => <MultiComboBoxItem key={c} text={c} value={c} />)}
            </MultiComboBox>
          </FormItem>
        </FormGroup>

        <FormGroup headerText="5 · Data">
          {sync.error?.message ? <FormItem>{strip(sync.error.message)}</FormItem> : null}
          {!h.query ? (
            <FormItem>
              <MessageStrip design="Information" hideCloseButton>Add a history query first.</MessageStrip>
            </FormItem>
          ) : dirty ? (
            <FormItem>
              <MessageStrip design="Critical" hideCloseButton>Save the model first — sync runs the saved query.</MessageStrip>
            </FormItem>
          ) : null}
          {h.query && info.data ? (
            <>
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
            </>
          ) : null}
          {h.query ? (
            <FormItem>
              <Button icon="synchronize" loading={sync.isPending} disabled={dirty} onClick={() => sync.mutate({ id: modelId })}>
                Sync now
              </Button>
            </FormItem>
          ) : null}
        </FormGroup>
      </Form>
    </div>
  );
}
