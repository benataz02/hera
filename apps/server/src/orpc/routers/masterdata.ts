import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db, configMasterdata, configModel } from "@hera/db";
import { ODataQueryZ, QuerySourceZ, ValZ, referencedTables } from "@hera/config-engine";
import { adminProcedure } from "../base.ts";
import { bumpMasterdata, DEFAULT_PAGE, fetchQueryTable, withSearch, type MasterdataRow } from "../../lookups.ts";
import { compileSpec, listPage, ListPageZ, TOTAL, type SqlFields } from "../../list-sql.ts";
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

// The list's four derived columns. They are presentation strings the page used to build while it
// held every row; sorting and filtering them server-side is what forces them into SQL.
// ponytail: CASE expressions over jsonb for a table that holds tens of rows — if masterdata ever
// grows real reporting needs, these become generated columns.
const KIND = sql<string>`case when ${configMasterdata.kind} = 'query' then 'Query' else 'Table' end`;
const SOURCE = sql<string>`case when ${configMasterdata.kind} = 'query'
  then (case when ${configMasterdata.query}->>'target' = 'beas' then 'Beas' else 'B1' end)
       || ' · ' || coalesce(nullif(${configMasterdata.query}->'query'->>'entitySet', ''), 'no entity set')
  else 'Maintained here' end`;
const COLUMN_COUNT = sql<number>`case when ${configMasterdata.kind} = 'query'
  then coalesce(jsonb_array_length(${configMasterdata.query}->'columns'), 0)
  else jsonb_array_length(${configMasterdata.columns}) end`;
const ROW_COUNT = sql<string>`case when ${configMasterdata.kind} = 'query'
  then 'Live' else jsonb_array_length(${configMasterdata.rows})::text end`;

const MASTERDATA_FIELDS: SqlFields = {
  name: { col: configMasterdata.name, kind: "string" },
  kind: { col: KIND, kind: "string" },
  source: { col: SOURCE, kind: "string" },
  columnCount: { col: COLUMN_COUNT, kind: "number" },
  rowCount: { col: ROW_COUNT, kind: "string" },
  updatedAt: { col: configMasterdata.updatedAt, kind: "date" },
};

export const masterdataRouter = {
  /** One page of the masterdata list for a saved view. Deliberately not `list` with paging bolted
   *  on: `list` returns whole rows including the `rows` jsonb, which MasterdataEditor and
   *  useDraftModel need and a list page must never drag down the wire. */
  rows: adminProcedure.input(ListPageZ).handler(async ({ input, context }) => {
    const { where, orderBy } = compileSpec(MASTERDATA_FIELDS, input.spec);
    const raw = await db
      .select({
        id: configMasterdata.id, name: configMasterdata.name, kind: KIND, source: SOURCE,
        columnCount: COLUMN_COUNT, rowCount: ROW_COUNT, updatedAt: configMasterdata.updatedAt,
        _total: TOTAL,
      })
      .from(configMasterdata)
      .where(and(eq(configMasterdata.tenantId, context.tenantId), where))
      // `id` last so the order is total — OFFSET paging over a non-unique sort duplicates and skips
      // rows between pages.
      .orderBy(...orderBy, configMasterdata.name, configMasterdata.id)
      .limit(input.top)
      .offset(input.skip ?? 0);
    return listPage(raw, input.top, input.skip);
  }),

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

  // Refuses while a model still names the table: the alternative is a dangling reference that only
  // shows up at resolve time as "Unknown lookup table '<name>'", on a configuration, to whoever
  // opened it. ponytail: names live inside jsonb, so this is a scan over the tenant's models —
  // tens of documents. A reference table maintained on model save only if that stops being true.
  remove: adminProcedure.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
    const [row] = await db
      .select({ name: configMasterdata.name })
      .from(configMasterdata)
      .where(and(eq(configMasterdata.id, input.id), eq(configMasterdata.tenantId, context.tenantId)));
    if (!row) throw new ORPCError("NOT_FOUND");
    const models = await db
      .select({ name: configModel.name, definition: configModel.definition })
      .from(configModel)
      .where(eq(configModel.tenantId, context.tenantId));
    const used = models.filter((m) => referencedTables(m.definition).has(row.name)).map((m) => m.name);
    if (used.length)
      throw new ORPCError("CONFLICT", {
        message: `'${row.name}' is used by ${used.length === 1 ? "model" : "models"} ${used.join(", ")}. Remove the reference there first.`,
      });
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
