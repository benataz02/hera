import type { Entries } from "@hera/config-engine";

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
  const entriesDirty = JSON.stringify(nextEntries) !== JSON.stringify(persistedEntries);
  const batchesDirty = JSON.stringify(nextBatches) !== JSON.stringify(persistedBatches);
  return entriesDirty || batchesDirty ? { id, entries: nextEntries, batches: nextBatches } : null;
}
