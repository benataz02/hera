import { useState } from "react";
import {
  Option, Panel, Select, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, Text, Title,
} from "@ui5/webcomponents-react";
import { fmt, type Candidate } from "./runView.ts";

const row = (label: string, value: string) => (
  <div style={{ display: "flex", justifyContent: "space-between", gap: "1.5rem" }}>
    <Text>{label}</Text>
    <Text style={{ fontWeight: 600 }}>{value}</Text>
  </div>
);

// ponytail: inline SVG micro-chart (≤ ~6 points); swap for @ui5/webcomponents-react-charts
// LineChart only if charts multiply — that package documents no design spec and weak a11y.
function PriceCurve({ points }: { points: { batchQty: number; unitPrice: number }[] }) {
  if (points.length < 2) return null;
  const W = 380, H = 150, P = 30;
  const prices = points.map((p) => p.unitPrice);
  const lo = Math.min(...prices), hi = Math.max(...prices);
  const x = (i: number) => P + (i * (W - 2 * P)) / (points.length - 1);
  const y = (v: number) => (hi === lo ? H / 2 : P + ((hi - v) * (H - 2 * P)) / (hi - lo));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} role="img" aria-label="Unit price by batch quantity">
      <polyline fill="none" stroke="var(--sapChart_OrderedColor_1, #0070f2)" strokeWidth="2"
        points={points.map((p, i) => `${x(i)},${y(p.unitPrice)}`).join(" ")} />
      {points.map((p, i) => (
        <g key={p.batchQty}>
          <circle cx={x(i)} cy={y(p.unitPrice)} r="3.5" fill="var(--sapChart_OrderedColor_1, #0070f2)" />
          <text x={x(i)} y={y(p.unitPrice) - 8} textAnchor="middle" fontSize="11"
            fill="var(--sapTextColor, #223)">{fmt(p.unitPrice)}</text>
          <text x={x(i)} y={H - 8} textAnchor="middle" fontSize="11"
            fill="var(--sapContent_LabelColor, #556)">{fmt(p.batchQty)}</text>
        </g>
      ))}
    </svg>
  );
}

// Everything the price is made of, for one candidate: per-batch breakdown, the price curve,
// and the run's frozen BOM/operations. Read-only — edits happen in Review.
export function CandidateDetail({ label, candidate }: { label: string; candidate: Candidate }) {
  const [batchIdx, setBatchIdx] = useState(0);
  const pb = candidate.perBatch[batchIdx] ?? candidate.perBatch[0];
  if (!pb) return null;
  const o = pb.outputs;
  return (
    <Panel headerText={label} fixed>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "2rem", alignItems: "flex-start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", minWidth: "17rem" }}>
          <Select onChange={(e) => setBatchIdx(Number((e.detail.selectedOption as HTMLElement).dataset.idx))}>
            {candidate.perBatch.map((b, i) => (
              <Option key={b.batchQty} data-idx={String(i)} selected={i === batchIdx}>Qty {fmt(b.batchQty)}</Option>
            ))}
          </Select>
          {row("Material / unit", fmt(o.materialPerUnit))}
          {row("Labor / unit", fmt(o.laborPerUnit))}
          {row("Unit cost", fmt(o.unitCost))}
          {row("Margin / unit", fmt(o.unitPrice - o.unitCost))}
          {row("Unit price", fmt(o.unitPrice))}
          {row("Batch total", fmt(o.batchTotal))}
        </div>
        <PriceCurve points={candidate.perBatch.map((b) => ({ batchQty: b.batchQty, unitPrice: b.outputs.unitPrice }))} />
      </div>

      <Title level="H6" style={{ margin: "1rem 0 0.25rem" }}>Bill of materials</Title>
      <Table noDataText="No BOM lines apply to this configuration." headerRow={
        <TableHeaderRow>
          <TableHeaderCell><span>Item</span></TableHeaderCell>
          <TableHeaderCell><span>Description</span></TableHeaderCell>
          <TableHeaderCell horizontalAlign="End"><span>Qty / unit</span></TableHeaderCell>
          <TableHeaderCell horizontalAlign="End"><span>Total qty</span></TableHeaderCell>
          <TableHeaderCell horizontalAlign="End"><span>Unit price</span></TableHeaderCell>
          <TableHeaderCell horizontalAlign="End"><span>Line total</span></TableHeaderCell>
        </TableHeaderRow>
      }>
        {o.bom.map((l) => (
          <TableRow key={l.id} rowKey={l.id}>
            <TableCell><Text>{l.itemCode}</Text></TableCell>
            <TableCell><Text>{l.desc}</Text></TableCell>
            <TableCell horizontalAlign="End"><Text>{fmt(l.qtyPerUnit)}</Text></TableCell>
            <TableCell horizontalAlign="End"><Text>{fmt(l.totalQty)}</Text></TableCell>
            <TableCell horizontalAlign="End"><Text>{fmt(l.unitPrice)}</Text></TableCell>
            <TableCell horizontalAlign="End"><Text>{fmt(l.lineTotal)}</Text></TableCell>
          </TableRow>
        ))}
      </Table>

      <Title level="H6" style={{ margin: "1rem 0 0.25rem" }}>Operations</Title>
      <Table noDataText="No operations apply to this configuration." headerRow={
        <TableHeaderRow>
          <TableHeaderCell><span>Resource</span></TableHeaderCell>
          <TableHeaderCell horizontalAlign="End"><span>Setup min</span></TableHeaderCell>
          <TableHeaderCell horizontalAlign="End"><span>Run min / unit</span></TableHeaderCell>
          <TableHeaderCell horizontalAlign="End"><span>Total min</span></TableHeaderCell>
          <TableHeaderCell horizontalAlign="End"><span>Cost</span></TableHeaderCell>
        </TableHeaderRow>
      }>
        {o.ops.map((l) => (
          <TableRow key={l.id} rowKey={l.id}>
            <TableCell><Text>{l.resource}</Text></TableCell>
            <TableCell horizontalAlign="End"><Text>{fmt(l.setupMin)}</Text></TableCell>
            <TableCell horizontalAlign="End"><Text>{fmt(l.runMinPerUnit)}</Text></TableCell>
            <TableCell horizontalAlign="End"><Text>{fmt(l.totalMin)}</Text></TableCell>
            <TableCell horizontalAlign="End"><Text>{fmt(l.cost)}</Text></TableCell>
          </TableRow>
        ))}
      </Table>
    </Panel>
  );
}
