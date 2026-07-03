import { Bar, Button, Input, StepInput, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableRowAction, Text, Title } from "@ui5/webcomponents-react";
import type { Issue, ModelDef } from "@hera/config-engine";
import { ExprInput } from "./ExprInput.tsx";
import { issueFor } from "./useDraftModel.ts";

type Update = (fn: (d: ModelDef) => ModelDef) => void;
type Props = { draft: ModelDef; update: Update; issues: Issue[] };

const newId = (prefix: string, taken: string[]) => {
  let n = taken.length + 1;
  while (taken.includes(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
};

// 150% BOM: every line is an expression over params (+ qty); condition filters per configuration.
export function BomTab({ draft, update, issues }: Props) {
  const set = (i: number, patch: Partial<ModelDef["bom"][number]>) =>
    update((d) => ({ ...d, bom: d.bom.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const cell = (i: number, field: "itemCode" | "desc" | "condition" | "qty" | "price", optional = false, placeholder?: string) => (
    <ExprInput optional={optional} value={draft.bom[i]![field]} model={draft} extraVars={["qty"]}
      placeholder={placeholder} fieldId={`expr-bom[${i}].${field}`} issue={issueFor(issues, `bom[${i}].${field}`)}
      onChange={(v) => set(i, { [field]: optional ? v : (v ?? "") } as Partial<ModelDef["bom"][number]>)} />
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", padding: "1rem" }}>
      <Bar design="Subheader" startContent={<Title level="H5">150% bill of materials</Title>}
        endContent={<Button icon="add" design="Emphasized" onClick={() =>
          update((d) => ({ ...d, bom: [...d.bom, { id: newId("line", d.bom.map((l) => l.id)), itemCode: '""', qty: "1", price: "0", scrapPct: 0 }] }))
        }>Add line</Button>} />
      <Text>Item, quantity and price are expressions; parameters and <code>qty</code> (batch size) are in scope. Condition decides whether the line applies.</Text>
      <Table noDataText="No BOM lines." rowActionCount={1} overflowMode="Scroll"
        onRowActionClick={(e) => {
          const i = Number(((e.detail.row as unknown) as HTMLElement).dataset.idx);
          update((d) => ({ ...d, bom: d.bom.filter((_, j) => j !== i) }));
        }}
        headerRow={
          <TableHeaderRow>
            <TableHeaderCell width="6rem"><span>Id</span></TableHeaderCell>
            <TableHeaderCell minWidth="11rem"><span>Item code</span></TableHeaderCell>
            <TableHeaderCell minWidth="11rem"><span>Description</span></TableHeaderCell>
            <TableHeaderCell minWidth="11rem"><span>Condition</span></TableHeaderCell>
            <TableHeaderCell minWidth="9rem"><span>Qty per unit</span></TableHeaderCell>
            <TableHeaderCell minWidth="9rem"><span>Unit price</span></TableHeaderCell>
            <TableHeaderCell width="7rem"><span>Scrap %</span></TableHeaderCell>
          </TableHeaderRow>
        }>
        {draft.bom.map((l, i) => (
          <TableRow key={i} rowKey={`bom-${i}`} data-idx={String(i)} actions={<TableRowAction icon="delete" text="Delete" />}>
            <TableCell><Input value={l.id} onInput={(e) => set(i, { id: e.target.value })} /></TableCell>
            <TableCell>{cell(i, "itemCode", false, '"CBL-STL" or a ternary')}</TableCell>
            <TableCell>{cell(i, "desc", true)}</TableCell>
            <TableCell>{cell(i, "condition", true, "always applies when empty")}</TableCell>
            <TableCell>{cell(i, "qty")}</TableCell>
            <TableCell>{cell(i, "price", false, 'number or LOOKUP(...)')}</TableCell>
            <TableCell><StepInput value={l.scrapPct} min={0} step={0.5} onChange={(e) => set(i, { scrapPct: e.target.value ?? 0 })} /></TableCell>
          </TableRow>
        ))}
      </Table>
    </div>
  );
}

export function RoutingTab({ draft, update, issues }: Props) {
  const set = (i: number, patch: Partial<ModelDef["routing"][number]>) =>
    update((d) => ({ ...d, routing: d.routing.map((o, j) => (j === i ? { ...o, ...patch } : o)) }));
  const cell = (i: number, field: "condition" | "setupMin" | "runMinPerUnit" | "ratePerHour", optional = false, placeholder?: string) => (
    <ExprInput optional={optional} value={draft.routing[i]![field]} model={draft} extraVars={["qty"]}
      placeholder={placeholder} fieldId={`expr-routing[${i}].${field}`} issue={issueFor(issues, `routing[${i}].${field}`)}
      onChange={(v) => set(i, { [field]: optional ? v : (v ?? "") } as Partial<ModelDef["routing"][number]>)} />
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", padding: "1rem" }}>
      <Bar design="Subheader" startContent={<Title level="H5">150% routing</Title>}
        endContent={<Button icon="add" design="Emphasized" onClick={() =>
          update((d) => ({ ...d, routing: [...d.routing, { id: newId("op", d.routing.map((o) => o.id)), resource: "", setupMin: "0", runMinPerUnit: "0", ratePerHour: "60" }] }))
        }>Add operation</Button>} />
      <Text>Times are minutes, rate is cost per hour; all are expressions with <code>qty</code> in scope. Setup is amortized over the batch by the engine.</Text>
      <Table noDataText="No operations." rowActionCount={1} overflowMode="Scroll"
        onRowActionClick={(e) => {
          const i = Number(((e.detail.row as unknown) as HTMLElement).dataset.idx);
          update((d) => ({ ...d, routing: d.routing.filter((_, j) => j !== i) }));
        }}
        headerRow={
          <TableHeaderRow>
            <TableHeaderCell width="6rem"><span>Id</span></TableHeaderCell>
            <TableHeaderCell><span>Resource</span></TableHeaderCell>
            <TableHeaderCell minWidth="11rem"><span>Condition</span></TableHeaderCell>
            <TableHeaderCell minWidth="9rem"><span>Setup (min)</span></TableHeaderCell>
            <TableHeaderCell minWidth="9rem"><span>Run / unit (min)</span></TableHeaderCell>
            <TableHeaderCell minWidth="9rem"><span>Rate / hour</span></TableHeaderCell>
          </TableHeaderRow>
        }>
        {draft.routing.map((o, i) => (
          <TableRow key={i} rowKey={`op-${i}`} data-idx={String(i)} actions={<TableRowAction icon="delete" text="Delete" />}>
            <TableCell><Input value={o.id} onInput={(e) => set(i, { id: e.target.value })} /></TableCell>
            <TableCell><Input value={o.resource} placeholder="e.g. SAW-01" onInput={(e) => set(i, { resource: e.target.value })} /></TableCell>
            <TableCell>{cell(i, "condition", true, "always runs when empty")}</TableCell>
            <TableCell>{cell(i, "setupMin")}</TableCell>
            <TableCell>{cell(i, "runMinPerUnit")}</TableCell>
            <TableCell>{cell(i, "ratePerHour")}</TableCell>
          </TableRow>
        ))}
      </Table>
    </div>
  );
}
