import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar, Button, BusyIndicator, Dialog, DynamicSideContent, Label, MessageStrip, ObjectPage,
  ObjectPageSection, ObjectPageSubSection, ObjectPageTitle, ObjectStatus,
  Text, TextArea, Title, ToggleButton, Toolbar,
} from "@ui5/webcomponents-react";
import { propagate, type Entries } from "@hera/config-engine";
import type { Val } from "@hera/config-engine";
import { orpc } from "../../orpc.ts";
import { useSectionParam } from "../../sectionParam.ts";
import { toast } from "../toast.ts";
import { cleanOverrides, statusUi, toggleSelection, type Sel } from "./runView.ts";
import { BatchEditor, ConfiguratorForm, ConsistencyStatus } from "./ConfiguratorForm.tsx";
import { ConfigGeneral, missingGeneral } from "./ConfigGeneral.tsx";
import { StepCandidatesReview } from "./StepCandidatesReview.tsx";
import { InsightsRail } from "./InsightsRail.tsx";
import { AssistantWindow } from "./AssistantWindow.tsx";
import type { ChatChange } from "./assistantState.ts";
import { ToBeDone } from "../Boundaries.tsx";
import {
  buildCalculationUpdate, CONFIG_PROCESS_STEP_IDS, POST_RUN_STEP, stepFromSection,
} from "./configProcessState.ts";

// The configuration process as an ObjectPage in IconTabBar mode: each step (
// Configure → Candidates → Create quote) is an ObjectPageSection shown as a tab, gated left to
// right like the old wizard (locked steps are disabled tabs); the config model's sections render
// as ObjectPageSubSections inside Configure. The floating footer carries the step actions.
// Local state overlays server state (override ?? server value) until a mutation persists it.
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

  // The current step is the ObjectPage section, and it lives in `?section=` (see useSectionParam).
  const [section, setSection] = useSectionParam();
  const gotoStep = (i: number) => setSection(CONFIG_PROCESS_STEP_IDS[i]!);
  const [entriesOverride, setEntries] = useState<Entries | null>(null);
  const [batchesOverride, setBatches] = useState<number[] | null>(null);
  const [selOverride, setSel] = useState<Sel[] | null>(null);
  const [runMeta, setRunMeta] = useState<{ capped: boolean; widest?: { key: string; size: number } } | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [note, setNote] = useState("");
  // Which insight panels are expanded. Lives here (not in the rail) so switching Configure ↔
  // Candidates doesn't reset it. Panel's `fixed` keeps the last open one from collapsing.
  const [openPanels, setOpenPanels] = useState(new Set(["costs"]));
  const togglePanel = (k: string) =>
    setOpenPanels((o) => {
      if (!o.has(k)) return new Set(o).add(k);
      if (o.size === 1) return o; // last one open — `fixed` blocks this anyway
      const n = new Set(o);
      n.delete(k);
      return n;
    });
  // Chati: the floating assistant window is always mounted (so its conversation survives close)
  // and toggled via `chatOpen`. `aiMarks` drives the "AI" chip in ConfiguratorForm; `assistantBusy`
  // gates form/batches/Calculate/Save-selection while a turn is in flight; `assistantProjectVersion`
  // tracks the project version Chati last observed (from its own `candidates` events) so a stale
  // browser tab doesn't reuse a version that predates the run it just triggered.
  const [chatOpen, setChatOpen] = useState(false);
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [aiMarks, setAiMarks] = useState<Map<string, string>>(new Map());
  const [assistantProjectVersion, setAssistantProjectVersion] = useState<string | null>(null);

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
        gotoStep(POST_RUN_STEP);
        toast(`${r.candidateCount} candidate${r.candidateCount === 1 ? "" : "s"} calculated`);
      },
    }),
  );
  const select = useMutation(orpc.configs.select.mutationOptions({
    onSuccess: () => { invalidate(); toast("Selection saved"); },
  }));

  if (q.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;
  if (q.error)
    return <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>{q.error.message}</MessageStrip>;
  const { project, model, latestRun, createdByEmail } = q.data;

  const entries = entriesOverride ?? project.entries;
  const batches = batchesOverride ?? project.batches;
  const selection = selOverride ?? latestRun?.selection ?? [];
  const runReady = !!latestRun && project.status !== "draft";

  const copyValues = (values: Record<string, Val>) => {
    const next = { ...entries };
    for (const [k, v] of Object.entries(values)) {
      const cur = next[k];
      if ((cur === undefined || cur === null || cur === "") && v !== null && v !== undefined) next[k] = v;
    }
    setEntries(next); // fills only empty params; ConfiguratorForm's propagate() takes it from here
  };

  // ConfiguratorForm's onChange, wrapped: a manual edit to a key Chati just set means that AI value
  // no longer describes what's on screen, so its "AI" chip must go — keep only the marks whose value
  // survived the edit untouched.
  const changeEntries = (next: Entries) => {
    setEntries(next);
    const kept = [...aiMarks].filter(([k]) => JSON.stringify(entries[k]) === JSON.stringify(next[k]));
    if (kept.length !== aiMarks.size) setAiMarks(new Map(kept));
  };

  // Chati's onApply: reused for both a forward AI-set value and a revert (ChatChange.reverted).
  // Forward rows merge `to` into entries and mark the key with its evidence; revert rows merge the
  // restore target and clear the mark instead (the value is going back to what it was, not being
  // freshly AI-set). `to` is a real Val on every row (never omitted — see ChangeRowZ); a revert
  // that restores an originally-unset key encodes that as `to: null` (AssistantWindow's
  // toRevertPayload), which we read as "delete the key", matching how the rest of this form
  // treats an absent/null value as unset.
  const applyAssistantChanges = (changes: ChatChange[]) => {
    const next = { ...entries };
    const nextMarks = new Map(aiMarks);
    for (const c of changes) {
      // `to === null` means "delete this key" (a revert of an originally-unset key). This relies on
      // apps/server/src/extraction.ts's validateSuggestionSet filtering null-valued suggestions out
      // before they ever become a forward ChangeRow — so a null `to` here can only be a revert, never
      // a genuine AI-set value. Revisit this delete-convention if that filter ever changes.
      if (c.to === null || c.to === undefined) delete next[c.key];
      else next[c.key] = c.to as Val;
      if (c.reverted) nextMarks.delete(c.key);
      else nextMarks.set(c.key, c.evidence);
    }
    setEntries(next);
    setAiMarks(nextMarks);
  };

  // ConsistencyStatus renders the message; prop here only gates Calculate/navigation.
  const prop = lookups.data ? propagate(model.definition, lookups.data, entries) : null;
  const conflicted = !!prop && prop.conflicts.length > 0;
  const entriesDirty = JSON.stringify(entries) !== JSON.stringify(project.entries);
  const batchesDirty = JSON.stringify(batches) !== JSON.stringify(project.batches);
  const staleRun = !!latestRun && (project.status === "draft" || entriesDirty || batchesDirty);

  // The Candidates tab is disabled while inputs are dirty/stale (see tabRef on its section),
  // so the only navigation the user can trigger here is back to Configure — which needs no save.
  // Forward motion goes exclusively through Calculate (which awaits the update), so we never
  // fire-and-forget a save that would flip status to "draft" and blank the step just landed on.
  //
  // A URL can still point at a locked step (bookmark to ?section=candidates on a since-reset
  // project), so stepFromSection clamps it. Exception: while a refetch is in flight the lock
  // verdict rests on stale data — right after Calculate the fresh run hasn't landed yet — so
  // don't count it as locked, or the user gets bounced off Candidates and back a moment later.
  const candidatesLocked = (!runReady || staleRun) && !q.isFetching;
  const step = stepFromSection(section, project.status, candidatesLocked);
  const calculate = async (calculationEntries: Entries = entries) => {
    try {
      const updateInput = buildCalculationUpdate(
        id, project.entries, calculationEntries, project.batches, batches,
      );
      if (updateInput) await update.mutateAsync(updateInput);
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

  const calcBusy = update.isPending || run.isPending;

  // Mandatory General fields, judged on what is persisted — a half-typed name never counts.
  const missing = missingGeneral({ name: project.name, customer: project.customer ?? null });

  const configureFooter = (
    <Bar design="FloatingFooter"
      startContent={
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <ConsistencyStatus model={model.definition} lookups={lookups.data} entries={entries} />
          {missing.length ? <ObjectStatus state="Critical">{missing.join(" and ")} required</ObjectStatus> : null}
          {staleRun ? <ObjectStatus state="Critical">inputs changed — calculate again</ObjectStatus> : null}
        </div>
      }
      endContent={
        <Button design="Emphasized"
          disabled={conflicted || missing.length > 0 || lookups.isPending || batches.length === 0 || calcBusy || assistantBusy}
          onClick={() => void calculate()}>
          {calcBusy ? "Calculating…" : "Calculate"}
        </Button>
      } />
  );

  const candidatesFooter = (
    <Bar design="FloatingFooter"
      startContent={
        <Text>
          {selection.length} quotation line{selection.length === 1 ? "" : "s"} selected
        </Text>
      }
      endContent={
        <Button design="Emphasized" disabled={select.isPending || selection.length === 0 || assistantBusy} onClick={saveSelection}>
          {select.isPending ? "Saving…" : "Save selection"}
        </Button>
      } />
  );

  // No ObjectPageHeader: the "requested" context moved into the title's subHeader (with Reject next
  // to the other title actions), and the errors below the title — they render only when there is
  // something to say, so nothing eats vertical space in the normal case.
  const messages = lookups.error || update.error || run.error ? (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", padding: "0.5rem 1rem 0" }}>
      {lookups.error ? (
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <MessageStrip design="Negative" hideCloseButton style={{ flex: 1 }}>{lookups.error.message}</MessageStrip>
          <Button onClick={() => lookups.refetch()}>Retry</Button>
        </div>
      ) : null}
      {update.error || run.error ? (
        <MessageStrip design="Negative" hideCloseButton>
          {update.error?.message ?? run.error?.message}
        </MessageStrip>
      ) : null}
    </div>
  ) : null;

  // The rail sits OUTSIDE the ObjectPage: ObjectPage collects sub-tabs from direct children only,
  // so wrapping the subsections would silently drop Configure's sub-anchor tabs.
  // DynamicSideContent handles the responsive drop-below itself — no media queries, no animation.
  // Its host sets container-type:inline-size, which makes it a containing block for position:fixed —
  // so the floating Chati window stays a sibling, outside it, or it would anchor to this box.
  return (
    <>
    <DynamicSideContent
      sideContentVisibility="AlwaysShow" hideSideContent={step === 2}
      sideContent={
        <InsightsRail projectId={id} model={model.definition} lookups={lookups.data} entries={entries}
          onCopy={copyValues} open={openPanels} onToggle={togglePanel} />
      }>
    
    {messages}
    <ObjectPage
      hidePinButton
      mode="IconTabBar"
      selectedSectionId={CONFIG_PROCESS_STEP_IDS[step]}
      onSelectedSectionChange={(e) => setSection(e.detail.selectedSectionId)}
      titleArea={
        <ObjectPageTitle
          header={<Title level="H5">{project.name}</Title>}
          subHeader={
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
              <Text>{model.name}</Text>
              <ObjectStatus state={statusUi[project.status].state}>{statusUi[project.status].text}</ObjectStatus>
              {project.status === "requested" ? (
                <Text>
                  Requested by {createdByEmail ?? "a portal user"} for {project.customer?.cardName ?? "—"}
                </Text>
              ) : null}
            </div>
          }
          actionsBar={
            <Toolbar design="Transparent">
              {project.status === "requested" ? (
                <Button design="Negative" onClick={() => setRejectOpen(true)}>Reject</Button>
              ) : null}
              <ToggleButton icon="ai" pressed={chatOpen} onClick={() => setChatOpen(!chatOpen)}>
                Chati
              </ToggleButton>
            </Toolbar>
          }
        />
      }
      footerArea={step === 0 ? configureFooter : step === 1 ? candidatesFooter : undefined}
      placeholder={calcBusy ? (
        <BusyIndicator active delay={0} text="Calculating candidates — pricing up to 200 combinations…"
          style={{ width: "100%", marginTop: "4rem" }} />
      ) : undefined}
    >
      <ObjectPageSection id="configure" titleText="Configure" hideTitleText>
        <ObjectPageSubSection id="general" titleText="General">
          <ConfigGeneral name={project.name} modelId={project.modelId} customer={project.customer ?? null}
            disabled={assistantBusy || update.isPending}
            onChange={(patch) => {
              // A model switch wipes entries/batches server-side; drop the local overlays too,
              // or the old model's values would be re-applied on top of the new form.
              if (patch.modelId) { setEntries(null); setBatches(null); setSel(null); }
              update.mutate({ id, ...patch });
            }} />
        </ObjectPageSubSection>
        <ObjectPageSubSection id="batches" titleText="Batch quantities">
          <BatchEditor batches={batches} onChange={setBatches} disabled={assistantBusy} />
        </ObjectPageSubSection>
        {model.definition.structure.sections.map((s) => (
          <ObjectPageSubSection key={s.key} id={s.key} titleText={s.title}>
            <ConfiguratorForm section={s.key} model={model.definition} lookups={lookups.data} entries={entries}
              onChange={changeEntries} loading={lookups.isFetching}
              aiMarks={aiMarks} disabled={assistantBusy} />
          </ObjectPageSubSection>
        ))}
      </ObjectPageSection>
      {/* wizard gating lives on the underlying ui5-tab: the inline tabRef re-runs every render,
          keeping disabled in sync — a disabled tab can't be selected, like the old WizardStep. */}
      <ObjectPageSection id="candidates" titleText="Candidates" hideTitleText
        tabRef={(el) => { if (el) el.disabled = !runReady || staleRun; }}>
        {runReady && latestRun ? (
          <StepCandidatesReview model={latestRun.modelSnapshot} lookups={latestRun.lookupSnapshot}
            runEntries={latestRun.entries} candidates={latestRun.candidates}
            selection={selection}
            onToggle={(i, b) => { if (select.isSuccess) select.reset(); setSel(toggleSelection(selection, i, b)); }}
            onChange={(next) => { if (select.isSuccess) select.reset(); setSel(next); }}
            capped={runMeta?.capped ?? latestRun.candidates.length >= 200}
            widest={runMeta?.widest}
            error={select.error?.message ?? null} saved={select.isSuccess} />
        ) : null}
      </ObjectPageSection>
      <ObjectPageSection id="quote" titleText="Create quote" hideTitleText
        tabRef={(el) => { if (el) el.disabled = true; }}>
        <ToBeDone what="Quote creation" />
      </ObjectPageSection>
    </ObjectPage>
    </DynamicSideContent>

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

    <AssistantWindow open={chatOpen} onClose={() => setChatOpen(false)}
      projectId={id} projectVersion={assistantProjectVersion ?? project.updatedAt.toISOString()}
      model={model.definition} lookups={lookups.data} entries={entries} batches={batches}
      onApply={applyAssistantChanges}
      onCandidates={(e) => { invalidate(); setSel([]); gotoStep(POST_RUN_STEP); setAssistantProjectVersion(e.projectVersion); }}
      onSelection={() => { invalidate(); setSel(null); }}
      onBusyChange={setAssistantBusy} />
    </>
  );
}
