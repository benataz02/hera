import {
  MessageStrip, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, Text, ToggleButton,
} from "@ui5/webcomponents-react";
import type { Entries, ModelDef } from "@hera/config-engine";
import { bestByBatch, candidateLabel, fmt, isSelected, openKeys, type PricedCandidate, type Sel } from "./runView.ts";

// The signature view: rows = candidates (labeled by their open-parameter values), columns =
// batch quantities, every price cell IS the selection control. One pressed cell = one future
// quotation line. Green marks the lowest price per column.
export function CandidatesMatrix({ model, runEntries, candidates, selection, onToggle, capped, widest, onRowClick }: {
  model: ModelDef;
  runEntries: Entries;
  candidates: PricedCandidate[];
  selection: Sel[];
  onToggle: (candidateIdx: number, batchQty: number) => void;
  capped: boolean;
  widest?: { key: string; size: number };
  onRowClick?: (idx: number) => void;
}) {
  const keys = openKeys(model, runEntries, candidates);
  const best = bestByBatch(candidates);
  const batches = candidates[0]?.perBatch.map((b) => b.batchQty) ?? [];

  return (
    <>
      {capped ? (
        <MessageStrip design="Critical" hideCloseButton>
          Stopped at {candidates.length} candidates — go back and set more parameters
          {widest ? ` (${model.parameters.find((p) => p.key === widest.key)?.label ?? widest.key} is widest with ${widest.size} options)` : ""}.
        </MessageStrip>
      ) : null}
      <Table
        onRowClick={onRowClick ? (e) => onRowClick(Number((e.detail.row as HTMLElement).dataset.idx)) : undefined}
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
          <TableRow key={i} rowKey={String(i)} data-idx={String(i)} interactive={!!onRowClick}>
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
    </>
  );
}
