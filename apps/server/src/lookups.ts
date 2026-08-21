import { refKeyCols } from "@hera/config-engine";
import type { Entries, LookupRef, ModelDef, Option, ResolvedLookups, ResolvedTable, Val } from "@hera/config-engine";
import { ORPCError } from "@orpc/server";

// Resolve a model's external references (manual lists, tenant config_tables, agent-backed
// B1/Beas GETs) into the engine's ResolvedLookups. The agent hop is injected so this stays
// testable and DB/transport-free; callers wire runRequest(tenantId, "query", ...) in.

export type QueryFetcher = (target: "b1" | "beas", path: string, opts?: { all?: boolean }) => Promise<unknown>;
export type TenantTable = { name: string; columns: { key: string }[]; rows: Val[][] };

// Service Layer (and our Beas client) return collections as { value: [...] }; accept bare arrays too.
function rowsOf(json: unknown, target: string, path: string): Record<string, unknown>[] {
  const v = Array.isArray(json) ? json : (json as { value?: unknown } | null)?.value;
  if (!Array.isArray(v)) throw new Error(`Lookup ${target} GET ${path} did not return a row array`);
  return v as Record<string, unknown>[];
}

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

/** AND a `contains(col,'q')` OR-group onto an OData path's $filter (or add one). Pure — the agent
 *  just GETs whatever path it is handed, so search composition belongs here. */
export function withSearch(path: string, cols: string[], q: string): string {
  const term = q.trim();
  const ors = cols.filter((c) => IDENT.test(c)).map((c) => `contains(${c},'${term.replace(/'/g, "''")}')`);
  if (!term || !ors.length) return path;
  const expr = ors.join(" or ");
  const existing = /([?&]\$filter=)([^&]*)/.exec(path);
  if (existing)
    return path.replace(existing[0], `${existing[1]}${encodeURIComponent(`(${decodeURIComponent(existing[2]!)}) and (${expr})`)}`);
  return `${path}${path.includes("?") ? "&" : "?"}$filter=${encodeURIComponent(expr)}`;
}

/** Resolve a value-help page request against the model. The OData path always comes from the
 *  model's own queryTables, never from the client; `cursor` may alter only OData paging options. */
export function queryPagePath(
  model: ModelDef,
  input: { table: string; search?: string; searchCols?: string[]; cursor?: string },
): { target: "b1" | "beas"; path: string; columns?: string[] } {
  const qt = model.queryTables.find((q) => q.name === input.table);
  if (!qt) throw new Error(`Unknown query table '${input.table}'`);
  const searchCols = input.searchCols ?? [];
  const unknownCol = searchCols.find((c) => !qt.columns.includes(c));
  if (unknownCol) throw new Error(`Search column '${unknownCol}' is not declared by query table '${qt.name}'`);
  const canonical = withSearch(qt.path, searchCols, input.search ?? "");
  let path = canonical;
  if (input.cursor) {
    const base = "https://lookup.invalid";
    const expected = new URL(canonical, base);
    const cursor = new URL(input.cursor, base);
    const paging = new Set(["$skip", "$skiptoken"]);
    const fixed = (u: URL) =>
      JSON.stringify([...u.searchParams].filter(([key]) => !paging.has(key)).sort());
    if (
      !input.cursor.startsWith("/") ||
      cursor.origin !== expected.origin ||
      cursor.pathname !== expected.pathname ||
      fixed(cursor) !== fixed(expected)
    ) {
      throw new Error("Cursor does not match this query table");
    }
    path = input.cursor;
  }
  return {
    target: qt.target,
    path,
    columns: qt.columns,
  };
}

/** GET a query and shape it as a table; columns come from the response unless pinned.
 *  Configurator lookups take one page and retain `nextLink`; history explicitly requests all. */
export async function fetchQueryTable(
  fetchQuery: QueryFetcher,
  target: "b1" | "beas",
  path: string,
  columns?: string[],
  all = false,
): Promise<ResolvedTable> {
  const json = await fetchQuery(target, path, { all });
  const rows = rowsOf(json, target, path);
  const cols = columns?.length ? columns : fieldsOf(rows);
  const envelope = json as { "@odata.nextLink"?: unknown; "odata.nextLink"?: unknown };
  const nextLink = envelope?.["@odata.nextLink"] ?? envelope?.["odata.nextLink"];
  return {
    columns: cols,
    rows: rows.map((r) => cols.map((c) => asVal(r[c]))),
    ...(typeof nextLink === "string" && nextLink ? { nextLink } : {}),
  };
}

/** Add only server-verified rows needed to bind persisted query selections. Domains stay the
 *  canonical first page, and cached lookup objects are never mutated. */
export async function enrichLookups(
  model: ModelDef,
  entries: Entries,
  canonical: ResolvedLookups,
  fetchQuery: QueryFetcher,
): Promise<ResolvedLookups> {
  let tables = canonical.tables;
  for (const p of model.parameters) {
    const ref = p.domain?.kind === "options" ? p.domain.ref : undefined;
    const value = entries[p.key];
    if (ref?.source !== "query" || !(p.key in entries) || Array.isArray(value)) continue;

    const query = model.queryTables.find((q) => q.name === ref.table);
    const valueCol = query && refKeyCols(ref, query.columns).valueCol;
    if (!query || !valueCol || !IDENT.test(valueCol))
      throw new ORPCError("BAD_REQUEST", { message: `Invalid lookup definition for parameter '${p.key}'` });

    const current = tables[ref.table];
    const currentKey = current?.columns.indexOf(valueCol) ?? -1;
    if (currentKey >= 0 && current!.rows.some((row) => row[currentKey] === value)) continue;

    const invalid = () => new ORPCError("BAD_REQUEST", {
      message: `Invalid lookup value for parameter '${p.key}': value is missing or stale`,
    });
    if (typeof value === "number" && !Number.isFinite(value)) throw invalid();
    const literal = typeof value === "string" ? `'${value.replace(/'/g, "''")}'` : String(value);
    const exact = `${valueCol} eq ${literal}`;
    const existing = /([?&]\$filter=)([^&]*)/.exec(query.path);
    const path = existing
      ? query.path.replace(
          existing[0],
          `${existing[1]}${encodeURIComponent(`(${decodeURIComponent(existing[2]!)}) and (${exact})`)}`,
        )
      : `${query.path}${query.path.includes("?") ? "&" : "?"}$filter=${encodeURIComponent(exact)}`;
    const fetched = await fetchQueryTable(fetchQuery, query.target, path, query.columns, false);
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

/** Fetch each queryTable and add it to `tables` (mutates in place). Concurrent: every fetch is an
 *  agent round trip (insert + notify + B1 GET + ack), so serial cost was N hops on a cache miss.
 *  `resolveLookups`'s `fetchOnce` still collapses two tables that share one GET. */
export async function addQueryTables(
  tables: Record<string, ResolvedTable>,
  queryTables: ModelDef["queryTables"],
  fetchQuery: QueryFetcher,
): Promise<void> {
  const fetched = await Promise.all(
    queryTables.map((qt) => fetchQueryTable(fetchQuery, qt.target, qt.path, qt.columns, false)),
  );
  queryTables.forEach((qt, i) => { tables[qt.name] = fetched[i]!; });
}

export async function resolveLookups(
  model: ModelDef,
  tenantTables: TenantTable[],
  fetchQuery: QueryFetcher,
): Promise<ResolvedLookups> {
  // Memoize per (target, path): two queryTables may share one GET.
  const fetched = new Map<string, Promise<unknown>>();
  const fetchOnce: QueryFetcher = (target, path, opts) => {
    const k = `${target} ${path}`;
    let p = fetched.get(k);
    if (!p) fetched.set(k, (p = fetchQuery(target, path, opts)));
    return p;
  };

  const tables = tablesFromTenant(tenantTables);
  await addQueryTables(tables, model.queryTables, fetchOnce);

  const domains: ResolvedLookups["domains"] = {};
  for (const p of model.parameters) {
    if (p.domain?.kind !== "options") continue;
    domains[p.key] = optionsFromRef(p.domain.ref, tables);
  }
  return { domains, tables };
}
