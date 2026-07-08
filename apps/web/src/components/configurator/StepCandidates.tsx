import { useState, type ReactNode } from "react";
import {
  Bar, Button, MessageStrip, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, Text,
  Title, ToggleButton,
} from "@ui5/webcomponents-react";
import type { Entries, ModelDef } from "@hera/config-engine";
import { bestByBatch, candidateLabel, fmt, isSelected, openKeys, type PricedCandidate, type Sel } from "./runView.ts";

// Wizard step 3, the signature view: rows = candidates (labeled by their open-parameter
// values), columns = batch quantities, every price cell IS the selection control. One
// pressed cell = one future quotation line. Green marks the lowest price per column.
export function StepCandidates({ model, runEntries, candidates, selection, onToggle, onNext, capped, widest, renderDetail, nextLabel }: {
  model: ModelDef;
  runEntries: Entries;
  candidates: PricedCandidate[];
  selection: Sel[];
  onToggle: (candidateIdx: number, batchQty: number) => void;
  onNext: () => void;
  capped: boolean;
  widest?: { key: string; size: number };
  renderDetail: (idx: number, label: string) => ReactNode;
  nextLabel?: string;
}) {
  const [detailIdx, setDetailIdx] = useState<number | null>(null);
  const keys = openKeys(model, runEntries, candidates);
  const best = bestByBatch(candidates);
  const batches = candidates[0]?.perBatch.map((b) => b.batchQty) ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <Title level="H5">Candidates</Title>
      <Text>
        Unit prices per batch quantity. Pick one or more cells to take into review — each picked
        cell becomes one quotation line. The green price is the lowest in its column.
      </Text>
      {capped ? (
        <MessageStrip design="Critical" hideCloseButton>
          Stopped at {candidates.length} candidates — go back and set more parameters
          {widest ? ` (${model.parameters.find((p) => p.key === widest.key)?.label ?? widest.key} is widest with ${widest.size} options)` : ""}.
        </MessageStrip>
      ) : null}

      <Table
        onRowClick={(e) => {
          const i = Number((e.detail.row as HTMLElement).dataset.idx);
          setDetailIdx(i === detailIdx ? null : i);
        }}
        headerRow={
          <TableHeaderRow sticky>
            <TableHeaderCell minWidth="14rem"><span>Configuration ({keys.join(" · ") || "fixed"})</span></TableHeaderCell>
            {batches.map((b) => (
              <TableHeaderCell key={b} horizontalAlign="End"><span>Qty {fmt(b)}</span></TableHeaderCell>
            ))}
          </TableHeaderRow>
        }
      >
        {candidates.map((c, i) => (
          <TableRow key={i} rowKey={String(i)} data-idx={String(i)} interactive>
            <TableCell><Text>{candidateLabel(keys, c.assignment)}</Text></TableCell>
            {c.perBatch.map((b) => (
              <TableCell key={b.batchQty} horizontalAlign="End">
                <ToggleButton pressed={isSelected(selection, i, b.batchQty)}
                  design={best[b.batchQty] === i ? "Positive" : "Default"}
                  tooltip={best[b.batchQty] === i ? "Lowest price for this quantity" : undefined}
                  onClick={(e) => { e.stopPropagation(); onToggle(i, b.batchQty); }}>
                  {fmt(b.unitPrice)}
                </ToggleButton>
              </TableCell>
            ))}
          </TableRow>
        ))}
      </Table>

      {detailIdx !== null && candidates[detailIdx]
        ? renderDetail(detailIdx, candidateLabel(keys, candidates[detailIdx].assignment))
        : <Text style={{ opacity: 0.7 }}>Click a row to see its details.</Text>}

      <Bar design="FloatingFooter" endContent={
        <Button design="Emphasized" disabled={selection.length === 0} onClick={onNext}>
          {nextLabel ?? "Review selection"} ({selection.length})
        </Button>
      } />
    </div>
  );
}
