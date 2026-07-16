import { and, eq, sql } from "drizzle-orm";
import { db, configHistory, configModel } from "@hera/db";
import type { ModelDef, Val } from "@hera/config-engine";
import { fetchQueryTable, type QueryFetcher } from "./lookups.ts";
import { assertAgentReady, runRequest } from "./orpc/routers/entities.ts";

// Pull a model's history query rows into config_history, wholesale (delete + insert, one tx).
// The query is the source of truth — no dedup/merge. Read side (configs.similar) goes through
// loadHistoryRows' 5-min cache, invalidated on every sync.

const CACHE_TTL_MS = 5 * 60_000;
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
  fetchQuery: QueryFetcher,
): Promise<{ count: number }> {
  const q = def.history?.query;
  if (!q?.path) throw new Error("Model has no history query");
  const t = await fetchQueryTable(fetchQuery, q.target, q.path, q.columns);
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

const SYNC_INTERVAL_MS = 60 * 60_000;

// ponytail: single in-process hourly interval, sequential per model; move to a jobs table if the
// server ever runs multi-instance or a tenant's sync gets slow enough to matter.
export function startHistorySync(): void {
  const tick = async () => {
    const models = await db
      .select({ id: configModel.id, tenantId: configModel.tenantId, definition: configModel.definition })
      .from(configModel)
      .where(sql`${configModel.definition} -> 'history' -> 'query' is not null`);
    for (const m of models) {
      try {
        await assertAgentReady(m.tenantId);
        const { count } = await syncModelHistory(m.tenantId, m.id, m.definition, (target, path) =>
          runRequest(m.tenantId, "query", { target, path }));
        console.log(`[history-sync] ${m.tenantId}/${m.id}: ${count} rows`);
      } catch (e) {
        console.error(`[history-sync] ${m.tenantId}/${m.id} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  };
  setInterval(() => void tick(), SYNC_INTERVAL_MS);
}
