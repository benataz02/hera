import { and, asc, desc, eq, gt, gte, ilike, lt, lte, ne, or, sql, type Column, type SQL } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { ListVariantDefZ, type FilterCond, type ListVariantDef } from "@hera/db";

// Compile a saved list view (ListVariantDef) into a Postgres WHERE + ORDER BY. This is the third
// executor of the same spec: apps/web/src/listSpec.ts used to run it over an in-memory array,
// entity-list.ts compiles it to OData for B1, and this one compiles it to SQL for the tenant's own
// tables (configs, models, masterdata, portal requests). Same spec, same behaviour, three backends.
//
// Pure: no db handle, no transport. Each router hands it a field map and gets clauses back, then
// writes its own .where(...).orderBy(...).limit(...).offset(...) — Drizzle's builder types don't
// survive being passed through a generic helper, and six lines per procedure is cheaper than making
// them.

/** One filterable/sortable column. `col` is whatever Drizzle can put in a comparison: a table
 *  column, or a `sql` expression for values the row derives (`customer->>'cardName'`).
 *  `kind` decides only two things: whether free-text search touches the column, and nothing else —
 *  the expression is expected to already carry the right SQL type, so there is no casting here. */
export type SqlField = { col: Column | SQL; kind: "string" | "number" | "date" | "enum" };
export type SqlFields = Record<string, SqlField>;

/** Column and SQL are different overloads on every drizzle operator, so a `Column | SQL` union
 *  resolves to neither. Interpolating once gives every operator a single SQL argument. */
const expr = (f: SqlField): SQL => sql`${f.col}`;

const condition = (cond: FilterCond, f: SqlField): SQL => {
  const col = expr(f);
  switch (cond.op) {
    // ilike, not like: applySpec lowercased both sides, so case-insensitive is what every saved
    // view was written against.
    case "contains":
      return ilike(col, `%${String(cond.value)}%`);
    case "startswith":
      return ilike(col, `${String(cond.value)}%`);
    case "eq":
      return eq(col, cond.value);
    case "ne":
      return ne(col, cond.value);
    case "gt":
      return gt(col, cond.value);
    case "ge":
      return gte(col, cond.value);
    case "lt":
      return lt(col, cond.value);
    case "le":
      return lte(col, cond.value);
  }
};

/**
 * `spec` -> `{ where, orderBy }`. Rules are compileList's, deliberately:
 *  - a filter naming a field the list does not have is an error: silently dropping it would show
 *    MORE rows than were asked for.
 *  - an *orderby* naming a missing field is not: a saved view outliving a column should still open.
 *  - free-text search becomes ILIKE over string fields only — the same rule OData forces on B1
 *    (contains() is string-only) and the one applySpec applied locally.
 *  - `select` is ignored: projection is fixed by the query builder here, and column order/visibility
 *    is presentation that ListReport applies itself.
 */
export function compileListSql(
  fields: SqlFields,
  spec: ListVariantDef,
): { where: SQL | undefined; orderBy: SQL[] } {
  const clauses: SQL[] = [];

  for (const cond of spec.filter) {
    const f = fields[cond.field];
    if (!f) throw new Error(`Filter field '${cond.field}' is not on this list`);
    clauses.push(condition(cond, f));
  }

  const q = spec.search?.trim();
  if (q) {
    const ors = Object.values(fields)
      .filter((f) => f.kind === "string")
      .map((f) => ilike(expr(f), `%${q}%`));
    // An OR of nothing is TRUE, not FALSE — only add the group if there is a string column to search.
    if (ors.length) clauses.push(or(...ors)!);
  }

  const orderBy = spec.orderby
    .filter((o) => fields[o.field])
    .map((o) => (o.dir === "desc" ? desc(expr(fields[o.field]!)) : asc(expr(fields[o.field]!))));

  return { where: clauses.length ? and(...clauses) : undefined, orderBy };
}

/** The "a full page probably means another one" heuristic, shared with entity-read.ts so
 *  getNextPageParam is one expression at every call site. One empty read at the end beats a
 *  COUNT(*) per page. */
export const nextSkipOf = (rowCount: number, top: number, skip?: number): number | undefined =>
  rowCount === top ? (skip ?? 0) + rowCount : undefined;

/** compileListSql behind an ORPCError. An unknown filter field means the client sent a saved view
 *  naming a column this list no longer has — a bad request, not a broken server. Routers call this;
 *  the compiler itself stays pure so the test can import it without oRPC. */
export function compileSpec(fields: SqlFields, spec: ListVariantDef) {
  try {
    return compileListSql(fields, spec);
  } catch (e) {
    throw new ORPCError("BAD_REQUEST", { message: e instanceof Error ? e.message : String(e) });
  }
}

/** Wire shape for a paged list, matching `entities.rows` so ListReport's contract is identical at
 *  every call site. No `count` flag: unlike B1, Postgres hands us the total for free (see TOTAL). */
export const ListPageZ = z.object({
  spec: ListVariantDefZ,
  top: z.number().int().min(1).max(500).default(100),
  skip: z.number().int().min(0).optional(),
});
export type ListPageInput = z.infer<typeof ListPageZ>;

/** The row count the filter would return, carried along with the page. A window function costs no
 *  second round trip and no repeat of the join, and at tenant-table sizes it is free — which is why
 *  these lists have no `count: true` first-page flag the way entities.rows needs one for B1. */
export const TOTAL = sql<number>`count(*) over ()`.as("_total");

/** Shape a raw page (rows carrying `_total`) into the `{ rows, total, nextSkip }` every list
 *  endpoint returns. `_total` is stripped so a row is only ever its own columns. */
export function listPage<T extends Record<string, unknown>>(
  raw: (T & { _total: number })[],
  top: number,
  skip?: number,
): { rows: T[]; total: number; nextSkip: number | undefined } {
  return {
    rows: raw.map(({ _total, ...r }) => r as unknown as T),
    total: raw[0]?._total ?? 0,
    nextSkip: nextSkipOf(raw.length, top, skip),
  };
}
