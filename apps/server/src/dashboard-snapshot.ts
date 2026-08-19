import { db, dashboardSnapshot, tenantIntegration, type B1Snapshot, type Bucket, type OpenQuote } from "@hera/db";
import { assertAgentReady, runRequest } from "./orpc/routers/entities.ts";

const OPEN_QUOTE_CAP = 1000;
const SYNC_INTERVAL_MS = 60 * 60_000;

/** Rolling 13 months: twelve so "last 12 months" is whole on the 1st, plus one prior month so
 *  the trend arrows always have something to compare against. */
export function snapshotPaths(now: Date): { orders: string; quotes: string; open: string; probe: string } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 12, 1))
    .toISOString().slice(0, 10);
  const docFields = "DocEntry,DocNum,DocDate,DocTotal,CardCode,CardName,SalesPersonCode";
  return {
    orders: `/Orders?$select=${docFields},GrossProfit&$filter=DocDate ge '${from}'&$orderby=DocEntry`,
    quotes: `/Quotations?$select=${docFields},DocumentStatus,Cancelled&$filter=DocDate ge '${from}'&$orderby=DocEntry`,
    open: `/Quotations?$select=${docFields}&$filter=DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO'&$orderby=DocEntry desc`,
    probe: "/Orders?$select=DocEntry,GrossProfit&$top=1",
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

const rowsOf = (json: unknown): Record<string, unknown>[] => {
  const v = Array.isArray(json) ? json : (json as { value?: unknown } | null)?.value;
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
};

export async function refreshB1Snapshot(
  tenantId: string,
  fetchQuery: (path: string) => Promise<unknown>,
  now: Date = new Date(),
): Promise<void> {
  const paths = snapshotPaths(now);

  // Probe once per run rather than assuming Orders exposes GrossProfit on this B1 version.
  let grossProfitAvailable = true;
  try {
    await fetchQuery(paths.probe);
  } catch {
    grossProfitAvailable = false;
  }

  const ordersPath = grossProfitAvailable
    ? paths.orders
    : paths.orders.replace(",GrossProfit", "");
  const [orders, quotes, open] = await Promise.all([
    fetchQuery(ordersPath), fetchQuery(paths.quotes), fetchQuery(paths.open),
  ]);

  const payload = foldRows({
    orders: rowsOf(orders), quotes: rowsOf(quotes), open: rowsOf(open), grossProfitAvailable,
  });

  await db
    .insert(dashboardSnapshot)
    .values({ tenantId, payload, computedAt: now, lastError: null })
    .onConflictDoUpdate({
      target: dashboardSnapshot.tenantId,
      set: { payload, computedAt: now, lastError: null },
    });
}

// ponytail: one in-process hourly interval, sequential per tenant — the same posture as
// startHistorySync. Move both to a jobs table if the server ever runs multi-instance.
export function startDashboardSnapshot(): void {
  const tick = async () => {
    try {
      const tenants = await db.select({ tenantId: tenantIntegration.tenantId }).from(tenantIntegration);
      for (const t of tenants) {
        try {
          await assertAgentReady(t.tenantId);
          await refreshB1Snapshot(t.tenantId, (path) => runRequest(t.tenantId, "query", { target: "b1", path }));
          console.log(`[dashboard-snapshot] ${t.tenantId}: ok`);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.error(`[dashboard-snapshot] ${t.tenantId} failed: ${message}`);
          await db
            .insert(dashboardSnapshot)
            .values({ tenantId: t.tenantId, payload: foldRows({ orders: [], quotes: [], open: [], grossProfitAvailable: false }), lastError: message })
            .onConflictDoUpdate({ target: dashboardSnapshot.tenantId, set: { lastError: message } });
        }
      }
    } catch (e) {
      console.error(`[dashboard-snapshot] tick failed: ${e instanceof Error ? e.message : e}`);
    }
  };
  setInterval(() => void tick(), SYNC_INTERVAL_MS);
}
