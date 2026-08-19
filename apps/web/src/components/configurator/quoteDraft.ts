import type { WriteUiStatus } from "../../objectSpec.ts";

export type QuoteSessionStored = {
  runId: string;
  selectionVersion: number;
  commandId: string;
  data: Record<string, unknown>;
  requestId: string | null;
  lastStatus: WriteUiStatus;
  docEntry?: string | null;
};

export function quoteSessionKey(
  host: string,
  projectId: string,
  runId: string,
  selectionVersion: number,
): string {
  return `hera:quoteDraft:${host}:${projectId}:${runId}:${selectionVersion}`;
}

/** Accept stored draft only when run id + selection version match the current seed. */
export function restoreQuoteSession(
  stored: QuoteSessionStored | null | undefined,
  expected: { runId: string; selectionVersion: number; commandId: string },
): QuoteSessionStored | null {
  if (!stored) return null;
  if (stored.runId !== expected.runId) return null;
  if (stored.selectionVersion !== expected.selectionVersion) return null;
  // Prefer the server's deterministic commandId for this selection fence.
  return { ...stored, commandId: expected.commandId };
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const memoryStore = new Map<string, string>();
const memoryStorage: StorageLike = {
  getItem: (k) => memoryStore.get(k) ?? null,
  setItem: (k, v) => {
    memoryStore.set(k, v);
  },
  removeItem: (k) => {
    memoryStore.delete(k);
  },
};

function storage(): StorageLike {
  try {
    if (typeof sessionStorage !== "undefined") return sessionStorage;
  } catch {
    /* ignore */
  }
  return memoryStorage;
}

export function readQuoteSession(key: string): QuoteSessionStored | null {
  try {
    const raw = storage().getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as QuoteSessionStored;
    if (
      typeof parsed?.runId !== "string" ||
      typeof parsed?.selectionVersion !== "number" ||
      typeof parsed?.commandId !== "string" ||
      !parsed.data ||
      typeof parsed.data !== "object"
    ) {
      return null;
    }
    const out: QuoteSessionStored = {
      runId: parsed.runId,
      selectionVersion: parsed.selectionVersion,
      commandId: parsed.commandId,
      data: parsed.data,
      requestId: typeof parsed.requestId === "string" ? parsed.requestId : null,
      lastStatus: (parsed.lastStatus ?? null) as WriteUiStatus,
    };
    if (typeof parsed.docEntry === "string") out.docEntry = parsed.docEntry;
    return out;
  } catch {
    return null;
  }
}

export function writeQuoteSession(key: string, value: QuoteSessionStored): void {
  storage().setItem(key, JSON.stringify(value));
}

export function clearQuoteSession(key: string): void {
  storage().removeItem(key);
}

export function seedHasOneLinePerSelection(
  data: Record<string, unknown>,
  selectionCount: number,
): boolean {
  const lines = data.DocumentLines;
  return Array.isArray(lines) && lines.length === selectionCount;
}

export function seedLinesPreserveConfigPrice(data: Record<string, unknown>): boolean {
  const lines = data.DocumentLines;
  if (!Array.isArray(lines) || lines.length === 0) return false;
  return lines.every(
    (row) =>
      row &&
      typeof row === "object" &&
      (row as Record<string, unknown>).priceSource === "config",
  );
}

export function shouldResumeWriteWatch(input: {
  requestId: string | null | undefined;
  lastStatus: WriteUiStatus;
}): boolean {
  if (!input.requestId) return false;
  return input.lastStatus === "pending" || input.lastStatus === "in_flight";
}

export function shouldRetainDraftAfterFailure(status: WriteUiStatus): boolean {
  return status === "failed";
}

export function openQuotationNav(docEntry: string | number) {
  return {
    to: "/$entity/$id" as const,
    params: { entity: "Quotations", id: String(docEntry) },
  };
}
