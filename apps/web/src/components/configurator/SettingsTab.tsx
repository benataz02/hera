import { useState } from "react";
import { Button, Form, FormGroup, FormItem, Input, Label, Option, Select, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableRowAction, Text, TextArea } from "@ui5/webcomponents-react";
import type { Issue, ModelDef } from "@hera/config-engine";
import { ExprInput } from "./ExprInput.tsx";
import { issueFor } from "./useDraftModel.ts";

export function SettingsTab({ draft, update, issues }: {
  draft: ModelDef;
  update: (fn: (d: ModelDef) => ModelDef) => void;
  issues: Issue[];
}) {
  // Batches edited as CSV; parse on change, ignore junk. // ponytail: token editor if CSV annoys
  const [batchText, setBatchText] = useState(draft.batchDefaults.join(", "));
  const setBatches = (text: string) => {
    setBatchText(text);
    const nums = text.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
    update((d) => ({ ...d, batchDefaults: nums }));
  };

  const setQt = (i: number, patch: Partial<ModelDef["queryTables"][number]>) =>
    update((d) => ({ ...d, queryTables: d.queryTables.map((q, j) => (j === i ? { ...q, ...patch } : q)) }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem", padding: "1rem" }}>
      <Form labelSpan="S12 M4" layout="S1 M1 L2 XL2">
        <FormGroup headerText="Model">
          <FormItem labelContent={<Label required>Name</Label>}>
            <Input value={draft.name} onInput={(e) => update((d) => ({ ...d, name: e.target.value }))} />
          </FormItem>
          <FormItem labelContent={<Label>Default batch sizes</Label>}>
            <Input value={batchText} placeholder="1, 10, 100" onInput={(e) => setBatches(e.target.value)}
              valueState={draft.batchDefaults.length ? "None" : "Negative"}
              valueStateMessage={<div>At least one positive integer batch size</div>} />
          </FormItem>
          <FormItem labelContent={<Label>Extraction context</Label>}>
            <TextArea value={draft.extraction?.context ?? ""} rows={3}
              placeholder="Drawing conventions the AI should know (units, title-block layout, notation)…"
              onInput={(e) =>
                update((d) => ({ ...d, extraction: e.target.value ? { context: e.target.value } : undefined }))} />
          </FormItem>
        </FormGroup>
        <FormGroup headerText="Pricing">
          <FormItem labelContent={<Label required>Unit price expression</Label>}>
            <ExprInput value={draft.pricing.priceExpr} model={draft} extraVars={["qty", "unitCost"]}
              fieldId="expr-pricing.priceExpr" issue={issueFor(issues, "pricing.priceExpr")}
              onChange={(v) => update((d) => ({ ...d, pricing: { ...d.pricing, priceExpr: v ?? "" } }))} />
          </FormItem>
          <FormItem labelContent={<Label required>Quote item code</Label>}>
            <Input value={draft.pricing.quoteItemCode}
              valueState={draft.pricing.quoteItemCode ? "None" : "Negative"}
              onInput={(e) => update((d) => ({ ...d, pricing: { ...d.pricing, quoteItemCode: e.target.value } }))} />
          </FormItem>
        </FormGroup>
      </Form>

      <Text>Query tables — B1/Beas datasets snapshotted for LOOKUP() and table domains.</Text>
      <Table
        noDataText="No query tables. Add one to pull rows from B1 or Beas."
        rowActionCount={1}
        onRowActionClick={(e) => {
          const i = Number(((e.detail.row as unknown) as HTMLElement).dataset.idx);
          update((d) => ({ ...d, queryTables: d.queryTables.filter((_, j) => j !== i) }));
        }}
        headerRow={
          <TableHeaderRow>
            <TableHeaderCell><span>Name</span></TableHeaderCell>
            <TableHeaderCell><span>Target</span></TableHeaderCell>
            <TableHeaderCell width="40%"><span>Path</span></TableHeaderCell>
            <TableHeaderCell><span>Columns (CSV)</span></TableHeaderCell>
          </TableHeaderRow>
        }
      >
        {draft.queryTables.map((q, i) => (
          <TableRow key={i} rowKey={`qt-${i}`} data-idx={String(i)} actions={<TableRowAction icon="delete" text="Delete" />}>
            <TableCell><Input value={q.name} onInput={(e) => setQt(i, { name: e.target.value })} /></TableCell>
            <TableCell>
              <Select value={q.target} onChange={(e) => setQt(i, { target: (e.detail.selectedOption as HTMLElement).dataset.v as "b1" | "beas" })}>
                <Option value="b1" data-v="b1">B1</Option>
                <Option value="beas" data-v="beas">Beas</Option>
              </Select>
            </TableCell>
            <TableCell><Input value={q.path} placeholder="/Items?$select=ItemCode,ItemName" onInput={(e) => setQt(i, { path: e.target.value })} /></TableCell>
            <TableCell><Input value={q.columns.join(", ")} onInput={(e) => setQt(i, { columns: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} /></TableCell>
          </TableRow>
        ))}
      </Table>
      <Button icon="add" style={{ alignSelf: "start" }}
        onClick={() => update((d) => ({ ...d, queryTables: [...d.queryTables, { name: "", target: "b1", path: "", columns: [] }] }))}>
        Add query table
      </Button>
    </div>
  );
}
