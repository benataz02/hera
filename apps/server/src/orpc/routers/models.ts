import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, configModel, configProject, configTable } from "@hera/db";
import { checkModel, LookupRefZ, ModelDefZ, ValZ } from "@hera/config-engine";
import { adminProcedure } from "../base.ts";
import { assertAgentReady, runRequest } from "./entities.ts";
import { optionsFromRef, tablesFromTenant, type QueryFetcher, type TenantTable } from "../../lookups.ts";

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

export function agentFetcher(tenantId: string): QueryFetcher {
  return async (target, path) => {
    await assertAgentReady(tenantId);
    return runRequest(tenantId, "query", { target, path });
  };
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
    .input(z.object({ id: z.uuid().optional(), definition: ModelDefZ }))
    .handler(async ({ input, context }) => {
      const known = (await tenantTables(context.tenantId)).map((t) => t.name);
      const issues = checkModel(input.definition, known);
      if (issues.length) throw new ORPCError("BAD_REQUEST", { message: "Model has errors", data: { issues } });
      const fields = { name: input.definition.name, definition: input.definition, updatedAt: new Date() };
      if (input.id) {
        const updated = await db
          .update(configModel)
          .set(fields)
          .where(and(eq(configModel.id, input.id), eq(configModel.tenantId, context.tenantId)))
          .returning({ id: configModel.id });
        if (!updated.length) throw new ORPCError("NOT_FOUND");
        return { id: input.id };
      }
      const [ins] = await db
        .insert(configModel)
        .values({ tenantId: context.tenantId, ...fields })
        .returning({ id: configModel.id });
      return { id: ins!.id };
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
  lookupPreview: adminProcedure
    .input(z.object({ ref: LookupRefZ, limit: z.number().int().min(1).max(100).default(20) }))
    .handler(async ({ input, context }) => {
      const tables = tablesFromTenant(await tenantTables(context.tenantId));
      const options = await optionsFromRef(input.ref, tables, agentFetcher(context.tenantId));
      return { options: options.slice(0, input.limit) };
    }),
};
