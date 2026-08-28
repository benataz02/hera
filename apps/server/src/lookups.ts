import { refKeyCols } from "@hera/config-engine";
import type {
  Entries, LookupRef, ModelDef, ODataQuery, Option, QuerySource, ResolvedLookups, ResolvedTable, Val,
} from "@hera/config-engine";
import { andFilter, escapeLiteral } from "@hera/b1";
import { ORPCError } from "@orpc/server";

// Resolve a model's external references (manual lists, tenant config_tables, and query-backed
// B1/Beas reads) into the engine's ResolvedLookups. The read hop is injected so this stays
// testable and DB/transport-free; production callers pass runnerFor(connector) from b1.ts.
//
// Nothing here builds a URL any more: a query is `{ entitySet, filter, orderby, top }` and
// packages/b1's query.ts is the only place that turns one into a path.

/** Rows per value-help page when the model's query does not pin its own `top`. */
export const DEFAULT_PAGE = 100;

export type QueryPage = {
  rows: Record<string, unknown>[];
  /** $skip for the next page; absent = the last page. */
  nextSkip?: number;
  /** a multi-page read stopped at its page cap — rows are incomplete. */
  truncated?: boolean;
};

/** The injected read hop. One page per call unless `maxPages` says otherwise. */
export type QueryRunner = (
  target: "b1" | "beas",
  query: ODataQuery,
  columns: string[],
  opts?: { skip?: number; maxPages?: number },
) => Promise<QueryPage>;

export type TenantTable = { name: string; columns: { key: string }[]; rows: Val[][] };

const asVal = (v: unknown): Val =>
  typeof v === "number" || typeof v === "boolean" || v === null || v === undefined ? ((v ?? null) as Val) : String(v);

export function tablesFromTenant(tenantTables: TenantTable[]): Record<string, ResolvedTable> {
  const out: Record<string, ResolvedTable> = {};
  for (const t of tenantTables) out[t.name] = { columns: t.columns.map((c) => c.key), rows: t.rows };
  return out;
}

function project(t: ResolvedTable, name: string, valueCol: string, labelCol?: string): Option[] {
  const vi = t.columns.indexOf(valueCol);
  if (vi < 0) throw new Error(`Table '${name}' has no column '${valueCol}'`);
  const li = labelCol === undefined ? vi : t.columns.indexOf(labelCol);
  if (li < 0) throw new Error(`Table '${name}' has no column '${labelCol}'`);
  return t.rows.map((r) => ({ value: r[vi] ?? null, label: String(r[li] ?? r[vi] ?? "") }));
}

export function optionsFromRef(ref: LookupRef, tables: Record<string, ResolvedTable>): Option[] {
  if (ref.source === "manual") return ref.options.map((o) => ({ value: o.value, label: o.label ?? String(o.value) }));
  const t = tables[ref.table];
  if (!t) throw new Error(`Unknown lookup table '${ref.table}'`);
  const { valueCol, labelCol } = refKeyCols(ref, t.columns);
  return project(t, ref.table, valueCol, labelCol);
}

// Response field names, in first-seen order — the query's columns by convention. Non-identifier
// keys (@odata.etag &c.) are dropped: columns become `<param>_<col>` values in the DSL.
const fieldsOf = (rows: Record<string, unknown>[]): string[] =>
  [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k));

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** AND a `contains(col,'q')` OR-group onto a query's $filter. Was regex surgery on a
 *  URL-encoded `$filter=` group; with a structured query it is string composition. */
export function withSearch(query: ODataQuery, cols: string[], q: string): ODataQuery {
  const term = q.trim();
  const ors = cols.filter((c) => IDENT.test(c)).map((c) => `contains(${c},'${escapeLiteral(term)}')`);
  if (!term || !ors.length) return query;
  return { ...query, filter: andFilter(query.filter, ors.join(" or ")) };
}

/** AND an exact `col eq <literal>` onto a query's $filter. */
export function withExact(query: ODataQuery, col: string, value: Val): ODataQuery {
  const literal = typeof value === "string" ? `'${escapeLiteral(value)}'` : String(value);
  return { ...query, filter: andFilter(query.filter, `${col} eq ${literal}`) };
}

/** Resolve a value-help page request against the model. The query always comes from the model's
 *  own queryTables, never from the client; `cursor` is a plain `$skip` offset and can express
 *  nothing else — which is what the old "parse both URLs and compare their searchParams" check
 *  was trying to guarantee. */
export function queryPageSource(
  model: ModelDef,
  input: { table: string; search?: string; searchCols?: string[]; cursor?: number },
): QuerySource & { skip?: number } {
  const qt = model.queryTables.find((q) => q.name === input.table);
  if (!qt) throw new Error(`Unknown query table '${input.table}'`);
  const searchCols = input.searchCols ?? [];
  const unknownCol = searchCols.find((c) => !qt.columns.includes(c));
  if (unknownCol) throw new Error(`Search column '${unknownCol}' is not declared by query table '${qt.name}'`);
  if (input.cursor !== undefined && (!Number.isInteger(input.cursor) || input.cursor < 0))
    throw new Error("Cursor must be a non-negative row offset");
  return {
    target: qt.target,
    query: withSearch(qt.query, searchCols, input.search ?? ""),
    columns: qt.columns,
    ...(input.cursor ? { skip: input.cursor } : {}),
  };
}

/** Read a query and shape it as a table; columns come from the response unless pinned. */
export async function fetchQueryTable(
  run: QueryRunner,
  target: "b1" | "beas",
  query: ODataQuery,
  columns?: string[],
  opts?: { skip?: number; maxPages?: number },
): Promise<ResolvedTable> {
  const page = await run(target, query, columns ?? [], opts);
  const cols = columns?.length ? columns : fieldsOf(page.rows);
  return {
    columns: cols,
    rows: page.rows.map((r) => cols.map((c) => asVal(r[c]))),
    ...(page.nextSkip === undefined ? {} : { nextSkip: page.nextSkip }),
  };
}

/** Add only server-verified rows needed to bind persisted query selections. Domains stay the
 *  canonical first page, and cached lookup objects are never mutated. */
export async function enrichLookups(
  model: ModelDef,
  entries: Entries,
  canonical: ResolvedLookups,
  run: QueryRunner,
): Promise<ResolvedLookups> {
  let tables = canonical.tables;
  for (const p of model.parameters) {
    const ref = p.domain?.kind === "options" ? p.domain.ref : undefined;
    const value = entries[p.key];
    if (ref?.source !== "query" || !(p.key in entries) || Array.isArray(value)) continue;

    const source = model.queryTables.find((q) => q.name === ref.table);
    const valueCol = source && refKeyCols(ref, source.columns).valueCol;
    if (!source || !valueCol || !IDENT.test(valueCol))
      throw new ORPCError("BAD_REQUEST", { message: `Invalid lookup definition for parameter '${p.key}'` });

    const current = tables[ref.table];
    const currentKey = current?.columns.indexOf(valueCol) ?? -1;
    if (currentKey >= 0 && current!.rows.some((row) => row[currentKey] === value)) continue;

    const invalid = () => new ORPCError("BAD_REQUEST", {
      message: `Invalid lookup value for parameter '${p.key}': value is missing or stale`,
    });
    if (typeof value === "number" && !Number.isFinite(value)) throw invalid();
    const fetched = await fetchQueryTable(
      run, source.target, withExact(source.query, valueCol, value ?? null), source.columns,
    );
    const fetchedKey = fetched.columns.indexOf(valueCol);
    const row = fetched.rows[0];
    if (!row || fetchedKey < 0 || row[fetchedKey] !== value) throw invalid();

    const base = current?.columns.length ? current : { ...current, columns: fetched.columns, rows: current?.rows ?? [] };
    const appended = base.columns.map((col) => {
      const i = fetched.columns.indexOf(col);
      return i < 0 ? null : (row[i] ?? null);
    });
    if (!base.rows.some((r) => r.length === appended.length && r.every((v, i) => v === appended[i]))) {
      if (tables === canonical.tables) tables = { ...tables };
      tables[ref.table] = { ...base, rows: [...base.rows, appended] };
    }
  }
  return tables === canonical.tables ? canonical : { domains: canonical.domains, tables };
}

/** Fetch each queryTable and add it to `tables` (mutates in place). Concurrent: every read is a
 *  live SAP hop. `resolveLookups`'s `runOnce` still collapses two tables that share one read. */
export async function addQueryTables(
  tables: Record<string, ResolvedTable>,
  queryTables: ModelDef["queryTables"],
  run: QueryRunner,
): Promise<void> {
  const fetched = await Promise.all(
    queryTables.map((qt) => fetchQueryTable(run, qt.target, qt.query, qt.columns)),
  );
  queryTables.forEach((qt, i) => { tables[qt.name] = fetched[i]!; });
}

export async function resolveLookups(
  model: ModelDef,
  tenantTables: TenantTable[],
  run: QueryRunner,
): Promise<ResolvedLookups> {
  // Memoize per (target, query, skip): two queryTables may share one read.
  const seen = new Map<string, Promise<QueryPage>>();
  const runOnce: QueryRunner = (target, query, columns, opts) => {
    const k = `${target} ${JSON.stringify(query)} ${opts?.skip ?? 0} ${opts?.maxPages ?? 1}`;
    let p = seen.get(k);
    if (!p) seen.set(k, (p = run(target, query, columns, opts)));
    return p;
  };

  const tables = tablesFromTenant(tenantTables);
  await addQueryTables(tables, model.queryTables, runOnce);

  const domains: ResolvedLookups["domains"] = {};
  for (const p of model.parameters) {
    if (p.domain?.kind !== "options") continue;
    domains[p.key] = optionsFromRef(p.domain.ref, tables);
  }
  return { domains, tables };
}
