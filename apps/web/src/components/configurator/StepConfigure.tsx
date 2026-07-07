import type { UseQueryResult } from "@tanstack/react-query";
import { Bar, BusyIndicator, Button, MessageStrip } from "@ui5/webcomponents-react";
import type { Entries, ModelDef, ResolvedLookups } from "@hera/config-engine";
import { ConfiguratorForm } from "./ConfiguratorForm.tsx";
import { ExtractPanel } from "./ExtractPanel.tsx";

// Wizard step 1: the same form the builder preview uses, over server-resolved lookups.
// Lookup errors (agent offline, source unreachable) surface verbatim with a retry.
export function StepConfigure({ modelId, model, lookups, entries, onChange, onNext, saving, conflicted }: {
  modelId: string;
  model: ModelDef;
  lookups: UseQueryResult<ResolvedLookups, Error>;
  entries: Entries;
  onChange: (next: Entries) => void;
  onNext: () => void;
  saving: boolean;
  conflicted: boolean;
}) {
  if (lookups.isPending) return <BusyIndicator active delay={200} style={{ width: "100%", marginTop: "3rem" }} />;
  if (lookups.error)
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <MessageStrip design="Negative" hideCloseButton>{lookups.error.message}</MessageStrip>
        <Button style={{ alignSelf: "start" }} onClick={() => lookups.refetch()}>Retry</Button>
      </div>
    );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <ExtractPanel modelId={modelId} model={model} entries={entries} onChange={onChange} />
      <ConfiguratorForm model={model} lookups={lookups.data} entries={entries} onChange={onChange} />
      <Bar design="FloatingFooter" endContent={
        <Button design="Emphasized" disabled={conflicted || saving} onClick={onNext}
          tooltip={conflicted ? "Resolve the conflicts above first" : undefined}>
          {saving ? "Saving…" : "Next: batches"}
        </Button>
      } />
    </div>
  );
}
