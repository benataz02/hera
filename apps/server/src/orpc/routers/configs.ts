import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db, configModel, configProject, user,
  type ConfigCandidate, type ConfigSelection, type ProjectEvent,
} from "@hera/db";
import { assistantConversation } from "@hera/assistant/schema";
import {
  computeOutputs, DslError, enumerate, EntriesZ, OutputOverridesZ, propagate,
  type Entries, type ModelDef, type Outputs, type ResolvedLookups, type Val,
} from "@hera/config-engine";
import { userProcedure } from "../base.ts";
import { B1Error, rowsOf } from "@hera/b1";
import { runnerFor, tenantConnector, viaB1 } from "../../b1.ts";
import { tenantTables } from "./models.ts";
import { enrichLookups, fetchQueryTable, queryPageSource, resolveLookups, type QueryRunner } from "../../lookups.ts";
import { loadHistoryRows } from "../../history-sync.ts";
import { scoreRows } from "../../similarity.ts";
import { docHistoryQuery, flattenDocs, sortDocRows, type DocRow } from "../../doc-history.ts";
import {
  assertConfigMutable,
  buildQuoteSeed,
  configDocumentCommandId,
  quotedTotals,
  validateSelectionPairs,
  DEDUP_UDF,
} from "../../config-quote.ts";
// The configuration process API: any member drives a project (draft -> calculated).
// Trust model: browser propagates for preview; THESE handlers compute the numbers that get
// stored. Lookups: ~5-min cache for interactive use, always fresh inside calculateProject.

export const needsSap = (m: ModelDef): boolean =>
  m.queryTables.length > 0 || m.parameters.some((p) => p.domain?.kind === "options" && p.domain.ref.source === "query");

/** A runner for this model: the tenant's agent when the model reads live data, and otherwise one
 *  that would throw if anything called it — so an agent-free model never touches sap_connection. */
export async function modelRunner(tenantId: string, m: ModelDef): Promise<QueryRunner> {
  if (!needsSap(m)) return () => Promise.reject(new Error("Model has no live queries"));
  return runnerFor(await tenantConnector(tenantId));
}

export async function loadModel(tenantId: string, modelId: string) {
  const [m] = await db
    .select({
      id: configModel.id, name: configModel.name, definition: configModel.definition,
      updatedAt: configModel.updatedAt, portal: configModel.portal,
    })
    .from(configModel)
    .where(and(eq(configModel.id, modelId), eq(configModel.tenantId, tenantId)))
    .limit(1);
  if (!m) throw new ORPCError("NOT_FOUND", { message: "Model not found" });
  return m;
}

async function freshLookups(tenantId: string, model: ModelDef, run: QueryRunner): Promise<ResolvedLookups> {
  try {
    return await resolveLookups(model, await tenantTables(tenantId), run);
  } catch (e) {
    if (e instanceof ORPCError) throw e; // SAP-not-connected etc. — keep the specific message
    throw new ORPCError("BAD_GATEWAY", { message: e instanceof Error ? e.message : String(e) });
  }
}

// ponytail: per-process cache keyed by model updatedAt (auto-invalidates on save);
// Redis/LRU only if the server ever scales past one Bun process.
const CACHE_TTL_MS = 5 * 60_000;
// The *promise* is cached, not the value: concurrent cold callers then share one lookup fetch
// instead of racing (same trick as resolveLookups' fetchOnce).
const lookupCache = new Map<string, { at: number; lookups: Promise<ResolvedLookups> }>();

/** The one way to resolve a model's lookups. Every caller goes through this cache — a run fired by
 *  the process page's auto-calculate would otherwise re-GET every query table on each keystroke. */
export function cachedLookups(
  tenantId: string, model: Awaited<ReturnType<typeof loadModel>>,
  run?: QueryRunner,
): Promise<ResolvedLookups> {
  const key = `${tenantId}:${model.id}:${model.updatedAt.getTime()}`;
  const hit = lookupCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.lookups;
  // An injected runner is the test seam (see configurator.test.ts); production resolves the
  // tenant's agent — but only for a model that actually reads live data.
  const p = (async () =>
    freshLookups(tenantId, model.definition, run ?? await modelRunner(tenantId, model.definition)))();
  p.catch(() => lookupCache.delete(key)); // a failed live lookup must not poison the key for 5 minutes
  lookupCache.set(key, { at: Date.now(), lookups: p });
  return p;
}

/** One page of a model's query table, for the value help. The caller names a table; the query is
 *  resolved from the stored model by queryPageSource (`models.queryPage` is the ad-hoc-query
 *  variant and stays admin-only). The cursor is a plain row offset and nothing else. */
export const QueryPageZ = z.object({
  modelId: z.uuid(),
  table: z.string().min(1),
  search: z.string().optional(),
  searchCols: z.array(z.string()).optional(),
  cursor: z.number().int().min(0).optional(),
});

export async function queryTablePage(
  tenantId: string, definition: ModelDef, input: z.infer<typeof QueryPageZ>,
) {
  let q;
  try {
    q = queryPageSource(definition, input);
  } catch (e) {
    throw new ORPCError("BAD_REQUEST", { message: e instanceof Error ? e.message : String(e) });
  }
  const run = runnerFor(await tenantConnector(tenantId));
  return fetchQueryTable(run, q.target, q.query, q.columns, { skip: q.skip });
}

/** Live model + lookups for a stored calculation. There is no snapshot: stored candidates are
 *  always re-priced against what the model and SAP say now. `enrichLookups` is not optional — it
 *  re-appends the off-page query rows a persisted entry may depend on. */
export async function liveEngine(tenantId: string, project: { modelId: string; entries: Entries }) {
  const model = await loadModel(tenantId, project.modelId);
  const runner = await modelRunner(tenantId, model.definition);
  const lookups = await enrichLookups(
    model.definition, project.entries, await cachedLookups(tenantId, model, runner), runner,
  );
  return { model, lookups };
}

/** The calculate path, shared by configs.run, portal.run and Chati's calculate tool. `entries` /
 *  `batches` default to the project's own; Chati passes its turn's working values instead, and
 *  those are persisted as part of the same UPDATE.
 *
 *  Reuse: a calculated project whose entries, batches and model are all unchanged keeps its
 *  candidates instead of re-enumerating. */
export async function calculateProject(
  tenantId: string, projectId: string, run: QueryRunner,
  override?: { entries: Entries; batches: number[] },
) {
  const [project] = await db
    .select({
      modelId: configProject.modelId, status: configProject.status, entries: configProject.entries,
      batches: configProject.batches, candidates: configProject.candidates,
      calculatedAt: configProject.calculatedAt, updatedAt: configProject.updatedAt,
    })
    .from(configProject)
    .where(and(eq(configProject.id, projectId), eq(configProject.tenantId, tenantId)))
    .limit(1);
  if (!project) throw new ORPCError("NOT_FOUND");
  const entries = override?.entries ?? project.entries;
  const batches = override?.batches ?? project.batches;
  if (!batches.length) throw new ORPCError("BAD_REQUEST", { message: "Add at least one batch quantity" });

  const model = await loadModel(tenantId, project.modelId);

  // Runs before the lookups resolve: a no-op recalculate must not pay for a resolution it is about
  // to throw away. The process page auto-calculates ~1s after every field edit.
  //
  // `status === "calculated"` is what proves the stored candidates still match the project's own
  // entries — every writer of entries/batches resets the status to draft. The comparison below
  // only decides the override case (Chati proposing values the project does not hold yet), where
  // it is the sole signal.
  if (
    project.status === "calculated" && project.calculatedAt && project.calculatedAt >= model.updatedAt &&
    JSON.stringify(project.entries) === JSON.stringify(entries) &&
    JSON.stringify(project.batches) === JSON.stringify(batches)
  ) {
    return {
      projectVersion: project.updatedAt.toISOString(), reused: true,
      candidateCount: project.candidates.length, capped: project.candidates.length >= 200,
      widest: undefined, candidates: project.candidates,
    };
  }

  const lookups = await enrichLookups(
    model.definition, entries, await cachedLookups(tenantId, model, run), run,
  );

  try {
    const pre = propagate(model.definition, lookups, entries);
    if (pre.conflicts.length)
      throw new ORPCError("BAD_REQUEST", {
        message: `Configuration has conflicts: ${pre.conflicts.map((c) => c.message).join("; ")}`,
      });
    const en = enumerate(model.definition, lookups, entries);
    if (!en.candidates.length)
      throw new ORPCError("BAD_REQUEST", { message: "No valid configuration completes the current entries" });
    const candidates: ConfigCandidate[] = en.candidates.map((assignment) => ({
      assignment,
      perBatch: batches.map((batchQty) => ({
        batchQty, outputs: computeOutputs(model.definition, lookups, assignment, batchQty),
      })),
    }));

    // One row, overwritten in place: entries and candidates move together, which is what lets
    // status === "calculated" stand in for "these entries produced these candidates".
    const now = new Date();
    const updated = await db.update(configProject)
      .set({ entries, batches, candidates, calculatedAt: now, status: "calculated", updatedAt: now })
      .where(and(eq(configProject.id, projectId), eq(configProject.tenantId, tenantId)))
      .returning({ id: configProject.id });
    if (!updated.length) throw new ORPCError("NOT_FOUND");
    return {
      projectVersion: now.toISOString(), reused: false,
      candidateCount: candidates.length, capped: en.capped, widest: en.widest, candidates,
    };
  } catch (e) {
    if (e instanceof DslError) throw new ORPCError("BAD_REQUEST", { message: e.message });
    throw e;
  }
}

// Exact help: live B1 Orders + Quotations for the project customer and/or the item-code param.
// itemCode is only ever a quoted filter value.
export async function fetchDocHistory(
  tenantId: string,
  projectId: string,
  itemCode?: string,
): Promise<{ itemCode: string | null; cardCode: string | null; rows: DocRow[] }> {
  const [project] = await db
    .select({ customer: configProject.customer })
    .from(configProject)
    .where(and(eq(configProject.id, projectId), eq(configProject.tenantId, tenantId)))
    .limit(1);
  if (!project) throw new ORPCError("NOT_FOUND");
  const trimmedItemCode = itemCode?.trim() || undefined;
  const cardCode = project.customer?.cardCode;
  if (!trimmedItemCode && !cardCode) return { itemCode: null, cardCode: null, rows: [] };

  const opts = { itemCode: trimmedItemCode, cardCode };
  const { b1 } = await tenantConnector(tenantId);
  // Two crossjoins in parallel — one per document type; B1 has no union.
  const [orders, quotes] = await viaB1(() =>
    Promise.all([
      b1.crossJoin(docHistoryQuery("Orders", opts)),
      b1.crossJoin(docHistoryQuery("Quotations", opts)),
    ]),
  );
  return {
    itemCode: trimmedItemCode ?? null,
    cardCode: cardCode ?? null,
    rows: sortDocRows([
      ...flattenDocs("order", orders.data, opts),
      ...flattenDocs("quotation", quotes.data, opts),
    ]),
  };
}

// Similarity help: rank cached historic rows against the live (unsaved) entries. `values` are
// the row's mapped param values, coerced to each param's type — what the Copy button applies.
export async function searchSimilarRows(tenantId: string, projectId: string, entries: Entries) {
  const [project] = await db
    .select({ modelId: configProject.modelId })
    .from(configProject)
    .where(and(eq(configProject.id, projectId), eq(configProject.tenantId, tenantId)))
    .limit(1);
  if (!project) throw new ORPCError("NOT_FOUND");
  const model = await loadModel(tenantId, project.modelId);
  const h = model.definition.history;
  if (!h?.mappings.length) return { results: [] };
  const rows = await loadHistoryRows(tenantId, model.id);
  const typeOf = new Map(model.definition.parameters.map((p) => [p.key, p.type]));
  const coerce = (param: string, v: Val): Val =>
    v === null ? null
    : typeOf.get(param) === "number" ? (Number.isFinite(Number(v)) ? Number(v) : null)
    : typeOf.get(param) === "boolean" ? (typeof v === "boolean" ? v : String(v).toLowerCase() === "true")
    : String(v);
  return {
    results: scoreRows(h, entries, rows).map((s) => ({
      score: s.score,
      matches: s.matches,
      display: Object.fromEntries(h.display.map((c) => [c, s.row[c] ?? null])),
      values: Object.fromEntries(h.mappings.map((m) => [m.param, coerce(m.param, s.row[m.column] ?? null)])),
    })),
  };
}

// ---- Quotation write-back -------------------------------------------------------------------
// Numbers are recomputed from the persisted selection on both the draft and the post, so the
// browser can influence *which* selection is quoted (via commandId) and nothing else.

async function loadProject(tenantId: string, projectId: string) {
  const [project] = await db.select().from(configProject)
    .where(and(eq(configProject.id, projectId), eq(configProject.tenantId, tenantId))).limit(1);
  if (!project) throw new ORPCError("NOT_FOUND");
  if (!project.candidates.length)
    throw new ORPCError("BAD_REQUEST", { message: "Calculate the configuration before quoting" });
  return project;
}

export async function quoteDraft(tenantId: string, projectId: string) {
  const project = await loadProject(tenantId, projectId);
  const { model, lookups } = await liveEngine(tenantId, project);
  const commandId = configDocumentCommandId({
    tenantId, projectId, candidates: project.candidates, selection: project.selection ?? [],
  });
  return {
    commandId,
    data: buildQuoteSeed(project, model.definition, lookups),
    totals: quotedTotals(model.definition, lookups, project.candidates, project.selection),
    quoted: project.b1DocEntry === null ? null : { docEntry: project.b1DocEntry, quotedAt: project.quotedAt },
  };
}

export async function createQuote(
  tenantId: string,
  input: { projectId: string; commandId: string; comments?: string; docDueDate?: string },
) {
  const project = await loadProject(tenantId, input.projectId);
  // Already posted: the row IS the idempotency record for a retry that got its response.
  if (project.b1DocEntry !== null) return { docEntry: project.b1DocEntry, docNum: null, reused: true };

  const commandId = configDocumentCommandId({
    tenantId, projectId: input.projectId, candidates: project.candidates, selection: project.selection ?? [],
  });
  if (commandId !== input.commandId)
    throw new ORPCError("CONFLICT", { message: "STATE_CHANGED" });

  const { model, lookups } = await liveEngine(tenantId, project);
  const seed = buildQuoteSeed(project, model.definition, lookups);
  const { b1 } = await tenantConnector(tenantId);

  return viaB1(async () => {
    // Check-then-create against the dedup UDF. This covers the window the DB cannot: we POSTed,
    // B1 created the quotation, and our response never arrived.
    const existing = await b1.readEntitySet("Quotations", {
      filter: `${DEDUP_UDF} eq '${commandId}'`, select: ["DocEntry", "DocNum"], top: 1,
    }).catch((e) => {
      // Only a 400 means "no such property"; an unreachable agent or a rejected session is a
      // different problem and must keep its own status rather than becoming setup advice.
      if (e instanceof B1Error && e.status === 400)
        throw new ORPCError("BAD_REQUEST", {
          message: `Cannot check for an existing quotation: ${DEDUP_UDF} is missing from Sales Quotation in SAP. Create it (alphanumeric, length 64) and try again. (${e.message})`,
        });
      throw e;
    });
    const prior = rowsOf(existing.data)[0];

    // createEntity answers with the document itself (Prefer: return-representation), not a
    // collection — so this is `.data`, not `rowsOf(.data)[0]`.
    const doc = (prior ?? (await b1.createEntity("Quotations", {
      ...seed,
      [DEDUP_UDF]: commandId,
      ...(input.comments ? { Comments: input.comments } : {}),
      ...(input.docDueDate ? { DocDueDate: input.docDueDate } : {}),
    }, { prefer: "representation" })).data ?? {}) as Record<string, unknown>;
    const docEntry = Number(doc.DocEntry);
    if (!Number.isFinite(docEntry))
      throw new ORPCError("BAD_GATEWAY", { message: "SAP created the quotation but returned no DocEntry" });

    const totals = quotedTotals(model.definition, lookups, project.candidates, project.selection);
    const now = new Date();
    await db.update(configProject)
      .set({
        status: "quoted", events: pushEvent("quoted"), updatedAt: now,
        b1DocEntry: docEntry, quotedAt: now,
        quotedValue: totals.value.toFixed(4), quotedCost: totals.cost.toFixed(4),
      })
      .where(and(eq(configProject.id, input.projectId), eq(configProject.tenantId, tenantId)));
    return { docEntry, docNum: doc.DocNum === undefined ? null : Number(doc.DocNum), reused: !!prior };
  });
}

export function applySelection(
  model: ModelDef, lookups: ResolvedLookups,
  candidates: ConfigCandidate[], selection: ConfigSelection[],
): { candidateIdx: number; batchQty: number; outputs: Outputs }[] {
  return selection.map((s) => {
    const cand = candidates[s.candidateIdx];
    if (!cand) throw new ORPCError("BAD_REQUEST", { message: `No candidate at index ${s.candidateIdx}` });
    try {
      const outputs = computeOutputs(model, lookups, cand.assignment, s.batchQty, s.overrides);
      return { candidateIdx: s.candidateIdx, batchQty: s.batchQty, outputs };
    } catch (e) {
      if (e instanceof DslError || e instanceof RangeError) throw new ORPCError("BAD_REQUEST", { message: e.message });
      throw e;
    }
  });
}

/** Append one event to config_project.events inside the same guarded UPDATE. */
export const pushEvent = (kind: ProjectEvent["kind"], note?: string) =>
  sql`${configProject.events} || ${JSON.stringify([{ at: new Date().toISOString(), kind, ...(note ? { note } : {}) }])}::jsonb`;

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
    const [creator] = await db.select({ email: user.email }).from(user).where(eq(user.id, project.createdBy)).limit(1);
    return { project, model, createdByEmail: creator?.email ?? null };
  }),

  create: userProcedure
    // No create dialog on the client: a new configuration is an empty draft, and name / model /
    // customer are filled in on its General section (configs.update).
    .input(z.object({ modelId: z.uuid(), name: z.string().min(1).default("Untitled configuration") }))
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
        modelId: z.uuid().optional(),
        customer: z.object({ cardCode: z.string(), cardName: z.string() }).nullable().optional(),
        entries: EntriesZ.optional(),
        batches: z.array(z.number().int().min(1)).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      await assertConfigMutable(context.tenantId, input.id);
      const { id, ...rest } = input;
      const fields: Partial<typeof configProject.$inferInsert> = { ...rest, updatedAt: new Date() };
      // Changing what gets computed invalidates a previous run's "calculated" claim.
      if (input.entries !== undefined || input.batches !== undefined) fields.status = "draft";
      // Switching the model invalidates every entry (a param key only means something inside its
      // own model), so entries/batches start over. Only on an actual change — re-sending the same
      // modelId must not wipe a configuration. loadModel also proves the model is this tenant's.
      if (input.modelId !== undefined) {
        const [cur] = await db
          .select({ modelId: configProject.modelId })
          .from(configProject)
          .where(and(eq(configProject.id, id), eq(configProject.tenantId, context.tenantId)))
          .limit(1);
        if (!cur) throw new ORPCError("NOT_FOUND");
        if (cur.modelId !== input.modelId) {
          const model = await loadModel(context.tenantId, input.modelId);
          fields.entries = {};
          fields.batches = model.definition.batchDefaults;
          fields.status = "draft";
        }
      }
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
      // Chati conversations for this project; FKs cascade turns/messages/tool_executions.
      await tx.delete(assistantConversation).where(and(eq(assistantConversation.tenantId, context.tenantId), eq(assistantConversation.projectId, input.id)));
      await tx.delete(configProject).where(and(eq(configProject.id, input.id), eq(configProject.tenantId, context.tenantId)));
    });
    return { ok: true };
  }),

  // Resolved lookups for client-side live propagation (wizard step 1). Cached ~5 min; key includes
  // the model's updatedAt so a model save is picked up immediately. Query tables contain the same
  // canonical first page used by runs, extraction, the assistant, and portal imports.
  lookups: userProcedure
    .input(z.object({ modelId: z.uuid(), entries: EntriesZ.optional() }))
    .handler(async ({ input, context }) => {
      const model = await loadModel(context.tenantId, input.modelId);
      const run = await modelRunner(context.tenantId, model.definition);
      return enrichLookups(model.definition, input.entries ?? {}, await cachedLookups(context.tenantId, model, run), run);
    }),

  // Value help paging for a query-backed parameter (see queryTablePage).
  queryPage: userProcedure.input(QueryPageZ).handler(async ({ input, context }) =>
    queryTablePage(context.tenantId, (await loadModel(context.tenantId, input.modelId)).definition, input)),

  // Exact help: live B1 Orders + Quotations for the project customer and/or the item-code param.
  // itemCode comes from the client (current unsaved entry); it is only ever a quoted filter value.
  docHistory: userProcedure
    .input(z.object({ id: z.uuid(), itemCode: z.string().optional() }))
    .handler(({ input, context }) => fetchDocHistory(context.tenantId, input.id, input.itemCode)),

  // Similarity help: rank cached historic rows against the live (unsaved) entries. `values` are
  // the row's mapped param values, coerced to each param's type — what the Copy button applies.
  similar: userProcedure
    .input(z.object({ id: z.uuid(), entries: EntriesZ }))
    .handler(({ input, context }) => searchSimilarRows(context.tenantId, input.id, input.entries)),

  run: userProcedure.input(z.object({ projectId: z.uuid() })).handler(async ({ input, context }) => {
    await assertConfigMutable(context.tenantId, input.projectId);
    const [project] = await db
      .select({ modelId: configProject.modelId })
      .from(configProject)
      .where(and(eq(configProject.id, input.projectId), eq(configProject.tenantId, context.tenantId)))
      .limit(1);
    if (!project) throw new ORPCError("NOT_FOUND");
    const model = await loadModel(context.tenantId, project.modelId);
    const { candidateCount, capped, widest } = await calculateProject(
      context.tenantId, input.projectId, await modelRunner(context.tenantId, model.definition),
    );
    return { candidateCount, capped, widest };
  }),

  // Store the user's candidate/batch/override picks; totals are recomputed HERE against the live
  // model and lookups — client-sent numbers are never persisted. The FOR UPDATE below is the fence.
  select: userProcedure
    .input(z.object({
      projectId: z.uuid(),
      selection: z.array(SelectionZ).min(1),
    }))
    .handler(async ({ input, context }) => {
      // Lookups resolve outside the transaction: they can involve a round trip to the customer's
      // agent, and holding a row lock across that is how you get a pile of stuck writers.
      const [pre] = await db
        .select({ modelId: configProject.modelId, entries: configProject.entries })
        .from(configProject)
        .where(and(eq(configProject.id, input.projectId), eq(configProject.tenantId, context.tenantId)))
        .limit(1);
      if (!pre) throw new ORPCError("NOT_FOUND");
      const { model, lookups } = await liveEngine(context.tenantId, pre);

      return db.transaction(async (tx) => {
        const [project] = await tx
          .select({ status: configProject.status, candidates: configProject.candidates })
          .from(configProject)
          .where(and(eq(configProject.id, input.projectId), eq(configProject.tenantId, context.tenantId)))
          .for("update");
        if (!project) throw new ORPCError("NOT_FOUND");
        await assertConfigMutable(context.tenantId, input.projectId, tx);
        validateSelectionPairs(project.candidates, input.selection);
        const selections = applySelection(model.definition, lookups, project.candidates, input.selection);
        await tx
          .update(configProject)
          .set({ selection: input.selection })
          .where(and(eq(configProject.id, input.projectId), eq(configProject.tenantId, context.tenantId)));
        return { selections };
      });
    }),

  // What will be posted to B1, recomputed from the persisted project. The commandId comes back
  // with it and is echoed by createQuote, so the client can never widen the selection between
  // preview and post.
  quoteDraft: userProcedure
    .input(z.object({ projectId: z.uuid() }))
    .handler(({ input, context }) => quoteDraft(context.tenantId, input.projectId)),

  createQuote: userProcedure
    .input(z.object({
      projectId: z.uuid(),
      commandId: z.string().length(64),
      // Only these two are the salesperson's to set; every number is recomputed server-side.
      comments: z.string().max(2000).optional(),
      docDueDate: z.iso.date().optional(),
    }))
    .handler(({ input, context }) => createQuote(context.tenantId, input)),

  // Internal reviewer sends a portal request back with a note. requested → rejected.
  reject: userProcedure
    .input(z.object({ id: z.uuid(), note: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      const updated = await db
        .update(configProject)
        .set({ status: "rejected", rejectionNote: input.note, events: pushEvent("rejected", input.note), updatedAt: new Date() })
        .where(and(
          eq(configProject.id, input.id), eq(configProject.tenantId, context.tenantId),
          eq(configProject.status, "requested"),
        ))
        .returning({ id: configProject.id });
      if (!updated.length) throw new ORPCError("BAD_REQUEST", { message: "Only a requested configuration can be rejected" });
      return { ok: true };
    }),
};
