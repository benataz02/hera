import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, configMasterdata } from "@hera/db";
import { adminProcedure, userProcedure } from "../base.ts";
import { assertAgentReady, runRequest } from "./entities.ts";

// Configuration Master Data: the single entity behind a field's "Master data" data source. Defined
// manually (rows typed in) or by a B1 query (OData GET via the agent). `columns[0]` is the key value;
// the value-help shows every column, the type-ahead the first two.
const ValueZ = z.union([z.string(), z.number(), z.boolean()]);
const RowZ = z.record(z.string(), ValueZ);
const NAME_RE = /^[A-Za-z0-9_ -]+$/;

const SaveZ = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  kind: z.enum(["manual", "query"]),
  columns: z.array(z.string()).min(1),
  rows: z.array(RowZ).default([]),
  source: z.string().optional(),
  path: z.string().optional(),
});

// Unwrap an OData list ({ value: [...] }) or a bare array into rows.
const odataRows = (result: unknown): Record<string, unknown>[] => {
  const r = result as { value?: unknown[] } | unknown[] | null;
  const arr = Array.isArray(r) ? r : (r?.value ?? []);
  return arr as Record<string, unknown>[];
};

export const masterdataRouter = {
  list: userProcedure.handler(async ({ context }) =>
    db
      .select({ id: configMasterdata.id, name: configMasterdata.name, kind: configMasterdata.kind, columns: configMasterdata.columns })
      .from(configMasterdata)
      .where(eq(configMasterdata.tenantId, context.tenantId)),
  ),

  // Editor loads the full row here; the runtime uses `resolve`. Any member may read.
  get: userProcedure.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
    const [row] = await db
      .select()
      .from(configMasterdata)
      .where(and(eq(configMasterdata.id, input.id), eq(configMasterdata.tenantId, context.tenantId)))
      .limit(1);
    if (!row) throw new ORPCError("NOT_FOUND");
    return row;
  }),

  save: adminProcedure.input(SaveZ).handler(async ({ input, context }) => {
    if (!NAME_RE.test(input.name)) throw new ORPCError("BAD_REQUEST", { message: `Bad master data name '${input.name}'` });
    const { tenantId } = context;
    // Query master data stores only its definition; manual stores its rows. Keep them from crossing.
    const values = {
      name: input.name,
      kind: input.kind,
      columns: input.columns,
      rows: input.kind === "manual" ? input.rows : [],
      source: input.kind === "query" ? (input.source ?? "") : null,
      path: input.kind === "query" ? (input.path ?? "") : null,
    };
    if (input.id) {
      const [row] = await db
        .update(configMasterdata)
        .set({ ...values, updatedAt: new Date() })
        .where(and(eq(configMasterdata.id, input.id), eq(configMasterdata.tenantId, tenantId)))
        .returning({ id: configMasterdata.id });
      if (!row) throw new ORPCError("NOT_FOUND");
      return { id: row.id };
    }
    const [row] = await db.insert(configMasterdata).values({ tenantId, ...values }).returning({ id: configMasterdata.id });
    return { id: row!.id };
  }),

  remove: adminProcedure.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
    await db.delete(configMasterdata).where(and(eq(configMasterdata.id, input.id), eq(configMasterdata.tenantId, context.tenantId)));
    return { ok: true };
  }),

  // Runtime resolver for the Configurator value-help: manual returns its stored rows; query runs the
  // agent's B1 OData GET live and projects each row to the defined columns. The browser caches the
  // result (TanStack Query, staleTime: Infinity), so a query hits B1 once per session.
  // ponytail: query resolution needs the agent online (same hop as configure.query); a stored snapshot
  //           would decouple it — dropped per the "no DB cache, staleTime: Infinity" decision.
  resolve: userProcedure.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
    const [row] = await db
      .select()
      .from(configMasterdata)
      .where(and(eq(configMasterdata.id, input.id), eq(configMasterdata.tenantId, context.tenantId)))
      .limit(1);
    if (!row) throw new ORPCError("NOT_FOUND");
    if (row.kind === "manual") return { columns: row.columns, rows: row.rows };

    if (!row.path || !row.path.startsWith("/")) throw new ORPCError("BAD_REQUEST", { message: "Query path must start with /" });
    await assertAgentReady(context.tenantId);
    const result = await runRequest(context.tenantId, "query", { path: row.path, source: row.source ?? "" });
    const rows = odataRows(result).map((r) => Object.fromEntries(row.columns.map((c) => [c, r[c] ?? ""])));
    return { columns: row.columns, rows: rows as Record<string, string | number | boolean>[] };
  }),
};
