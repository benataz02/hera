import { useRef, useState } from "react";
import { Bar, Button, BusyIndicator, MessageStrip, Text, Title } from "@ui5/webcomponents-react";
import { DslError, type Entries, type Issue, type ModelDef } from "@hera/config-engine";
import { ConfiguratorForm, ConsistencyStatus } from "./ConfiguratorForm.tsx";
import { usePreviewLookups } from "./usePreviewLookups.ts";

// Test-drives the draft with the real engine. While the draft has errors we keep rendering the
// last valid draft (with a hint) so one bad keystroke doesn't blank the preview.
export function PreviewPane({ draft, issues }: { draft: ModelDef; issues: Issue[] }) {
  const [entries, setEntries] = useState<Entries>({});
  const lastGood = useRef<ModelDef>(draft);
  if (issues.length === 0) lastGood.current = draft;
  const model = issues.length === 0 ? draft : lastGood.current;

  const lookups = usePreviewLookups(model);

  let body: React.ReactNode;
  if (lookups.isPending) body = <BusyIndicator active delay={200} style={{ width: "100%", marginTop: "3rem" }} />;
  else if (lookups.error)
    body = (
      <div style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <MessageStrip design="Negative" hideCloseButton>{lookups.error.message}</MessageStrip>
        <Button style={{ alignSelf: "start" }} onClick={() => lookups.refetch()}>Retry</Button>
      </div>
    );
  else {
    try {
      body = (
        <>
          <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "0 1rem 1rem" }}>
            <ConfiguratorForm model={model} lookups={lookups.data} entries={entries} onChange={setEntries} />
          </div>
          <Bar design="Footer"
            startContent={<ConsistencyStatus model={model} lookups={lookups.data} entries={entries} />} />
        </>
      );
    } catch (e) {
      body = (
        <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>
          {e instanceof DslError ? e.message : String(e)}
        </MessageStrip>
      );
    }
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <Bar design="Subheader"
        startContent={<Title level="H5">Live preview</Title>}
        endContent={
          <Button design="Transparent" icon="reset" onClick={() => setEntries({})}>Reset entries</Button>
        }
      />
      {issues.length > 0 ? (
        <MessageStrip design="Critical" hideCloseButton>
          Showing the last valid version — fix {issues.length} error{issues.length === 1 ? "" : "s"} to preview the current draft.
        </MessageStrip>
      ) : null}
      {body}
    </div>
  );
}
