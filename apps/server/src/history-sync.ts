import { and, eq } from "drizzle-orm";
import { db, configHistory } from "@hera/db";
import type { ModelDef, Val } from "@hera/config-engine";
import { fetchQueryTable, type QueryRunner } from "./lookups.ts";

// Pull a model's history query rows into config_history, wholesale (delete + insert, one tx).
// The query is the source of truth — no dedup/merge. Read side (configs.similar) goes through
// loadHistoryRows' 5-min cache, invalidated on every sync.

const CACHE_TTL_MS = 5 * 60_000;
/** Pages of the history query one sync will walk. At B1's default page size that is tens of
 *  thousands of rows — deeper history is the signal to move this off the request path. */
const HISTORY_MAX_PAGES = 200;
const cache = new Map<string, { at: number; rows: Record<string, Val>[] }>();
const keyOf = (tenantId: string, modelId: string) => `${tenantId}:${modelId}`;

export async function loadHistoryRows(tenantId: string, modelId: string): Promise<Record<string, Val>[]> {
  const key = keyOf(tenantId, modelId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;
  const rows = (
    await db
      .select({ row: configHistory.row })
      .from(configHistory)
      .where(and(eq(configHistory.tenantId, tenantId), eq(configHistory.modelId, modelId)))
  ).map((r) => r.row);
  cache.set(key, { at: Date.now(), rows });
  return rows;
}

export async function syncModelHistory(
  tenantId: string,
  modelId: string,
  def: ModelDef,
  run: QueryRunner,
): Promise<{ count: number }> {
  const q = def.history?.query;
  if (!q) throw new Error("Model has no history query");
  // ponytail: capped synchronous walk. The cap is stated here, at the call site, precisely
  // because packages/b1 has no readAll to hide it in.
  const t = await fetchQueryTable(run, q.target, q.query, q.columns, { maxPages: HISTORY_MAX_PAGES });
  const rows = t.rows.map((r) => Object.fromEntries(t.columns.map((c, i) => [c, r[i] ?? null])));
  await db.transaction(async (tx) => {
    await tx.delete(configHistory).where(and(eq(configHistory.tenantId, tenantId), eq(configHistory.modelId, modelId)));
    for (let i = 0; i < rows.length; i += 1000) {
      await tx.insert(configHistory).values(rows.slice(i, i + 1000).map((row) => ({ tenantId, modelId, row })));
    }
  });
  cache.delete(keyOf(tenantId, modelId));
  return { count: rows.length };
}
