import { and, eq } from "drizzle-orm";
import { db, configProject } from "@hera/db";
import type { AssistantDeps, Executors, ExecutorCtx, ModelLike } from "@hera/assistant";
import { ExtractFileZ } from "../orpc/routers/extraction.ts";
import { loadModel, cachedLookups } from "../orpc/routers/configs.ts";
import { createExecutors, type ExecutorCtx as ServerExecutorCtx } from "./executors.ts";
import { makePolicy } from "./policy.ts";
import { makeChatAdapter } from "./adapter.ts";
import { validateFile } from "./validate-file.ts";
import { auditLine } from "./audit.ts";

// Glue: assembles the full `AssistantDeps` (packages/assistant/src/loop.ts) from apps/server's
// existing loaders (configs.ts) plus this task's four adapter modules. Kept thin on purpose —
// no policy/business logic lives here, only wiring.

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

async function loadModelAndLookups(tenantId: string, modelId: string) {
  const model = await loadModel(tenantId, modelId);
  const lookups = await cachedLookups(tenantId, model);
  return { model: model as ModelLike, lookups };
}

/** Wraps a Task 10-11 executor (`(input) => Promise<result>`, managing its own persistence —
 *  module-level `db`, or its own `db.transaction()` for selectCandidates) into the 3-argument
 *  shape `loop.ts`'s `Executors` type requires: `(input, tx, signal) => Promise<result>`.
 *
 *  `tx` is accepted but deliberately never threaded into `calculate`/`selectCandidates`'s own
 *  internal transactions (executors.ts is untouched by this task). This is safe despite not
 *  being fully atomic with `runToolOperation`'s own completion-row UPDATE: `calculate` (via
 *  `executeRunFromSnapshot`) already has idempotent reuse-detection — a repeated call with
 *  matching entries/batches/model-snapshot against an already-`calculated` project returns the
 *  existing run instead of re-inserting — and `selectCandidates` already CASes on
 *  `expectedSelectionVersion`, so a repeated call after a crash-then-reclaim window gets a safe
 *  `SELECTION_CHANGED` rejection, never a silent double-apply. A crash between the executor's own
 *  commit and `runToolOperation`'s completion-row UPDATE can therefore at worst produce a
 *  confusing-but-safe error on the rare retry — never corrupt data or double-apply. This is a
 *  known, deliberate limitation (in the same spirit as this plan's other named deltas, e.g. the
 *  opaque candidateId scoped to its run row), not an oversight: `executeRunFromSnapshot` is also
 *  shared with the plain (non-assistant) `configs.run` handler, so changing its signature has
 *  blast radius beyond Chati, and Postgres transactions can't be handed a foreign connection
 *  anyway.
 *
 *  `signal` is honored best-effort only: `agentFetcher`/`runRequest` (used by
 *  `searchSimilar`/`getDocHistory`/`calculate`'s lookups) accept no `AbortSignal` — checked
 *  `runRequest`/`entities.ts`, and there is no outbound `fetch()` in that path to hook (agent
 *  calls are DB-mediated pull/lease, not an HTTP call from this server) — so an in-flight agent
 *  request can't be cancelled early. This wrapper only rejects a call that hasn't started yet
 *  when the signal is ALREADY aborted; the per-tool 30s/60s timeout is therefore soft for
 *  agent-backed reads, with the turn's own 120s watchdog as the hard backstop. */
function wrap<I, O>(fn: (input: I) => Promise<O>) {
  return async (input: unknown, _tx: unknown, signal: AbortSignal): Promise<unknown> => {
    if (signal.aborted) throw new Error("Turn aborted before this tool call started");
    return fn(input as I);
  };
}

function makeExecutors(ctx: ExecutorCtx): Executors {
  // `model`/`file` are typed narrower on the real (executors.ts) ExecutorCtx than on loop.ts's
  // structurally-mirrored one (concrete ModelDef-bearing model; a literal mimeType union) —
  // `deps.ts`'s own loaders (`loadModelAndLookups`, and Chati's file schema) already guarantee
  // the runtime value satisfies the narrower shape, so this is a type-level cast, not a runtime
  // trust decision.
  const real = createExecutors({ ...ctx, model: ctx.model as ServerExecutorCtx["model"], file: ctx.file as ServerExecutorCtx["file"] });
  return {
    state: real.state,
    setValues: wrap(real.setValues),
    extractFromDrawing: wrap(real.extractFromDrawing),
    previewCandidates: wrap(real.previewCandidates),
    calculate: wrap(real.calculate),
    selectCandidates: wrap(real.selectCandidates),
    searchSimilar: wrap(real.searchSimilar),
    getDocHistory: wrap(real.getDocHistory),
    suggestFollowUps: wrap(real.suggestFollowUps),
  };
}

export const assistantDeps: AssistantDeps = {
  db,
  fileSchema: ExtractFileZ,
  loadProject,
  loadModelAndLookups,
  makeExecutors,
  policy: makePolicy(),
  makeChatAdapter,
  validateFile,
  audit: auditLine,
};
