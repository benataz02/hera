import { ORPCError } from "@orpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { db, configRun, type RunCandidate, type RunSelection } from "@hera/db";
import {
  propagate, enumerate, computeOutputs,
  type Entries, type ResolvedLookups, type Val, type Outputs,
} from "@hera/config-engine";
import {
  assistantToolExecution, assistantTurn, byteSize, MAX_TOOL_RESULT_BYTES, type Evidence,
} from "@hera/assistant";
import { validateSuggestionSet } from "../extraction.ts";
import { callExtraction as realCallExtraction, type ExtractFile } from "../orpc/routers/extraction.ts";
import {
  searchSimilarRows as realSimilar, fetchDocHistory as realDocs, loadModel,
  executeRunFromSnapshot, applySelection,
} from "../orpc/routers/configs.ts";
import { modelRunner } from "../orpc/routers/configs.ts";
import type { DocRow } from "../doc-history.ts";

// Tool executors: the server-side implementations closed over one turn's context. Each returns
// (never throws) a domain result — `{ ok:true, stale:false, ... }` | `staleResult(...)` | a
// structured `{ ok:false, code, message, retryable }` error — so the turn loop never has to
// special-case a thrown exception from a tool call, only from real infrastructure failure
// (mapInfra's final `throw e`, which ends the turn).
// calculate/selectCandidates are added to this same factory by Task 11.

export type Working = { entries: Entries; batches: number[]; projectVersion: string; workingRevision: number };
export type ExecutorCtx = {
  tenantId: string; projectId: string; userId: string;
  turnId: string; userMessageId: string; userMessage: string; conversationId: string;
  leaseToken: string;
  model: Awaited<ReturnType<typeof loadModel>>; lookups: ResolvedLookups;
  working: Working; // mutated in place by setValues; the loop mirrors changes via events
  file?: ExtractFile; // retained attachment for extractFromDrawing, if any
  signal: AbortSignal;
};
export type ExecutorDeps = {
  searchSimilarRows: typeof realSimilar;
  fetchDocHistory: typeof realDocs;
  callExtraction: typeof realCallExtraction;
};

const err = (code: string, message: string, retryable = false) => ({ ok: false as const, code, message, retryable });

/** Halves an array until its serialized size fits the cap (or one item remains). Used for the
 *  read tools' bounded row/param arrays so a pathological result can't blow the model context. */
function capToByteLimit<T>(items: T[]): { items: T[]; truncated: boolean } {
  let out = items;
  let truncated = false;
  while (out.length > 1 && byteSize(out) > MAX_TOOL_RESULT_BYTES) {
    out = out.slice(0, Math.ceil(out.length / 2));
    truncated = true;
  }
  return { items: out, truncated };
}

/** Display label for a candidate: the first ~3 key/value pairs of its assignment. */
function summarize(assignment: Entries): string {
  const pairs = Object.entries(assignment).slice(0, 3);
  return pairs.length ? pairs.map(([k, v]) => `${k}: ${v}`).join(", ") : "Configuration";
}

/** Key figure for a preview candidate: unit price and batch total, formatted like the
 *  configurator UI (`apps/web/src/components/configurator/runView.ts`'s `fmt`). */
function keyFigureOf(outputs: Outputs): string {
  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return `unit ${fmt(outputs.unitPrice)} · batch ${fmt(outputs.batchTotal)}`;
}

/** Maps a `DocRow` (`apps/server/src/doc-history.ts`'s `flattenDocs`) to the getDocHistory
 *  tool's row shape (`packages/assistant/src/tools.ts`): docNum there is a string. */
function projectDocRow(row: DocRow): { kind: "order" | "quotation"; docNum: string; date: string; itemCode: string; qty: number; price: number } {
  return { kind: row.docType, docNum: String(row.docNum), date: row.docDate, itemCode: row.itemCode, qty: row.quantity, price: row.unitPrice };
}

export function createExecutors(
  ctx: ExecutorCtx,
  deps: ExecutorDeps = { searchSimilarRows: realSimilar, fetchDocHistory: realDocs, callExtraction: realCallExtraction },
) {
  const state: { frozen: boolean; lastRun?: { runId: string; candidates: RunCandidate[] } } = { frozen: false };

  /** Resolve evidence → display string, or an error result. User: bind to this message, detail
   *  must be a normalized substring (else whole short message). Other sources: sourceRef must
   *  resolve to a successful execution of THIS conversation. */
  async function resolveEvidence(ev: Evidence): Promise<{ evidence: string } | { error: ReturnType<typeof err> }> {
    if (ev.source === "user") {
      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
      const detail = norm(ctx.userMessage).includes(norm(ev.detail)) ? ev.detail : ctx.userMessage.slice(0, 200);
      return { evidence: detail };
    }
    if (!ev.sourceRef) return { error: err("INVALID_PROVENANCE", `${ev.source} evidence requires sourceRef`) };
    const turnsOfConv = db.select({ id: assistantTurn.id }).from(assistantTurn)
      .where(eq(assistantTurn.conversationId, ctx.conversationId));
    const rows = await db.select().from(assistantToolExecution).where(and(
      inArray(assistantToolExecution.turnId, turnsOfConv),
      eq(assistantToolExecution.status, "complete"),
    ));
    const match = rows.find((r) =>
      (r.toolCallId === ev.sourceRef!.toolCallId || r.replayToolCallIds.includes(ev.sourceRef!.toolCallId)) &&
      (r.result as { resultId?: string } | null)?.resultId === ev.sourceRef!.resultId);
    if (!match) return { error: err("INVALID_PROVENANCE", "sourceRef does not resolve to a tool result in this conversation") };
    return { evidence: `${ev.detail} (${ev.source})` };
  }

  return {
    state,
    async setValues(input: { values: { key: string; value: Val; evidence: Evidence }[] }) {
      if (state.frozen) return err("WORKING_FROZEN", "calculate already ran this turn; values are frozen");
      const resolved: Record<string, { value: Val; evidence: string }> = {};
      for (const v of input.values) {
        const r = await resolveEvidence(v.evidence);
        if ("error" in r) return r.error;
        resolved[v.key] = { value: v.value, evidence: r.evidence };
      }
      const before = { ...ctx.working.entries };
      const val = validateSuggestionSet(ctx.model.definition, ctx.lookups, ctx.working.entries, resolved);
      const changes = val.suggestions.map((s) => ({
        key: s.paramKey, from: before[s.paramKey] ?? undefined, to: s.value,
        evidence: s.evidence, valid: s.valid, reason: s.reason,
      }));
      const changed = JSON.stringify(val.nextEntries) !== JSON.stringify(ctx.working.entries);
      if (changed) { ctx.working.entries = val.nextEntries; ctx.working.workingRevision += 1; }
      const prop = propagate(ctx.model.definition, ctx.lookups, ctx.working.entries);
      return {
        ok: true as const, stale: false as const, workingRevision: ctx.working.workingRevision,
        changes, conflicts: prop.conflicts.map((c) => c.message),
        unset: ctx.model.definition.parameters.filter((p) => ctx.working.entries[p.key] === undefined).map((p) => p.key),
      };
    },

    async previewCandidates(input: { overrides?: Record<string, Val> }) {
      const entries = { ...ctx.working.entries, ...(input.overrides ?? {}) };
      const prop = propagate(ctx.model.definition, ctx.lookups, entries);
      if (prop.conflicts.length) return err("CONFLICTS", prop.conflicts.map((c) => c.message).join("; "));
      const en = enumerate(ctx.model.definition, ctx.lookups, entries);
      const batchQty = ctx.working.batches[0] ?? 1;
      const top = en.candidates.slice(0, 5).map((assignment, i) => {
        const outputs = computeOutputs(ctx.model.definition, ctx.lookups, assignment, batchQty);
        return { previewId: `p${i}`, label: summarize(assignment), keyFigure: keyFigureOf(outputs) };
      });
      return { ok: true as const, stale: false as const, resultId: crypto.randomUUID(),
        observedProjectVersion: ctx.working.projectVersion, workingRevision: ctx.working.workingRevision,
        candidateCount: en.candidates.length, top };
    },

    async searchSimilar(_: Record<string, never>) {
      try {
        const r = await deps.searchSimilarRows(ctx.tenantId, ctx.projectId, ctx.working.entries);
        const mapped = r.results.slice(0, 3).map((row, i) => ({ rowId: `r${i}`, score: row.score, values: row.values, display: row.display }));
        const { items: rows } = capToByteLimit(mapped);
        return { ok: true as const, stale: false as const, resultId: crypto.randomUUID(),
          observedProjectVersion: ctx.working.projectVersion, rows };
      } catch (e) { return mapInfra(e); }
    },

    async getDocHistory(input: { itemCode?: string }) {
      try {
        const r = await deps.fetchDocHistory(ctx.tenantId, ctx.projectId, input.itemCode);
        const mapped = r.rows.slice(0, 20).map((row, i) => ({ rowId: `r${i}`, ...projectDocRow(row) }));
        const { items: rows, truncated: byteTruncated } = capToByteLimit(mapped);
        return { ok: true as const, stale: false as const, resultId: crypto.randomUUID(),
          observedProjectVersion: ctx.working.projectVersion, observedAt: new Date().toISOString(),
          rows, truncated: r.rows.length > 20 || byteTruncated, total: r.rows.length };
      } catch (e) { return mapInfra(e); }
    },

    async extractFromDrawing(_: Record<string, never>) {
      if (!ctx.file) return err("NO_ATTACHMENT", "No drawing is attached to this turn");
      try {
        const raw = await deps.callExtraction(ctx.model, ctx.lookups, ctx.file);
        const mapped = Object.entries(raw)
          .filter(([, v]) => v && (v as { value?: unknown }).value != null)
          .map(([paramKey, v]) => ({ paramKey, value: (v as { value: Val }).value,
            evidence: String((v as { evidence?: unknown }).evidence ?? ""), rowId: paramKey }));
        const { items: params } = capToByteLimit(mapped);
        return { ok: true as const, stale: false as const, resultId: crypto.randomUUID(),
          observedProjectVersion: ctx.working.projectVersion, params };
      } catch (e) { return mapInfra(e); }
    },

    async suggestFollowUps(input: { suggestions: string[] }) {
      const accepted = [...new Set(input.suggestions.map((s) => s.trim()).filter(Boolean))].slice(0, 3).map((s) => s.slice(0, 120));
      return { ok: true as const, stale: false as const, accepted };
    },

    async calculate(_: Record<string, never>) {
      const prop = propagate(ctx.model.definition, ctx.lookups, ctx.working.entries);
      if (prop.conflicts.length) return err("CONFLICTS", prop.conflicts.map((c) => c.message).join("; "));
      if (!ctx.working.batches.length) return err("INVALID_ARGUMENTS", "Add at least one batch quantity");
      try {
        const r = await executeRunFromSnapshot(
          ctx.tenantId, ctx.projectId, ctx.working.entries, ctx.working.batches,
          new Date(ctx.working.projectVersion), await modelRunner(ctx.tenantId, ctx.model.definition),
        );
        state.frozen = true;
        state.lastRun = { runId: r.runId, candidates: r.candidates };
        ctx.working.projectVersion = r.projectVersion;
        const batchQty = ctx.working.batches[0] ?? 1;
        const top = r.candidates.slice(0, 5).map((cand, idx) => {
          const perBatch = cand.perBatch.find((b) => b.batchQty === batchQty) ?? cand.perBatch[0]!;
          return { candidateId: `c${idx}`, label: summarize(cand.assignment), keyFigure: keyFigureOf(perBatch.outputs) };
        });
        return {
          ok: true as const, stale: false as const, runId: r.runId, projectVersion: r.projectVersion,
          reused: r.reused, candidateCount: r.candidateCount, top,
        };
      } catch (e) {
        if (e instanceof ORPCError && e.code === "CONFLICT")
          return err("STATE_CHANGED", "The project changed since this turn started; refresh and try again");
        return mapInfra(e);
      }
    },

    async selectCandidates(input: {
      runId: string;
      selections: { candidateId: string; batchQty: number }[]; mode: "add" | "replace";
    }) {
      return db.transaction(async (tx) => {
        const [run] = await tx.select().from(configRun)
          .where(and(eq(configRun.id, input.runId), eq(configRun.tenantId, ctx.tenantId)))
          .for("update");
        // A recalculate replaces the project's run row, so a runId that no longer resolves means
        // exactly that: this turn's run is stale.
        if (!run || JSON.stringify(run.entries) !== JSON.stringify(ctx.working.entries))
          return err("STALE_RUN", "This run is no longer the project's current configuration; recalculate");

        const validBatchQtys = new Set(run.candidates[0]?.perBatch.map((b) => b.batchQty) ?? []);
        const parsed: { candidateIdx: number; batchQty: number }[] = [];
        for (const s of input.selections) {
          const m = /^c(\d+)$/.exec(s.candidateId);
          const idx = m ? Number(m[1]) : NaN;
          if (!m || !run.candidates[idx]) return err("INVALID_ARGUMENTS", `Unknown candidateId ${s.candidateId}`);
          if (!validBatchQtys.has(s.batchQty))
            return err("INVALID_ARGUMENTS", `batchQty ${s.batchQty} is not one of this run's batches`);
          parsed.push({ candidateIdx: idx, batchQty: s.batchQty });
        }

        const key = (s: { candidateIdx: number; batchQty: number }) => `${s.candidateIdx}:${s.batchQty}`;
        let next: RunSelection[];
        if (input.mode === "replace") {
          next = parsed.map((p) => ({ candidateIdx: p.candidateIdx, batchQty: p.batchQty }));
        } else {
          const merged = new Map((run.selection ?? []).map((s) => [key(s), s]));
          for (const p of parsed) merged.set(key(p), { candidateIdx: p.candidateIdx, batchQty: p.batchQty });
          next = [...merged.values()];
        }

        try {
          applySelection(run, next);
        } catch (e) {
          return mapInfra(e);
        }

        await tx.update(configRun).set({ selection: next })
          .where(and(eq(configRun.id, run.id), eq(configRun.tenantId, ctx.tenantId)));

        return {
          ok: true as const, stale: false as const, runId: run.id,
          selections: next.map((s) => ({ candidateId: `c${s.candidateIdx}`, batchQty: s.batchQty })),
        };
      });
    },
  };
}

/** ORPCError SERVICE_UNAVAILABLE/BAD_GATEWAY → structured retryable tool errors; any other
 *  ORPCError → INVALID_ARGUMENTS (the executor's own domain input was rejected downstream);
 *  anything that isn't an ORPCError rethrows (infrastructure ends the turn). */
function mapInfra(e: unknown) {
  if (e instanceof ORPCError) {
    if (e.code === "SERVICE_UNAVAILABLE") return err("PROVIDER_UNAVAILABLE", e.message, true);
    if (e.code === "BAD_GATEWAY") return err("AGENT_UNAVAILABLE", e.message, true);
    return err("INVALID_ARGUMENTS", e.message);
  }
  throw e;
}
