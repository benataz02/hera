import { createHash } from "node:crypto";
import { ORPCError, withEventMeta } from "@orpc/server";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { db, configProject } from "@hera/db";
import {
  domainOf, propagate,
  type Entries, type ModelDef, type ResolvedLookups, type Val,
} from "@hera/config-engine";
import {
  AssistantEventZ, TOOLS, byteSize, canonicalJson, staleResult,
  makeSetValuesInputZ, makePreviewCandidatesInputZ,
  assistantConversation, assistantMessage, assistantTurn,
  MAX_TOOL_RESULT_BYTES,
  type AssistantEvent, type AssistChatInput, type ChangeRow, type Evidence, type ExtractFile,
  type MessageContent, type Provider, type ToolName, type UiChange,
} from "@hera/assistant";
import { loadModel, enrichedLookups } from "../orpc/routers/configs.ts";
import { buildAssistPrompt } from "./prompt.ts";
import { ProviderApiError, resolveProvider } from "./provider.ts";
import { createExecutors, type ExecutorCtx, type Working } from "./executors.ts";
import { makeChatAdapter, type ToolDecl } from "./adapter.ts";
import { makePolicy } from "./policy.ts";
import { validateFile } from "./validate-file.ts";
import { auditLine as audit } from "./audit.ts";
import {
  allocSeq, bumpCounters, claimTurn, claimTurnWithNewConversation, claimWrapUp, finalizeTurn,
  renewLease, runToolOperation, updateWorking,
  LEASE_RENEW_MS, type TurnRow,
} from "./turns.ts";


// The turn engine. Everything it needs is imported directly — `db`, the project/model loaders,
// the executors, the provider adapter, policy and audit. There is no injected `AssistantDeps`
// seam: this module and its collaborators all live in apps/server, and the one genuinely shared
// surface (tables, wire events, tool declarations, the chat input contract) is @hera/assistant.
//
// oRPC findings (orpc skill, confirmed against the installed @orpc/server types before writing
// `chat` in router.ts): `eventIterator` from "@orpc/server" wraps an output zod schema for a
// streaming procedure; the handler is a plain `async function*` receiving `{ input, context,
// signal, lastEventId }` — `signal` is a real `AbortSignal` that aborts on client disconnect,
// no extra plumbing needed. `withEventMeta(data, { id })` stamps a per-event SSE id (used here as
// `${turnId}:${seq}`) without adding an enumerable field, so it round-trips through the strict
// `AssistantEventZ` output validation untouched.

// ---- Global constants (plan's "Global Constraints" section, copied verbatim) ----
const MAX_ITERATIONS = 8;
const MAX_TOOL_CALLS = 8; // executedToolCallCount ceiling, across all attempts of a turnId
const MAX_PROVIDER_CALLS = 9; // 8 loop + 1 wrap-up. Extraction retries live inside the executor and never reach bumpCounters.
const MAX_OUTPUT_TOKENS_PER_CALL = 2048;
const MAX_OUTPUT_TOKENS_PER_TURN = 8192;
const WRAP_UP_RESERVE_TOKENS = 512;
const MAX_INPUT_TOKENS_PER_CALL = 32_000;
const MAX_INPUT_TOKENS_PER_TURN = 128_000;
const TURN_WATCHDOG_MS = 120_000;
const TOOL_TIMEOUT_MS = 30_000;
const EXTRACTION_TIMEOUT_MS = 60_000;
const CONTEXT_TURN_LIMIT = 20; // last 20 whole turns

const STATE_BOUND_TOOLS = new Set<ToolName>(["setValues", "extractFromDrawing", "previewCandidates", "calculate", "selectCandidates"]);
const RESULT_TOOLS = new Set<ToolName>(["searchSimilar", "getDocHistory", "previewCandidates"]);

const policy = makePolicy();

/** The project fields the engine reads. */
async function loadProject(tenantId: string, projectId: string) {
  const [p] = await db
    .select({
      id: configProject.id, updatedAt: configProject.updatedAt, entries: configProject.entries,
      batches: configProject.batches, customer: configProject.customer, status: configProject.status,
      modelId: configProject.modelId,
    })
    .from(configProject)
    .where(and(eq(configProject.id, projectId), eq(configProject.tenantId, tenantId)))
    .limit(1);
  return p ?? null;
}

/** The candidates a prior attempt of this turn already computed. Re-hydrates `state.lastRun` on
 *  resume so the prompt's candidate count stays accurate and `selectCandidates` evidence keeps
 *  resolving — the durable freeze itself comes from `assistantTurn.calculated`, not this lookup. */
async function loadCandidates(tenantId: string, projectId: string) {
  const [r] = await db
    .select({ candidates: configProject.candidates })
    .from(configProject)
    .where(and(eq(configProject.id, projectId), eq(configProject.tenantId, tenantId)))
    .limit(1);
  return r ? { candidates: r.candidates } : null;
}

// ---- Small named helpers (per the brief) ----

/** Stamp the SSE event id `{turnId}:{seq}` — a non-enumerable meta field, invisible to
 *  AssistantEventZ's strict output validation. */
function eventFor(e: AssistantEvent): AssistantEvent {
  return withEventMeta(e, { id: `${e.turnId}:${e.seq}` });
}

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");
const estimateTokens = (s: string) => Math.ceil(s.length / 4);

// Stable error codes this engine throws internally (turns.ts fences, resolveProvider, the
// resume-divergence guard). Anything outside this set — such as a DB driver error — is arbitrary
// content that must NOT reach the audit log, the persisted `turn.errorCode`, or the wire, so it
// collapses to a generic INTERNAL_ERROR. ProviderApiError has already been sanitized at the
// provider boundary; oRPC errors keep their own stable `code` enum (never their free-form message).
const KNOWN_ERROR_CODES = new Set([
  "LEASE_LOST", "OPERATION_IN_FLIGHT", "MAX_ATTEMPTS", "PROVIDER_UNAVAILABLE",
  "STATE_CHANGED", "CONTEXT_TOO_LARGE", "INVALID_TOOL_OUTPUT",
]);
function classifyTurnError(e: unknown): string {
  if (e instanceof ProviderApiError) return e.code;
  if (e instanceof ORPCError) return e.code;
  const msg = e instanceof Error ? e.message : String(e);
  return KNOWN_ERROR_CODES.has(msg) ? msg : "INTERNAL_ERROR";
}

/** `name:sha256(args):relevant` — relevant is the fencing dimension a tool's own input doesn't
 *  already capture: the attachment hash for extraction, the observed project version for the two
 *  agent-backed read tools and for selections (a recalculate moves that version, which is exactly
 *  when a candidateId stops meaning what it meant), and the working revision otherwise
 *  (setValues/previewCandidates/calculate/suggestFollowUps all read/write the working copy). */
function operationKeyFor(
  name: ToolName, args: unknown, workingRevision: number, projectVersion: string,
  attachmentSha256: string | undefined,
): string {
  const argsHash = sha256Hex(canonicalJson(args));
  const relevant =
    name === "extractFromDrawing" ? `file:${attachmentSha256 ?? "none"}`
    : (name === "selectCandidates" || name === "getDocHistory" || name === "searchSimilar") ? `pv:${projectVersion}`
    : `rev:${workingRevision}`;
  return `${name}:${argsHash}:${relevant}`;
}

// ---- Provider-neutral message shape, owned by this package (see report re: makeChatAdapter's
// `messages: unknown[]` being deliberately opaque — Task 14 maps this to TanStack AI's own
// per-provider native format). ----
export type ModelPart =
  | { type: "text"; text: string }
  | { type: "toolCall"; id: string; name: string; args: unknown; metadata?: unknown }
  | { type: "toolResult"; id: string; name: string; result: unknown };
export type Msg = { role: "user"; text: string } | { role: "assistant"; parts: ModelPart[] };

function summarizeReadResult(result: unknown): unknown {
  if (!result || typeof result !== "object" || (result as { ok?: unknown }).ok !== true) return result;
  const r = result as Record<string, unknown>;
  const rows = Array.isArray(r.rows) ? r.rows.length : undefined;
  const observedAt = typeof r.observedAt === "string" ? r.observedAt
    : typeof r.observedProjectVersion === "string" ? r.observedProjectVersion : undefined;
  return { ok: true, stale: false, summary: rows !== undefined ? `${rows} rows observed earlier` : "observed earlier", observedAt };
}

function staleProjectPart(p: ModelPart, observedVersion: string): ModelPart {
  if (p.type !== "toolResult") return p;
  if (STATE_BOUND_TOOLS.has(p.name as ToolName)) {
    const orig = p.result as Record<string, unknown> | null;
    const ov = orig && typeof orig === "object" && typeof orig.observedProjectVersion === "string" ? orig.observedProjectVersion
      : orig && typeof orig === "object" && typeof orig.projectVersion === "string" ? orig.projectVersion : observedVersion;
    return { ...p, result: staleResult(ov) };
  }
  return { ...p, result: summarizeReadResult(p.result) };
}
function capPart(p: ModelPart): ModelPart {
  if (p.type !== "toolResult" || byteSize(p.result) <= MAX_TOOL_RESULT_BYTES) return p;
  return { ...p, result: { truncated: true, note: "result omitted from context: too large" } };
}

/** Builds the `[{user},{assistant}]` groups for the last N whole turns, oldest-first. Only the
 *  newest prior turn's tool results are kept complete (capped defensively); everything older is
 *  stale-projected: state-bound results collapse to `staleResult(...)`, the two read tools get a
 *  bounded summary with ids stripped (never split a call/result pair either way). */
function projectTranscript(rows: { userText: string; parts: ModelPart[] }[], observedVersion: string): Msg[][] {
  return rows.map((r, i) => {
    const isNewest = i === rows.length - 1;
    const parts = r.parts.map((p) => (isNewest ? capPart(p) : staleProjectPart(p, observedVersion)));
    return [{ role: "user" as const, text: r.userText }, { role: "assistant" as const, parts }];
  });
}

function toolDeclsFor(model: ModelDef): ToolDecl[] {
  const keys = model.parameters.map((p) => p.key);
  return (Object.keys(TOOLS) as ToolName[]).map((name) => {
    const t = TOOLS[name];
    return {
      name, kind: t.kind, label: t.label, description: t.description,
      input: name === "setValues" ? makeSetValuesInputZ(keys)
        : name === "previewCandidates" ? makePreviewCandidatesInputZ(keys)
        : t.input,
      output: t.output,
    };
  });
}

function toChangeRow(c: UiChange): ChangeRow {
  return { key: c.key, from: c.from as ChangeRow["from"], to: c.to as ChangeRow["to"], evidence: c.evidence, provenance: c.provenance, valid: c.valid, reason: c.reason };
}

/** Zips the tool RESULT's per-key change rows (no provenance — that lives on the call's input)
 *  back together with the ORIGINAL setValues input's structured evidence, by key. */
function buildChangeRows(
  inputValues: { key: string; value: Val; evidence: Evidence }[],
  resultChanges: { key: string; from?: Val; to: Val; evidence: string; valid: boolean; reason?: string }[],
): UiChange[] {
  const provOf = new Map(inputValues.map((v) => [v.key, v.evidence]));
  return resultChanges.map((c) => ({
    key: c.key, from: c.from, to: c.to, evidence: c.evidence, valid: c.valid, reason: c.reason,
    provenance: provOf.get(c.key) ?? { source: "user", detail: c.evidence },
  }));
}

function validateEntries(model: ModelDef, lookups: ResolvedLookups, entries: Entries): void {
  for (const [key, v] of Object.entries(entries)) {
    const p = model.parameters.find((pp) => pp.key === key);
    if (!p) throw new ORPCError("BAD_REQUEST", { message: `Unknown parameter: ${key}` });
    if (p.ui === "multicombo") {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
        throw new ORPCError("BAD_REQUEST", { message: `${key} must be a list of strings` });
      continue;
    }
    if (Array.isArray(v) || (v !== null && typeof v !== p.type))
      throw new ORPCError("BAD_REQUEST", { message: `${key} has the wrong type` });
    if (v !== null && v !== undefined) {
      const domain = domainOf(model, lookups, key);
      const queryBacked = p.domain?.kind === "options" && p.domain.ref.source === "query";
      if (!queryBacked && domain.length && !domain.some((o) => o.value === v))
        throw new ORPCError("BAD_REQUEST", { message: `${key} is not one of the allowed values` });
    }
  }
}

function attachmentOf(file: ExtractFile | undefined) {
  if (!file) return undefined;
  return { name: file.name, mime: file.mimeType, sha256: createHash("sha256").update(Buffer.from(file.dataBase64, "base64")).digest("hex") };
}

function snapshotEvent(turn: TurnRow, seq: number, ui: MessageContent["ui"] | undefined, status: "running" | "partial" | "complete" | "failed"): AssistantEvent {
  return {
    type: "snapshot", turnId: turn.id, seq,
    text: ui?.text ?? "", changes: (ui?.changes ?? []).map(toChangeRow),
    results: ui?.results ?? [],
    suggestions: ui?.suggestions, status, projectVersion: turn.latestProjectVersion.toISOString(),
  };
}

// NOTE: `setValues` is deliberately NOT handled here — its "changes" event needs the ORIGINAL
// call's structured per-key evidence (source: user/drawing/similar/document) to build correct
// provenance, which `buildChangeRows` already resolves at the call site; reconstructing a
// generic `{source:"user"}` here (as an earlier draft of this function did) would silently
// discard drawing/similar/document provenance on the WIRE EVENT while the persisted UI
// projection (built from the same `buildChangeRows` call) stayed correct — a real
// provenance-integrity bug, not a style choice. See the setValues branch in the main loop.
function domainEventFor(name: ToolName, turnId: string, seq: number, out: Record<string, unknown>): AssistantEvent | null {
  if (out.ok !== true || out.stale === true) return null;
  switch (name) {
    case "searchSimilar": case "getDocHistory": case "previewCandidates":
      return { type: "result", turnId, seq, tool: name, resultId: out.resultId as string, observedProjectVersion: out.observedProjectVersion as string, data: out };
    case "calculate":
      return { type: "candidates", turnId, seq, projectVersion: out.projectVersion as string, candidateCount: out.candidateCount as number, top: out.top as { candidateId: string; label: string; keyFigure?: string }[] };
    case "selectCandidates":
      return { type: "selection", turnId, seq, selections: out.selections as { candidateId: string; batchQty: number }[] };
    default:
      return null; // extractFromDrawing (fed back to the model only) / suggestFollowUps (stashed for `done`)
  }
}

// ---- The engine ----

export async function* runTurn(
  ctx: { tenantId: string; userId: string }, input: AssistChatInput, signal: AbortSignal,
): AsyncGenerator<AssistantEvent> {
  const { tenantId, userId } = ctx;

  // Phase timings for "why is the first token slow". One audit line per turn, emitted at the
  // first chunk of the first provider call. ponytail: console timings; a real tracer only if
  // these stop being enough to localize a regression.
  const t0 = Date.now();
  const marks: Record<string, number> = {};
  const mark = (k: string) => { marks[k] = Date.now() - t0; };

  // ============ STEP 1: pre-stream (typed ORPCErrors, nothing persisted yet) ============
  policy.checkTurnStart(tenantId, userId);
  if (input.file) validateFile(input.file as ExtractFile);

  const project = await loadProject(tenantId, input.projectId);
  if (!project) throw new ORPCError("NOT_FOUND", { message: "Project not found" });

  let conversation: { id: string; provider: Provider; model: string } | null = null;
  if (input.conversationId) {
    const [c] = await db.select({
      id: assistantConversation.id,
      provider: assistantConversation.provider,
      model: assistantConversation.model,
    })
      .from(assistantConversation)
      .where(and(
        eq(assistantConversation.id, input.conversationId),
        eq(assistantConversation.tenantId, tenantId),
        eq(assistantConversation.projectId, input.projectId),
      )).limit(1);
    if (!c) throw new ORPCError("NOT_FOUND", { message: "Conversation not found" });
    conversation = c;
  }

  // Peek the turn row (if any) up front: this both (a) tells us whether this is a genuinely NEW
  // turnId (gates the STATE_CHANGED pre-check below) and (b) lets a resume/retry reuse the
  // ALREADY-PINNED provider/model rather than re-deriving it from input/conversation, so
  // claimTurn's identity check (provider is immutable per turn) can never spuriously mismatch.
  const [existingTurn] = await db.select().from(assistantTurn).where(eq(assistantTurn.id, input.turnId)).limit(1);

  if (!existingTurn && project.updatedAt.toISOString() !== input.projectVersion)
    throw new ORPCError("CONFLICT", { message: "STATE_CHANGED" });

  const provider: Provider | undefined = existingTurn?.provider ?? input.provider ?? conversation?.provider;
  if (!provider) throw new ORPCError("BAD_REQUEST", { message: "provider is required to start a new conversation" });

  // A turn whose row already exists AND is "complete" can only ever come back from `claimTurn`
  // as `replay` (zero adapter calls, see the branch below) or `rejected` (identity mismatch) —
  // neither needs the provider to be resolved/available, so skip that check entirely here. This
  // is what lets a completed turn be replayed even if its provider later became unavailable
  // (e.g. an API key was removed). `existingTurn.model` is already durable in that case, so no
  // resolved profile is needed to fill in a model name either. A genuinely new turn still needs
  // to resolve the provider before `claimTurn`, since `provider`/`model` are required insert
  // columns; a resume needs it too (it WILL make adapter calls), using the already-pinned
  // `existingTurn.provider` above so `claimTurn`'s immutable-identity check can never mismatch.
  const isProspectiveReplay = existingTurn?.status === "complete";
  let modelName: string;
  if (isProspectiveReplay) {
    modelName = existingTurn!.model;
  } else {
    let resolved;
    try {
      const requestedModel = existingTurn?.model ?? input.model
        ?? (input.provider && input.provider !== conversation?.provider ? undefined : conversation?.model);
      resolved = resolveProvider(provider, process.env, requestedModel);
    } catch {
      throw new ORPCError("SERVICE_UNAVAILABLE", { message: `${provider} is not available` });
    }
    modelName = existingTurn?.model ?? resolved.profile.model;
  }

  const model = await loadModel(tenantId, project.modelId);
  const lookups = await enrichedLookups(tenantId, model, input.entries as Entries);
  validateEntries(model.definition, lookups, input.entries as Entries);
  mark("prep"); // project + conversation + turn peek + model + lookups

  // ============ STEP 2: claim ============
  const attachment = attachmentOf(input.file as ExtractFile | undefined);
  const claimParams = {
    turnId: input.turnId, userId, provider, model: modelName,
    projectVersion: new Date(input.projectVersion), entries: input.entries as Entries, batches: input.batches,
    userMessage: input.message, attachment,
  };

  let claim: Awaited<ReturnType<typeof claimTurn>>;
  const isNewConversation = !conversation;
  const title = input.message.slice(0, 80);
  if (!conversation) {
    // Conversation INSERT + claim are ONE transaction (see `claimTurnWithNewConversation`) — a
    // rejected claim, or a genuine DB error mid-claim, rolls back the conversation row too. No
    // orphan conversation can ever be left behind.
    claim = await claimTurnWithNewConversation(
      db, { tenantId, projectId: input.projectId, createdByUserId: userId, provider, model: modelName, title },
      claimParams,
    );
  } else {
    if (!existingTurn && (provider !== conversation.provider || modelName !== conversation.model))
      await db.update(assistantConversation).set({ provider, model: modelName }).where(eq(assistantConversation.id, conversation.id));
    claim = await claimTurn(db, { ...claimParams, conversationId: conversation.id });
  }

  if (claim.kind === "rejected")
    throw new ORPCError("CONFLICT", { message: claim.code });

  const { leaseToken, turn } = claim;
  const conversationId = turn.conversationId;
  mark("claim");

  if (claim.kind === "replay") {
    const [msg] = await db.select().from(assistantMessage)
      .where(and(eq(assistantMessage.turnId, turn.id), eq(assistantMessage.role, "assistant"))).limit(1);
    const s = await allocSeq(db, turn.id, leaseToken, 2);
    yield eventFor(snapshotEvent(turn, s, msg?.content.ui, "complete"));
    yield eventFor({ type: "done", turnId: turn.id, seq: s + 1, suggestions: msg?.content.ui.suggestions ?? [], usage: { inputTokens: turn.inputTokens, outputTokens: turn.outputTokens } });
    return; // zero adapter calls, nothing else to clean up
  }

  if (isNewConversation) {
    // claim.kind is necessarily "new" here: "replay" already returned above, and "resume"
    // requires an existing turn, which requires an existing (not new) conversation.
    const s = await allocSeq(db, turn.id, leaseToken, 1);
    yield eventFor({ type: "conversation", turnId: input.turnId, seq: s, id: conversationId, title, provider });
  }

  // ============ From here on: "new" or "resume" — lease renewal + watchdog + finalize ============
  const turnAbort = new AbortController();
  const onExternalAbort = () => turnAbort.abort();
  signal.addEventListener("abort", onExternalAbort);
  const renewTimer = setInterval(() => {
    renewLease(db, turn.id, leaseToken).then((ok) => { if (!ok) turnAbort.abort(); }).catch(() => turnAbort.abort());
  }, LEASE_RENEW_MS);
  const watchdog = setTimeout(() => turnAbort.abort(), TURN_WATCHDOG_MS);

  let finalStatus: "complete" | "partial" | "failed" = "partial";
  let finalErrorCode: string | undefined;
  const acc: { text: string; changes: UiChange[]; results: { tool: string; resultId: string; data: unknown }[] } = { text: "", changes: [], results: [] };
  let suggestions: string[] | undefined;
  let modelParts: ModelPart[] = [];
  let lastCounters = {
    iterationCount: turn.iterationCount,
    executedToolCallCount: turn.executedToolCallCount, providerCallCount: turn.providerCallCount,
    inputTokens: turn.inputTokens, outputTokens: turn.outputTokens,
  };

  // Pre-crash assistant transcript parts of THIS turn, spliced into the live model context below
  // so a resumed model sees what it already did (empty for `new`, or a hard crash before finalize).
  let resumeParts: ModelPart[] = [];

  try {
    // -------- resume continuation --------
    let working: Working = { entries: turn.workingEntries, batches: turn.workingBatches, projectVersion: turn.latestProjectVersion.toISOString(), workingRevision: turn.workingRevision };
    if (claim.kind === "resume") {
      // The pre-crash assistant message (if `finalizeTurn` ran before the crash): its `ui` is what
      // the window already rendered; its `model` is the tool-call/result transcript this turn
      // already produced. Both are needed to CONTINUE the turn rather than restart the model cold.
      const [priorAssistant] = await db.select().from(assistantMessage)
        .where(and(eq(assistantMessage.turnId, turn.id), eq(assistantMessage.role, "assistant"))).limit(1);
      const priorUi = priorAssistant?.content.ui;

      // (3) Always yield the snapshot first on resume (plan Task 13). The client's `snapshot`
      // reducer case replaces its stale partial text/changes with this authoritative projection
      // and re-fires onApplyValues for the persisted valid changes, before any new delta arrives.
      const snapSeq = await allocSeq(db, turn.id, leaseToken, 1);
      yield eventFor(snapshotEvent(turn, snapSeq, priorUi, "running"));

      // (2) Re-seed the server-side accumulators + model transcript from the pre-crash message, so
      // both the finalized message and the model's own context continue the turn instead of losing
      // (persisted) or re-deriving (context) the work done before the crash.
      if (priorAssistant) {
        acc.text = priorUi?.text ?? "";
        acc.changes = [...(priorUi?.changes ?? []), ...(priorUi?.invalid ?? [])];
        acc.results = priorUi?.results ?? [];
        if (priorUi?.suggestions?.length) suggestions = priorUi.suggestions;
        resumeParts = (priorAssistant.content.model ?? []) as ModelPart[];
        modelParts = [...resumeParts];
      }

      // -------- overlay reconciliation (the form edits the user made while the turn was down) --------
      if (input.resume) {
        const touched = new Set(input.resume.touchedEntryKeys);
        const nextEntries = { ...working.entries };
        let changed = false;
        for (const k of touched) {
          const v = (input.entries as Entries)[k];
          if (JSON.stringify(v) !== JSON.stringify(nextEntries[k])) {
            if (v === undefined) delete nextEntries[k]; else nextEntries[k] = v;
            changed = true;
          }
        }
        let nextBatches = working.batches;
        if (input.resume.batchesTouched && JSON.stringify(input.batches) !== JSON.stringify(working.batches)) {
          nextBatches = input.batches;
          changed = true;
        }
        // Divergence-from-"that run's snapshot" check: `AssistantDeps` has no accessor for a
        // stored calculation, so this reads the turn's own `workingEntries`/`workingBatches` AT CLAIM
        // TIME as already BEING the frozen run's snapshot — `calculate` sets `state.frozen = true`,
        // blocking any further `setValues`, so nothing else can move those columns once
        // `calculated` is set. Divergence is therefore just: the resume overlay would actually
        // change entries/batches while `calculated` is set (see loop.ts:325-328 and the
        // report's judgment call #2 for the same reasoning applied to provider-on-resume). The
        // leading snapshot was already yielded above, so this branch only needs the error event.
        if (turn.calculated && changed) {
          const s = await allocSeq(db, turn.id, leaseToken, 1);
          yield eventFor({ type: "error", turnId: turn.id, seq: s, code: "STATE_CHANGED", message: "The project changed since this turn started; start a new message", retryable: false });
          finalStatus = "partial"; finalErrorCode = "STATE_CHANGED";
          return;
        }
        if (changed) {
          const ok = await updateWorking(db, turn.id, leaseToken, { entries: nextEntries, batches: nextBatches, revision: working.workingRevision + 1 });
          if (!ok) throw new Error("LEASE_LOST");
          working = { ...working, entries: nextEntries, batches: nextBatches, workingRevision: working.workingRevision + 1 };
        }
      }
    }

    // ============ STEP 3: context ============
    const [userMsg] = await db.select({ id: assistantMessage.id }).from(assistantMessage)
      .where(and(eq(assistantMessage.turnId, turn.id), eq(assistantMessage.role, "user"))).limit(1);
    const userMessageId = userMsg?.id ?? turn.id;

    const execCtx: ExecutorCtx = {
      tenantId, projectId: input.projectId, userId, turnId: turn.id, userMessageId,
      userMessage: input.message, conversationId, leaseToken,
      model, lookups, working: { ...working }, file: input.file as ExtractFile | undefined, signal: turnAbort.signal,
    };
    const executors = createExecutors(execCtx);

    // (1) Restore the frozen state if a prior attempt of this turn already ran `calculate`. The
    // durable source of truth is the `calculated` column (persisted in its own committed update
    // the moment calculate succeeded), so this holds even on a hard crash with no assistant
    // message. Without it, `makeExecutors` hands back `frozen: false` and a resumed model could run
    // setValues again — advancing `workingRevision` off the value the original `calculate`'s
    // operationKey was computed from, which would let a genuinely new calculation be written.
    if (turn.calculated) {
      executors.state.frozen = true;
      const run = await loadCandidates(tenantId, input.projectId);
      if (run) executors.state.lastRun = run;
    }

    const priorTurnRows = await db.select({ id: assistantTurn.id }).from(assistantTurn)
      .where(and(eq(assistantTurn.conversationId, conversationId), ne(assistantTurn.id, turn.id)))
      .orderBy(desc(assistantTurn.startedAt)).limit(CONTEXT_TURN_LIMIT);
    const priorIds = priorTurnRows.map((t) => t.id).reverse(); // oldest-first
    const priorMsgs = priorIds.length
      ? await db.select().from(assistantMessage).where(inArray(assistantMessage.turnId, priorIds))
      : [];
    const rows = priorIds.map((id) => ({
      userText: priorMsgs.find((m) => m.turnId === id && m.role === "user")?.content.ui.text ?? "",
      parts: (priorMsgs.find((m) => m.turnId === id && m.role === "assistant")?.content.model ?? []) as ModelPart[],
    }));
    let historyGroups = projectTranscript(rows, execCtx.working.projectVersion);

    const propagation = propagate(model.definition, lookups, execCtx.working.entries);
    const systemPrompt = buildAssistPrompt(model.definition, propagation, {
      entries: execCtx.working.entries, batches: execCtx.working.batches,
      projectVersion: execCtx.working.projectVersion, workingRevision: execCtx.working.workingRevision,
    }, {
      customer: project.customer, status: project.status,
      candidateCount: executors.state.lastRun?.candidates.length,
      attachment: input.file ? { name: (input.file as ExtractFile).name, mimeType: (input.file as ExtractFile).mimeType } : null,
    });
    const toolDecls = toolDeclsFor(model.definition);
    mark("context"); // prior-turn transcript load + propagate() + system prompt + tool decls

    const baseEstimate = estimateTokens(systemPrompt) + estimateTokens(JSON.stringify(toolDecls.map((t) => ({ name: t.name, description: t.description }))));
    if (baseEstimate > MAX_INPUT_TOKENS_PER_CALL) {
      const s = await allocSeq(db, turn.id, leaseToken, 1);
      yield eventFor({ type: "error", turnId: turn.id, seq: s, code: "CONTEXT_TOO_LARGE", message: "This configuration is too large for the assistant to process in one turn.", retryable: true });
      finalStatus = "partial"; finalErrorCode = "CONTEXT_TOO_LARGE";
      return;
    }

    // ============ STEP 4: provider loop ============
    const adapter = makeChatAdapter(provider, modelName);
    // On resume, splice the current turn's pre-crash assistant transcript after the user message so
    // the model sees its own earlier setValues/calculate calls and continues instead of redoing them.
    const liveHead: Msg[] = [{ role: "user", text: input.message }];
    if (resumeParts.length) liveHead.push({ role: "assistant", parts: resumeParts });
    let liveMessages: Msg[] = liveHead;
    let doneNaturally = false;
    let toolBudgetExceeded = false;
    let firstTokenLogged = false;

    while (!doneNaturally && !toolBudgetExceeded) {
      const counters = await bumpCounters(db, turn.id, leaseToken, { iterationCount: 1, providerCallCount: 1 });
      lastCounters = counters;
      if (counters.iterationCount > MAX_ITERATIONS || counters.providerCallCount > MAX_PROVIDER_CALLS) break;
      const outputBudgetLeft = MAX_OUTPUT_TOKENS_PER_TURN - WRAP_UP_RESERVE_TOKENS - counters.outputTokens;
      if (outputBudgetLeft <= 0) break;
      if (counters.inputTokens >= MAX_INPUT_TOKENS_PER_TURN) break;
      const maxOutputTokens = Math.min(MAX_OUTPUT_TOKENS_PER_CALL, outputBudgetLeft);

      let messages: unknown[] = [...historyGroups.flat(), ...liveMessages];
      while (estimateTokens(systemPrompt) + estimateTokens(JSON.stringify(messages)) > MAX_INPUT_TOKENS_PER_CALL && historyGroups.length > 0) {
        historyGroups = historyGroups.slice(1);
        messages = [...historyGroups.flat(), ...liveMessages];
      }
      if (estimateTokens(systemPrompt) + estimateTokens(JSON.stringify(messages)) > MAX_INPUT_TOKENS_PER_CALL) {
        const s = await allocSeq(db, turn.id, leaseToken, 1);
        yield eventFor({ type: "error", turnId: turn.id, seq: s, code: "CONTEXT_TOO_LARGE", message: "This conversation is too large for the assistant to process.", retryable: true });
        finalStatus = "partial"; finalErrorCode = "CONTEXT_TOO_LARGE";
        return;
      }

      let sawToolCall = false;
      let sawSuggestions = false;
      let usageReceived = false;
      let iterationText = "";
      let textBuf = "";
      let lastFlush = Date.now();
      const iterationParts: ModelPart[] = [];

      const flushText = async function* (): AsyncGenerator<AssistantEvent> {
        if (!textBuf) return;
        const flushed = textBuf; textBuf = ""; lastFlush = Date.now();
        const s = await allocSeq(db, turn.id, leaseToken, 1);
        acc.text += flushed;
        yield eventFor({ type: "delta", turnId: turn.id, seq: s, text: flushed });
      };

      const callAt = Date.now();
      for await (const chunk of adapter({ system: systemPrompt, messages, tools: toolDecls, maxOutputTokens, signal: turnAbort.signal })) {
        if (!firstTokenLogged) {
          firstTokenLogged = true;
          audit({
            event: "assist_first_token", turnId: turn.id, tenantId, resumed: claim.kind === "resume",
            ...marks, callAt: callAt - t0, ttftMs: Date.now() - callAt,
            systemChars: systemPrompt.length, historyChars: JSON.stringify(messages).length,
            historyTurns: historyGroups.length, toolCount: toolDecls.length,
          });
        }
        if (chunk.kind === "text") {
          textBuf += chunk.text;
          iterationText += chunk.text;
          if (textBuf.length >= 256 || Date.now() - lastFlush >= 50) yield* flushText();
        } else if (chunk.kind === "usage") {
          usageReceived = true;
          const bumped = await bumpCounters(db, turn.id, leaseToken, { inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens });
          lastCounters = bumped;
          policy.chargeTokens(tenantId, chunk.inputTokens + chunk.outputTokens);
        } else if (chunk.kind === "toolCall") {
          const name = chunk.name as ToolName;

          if (sawToolCall || !(name in TOOLS)) {
            const errRes = sawToolCall
              ? { ok: false, code: "TOOL_ORDER", message: "one tool per turn", retryable: true }
              : { ok: false, code: "UNKNOWN_TOOL", message: `Unknown tool ${chunk.name}`, retryable: true };
            iterationParts.push({
              type: "toolCall", id: chunk.id, name: chunk.name, args: chunk.args,
              ...(chunk.metadata !== undefined ? { metadata: chunk.metadata } : {}),
            });
            iterationParts.push({ type: "toolResult", id: chunk.id, name: chunk.name, result: errRes });
            continue;
          }
          sawToolCall = true;

          const s1 = await allocSeq(db, turn.id, leaseToken, 1);
          yield eventFor({ type: "tool", turnId: turn.id, seq: s1, name, label: TOOLS[name].label });

          const paramKeys = model.definition.parameters.map((p) => p.key);
          const inputSchema = name === "setValues" ? makeSetValuesInputZ(paramKeys)
            : name === "previewCandidates" ? makePreviewCandidatesInputZ(paramKeys)
            : TOOLS[name].input;
          const parsedArgs = inputSchema.safeParse(chunk.args);
          iterationParts.push({
            type: "toolCall", id: chunk.id, name, args: chunk.args,
            ...(chunk.metadata !== undefined ? { metadata: chunk.metadata } : {}),
          });

          if (!parsedArgs.success) {
            const errRes = { ok: false, code: "INVALID_ARGUMENTS", message: parsedArgs.error.issues.map((i) => i.message).join("; ").slice(0, 2000), retryable: true };
            iterationParts.push({ type: "toolResult", id: chunk.id, name, result: errRes });
            continue;
          }

          const executed = await bumpCounters(db, turn.id, leaseToken, { executedToolCallCount: 1 });
          lastCounters = executed;
          if (executed.executedToolCallCount > MAX_TOOL_CALLS) {
            const errRes = { ok: false, code: "TOOL_LIMIT", message: "Tool call limit reached for this turn", retryable: true };
            iterationParts.push({ type: "toolResult", id: chunk.id, name, result: errRes });
            toolBudgetExceeded = true;
            continue;
          }

          const opKey = operationKeyFor(name, parsedArgs.data, execCtx.working.workingRevision, execCtx.working.projectVersion, attachment?.sha256);
          const toolTimeoutMs = name === "extractFromDrawing" ? EXTRACTION_TIMEOUT_MS : TOOL_TIMEOUT_MS;
          const opSignal = AbortSignal.any([turnAbort.signal, AbortSignal.timeout(toolTimeoutMs)]);

          const domainSeq = await allocSeq(db, turn.id, leaseToken, 1);
          const opResult = await runToolOperation(db, {
            turnId: turn.id, leaseToken, toolCallId: chunk.id, name, operationKey: opKey, input: parsedArgs.data,
            // Executors manage their own persistence (module-level `db`, or their own
            // `db.transaction` for selectCandidates), so `runToolOperation`'s tx isn't threaded
            // in — see the reuse reasoning on `calculateProject` and
            // `selectCandidates`. `opSignal` is honored best-effort: the agent-backed reads take
            // no AbortSignal, so a call that has already started can't be cancelled; the turn's
            // 120s watchdog is the hard backstop.
            exec: async () => {
              if (opSignal.aborted) throw new Error("Turn aborted before this tool call started");
              const run = executors[name] as (i: unknown) => Promise<unknown>;
              const result = await run(parsedArgs.data);
              const r = result as Record<string, unknown>;
              const affectedProjectVersion = typeof r.projectVersion === "string" ? new Date(r.projectVersion) : undefined;
              return { result, affectedProjectVersion, eventSeq: domainSeq };
            },
          });
          const effectiveSeq = opResult.eventSeq ?? domainSeq;
          const rawResult = opResult.result;

          const parsedOut = TOOLS[name].output.safeParse(rawResult);
          if (!parsedOut.success) {
            audit({ event: "assist_tool_output_invalid", turnId: turn.id, tenantId, name, issues: parsedOut.error.issues });
            finalStatus = "failed"; finalErrorCode = "INVALID_TOOL_OUTPUT";
            const s = await allocSeq(db, turn.id, leaseToken, 1);
            yield eventFor({ type: "error", turnId: turn.id, seq: s, code: "INVALID_TOOL_OUTPUT", message: "The assistant produced an invalid tool result.", retryable: false });
            return;
          }
          const out = parsedOut.data as Record<string, unknown>;
          iterationParts.push({ type: "toolResult", id: chunk.id, name, result: out });

          if (!opResult.replayed) {
            if (name === "setValues" && out.ok === true && out.stale !== true) {
              await updateWorking(db, turn.id, leaseToken, { entries: execCtx.working.entries, batches: execCtx.working.batches, revision: execCtx.working.workingRevision });
            } else if (name === "calculate" && out.ok === true && out.stale !== true) {
              await updateWorking(db, turn.id, leaseToken, {
                entries: execCtx.working.entries, batches: execCtx.working.batches, revision: execCtx.working.workingRevision,
                latestProjectVersion: new Date(execCtx.working.projectVersion), calculated: true,
              });
            }
          }

          if (name === "setValues" && out.ok === true && out.stale !== true) {
            const rows2 = buildChangeRows((parsedArgs.data as unknown as { values: { key: string; value: Val; evidence: Evidence }[] }).values, out.changes as { key: string; from?: Val; to: Val; evidence: string; valid: boolean; reason?: string }[]);
            acc.changes.push(...rows2);
            if (rows2.length)
              yield eventFor({ type: "changes", turnId: turn.id, seq: effectiveSeq, workingRevision: out.workingRevision as number, changes: rows2.map(toChangeRow) });
          } else {
            if (RESULT_TOOLS.has(name) && out.ok === true && out.stale !== true) {
              acc.results.push({ tool: name, resultId: out.resultId as string, data: out });
            } else if (name === "suggestFollowUps" && out.ok === true) {
              suggestions = out.accepted as string[];
              sawSuggestions = true;
            }
            const domainEvent = domainEventFor(name, turn.id, effectiveSeq, out);
            if (domainEvent) yield eventFor(domainEvent);
          }
        }
      }
      yield* flushText();
      if (iterationText) iterationParts.unshift({ type: "text", text: iterationText });

      if (!usageReceived) {
        const estIn = estimateTokens(systemPrompt) + estimateTokens(JSON.stringify(messages));
        const estOut = estimateTokens(iterationText);
        lastCounters = await bumpCounters(db, turn.id, leaseToken, { inputTokens: estIn, outputTokens: estOut });
        policy.chargeTokens(tenantId, estIn + estOut);
      }

      modelParts.push(...iterationParts);
      // suggestFollowUps emitted ALONGSIDE prose is the final reply — the model has said its
      // piece and picked its chips. Looping again just to have it repeat the answer costs a full
      // extra provider round trip (measured ~3.3s, half the turn). Prose is the guard: a bare
      // suggestFollowUps with no text is treated as mid-work and still loops.
      if (sawSuggestions && iterationText.trim()) {
        doneNaturally = true;
      } else if (sawToolCall && !toolBudgetExceeded) {
        liveMessages = [...liveMessages, { role: "assistant", parts: iterationParts }];
      } else if (!sawToolCall) {
        doneNaturally = true;
      }
    }

    // ============ STEP 5: wrap-up ============
    if (!doneNaturally) {
      const isWinner = await claimWrapUp(db, turn.id, leaseToken);
      const wrapUpBudget = MAX_OUTPUT_TOKENS_PER_TURN - lastCounters.outputTokens;
      const canCallProvider = isWinner && lastCounters.providerCallCount < MAX_PROVIDER_CALLS && wrapUpBudget > 0;

      if (canCallProvider) {
        const counters = await bumpCounters(db, turn.id, leaseToken, { providerCallCount: 1, iterationCount: 1 });
        lastCounters = counters;
        const messages: unknown[] = [...historyGroups.flat(), ...liveMessages];
        let textBuf = ""; let lastFlush = Date.now(); let wrapText = "";
        let usageReceived = false;
        for await (const chunk of adapter({ system: systemPrompt, messages, tools: null, maxOutputTokens: WRAP_UP_RESERVE_TOKENS, signal: turnAbort.signal })) {
          if (chunk.kind === "text") {
            textBuf += chunk.text; wrapText += chunk.text;
            if (textBuf.length >= 256 || Date.now() - lastFlush >= 50) {
              const flushed = textBuf; textBuf = ""; lastFlush = Date.now();
              const s = await allocSeq(db, turn.id, leaseToken, 1);
              acc.text += flushed;
              yield eventFor({ type: "delta", turnId: turn.id, seq: s, text: flushed });
            }
          } else if (chunk.kind === "usage") {
            usageReceived = true;
            lastCounters = await bumpCounters(db, turn.id, leaseToken, { inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens });
            policy.chargeTokens(tenantId, chunk.inputTokens + chunk.outputTokens);
          }
        }
        if (textBuf) {
          const s = await allocSeq(db, turn.id, leaseToken, 1);
          acc.text += textBuf;
          yield eventFor({ type: "delta", turnId: turn.id, seq: s, text: textBuf });
        }
        if (!usageReceived) {
          const estIn = estimateTokens(systemPrompt) + estimateTokens(JSON.stringify(messages));
          const estOut = estimateTokens(wrapText);
          lastCounters = await bumpCounters(db, turn.id, leaseToken, { inputTokens: estIn, outputTokens: estOut });
          policy.chargeTokens(tenantId, estIn + estOut);
        }
        if (wrapText) modelParts.push({ type: "text", text: wrapText });
      } else {
        const limitMsg = "I've reached my limit for this turn. Please continue in a new message.";
        const s = await allocSeq(db, turn.id, leaseToken, 1);
        acc.text += limitMsg;
        modelParts.push({ type: "text", text: limitMsg });
        yield eventFor({ type: "delta", turnId: turn.id, seq: s, text: limitMsg });
      }
    }

    // ============ STEP 6: done ============
    const s = await allocSeq(db, turn.id, leaseToken, 1);
    yield eventFor({ type: "done", turnId: turn.id, seq: s, suggestions: suggestions ?? [], usage: { inputTokens: lastCounters.inputTokens, outputTokens: lastCounters.outputTokens } });
    finalStatus = "complete";
  } catch (e) {
    // A raw Error.message can be arbitrary DB/SDK content, so only the provider-boundary wrapper's
    // sanitized public API message may reach the wire. Audit and persisted state keep stable codes.
    const code = classifyTurnError(e);
    const message = e instanceof ProviderApiError ? e.message : "Something went wrong; you can retry.";
    finalStatus = "partial"; finalErrorCode = code;
    audit({ event: "assist_turn_error", turnId: turn.id, tenantId, code });
    try {
      const s = await allocSeq(db, turn.id, leaseToken, 1);
      yield eventFor({ type: "error", turnId: turn.id, seq: s, code, message, retryable: true });
    } catch { /* lease lost or transport gone: best-effort only */ }
  } finally {
    clearInterval(renewTimer);
    clearTimeout(watchdog);
    signal.removeEventListener("abort", onExternalAbort);
    await finalizeTurn(db, {
      turnId: turn.id, leaseToken, status: finalStatus, errorCode: finalErrorCode,
      assistantUi: {
        text: acc.text, changes: acc.changes.filter((c) => c.valid), invalid: acc.changes.filter((c) => !c.valid),
        results: acc.results, ...(input.file ? { fileName: (input.file as ExtractFile).name } : {}),
      },
      assistantModel: modelParts, conversationId, suggestions,
    });
  }
}

// Re-exported so router.ts (and any future caller) can validate a chat handler's declared
// output against the exact same schema this engine yields.
export { AssistantEventZ };
