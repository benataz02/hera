import type { Entries } from "@hera/config-engine";

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
  runReady: boolean;
}) {
  if (p.conflicted || p.missingCount > 0 || p.batchCount === 0 || !p.lookupsReady || p.assistantBusy) return false;
  return p.entriesDirty || p.batchesDirty || !p.runReady;
}

export function buildCalculationUpdate(
  id: string,
  persistedEntries: Entries,
  nextEntries: Entries,
  persistedBatches: number[],
  nextBatches: number[],
) {
  const entriesDirty = !sameEntries(nextEntries, persistedEntries);
  const batchesDirty = JSON.stringify(nextBatches) !== JSON.stringify(persistedBatches);
  return entriesDirty || batchesDirty ? { id, entries: nextEntries, batches: nextBatches } : null;
}
