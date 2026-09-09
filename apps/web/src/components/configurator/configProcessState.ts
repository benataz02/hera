import type { Entries, TableRows } from "@hera/config-engine";

export function sameEntries(a: Entries, b: Entries): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) {
    if (!Object.hasOwn(b, k) || JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  }
  return true;
}

export function needsCalculation(p: {
  conflicted: boolean;
  missingCount: number;
  batchCount: number;
  lookupsReady: boolean;
  assistantBusy: boolean;
  entriesDirty: boolean;
  batchesDirty: boolean;
  tablesDirty: boolean;
  runReady: boolean;
}) {
  if (p.conflicted || p.missingCount > 0 || p.batchCount === 0 || !p.lookupsReady || p.assistantBusy) return false;
  return p.entriesDirty || p.batchesDirty || p.tablesDirty || !p.runReady;
}

/** Row data survives a Postgres round trip as jsonb, which reorders object keys — so compare the
 *  canonical shape, not the literal string. Same reason configDocumentCommandId sorts keys. */
export function sameTables(a: TableRows, b: TableRows): boolean {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const canon = (t: TableRows) =>
    keys.map((k) => (t[k] ?? []).map((row) => Object.keys(row).sort().map((c) => [c, row[c]])));
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

export function buildCalculationUpdate(
  id: string,
  persistedEntries: Entries,
  nextEntries: Entries,
  persistedBatches: number[],
  nextBatches: number[],
  persistedTables: TableRows = {},
  nextTables: TableRows = {},
) {
  const entriesDirty = !sameEntries(nextEntries, persistedEntries);
  const batchesDirty = JSON.stringify(nextBatches) !== JSON.stringify(persistedBatches);
  const tablesDirty = !sameTables(nextTables, persistedTables);
  return entriesDirty || batchesDirty || tablesDirty
    ? { id, entries: nextEntries, batches: nextBatches, tables: nextTables }
    : null;
}
