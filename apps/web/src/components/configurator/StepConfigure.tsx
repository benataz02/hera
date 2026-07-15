import type { ComponentProps } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Bar, Button, MessageStrip } from "@ui5/webcomponents-react";
import type { Entries, ModelDef, ResolvedLookups } from "@hera/config-engine";
import { ConfiguratorForm, ConsistencyStatus } from "./ConfiguratorForm.tsx";
import { ExtractPanel } from "./ExtractPanel.tsx";

// Wizard step 1: the same form the builder preview uses, over server-resolved lookups.
// Lookup errors (agent offline, source unreachable) surface verbatim with a retry.
export function StepConfigure({ modelId, model, lookups, entries, onChange, onNext, saving, conflicted, extract }: {
  modelId: string;
  model: ModelDef;
  lookups: UseQueryResult<ResolvedLookups, Error>;
  entries: Entries;
  onChange: (next: Entries) => void;
  onNext: () => void;
  saving: boolean;
  conflicted: boolean;
  extract?: ComponentProps<typeof ExtractPanel>["extract"];
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      {lookups.error ? (
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <MessageStrip design="Negative" hideCloseButton style={{ flex: 1 }}>{lookups.error.message}</MessageStrip>
          <Button onClick={() => lookups.refetch()}>Retry</Button>
        </div>
      ) : null}
      <ExtractPanel modelId={modelId} model={model} entries={entries} onChange={onChange} extract={extract} />
      <ConfiguratorForm model={model} lookups={lookups.data} entries={entries} onChange={onChange}
        loading={lookups.isFetching} />
      <Bar design="FloatingFooter"
        startContent={<ConsistencyStatus model={model} lookups={lookups.data} entries={entries} />}
        endContent={
          <Button design="Emphasized" disabled={conflicted || saving || lookups.isPending} onClick={onNext}
            tooltip={conflicted ? "Resolve the conflicts above first" : undefined}>
            {saving ? "Saving…" : "Next: batches"}
          </Button>
        } />
    </div>
  );
}
