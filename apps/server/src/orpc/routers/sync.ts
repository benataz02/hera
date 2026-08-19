import { z } from "zod";
import { and, eq, ne, sql } from "drizzle-orm";
import { db, agentRequest, tenantIntegration } from "@hera/db";
import { outboxChannel, requestChannel, waitForNotify } from "@hera/db/listener";
import { agentProcedure } from "../base.ts";
import { completeWriteOrigin } from "../../config-quote.ts";
import type { WritePayload } from "../../writes.ts";

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

const WriteCapabilityZ = z.object({ entity: z.string().min(1), dedupField: z.string().min(1) });

export const syncRouter = {
  // Agent reports create prerequisites (entity + dedup UDF) after EDMX validation.
  heartbeat: agentProcedure
    .input(z.object({ capabilities: z.array(WriteCapabilityZ) }))
    .handler(async ({ input, context }) => {
      const now = new Date();
      await db
        .update(tenantIntegration)
        .set({
          writeCapabilities: input.capabilities,
          writeCapabilitiesCheckedAt: now,
          lastSeenAt: now,
        })
        .where(eq(tenantIntegration.tenantId, context.tenantId));
      return { ok: true };
    }),

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

  // Durable write success. Attempt-fenced: a stale agent callback cannot finish a newer lease.
  // Config-document origins complete project/run side effects in the same transaction.
  ack: agentProcedure
    .input(
      z.object({
        id: z.string(),
        attempt: z.number().int().positive(),
        result: z.unknown().optional(),
        docEntry: z.string().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const updated = await db.transaction(async (tx) => {
        const rows = await tx
          .update(agentRequest)
          .set({
            status: "done",
            result: input.result ?? null,
            docEntry: input.docEntry ?? null,
            lastError: null,
            leaseUntil: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(agentRequest.id, input.id),
              eq(agentRequest.tenantId, context.tenantId),
              eq(agentRequest.status, "in_flight"),
              eq(agentRequest.attempts, input.attempt),
            ),
          )
          .returning({
            id: agentRequest.id,
            kind: agentRequest.kind,
            payload: agentRequest.payload,
          });
        const row = rows[0];
        if (!row) return null;
        if (row.kind === "write") {
          await completeWriteOrigin(
            tx,
            context.tenantId,
            row.id,
            row.payload as unknown as WritePayload,
            { result: input.result, docEntry: input.docEntry },
          );
        }
        return row;
      });
      if (updated) await db.execute(sql`select pg_notify(${requestChannel(input.id)}, '')`);
      return { ok: true };
    }),

  // transient -> hold with a backoff lease (redelivered when it expires).
  // permanent -> dead-letter for a human. Only ever 'permanent' on confirmed rejection.
  // Attempt-fenced like ack — stale nacks cannot touch a newer lease.
  nack: agentProcedure
    .input(
      z.object({
        id: z.string(),
        attempt: z.number().int().positive(),
        kind: z.enum(["transient", "permanent"]),
        error: z.string().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const fence = and(
        eq(agentRequest.id, input.id),
        eq(agentRequest.tenantId, context.tenantId),
        eq(agentRequest.status, "in_flight"),
        eq(agentRequest.attempts, input.attempt),
      );
      if (input.kind === "permanent") {
        const updated = await db
          .update(agentRequest)
          .set({
            status: "failed",
            lastError: input.error ?? null,
            leaseUntil: null,
            updatedAt: new Date(),
          })
          .where(fence)
          .returning({ id: agentRequest.id });
        if (updated.length) await db.execute(sql`select pg_notify(${requestChannel(input.id)}, '')`);
      } else {
        await db
          .update(agentRequest)
          .set({
            status: "in_flight",
            lastError: input.error ?? null,
            leaseUntil: new Date(Date.now() + TRANSIENT_BACKOFF_MS),
            updatedAt: new Date(),
          })
          .where(fence);
      }
      return { ok: true };
    }),

  // Request/reply kinds only (metadata|list|object-get|…). Never completes durable `write` rows.
  fulfill: agentProcedure
    .input(z.object({ id: z.string(), result: z.unknown() }))
    .handler(async ({ input, context }) => {
      const updated = await db
        .update(agentRequest)
        .set({ status: "done", result: input.result ?? null, leaseUntil: null, updatedAt: new Date() })
        .where(
          and(
            eq(agentRequest.id, input.id),
            eq(agentRequest.tenantId, context.tenantId),
            ne(agentRequest.kind, "write"),
          ),
        )
        .returning({ id: agentRequest.id });
      if (updated.length) await db.execute(sql`select pg_notify(${requestChannel(input.id)}, '')`);
      return { ok: true };
    }),

  fail: agentProcedure
    .input(z.object({ id: z.string(), error: z.string() }))
    .handler(async ({ input, context }) => {
      const updated = await db
        .update(agentRequest)
        .set({ status: "failed", lastError: input.error, leaseUntil: null, updatedAt: new Date() })
        .where(
          and(
            eq(agentRequest.id, input.id),
            eq(agentRequest.tenantId, context.tenantId),
            ne(agentRequest.kind, "write"),
          ),
        )
        .returning({ id: agentRequest.id });
      if (updated.length) await db.execute(sql`select pg_notify(${requestChannel(input.id)}, '')`);
      return { ok: true };
    }),
};
