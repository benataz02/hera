import { ORPCError } from "@orpc/server";
import {
  andFilter, coerceKey, countOf, nextLinkOf, rowsOf,
  type B1EntitySchema, type B1Transport, type Key,
} from "@hera/b1";
import type { ListVariantDef } from "@hera/db";
import { compileList } from "./entity-list.ts";
import { decryptSecret, encryptSecret } from "./crypto.ts";
import { viaB1 } from "./b1.ts";

// The B1 read bodies, once. Two routers call these: entities.* (internal, admin) and
// portal.docs.* (a client, fenced to their CardCode). Neither owns the implementation — the same
// pattern portal.extract already uses with extraction.ts.
//
// The `schema` is a parameter rather than something these functions fetch. That is the whole
// seam: the portal hands in a schema filtered to its allowlist, and compileList's existing rules
// then do the fencing with no second policy to keep in step.

/** A modelling error from compileList/coerceKey is the caller's mistake, not a server fault. */
export const bad = (e: unknown): never => {
  throw e instanceof ORPCError
    ? e
    : new ORPCError("BAD_REQUEST", { message: e instanceof Error ? e.message : String(e) });
};

/** What a cursor may be replayed as. A sealed nextLink is bound to its tenant, entity set and
 *  fence, so a portal client cannot hand back an internal user's cursor and read rows their
 *  CardCode filter would have excluded, nor reach an entity `entity-profiles.ts` never curated. */
export type CursorFence = { tenantId: string; key: string };

/** B1's `@odata.nextLink`, encrypted. The client gets an opaque blob and hands it straight back:
 *  it can neither read the URL nor forge one, so `readNext`'s origin check is no longer the only
 *  thing standing between a browser and an arbitrary Service Layer query. Sealing reuses
 *  crypto.ts's AES-256-GCM — the auth tag is what makes a tampered cursor fail closed. */
const sealCursor = (entity: string, f: CursorFence, nextLink: string): string =>
  encryptSecret(JSON.stringify([f.tenantId, entity, f.key, nextLink]));

const openCursor = (entity: string, f: CursorFence, cursor: string): string => {
  let parts: unknown;
  try {
    parts = JSON.parse(decryptSecret(cursor));
  } catch {
    throw new ORPCError("BAD_REQUEST", { message: "Invalid page cursor" });
  }
  const [tenantId, ent, key, link] = parts as [string, string, string, string];
  if (tenantId !== f.tenantId || ent !== entity || key !== f.key || typeof link !== "string")
    throw new ORPCError("BAD_REQUEST", { message: "Page cursor does not belong to this list" });
  return link;
};

export type RowsArgs = {
  spec: ListVariantDef;
  /** rows per page — `Prefer: odata.maxpagesize`, from B1_PAGE_SIZE */
  pageSize: number;
  /** sealed `@odata.nextLink` from the previous page; absent = first page */
  cursor?: string;
  count?: boolean;
};

/**
 * One page of rows for a saved list view. The spec is compiled to OData here — the browser never
 * sends a filter string.
 *
 * `extraFilter` is ANDed onto the *compiled* filter, not onto the spec. That is deliberate: a
 * scope clause added after compilation names a field the caller's schema may not even contain,
 * so the caller cannot express, override or observe it through their own spec.
 */
export async function readRows(
  b1: B1Transport,
  schema: B1EntitySchema,
  entity: string,
  a: RowsArgs,
  fence: CursorFence,
  extraFilter?: string,
) {
  let res;
  if (a.cursor) {
    // Continuing a list: the next page is wherever B1 said it is. Nothing is recomputed here, so
    // the filter/orderby/fence of page 1 cannot drift from page 2 — the link carries them.
    const link = openCursor(entity, fence, a.cursor);
    res = await viaB1(() => b1.readNext(link, a.pageSize));
  } else {
    let query;
    try {
      query = compileList(schema, a.spec, { pageSize: a.pageSize, count: a.count });
    } catch (e) {
      return bad(e);
    }
    if (extraFilter) query.filter = andFilter(query.filter, extraFilter);
    res = await viaB1(() => b1.readEntitySet(entity, query));
  }

  const rows = rowsOf(res.data);
  const next = nextLinkOf(res.data);
  return {
    rows,
    keys: schema.keys,
    // Only page 1 asks for $count; @odata.count does not ride along on a nextLink page.
    total: countOf(res.data),
    // B1's own answer to "is there more", sealed. Never a row count we guessed at, and never a
    // URL the browser can read or edit.
    nextCursor: next ? sealCursor(entity, fence, next) : undefined,
  };
}

/** One row, with its ETag — which is what makes a curated edit safe. The schema decides string
 *  vs integer quoting: a digit-looking ItemCode is not an Int32 key. */
export async function readOne(b1: B1Transport, schema: B1EntitySchema, entity: string, raw: Key) {
  let key: Key;
  try {
    key = coerceKey(schema, raw);
  } catch (e) {
    return bad(e);
  }
  const res = await viaB1(() => b1.readEntity(entity, key));
  return { row: res.data as Record<string, unknown>, etag: res.etag ?? null };
}
