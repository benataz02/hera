import { describe, expect, test } from "bun:test";
import {
  buildCalculationUpdate,
  CONFIG_PROCESS_STEP_IDS,
  initialConfigProcessStep,
  POST_RUN_STEP,
} from "./configProcessState.ts";

describe("config process navigation", () => {
  test("draft project load lands on Configure", () => {
    expect(CONFIG_PROCESS_STEP_IDS[initialConfigProcessStep("draft")]).toBe("configure");
  });

  test("calculated project load lands on Candidates", () => {
    expect(CONFIG_PROCESS_STEP_IDS[initialConfigProcessStep("calculated")]).toBe("candidates");
  });

  test("a successful run navigates to Candidates", () => {
    expect(CONFIG_PROCESS_STEP_IDS[POST_RUN_STEP]).toBe("candidates");
  });
});

test("calculation persists the assistant-proposed entries before the run snapshot", () => {
  const beforeTurn = { material: "steel", section: 10 };
  const assistantProposed = { material: "aluminium", section: 16 };

  const update = buildCalculationUpdate("project-1", beforeTurn, assistantProposed, [1], [1]);

  expect(update?.entries).toEqual(assistantProposed);
  expect(update?.entries).not.toEqual(beforeTurn);
});
