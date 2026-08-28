import { db, dashboardSnapshot, type B1Snapshot, type Bucket, type OpenQuote } from "@hera/db";
import { readPages, type B1Transport, type QueryOptions } from "@hera/b1";

const OPEN_QUOTE_CAP = 1000;
/** Rows per Service Layer page while walking the snapshot's history. */
const PAGE_SIZE = 500;
// ponytail: capped synchronous refresh — 40 pages x 500 rows is ~20k documents per stream. If a
// tenant's history outgrows one request, that is when a job runner earns its place, not before.
const MAX_PAGES = 40;

export type SnapshotQueries = { orders: QueryOptions; quotes: QueryOptions; open: QueryOptions; probe: QueryOptions };

const DOC_FIELDS = ["DocEntry", "DocNum", "DocDate", "DocTotal", "CardCode", "CardName", "SalesPersonCode"];

/** Rolling 13 months: twelve so "last 12 months" is whole on the 1st, plus one prior month so
 *  the trend arrows always have something to compare against. */
export function snapshotQueries(now: Date): SnapshotQueries {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 12, 1))
    .toISOString().slice(0, 10);
  return {
    orders: { select: [...DOC_FIELDS, "GrossProfit"], filter: `DocDate ge '${from}'`, orderby: "DocEntry", maxPageSize: PAGE_SIZE },
    quotes: { select: [...DOC_FIELDS, "DocumentStatus", "Cancelled"], filter: `DocDate ge '${from}'`, orderby: "DocEntry", maxPageSize: PAGE_SIZE },
    open: {
      select: DOC_FIELDS,
      filter: "DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO'",
      orderby: "DocEntry desc", maxPageSize: PAGE_SIZE,
    },
    probe: { select: ["DocEntry", "GrossProfit"], top: 1 },
  };
}

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0)) || 0;
const str = (v: unknown): string => (v == null ? "" : String(v));
const monthOf = (docDate: unknown): string => str(docDate).slice(0, 7);
/** B1 uses -1 for "no sales employee"; bucket those under "". */
const repOf = (code: unknown): string => (num(code) > 0 ? String(num(code)) : "");

const emptyBucket = (): Bucket => ({
  orders: { count: 0, value: 0, grossProfit: null },
  quotes: { count: 0, closed: 0, value: 0 },
});

export function foldRows(input: {
  orders: Record<string, unknown>[]; quotes: Record<string, unknown>[];
  open: Record<string, unknown>[]; grossProfitAvailable: boolean;
}): B1Snapshot {
  const months: B1Snapshot["months"] = {};
  const cell = (row: Record<string, unknown>): Bucket => {
    const m = (months[monthOf(row.DocDate)] ??= {});
    return (m[repOf(row.SalesPersonCode)] ??= emptyBucket());
  };

  for (const o of input.orders) {
    const b = cell(o);
    b.orders.count += 1;
    b.orders.value += num(o.DocTotal);
    if (input.grossProfitAvailable) b.orders.grossProfit = (b.orders.grossProfit ?? 0) + num(o.GrossProfit);
  }
  for (const q of input.quotes) {
    const b = cell(q);
    b.quotes.count += 1;
    b.quotes.value += num(q.DocTotal);
    // ponytail: closed-and-not-cancelled stands in for converted. Exact attribution needs
    //           Orders?$expand=DocumentLines($select=BaseEntry,BaseType). Upgrade on dispute.
    if (str(q.DocumentStatus) === "bost_Close" && str(q.Cancelled) !== "tYES") b.quotes.closed += 1;
  }

  const openQuotes: OpenQuote[] = input.open.slice(0, OPEN_QUOTE_CAP).map((q) => ({
    docEntry: num(q.DocEntry), docNum: num(q.DocNum),
    cardCode: str(q.CardCode), cardName: str(q.CardName),
    docDate: str(q.DocDate).slice(0, 10), docTotal: num(q.DocTotal),
    salesPersonCode: num(q.SalesPersonCode),
  }));

  return {
    currency: "EUR", // ponytail: tenant default; per-document DocCurrency when a tenant is multi-currency.
    months,
    openQuotes,
    openQuotesTruncated: input.open.length > OPEN_QUOTE_CAP,
    grossProfitAvailable: input.grossProfitAvailable,
  };
}

export async function refreshB1Snapshot(
  tenantId: string,
  b1: B1Transport,
  now: Date = new Date(),
): Promise<void> {
  const q = snapshotQueries(now);

  // Probe once per run rather than assuming Orders exposes GrossProfit on this B1 version.
  let grossProfitAvailable = true;
  try {
    await b1.readEntitySet("Orders", q.probe);
  } catch {
    grossProfitAvailable = false;
  }

  const ordersQuery = grossProfitAvailable
    ? q.orders
    : { ...q.orders, select: q.orders.select?.filter((c) => c !== "GrossProfit") };
  // Each stream is a bounded nextLink walk. Without it a refresh silently kept only B1's first
  // page (20 rows by default) and reported it as a whole year.
  const [orders, quotes, open] = await Promise.all([
    readPages(b1, "Orders", ordersQuery, { maxPages: MAX_PAGES }),
    readPages(b1, "Quotations", q.quotes, { maxPages: MAX_PAGES }),
    readPages(b1, "Quotations", q.open, { maxPages: MAX_PAGES }),
  ]);

  const payload = foldRows({
    orders: orders.rows, quotes: quotes.rows, open: open.rows, grossProfitAvailable,
  });
  // Hitting the page cap is truncation too — never report a capped walk as a complete one.
  payload.openQuotesTruncated ||= open.truncated;

  await db
    .insert(dashboardSnapshot)
    .values({ tenantId, payload, computedAt: now, lastError: null })
    .onConflictDoUpdate({
      target: dashboardSnapshot.tenantId,
      set: { payload, computedAt: now, lastError: null },
    });
}
