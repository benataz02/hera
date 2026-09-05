import { and, eq } from "drizzle-orm";
import { db, entityMeta } from "@hera/db";
import {
  parseEntityList, parseEntitySchema, type B1EntityRef, type B1EntitySchema, type B1Transport,
} from "@hera/b1";

// B1's $metadata, cached. The full EDMX is ~1.7 MB; both reads here use the scoped query the
// Service Layer already supports, so a schema costs one entity's worth of XML, not the lot.

const TTL_MS = 24 * 60 * 60_000;

/** Bump this whenever metadata.ts changes what a parsed schema looks like. A row parsed by the
 *  old code is stale however fresh it is, and without this every tenant keeps serving the old
 *  shape for a day — which is how BoYesNoEnum kept rendering as a tYES/tNO dropdown after it
 *  became a boolean. */
//  Must be a past timestamp: `Math.min` with process start so a future one can only ever be a
//  no-op, never a re-read of $metadata on every single request.
const PARSER_EPOCH = Math.min(Date.parse("2026-08-28T07:55:00Z"), Date.now());

/** A cached schema is usable if it is inside the TTL and was parsed by the current parser. */
export const cacheIsFresh = (fetchedAt: Date, now = Date.now()): boolean =>
  fetchedAt.getTime() >= PARSER_EPOCH && now - fetchedAt.getTime() < TTL_MS;

/** The entity list is small and shared by every browse page — a per-process cache is enough,
 *  and it self-heals on restart. The per-entity schemas go to Postgres because there are ~420
 *  of them and they outlive a deploy. */
const listCache = new Map<string, { at: number; list: Promise<B1EntityRef[]> }>();

export function entityList(tenantId: string, b1: B1Transport, refresh = false): Promise<B1EntityRef[]> {
  const hit = listCache.get(tenantId);
  if (!refresh && hit && Date.now() - hit.at < TTL_MS) return hit.list;
  const list = b1
    .metadata({ scope: "entityset", annotation: "labelWithTable" })
    .then(parseEntityList);
  list.catch(() => listCache.delete(tenantId)); // a failed fetch must not poison the key for a day
  listCache.set(tenantId, { at: Date.now(), list });
  return list;
}

/** Reject an entity name the tenant's B1 does not expose, before it can reach a URL. */
export async function assertEntity(tenantId: string, b1: B1Transport, name: string): Promise<B1EntityRef> {
  const found = (await entityList(tenantId, b1)).find((e) => e.name === name);
  if (!found) throw new Error(`Unknown entity set '${name}'`);
  return found;
}

export async function entitySchema(
  tenantId: string,
  b1: B1Transport,
  name: string,
  refresh = false,
): Promise<B1EntitySchema> {
  await assertEntity(tenantId, b1, name);
  if (!refresh) {
    const [row] = await db
      .select()
      .from(entityMeta)
      .where(and(eq(entityMeta.tenantId, tenantId), eq(entityMeta.entityName, name)))
      .limit(1);
    if (row && cacheIsFresh(row.fetchedAt)) return row.json;
  }

  // dependency=true pulls the ComplexTypes and EnumTypes this entity's properties reference,
  // which is what makes one scoped call enough to render a whole form.
  const xml = await b1.metadata({
    scope: "entityset",
    annotation: "labelWithField,labelWithTable",
    entityset: name,
    dependency: true,
  });
  const schema = parseEntitySchema(xml, name, await entityList(tenantId, b1, refresh));
  const fetchedAt = new Date();
  await db
    .insert(entityMeta)
    .values({ tenantId, entityName: name, json: schema, fetchedAt })
    .onConflictDoUpdate({
      target: [entityMeta.tenantId, entityMeta.entityName],
      set: { json: schema, fetchedAt },
    });
  return schema;
}
