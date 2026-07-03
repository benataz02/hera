import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db, agentRequest, tenantIntegration } from "@hera/db";
import { outboxChannel, requestChannel, waitForNotify } from "@hera/db/listener";
import { agentProcedure } from "../base.ts";

const LEASE_SECONDS = 60;
const PULL_HOLD_MS = 25_000;
const TRANSIENT_BACKOFF_MS = 10_000;

export interface ClaimedItem {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  dedupKey: string | null;
  attempts: number;
}

// Atomically claim work: pending rows, plus in_flight rows whose lease expired (redelivery).
// FOR UPDATE SKIP LOCKED makes a second agent a harmless no-op. attempts is incremented HERE,
// at claim time — it drives the 'quote' kind's GET-before-POST. Read kinds ignore attempts.
async function claim(tenantId: string, max: number): Promise<ClaimedItem[]> {
  const res = await db.execute(sql`
    UPDATE agent_request SET
      status = 'in_flight',
      attempts = attempts + 1,
      lease_until = now() + (${LEASE_SECONDS} || ' seconds')::interval,
      updated_at = now()
    WHERE id IN (
      SELECT id FROM agent_request
      WHERE tenant_id = ${tenantId}
        AND status IN ('pending', 'in_flight')
        AND (lease_until IS NULL OR lease_until < now())
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT ${max}
    )
    RETURNING id, kind, payload, dedup_key AS "dedupKey", attempts
  `);
  return res.rows as unknown as ClaimedItem[];
}

export const syncRouter = {
  // Long-poll: claim now; if empty, park on the doorbell up to ~25s, then claim once more.
  // A missed NOTIFY just means we wait out the timeout — slower, never lost.
  pull: agentProcedure
    .input(z.object({ max: z.number().int().min(1).max(100).default(20) }))
    .handler(async ({ input, context }) => {
      const { tenantId } = context;
      await db
        .update(tenantIntegration)
        .set({ lastSeenAt: new Date() })
        .where(eq(tenantIntegration.tenantId, tenantId));

      let items = await claim(tenantId, input.max);
      if (items.length === 0) {
        await waitForNotify(outboxChannel(tenantId), PULL_HOLD_MS);
        items = await claim(tenantId, input.max);
      }
      return { items };
    }),

  // transient -> hold with a backoff lease (redelivered when it expires).
  // permanent -> dead-letter for a human. Only ever 'permanent' on confirmed rejection.
  nack: agentProcedure
    .input(
      z.object({
        id: z.string(),
        kind: z.enum(["transient", "permanent"]),
        error: z.string().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const where = and(eq(agentRequest.id, input.id), eq(agentRequest.tenantId, context.tenantId));
      if (input.kind === "permanent") {
        await db
          .update(agentRequest)
          .set({ status: "failed", lastError: input.error ?? null, leaseUntil: null, updatedAt: new Date() })
          .where(where);
      } else {
        await db
          .update(agentRequest)
          .set({
            status: "in_flight",
            lastError: input.error ?? null,
            leaseUntil: new Date(Date.now() + TRANSIENT_BACKOFF_MS),
            updatedAt: new Date(),
          })
          .where(where);
      }
      return { ok: true };
    }),

  // Request/reply kinds (metadata|list|get|create|update): store the result and wake the
  // browser handler parked on requestChannel(id). No dedup/redelivery — reads are idempotent.
  fulfill: agentProcedure
    .input(z.object({ id: z.string(), result: z.unknown() }))
    .handler(async ({ input, context }) => {
      const updated = await db
        .update(agentRequest)
        .set({ status: "done", result: input.result ?? null, leaseUntil: null, updatedAt: new Date() })
        .where(and(eq(agentRequest.id, input.id), eq(agentRequest.tenantId, context.tenantId)))
        .returning({ id: agentRequest.id });
      if (updated.length) await db.execute(sql`select pg_notify(${requestChannel(input.id)}, '')`);
      return { ok: true };
    }),

  fail: agentProcedure
    .input(z.object({ id: z.string(), error: z.string() }))
    .handler(async ({ input, context }) => {
      await db
        .update(agentRequest)
        .set({ status: "failed", lastError: input.error, leaseUntil: null, updatedAt: new Date() })
        .where(and(eq(agentRequest.id, input.id), eq(agentRequest.tenantId, context.tenantId)));
      await db.execute(sql`select pg_notify(${requestChannel(input.id)}, '')`);
      return { ok: true };
    }),
};
