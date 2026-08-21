import { useEffect, useRef, useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Bar, BusyIndicator, Button, MessageStrip, ObjectStatus,
} from "@ui5/webcomponents-react";
import { client, orpc } from "../../orpc.ts";
import {
  missingRequiredFields,
  shouldDisableSave,
  waitWriteDoneVisible,
  writeStatusMessage,
  type WriteUiStatus,
} from "../../objectSpec.ts";
import { useObjectVariants } from "../../variants.ts";
import { EntityObjectEditor } from "../EntityObjectEditor.tsx";
import {
  clearQuoteSession,
  openQuotationNav,
  quoteSessionKey,
  readQuoteSession,
  restoreQuoteSession,
  shouldResumeWriteWatch,
  writeQuoteSession,
  type QuoteSessionStored,
} from "./quoteDraft.ts";

type Props = {
  projectId: string;
  onFooterChange?: (footer: ReactElement | undefined) => void;
};

/**
 * Configurator quote step: seeds from configs.quoteDraft, edits via EntityObjectEditor
 * (no nested ObjectPage), enqueues via configs.createQuote + entities.watchWrite.
 */
export function StepCreateQuote({ projectId, onFooterChange }: Props) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const ov = useObjectVariants("Quotations");
  const capsQ = useQuery(orpc.entities.capabilities.queryOptions({ input: { entity: "Quotations" } }));
  const draftQ = useQuery({
    ...orpc.configs.quoteDraft.queryOptions({ input: { projectId } }),
    staleTime: 0,
  });

  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(() => new Set());
  const [commandId, setCommandId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [writeStatus, setWriteStatus] = useState<WriteUiStatus>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [docEntry, setDocEntry] = useState<string | null>(null);
  const [saveErrors, setSaveErrors] = useState<string[]>([]);
  const [seededKey, setSeededKey] = useState("");
  const watchAbortRef = useRef<AbortController | null>(null);

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const metaRef = useRef({ runId, commandId, requestId, writeStatus, docEntry });
  metaRef.current = { runId, commandId, requestId, writeStatus, docEntry };

  const persist = (patch: Partial<QuoteSessionStored> & { data: Record<string, unknown> }) => {
    const m = metaRef.current;
    if (!m.runId || !m.commandId) return;
    const key = quoteSessionKey(window.location.host, projectId, m.runId);
    const stored: QuoteSessionStored = {
      runId: m.runId,
      commandId: m.commandId,
      data: patch.data,
      requestId: patch.requestId !== undefined ? patch.requestId : m.requestId,
      lastStatus: patch.lastStatus !== undefined ? patch.lastStatus : m.writeStatus,
    };
    const entry = patch.docEntry !== undefined ? patch.docEntry : m.docEntry;
    if (entry) stored.docEntry = entry;
    writeQuoteSession(key, stored);
  };

  const clearSession = () => {
    const m = metaRef.current;
    if (!m.runId) return;
    clearQuoteSession(quoteSessionKey(window.location.host, projectId, m.runId));
  };

  const watchRequest = async (rid: string) => {
    watchAbortRef.current?.abort();
    const ac = new AbortController();
    watchAbortRef.current = ac;
    try {
      const iter = await client.entities.watchWrite({ requestId: rid }, { signal: ac.signal });
      for await (const state of iter) {
        if (ac.signal.aborted) return;
        setWriteStatus(state.status);
        if (state.error) setWriteError(state.error);
        if (state.docEntry) setDocEntry(state.docEntry);
        const data = draftRef.current;
        if (data) {
          persist({
            data,
            requestId: rid,
            lastStatus: state.status,
            docEntry: state.docEntry ?? null,
          });
        }
        if (state.status === "failed") return;
        if (state.status === "done") {
          await waitWriteDoneVisible();
          if (ac.signal.aborted) return;
          clearSession();
          await qc.invalidateQueries({
            queryKey: orpc.configs.get.queryOptions({ input: { id: projectId } }).queryKey,
          });
          return;
        }
      }
    } catch (err) {
      if (ac.signal.aborted) return;
      setWriteStatus("failed");
      setWriteError(err instanceof Error ? err.message : String(err));
    }
  };

  // Seed / restore when quoteDraft lands (or selection fence changes).
  useEffect(() => {
    const seed = draftQ.data;
    if (!seed) return;
    const fence = `${seed.runId}:${seed.commandId}`;
    if (fence === seededKey) return;

    const key = quoteSessionKey(window.location.host, projectId, seed.runId);
    const restored = restoreQuoteSession(readQuoteSession(key), {
      runId: seed.runId,
      commandId: seed.commandId,
    });

    setRunId(seed.runId);
    setCommandId(seed.commandId);
    setDirtyPaths(new Set());
    setSaveErrors([]);
    setSeededKey(fence);

    if (restored) {
      setDraft(restored.data);
      setRequestId(restored.requestId);
      setWriteStatus(restored.lastStatus);
      setWriteError(null);
      setDocEntry(restored.docEntry ?? null);
      if (shouldResumeWriteWatch(restored) && restored.requestId) {
        void watchRequest(restored.requestId);
      }
    } else {
      const data = structuredClone(seed.data) as Record<string, unknown>;
      setDraft(data);
      setRequestId(null);
      setWriteStatus(null);
      setWriteError(null);
      setDocEntry(null);
      writeQuoteSession(key, {
        runId: seed.runId,
        commandId: seed.commandId,
        data,
        requestId: null,
        lastStatus: null,
      });
    }
    // watchRequest is stable enough via refs; intentional seed-only deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftQ.data, projectId, seededKey]);

  useEffect(() => {
    return () => {
      watchAbortRef.current?.abort();
      watchAbortRef.current = null;
    };
  }, []);

  const createQuote = async () => {
    const data = draftRef.current;
    const m = metaRef.current;
    if (!data || !m.commandId || !m.runId) return;
    if (shouldDisableSave(m.writeStatus) || m.docEntry) return;
    const profile = draftQ.data?.profile ?? null;
    const missing = missingRequiredFields(profile, data);
    if (missing.length) {
      setSaveErrors(missing);
      return;
    }
    setSaveErrors([]);
    setWriteError(null);
    setWriteStatus("submitting");

    watchAbortRef.current?.abort();
    const ac = new AbortController();
    watchAbortRef.current = ac;

    try {
      const { requestId: rid } = await client.configs.createQuote({
        projectId,
        runId: m.runId,
        commandId: m.commandId,
        data,
      });
      setRequestId(rid);
      setWriteStatus("pending");
      persist({ data, requestId: rid, lastStatus: "pending" });

      const iter = await client.entities.watchWrite({ requestId: rid }, { signal: ac.signal });
      for await (const state of iter) {
        if (ac.signal.aborted) return;
        setWriteStatus(state.status);
        if (state.error) setWriteError(state.error);
        if (state.docEntry) setDocEntry(state.docEntry);
        persist({
          data: draftRef.current ?? data,
          requestId: rid,
          lastStatus: state.status,
          docEntry: state.docEntry ?? null,
        });
        if (state.status === "failed") {
          // Keep draft + deterministic commandId (same fence on retry).
          return;
        }
        if (state.status === "done") {
          await waitWriteDoneVisible();
          if (ac.signal.aborted) return;
          clearSession();
          await qc.invalidateQueries({
            queryKey: orpc.configs.get.queryOptions({ input: { id: projectId } }).queryKey,
          });
          return;
        }
      }
    } catch (err) {
      if (ac.signal.aborted) return;
      setWriteStatus("failed");
      setWriteError(err instanceof Error ? err.message : String(err));
      if (draftRef.current) persist({ data: draftRef.current, lastStatus: "failed" });
    }
  };

  const createRef = useRef(createQuote);
  createRef.current = createQuote;

  const openQuotation = () => {
    if (!docEntry) return;
    void navigate(openQuotationNav(docEntry));
  };
  const openRef = useRef(openQuotation);
  openRef.current = openQuotation;

  const statusStrip = writeStatusMessage(writeStatus, writeError);
  const submitDisabled =
    !draft ||
    !capsQ.data?.canCreate ||
    shouldDisableSave(writeStatus) ||
    (!!docEntry && writeStatus === "done");
  const showOpen = !!docEntry && (writeStatus === "done" || writeStatus === null);

  useEffect(() => {
    if (!onFooterChange) return;
    onFooterChange(
      <Bar
        design="FloatingFooter"
        startContent={
          statusStrip ? (
            <MessageStrip design={statusStrip.design} hideCloseButton>
              {statusStrip.text}
            </MessageStrip>
          ) : saveErrors.length ? (
            <ObjectStatus state="Critical">Required: {saveErrors.join(", ")}</ObjectStatus>
          ) : null
        }
        endContent={
          showOpen ? (
            <Button design="Emphasized" onClick={() => openRef.current()}>
              Open quotation
            </Button>
          ) : (
            <Button
              design="Emphasized"
              disabled={submitDisabled}
              onClick={() => void createRef.current()}
            >
              {shouldDisableSave(writeStatus) ? "Creating…" : "Create quote"}
            </Button>
          )
        }
      />,
    );
    return () => onFooterChange(undefined);
  }, [
    onFooterChange,
    statusStrip?.design,
    statusStrip?.text,
    saveErrors,
    showOpen,
    submitDisabled,
    writeStatus,
  ]);

  if (draftQ.isPending || capsQ.isPending || ov.isLoading || !ov.ready) {
    return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "2rem" }} />;
  }
  if (draftQ.error) {
    return (
      <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem 0" }}>
        {draftQ.error.message}
      </MessageStrip>
    );
  }
  if (!draftQ.data?.schema || !draftQ.data.profile) {
    return (
      <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem 0" }}>
        Quotations is not enabled for write, or no profile is available.
      </MessageStrip>
    );
  }
  if (!ov.selectedId) {
    return (
      <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem 0" }}>
        No object view is available for Quotations.
      </MessageStrip>
    );
  }
  if (!draft || !commandId) {
    return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "2rem" }} />;
  }

  const { schema, profile } = draftQ.data;
  const capabilities = capsQ.data ?? { canEdit: false, canCreate: false };
  const editorCaps = {
    canEdit: !!capabilities.canCreate,
    canCreate: !!capabilities.canCreate,
    reason: capabilities.reason,
  };

  return (
    <EntityObjectEditor
      entity="Quotations"
      schema={schema}
      profile={profile}
      record={draft}
      draft={draft}
      dirtyPaths={dirtyPaths}
      variant={ov.definition}
      capabilities={editorCaps}
      writeStatus={writeStatus}
      writeError={writeError}
      onDraftChange={(next, paths) => {
        setDraft(next);
        setDirtyPaths(paths);
        persist({ data: next });
      }}
      onVariantChange={(id) => ov.select(id)}
      onSubmit={() => void createRef.current()}
      onCancel={() => {}}
    />
  );
}
