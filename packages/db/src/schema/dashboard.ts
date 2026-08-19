import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** One month × sales-employee cell of the B1 snapshot. */
export type Bucket = {
  orders: { count: number; value: number; grossProfit: number | null };
  quotes: { count: number; closed: number; value: number };
};

export type OpenQuote = {
  docEntry: number;
  docNum: number;
  cardCode: string;
  cardName: string;
  docDate: string; // ISO date, B1 DocDate
  docTotal: number;
  salesPersonCode: number;
};

/** Everything the dashboard needs from B1, aggregated. months: "YYYY-MM" -> SalesPersonCode
 *  (or "" when the document has none) -> Bucket. Bucketing by month AND rep is what lets one
 *  hourly fetch serve every time window and both the "mine" and "tenant" scopes. */
export type B1Snapshot = {
  currency: string;
  months: Record<string, Record<string, Bucket>>;
  openQuotes: OpenQuote[];
  openQuotesTruncated: boolean;
  grossProfitAvailable: boolean;
};

// One row per tenant, replaced wholesale — same posture as config_history.
// ponytail: jsonb blob, not modelled tables; real tables only if the dashboard needs drill-down.
export const dashboardSnapshot = pgTable("dashboard_snapshot", {
  tenantId: text("tenant_id").primaryKey(),
  payload: jsonb("payload").$type<B1Snapshot>().notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  lastError: text("last_error"),
});
