import { describe, expect, test } from "bun:test";
import { buildCalculationUpdate, needsCalculation, sameEntries, sameTables } from "./configProcessState.ts";

const ready = {
  conflicted: false,
  missingCount: 0,
  batchCount: 1,
  lookupsReady: true,
  assistantBusy: false,
  entriesDirty: false,
  batchesDirty: false,
  tablesDirty: false,
  runReady: true,
};

describe("needsCalculation", () => {
  test("runs when dirty or not run-ready; skips when gated", () => {
    expect(needsCalculation({ ...ready, entriesDirty: true })).toBe(true);
    expect(needsCalculation({ ...ready, batchesDirty: true })).toBe(true);
    expect(needsCalculation({ ...ready, tablesDirty: true })).toBe(true);
    expect(needsCalculation({ ...ready, runReady: false })).toBe(true);
    expect(needsCalculation(ready)).toBe(false);
    expect(needsCalculation({ ...ready, entriesDirty: true, conflicted: true })).toBe(false);
    expect(needsCalculation({ ...ready, entriesDirty: true, missingCount: 1 })).toBe(false);
    expect(needsCalculation({ ...ready, entriesDirty: true, batchCount: 0 })).toBe(false);
    expect(needsCalculation({ ...ready, entriesDirty: true, lookupsReady: false })).toBe(false);
    expect(needsCalculation({ ...ready, entriesDirty: true, assistantBusy: true })).toBe(false);
  });
});

test("calculation persists the assistant-proposed entries before the run snapshot", () => {
  const beforeTurn = { material: "steel", section: 10 };
  const assistantProposed = { material: "aluminium", section: 16 };

  const update = buildCalculationUpdate("project-1", beforeTurn, assistantProposed, [1], [1]);

  expect(update?.entries).toEqual(assistantProposed);
  expect(update?.entries).not.toEqual(beforeTurn);
});

test("reordered keys from jsonb are not a dirty change", () => {
  const typed = { material: "steel", width: 10 };
  const fromPg = { width: 10, material: "steel" };
  expect(JSON.stringify(typed) === JSON.stringify(fromPg)).toBe(false);
  expect(sameEntries(typed, fromPg)).toBe(true);
  expect(buildCalculationUpdate("p", fromPg, typed, [1], [1])).toBeNull();
});

test("a real value change still persists", () => {
  expect(sameEntries({ material: "steel" }, { material: "aluminium" })).toBe(false);
  expect(buildCalculationUpdate("p", { material: "steel" }, { material: "aluminium" }, [1], [1])?.entries)
    .toEqual({ material: "aluminium" });
});

describe("sameTables", () => {
  test("jsonb key and table reordering is not a change", () => {
    expect(sameTables({ parts: [{ code: "A", qty: 1 }] }, { parts: [{ qty: 1, code: "A" }] })).toBe(true);
    expect(sameTables({ a: [], b: [{ x: 1 }] }, { b: [{ x: 1 }], a: [] })).toBe(true);
    // an absent key and an empty list are the same thing to the engine
    expect(sameTables({}, { parts: [] })).toBe(true);
  });

  test("an edited cell, an added row and a removed row all count", () => {
    expect(sameTables({ parts: [{ qty: 1 }] }, { parts: [{ qty: 2 }] })).toBe(false);
    expect(sameTables({ parts: [{ qty: 1 }] }, { parts: [{ qty: 1 }, { qty: 1 }] })).toBe(false);
    expect(sameTables({ parts: [{ qty: 1 }] }, {})).toBe(false);
  });

  test("a matrix edit alone triggers a recalculate", () => {
    const persisted = { parts: [{ qty: 1 }] };
    const update = buildCalculationUpdate("p", {}, {}, [1], [1], persisted, { parts: [{ qty: 2 }] });
    expect(update?.tables).toEqual({ parts: [{ qty: 2 }] });
    expect(buildCalculationUpdate("p", {}, {}, [1], [1], persisted, { parts: [{ qty: 1 }] })).toBeNull();
  });
});
