import type { LookupRef, ModelDef, Option, ResolvedLookups, ResolvedTable, Val } from "@hera/config-engine";

// Resolve a model's external references (manual lists, tenant config_tables, agent-backed
// B1/Beas GETs) into the engine's ResolvedLookups. The agent hop is injected so this stays
// testable and DB/transport-free; callers wire runRequest(tenantId, "query", ...) in.

export type QueryFetcher = (target: "b1" | "beas", path: string) => Promise<unknown>;
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
  return project(t, ref.table, ref.valueCol, ref.labelCol);
}

/** Fetch each queryTable and add it to `tables` (mutates in place). */
export async function addQueryTables(
  tables: Record<string, ResolvedTable>,
  queryTables: ModelDef["queryTables"],
  fetchQuery: QueryFetcher,
): Promise<void> {
  for (const qt of queryTables) {
    const rows = rowsOf(await fetchQuery(qt.target, qt.path), qt.target, qt.path);
    tables[qt.name] = { columns: qt.columns, rows: rows.map((r) => qt.columns.map((c) => asVal(r[c]))) };
  }
}

export async function resolveLookups(
  model: ModelDef,
  tenantTables: TenantTable[],
  fetchQuery: QueryFetcher,
): Promise<ResolvedLookups> {
  // Memoize per (target, path): two queryTables may share one GET.
  const fetched = new Map<string, Promise<unknown>>();
  const fetchOnce: QueryFetcher = (target, path) => {
    const k = `${target} ${path}`;
    let p = fetched.get(k);
    if (!p) fetched.set(k, (p = fetchQuery(target, path)));
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
