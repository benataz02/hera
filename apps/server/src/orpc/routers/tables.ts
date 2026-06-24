import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, configTable } from "@hera/db";
import { adminProcedure, userProcedure } from "../base.ts";

// User-defined lookup tables backing the "Table" data source. A table is an ordered list of
// {value, name} rows (the builder's Sort column is just the array order).
const RowZ = z.object({ value: z.string(), name: z.string() });
const NAME_RE = /^[A-Za-z0-9_ -]+$/;

export const tablesRouter = {
  list: userProcedure.handler(async ({ context }) =>
    db.select({ id: configTable.id, name: configTable.name }).from(configTable).where(eq(configTable.tenantId, context.tenantId)),
  ),

  // Runtime resolves a Table data source through this — any member may read.
  get: userProcedure.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
    const [row] = await db
      .select()
      .from(configTable)
      .where(and(eq(configTable.id, input.id), eq(configTable.tenantId, context.tenantId)))
      .limit(1);
    if (!row) throw new ORPCError("NOT_FOUND");
    return row;
  }),

  save: adminProcedure
    .input(z.object({ id: z.string().optional(), name: z.string().min(1), rows: z.array(RowZ) }))
    .handler(async ({ input, context }) => {
      if (!NAME_RE.test(input.name)) throw new ORPCError("BAD_REQUEST", { message: `Bad table name '${input.name}'` });
      const { tenantId } = context;
      if (input.id) {
        const [row] = await db
          .update(configTable)
          .set({ name: input.name, rows: input.rows, updatedAt: new Date() })
          .where(and(eq(configTable.id, input.id), eq(configTable.tenantId, tenantId)))
          .returning({ id: configTable.id });
        if (!row) throw new ORPCError("NOT_FOUND");
        return { id: row.id };
      }
      const [row] = await db
        .insert(configTable)
        .values({ tenantId, name: input.name, rows: input.rows })
        .returning({ id: configTable.id });
      return { id: row!.id };
    }),

  remove: adminProcedure.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
    await db.delete(configTable).where(and(eq(configTable.id, input.id), eq(configTable.tenantId, context.tenantId)));
    return { ok: true };
  }),
};
