import { useState } from "react";
import {
  Bar, Button, MessageStrip, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, Text,
  Title, ToggleButton,
} from "@ui5/webcomponents-react";
import type { Entries, ModelDef } from "@hera/config-engine";
import { bestByBatch, candidateLabel, fmt, isSelected, openKeys, type Candidate, type Sel } from "./runView.ts";
import { CandidateDetail } from "./CandidateDetail.tsx";

// Wizard step 3, the signature view: rows = candidates (labeled by their open-parameter
// values), columns = batch quantities, every price cell IS the selection control. One
// pressed cell = one future quotation line. Green marks the lowest price per column.
export function StepCandidates({ model, runEntries, candidates, selection, onToggle, onNext, capped, widest }: {
  model: ModelDef;
  runEntries: Entries;
  candidates: Candidate[];
  selection: Sel[];
  onToggle: (candidateIdx: number, batchQty: number) => void;
  onNext: () => void;
  capped: boolean;
  widest?: { key: string; size: number };
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
          {widest ? ` (${widest.key} is widest with ${widest.size} options)` : ""}.
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
                  {fmt(b.outputs.unitPrice)}
                </ToggleButton>
              </TableCell>
            ))}
          </TableRow>
        ))}
      </Table>

      {detailIdx !== null && candidates[detailIdx] ? (
        <CandidateDetail label={candidateLabel(keys, candidates[detailIdx].assignment)}
          candidate={candidates[detailIdx]} />
      ) : (
        <Text style={{ opacity: 0.7 }}>Click a row to see its cost breakdown, price curve, BOM and operations.</Text>
      )}

      <Bar design="FloatingFooter" endContent={
        <Button design="Emphasized" disabled={selection.length === 0} onClick={onNext}>
          Review selection ({selection.length})
        </Button>
      } />
    </div>
  );
}
