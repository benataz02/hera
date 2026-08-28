import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, count, eq, max } from "drizzle-orm";
import { db, configHistory, configModel, configProject, configTable } from "@hera/db";
import { checkModel, LookupRefZ, ModelDefZ, ODataQueryZ, ValZ } from "@hera/config-engine";
import { adminProcedure } from "../base.ts";
import { addQueryTables, fetchQueryTable, optionsFromRef, resolveLookups, tablesFromTenant, withSearch, type TenantTable } from "../../lookups.ts";
import { runnerFor, tenantConnector } from "../../b1.ts";
import { syncModelHistory } from "../../history-sync.ts";

// Admin-only configurator model builder API. save is the gate: a model that passes
// ModelDefZ + checkModel here can never produce a parse/unknown-ref error at runtime.

const ColumnZ = z.object({
  key: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "must be a valid identifier"),
  label: z.string(),
  type: z.enum(["string", "number", "boolean"]),
});

export async function tenantTables(tenantId: string): Promise<TenantTable[]> {
  return db
    .select({ name: configTable.name, columns: configTable.columns, rows: configTable.rows })
    .from(configTable)
    .where(eq(configTable.tenantId, tenantId));
}

export const modelsRouter = {
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
      const known = (await tenantTables(context.tenantId)).map((t) => ({ name: t.name, columns: t.columns.map((c) => c.key) }));
      const issues = checkModel(input.definition, known);
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

  tables: {
    list: adminProcedure.handler(({ context }) =>
      db.select().from(configTable).where(eq(configTable.tenantId, context.tenantId)).orderBy(configTable.name),
    ),

    save: adminProcedure
      .input(
        z.object({
          id: z.uuid().optional(),
          name: z.string().min(1),
          columns: z.array(ColumnZ).min(1),
          rows: z.array(z.array(ValZ)),
        }),
      )
      .handler(async ({ input, context }) => {
        for (const r of input.rows) {
          if (r.length !== input.columns.length)
            throw new ORPCError("BAD_REQUEST", { message: `Row has ${r.length} cells, expected ${input.columns.length}` });
        }
        const fields = { name: input.name, columns: input.columns, rows: input.rows, updatedAt: new Date() };
        try {
          if (input.id) {
            const updated = await db
              .update(configTable)
              .set(fields)
              .where(and(eq(configTable.id, input.id), eq(configTable.tenantId, context.tenantId)))
              .returning({ id: configTable.id });
            if (!updated.length) throw new ORPCError("NOT_FOUND");
            return { id: input.id };
          }
          const [ins] = await db
            .insert(configTable)
            .values({ tenantId: context.tenantId, ...fields })
            .returning({ id: configTable.id });
          return { id: ins!.id };
        } catch (e) {
          if ((e as { code?: string }).code === "23505")
            throw new ORPCError("BAD_REQUEST", { message: `A table named '${input.name}' already exists` });
          throw e;
        }
      }),

    // ponytail: no reference check against models (names live inside jsonb); a dangling
    // reference fails at resolve time with "Unknown lookup table '<name>'".
    remove: adminProcedure.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
      await db.delete(configTable).where(and(eq(configTable.id, input.id), eq(configTable.tenantId, context.tenantId)));
      return { ok: true };
    }),
  },

  // Builder "Preview" button: resolve any LookupRef against live sources, first N options.
  // Query refs read from queryTables, so the (unsaved) draft's queryTables ride along.
  lookupPreview: adminProcedure
    .input(z.object({
      ref: LookupRefZ,
      queryTables: ModelDefZ.shape.queryTables.optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }))
    .handler(async ({ input, context }) => {
      const tables = tablesFromTenant(await tenantTables(context.tenantId));
      await addQueryTables(tables, input.queryTables ?? [], runnerFor(await tenantConnector(context.tenantId)));
      const options = optionsFromRef(input.ref, tables);
      return { options: options.slice(0, input.limit) };
    }),

  // One page of a query: the editor's "Test fetch" (columns come from the response, never
  // hand-typed) and the builder's value help both live here. Admin-only, because unlike
  // configs.queryPage it takes an ad-hoc query instead of naming a saved model's table —
  // the builder is editing a draft that is not stored yet.
  queryPage: adminProcedure
    .input(z.object({
      target: z.enum(["b1", "beas"]),
      query: ODataQueryZ,
      columns: z.array(z.string()).optional(),
      search: z.string().optional(),
      searchCols: z.array(z.string()).optional(),
      cursor: z.number().int().min(0).optional(),
    }))
    .handler(async ({ input, context }) =>
      fetchQueryTable(
        runnerFor(await tenantConnector(context.tenantId)),
        input.target,
        withSearch(input.query, input.searchCols ?? [], input.search ?? ""),
        input.columns,
        { skip: input.cursor },
      ),
    ),

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
        return await resolveLookups(
          input.definition, await tenantTables(context.tenantId),
          runnerFor(await tenantConnector(context.tenantId)),
        );
      } catch (e) {
        if (e instanceof ORPCError) throw e; // SAP-unavailable etc. — keep the specific message
        throw new ORPCError("BAD_GATEWAY", { message: e instanceof Error ? e.message : String(e) });
      }
    }),
};
