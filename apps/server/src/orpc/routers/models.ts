import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, count, eq, max } from "drizzle-orm";
import { db, configHistory, configModel, configProject } from "@hera/db";
import { checkModel, ModelDefZ, RESERVED_LINE_FIELDS } from "@hera/config-engine";
import { adminProcedure } from "../base.ts";
import { queryRowsFor, resolveLookups } from "../../lookups.ts";
import { knownTables, masterdataRows } from "./masterdata.ts";
import { runnerFor, tenantConnector } from "../../b1.ts";
import { syncModelHistory } from "../../history-sync.ts";
import { compileSpec, listPage, ListPageZ, TOTAL, type SqlFields } from "../../list-sql.ts";
import { entitySchema } from "../../entity-meta.ts";
import { viaB1 } from "../../b1.ts";

// Admin-only configurator model builder API. save is the gate: a model that passes
// ModelDefZ + checkModel here can never produce a parse/unknown-ref error at runtime.

// Standard DocumentLine fields an items table may write. Short by design: everything else a
// customer wants on the line is a UDF, which lineFields discovers from their own B1.
const STANDARD_LINE_FIELDS = new Set(["ItemDescription", "FreeText", "MeasureUnit", "Width1", "Height1", "Length1"]);

const MODEL_FIELDS: SqlFields = {
  name: { col: configModel.name, kind: "string" },
  updatedAt: { col: configModel.updatedAt, kind: "date" },
};

export const modelsRouter = {
  /** One page of the models list for a saved view. `list` stays: GlobalSearch still needs the
   *  whole array to search it in the browser. */
  rows: adminProcedure.input(ListPageZ).handler(async ({ input, context }) => {
    const { where, orderBy } = compileSpec(MODEL_FIELDS, input.spec);
    const raw = await db
      .select({ id: configModel.id, name: configModel.name, updatedAt: configModel.updatedAt, _total: TOTAL })
      .from(configModel)
      .where(and(eq(configModel.tenantId, context.tenantId), where))
      // `id` last so the order is total — OFFSET paging over a non-unique sort duplicates and skips
      // rows between pages.
      .orderBy(...orderBy, configModel.name, configModel.id)
      .limit(input.top)
      .offset(input.skip ?? 0);
    return listPage(raw, input.top, input.skip);
  }),

  list: adminProcedure.handler(({ context }) =>
    db
      .select({ id: configModel.id, name: configModel.name, updatedAt: configModel.updatedAt })
      .from(configModel)
      .where(eq(configModel.tenantId, context.tenantId))
      .orderBy(configModel.name),
  ),

  get: adminProcedure.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
    const [row] = await db
      .select()
      .from(configModel)
      .where(and(eq(configModel.id, input.id), eq(configModel.tenantId, context.tenantId)))
      .limit(1);
    if (!row) throw new ORPCError("NOT_FOUND");
    return row;
  }),

  save: adminProcedure
    .input(z.object({
      id: z.uuid().optional(),
      definition: ModelDefZ,
      portal: z.boolean().optional(),
      portalDescription: z.string().nullable().optional(),
    }))
    .handler(async ({ input, context }) => {
      const issues = checkModel(input.definition, knownTables(await masterdataRows(context.tenantId)));
      if (issues.length) throw new ORPCError("BAD_REQUEST", { message: "Model has errors", data: { issues } });
      const fields = {
        name: input.definition.name, definition: input.definition, updatedAt: new Date(),
        ...(input.portal !== undefined ? { portal: input.portal } : {}),
        ...(input.portalDescription !== undefined ? { portalDescription: input.portalDescription } : {}),
      };
      // RETURNING the whole row (not just the id) so the client can seed its models.get cache
      // from the save response instead of refetching.
      if (input.id) {
        const [updated] = await db
          .update(configModel)
          .set(fields)
          .where(and(eq(configModel.id, input.id), eq(configModel.tenantId, context.tenantId)))
          .returning();
        if (!updated) throw new ORPCError("NOT_FOUND");
        return updated;
      }
      const [ins] = await db
        .insert(configModel)
        .values({ tenantId: context.tenantId, ...fields })
        .returning();
      return ins!;
    }),

  remove: adminProcedure.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
    const [inUse] = await db
      .select({ id: configProject.id })
      .from(configProject)
      .where(and(eq(configProject.tenantId, context.tenantId), eq(configProject.modelId, input.id)))
      .limit(1);
    if (inUse) throw new ORPCError("BAD_REQUEST", { message: "Model is used by existing configurations" });
    await db.delete(configModel).where(and(eq(configModel.id, input.id), eq(configModel.tenantId, context.tenantId)));
    return { ok: true };
  }),


  // "Sync now": run the model's history query through the agent and wholesale-replace config_history.
  syncHistory: adminProcedure.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
    const [m] = await db
      .select({ id: configModel.id, definition: configModel.definition })
      .from(configModel)
      .where(and(eq(configModel.id, input.id), eq(configModel.tenantId, context.tenantId)))
      .limit(1);
    if (!m) throw new ORPCError("NOT_FOUND");
    if (!m.definition.history?.query)
      throw new ORPCError("BAD_REQUEST", { message: "Save a history query first" });
    return syncModelHistory(context.tenantId, m.id, m.definition, runnerFor(await tenantConnector(context.tenantId)));
  }),

  historyInfo: adminProcedure.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
    const [r] = await db
      .select({ count: count(), lastSyncedAt: max(configHistory.syncedAt) })
      .from(configHistory)
      .where(and(eq(configHistory.tenantId, context.tenantId), eq(configHistory.modelId, input.id)));
    return { count: r?.count ?? 0, lastSyncedAt: r?.lastSyncedAt ?? null };
  }),

  // Live preview for the (possibly unsaved) builder draft: same resolver as configs.lookups/run,
  // keyed by the posted definition instead of a saved model id. Client sends a stripped-down
  // "lookup skeleton" so typing in expression fields doesn't refetch.
  previewLookups: adminProcedure
    .input(z.object({ definition: ModelDefZ }))
    .handler(async ({ input, context }) => {
      try {
        const rows = await masterdataRows(context.tenantId);
        return await resolveLookups(
          input.definition, rows,
          queryRowsFor(input.definition, rows).length
            ? runnerFor(await tenantConnector(context.tenantId))
            : () => Promise.reject(new Error("Model has no live queries")),
        );
      } catch (e) {
        if (e instanceof ORPCError) throw e; // SAP-unavailable etc. — keep the specific message
        throw new ORPCError("BAD_GATEWAY", { message: e instanceof Error ? e.message : String(e) });
      }
    }),

  /** DocumentLine fields an items table may map its columns onto, from the tenant's own
   *  Quotations metadata — so the dropdown lists that customer's real UDFs rather than a guess.
   *  Errors are NOT mapped to a failure the builder blocks on: the caller falls back to a
   *  free-text field, because a down tunnel must not make the model builder unusable. */
  lineFields: adminProcedure.handler(async ({ context }) => {
    const b1 = (await tenantConnector(context.tenantId)).b1;
    const schema = await viaB1(() => entitySchema(context.tenantId, b1, "Quotations"));
    // fields is an array, not a record; DocumentLines is a collection carrying its own fields.
    const lines = schema.fields.find((f) => f.name === "DocumentLines")?.fields ?? [];
    return lines
      .filter((f) => (f.isUDF || STANDARD_LINE_FIELDS.has(f.name)) && !RESERVED_LINE_FIELDS.has(f.name))
      .map((f) => ({ name: f.name, label: f.label ?? f.name, isUDF: !!f.isUDF }))
      .sort((a, b) => Number(b.isUDF) - Number(a.isUDF) || a.name.localeCompare(b.name));
  }),
};
