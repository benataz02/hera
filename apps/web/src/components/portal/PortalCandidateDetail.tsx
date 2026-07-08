import { CheckBox, Form, FormItem, Label, Panel, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, Text, Title } from "@ui5/webcomponents-react";
import type { Entries, ModelDef } from "@hera/config-engine";
import { fmt, isSelected, type Sel } from "../configurator/runView.ts";

export type PortalCandidate = { assignment: Entries; perBatch: { batchQty: number; unitPrice: number; total: number }[] };

// What a client sees per candidate: the full parameter assignment + price per quantity.
// No costs, no BOM, no routing, no chart — by design (and the data isn't in the payload anyway).
export function PortalCandidateDetail({ label, model, candidate, candidateIdx, selection }: {
  label: string;
  model: ModelDef;
  candidate: PortalCandidate;
  candidateIdx: number;
  selection: Sel[];
}) {
  return (
    <Panel headerText={`Configuration: ${label}`}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "2rem", padding: "0.5rem" }}>
        <Form labelSpan="S6" layout="S1 M2" style={{ flex: "1 1 20rem" }}>
          {model.parameters
            .filter((p) => candidate.assignment[p.key] !== undefined)
            .map((p) => (
              <FormItem key={p.key} labelContent={<Label>{p.label}</Label>}>
                <Text>{String(candidate.assignment[p.key])}{p.unit ? ` ${p.unit}` : ""}</Text>
              </FormItem>
            ))}
        </Form>
        <div style={{ flex: "1 1 16rem" }}>
          <Title level="H6">Price by quantity</Title>
          <Table headerRow={
            <TableHeaderRow>
              <TableHeaderCell><span>Quantity</span></TableHeaderCell>
              <TableHeaderCell horizontalAlign="End"><span>Unit price</span></TableHeaderCell>
              <TableHeaderCell horizontalAlign="End"><span>Total</span></TableHeaderCell>
              <TableHeaderCell><span>Selected</span></TableHeaderCell>
            </TableHeaderRow>
          }>
            {candidate.perBatch.map((b) => (
              <TableRow key={b.batchQty} rowKey={String(b.batchQty)}>
                <TableCell><Text>{fmt(b.batchQty)}</Text></TableCell>
                <TableCell horizontalAlign="End"><Text>{fmt(b.unitPrice)}</Text></TableCell>
                <TableCell horizontalAlign="End"><Text>{fmt(b.total)}</Text></TableCell>
                <TableCell><CheckBox checked={isSelected(selection, candidateIdx, b.batchQty)} disabled /></TableCell>
              </TableRow>
            ))}
          </Table>
        </div>
      </div>
    </Panel>
  );
}
