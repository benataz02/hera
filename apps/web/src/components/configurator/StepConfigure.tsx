import type { ComponentProps } from "react";
import { Bar, BusyIndicator, Button, MessageStrip } from "@ui5/webcomponents-react";
import type { Entries, ModelDef, Propagation, ResolvedLookups, ResolvedTable } from "@hera/config-engine";
import { ConfiguratorForm, ConsistencyStatus } from "./ConfiguratorForm.tsx";
import { ExtractPanel } from "./ExtractPanel.tsx";

// Wizard step 1: the same form the builder preview uses, over ready lookups + propagate.
// Lookup errors (agent offline, source unreachable) surface verbatim with a retry.
export function StepConfigure({ modelId, model, lookups, lk, prop, lookupError, onRetryLookups, entries, onChange, onQueryPick, onNext, saving, conflicted, extract }: {
  modelId: string;
  model: ModelDef;
  lookups?: ResolvedLookups;
  lk?: ResolvedLookups;
  prop?: Propagation | null;
  lookupError?: Error | null;
  onRetryLookups?: () => void;
  entries: Entries;
  onChange: (next: Entries) => void;
  onQueryPick: (paramKey: string, table: string, selected: ResolvedTable | undefined) => void;
  onNext: () => void;
  saving: boolean;
  conflicted: boolean;
  extract?: ComponentProps<typeof ExtractPanel>["extract"];
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      {lookupError ? (
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <MessageStrip design="Negative" hideCloseButton style={{ flex: 1 }}>{lookupError.message}</MessageStrip>
          {onRetryLookups ? <Button onClick={onRetryLookups}>Retry</Button> : null}
        </div>
      ) : null}
      <ExtractPanel modelId={modelId} model={model} entries={entries} onChange={onChange} extract={extract} />
      {lookups && lk && prop ? (
        <ConfiguratorForm model={model} lookups={lookups} lk={lk} prop={prop} entries={entries} onChange={onChange}
          onQueryPick={onQueryPick} querySource={{ kind: "portal", modelId }} />
      ) : lookupError ? null : <BusyIndicator active delay={0} />}
      <Bar design="FloatingFooter"
        startContent={prop ? <ConsistencyStatus prop={prop} /> : undefined}
        endContent={
          <Button design="Emphasized" disabled={conflicted || saving || !prop} onClick={onNext}
            tooltip={conflicted ? "Resolve the conflicts above first" : undefined}>
            {saving ? "Saving…" : "Next: batches"}
          </Button>
        } />
    </div>
  );
}
