import type { Entries } from "@hera/config-engine";

export const CONFIG_PROCESS_STEP_IDS = ["configure", "candidates", "quote"] as const;

export function initialConfigProcessStep(status: string) {
  return status === "draft" ? 0 : 1;
}

export const POST_RUN_STEP = 1;

// Which step the ObjectPage shows. `?section=` wins, but an unknown id — or a link to Candidates
// while the wizard has that tab locked — falls back to where the project status says the user belongs.
export function stepFromSection(section: string | undefined, status: string, candidatesLocked: boolean) {
  const i = (CONFIG_PROCESS_STEP_IDS as readonly string[]).indexOf(section ?? "");
  return i < 0 || (i === POST_RUN_STEP && candidatesLocked) ? initialConfigProcessStep(status) : i;
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
