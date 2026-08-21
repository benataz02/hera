import type { DomainOption, Entries, ResolvedLookups, ResolvedTable, Val } from "@hera/config-engine";

// Pure helpers for ConfiguratorForm, kept UI-free so they're unit-testable without the UI5 runtime.

/** Current off-page/search row per query parameter. Keyed by param, not table, so two fields
 *  sharing a query still replace independently. */
export type QueryPicks = Record<string, { table: string; columns: string[]; row: Val[] }>;

export function setQueryPick(
  picks: QueryPicks, paramKey: string, table: string, selected: ResolvedTable | undefined,
): QueryPicks {
  const row = selected?.rows[0];
  if (!row || !selected) {
    if (!(paramKey in picks)) return picks;
    const next = { ...picks };
    delete next[paramKey];
    return next;
  }
  const cur = picks[paramKey];
  if (cur && cur.table === table && JSON.stringify(cur.row) === JSON.stringify(row)
    && JSON.stringify(cur.columns) === JSON.stringify(selected.columns)) return picks;
  return { ...picks, [paramKey]: { table, columns: selected.columns, row } };
}

/** Append each pick's current row to `tables`. Domains stay the canonical snapshot. */
export function mergeQueryPicks(base: ResolvedLookups, picks: QueryPicks): ResolvedLookups {
  const extras = Object.values(picks);
  if (!extras.length) return base;
  const added: Record<string, { columns: string[]; rows: Val[][] }> = {};
  for (const p of extras) {
    const slot = (added[p.table] ??= { columns: p.columns, rows: [] });
    slot.rows.push(p.row);
  }
  const tables = { ...base.tables };
  for (const [name, extra] of Object.entries(added)) {
    const canonical = tables[name];
    const rows = [...extra.rows, ...(canonical?.rows ?? [])];
    tables[name] = {
      ...(canonical ?? { columns: extra.columns, rows: [] }),
      rows: [...new Map(rows.map((r) => [JSON.stringify(r), r])).values()],
    };
  }
  return { domains: base.domains, tables };
}

export function setEntry(entries: Entries, key: string, v: Val | undefined): Entries {
  if (v === undefined) {
    if (!(key in entries)) return entries;
    const next = { ...entries };
    delete next[key];
    return next;
  }
  if (key in entries && JSON.stringify(entries[key]) === JSON.stringify(v)) return entries;
  return { ...entries, [key]: v };
}

export type EntryResolution = { kind: "clear" } | { kind: "set"; value: Val; index: number } | { kind: "reject" };

/** Map free text typed into a value-help input to a domain option. "reject" = not in the list. */
export function resolveEntry(dom: DomainOption[], raw: string): EntryResolution {
  if (raw.trim() === "") return { kind: "clear" };
  const l = raw.trim().toLowerCase();
  let index = dom.findIndex((o) => o.label.toLowerCase() === l);
  if (index < 0) index = dom.findIndex((o) => String(o.value ?? "").toLowerCase() === l);
  return index < 0 ? { kind: "reject" } : { kind: "set", value: dom[index]!.value, index };
}
