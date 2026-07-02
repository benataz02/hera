import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db, agentRequest, tenantIntegration, FilterCondZ, type EnabledEntity, type EntitySchema } from "@hera/db";
import { outboxChannel, requestChannel, waitForNotify } from "@hera/db/listener";
import { adminProcedure, userProcedure } from "../base.ts";
import { ensureStandardVariants } from "./variants.ts";

const REQUEST_TIMEOUT_MS = 30_000;
const WAIT_CHUNK_MS = 5_000;
const NAME_RE = /^[A-Za-z0-9_]+$/;
// Agent long-polls (~25s/cycle) and stamps lastSeenAt each pull; 3 missed cycles => offline.
const AGENT_STALE_MS = 90_000;

// Fail fast with a clear reason instead of waiting out the request timeout when no agent is
// configured for this tenant, or the configured one isn't connected. (A timeout can't tell
// "agent is slow" from "no agent will ever answer this tenant".)
export async function assertAgentReady(tenantId: string): Promise<void> {
  const [ti] = await db
    .select({ lastSeenAt: tenantIntegration.lastSeenAt })
    .from(tenantIntegration)
    .where(eq(tenantIntegration.tenantId, tenantId))
    .limit(1);
  if (!ti) {
    throw new ORPCError("SERVICE_UNAVAILABLE", {
      message: "No on-prem agent is configured for this tenant. Provision one (bun run seed:agent <slug>) and start it.",
    });
  }
  const age = ti.lastSeenAt ? Date.now() - ti.lastSeenAt.getTime() : Infinity;
  if (age > AGENT_STALE_MS) {
    throw new ORPCError("SERVICE_UNAVAILABLE", {
      message: ti.lastSeenAt
        ? `The on-prem agent for this tenant is offline (last seen ${Math.round(age / 1000)}s ago). Start it and retry.`
        : "The on-prem agent for this tenant has never connected. Start it and retry.",
    });
  }
}

// Enqueue an on-demand request for the agent, ring its doorbell, then park on this request's
// reply channel until the agent fulfills/fails it (or we give up). Reuses the exact LISTEN/NOTIFY
// machinery the quote backbone uses — just a different table column for the result.
export async function runRequest(tenantId: string, kind: string, payload: Record<string, unknown>): Promise<unknown> {
  const [row] = await db
    .insert(agentRequest)
    .values({ tenantId, kind, payload })
    .returning({ id: agentRequest.id });
  const id = row!.id;
  await db.execute(sql`select pg_notify(${outboxChannel(tenantId)}, '')`);

  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  for (;;) {
    const [r] = await db
      .select({ status: agentRequest.status, result: agentRequest.result, lastError: agentRequest.lastError })
      .from(agentRequest)
      .where(eq(agentRequest.id, id))
      .limit(1);
    if (!r) throw new ORPCError("NOT_FOUND");
    if (r.status === "done") return r.result;
    if (r.status === "failed") throw new ORPCError("BAD_GATEWAY", { message: r.lastError ?? "Agent error" });
    if (Date.now() >= deadline) {
      throw new ORPCError("TIMEOUT", { message: "The on-prem agent did not respond. Is it running?" });
    }
    await waitForNotify(requestChannel(id), Math.min(WAIT_CHUNK_MS, deadline - Date.now()));
  }
}

const PropertyZ = z.object({ name: z.string(), type: z.string(), nullable: z.boolean() });
const EntitySchemaZ = z.object({ name: z.string(), keys: z.array(z.string()), properties: z.array(PropertyZ) });
const EnabledEntityZ = EntitySchemaZ.extend({ editable: z.boolean() });

const OrderByZ = z.object({ field: z.string(), dir: z.enum(["asc", "desc"]) });

async function loadEnabled(tenantId: string, name: string): Promise<EnabledEntity> {
  const [row] = await db
    .select({ enabledEntities: tenantIntegration.enabledEntities })
    .from(tenantIntegration)
    .where(eq(tenantIntegration.tenantId, tenantId))
    .limit(1);
  const e = (row?.enabledEntities ?? []).find((x) => x.name === name);
  if (!e) throw new ORPCError("FORBIDDEN", { message: `Entity '${name}' is not enabled` });
  return e;
}

async function assertEditable(tenantId: string, name: string): Promise<EnabledEntity> {
  const e = await loadEnabled(tenantId, name);
  if (!e.editable) throw new ORPCError("FORBIDDEN", { message: `Entity '${name}' is read-only` });
  return e;
}

// B1 URL key predicate: string/guid keys are quoted — ('CODE'); numeric keys are bare — (123).
function keyQuoted(e: EnabledEntity): boolean {
  const keyProp = e.properties.find((p) => p.name === e.keys[0]);
  return !keyProp || /string|guid/i.test(keyProp.type);
}

export const entitiesRouter = {
  // Any member: open the agent's B1 Service Layer session up front (once, after sign-in) so the
  // first real query skips the /Login round-trip. Fire-and-forget: the agent logs in lazily anyway,
  // so a failed pre-warm (agent offline, B1 down) returns { ok: false } instead of a 5xx that would
  // paint a bogus error in the browser console.
  login: userProcedure.handler(async ({ context }) => {
    try {
      await assertAgentReady(context.tenantId);
      await runRequest(context.tenantId, "login", {});
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }),

  // Admin: ask the agent for the B1 $metadata catalog (entity sets + their field schemas).
  discover: adminProcedure.handler(async ({ context }) => {
    await assertAgentReady(context.tenantId);
    return (await runRequest(context.tenantId, "metadata", {})) as EntitySchema[];
  }),

  // Admin: persist the chosen entities (with editable flag). Client sends schemas from discover.
  setEnabled: adminProcedure
    .input(z.object({ entities: z.array(EnabledEntityZ) }))
    .handler(async ({ input, context }) => {
      for (const e of input.entities) {
        if (!NAME_RE.test(e.name)) throw new ORPCError("BAD_REQUEST", { message: `Bad entity name '${e.name}'` });
      }
      await db
        .update(tenantIntegration)
        .set({ enabledEntities: input.entities })
        .where(eq(tenantIntegration.tenantId, context.tenantId));
      for (const e of input.entities) {
        await ensureStandardVariants(context.tenantId, context.userId, e.name);
      }
      return { ok: true };
    }),

  // Any member: the enabled list drives the side-nav + form schemas. No agent hop.
  getEnabled: userProcedure.handler(async ({ context }) => {
    const [row] = await db
      .select({ enabledEntities: tenantIntegration.enabledEntities })
      .from(tenantIntegration)
      .where(eq(tenantIntegration.tenantId, context.tenantId))
      .limit(1);
    return row?.enabledEntities ?? [];
  }),

  list: userProcedure
    .input(
      z.object({
        entity: z.string(),
        top: z.number().int().min(1).max(1000).default(100),
        skip: z.number().int().min(0).default(0),
        q: z.string().optional(),
        // The saved view's OData call. Field names are validated against the schema below — never
        // trusted raw — and each filter field's Edm type is attached so the agent encodes literals.
        select: z.array(z.string()).optional(),
        filter: z.array(FilterCondZ).optional(),
        orderby: z.array(OrderByZ).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const e = await loadEnabled(context.tenantId, input.entity);
      const propByName = new Map(e.properties.map((p) => [p.name, p]));
      const assertField = (name: string) => {
        if (!propByName.has(name)) throw new ORPCError("BAD_REQUEST", { message: `Unknown field '${name}'` });
      };
      for (const f of input.select ?? []) assertField(f);
      for (const o of input.orderby ?? []) assertField(o.field);
      const filter = (input.filter ?? []).map((c) => {
        assertField(c.field);
        return { ...c, type: propByName.get(c.field)!.type };
      });
      // Global search hits string-typed fields only (contains() is string-only), and only the
      // visible (selected) columns — a search must never match on a field the user can't see. The
      // server derives the field list from the schema (∩ the validated select) so the agent never
      // trusts a client-supplied one. No explicit select = default view (all columns) = all string fields.
      const visible = input.select?.length ? new Set(input.select) : null;
      const fields = input.q
        ? e.properties.filter((p) => /string/i.test(p.type) && (!visible || visible.has(p.name))).map((p) => p.name)
        : [];
      return (await runRequest(context.tenantId, "list", { ...input, fields, filter })) as {
        rows: Record<string, unknown>[];
        count: number | null;
        hasMore: boolean;
      };
    }),

  get: userProcedure
    .input(z.object({ entity: z.string(), key: z.string() }))
    .handler(async ({ input, context }) => {
      const e = await loadEnabled(context.tenantId, input.entity);
      return (await runRequest(context.tenantId, "get", { ...input, keyQuoted: keyQuoted(e) })) as Record<string, unknown>;
    }),

  create: userProcedure
    .input(z.object({ entity: z.string(), data: z.record(z.string(), z.unknown()) }))
    .handler(async ({ input, context }) => {
      await assertEditable(context.tenantId, input.entity);
      return (await runRequest(context.tenantId, "create", input)) as Record<string, unknown>;
    }),

  update: userProcedure
    .input(z.object({ entity: z.string(), key: z.string(), data: z.record(z.string(), z.unknown()) }))
    .handler(async ({ input, context }) => {
      const e = await assertEditable(context.tenantId, input.entity);
      return (await runRequest(context.tenantId, "update", { ...input, keyQuoted: keyQuoted(e) })) as Record<string, unknown>;
    }),
};
