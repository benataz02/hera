import { describe, expect, test } from "bun:test";
import { greeting, money, nextActions, percent, scaled, trendOf } from "./dashboardView.ts";

describe("formatting", () => {
  test("money renders whole units with the currency", () => {
    expect(money(1234.5, "EUR")).toBe("€1,235");
  });
  test("percent renders one decimal, and a dash for null", () => {
    expect(percent(0.3155)).toBe("31.6%");
    expect(percent(null)).toBe("—");
  });
  test("scaled abbreviates thousands and millions", () => {
    expect(scaled(950)).toEqual({ value: "950", scale: "" });
    expect(scaled(12_400)).toEqual({ value: "12.4", scale: "k" });
    expect(scaled(1_240_000)).toEqual({ value: "1.24", scale: "M" });
  });
});

describe("trendOf", () => {
  test("compares against the previous period", () => {
    expect(trendOf(10, 5)).toBe("Up");
    expect(trendOf(5, 10)).toBe("Down");
    expect(trendOf(5, 5)).toBe("None");
  });
  test("no previous period is not a trend", () => {
    expect(trendOf(10, 0)).toBe("None");
  });
});

describe("greeting", () => {
  test("changes with the time of day", () => {
    expect(greeting(new Date("2026-08-19T08:00:00"), "Ben")).toBe("Good morning, Ben");
    expect(greeting(new Date("2026-08-19T14:00:00"), "Ben")).toBe("Good afternoon, Ben");
    expect(greeting(new Date("2026-08-19T20:00:00"), "Ben")).toBe("Good evening, Ben");
  });
});

describe("nextActions", () => {
  const base = {
    attention: [], exceptions: { failed: [], agentStale: false, agentLastSeen: null },
  } as never;

  test("is empty when nothing needs a human", () => {
    expect(nextActions(base)).toEqual([]);
  });

  test("pluralises and links each kind of work", () => {
    const o = {
      attention: [{ reason: "Portal request waiting" }, { reason: "Portal request waiting" }, { reason: "Rejected — needs rework" }],
      exceptions: { failed: [{ id: "x" }], agentStale: true, agentLastSeen: null },
    } as never;
    expect(nextActions(o)).toEqual([
      { text: "3 configurations need you", to: "/configs" },
      { text: "1 sync failed", to: "/settings" },
      { text: "The on-prem agent is offline", to: "/settings" },
    ]);
  });
});
