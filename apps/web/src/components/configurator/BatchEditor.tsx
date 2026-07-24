import { useState } from "react";
import { Button, Label, StepInput, Text, Token, Tokenizer } from "@ui5/webcomponents-react";

// The batch-quantity list editor shared by the internal Configure step and the portal wizard.
export function BatchEditor({ batches, onChange, disabled }: {
  batches: number[];
  onChange: (next: number[]) => void;
  disabled?: boolean;
}) {
  const [qty, setQty] = useState(1);
  const add = () => {
    if (!batches.includes(qty)) onChange([...batches, qty].sort((a, b) => a - b));
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", width: "100%" }}>
      <Tokenizer accessibleName="Batch quantities" disabled={disabled}
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
          <StepInput id="new-batch-qty" min={1} value={qty} disabled={disabled} onChange={(e) => setQty(e.target.value ?? 1)} />
        </div>
        <Button icon="add" disabled={disabled} onClick={add}>Add quantity</Button>
      </div>
    </div>
  );
}
