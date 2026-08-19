import { describe, expect, test } from "bun:test";
import {
  applyWriteDoneDisplay,
  buildWriteData,
  isCollectionDirty,
  newEditCommandId,
  shouldAbortWriteOnNavigateAway,
  shouldClearDraftOnCancel,
  shouldDisableCancel,
  shouldDisableSave,
  shouldMintNewCommandIdAfterFailed,
  shouldPreserveDraftOnFailure,
  waitWriteDoneVisible,
  WRITE_DONE_VISIBLE_MS,
  writeStatusMessage,
} from "../objectSpec.ts";

describe("buildWriteData omits clean collections", () => {
  const draft = {
    Comments: "hi",
    DocumentStatus: "bost_Open",
    DocumentLines: [
      { LineNum: 0, ItemCode: "A1", Quantity: 1 },
      { LineNum: 1, ItemCode: "B2", Quantity: 2 },
    ],
  };

  test("header-only dirty → payload has no DocumentLines", () => {
    const dirty = new Set(["Comments"]);
    expect(isCollectionDirty(dirty, "DocumentLines")).toBe(false);
    const data = buildWriteData(draft, dirty, ["DocumentLines"]);
    expect(data.Comments).toBe("hi");
    expect(data).not.toHaveProperty("DocumentLines");
  });

  test("dirty line field → DocumentLines present", () => {
    const dirty = new Set(["DocumentLines.0.Quantity"]);
    expect(isCollectionDirty(dirty, "DocumentLines")).toBe(true);
    const data = buildWriteData(draft, dirty, ["DocumentLines"]);
    expect(data.DocumentLines).toEqual(draft.DocumentLines);
  });

  test("collection root dirty → DocumentLines present", () => {
    const dirty = new Set(["DocumentLines"]);
    const data = buildWriteData(draft, dirty, ["DocumentLines"]);
    expect(data.DocumentLines).toEqual(draft.DocumentLines);
  });
});

describe("write status message strips", () => {
  test("submitting → Information Pending… (same as pending)", () => {
    expect(writeStatusMessage("submitting")).toEqual({
      design: "Information",
      text: "Pending…",
    });
  });

  test("pending → Information Pending…", () => {
    expect(writeStatusMessage("pending")).toEqual({
      design: "Information",
      text: "Pending…",
    });
  });

  test("in_flight → Information Saving / In flight…", () => {
    expect(writeStatusMessage("in_flight")).toEqual({
      design: "Information",
      text: "Saving / In flight…",
    });
  });

  test("failed → Negative with error text", () => {
    expect(writeStatusMessage("failed", "SAP rejected")).toEqual({
      design: "Negative",
      text: "SAP rejected",
    });
  });

  test("done → Positive", () => {
    expect(writeStatusMessage("done")).toEqual({
      design: "Positive",
      text: "Saved",
    });
  });

  test("null status → no strip", () => {
    expect(writeStatusMessage(null)).toBeNull();
  });
});

describe("Save disablement", () => {
  test("disables while submitting (before requestId), pending, in_flight, or done", () => {
    expect(shouldDisableSave("submitting")).toBe(true);
    expect(shouldDisableSave("pending")).toBe(true);
    expect(shouldDisableSave("in_flight")).toBe(true);
    expect(shouldDisableSave("done")).toBe(true);
    expect(shouldDisableSave("failed")).toBe(false);
    expect(shouldDisableSave(null)).toBe(false);
  });
});

describe("Cancel disablement / optimistic submitting lock", () => {
  test("submitting before requestId disables cancel even if not yet enqueued flag", () => {
    expect(shouldDisableCancel(false, "submitting")).toBe(true);
  });

  test("enqueued lock disables cancel", () => {
    expect(shouldDisableCancel(true, null)).toBe(true);
    expect(shouldDisableCancel(true, "pending")).toBe(true);
  });

  test("pending / in_flight / done disable cancel", () => {
    expect(shouldDisableCancel(false, "pending")).toBe(true);
    expect(shouldDisableCancel(false, "in_flight")).toBe(true);
    expect(shouldDisableCancel(false, "done")).toBe(true);
  });

  test("idle and failed allow cancel when not enqueued", () => {
    expect(shouldDisableCancel(false, null)).toBe(false);
    expect(shouldDisableCancel(false, "failed")).toBe(false);
  });
});

describe("permanent failure preserves draft", () => {
  test("failed status keeps edit draft", () => {
    expect(shouldPreserveDraftOnFailure("failed")).toBe(true);
    expect(shouldPreserveDraftOnFailure("done")).toBe(false);
    expect(shouldPreserveDraftOnFailure("pending")).toBe(false);
  });
});

describe("failed → mint new commandId for Save retry", () => {
  test("permanent failed requires a fresh commandId (dedup-safe)", () => {
    expect(shouldMintNewCommandIdAfterFailed("failed")).toBe(true);
    expect(shouldMintNewCommandIdAfterFailed("done")).toBe(false);
    expect(shouldMintNewCommandIdAfterFailed("pending")).toBe(false);
    expect(shouldMintNewCommandIdAfterFailed(null)).toBe(false);
  });

  test("minted id after failed differs from the terminal commandId", () => {
    const terminal = newEditCommandId();
    expect(shouldMintNewCommandIdAfterFailed("failed")).toBe(true);
    const retry = newEditCommandId();
    expect(retry).not.toBe(terminal);
  });
});

describe("done visibility then exit", () => {
  test("WRITE_DONE_VISIBLE_MS is a short paint window", () => {
    expect(WRITE_DONE_VISIBLE_MS).toBeGreaterThanOrEqual(400);
    expect(WRITE_DONE_VISIBLE_MS).toBeLessThanOrEqual(800);
  });

  test("waitWriteDoneVisible resolves after the paint window", async () => {
    const start = Date.now();
    await waitWriteDoneVisible(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });

  test("done strip stays Positive while exit is deferred", () => {
    // Sequence contract: paint done (strip visible) before clearing draft.
    expect(writeStatusMessage("done")).toEqual({ design: "Positive", text: "Saved" });
    expect(shouldDisableSave("done")).toBe(true);
    expect(shouldDisableCancel(true, "done")).toBe(true);
  });
});

describe("done re-fetch replaces optimistic totals", () => {
  test("display source becomes fetched projection, not optimistic draft", () => {
    const optimistic = {
      DocTotal: 999,
      DocumentLines: [{ LineNum: 0, Quantity: 2, LineTotal: 500 }],
    };
    const fetched = {
      DocTotal: 100,
      DocumentLines: [{ LineNum: 0, Quantity: 2, LineTotal: 50 }],
    };
    const { draft, working } = applyWriteDoneDisplay(optimistic, fetched);
    expect(draft).toBeNull();
    expect(working).toEqual(fetched);
    expect(working.DocTotal).toBe(100);
  });
});

describe("Cancel before enqueue", () => {
  test("clears draft session when not yet enqueued", () => {
    expect(shouldClearDraftOnCancel(false)).toBe(true);
  });

  test("does not clear session after enqueue (command stays live)", () => {
    expect(shouldClearDraftOnCancel(true)).toBe(false);
  });
});

describe("navigation-away does not cancel the command", () => {
  test("unmount must not abort the durable write", () => {
    expect(shouldAbortWriteOnNavigateAway()).toBe(false);
  });
});

describe("commandId lifecycle", () => {
  test("newEditCommandId returns a UUID string", () => {
    const id = newEditCommandId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  test("commandId is stable across calls only when retained by caller", () => {
    const a = newEditCommandId();
    const b = newEditCommandId();
    expect(a).not.toBe(b);
  });
});
