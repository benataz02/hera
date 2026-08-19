import { describe, expect, test } from "bun:test";
import {
  createItemContextSequencer,
  createItemContextSequencerMap,
  ensureLineDraftKeys,
  findRowByKey,
  lineRowKey,
  pickFlexMinWidth,
} from "./objectLinesLogic.ts";

describe("lineRowKey", () => {
  test("uses LineNum when present", () => {
    expect(lineRowKey({ LineNum: 0 })).toBe("0");
    expect(lineRowKey({ LineNum: 12, __draftKey: "ignored" })).toBe("12");
  });

  test("falls back to local draft UUID", () => {
    expect(lineRowKey({ ItemCode: "A1", __draftKey: "draft-abc" })).toBe("draft-abc");
  });
});

describe("ensureLineDraftKeys", () => {
  test("assigns draft keys only to rows without LineNum", () => {
    const rows = ensureLineDraftKeys([
      { LineNum: 1, ItemCode: "A" },
      { ItemCode: "B" },
      { ItemCode: "C", __draftKey: "keep-me" },
    ]);
    expect(lineRowKey(rows[0]!)).toBe("1");
    expect(lineRowKey(rows[1]!)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(lineRowKey(rows[2]!)).toBe("keep-me");
    expect(rows[0]).not.toHaveProperty("__draftKey");
  });

  test("does not mutate input rows", () => {
    const input = [{ ItemCode: "X" }];
    const out = ensureLineDraftKeys(input);
    expect(input[0]).not.toHaveProperty("__draftKey");
    expect(out[0]).toHaveProperty("__draftKey");
    expect(out).not.toBe(input);
  });
});

describe("findRowByKey", () => {
  test("resolves by LineNum / draft key and skips missing", () => {
    const rows = [
      { LineNum: 1, ItemCode: "A" },
      { ItemCode: "B", __draftKey: "d1" },
    ];
    expect(findRowByKey(rows, "1")?.index).toBe(0);
    expect(findRowByKey(rows, "d1")?.row.ItemCode).toBe("B");
    expect(findRowByKey(rows, "gone")).toBeNull();
  });
});

describe("pickFlexMinWidth", () => {
  test("uses description min for flex columns", () => {
    expect(pickFlexMinWidth("ItemDescription")).toBeGreaterThanOrEqual(120);
  });
});

describe("createItemContextSequencer", () => {
  test("same sequencer drops stale when a newer request starts", async () => {
    const seq = createItemContextSequencer();
    let resolveSlow: (v: { defaults: Record<string, unknown> }) => void = () => {};
    const slow = new Promise<{ defaults: Record<string, unknown> }>((r) => {
      resolveSlow = r;
    });

    const p1 = seq.run(async () => slow, { itemCode: "A" });
    const p2 = seq.run(async () => ({ defaults: { ItemDescription: "fast" } }), { itemCode: "A" });

    resolveSlow({ defaults: { ItemDescription: "slow" } });
    expect(await p1).toBeNull();
    expect(await p2).toEqual({ defaults: { ItemDescription: "fast" } });
  });
});

describe("createItemContextSequencerMap", () => {
  test("different line keys do not abort each other", async () => {
    const map = createItemContextSequencerMap();
    let resolveA: (v: { defaults: Record<string, unknown> }) => void = () => {};
    const slowA = new Promise<{ defaults: Record<string, unknown> }>((r) => {
      resolveA = r;
    });

    const pA = map.forKey("line-1").run(async () => slowA, { itemCode: "A" });
    const pB = map.forKey("line-2").run(async () => ({ defaults: { ItemDescription: "B" } }), {
      itemCode: "B",
    });

    resolveA({ defaults: { ItemDescription: "A" } });
    expect(await pA).toEqual({ defaults: { ItemDescription: "A" } });
    expect(await pB).toEqual({ defaults: { ItemDescription: "B" } });
  });

  test("same line key still drops stale", async () => {
    const map = createItemContextSequencerMap();
    let resolveSlow: (v: { defaults: Record<string, unknown> }) => void = () => {};
    const slow = new Promise<{ defaults: Record<string, unknown> }>((r) => {
      resolveSlow = r;
    });
    const seq = map.forKey("line-1");
    const p1 = seq.run(async () => slow, { itemCode: "A" });
    const p2 = seq.run(async () => ({ defaults: { ItemDescription: "new" } }), { itemCode: "A2" });
    resolveSlow({ defaults: { ItemDescription: "old" } });
    expect(await p1).toBeNull();
    expect(await p2).toEqual({ defaults: { ItemDescription: "new" } });
  });
});
