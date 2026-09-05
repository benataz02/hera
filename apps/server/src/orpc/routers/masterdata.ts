import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, configMasterdata } from "@hera/db";
import { ODataQueryZ, QuerySourceZ, ValZ } from "@hera/config-engine";
import { adminProcedure } from "../base.ts";
import { bumpMasterdata, DEFAULT_PAGE, fetchQueryTable, withSearch, type MasterdataRow } from "../../lookups.ts";
import { runnerFor, tenantConnector } from "../../b1.ts";

// Tenant masterdata: one entity, two kinds. "table" keeps its values here; "query" keeps a live
// B1/Beas read. Models reference either by name and never hold the definition, so the same query
// is defined once for the whole tenant.

const ColumnZ = z.object({
  key: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "must be a valid identifier"),
  label: z.string(),
  type: z.enum(["string", "number", "boolean"]),
});

const MasterdataQueryZ = QuerySourceZ.extend({
  /** dialog headers; missing/blank → show the key. Engine ignores. */
  labels: z.record(z.string(), z.string()).optional(),
  /** keys omitted from the value-help dialog. Still fetched, still derived. */
  hidden: z.array(z.string()).optional(),
});

const base = { id: z.uuid().optional(), name: z.string().min(1) };
const SaveZ = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("table"), columns: z.array(ColumnZ).min(1), rows: z.array(z.array(ValZ)) }),
  z.object({ ...base, kind: z.literal("query"), query: MasterdataQueryZ }),
]);

/** Every masterdata row of a tenant, in the shape the resolvers take. */
export async function masterdataRows(tenantId: string): Promise<MasterdataRow[]> {
  return db
    .select({
      name: configMasterdata.name, kind: configMasterdata.kind,
      columns: configMasterdata.columns, rows: configMasterdata.rows, query: configMasterdata.query,
    })
    .from(configMasterdata)
    .where(eq(configMasterdata.tenantId, tenantId));
}

/** Column keys per table, the namespace checkModel validates against. */
export const knownTables = (rows: MasterdataRow[]) =>
  rows.map((t) => ({
    name: t.name,
    columns: t.kind === "query" ? (t.query?.columns ?? []) : t.columns.map((c) => c.key),
  }));

export const masterdataRouter = {
  list: adminProcedure.handler(({ context }) =>
    db.select().from(configMasterdata).where(eq(configMasterdata.tenantId, context.tenantId)).orderBy(configMasterdata.name),
  ),

  save: adminProcedure.input(SaveZ).handler(async ({ input, context }) => {
    // The kind's own fields are written and the other kind's are reset, so a row can never carry
    // half of each.
    const fields = input.kind === "table"
      ? { kind: "table" as const, columns: input.columns, rows: input.rows, query: null }
      : { kind: "query" as const, columns: [], rows: [], query: input.query };
    if (input.kind === "table") {
      for (const r of input.rows) {
        if (r.length !== input.columns.length)
          throw new ORPCError("BAD_REQUEST", { message: `Row has ${r.length} cells, expected ${input.columns.length}` });
      }
    }
    const values = { name: input.name, ...fields, updatedAt: new Date() };
    try {
      if (input.id) {
        const updated = await db
          .update(configMasterdata)
          .set(values)
          .where(and(eq(configMasterdata.id, input.id), eq(configMasterdata.tenantId, context.tenantId)))
          .returning({ id: configMasterdata.id });
        if (!updated.length) throw new ORPCError("NOT_FOUND");
        bumpMasterdata(context.tenantId);
        return { id: input.id };
      }
      const [ins] = await db
        .insert(configMasterdata)
        .values({ tenantId: context.tenantId, ...values })
        .returning({ id: configMasterdata.id });
      bumpMasterdata(context.tenantId);
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
    await db.delete(configMasterdata).where(and(eq(configMasterdata.id, input.id), eq(configMasterdata.tenantId, context.tenantId)));
    bumpMasterdata(context.tenantId);
    return { ok: true };
  }),

  // One page of an ad-hoc query: the editor's "Test fetch" (columns come from the response, never
  // hand-typed) and the builder's value help both live here. Admin-only, because unlike
  // configs.queryPage it takes the query itself instead of naming a saved masterdata row — the
  // editor is editing a draft that is not stored yet.
  queryPage: adminProcedure
    .input(z.object({
      target: z.enum(["b1", "beas"]),
      query: ODataQueryZ,
      columns: z.array(z.string()).optional(),
      search: z.string().optional(),
      searchCols: z.array(z.string()).optional(),
      cursor: z.number().int().min(0).optional(),
      /** Shrinks the read below a page; the editor's preview asks for five rows. */
      top: z.number().int().min(1).max(DEFAULT_PAGE).optional(),
    }))
    .handler(async ({ input, context }) =>
      fetchQueryTable(
        runnerFor(await tenantConnector(context.tenantId)),
        input.target,
        withSearch(input.query, input.searchCols ?? [], input.search ?? ""),
        input.columns,
        { skip: input.cursor, top: input.top },
      ),
    ),
};
