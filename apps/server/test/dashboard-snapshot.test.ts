import { describe, expect, test } from "bun:test";
import { entitySetPath } from "@hera/b1";
import { foldRows, snapshotQueries } from "../src/dashboard-snapshot.ts";

const NOW = new Date("2026-08-19T12:00:00Z");

describe("snapshotQueries", () => {
  test("windows orders and quotations over a rolling 13 months", () => {
    const q = snapshotQueries(NOW);
    expect(q.orders.filter).toBe("DocDate ge '2025-08-01'");
    expect(q.orders.select).toContain("GrossProfit");
    expect(q.quotes.filter).toBe("DocDate ge '2025-08-01'");
  });

  test("open quotations are filtered on status and cancellation, not on date", () => {
    const q = snapshotQueries(NOW);
    expect(q.open.filter).toContain("DocumentStatus eq 'bost_Open'");
    expect(q.open.filter).toContain("Cancelled eq 'tNO'");
    expect(q.open.filter).not.toContain("DocDate ge");
  });

  test("the gross-profit probe asks for a single row", () => {
    expect(entitySetPath("Orders", snapshotQueries(NOW).probe)).toBe("Orders?$select=DocEntry%2CGrossProfit&$top=1");
  });

  test("history streams ask B1 for a real page size, so the walk is not 20 rows at a time", () => {
    const q = snapshotQueries(NOW);
    for (const s of [q.orders, q.quotes, q.open]) expect(s.maxPageSize).toBeGreaterThan(100);
  });
});

describe("foldRows", () => {
  const order = (o: Record<string, unknown>) => ({
    DocDate: "2026-08-03", DocTotal: 100, SalesPersonCode: 1, GrossProfit: 30, ...o,
  });
  const quote = (o: Record<string, unknown>) => ({
    DocDate: "2026-08-03", DocTotal: 50, SalesPersonCode: 1,
    DocumentStatus: "bost_Open", Cancelled: "tNO", ...o,
  });

  test("buckets by month and sales employee", () => {
    const s = foldRows({
      orders: [order({}), order({ SalesPersonCode: 2, DocTotal: 900 }), order({ DocDate: "2026-07-01" })],
      quotes: [], open: [], grossProfitAvailable: true,
    });
    expect(s.months["2026-08"]!["1"]!.orders).toEqual({ count: 1, value: 100, grossProfit: 30 });
    expect(s.months["2026-08"]!["2"]!.orders.value).toBe(900);
    expect(s.months["2026-07"]!["1"]!.orders.count).toBe(1);
  });

  test("a document with no sales employee lands in the empty-string bucket", () => {
    const s = foldRows({ orders: [order({ SalesPersonCode: -1 })], quotes: [], open: [], grossProfitAvailable: true });
    expect(s.months["2026-08"]![""]!.orders.count).toBe(1);
  });

  test("closed and not cancelled counts as converted", () => {
    const s = foldRows({
      orders: [],
      quotes: [
        quote({ DocumentStatus: "bost_Close" }),
        quote({ DocumentStatus: "bost_Close", Cancelled: "tYES" }),
        quote({}),
      ],
      open: [], grossProfitAvailable: false,
    });
    expect(s.months["2026-08"]!["1"]!.quotes).toEqual({ count: 3, closed: 1, value: 150 });
  });

  test("gross profit is null throughout when the probe failed", () => {
    const s = foldRows({ orders: [order({})], quotes: [], open: [], grossProfitAvailable: false });
    expect(s.months["2026-08"]!["1"]!.orders.grossProfit).toBeNull();
    expect(s.grossProfitAvailable).toBe(false);
  });

  test("open quotes are capped and the truncation is reported", () => {
    const many = Array.from({ length: 1200 }, (_, i) => quote({ DocEntry: i, DocNum: i }));
    const s = foldRows({ orders: [], quotes: [], open: many, grossProfitAvailable: false });
    expect(s.openQuotes).toHaveLength(1000);
    expect(s.openQuotesTruncated).toBe(true);
  });
});
