import { useState } from "react";
import { Bar, Button, Label, MessageStrip, StepInput, Text, Title, Token, Tokenizer } from "@ui5/webcomponents-react";

// Wizard step 2: the batch quantities to price. Each quantity becomes a column in the
// candidates matrix; setup cost is amortized across the batch by the engine.
export function StepBatches({ batches, onChange, onCalculate, running, error, staleRun }: {
  batches: number[];
  onChange: (next: number[]) => void;
  onCalculate: () => void;
  running: boolean;
  error: string | null;
  staleRun: boolean;
}) {
  const [qty, setQty] = useState(1);
  const add = () => {
    if (!batches.includes(qty)) onChange([...batches, qty].sort((a, b) => a - b));
  };
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
      <Tokenizer accessibleName="Batch quantities"
        onTokenDelete={(e) => {
          const gone = new Set(e.detail.tokens.map((t) => Number((t as HTMLElement).getAttribute("text"))));
          onChange(batches.filter((b) => !gone.has(b)));
        }}>
        {batches.map((b) => <Token key={b} text={String(b)} />)}
      </Tokenizer>
      {batches.length === 0 ? <Text>Add at least one quantity to calculate.</Text> : null}
      <div style={{ display: "flex", alignItems: "flex-end", gap: "0.5rem" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          <Label for="new-batch-qty">Quantity</Label>
          <StepInput id="new-batch-qty" min={1} value={qty} onChange={(e) => setQty(e.target.value ?? 1)} />
        </div>
        <Button icon="add" onClick={add}>Add quantity</Button>
      </div>
      <Bar design="FloatingFooter" endContent={
        <Button design="Emphasized" disabled={batches.length === 0 || running} onClick={onCalculate}>
          {running ? "Calculating…" : "Calculate"}
        </Button>
      } />
    </div>
  );
}
