import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar, Button, BusyIndicator, Dialog, Label, MessageStrip, ObjectStatus, Text, TextArea, Title, Wizard, WizardStep,
} from "@ui5/webcomponents-react";
import { propagate, type Entries } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";
import { cleanOverrides, statusUi, toggleSelection, toPriced, type Sel } from "./runView.ts";
import { StepConfigure } from "./StepConfigure.tsx";
import { StepBatches } from "./StepBatches.tsx";
import { StepCandidates } from "./StepCandidates.tsx";
import { CandidateDetail } from "./CandidateDetail.tsx";
import { StepReview } from "./StepReview.tsx";

// The configuration process: 5 steps, gated left to right. Steps 1–2 work on live model +
// lookups; steps 3–4 render ONLY from the immutable run snapshot. Local state overlays
// server state (override ?? server value) until a mutation persists it.
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
        setStep(2);
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
  const step = stepOverride ?? (project.status === "draft" ? 0 : 2);

  const prop = lookups.data ? propagate(model.definition, lookups.data, entries) : null;
  const conflicted = !!prop && prop.conflicts.length > 0;
  const entriesDirty = JSON.stringify(entries) !== JSON.stringify(project.entries);
  const batchesDirty = JSON.stringify(batches) !== JSON.stringify(project.batches);

  const saveEntries = () => {
    if (entriesDirty) update.mutate({ id, entries });
  };
  const goto = (i: number) => {
    if (step === 0 && i !== 0) saveEntries(); // leaving Configure persists (and re-drafts) the project
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

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Bar design="Header"
        startContent={
          <>
            <Title level="H4">{project.name}</Title>
            <Text>{model.name}</Text>
          </>
        }
        endContent={<ObjectStatus state={statusUi[project.status].state}>{statusUi[project.status].text}</ObjectStatus>}
      />
      {project.status === "requested" ? (
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", margin: "0.5rem 1rem" }}>
          <MessageStrip design="Critical" hideCloseButton style={{ flex: 1 }}>
            Requested by {createdByEmail ?? "a portal user"} for {project.customer?.cardName ?? "—"} —
            review the configuration, then create the quotation or reject with a note.
          </MessageStrip>
          <Button design="Negative" onClick={() => setRejectOpen(true)}>Reject</Button>
        </div>
      ) : null}
      <Wizard contentLayout="MultipleSteps" style={{ flex: 1, minHeight: 0 }}
        onStepChange={(e) => goto(Number((e.detail.step as HTMLElement).dataset.idx))}>
        <WizardStep titleText="Configure" icon="settings" data-idx="0" selected={step === 0}>
          <StepConfigure model={model.definition} modelId={project.modelId} lookups={lookups} entries={entries}
            onChange={setEntries} onNext={() => goto(1)} saving={update.isPending} conflicted={conflicted} />
        </WizardStep>
        <WizardStep titleText="Batches" icon="multiselect-all" data-idx="1" selected={step === 1} disabled={conflicted}>
          <StepBatches batches={batches} onChange={setBatches} onCalculate={() => void calculate()}
            running={update.isPending || run.isPending}
            error={update.error?.message ?? run.error?.message ?? null}
            staleRun={!!latestRun && (project.status === "draft" || entriesDirty || batchesDirty)} />
        </WizardStep>
        <WizardStep titleText="Candidates" icon="grid" data-idx="2" selected={step === 2} disabled={!runReady}>
          {runReady && latestRun ? (
            <StepCandidates model={latestRun.modelSnapshot} runEntries={latestRun.entries}
              candidates={latestRun.candidates.map(toPriced)} selection={selection}
              onToggle={(i, b) => setSel(toggleSelection(selection, i, b))}
              onNext={() => goto(3)}
              capped={runMeta?.capped ?? latestRun.candidates.length >= 200}
              widest={runMeta?.widest}
              renderDetail={(i, label) => <CandidateDetail label={label} candidate={latestRun.candidates[i]!} />} />
          ) : null}
        </WizardStep>
        <WizardStep titleText="Review outputs" icon="activity-items" data-idx="3" selected={step === 3}
          disabled={!runReady || selection.length === 0}>
          {runReady && latestRun ? (
            <StepReview model={latestRun.modelSnapshot} lookups={latestRun.lookupSnapshot}
              runEntries={latestRun.entries} candidates={latestRun.candidates}
              selection={selection} onChange={setSel}
              onSave={saveSelection} saving={select.isPending}
              error={select.error?.message ?? null} saved={select.isSuccess} />
          ) : null}
        </WizardStep>
        <WizardStep titleText="Create quote" icon="sales-quote" data-idx="4" disabled>
          <Text>Available after review — coming in phase 5.</Text>
        </WizardStep>
      </Wizard>

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
  );
}
