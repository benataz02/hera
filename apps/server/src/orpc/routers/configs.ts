import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db, configModel, configProject, configRun, type RunCandidate, type RunSelection } from "@hera/db";
import {
  computeOutputs, DslError, enumerate, EntriesZ, OutputOverridesZ, propagate,
  type ModelDef, type Outputs, type ResolvedLookups,
} from "@hera/config-engine";
import { userProcedure } from "../base.ts";
import { assertAgentReady } from "./entities.ts";
import { agentFetcher, tenantTables } from "./models.ts";
import { resolveLookups, type QueryFetcher } from "../../lookups.ts";

// The configuration process API: any member drives a project (draft -> calculated via run).
// Trust model: browser propagates for preview; THESE handlers compute the numbers that get
// stored. Lookups: ~5-min cache for interactive use, always fresh inside executeRun.

const needsAgent = (m: ModelDef): boolean =>
  m.queryTables.length > 0 || m.parameters.some((p) => p.domain?.kind === "options" && p.domain.ref.source === "query");

async function loadModel(tenantId: string, modelId: string) {
  const [m] = await db
    .select({ id: configModel.id, name: configModel.name, definition: configModel.definition, updatedAt: configModel.updatedAt })
    .from(configModel)
    .where(and(eq(configModel.id, modelId), eq(configModel.tenantId, tenantId)))
    .limit(1);
  if (!m) throw new ORPCError("NOT_FOUND", { message: "Model not found" });
  return m;
}

async function freshLookups(tenantId: string, model: ModelDef, fetchQuery: QueryFetcher): Promise<ResolvedLookups> {
  try {
    return await resolveLookups(model, await tenantTables(tenantId), fetchQuery);
  } catch (e) {
    if (e instanceof ORPCError) throw e; // agent offline etc. — keep the specific message
    throw new ORPCError("BAD_GATEWAY", { message: e instanceof Error ? e.message : String(e) });
  }
}

// ponytail: per-process cache keyed by model updatedAt (auto-invalidates on save);
// Redis/LRU only if the server ever scales past one Bun process.
const CACHE_TTL_MS = 5 * 60_000;
const lookupCache = new Map<string, { at: number; lookups: ResolvedLookups }>();

export async function executeRun(tenantId: string, projectId: string, fetchQuery: QueryFetcher) {
  const [project] = await db
    .select()
    .from(configProject)
    .where(and(eq(configProject.id, projectId), eq(configProject.tenantId, tenantId)))
    .limit(1);
  if (!project) throw new ORPCError("NOT_FOUND");
  if (!project.batches.length) throw new ORPCError("BAD_REQUEST", { message: "Add at least one batch quantity" });

  const model = await loadModel(tenantId, project.modelId);
  const lookups = await freshLookups(tenantId, model.definition, fetchQuery); // always fresh at run time

  try {
    const pre = propagate(model.definition, lookups, project.entries);
    if (pre.conflicts.length)
      throw new ORPCError("BAD_REQUEST", {
        message: `Configuration has conflicts: ${pre.conflicts.map((c) => c.message).join("; ")}`,
      });
    const en = enumerate(model.definition, lookups, project.entries);
    if (!en.candidates.length)
      throw new ORPCError("BAD_REQUEST", { message: "No valid configuration completes the current entries" });

    const candidates: RunCandidate[] = en.candidates.map((assignment) => ({
      assignment,
      perBatch: project.batches.map((batchQty) => ({
        batchQty,
        outputs: computeOutputs(model.definition, lookups, assignment, batchQty),
      })),
    }));

    const runId = await db.transaction(async (tx) => {
      const [run] = await tx
        .insert(configRun)
        .values({
          tenantId, projectId,
          modelSnapshot: model.definition, lookupSnapshot: lookups,
          entries: project.entries, candidates,
        })
        .returning({ id: configRun.id });
      await tx
        .update(configProject)
        .set({ status: "calculated", updatedAt: new Date() })
        .where(eq(configProject.id, projectId));
      return run!.id;
    });
    return { runId, candidateCount: candidates.length, capped: en.capped, widest: en.widest };
  } catch (e) {
    // Save-gated models shouldn't hit DSL errors, but live lookup data can (missing LOOKUP row).
    if (e instanceof DslError) throw new ORPCError("BAD_REQUEST", { message: e.message });
    throw e;
  }
}

export function applySelection(
  run: { modelSnapshot: ModelDef; lookupSnapshot: ResolvedLookups; candidates: RunCandidate[] },
  selection: RunSelection[],
): { candidateIdx: number; batchQty: number; outputs: Outputs }[] {
  return selection.map((s) => {
    const cand = run.candidates[s.candidateIdx];
    if (!cand) throw new ORPCError("BAD_REQUEST", { message: `No candidate at index ${s.candidateIdx}` });
    try {
      const outputs = computeOutputs(run.modelSnapshot, run.lookupSnapshot, cand.assignment, s.batchQty, s.overrides);
      return { candidateIdx: s.candidateIdx, batchQty: s.batchQty, outputs };
    } catch (e) {
      if (e instanceof DslError || e instanceof RangeError) throw new ORPCError("BAD_REQUEST", { message: e.message });
      throw e;
    }
  });
}

const SelectionZ = z.object({
  candidateIdx: z.number().int().min(0),
  batchQty: z.number().int().min(1),
  overrides: OutputOverridesZ.optional(),
});

export const configsRouter = {
  // Members can list models (id + name only) to start a configuration; editing stays admin-only.
  models: userProcedure.handler(({ context }) =>
    db
      .select({ id: configModel.id, name: configModel.name })
      .from(configModel)
      .where(eq(configModel.tenantId, context.tenantId))
      .orderBy(configModel.name),
  ),

  list: userProcedure.handler(({ context }) =>
    db
      .select({
        id: configProject.id, name: configProject.name, status: configProject.status,
        customer: configProject.customer, modelName: configModel.name, updatedAt: configProject.updatedAt,
      })
      .from(configProject)
      .innerJoin(configModel, eq(configModel.id, configProject.modelId))
      .where(eq(configProject.tenantId, context.tenantId))
      .orderBy(desc(configProject.updatedAt)),
  ),

  get: userProcedure.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
    const [project] = await db
      .select()
      .from(configProject)
      .where(and(eq(configProject.id, input.id), eq(configProject.tenantId, context.tenantId)))
      .limit(1);
    if (!project) throw new ORPCError("NOT_FOUND");
    const model = await loadModel(context.tenantId, project.modelId);
    const [latestRun] = await db
      .select()
      .from(configRun)
      .where(and(eq(configRun.projectId, project.id), eq(configRun.tenantId, context.tenantId)))
      .orderBy(desc(configRun.createdAt))
      .limit(1);
    return { project, model, latestRun: latestRun ?? null };
  }),

  create: userProcedure
    .input(z.object({ modelId: z.uuid(), name: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      const model = await loadModel(context.tenantId, input.modelId);
      const [ins] = await db
        .insert(configProject)
        .values({
          tenantId: context.tenantId, modelId: model.id, name: input.name,
          batches: model.definition.batchDefaults, createdBy: context.userId,
        })
        .returning({ id: configProject.id });
      return { id: ins!.id };
    }),

  update: userProcedure
    .input(
      z.object({
        id: z.uuid(),
        name: z.string().min(1).optional(),
        customer: z.object({ cardCode: z.string(), cardName: z.string() }).nullable().optional(),
        entries: EntriesZ.optional(),
        batches: z.array(z.number().int().min(1)).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const { id, ...rest } = input;
      const fields: Partial<typeof configProject.$inferInsert> = { ...rest, updatedAt: new Date() };
      // Changing what gets computed invalidates a previous run's "calculated" claim.
      if (input.entries !== undefined || input.batches !== undefined) fields.status = "draft";
      const updated = await db
        .update(configProject)
        .set(fields)
        .where(and(eq(configProject.id, id), eq(configProject.tenantId, context.tenantId)))
        .returning({ id: configProject.id });
      if (!updated.length) throw new ORPCError("NOT_FOUND");
      return { ok: true };
    }),

  remove: userProcedure.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
    await db.transaction(async (tx) => {
      await tx.delete(configRun).where(and(eq(configRun.projectId, input.id), eq(configRun.tenantId, context.tenantId)));
      await tx.delete(configProject).where(and(eq(configProject.id, input.id), eq(configProject.tenantId, context.tenantId)));
    });
    return { ok: true };
  }),

  // Resolved lookups for client-side live propagation (wizard step 1). Cached ~5 min;
  // key includes the model's updatedAt so a model save is picked up immediately.
  lookups: userProcedure.input(z.object({ modelId: z.uuid() })).handler(async ({ input, context }) => {
    const model = await loadModel(context.tenantId, input.modelId);
    const key = `${context.tenantId}:${model.id}:${model.updatedAt.getTime()}`;
    const hit = lookupCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.lookups;
    if (needsAgent(model.definition)) await assertAgentReady(context.tenantId);
    const lookups = await freshLookups(context.tenantId, model.definition, agentFetcher(context.tenantId));
    lookupCache.set(key, { at: Date.now(), lookups });
    return lookups;
  }),

  run: userProcedure.input(z.object({ projectId: z.uuid() })).handler(async ({ input, context }) => {
    const [project] = await db
      .select({ modelId: configProject.modelId })
      .from(configProject)
      .where(and(eq(configProject.id, input.projectId), eq(configProject.tenantId, context.tenantId)))
      .limit(1);
    if (!project) throw new ORPCError("NOT_FOUND");
    const model = await loadModel(context.tenantId, project.modelId);
    if (needsAgent(model.definition)) await assertAgentReady(context.tenantId);
    return executeRun(context.tenantId, input.projectId, agentFetcher(context.tenantId));
  }),

  // Store the user's candidate/batch/override picks; totals are recomputed HERE from the
  // run snapshot — client-sent numbers are never persisted.
  select: userProcedure
    .input(z.object({ runId: z.uuid(), selection: z.array(SelectionZ).min(1) }))
    .handler(async ({ input, context }) => {
      const [run] = await db
        .select()
        .from(configRun)
        .where(and(eq(configRun.id, input.runId), eq(configRun.tenantId, context.tenantId)))
        .limit(1);
      if (!run) throw new ORPCError("NOT_FOUND");
      const selections = applySelection(run, input.selection);
      await db.update(configRun).set({ selection: input.selection }).where(eq(configRun.id, run.id));
      return { selections };
    }),
};
