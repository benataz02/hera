import type { Entries } from "@hera/config-engine";

export const CONFIG_PROCESS_STEP_IDS = ["configure", "candidates", "quote"] as const;

export function initialConfigProcessStep(status: string) {
  return status === "draft" ? 0 : 1;
}

export const POST_RUN_STEP = 1;

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
