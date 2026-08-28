import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { db, sapConnection } from "@hera/db";
import { B1Error, RemoteTransport, readPages, rowsOrThrow, type B1Transport, type Connector } from "@hera/b1";
import { decryptSecret } from "./crypto.ts";
import { DEFAULT_PAGE, type QueryRunner } from "./lookups.ts";

export const SAP_UNAVAILABLE = "SAP is not connected.";

export type { Connector };

/** The tenant's on-prem agent, as a pair of transports. One PK select per call — the
 *  transports hold nothing but config, so there is nothing worth caching. */
export async function tenantConnector(tenantId: string): Promise<Connector> {
  const [row] = await db.select().from(sapConnection).where(eq(sapConnection.tenantId, tenantId)).limit(1);
  if (!row) throw new ORPCError("SERVICE_UNAVAILABLE", { message: SAP_UNAVAILABLE });
  const common = {
    agentUrl: row.agentUrl,
    secret: decryptSecret(row.secret),
    accessClientId: row.accessClientId,
    accessClientSecret: row.accessClientSecret,
  };
  return {
    b1: new RemoteTransport({ ...common, target: "b1" }),
    beas: row.beasEnabled ? new RemoteTransport({ ...common, target: "beas" }) : null,
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
      const top = query.top ?? DEFAULT_PAGE;
      const base = {
        filter: query.filter,
        orderby: query.orderby,
        ...(columns.length ? { select: columns } : {}),
      };

      if (opts?.maxPages && opts.maxPages > 1) {
        // Multi-page read (history sync). No $top: the bound is the page cap, stated by the caller.
        const { rows, truncated } = await readPages(
          t, query.entitySet, { ...base, maxPageSize: top }, { maxPages: opts.maxPages },
        );
        return { rows, truncated };
      }

      const res = await t.readEntitySet(query.entitySet, { ...base, top, skip: opts?.skip });
      const rows = rowsOrThrow(res.data, `Lookup ${target} ${query.entitySet}`);
      // A full page means there is probably another. One extra empty read at the end beats
      // paying for $count on every value-help keystroke.
      return { rows, ...(rows.length === top ? { nextSkip: (opts?.skip ?? 0) + rows.length } : {}) };
    });
}
