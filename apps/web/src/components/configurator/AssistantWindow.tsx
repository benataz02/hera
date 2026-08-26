import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toORPCError } from "@orpc/client";
import {
  BusyIndicator, Button, Card, CardHeader, FileUploader, Icon, MessageStrip, ObjectStatus, Option, Select, Tag, Text, Title,
} from "@ui5/webcomponents-react";
import { PromptInput } from "@ui5/webcomponents-ai-react";
import type { Entries, ModelDef, ResolvedLookups } from "@hera/config-engine";
import type { AssistantEvent, AssistChatInput, Provider } from "@hera/assistant";
import { client, orpc } from "../../orpc.ts";
import { meQuery } from "../../orpc.ts";
import { randomUuid } from "../../uuid.ts";
import { confirm } from "../confirm.ts";
import { MIME_BY_EXT, toBase64 } from "./ExtractPanel.tsx";
import {
  applyEvent, initialChatState, recordUserEdit, revertAll, revertChange, startTurn,
  type ChatChange, type ChatMsg, type ChatState,
} from "./assistantState.ts";

// Joule-style floating Chati window. Kept as one file by design (brief's decomposition): the page
// (Task 17) mounts this once and toggles `open`; the component itself stays mounted across opens
// so conversation state survives close, matching the spec's "close keeps conversation state" rule.

const MAX_BYTES = 15 * 1024 * 1024;
const STARTER_CHIPS = ["What's left to fill?", "Fill this from a drawing", "Copy my most similar past config"];
const PROVIDER_LABEL: Record<Provider, string> = { gemini: "Gemini", anthropic: "Claude", openai: "GPT" };

type Attachment = { name: string; mimeType: "application/pdf" | "image/png" | "image/jpeg"; dataBase64: string };
type LogMsg = ChatMsg & { readOnly?: boolean };

const winStyle = (expanded: boolean): CSSProperties => ({
  position: "fixed", zIndex: 100, display: "flex", flexDirection: "column",
  borderRadius: "0.75rem", overflow: "hidden", boxShadow: "var(--sapContent_Shadow2)",
  background: "var(--sapBackgroundColor)",
  ...(expanded ? { inset: "2rem" } : { right: "1rem", bottom: "1rem", width: "26rem", height: "34rem" }),
});
// Joule palette. The header is the flat top of the same gradient the welcome hero continues, so
// the two read as one purple block when the conversation is empty.
const JOULE_TOP = "#6b21d8";
const JOULE_HERO = `linear-gradient(150deg, ${JOULE_TOP} 0%, #8d1fd2 55%, #b826c6 100%)`;
const headerStyle: CSSProperties = {
  display: "flex", alignItems: "center", gap: "0.15rem", padding: "0.5rem 0.6rem", flex: "0 0 auto",
  background: JOULE_TOP,
};
const inputRowStyle: CSSProperties = {
  display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.5rem 0.6rem",
  borderTop: "1px solid var(--sapList_BorderColor)", flex: "0 0 auto",
};

// ---- Small pure helpers ----

function relativeTime(d: Date): string {
  const mins = Math.round((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

const labelOf = (model: ModelDef, key: string) => model.parameters.find((p) => p.key === key)?.label ?? key;

function formatVal(model: ModelDef, lookups: ResolvedLookups | undefined, key: string, v: unknown): string {
  if (v === undefined || v === null) return "—";
  if (Array.isArray(v)) return v.length ? v.map((x) => formatVal(model, lookups, key, x)).join(", ") : "—";
  const opt = lookups?.domains[key]?.find((o) => o.value === v);
  return opt ? opt.label : String(v);
}

function describeError(err: unknown): { code: string; message: string } {
  const e = toORPCError(err);
  return { code: e.code, message: e.message || "Something went wrong; you can retry." };
}

/** Builds the onApply payload for a revert: `to` becomes the restore target (the row's original
 * `from`, or `null` when the key was originally unset — ChatChange.to can't express "delete"),
 * `reverted: true` stays on the row so the page's onApply can tell a revert from a fresh AI
 * apply and clear the AI marker instead of setting one — see the report's judgment call on
 * reusing `onApply` for revert (the given prop interface has no separate revert channel). */
function toRevertPayload(row: ChatChange): ChatChange {
  return { ...row, to: row.from === undefined ? null : row.from };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function formatRaw(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) return v.map((x) => String(x)).join(", ");
  return String(v);
}

const RESULT_TITLES: Record<string, string> = {
  searchSimilar: "Similar configurations", getDocHistory: "Document history", previewCandidates: "Preview",
};

/** One line item in a document-style card: bold title + key figure on the right, then a meta line
 * and a muted note beneath — the itemised layout the brief's reference screenshot uses. */
type DocLine = { key: string; title: string; keyFigure?: string; meta?: string; note?: string };

/** Defensive: `result.data` is `unknown` on the wire (events.ts). Reads each known tool's shape
 * (tools.ts) without trusting it — an unrecognized tool or malformed payload renders an empty card
 * rather than throwing. */
function resultRows(tool: string, data: unknown): DocLine[] {
  if (!isRecord(data)) return [];
  if (tool === "searchSimilar") {
    return asArray(data.rows).filter(isRecord).map((r) => {
      // First display field is the item's name; the rest become the descriptive line under it.
      const [first, ...rest] = Object.entries(isRecord(r.display) ? r.display : {});
      return {
        key: String(r.rowId ?? ""),
        title: first ? formatRaw(first[1]) : String(r.rowId ?? ""),
        note: rest.map(([k, v]) => `${k}: ${formatRaw(v)}`).join(" · ") || undefined,
        keyFigure: typeof r.score === "number" ? `${Math.round(r.score * 100)}% match` : undefined,
      };
    });
  }
  if (tool === "getDocHistory") {
    return asArray(data.rows).filter(isRecord).map((r) => ({
      key: String(r.rowId ?? ""),
      title: `${r.kind === "order" ? "Order" : "Quotation"} ${String(r.docNum ?? "")}`.trim(),
      meta: typeof r.date === "string" ? r.date.slice(0, 10) : undefined,
      note: r.qty != null ? `Quantity ${String(r.qty)}` : undefined,
      keyFigure: r.price != null ? String(r.price) : undefined,
    }));
  }
  if (tool === "previewCandidates") {
    return asArray(data.top).filter(isRecord).map((r) => ({
      key: String(r.previewId ?? ""), title: String(r.label ?? ""),
      keyFigure: r.keyFigure != null ? String(r.keyFigure) : undefined,
    }));
  }
  return [];
}

/** The card's bottom "Total"-style row: a label and a value, ruled off from the line items. */
function resultFooter(tool: string, data: unknown): { label: string; value: string } | undefined {
  if (!isRecord(data)) return undefined;
  if (tool === "getDocHistory") {
    const total = typeof data.total === "number" ? data.total : undefined;
    if (total === undefined) return undefined;
    return { label: "Documents", value: `${asArray(data.rows).length} of ${total}${data.truncated ? " · more available" : ""}` };
  }
  if (tool === "previewCandidates") {
    const count = typeof data.candidateCount === "number" ? data.candidateCount : undefined;
    return count === undefined ? undefined : { label: "Candidates", value: `${asArray(data.top).length} of ${count}` };
  }
  if (tool === "searchSimilar") return { label: "Matches", value: String(asArray(data.rows).length) };
  return undefined;
}

type ConversationTurn = Awaited<ReturnType<typeof client.assist.get>>["turns"][number];

/** Converts a page of `assist.get` turns (oldest-first) into read-only log entries. Loaded
 * messages never get revert buttons or AI markers (spec: a persisted `from` is stale against
 * today's entries) — `readOnly: true` gates that in ChatLog/AppliedValuesCard. */
function turnsToMsgs(turns: ConversationTurn[]): LogMsg[] {
  const out: LogMsg[] = [];
  for (const t of turns) {
    if (t.user) out.push({ role: "user", turnId: t.turnId, text: t.user.text, fileName: t.user.fileName, readOnly: true });
    if (t.assistant) {
      out.push({
        role: "assistant", turnId: t.turnId, text: t.assistant.text,
        changes: [...(t.assistant.changes ?? []), ...(t.assistant.invalid ?? [])],
        results: t.assistant.results, suggestions: t.assistant.suggestions,
        readOnly: true,
      });
    }
  }
  return out;
}

// ---- The window ----

export function AssistantWindow({
  open, onClose, projectId, projectVersion, model, lookups, entries, batches,
  onApply, onCandidates, onSelection, onBusyChange, chat,
}: {
  open: boolean; onClose: () => void;
  projectId: string; projectVersion: string;
  model: ModelDef; lookups?: ResolvedLookups;
  entries: Entries; batches: number[];
  onApply: (changes: ChatChange[]) => void; // page applies values + aiMarks
  onCandidates: (e: { runId: string; projectVersion: string }) => void;
  onSelection: (e: { runId: string }) => void;
  onBusyChange: (busy: boolean) => void;
  chat?: (input: AssistChatInput, opts: { signal: AbortSignal }) => Promise<AsyncIterable<AssistantEvent>>;
}) {
  const [view, setView] = useState<"chat" | "conversations">("chat");
  const [expanded, setExpanded] = useState(false);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [provider, setProvider] = useState<Provider | undefined>(undefined);
  const [aiModel, setAiModel] = useState<string | undefined>(undefined);
  const [state, setState] = useState<ChatState>(initialChatState);
  const [hydrated, setHydrated] = useState<LogMsg[]>([]);
  const [hydratedCursor, setHydratedCursor] = useState<string | null>(null);
  const [hydrating, setHydrating] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [stopping, setStopping] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const lastTurnRef = useRef<{
    turnId: string; message: string; file?: Attachment;
    provider: Provider | undefined; model: string | undefined;
  } | null>(null);
  const prevEntriesRef = useRef(entries);
  const prevBatchesRef = useRef(batches);

  const { data: me } = useQuery(meQuery);
  const providersQ = useQuery(orpc.assist.providers.queryOptions());

  const firstName = me?.user?.name?.split(" ")[0] || me?.user?.email?.split("@")[0] || "there";

  // Default the provider-model Select once the list loads, if nothing (no loaded conversation, no
  // manual pick) has set one yet.
  useEffect(() => {
    if (provider !== undefined && aiModel !== undefined) return;
    const first = providersQ.data?.[0];
    if (first) {
      setProvider(first.provider);
      setAiModel(first.model);
    }
  }, [providersQ.data, provider, aiModel]);

  // Touched-tracking: while the latest assistant message is sitting in an error state (a pending
  // retry), diff live entries/batches props against what they were last render and record any
  // user edit — so a later `snapshot` on resume marks those keys `superseded` instead of
  // silently overwriting a value the user already changed by hand.
  useEffect(() => {
    const last = state.messages.at(-1);
    const pendingError = last?.role === "assistant" && !!last.error;
    if (pendingError) {
      const prevEntries = prevEntriesRef.current;
      const changedKeys = Object.keys({ ...prevEntries, ...entries })
        .filter((k) => JSON.stringify(prevEntries[k]) !== JSON.stringify(entries[k]));
      const batchesChanged = JSON.stringify(prevBatchesRef.current) !== JSON.stringify(batches);
      if (changedKeys.length || batchesChanged) setState((s) => recordUserEdit(s, changedKeys, batchesChanged));
    }
    prevEntriesRef.current = entries;
    prevBatchesRef.current = batches;
  }, [entries, batches, state.messages]);

  const applyOpts = { onApplyValues: onApply, onCandidates, onSelection, onConversation: setConversationId };

  async function runStream(params: {
    turnId: string; message: string; file?: Attachment;
    provider: Provider | undefined; model: string | undefined;
    resume?: { lastAppliedSeq: number; touchedEntryKeys: string[]; batchesTouched: boolean };
  }) {
    const ac = new AbortController();
    abortRef.current = ac;
    onBusyChange(true);
    try {
      const input: AssistChatInput = {
        projectId, turnId: params.turnId, conversationId,
        provider: params.provider, model: params.model,
        entries, batches, projectVersion, message: params.message,
        file: params.file, resume: params.resume,
      };
      const doChat = chat ?? ((i: AssistChatInput, o: { signal: AbortSignal }) => client.assist.chat(i, o));
      const iter = await doChat(input, { signal: ac.signal });
      for await (const e of iter) setState((s) => applyEvent(s, e, applyOpts));
    } catch (err) {
      if (!ac.signal.aborted) {
        const { code, message } = describeError(err);
        setState((s) => applyEvent(
          s, { type: "error", turnId: params.turnId, seq: (s.appliedSeq[params.turnId] ?? -1) + 1, code, message, retryable: true },
          applyOpts,
        ));
      }
    } finally {
      abortRef.current = null;
      setStopping(false);
      onBusyChange(false);
      // Unconditional: the abort path above skips the synthetic `error` event (the only other
      // thing that flips this off), so without this, closing the window mid-turn leaves
      // state.busy stuck true for the rest of the mounted lifetime. Harmless no-op otherwise —
      // `done`/`error` events already set busy:false before this runs.
      setState((s) => (s.busy ? { ...s, busy: false } : s));
    }
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || state.busy) return;
    let attachment: Attachment | undefined;
    if (file) {
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      const mimeType = MIME_BY_EXT[ext];
      if (!mimeType) { setFileError("Only PDF, PNG or JPEG drawings are supported."); return; }
      if (file.size > MAX_BYTES) { setFileError("The file exceeds the 15MB limit."); return; }
      attachment = { name: file.name, mimeType, dataBase64: await toBase64(file) };
    }
    setFile(null);
    setFileError(null);
    setPromptValue("");
    const turnId = randomUuid();
    lastTurnRef.current = { turnId, message: trimmed, file: attachment, provider, model: aiModel };
    setState((s) => startTurn(s, turnId, trimmed, attachment?.name));
    await runStream({ turnId, message: trimmed, file: attachment, provider, model: aiModel });
  }

  function retry(turnId: string) {
    const last = lastTurnRef.current;
    if (!last || last.turnId !== turnId || state.busy) return;
    const resume = {
      lastAppliedSeq: state.appliedSeq[turnId] ?? -1,
      touchedEntryKeys: [...state.touched.entryKeys],
      batchesTouched: state.touched.batches,
    };
    setState((s) => ({
      ...s, busy: true,
      messages: s.messages.map((m) => (m.role === "assistant" && m.turnId === turnId ? { ...m, error: undefined } : m)),
    }));
    // Pin the provider/model captured at send time, not the live Select state — the user may have
    // switched it since the turn errored, and the server rejects a reused turnId whose pair
    // doesn't match the original with
    // TURN_IDENTITY_MISMATCH instead of resuming it.
    void runStream({
      turnId, message: last.message, file: last.file,
      provider: last.provider, model: last.model, resume,
    });
  }

  function requestClose() {
    if (state.busy) {
      setStopping(true);
      abortRef.current?.abort();
    }
    onClose();
  }

  async function pickFile(f: File | null | undefined) {
    setFileError(null);
    if (!f) return;
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    if (!MIME_BY_EXT[ext]) { setFileError("Only PDF, PNG or JPEG drawings are supported."); return; }
    if (f.size > MAX_BYTES) { setFileError("The file exceeds the 15MB limit."); return; }
    setFile(f);
  }

  async function loadConversation(id: string, before?: string) {
    setHydrating(true);
    try {
      const res = await client.assist.get({ projectId, conversationId: id, beforeTurn: before });
      const msgs = turnsToMsgs(res.turns);
      setHydrated((h) => (before ? [...msgs, ...h] : msgs));
      setHydratedCursor(res.nextCursor);
    } finally {
      setHydrating(false);
    }
  }

  function pickConversation(id: string, convProvider: Provider, convModel: string) {
    setState(initialChatState);
    setHydrated([]);
    setHydratedCursor(null);
    lastTurnRef.current = null;
    setConversationId(id);
    setProvider(convProvider);
    setAiModel(convModel);
    setView("chat");
    void loadConversation(id);
  }

  function newChat() {
    setState(initialChatState);
    setHydrated([]);
    setHydratedCursor(null);
    lastTurnRef.current = null;
    setConversationId(undefined);
    setView("chat");
  }

  function revertOne(msg: ChatMsg, key: string) {
    const result = revertChange(msg, key, entries);
    const updated = "superseded" in result ? result.superseded : result.marked;
    setState((s) => ({ ...s, messages: s.messages.map((m) => (m === msg ? updated : m)) }));
    if (!("superseded" in result)) {
      const row = result.marked.changes?.find((c) => c.key === key);
      if (row) onApply([toRevertPayload(row)]);
    }
  }

  function revertOneAll(msg: ChatMsg) {
    const result = revertAll(msg, entries);
    setState((s) => ({ ...s, messages: s.messages.map((m) => (m === msg ? result.marked : m)) }));
    const wasReverted = new Set((msg.changes ?? []).filter((c) => c.reverted).map((c) => c.key));
    const justReverted = (result.marked.changes ?? []).filter((c) => c.reverted && !wasReverted.has(c.key));
    if (justReverted.length) onApply(justReverted.map(toRevertPayload));
  }

  if (!open && !stopping) return null; // parent keeps it mounted; open gates visibility

  const logMessages: LogMsg[] = [...hydrated, ...state.messages];

  return (
    <div style={winStyle(expanded)}>
      <div style={headerStyle}>
        {view === "chat" ? (
          <Button design="Transparent" icon="navigation-left-arrow" tooltip="Conversations"
            disabled={state.busy} onClick={() => setView("conversations")} />
        ) : null}
        <Title level="H5" style={{ color: "white", flex: 1 }}>Chati</Title>
        <Select disabled={state.busy} value={provider && aiModel ? `${provider}:${aiModel}` : ""} style={{ width: "13rem" }}
          onChange={(e) => {
            const option = e.detail.selectedOption as HTMLElement;
            const p = option.dataset.provider as Provider | undefined;
            const m = option.dataset.model;
            if (p && m) {
              setProvider(p);
              setAiModel(m);
            }
          }}>
          {(providersQ.data ?? []).map((p) => (
            <Option key={`${p.provider}:${p.model}`} value={`${p.provider}:${p.model}`}
              data-provider={p.provider} data-model={p.model}>
              {PROVIDER_LABEL[p.provider]} — {p.model}
            </Option>
          ))}
        </Select>
        <Button design="Transparent" icon={expanded ? "exit-full-screen" : "full-screen"}
          tooltip={expanded ? "Collapse" : "Expand"} onClick={() => setExpanded(!expanded)} />
        <Button design="Transparent" icon="decline" tooltip="Close" onClick={requestClose} />
      </div>

      {stopping ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <BusyIndicator active delay={0} text="Stopping…" />
        </div>
      ) : view === "conversations" ? (
        <ConversationsList projectId={projectId} onPick={pickConversation} onNew={newChat} busy={state.busy} />
      ) : logMessages.length === 0 ? (
        <Welcome firstName={firstName} onChip={(t) => void send(t)} />
      ) : (
        <ChatLog messages={logMessages} model={model} lookups={lookups}
          onRevert={revertOne} onRevertAll={revertOneAll} onSuggestion={(t) => void send(t)}
          onOpenCandidates={onCandidates}
          onRetry={retry} canRetry={(turnId) => lastTurnRef.current?.turnId === turnId}
          hydratedCursor={hydratedCursor} hydrating={hydrating}
          onLoadOlder={() => conversationId && void loadConversation(conversationId, hydratedCursor ?? undefined)} />
      )}

      {fileError ? <MessageStrip design="Negative" hideCloseButton onClose={() => setFileError(null)}>{fileError}</MessageStrip> : null}
      <div style={inputRowStyle}>
        <FileUploader hideInput accept=".pdf,.png,.jpg,.jpeg" disabled={state.busy}
          onChange={(e) => void pickFile(e.target.files?.[0])}>
          <Button icon="attachment" disabled={state.busy} tooltip="Attach a drawing" />
        </FileUploader>
        {file ? <Tag interactive hideStateIcon onClick={() => setFile(null)}>{file.name} ✕</Tag> : null}
        <PromptInput style={{ flex: 1 }} placeholder="Type or speak something…" disabled={state.busy}
          value={promptValue} onInput={(e) => setPromptValue(e.target.value)}
          onSubmit={(e) => void send(e.target.value)} />
      </div>
    </div>
  );
}

// ---- Views ----

function Welcome({ firstName, onChip }: { firstName: string; onChip: (text: string) => void }) {
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>
      <div style={{ background: JOULE_HERO, padding: "1.25rem 1.25rem 2rem", flex: "0 0 auto" }}>
        {/* "ai" is the SAP-icons Joule mark; main.tsx registers AllIcons, so no per-icon import. */}
        <div style={{ display: "flex", justifyContent: "center", padding: "0.75rem 0 1.5rem" }}>
          <Icon name="da-2" style={{ width: "7rem", height: "5rem", color: "#fff" }} />
        </div>
        <Text style={{ color: "rgba(255,255,255,0.85)", display: "block" }}>Hello {firstName},</Text>
        <Title level="H1" style={{ color: "#fff" }}>How can I help you?</Title>
      </div>
      <div style={{ padding: "0.75rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <div style={{
          border: "1px solid var(--sapList_BorderColor)", borderRadius: "0.5rem", padding: "0.5rem 0.75rem",
        }}>
          <Text style={{ color: "var(--sapContent_LabelColor)" }}>Get started</Text>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
          {STARTER_CHIPS.map((c) => <Button key={c} onClick={() => onChip(c)}>{c}</Button>)}
        </div>
      </div>
    </div>
  );
}

function ChatLog({
  messages, model, lookups, onRevert, onRevertAll, onSuggestion, onOpenCandidates, onRetry, canRetry,
  hydratedCursor, hydrating, onLoadOlder,
}: {
  messages: LogMsg[]; model: ModelDef; lookups?: ResolvedLookups;
  onRevert: (msg: ChatMsg, key: string) => void; onRevertAll: (msg: ChatMsg) => void;
  onSuggestion: (text: string) => void;
  onOpenCandidates: (e: { runId: string; projectVersion: string }) => void;
  onRetry: (turnId: string) => void; canRetry: (turnId: string) => boolean;
  hydratedCursor: string | null; hydrating: boolean; onLoadOlder: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length]);

  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") { lastAssistantIdx = i; break; }
  }

  return (
    <div ref={scrollRef} style={{
      flex: 1, minHeight: 0, overflowY: "auto", padding: "0.75rem",
      display: "flex", flexDirection: "column", gap: "0.75rem",
    }}>
      {hydratedCursor ? (
        <Button design="Transparent" disabled={hydrating} onClick={onLoadOlder} style={{ alignSelf: "center" }}>
          {hydrating ? "Loading…" : "Load older"}
        </Button>
      ) : null}
      {messages.map((m, i) => (
        <Bubble key={`${m.turnId}-${m.role}-${i}`} msg={m} model={model} lookups={lookups}
          onRevert={m.readOnly ? undefined : (key) => onRevert(m, key)}
          onRevertAll={m.readOnly ? undefined : () => onRevertAll(m)}
          showSuggestions={i === lastAssistantIdx && !m.streaming}
          onSuggestion={onSuggestion}
          onOpenCandidates={onOpenCandidates}
          onRetry={() => onRetry(m.turnId)}
          canRetry={!m.readOnly && canRetry(m.turnId)} />
      ))}
    </div>
  );
}

function Bubble({
  msg, model, lookups, onRevert, onRevertAll, showSuggestions, onSuggestion, onOpenCandidates, onRetry, canRetry,
}: {
  msg: LogMsg; model: ModelDef; lookups?: ResolvedLookups;
  onRevert?: (key: string) => void; onRevertAll?: () => void;
  showSuggestions: boolean; onSuggestion: (text: string) => void;
  onOpenCandidates: (e: { runId: string; projectVersion: string }) => void;
  onRetry: () => void; canRetry: boolean;
}) {
  const isUser = msg.role === "user";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: isUser ? "flex-end" : "flex-start", gap: "0.3rem" }}>
      <div style={{
        maxWidth: "88%", padding: "0.5rem 0.75rem", borderRadius: "0.75rem",
        background: isUser ? "var(--sapButton_Emphasized_Background)" : "var(--sapList_Background)",
        color: isUser ? "var(--sapButton_Emphasized_TextColor)" : "var(--sapTextColor)",
      }}>
        {msg.text ? <Text style={{ color: "inherit", whiteSpace: "pre-wrap" }}>{msg.text}</Text> : null}
        {isUser && msg.fileName ? <div style={{ marginTop: "0.25rem" }}><Tag hideStateIcon>{msg.fileName}</Tag></div> : null}
        {!isUser && msg.streaming && !msg.text ? <BusyIndicator active delay={0} size="S" /> : null}
      </div>

      {!isUser ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", width: "88%" }}>
          {(msg.activity ?? []).map((a) => (
            <Text key={a.seq} style={{ fontStyle: "italic", opacity: 0.6, fontSize: "0.8rem" }}>{a.label}</Text>
          ))}
          {(msg.results ?? []).map((r, i) => <ResultCard key={r.resultId || i} tool={r.tool} data={r.data} />)}
          {msg.changes && msg.changes.length ? (
            <AppliedValuesCard changes={msg.changes} model={model} lookups={lookups}
              readOnly={!!msg.readOnly} onRevert={onRevert} onRevertAll={onRevertAll} />
          ) : null}
          {msg.candidates ? <RunSummaryCard candidates={msg.candidates} onOpen={() => onOpenCandidates(msg.candidates!)} /> : null}
          {msg.error ? (
            <MessageStrip design="Negative" hideCloseButton>
              {msg.error.message}
              {msg.error.retryable && canRetry ? (
                <Button design="Transparent" onClick={onRetry} style={{ marginLeft: "0.5rem" }}>Retry</Button>
              ) : null}
            </MessageStrip>
          ) : null}
          {showSuggestions && msg.suggestions?.length ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
              {msg.suggestions.map((s) => <Button key={s} design="Transparent" onClick={() => onSuggestion(s)}>{s}</Button>)}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ConversationsList({ projectId, onPick, onNew, busy }: {
  projectId: string;
  onPick: (id: string, provider: Provider, model: string) => void;
  onNew: () => void; busy: boolean;
}) {
  const qc = useQueryClient();
  const q = useQuery(orpc.assist.list.queryOptions({ input: { projectId } }));
  const del = useMutation(orpc.assist.delete.mutationOptions({
    onSuccess: () => qc.invalidateQueries({ queryKey: orpc.assist.list.queryOptions({ input: { projectId } }).queryKey }),
  }));

  const onDelete = async (id: string, title: string) => {
    const ok = await confirm({
      title: "Delete conversation", message: `Delete "${title}"? This can't be undone.`,
      actionText: "Delete", destructive: true,
    });
    if (ok) del.mutate({ projectId, conversationId: id });
  };

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0.75rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <Button design="Emphasized" icon="add" disabled={busy} onClick={onNew} style={{ alignSelf: "flex-start" }}>New chat</Button>
      {q.isPending ? <BusyIndicator active delay={0} /> : null}
      {q.error ? <MessageStrip design="Negative" hideCloseButton>{q.error.message}</MessageStrip> : null}
      {del.error ? <MessageStrip design="Negative" hideCloseButton>{del.error.message}</MessageStrip> : null}
      {q.data && q.data.items.length === 0 ? <Text>No conversations yet.</Text> : null}
      {(q.data?.items ?? []).map((c) => (
        <div key={c.id} onClick={() => { if (!busy) onPick(c.id, c.provider, c.model); }} style={{
          display: "flex", alignItems: "center", gap: "0.5rem", cursor: busy ? "default" : "pointer",
          padding: "0.4rem 0.5rem", borderRadius: "0.5rem", border: "1px solid var(--sapList_BorderColor)",
          opacity: busy ? 0.6 : 1,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontWeight: "bold", display: "block" }}>{c.title}</Text>
            <Text style={{ fontSize: "0.75rem", opacity: 0.65 }}>{relativeTime(new Date(c.updatedAt))}</Text>
          </div>
          <Button design="Transparent" icon="delete" disabled={del.isPending || busy}
            onClick={(e) => { e.stopPropagation(); void onDelete(c.id, c.title); }} />
        </div>
      ))}
    </div>
  );
}

// ---- Info cards ----

function DocLines({ rows, footer }: { rows: DocLine[]; footer?: { label: string; value: string } }) {
  return (
    <div style={{ padding: "0 1rem 0.75rem" }}>
      {rows.length === 0 ? <Text>No results.</Text> : rows.map((r, i) => (
        <div key={r.key || i} style={{
          padding: "0.6rem 0",
          borderTop: i === 0 ? undefined : "1px solid var(--sapList_BorderColor)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Text style={{ flex: 1, fontWeight: "bold" }}>{r.title}</Text>
            {r.keyFigure ? (
              <Text style={{ fontWeight: "bold", color: "var(--sapInformativeTextColor)" }}>{r.keyFigure}</Text>
            ) : null}
          </div>
          {r.meta ? <Text>{r.meta}</Text> : null}
          {r.note ? <Text style={{ color: "var(--sapContent_LabelColor)" }}>{r.note}</Text> : null}
        </div>
      ))}
      {footer ? (
        <div style={{
          display: "flex", justifyContent: "space-between", gap: "0.5rem",
          borderTop: "2px solid var(--sapList_BorderColor)", paddingTop: "0.55rem", marginTop: "0.15rem",
        }}>
          <Text style={{ fontWeight: "bold" }}>{footer.label}</Text>
          <Text style={{ fontWeight: "bold" }}>{footer.value}</Text>
        </div>
      ) : null}
    </div>
  );
}

function ResultCard({ tool, data }: { tool: string; data: unknown }) {
  return (
    <Card header={<CardHeader titleText={RESULT_TITLES[tool] ?? tool} />}>
      <DocLines rows={resultRows(tool, data)} footer={resultFooter(tool, data)} />
    </Card>
  );
}

function AppliedValuesCard({ changes, model, lookups, readOnly, onRevert, onRevertAll }: {
  changes: ChatChange[]; model: ModelDef; lookups?: ResolvedLookups; readOnly: boolean;
  onRevert?: (key: string) => void; onRevertAll?: () => void;
}) {
  const eligible = changes.filter((c) => c.valid && !c.reverted && !c.superseded);
  return (
    <Card header={<CardHeader titleText="Applied values" />}>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem", padding: "0.5rem 1rem" }}>
        {changes.map((c) => (
          <div key={c.key} style={{ opacity: c.reverted ? 0.55 : 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <ObjectStatus state={c.valid ? "Information" : "Negative"}>
                <span style={{ textDecoration: c.reverted ? "line-through" : "none" }}>
                  {labelOf(model, c.key)}: {c.from === undefined ? "—" : formatVal(model, lookups, c.key, c.from)} → {formatVal(model, lookups, c.key, c.to)}
                </span>
              </ObjectStatus>
              {!readOnly && c.valid && !c.reverted && !c.superseded ? (
                <Button design="Transparent" icon="undo" tooltip="Revert" onClick={() => onRevert?.(c.key)} />
              ) : null}
            </div>
            {c.valid ? (
              <Text style={{ fontSize: "0.7rem", opacity: 0.6 }}>{c.evidence}</Text>
            ) : (
              <ObjectStatus state="Negative">{c.reason ?? "Not applied"}</ObjectStatus>
            )}
            {c.superseded ? <Text style={{ fontSize: "0.7rem", opacity: 0.6 }}>Superseded by a later edit.</Text> : null}
          </div>
        ))}
      </div>
      {!readOnly && eligible.length >= 2 ? (
        <div style={{ padding: "0 1rem 0.75rem" }}>
          <Button design="Transparent" onClick={onRevertAll}>Revert all</Button>
        </div>
      ) : null}
    </Card>
  );
}

function RunSummaryCard({ candidates, onOpen }: {
  candidates: NonNullable<ChatMsg["candidates"]>; onOpen: () => void;
}) {
  // `top` is `unknown[]` on ChatMsg (assistantState.ts doesn't narrow it) — read defensively,
  // same approach as resultRows.
  const top: DocLine[] = candidates.top.filter(isRecord).map((t) => ({
    key: String(t.candidateId ?? ""), title: String(t.label ?? ""),
    keyFigure: t.keyFigure != null ? String(t.keyFigure) : undefined,
  }));
  return (
    <Card header={<CardHeader titleText="Candidates calculated"
      subtitleText={`${candidates.candidateCount} candidate${candidates.candidateCount === 1 ? "" : "s"}`} />}>
      <DocLines rows={top} footer={{ label: "Candidates", value: String(candidates.candidateCount) }} />
      <div style={{ padding: "0 1rem 0.75rem" }}>
        <Button design="Transparent" onClick={onOpen}>Open Candidates</Button>
      </div>
    </Card>
  );
}
