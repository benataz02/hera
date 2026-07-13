import { useState, type ReactNode } from "react";
import { Bar, Button, Text, Title } from "@ui5/webcomponents-react";
import type { Entries, ModelDef } from "@hera/config-engine";
import { candidateLabel, openKeys, type PricedCandidate, type Sel } from "./runView.ts";
import { CandidatesMatrix } from "./CandidatesMatrix.tsx";

// Portal wizard "Prices" step: the candidates matrix plus a read-only row-click detail.
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <Title level="H5">Candidates</Title>
      <Text>
        Unit prices per batch quantity. Pick one or more cells to take into review — each picked
        cell becomes one quotation line. The green price is the lowest in its column.
      </Text>
      <CandidatesMatrix model={model} runEntries={runEntries} candidates={candidates}
        selection={selection} onToggle={onToggle} capped={capped} widest={widest}
        onRowClick={(i) => setDetailIdx(i === detailIdx ? null : i)} />
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
