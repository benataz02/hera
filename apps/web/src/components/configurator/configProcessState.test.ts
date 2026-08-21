import { describe, expect, test } from "bun:test";
import { buildCalculationUpdate, needsCalculation, sameEntries } from "./configProcessState.ts";

const ready = {
  conflicted: false,
  missingCount: 0,
  batchCount: 1,
  lookupsReady: true,
  assistantBusy: false,
  entriesDirty: false,
  batchesDirty: false,
  runReady: true,
};

describe("needsCalculation", () => {
  test("runs when dirty or not run-ready; skips when gated", () => {
    expect(needsCalculation({ ...ready, entriesDirty: true })).toBe(true);
    expect(needsCalculation({ ...ready, batchesDirty: true })).toBe(true);
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
