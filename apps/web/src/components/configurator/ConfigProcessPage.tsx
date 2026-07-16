import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar, Button, BusyIndicator, Dialog, Form, FormGroup, FormItem, Label, MessageStrip,
  ObjectStatus, SplitterElement, SplitterLayout, Text, TextArea, Title, ToggleButton, Wizard, WizardStep,
} from "@ui5/webcomponents-react";
import { propagate, type Entries } from "@hera/config-engine";
import type { Val } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";
import { cleanOverrides, statusUi, toggleSelection, type Sel } from "./runView.ts";
import { ConfiguratorForm, ConsistencyStatus } from "./ConfiguratorForm.tsx";
import { ExtractPanel } from "./ExtractPanel.tsx";
import { BatchEditor } from "./BatchEditor.tsx";
import { StepCandidatesReview } from "./StepCandidatesReview.tsx";
import { HistoryPane } from "./HistoryPane.tsx";
import "./ConfigProcessPage.css";

// The configuration process: 3 steps, gated left to right. Step 1 (Configure) works on live
// model + lookups and includes the batch quantities; step 2 (Candidates) renders ONLY from the
// immutable run snapshot, with the editable outputs of every selected cell inline. Local state
// overlays server state (override ?? server value) until a mutation persists it.
export function ConfigProcessPage({ id }: { id: string }) {
  const qc = useQueryClient();
  const q = useQuery(orpc.configs.get.queryOptions({ input: { id } }));
  const modelId = q.data?.project.modelId;
  const lookups = useQuery({
    ...orpc.configs.lookups.queryOptions({ input: { modelId: modelId! } }),
    enabled: !!modelId,
    staleTime: 5 * 60_000, // matches the server-side cache window
    retry: false, // agent-offline should show its message, not spin
  });

  const [stepOverride, setStep] = useState<number | null>(null);
  const [entriesOverride, setEntries] = useState<Entries | null>(null);
  const [batchesOverride, setBatches] = useState<number[] | null>(null);
  const [selOverride, setSel] = useState<Sel[] | null>(null);
  const [runMeta, setRunMeta] = useState<{ capped: boolean; widest?: { key: string; size: number } } | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [note, setNote] = useState("");
  // Slide the help pane like the builder preview: open by default only when the model asks for it.
  const [paneOverride, setPaneOverride] = useState<boolean | null>(null);
  const [animating, setAnimating] = useState(false);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: orpc.configs.get.queryOptions({ input: { id } }).queryKey });
  const update = useMutation(orpc.configs.update.mutationOptions({ onSuccess: invalidate }));
  const reject = useMutation(orpc.configs.reject.mutationOptions({
    onSuccess: () => { setRejectOpen(false); invalidate(); },
  }));
  const run = useMutation(
    orpc.configs.run.mutationOptions({
      onSuccess: (r) => {
        setRunMeta({ capped: r.capped, widest: r.widest });
        setSel([]); // a new run invalidates any previous candidate picks
        invalidate();
        setStep(1);
      },
    }),
  );
  const select = useMutation(orpc.configs.select.mutationOptions({ onSuccess: invalidate }));

  if (q.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;
  if (q.error)
    return <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>{q.error.message}</MessageStrip>;
  const { project, model, latestRun, createdByEmail } = q.data;

  const entries = entriesOverride ?? project.entries;
  const batches = batchesOverride ?? project.batches;
  const selection = selOverride ?? latestRun?.selection ?? [];
  const runReady = !!latestRun && project.status !== "draft";
  const step = stepOverride ?? (project.status === "draft" ? 0 : 1);

  const paneOpen = paneOverride ?? !!model.definition.history;
  const PANE_ANIM = "flex-basis 0.28s cubic-bezier(0.2, 0, 0, 1)";
  const copyValues = (values: Record<string, Val>) => {
    const next = { ...entries };
    for (const [k, v] of Object.entries(values)) {
      const cur = next[k];
      if ((cur === undefined || cur === null || cur === "") && v !== null && v !== undefined) next[k] = v;
    }
    setEntries(next); // fills only empty params; ConfiguratorForm's propagate() takes it from here
  };

  // ConsistencyStatus renders the message; prop here only gates Calculate/navigation.
  const prop = lookups.data ? propagate(model.definition, lookups.data, entries) : null;
  const conflicted = !!prop && prop.conflicts.length > 0;
  const entriesDirty = JSON.stringify(entries) !== JSON.stringify(project.entries);
  const batchesDirty = JSON.stringify(batches) !== JSON.stringify(project.batches);
  const staleRun = !!latestRun && (project.status === "draft" || entriesDirty || batchesDirty);

  const goto = (i: number) => {
    if (step === 0 && i !== 0 && (entriesDirty || batchesDirty)) update.mutate({ id, entries, batches });
    setStep(i);
  };
  const calculate = async () => {
    try {
      if (entriesDirty || batchesDirty) await update.mutateAsync({ id, entries, batches });
      run.mutate({ projectId: id });
    } catch {
      /* update.error renders below */
    }
  };
  const saveSelection = () => {
    if (!latestRun || selection.length === 0) return;
    select.mutate({
      runId: latestRun.id,
      selection: selection.map((s) => ({
        candidateIdx: s.candidateIdx, batchQty: s.batchQty, overrides: cleanOverrides(s.overrides),
      })),
    });
  };

  const configureBody = (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      {lookups.error ? (
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <MessageStrip design="Negative" hideCloseButton style={{ flex: 1 }}>{lookups.error.message}</MessageStrip>
          <Button onClick={() => lookups.refetch()}>Retry</Button>
        </div>
      ) : null}
      <ExtractPanel modelId={project.modelId} model={model.definition} entries={entries} onChange={setEntries} />
      <ConfiguratorForm model={model.definition} lookups={lookups.data} entries={entries} onChange={setEntries}
        loading={lookups.isFetching} />
      <Form headerText="Batch quantities" headerLevel="H5" labelSpan="S12 M4" layout="S1 M1 L1 XL1">
        <FormGroup>
          <FormItem labelContent={<Label>Quantities</Label>}>
            <BatchEditor batches={batches} onChange={setBatches} />
          </FormItem>
        </FormGroup>
      </Form>
      {update.error || run.error ? (
        <MessageStrip design="Negative" hideCloseButton>{update.error?.message ?? run.error?.message}</MessageStrip>
      ) : null}
      <Bar design="FloatingFooter" className="hera-step-bar"
        startContent={
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <ConsistencyStatus model={model.definition} lookups={lookups.data} entries={entries} />
            {staleRun ? <ObjectStatus state="Critical">inputs changed — calculate again</ObjectStatus> : null}
          </div>
        }
        endContent={
          <Button design="Emphasized"
            disabled={conflicted || lookups.isPending || batches.length === 0 || update.isPending || run.isPending}
            onClick={() => void calculate()}>
            {update.isPending || run.isPending ? "Calculating…" : "Calculate"}
          </Button>
        } />
    </div>
  );

  return (
    <SplitterLayout style={{ height: "100%", width: "100%" }}
      onTransitionEnd={(e) => { if (e.propertyName === "flex-basis") setAnimating(false); }}>
    <SplitterElement size={paneOpen ? "62%" : "100%"} minSize={480}
      style={{ transition: animating ? PANE_ANIM : undefined }}>
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {project.status === "requested" ? (
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", margin: "0.5rem 1rem" }}>
          <MessageStrip design="Critical" hideCloseButton style={{ flex: 1 }}>
            Requested by {createdByEmail ?? "a portal user"} for {project.customer?.cardName ?? "—"} —
            review the configuration, then create the quotation or reject with a note.
          </MessageStrip>
          <Button design="Negative" onClick={() => setRejectOpen(true)}>Reject</Button>
        </div>
      ) : null}
      <div className="hera-wizard-wrap">
        <div className="hera-wizard-header">
          <Title level="H5">{project.name}</Title>
          <Text>{model.name}</Text>
          <ObjectStatus state={statusUi[project.status].state}>{statusUi[project.status].text}</ObjectStatus>
          <ToggleButton icon="history" pressed={paneOpen} style={{ marginLeft: "auto" }}
            onClick={() => { setAnimating(true); setPaneOverride(!paneOpen); }}>
            History
          </ToggleButton>
        </div>
        <Wizard className="hera-wizard" contentLayout="SingleStep"
          onStepChange={(e) => goto(Number((e.detail.step as HTMLElement).dataset.idx))}>
          <WizardStep titleText="Configure" icon="settings" data-idx="0" selected={step === 0}>
            {configureBody}
          </WizardStep>
          <WizardStep titleText="Candidates" icon="grid" data-idx="1" selected={step === 1} disabled={!runReady}>
            {runReady && latestRun ? (
              <StepCandidatesReview model={latestRun.modelSnapshot} lookups={latestRun.lookupSnapshot}
                runEntries={latestRun.entries} candidates={latestRun.candidates}
                selection={selection}
                onToggle={(i, b) => setSel(toggleSelection(selection, i, b))}
                onChange={setSel}
                capped={runMeta?.capped ?? latestRun.candidates.length >= 200}
                widest={runMeta?.widest}
                onSave={saveSelection} saving={select.isPending}
                error={select.error?.message ?? null} saved={select.isSuccess} />
            ) : null}
          </WizardStep>
          <WizardStep titleText="Create quote" icon="sales-quote" data-idx="2" disabled>
            <Text>Available after review — coming in phase 5.</Text>
          </WizardStep>
        </Wizard>
      </div>

      <Dialog open={rejectOpen} headerText="Reject request" onClose={() => setRejectOpen(false)}
        footer={
          <Bar design="Footer" endContent={
            <>
              <Button design="Negative" disabled={!note.trim() || reject.isPending}
                onClick={() => reject.mutate({ id, note: note.trim() })}>
                {reject.isPending ? "Rejecting…" : "Reject with note"}
              </Button>
              <Button onClick={() => setRejectOpen(false)}>Cancel</Button>
            </>
          } />
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", padding: "0.5rem 0" }}>
          {reject.error ? <MessageStrip design="Negative" hideCloseButton>{reject.error.message}</MessageStrip> : null}
          <Label for="reject-note" required>What should the client change?</Label>
          <TextArea id="reject-note" rows={4} value={note} onInput={(e) => setNote(e.target.value)} />
        </div>
      </Dialog>
    </div>
    </SplitterElement>
    <SplitterElement size={paneOpen ? "38%" : "0%"} minSize={paneOpen ? 320 : 0} resizable={paneOpen}
      style={{ transition: animating ? PANE_ANIM : undefined }}>
      <div style={{ flex: 1, minWidth: 0, height: "100%", display: "flex", flexDirection: "column", minHeight: 0,
        overflowY: "auto", padding: "0 0.5rem", opacity: paneOpen ? 1 : 0, transition: "opacity 0.28s ease" }}>
        <HistoryPane projectId={id} model={model.definition} entries={entries} onCopy={copyValues} />
      </div>
    </SplitterElement>
    </SplitterLayout>
  );
}
