import { COLUMN_BOUNDS, classifyColumnKind } from "../objectSpec.ts";
import { randomUuid } from "../uuid.ts";

export const DRAFT_ROW_KEY = "__draftKey";

/** Stable table rowKey: SAP LineNum when present, else a local draft UUID. */
export function lineRowKey(row: Record<string, unknown>): string {
  if (row.LineNum != null && row.LineNum !== "") return String(row.LineNum);
  const draft = row[DRAFT_ROW_KEY];
  if (typeof draft === "string" && draft) return draft;
  return "row";
}

/** Ensure new (no LineNum) rows carry a local draft UUID. Does not mutate input. */
export function ensureLineDraftKeys(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    if (row.LineNum != null && row.LineNum !== "") return row;
    if (typeof row[DRAFT_ROW_KEY] === "string" && row[DRAFT_ROW_KEY]) return row;
    return { ...row, [DRAFT_ROW_KEY]: randomUuid() };
  });
}

/** minWidth for a flex (description) column. */
export function pickFlexMinWidth(fieldName: string): number {
  const kind = classifyColumnKind(undefined, fieldName);
  return COLUMN_BOUNDS[kind === "text" ? "description" : kind].min;
}

export type ItemContextRequest = {
  itemCode: string;
  cardCode?: string;
  inventoryQuantity?: number;
  uomEntry?: number;
  uomQuantity?: number;
  date?: string;
  currency?: string;
  priceList?: number;
};

export type ItemContextResult = {
  defaults: Record<string, unknown>;
  price?: { value: number; currency?: string; discount?: number };
};

/**
 * Sequence + abort guard for item-context fetches. Callers debounce before invoking `run`.
 * Stale responses (older seq or aborted) return null.
 */
export function createItemContextSequencer() {
  let seq = 0;
  let controller: AbortController | null = null;

  return {
    async run(
      fetchFn: (req: ItemContextRequest, signal: AbortSignal) => Promise<ItemContextResult>,
      req: ItemContextRequest,
    ): Promise<ItemContextResult | null> {
      controller?.abort();
      controller = new AbortController();
      const mySeq = ++seq;
      const signal = controller.signal;
      try {
        const result = await fetchFn(req, signal);
        if (mySeq !== seq || signal.aborted) return null;
        return result;
      } catch (err) {
        if (signal.aborted || mySeq !== seq) return null;
        throw err;
      }
    },
    abort() {
      controller?.abort();
      controller = null;
      seq++;
    },
  };
}

export type ItemContextSequencer = ReturnType<typeof createItemContextSequencer>;

/** Per-lineRowKey sequencers — abort only same-line stale fetches, not other rows. */
export function createItemContextSequencerMap() {
  const byKey = new Map<string, ItemContextSequencer>();
  return {
    forKey(key: string): ItemContextSequencer {
      let s = byKey.get(key);
      if (!s) {
        s = createItemContextSequencer();
        byKey.set(key, s);
      }
      return s;
    },
    abortAll() {
      for (const s of byKey.values()) s.abort();
      byKey.clear();
    },
  };
}

/** Find a live row by lineRowKey; null if removed. */
export function findRowByKey(
  rows: Record<string, unknown>[],
  key: string,
): { row: Record<string, unknown>; index: number } | null {
  const index = rows.findIndex((r) => lineRowKey(r) === key);
  if (index < 0) return null;
  return { row: rows[index]!, index };
}
