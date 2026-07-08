import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar, BusyIndicator, Button, Card, CardHeader, Dialog, MessageStrip, ObjectStatus, Table, TableCell,
  TableHeaderCell, TableHeaderRow, TableRow, Text, Title, Wizard, WizardStep,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-icons/dist/paper-plane.js";
import { propagate, type Entries } from "@hera/config-engine";
import { client, orpc } from "../../orpc.ts";
import { StepConfigure } from "../configurator/StepConfigure.tsx";
import { StepBatches } from "../configurator/StepBatches.tsx";
import { StepCandidates } from "../configurator/StepCandidates.tsx";
import { candidateLabel, fmt, isSelected, openKeys, toggleSelection, type Sel } from "../configurator/runView.ts";
import { portalStatusUi, type PortalStatus } from "./portalUi.ts";
import { PortalCandidateDetail } from "./PortalCandidateDetail.tsx";
import { PortalRequestSummary } from "./PortalRequestSummary.tsx";

// The client's request flow: Configure → Quantities → Prices → Submit while editable;
// a read-only summary once submitted. Mirrors ConfigProcessPage's state overlay pattern.
export function PortalRequestPage({ id }: { id: string }) {
  const qc = useQueryClient();
  const q = useQuery(orpc.portal.projects.get.queryOptions({ input: { id } }));
  const modelId = q.data?.project.modelId;
  const lookups = useQuery({
    ...orpc.portal.lookups.queryOptions({ input: { modelId: modelId! } }),
    enabled: !!modelId,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const [stepOverride, setStep] = useState<number | null>(null);
  const [entriesOverride, setEntries] = useState<Entries | null>(null);
  const [batchesOverride, setBatches] = useState<number[] | null>(null);
  const [selOverride, setSel] = useState<Sel[] | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [runMeta, setRunMeta] = useState<{ capped: boolean; widest?: { key: string; size: number } } | null>(null);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: orpc.portal.projects.get.queryOptions({ input: { id } }).queryKey });
  const update = useMutation(orpc.portal.projects.update.mutationOptions({ onSuccess: invalidate }));
  const run = useMutation(
    orpc.portal.run.mutationOptions({
      onSuccess: (r) => { setRunMeta({ capped: r.capped, widest: r.widest }); setSel([]); invalidate(); setStep(2); },
    }),
  );
  const submit = useMutation(
    orpc.portal.submit.mutationOptions({ onSuccess: () => { setConfirmOpen(false); setStep(null); invalidate(); } }),
  );
  const withdraw = useMutation(orpc.portal.withdraw.mutationOptions({ onSuccess: invalidate }));
  const reopen = useMutation(orpc.portal.reopen.mutationOptions({ onSuccess: () => { setStep(0); invalidate(); } }));

  if (q.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;
  if (q.error)
    return <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>{q.error.message}</MessageStrip>;
  const { project, model, latestRun } = q.data;
  const status = project.status as PortalStatus;

  if (status !== "draft" && status !== "calculated") {
    return (
      <PortalRequestSummary project={{ ...project, status }} model={model} latestRun={latestRun}
        onWithdraw={() => withdraw.mutate({ projectId: id })}
        onReopen={() => reopen.mutate({ projectId: id })}
        busy={withdraw.isPending || reopen.isPending} />
    );
  }

  const entries = entriesOverride ?? project.entries;
  const batches = batchesOverride ?? project.batches;
  const selection = selOverride ?? (latestRun?.selection as Sel[] | null) ?? [];
  const runReady = !!latestRun && status === "calculated";
  const step = stepOverride ?? (status === "draft" ? 0 : 2);

  const prop = lookups.data ? propagate(model.definition, lookups.data, entries) : null;
  const conflicted = !!prop && prop.conflicts.length > 0;
  const entriesDirty = JSON.stringify(entries) !== JSON.stringify(project.entries);
  const batchesDirty = JSON.stringify(batches) !== JSON.stringify(project.batches);

  const goto = (i: number) => {
    if (step === 0 && i !== 0 && entriesDirty) update.mutate({ id, entries });
    setStep(i);
  };
  const calculate = async () => {
    try {
      if (entriesDirty || batchesDirty) await update.mutateAsync({ id, entries, batches });
      run.mutate({ projectId: id });
    } catch { /* update.error renders in StepBatches */ }
  };

  const keys = latestRun ? openKeys(model.definition, latestRun.entries, latestRun.candidates) : [];
  const chosen = selection.map((s) => {
    const c = latestRun!.candidates[s.candidateIdx]!;
    const b = c.perBatch.find((x) => x.batchQty === s.batchQty)!;
    return { label: candidateLabel(keys, c.assignment), batchQty: s.batchQty, unitPrice: b.unitPrice, total: b.total };
  });
  const grand = chosen.reduce((sum, l) => sum + l.total, 0);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Bar design="Header"
        startContent={<><Title level="H4">{project.name}</Title><Text>{model.name}</Text></>}
        endContent={<ObjectStatus state={portalStatusUi[status].state}>{portalStatusUi[status].text}</ObjectStatus>} />
      {!model.available ? (
        <MessageStrip design="Negative" hideCloseButton style={{ margin: "0.5rem 1rem" }}>
          This product is no longer available — contact your supplier.
        </MessageStrip>
      ) : null}
      <Wizard contentLayout="MultipleSteps" style={{ flex: 1, minHeight: 0 }}
        onStepChange={(e) => goto(Number((e.detail.step as HTMLElement).dataset.idx))}>
        <WizardStep titleText="Configure" icon="settings" data-idx="0" selected={step === 0}>
          <StepConfigure model={model.definition} modelId={project.modelId} lookups={lookups} entries={entries}
            onChange={setEntries} onNext={() => goto(1)} saving={update.isPending} conflicted={conflicted}
            extract={(input) => client.portal.extract(input)} />
        </WizardStep>
        <WizardStep titleText="Quantities" icon="multiselect-all" data-idx="1" selected={step === 1} disabled={conflicted}>
          <StepBatches batches={batches} onChange={setBatches} onCalculate={() => void calculate()}
            running={update.isPending || run.isPending}
            error={update.error?.message ?? run.error?.message ?? null}
            staleRun={!!latestRun && (status === "draft" || entriesDirty || batchesDirty)} />
        </WizardStep>
        <WizardStep titleText="Prices" icon="grid" data-idx="2" selected={step === 2} disabled={!runReady}>
          {runReady && latestRun ? (
            <StepCandidates model={model.definition} runEntries={latestRun.entries}
              candidates={latestRun.candidates} selection={selection}
              onToggle={(i, b) => setSel(toggleSelection(selection, i, b))}
              onNext={() => goto(3)} nextLabel="Review request"
              capped={runMeta?.capped ?? latestRun.candidates.length >= 200} widest={runMeta?.widest}
              renderDetail={(i, label) => (
                <PortalCandidateDetail label={label} model={model.definition}
                  candidate={latestRun.candidates[i]!} candidateIdx={i} selection={selection} />
              )} />
          ) : null}
        </WizardStep>
        <WizardStep titleText="Submit" icon="paper-plane" data-idx="3" selected={step === 3}
          disabled={!runReady || selection.length === 0}>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <Card header={<CardHeader titleText="Your request" subtitleText={`${chosen.length} line(s)`} />}>
              <Table headerRow={
                <TableHeaderRow>
                  <TableHeaderCell><span>Configuration</span></TableHeaderCell>
                  <TableHeaderCell horizontalAlign="End"><span>Quantity</span></TableHeaderCell>
                  <TableHeaderCell horizontalAlign="End"><span>Unit price</span></TableHeaderCell>
                  <TableHeaderCell horizontalAlign="End"><span>Total</span></TableHeaderCell>
                </TableHeaderRow>
              }>
                {chosen.map((l, i) => (
                  <TableRow key={i} rowKey={String(i)}>
                    <TableCell><Text>{l.label}</Text></TableCell>
                    <TableCell horizontalAlign="End"><Text>{fmt(l.batchQty)}</Text></TableCell>
                    <TableCell horizontalAlign="End"><Text>{fmt(l.unitPrice)}</Text></TableCell>
                    <TableCell horizontalAlign="End"><Text>{fmt(l.total)}</Text></TableCell>
                  </TableRow>
                ))}
              </Table>
              <div style={{ display: "flex", justifyContent: "flex-end", padding: "0.75rem" }}>
                <Title level="H5">Total: {fmt(grand)}</Title>
              </div>
            </Card>
            <MessageStrip design="Information" hideCloseButton>
              Prices are indicative until your supplier confirms the quote.
            </MessageStrip>
            {submit.error ? <MessageStrip design="Negative" hideCloseButton>{submit.error.message}</MessageStrip> : null}
            <Bar design="FloatingFooter" endContent={
              <Button design="Emphasized" disabled={selection.length === 0 || submit.isPending}
                onClick={() => setConfirmOpen(true)}>
                Request quote
              </Button>
            } />
          </div>
        </WizardStep>
      </Wizard>

      <Dialog open={confirmOpen} headerText="Request quote" onClose={() => setConfirmOpen(false)}
        footer={
          <Bar design="Footer" endContent={
            <>
              <Button design="Emphasized" disabled={submit.isPending}
                onClick={() => submit.mutate({
                  projectId: id,
                  selection: selection.map((s) => ({ candidateIdx: s.candidateIdx, batchQty: s.batchQty })),
                })}>
                {submit.isPending ? "Submitting…" : "Submit request"}
              </Button>
              <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
            </>
          } />
        }
      >
        <Text>Submit {chosen.length} line(s) to your supplier? The request locks until they respond, but you can withdraw it.</Text>
      </Dialog>
    </div>
  );
}
