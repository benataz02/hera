import { Bar, Button, MessageStrip, Text, Title } from "@ui5/webcomponents-react";
import { BatchEditor } from "./BatchEditor.tsx";

// Portal wizard "Quantities" step: the batch quantities to price. Each quantity becomes a
// column in the candidates matrix; setup cost is amortized across the batch by the engine.
export function StepBatches({ batches, onChange, onCalculate, running, error, staleRun }: {
  batches: number[];
  onChange: (next: number[]) => void;
  onCalculate: () => void;
  running: boolean;
  error: string | null;
  staleRun: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <Title level="H5">Batch quantities</Title>
      <Text>Each quantity gets its own price column — setup cost is spread across the batch.</Text>
      {staleRun ? (
        <MessageStrip design="Critical" hideCloseButton>
          Inputs changed since the last calculation — calculate again to refresh candidates.
        </MessageStrip>
      ) : null}
      {error ? <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip> : null}
      <BatchEditor batches={batches} onChange={onChange} />
      <Bar design="FloatingFooter" endContent={
        <Button design="Emphasized" disabled={batches.length === 0 || running} onClick={onCalculate}>
          {running ? "Calculating…" : "Calculate"}
        </Button>
      } />
    </div>
  );
}
