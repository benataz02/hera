import { describe, expect, test } from "bun:test";
import {
  clearQuoteSession,
  openQuotationNav,
  quoteSessionKey,
  readQuoteSession,
  restoreQuoteSession,
  seedHasOneLinePerSelection,
  seedLinesPreserveConfigPrice,
  shouldResumeWriteWatch,
  shouldRetainDraftAfterFailure,
  writeQuoteSession,
  type QuoteSessionStored,
} from "./quoteDraft.ts";

const host = "acme.lvh.me:5173";
const projectId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const selectionVersion = 3;
const commandId = "cmd-abc";

function seed(lines = 2): Record<string, unknown> {
  return {
    CardCode: "C0001",
    CardName: "Acme",
    DocumentLines: Array.from({ length: lines }, (_, i) => ({
      ItemCode: "CFG",
      ItemDescription: `line ${i}`,
      Quantity: 10 + i,
      UnitPrice: 100 + i,
      priceSource: "config",
    })),
  };
}

describe("quote session key", () => {
  test("includes tenant host, project, run, and selection version", () => {
    expect(quoteSessionKey(host, projectId, runId, selectionVersion)).toBe(
      `hera:quoteDraft:${host}:${projectId}:${runId}:${selectionVersion}`,
    );
  });
});

describe("session restore / discard", () => {
  test("restores editable draft when run id and selection version match", () => {
    const stored: QuoteSessionStored = {
      runId,
      selectionVersion,
      commandId,
      data: seed(),
      requestId: null,
      lastStatus: null,
    };
    const restored = restoreQuoteSession(stored, { runId, selectionVersion, commandId });
    expect(restored).toEqual(stored);
  });

  test("discards stale draft when selection version differs", () => {
    const stored: QuoteSessionStored = {
      runId,
      selectionVersion: 2,
      commandId: "old",
      data: seed(1),
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      lastStatus: "pending",
    };
    expect(restoreQuoteSession(stored, { runId, selectionVersion: 3, commandId })).toBeNull();
  });

  test("discards stale draft when run id differs", () => {
    const stored: QuoteSessionStored = {
      runId: "33333333-3333-4333-8333-333333333333",
      selectionVersion,
      commandId,
      data: seed(1),
      requestId: null,
      lastStatus: null,
    };
    expect(restoreQuoteSession(stored, { runId, selectionVersion, commandId })).toBeNull();
  });

  test("round-trips through sessionStorage for a matching key", () => {
    const key = quoteSessionKey(host, projectId, runId, selectionVersion);
    clearQuoteSession(key);
    const stored: QuoteSessionStored = {
      runId,
      selectionVersion,
      commandId,
      data: seed(),
      requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      lastStatus: "in_flight",
    };
    writeQuoteSession(key, stored);
    expect(readQuoteSession(key)).toEqual(stored);
    clearQuoteSession(key);
    expect(readQuoteSession(key)).toBeNull();
  });
});

describe("canonical seed display", () => {
  test("one DocumentLines row per persisted selection", () => {
    expect(seedHasOneLinePerSelection(seed(3), 3)).toBe(true);
    expect(seedHasOneLinePerSelection(seed(2), 3)).toBe(false);
  });

  test("preserves priceSource=config on seeded lines", () => {
    expect(seedLinesPreserveConfigPrice(seed(2))).toBe(true);
    const sap = seed(1);
    (sap.DocumentLines as Record<string, unknown>[])[0]!.priceSource = "sap";
    expect(seedLinesPreserveConfigPrice(sap)).toBe(false);
  });
});

describe("write watch / failure / completion", () => {
  test("resumes watch after reload when a non-terminal requestId is stored", () => {
    expect(
      shouldResumeWriteWatch({
        requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        lastStatus: "pending",
      }),
    ).toBe(true);
    expect(
      shouldResumeWriteWatch({
        requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        lastStatus: "in_flight",
      }),
    ).toBe(true);
    expect(
      shouldResumeWriteWatch({
        requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        lastStatus: "failed",
      }),
    ).toBe(false);
    expect(shouldResumeWriteWatch({ requestId: null, lastStatus: "pending" })).toBe(false);
    expect(
      shouldResumeWriteWatch({
        requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        lastStatus: "done",
      }),
    ).toBe(false);
  });

  test("failure retains the draft (same command id)", () => {
    expect(shouldRetainDraftAfterFailure("failed")).toBe(true);
    expect(shouldRetainDraftAfterFailure("done")).toBe(false);
  });
});

describe("Open quotation navigation", () => {
  test("builds /$entity/$id params for Quotations", () => {
    expect(openQuotationNav(42)).toEqual({
      to: "/$entity/$id",
      params: { entity: "Quotations", id: "42" },
    });
    expect(openQuotationNav("99")).toEqual({
      to: "/$entity/$id",
      params: { entity: "Quotations", id: "99" },
    });
  });
});
