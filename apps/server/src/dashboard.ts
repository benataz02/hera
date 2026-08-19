import type { B1Snapshot, Bucket, OpenQuote, ProjectSource, ProjectStatus } from "@hera/db";

export type Window = "month" | "quarter" | "year12";
export type Scope = "mine" | "tenant";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Matches AGENT_STALE_MS in orpc/routers/entities.ts. */
const AGENT_STALE_MS = 90_000;
/** A quoted configuration nobody has moved in this long wants a human. */
const STALE_QUOTE_DAYS = 7;

export type ProjectRow = {
  id: string; name: string; status: ProjectStatus; source: ProjectSource;
  createdBy: string; createdAt: Date; customerName: string | null;
  quotedAt: Date | null; b1DocEntry: number | null;
  quotedValue: number | null; quotedCost: number | null;
};

export type ExceptionRow = { id: string; kind: string; lastError: string | null; updatedAt: Date };

export type Overview = {
  window: Window; scope: Scope; currency: string;
  computedAt: string | null; snapshotError: string | null;
  orderValue: { total: number; hera: number; prevTotal: number };
  conversion: { rate: number; prevRate: number; quotes: number; converted: number };
  turnaround: { medianDays: number | null; sampled: number };
  margin: { pct: number | null; value: number; cost: number; covered: number; of: number };
  funnel: Array<{ stage: string; count: number }>;
  pipeline: Array<{ bucket: string; value: number; count: number; docEntries: number[] }>;
  pipelineTruncated: boolean;
  attention: Array<{ id: string; name: string; customer: string | null; docEntry: number | null; reason: string; ageDays: number }>;
  exceptions: { failed: ExceptionRow[]; agentStale: boolean; agentLastSeen: string | null };
};

const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

/** The "YYYY-MM" keys a window covers, oldest first. */
export function monthKeys(window: Window, now: Date): string[] {
  if (window === "month") return [monthKey(now)];
  const out: string[] = [];
  if (window === "quarter") {
    const firstMonth = Math.floor(now.getUTCMonth() / 3) * 3;
    for (let m = firstMonth; m <= now.getUTCMonth(); m++) {
      out.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), m, 1))));
    }
    return out;
  }
  for (let i = 11; i >= 0; i--) {
    out.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
  }
  return out;
}

/** The month keys immediately preceding a window, same length — for the trend arrow. */
function priorKeys(keys: string[], now: Date, window: Window): string[] {
  const span = keys.length;
  const first = window === "month" ? now.getUTCMonth() : now.getUTCMonth() - span + 1;
  const out: string[] = [];
  for (let i = span; i >= 1; i--) {
    out.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), first - i, 1))));
  }
  return out;
}

export function medianDays(durationsMs: number[]): number | null {
  if (durationsMs.length === 0) return null;
  const s = [...durationsMs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  const ms = s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  return ms / DAY_MS;
}

const EMPTY: Bucket = {
  orders: { count: 0, value: 0, grossProfit: null },
  quotes: { count: 0, closed: 0, value: 0 },
};

/** Sum the cells a (window, scope) selects. rep === null means every rep. */
function sumBuckets(months: B1Snapshot["months"], keys: string[], rep: number | null): Bucket {
  const acc: Bucket = structuredClone(EMPTY);
  for (const k of keys) {
    const byRep = months[k];
    if (!byRep) continue;
    for (const [code, b] of Object.entries(byRep)) {
      if (rep !== null && code !== String(rep)) continue;
      acc.orders.count += b.orders.count;
      acc.orders.value += b.orders.value;
      if (b.orders.grossProfit !== null) {
        acc.orders.grossProfit = (acc.orders.grossProfit ?? 0) + b.orders.grossProfit;
      }
      acc.quotes.count += b.quotes.count;
      acc.quotes.closed += b.quotes.closed;
      acc.quotes.value += b.quotes.value;
    }
  }
  return acc;
}

const BUCKET_EDGES: Array<[label: string, maxDays: number]> = [
  ["0-7d", 7], ["8-14d", 14], ["15-30d", 30], ["30d+", Infinity],
];

export function ageBuckets(
  quotes: OpenQuote[], now: Date, heraDocEntries: Set<number>,
): Overview["pipeline"] {
  const out = BUCKET_EDGES.map(([bucket]) => ({ bucket, value: 0, count: 0, docEntries: [] as number[] }));
  // Compare date-to-date, not instant-to-instant: B1 DocDate has no time, so a quote raised
  // today must read as 0 days old regardless of what time the dashboard is loaded.
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (const q of quotes) {
    const ageDays = (today - Date.parse(`${q.docDate}T00:00:00Z`)) / DAY_MS;
    const i = BUCKET_EDGES.findIndex(([, max]) => ageDays <= max);
    const slot = out[i === -1 ? out.length - 1 : i]!;
    slot.value += q.docTotal;
    slot.count += 1;
    if (heraDocEntries.has(q.docEntry)) slot.docEntries.push(q.docEntry);
  }
  return out;
}

export function buildOverview(input: {
  window: Window; scope: Scope; now: Date;
  snapshot: { payload: B1Snapshot; computedAt: Date; lastError: string | null } | null;
  salesPersonCode: number | null;
  projects: ProjectRow[];
  failed: ExceptionRow[];
  agentLastSeen: Date | null;
}): Overview {
  const { window, scope, now, snapshot, salesPersonCode, projects, failed, agentLastSeen } = input;
  const rep = scope === "mine" ? salesPersonCode : null;
  const payload = snapshot?.payload;
  const keys = monthKeys(window, now);
  const cur = payload ? sumBuckets(payload.months, keys, rep) : structuredClone(EMPTY);
  const prev = payload ? sumBuckets(payload.months, priorKeys(keys, now, window), rep) : structuredClone(EMPTY);

  const heraDocEntries = new Set(
    projects.filter((p) => p.b1DocEntry !== null).map((p) => p.b1DocEntry!),
  );

  const quoted = projects.filter((p) => p.quotedAt !== null);
  const turnaroundMs = quoted.map((p) => p.quotedAt!.getTime() - p.createdAt.getTime());

  const withMargin = quoted.filter((p) => p.quotedValue !== null && p.quotedCost !== null);
  const marginValue = withMargin.reduce((s, p) => s + p.quotedValue!, 0);
  const marginCost = withMargin.reduce((s, p) => s + p.quotedCost!, 0);

  // A HERA quotation absent from openQuotes counts as converted.
  // ponytail: "not open" stands in for "ordered" — exact attribution needs
  //           Orders?$expand=DocumentLines($select=BaseEntry,BaseType). Upgrade on dispute.
  // null, not an empty set: with no snapshot we cannot tell converted from open, and claiming
  // every HERA quotation converted would be the worst possible default.
  const open = payload ? new Set(payload.openQuotes.map((q) => q.docEntry)) : null;
  const isOrdered = (p: ProjectRow) => open !== null && p.b1DocEntry !== null && !open.has(p.b1DocEntry);

  const ordered = projects.filter(isOrdered);
  const stage = (...s: ProjectStatus[]) => projects.filter((p) => s.includes(p.status)).length;

  const attention = projects
    .filter((p) => p.status === "requested" || p.status === "rejected" ||
      (p.status === "quoted" && p.quotedAt !== null &&
        (now.getTime() - p.quotedAt.getTime()) / DAY_MS > STALE_QUOTE_DAYS))
    .map((p) => ({
      id: p.id, name: p.name, customer: p.customerName, docEntry: p.b1DocEntry,
      reason: p.status === "requested" ? "Portal request waiting"
        : p.status === "rejected" ? "Rejected — needs rework"
        : `No movement for ${STALE_QUOTE_DAYS}+ days`,
      ageDays: Math.floor((now.getTime() - (p.quotedAt ?? p.createdAt).getTime()) / DAY_MS),
    }))
    .sort((a, b) => b.ageDays - a.ageDays);

  const heraOrderValue = withMargin.filter(isOrdered).reduce((s, p) => s + p.quotedValue!, 0);

  return {
    window, scope,
    currency: payload?.currency ?? "EUR",
    computedAt: snapshot?.computedAt.toISOString() ?? null,
    snapshotError: snapshot?.lastError ?? null,
    orderValue: { total: cur.orders.value, hera: heraOrderValue, prevTotal: prev.orders.value },
    conversion: {
      rate: cur.quotes.count ? cur.quotes.closed / cur.quotes.count : 0,
      prevRate: prev.quotes.count ? prev.quotes.closed / prev.quotes.count : 0,
      quotes: cur.quotes.count, converted: cur.quotes.closed,
    },
    turnaround: { medianDays: medianDays(turnaroundMs), sampled: turnaroundMs.length },
    margin: {
      pct: marginValue > 0 ? (marginValue - marginCost) / marginValue : null,
      value: marginValue, cost: marginCost, covered: withMargin.length, of: quoted.length,
    },
    funnel: [
      { stage: "Draft", count: stage("draft") },
      { stage: "Calculated", count: stage("calculated", "requested", "rejected") },
      { stage: "Quoted", count: stage("quoted") },
      { stage: "Ordered", count: ordered.length },
    ],
    pipeline: ageBuckets(payload?.openQuotes ?? [], now, heraDocEntries),
    pipelineTruncated: payload?.openQuotesTruncated ?? false,
    attention,
    exceptions: {
      failed,
      agentStale: !agentLastSeen || now.getTime() - agentLastSeen.getTime() > AGENT_STALE_MS,
      agentLastSeen: agentLastSeen?.toISOString() ?? null,
    },
  };
}
