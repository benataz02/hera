import { describe, expect, test } from "bun:test";
import { ageBuckets, buildOverview, medianDays, monthKeys, type ProjectRow } from "../src/dashboard.ts";
import type { B1Snapshot, OpenQuote } from "@hera/db";

const NOW = new Date("2026-08-19T12:00:00Z");
const day = 24 * 60 * 60 * 1000;

describe("monthKeys", () => {
  test("month window is the current month only", () => {
    expect(monthKeys("month", NOW)).toEqual(["2026-08"]);
  });
  test("quarter window is the three months of the calendar quarter to date", () => {
    expect(monthKeys("quarter", NOW)).toEqual(["2026-07", "2026-08"]);
  });
  test("year12 window is twelve months ending with the current one", () => {
    const keys = monthKeys("year12", NOW);
    expect(keys).toHaveLength(12);
    expect(keys[0]).toBe("2025-09");
    expect(keys[11]).toBe("2026-08");
  });
});

describe("medianDays", () => {
  test("odd count takes the middle value", () => {
    expect(medianDays([1 * day, 5 * day, 3 * day])).toBeCloseTo(3, 6);
  });
  test("even count averages the two middle values", () => {
    expect(medianDays([2 * day, 4 * day, 6 * day, 8 * day])).toBeCloseTo(5, 6);
  });
  test("empty sample is null, not zero", () => {
    expect(medianDays([])).toBeNull();
  });
});

describe("ageBuckets", () => {
  const q = (docEntry: number, daysAgo: number, total: number): OpenQuote => ({
    docEntry, docNum: docEntry, cardCode: "C1", cardName: "Acme",
    docDate: new Date(NOW.getTime() - daysAgo * day).toISOString().slice(0, 10),
    docTotal: total, salesPersonCode: 1,
  });

  test("assigns each quote to exactly one bucket at the boundaries", () => {
    const out = ageBuckets([q(1, 0, 10), q(2, 7, 20), q(3, 8, 40), q(4, 14, 80),
                            q(5, 15, 160), q(6, 30, 320), q(7, 31, 640)], NOW, new Set());
    expect(out.map((b) => [b.bucket, b.count, b.value])).toEqual([
      ["0-7d", 2, 30],
      ["8-14d", 2, 120],
      ["15-30d", 2, 480],
      ["30d+", 1, 640],
    ]);
  });

  test("records the HERA-originated doc entries per bucket", () => {
    const out = ageBuckets([q(1, 0, 10), q(2, 40, 20)], NOW, new Set([2]));
    expect(out[0]!.docEntries).toEqual([]);
    expect(out[3]!.docEntries).toEqual([2]);
  });
});

describe("buildOverview", () => {
  const emptySnapshot: B1Snapshot = {
    currency: "EUR", months: {}, openQuotes: [], openQuotesTruncated: false,
    grossProfitAvailable: false,
  };
  const project = (over: Partial<ProjectRow>): ProjectRow => ({
    id: "p1", name: "Pump", status: "draft", source: "internal", createdBy: "u1",
    createdAt: new Date(NOW.getTime() - 3 * day), customerName: "Acme",
    quotedAt: null, b1DocEntry: null, quotedValue: null, quotedCost: null, ...over,
  });
  const base = {
    window: "month" as const, now: NOW,
    snapshot: { payload: emptySnapshot, computedAt: NOW, lastError: null },
    projects: [],
  };

  test("funnel counts every stage, ordered draft to ordered", () => {
    const out = buildOverview({
      ...base,
      projects: [
        project({ id: "a", status: "draft" }),
        project({ id: "b", status: "calculated" }),
        project({ id: "c", status: "requested" }),
        project({ id: "d", status: "quoted", quotedAt: NOW, b1DocEntry: 10 }),
        project({ id: "e", status: "quoted", quotedAt: NOW, b1DocEntry: 11 }),
      ],
    });
    // Both quoted runs have a b1DocEntry that is absent from openQuotes, so the
    // "not open ⇒ converted" approximation counts them as ordered.
    expect(out.funnel).toEqual([
      { stage: "Draft", count: 1 },
      { stage: "Calculated", count: 2 },
      { stage: "Quoted", count: 2 },
      { stage: "Ordered", count: 2 },
    ]);
  });

  test("nothing counts as ordered without a snapshot to check against", () => {
    const out = buildOverview({
      ...base, snapshot: null,
      projects: [project({ status: "quoted", quotedAt: NOW, b1DocEntry: 10 })],
    });
    expect(out.funnel[3]).toEqual({ stage: "Ordered", count: 0 });
  });

  test("a quotation still open in B1 is quoted, not ordered", () => {
    const openQuote = {
      docEntry: 10, docNum: 10, cardCode: "C1", cardName: "Acme",
      docDate: "2026-08-01", docTotal: 500, salesPersonCode: 1,
    };
    const out = buildOverview({
      ...base,
      snapshot: { payload: { ...emptySnapshot, openQuotes: [openQuote] }, computedAt: NOW, lastError: null },
      projects: [project({ status: "quoted", quotedAt: NOW, b1DocEntry: 10 })],
    });
    expect(out.funnel[3]).toEqual({ stage: "Ordered", count: 0 });
  });

  test("margin excludes runs with no captured value and reports the coverage", () => {
    const out = buildOverview({
      ...base,
      projects: [
        project({ id: "a", status: "quoted", quotedAt: NOW, quotedValue: 1000, quotedCost: 700 }),
        project({ id: "b", status: "quoted", quotedAt: NOW, quotedValue: null, quotedCost: null }),
      ],
    });
    expect(out.margin.pct).toBeCloseTo(0.3, 6);
    expect(out.margin.covered).toBe(1);
    expect(out.margin.of).toBe(2);
  });

  test("margin is null rather than zero when nothing is covered", () => {
    const out = buildOverview({ ...base, projects: [project({ status: "quoted", quotedAt: NOW })] });
    expect(out.margin.pct).toBeNull();
  });

  test("missing snapshot yields zeroed B1 figures and a null computedAt", () => {
    const out = buildOverview({ ...base, snapshot: null });
    expect(out.orderValue.total).toBe(0);
    expect(out.computedAt).toBeNull();
  });

  test("sums every sales-employee bucket in the window", () => {
    const months = {
      "2026-08": {
        "1": { orders: { count: 1, value: 100, grossProfit: null }, quotes: { count: 2, closed: 1, value: 200 } },
        "2": { orders: { count: 1, value: 900, grossProfit: null }, quotes: { count: 1, closed: 0, value: 50 } },
      },
    };
    const snapshot = { payload: { ...emptySnapshot, months }, computedAt: NOW, lastError: null };
    expect(buildOverview({ ...base, snapshot }).orderValue.total).toBe(1000);
  });

  test("conversion divides closed quotes by total quotes in the window", () => {
    const months = {
      "2026-08": {
        "": { orders: { count: 0, value: 0, grossProfit: null }, quotes: { count: 4, closed: 1, value: 400 } },
      },
    };
    const out = buildOverview({ ...base, snapshot: { payload: { ...emptySnapshot, months }, computedAt: NOW, lastError: null } });
    expect(out.conversion.rate).toBeCloseTo(0.25, 6);
  });

});
