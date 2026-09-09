import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { db, sapConnection } from "@hera/db";
import { B1Error, RemoteTransport, nextLinkOf, readPages, rowsOrThrow, type AgentTarget, type B1Transport, type Connector } from "@hera/b1";
import { decryptSecret } from "./crypto.ts";
import { DEFAULT_PAGE, type QueryRunner } from "./lookups.ts";

export const SAP_UNAVAILABLE = "SAP is not connected.";

export type { Connector };

export type TenantAgent = AgentTarget & { beasEnabled: boolean };

/** The tenant's agent, as plain config. One PK select — nothing here is worth caching. Printing
 *  needs this without a transport, so the row->config mapping lives here rather than inline. */
export async function agentTarget(tenantId: string): Promise<TenantAgent> {
  const [row] = await db.select().from(sapConnection).where(eq(sapConnection.tenantId, tenantId)).limit(1);
  if (!row) throw new ORPCError("SERVICE_UNAVAILABLE", { message: SAP_UNAVAILABLE });
  return {
    agentUrl: row.agentUrl,
    secret: decryptSecret(row.secret),
    accessClientId: row.accessClientId,
    accessClientSecret: row.accessClientSecret,
    beasEnabled: row.beasEnabled,
  };
}

/** The tenant's on-prem agent, as a pair of transports. The transports hold nothing but config,
 *  so there is nothing worth caching. */
export async function tenantConnector(tenantId: string): Promise<Connector> {
  const a = await agentTarget(tenantId);
  return {
    b1: new RemoteTransport({ ...a, target: "b1" }),
    beas: a.beasEnabled ? new RemoteTransport({ ...a, target: "beas" }) : null,
  };
}

export function transportFor(c: Connector, target: "b1" | "beas"): B1Transport {
  const t = target === "beas" ? c.beas : c.b1;
  if (!t) throw new ORPCError("SERVICE_UNAVAILABLE", { message: "Beas is not enabled for this workspace." });
  return t;
}

/** Map a B1Error to the closest ORPCError. Status + code come off the wire intact, so this is a
 *  lookup rather than a regex over a message. Agent-auth 401 is the exception: it never reached
 *  SAP, so it must not be phrased as a SAP rejection. Anything else is rethrown untouched. */
export function toOrpcError(e: unknown): unknown {
  if (e instanceof ORPCError) return e;
  if (!(e instanceof B1Error)) return e;
  const message = e.message;
  switch (true) {
    case e.status === 503:
      return new ORPCError("SERVICE_UNAVAILABLE", { message });
    case e.status === 401 && message === "Bad agent secret":
      return new ORPCError("BAD_GATEWAY", {
        message: "The on-prem agent rejected the shared secret. Re-run seed:agent with the secret from agent.json.",
      });
    case e.status === 401 || e.status === 403:
      return new ORPCError("BAD_GATEWAY", { message: `SAP rejected the request: ${message}` });
    case e.status === 404:
      return new ORPCError("NOT_FOUND", { message });
    case e.status === 409 || e.status === 412:
      return new ORPCError("CONFLICT", { message: `The SAP document changed since it was read: ${message}` });
    case e.status === 400:
      return new ORPCError("BAD_REQUEST", { message });
    default:
      return new ORPCError("BAD_GATEWAY", { message });
  }
}

/** Wrap a live-SAP hop so handlers stay one-liners. */
export async function viaB1<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toOrpcError(e);
  }
}

/** The production QueryRunner: turns a model's structured query into transport calls.
 *  `$select` is derived here from the source's declared columns — the model never stores one. */
export function runnerFor(conn: Connector): QueryRunner {
  return (target, query, columns, opts) =>
    viaB1(async () => {
      const t = transportFor(conn, target);
      const base = {
        filter: query.filter,
        orderby: query.orderby,
        ...(columns.length ? { select: columns } : {}),
      };

      if (opts?.maxPages && opts.maxPages > 1) {
        // Multi-page read (history sync). No $top: the bound is the page cap, stated by the caller.
        const { rows, truncated } = await readPages(
          t, query.entitySet, { ...base, maxPageSize: DEFAULT_PAGE }, { maxPages: opts.maxPages },
        );
        return { rows, truncated };
      }

      // The caller may ask for less than a page (the masterdata editor's preview reads five rows);
      // DEFAULT_PAGE stays the ceiling, so `size` can only ever shrink the read.
      const size = Math.min(opts?.top ?? DEFAULT_PAGE, DEFAULT_PAGE);
      // Page size is `Prefer: odata.maxpagesize`, not `$top`: `$top` bounds the whole result set,
      // so B1 stops emitting `@odata.nextLink` once it is exhausted and the value help would page
      // exactly once. `$skip` stays the cursor here — see the note in CLAUDE.md; the entity list
      // uses the nextLink itself, but a value help's cursor must stay a plain offset.
      const res = await t.readEntitySet(query.entitySet, { ...base, maxPageSize: size, skip: opts?.skip });
      const rows = rowsOrThrow(res.data, `Lookup ${target} ${query.entitySet}`);
      // @odata.nextLink is B1's own "there is more", so paging no longer depends on the page it
      // returned matching the $top we asked for. The cursor stays a plain $skip offset.
      return { rows, ...(nextLinkOf(res.data) ? { nextSkip: (opts?.skip ?? 0) + rows.length } : {}) };
    });
}
