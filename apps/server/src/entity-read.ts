import { ORPCError } from "@orpc/server";
import {
  andFilter, coerceKey, countOf, rowsOf,
  type B1EntitySchema, type B1Transport, type Key,
} from "@hera/b1";
import type { ListVariantDef } from "@hera/db";
import { compileList } from "./entity-list.ts";
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

export type RowsArgs = { spec: ListVariantDef; top: number; skip?: number; count?: boolean };

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
  extraFilter?: string,
) {
  let query;
  try {
    query = compileList(schema, a.spec, { top: a.top, skip: a.skip, count: a.count });
  } catch (e) {
    return bad(e);
  }
  if (extraFilter) query.filter = andFilter(query.filter, extraFilter);

  const res = await viaB1(() => b1.readEntitySet(entity, query));
  const rows = rowsOf(res.data);
  return {
    rows,
    keys: schema.keys,
    total: countOf(res.data),
    // A full page probably means another one; one empty read at the end beats $count per page.
    nextSkip: rows.length === a.top ? (a.skip ?? 0) + rows.length : undefined,
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
