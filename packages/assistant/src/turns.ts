import { createHash } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Entries } from "@hera/config-engine";
import {
  assistantConversation, assistantMessage, assistantToolExecution, assistantTurn,
  type MessageContent, type Provider,
} from "./schema.ts";

// The durable heart of the turn loop. Every write here is fenced on `leaseToken` matching
// the turn's CURRENT lease so a stale/lost-lease owner can never silently overwrite a newer
// owner's work — see claimTurn's Postgres note and runToolOperation's reclaim logic below.

export type Db = NodePgDatabase<Record<string, unknown>>;
export const LEASE_MS = 30_000;
export const LEASE_RENEW_MS = 10_000;
const leaseExpiry = () => new Date(Date.now() + LEASE_MS);

export type TurnRow = typeof assistantTurn.$inferSelect;

export type ClaimParams = {
  turnId: string;
  conversationId: string;
  userId: string;
  provider: Provider;
  model: string;
  projectVersion: Date;
  entries: Entries;
  batches: number[];
  userMessage: string;
  attachment?: { name: string; mime: string; sha256: string };
};

export type ClaimResult =
  | { kind: "new" | "resume" | "replay"; leaseToken: string; turn: TurnRow }
  | { kind: "rejected"; code: "TURN_IN_PROGRESS" | "TURN_IDENTITY_MISMATCH" };

// Unique-violation code lives on the immediate error in some drivers, on `.cause` in others
// (node-postgres errors get wrapped as they cross the pool/transaction boundary) — walk the
// cause chain rather than trusting either shape alone.
function isUniqueViolation(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur != null; i++) {
    if (typeof cur === "object" && (cur as { code?: unknown }).code === "23505") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

export async function claimTurn(db: Db, p: ClaimParams): Promise<ClaimResult> {
  try {
    return await db.transaction(async (tx) => {
      // 1. Expire dead owners that would block the partial-unique indexes.
      await tx.update(assistantTurn).set({ status: "partial", leaseToken: null })
        .where(and(eq(assistantTurn.status, "running"), lt(assistantTurn.leaseExpiresAt, new Date()),
          sql`(${assistantTurn.conversationId} = ${p.conversationId} or ${assistantTurn.userId} = ${p.userId})`));

      const [existing] = await tx.select().from(assistantTurn).where(eq(assistantTurn.id, p.turnId)).limit(1);
      const leaseToken = crypto.randomUUID();
      if (existing) {
        // Immutable identity check: conversation, user, message, provider, attachment hash.
        if (existing.conversationId !== p.conversationId || existing.userId !== p.userId
          || existing.userMessage !== p.userMessage || existing.provider !== p.provider
          || (existing.attachmentSha256 ?? null) !== (p.attachment?.sha256 ?? null))
          return { kind: "rejected" as const, code: "TURN_IDENTITY_MISMATCH" as const };
        if (existing.status === "running" && existing.leaseExpiresAt && existing.leaseExpiresAt > new Date())
          return { kind: "rejected" as const, code: "TURN_IN_PROGRESS" as const };
        const [turn] = await tx.update(assistantTurn)
          .set({ leaseToken, leaseExpiresAt: leaseExpiry(), updatedAt: new Date(),
            status: existing.status === "complete" ? "complete" : "running" })
          .where(eq(assistantTurn.id, p.turnId)).returning();
        return { kind: existing.status === "complete" ? "replay" as const : "resume" as const, leaseToken, turn: turn! };
      }
      // New turn. STATE_CHANGED is checked by the caller against the live project BEFORE claim;
      // here we only record the version the turn started from.
      const [turn] = await tx.insert(assistantTurn).values({
        id: p.turnId, conversationId: p.conversationId, userId: p.userId,
        provider: p.provider, model: p.model,
        initialProjectVersion: p.projectVersion, latestProjectVersion: p.projectVersion,
        initialEntries: p.entries, initialBatches: p.batches,
        workingEntries: p.entries, workingBatches: p.batches,
        userMessage: p.userMessage, leaseToken, leaseExpiresAt: leaseExpiry(),
        attachmentName: p.attachment?.name, attachmentMime: p.attachment?.mime, attachmentSha256: p.attachment?.sha256,
      }).returning();
      await tx.insert(assistantMessage).values({
        conversationId: p.conversationId, turnId: p.turnId, role: "user", createdByUserId: p.userId,
        content: { ui: { text: p.userMessage, ...(p.attachment ? { fileName: p.attachment.name } : {}) }, model: [] },
      });
      return { kind: "new" as const, leaseToken, turn: turn! };
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { kind: "rejected", code: "TURN_IN_PROGRESS" };
    throw e;
  }
}

/** Fenced UPDATE of `leaseExpiresAt`. False = lease already lost (someone else claimed the turn). */
export async function renewLease(db: Db, turnId: string, leaseToken: string): Promise<boolean> {
  const updated = await db.update(assistantTurn)
    .set({ leaseExpiresAt: leaseExpiry(), updatedAt: new Date() })
    .where(and(eq(assistantTurn.id, turnId), eq(assistantTurn.leaseToken, leaseToken)))
    .returning({ id: assistantTurn.id });
  return updated.length > 0;
}

/** Fenced `nextSeq += n`; returns the FIRST allocated seq (the old value), so the caller can
 *  hand out `[first, first+n)` to itself. Throws when the lease is gone — there is no sane
 *  "seq" to return to a caller that no longer owns the turn. */
export async function allocSeq(db: Db, turnId: string, leaseToken: string, n = 1): Promise<number> {
  const [row] = await db.update(assistantTurn)
    .set({ nextSeq: sql`${assistantTurn.nextSeq} + ${n}`, updatedAt: new Date() })
    .where(and(eq(assistantTurn.id, turnId), eq(assistantTurn.leaseToken, leaseToken)))
    .returning({ nextSeq: assistantTurn.nextSeq });
  if (!row) throw new Error("LEASE_LOST");
  return row.nextSeq - n;
}

export type CounterDelta = Partial<{
  iterationCount: number; emittedToolCallCount: number; executedToolCallCount: number;
  providerCallCount: number; inputTokens: number; outputTokens: number;
}>;
export type TurnCounters = {
  iterationCount: number; emittedToolCallCount: number; executedToolCallCount: number;
  providerCallCount: number; inputTokens: number; outputTokens: number;
};

/** Fenced atomic increments (only columns present in `delta` are touched); returns the new
 *  values so the budget accountant can check limits off the authoritative row, not a local
 *  guess. Throws LEASE_LOST rather than returning a fake zeroed counters object. */
export async function bumpCounters(db: Db, turnId: string, leaseToken: string, delta: CounterDelta): Promise<TurnCounters> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (delta.iterationCount) set.iterationCount = sql`${assistantTurn.iterationCount} + ${delta.iterationCount}`;
  if (delta.emittedToolCallCount) set.emittedToolCallCount = sql`${assistantTurn.emittedToolCallCount} + ${delta.emittedToolCallCount}`;
  if (delta.executedToolCallCount) set.executedToolCallCount = sql`${assistantTurn.executedToolCallCount} + ${delta.executedToolCallCount}`;
  if (delta.providerCallCount) set.providerCallCount = sql`${assistantTurn.providerCallCount} + ${delta.providerCallCount}`;
  if (delta.inputTokens) set.inputTokens = sql`${assistantTurn.inputTokens} + ${delta.inputTokens}`;
  if (delta.outputTokens) set.outputTokens = sql`${assistantTurn.outputTokens} + ${delta.outputTokens}`;

  const [row] = await db.update(assistantTurn).set(set)
    .where(and(eq(assistantTurn.id, turnId), eq(assistantTurn.leaseToken, leaseToken)))
    .returning({
      iterationCount: assistantTurn.iterationCount, emittedToolCallCount: assistantTurn.emittedToolCallCount,
      executedToolCallCount: assistantTurn.executedToolCallCount, providerCallCount: assistantTurn.providerCallCount,
      inputTokens: assistantTurn.inputTokens, outputTokens: assistantTurn.outputTokens,
    });
  if (!row) throw new Error("LEASE_LOST");
  return row;
}

/** Fenced UPDATE of the working entries/batches/revision, plus the optional side effects of a
 *  successful tool call (`latestProjectVersion` after a mutating executor observes fresher B1
 *  state, `calculatedRunId` once `calculate` succeeds and freezes further `setValues`). */
export async function updateWorking(
  db: Db, turnId: string, leaseToken: string,
  working: { entries: Entries; batches: number[]; revision: number; latestProjectVersion?: Date; calculatedRunId?: string },
): Promise<boolean> {
  const set: Record<string, unknown> = {
    workingEntries: working.entries, workingBatches: working.batches, workingRevision: working.revision,
    updatedAt: new Date(),
  };
  if (working.latestProjectVersion !== undefined) set.latestProjectVersion = working.latestProjectVersion;
  if (working.calculatedRunId !== undefined) set.calculatedRunId = working.calculatedRunId;

  const updated = await db.update(assistantTurn).set(set)
    .where(and(eq(assistantTurn.id, turnId), eq(assistantTurn.leaseToken, leaseToken)))
    .returning({ id: assistantTurn.id });
  return updated.length > 0;
}

// Canonical (sorted-key) JSON stringify, so semantically-identical input objects with
// different key order hash identically. Only used for the stored `inputHash` audit column —
// `operationKey` (computed by the caller) is the actual idempotency key.
function canonicalStringify(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(",")}}`;
}
const inputHash = (input: unknown) => createHash("sha256").update(canonicalStringify(input)).digest("hex");

export type RunToolOperationParams = {
  turnId: string;
  leaseToken: string;
  toolCallId: string;
  name: string;
  operationKey: string;
  input: unknown;
  exec: (tx: Db) => Promise<{ result: unknown; runId?: string; affectedProjectVersion?: Date; eventSeq?: number }>;
};

type ClaimStep =
  | { kind: "replay"; result: unknown; eventSeq?: number }
  | { kind: "error"; errorCode: string }
  | { kind: "run"; id: string };

// `exec()` can run for real time (an executor may call out to SAP B1). Step 2 below is a
// separate, longer-lived transaction than step 1 — during that window the TURN's lease can be
// reclaimed by a brand-new owner even though this operation row's own `leaseToken` (copied from
// the turn's lease at claim/reclaim time) never changes locally for a zombie caller. So every
// write in step 2 re-checks the turn's CURRENT lease via this subquery, not just the operation
// row's stale copy of it.
const turnLeaseLive = (turnId: string, leaseToken: string) =>
  sql`exists (select 1 from ${assistantTurn} where ${assistantTurn.id} = ${turnId} and ${assistantTurn.leaseToken} = ${leaseToken})`;

/** The `(turnId, operationKey)` idempotency boundary for tool calls.
 *
 *  Two transactions, deliberately NOT one:
 *  1. A short transaction claims (or replays/rejects) the `assistant_tool_execution` row and
 *     COMMITS it as `running` immediately. This is what makes a concurrent duplicate call see
 *     "running" and the reclaim/attempts bookkeeping durable even if `exec` itself crashes the
 *     process — if insert-running and exec were the same transaction, a failed exec would roll
 *     back the very row that records the failure, and reclaim could loop forever.
 *  2. A second transaction runs `exec` and its completion UPDATE together, so the tool's own
 *     domain write (e.g. persisting a calculate run) and the tool_execution completion row are
 *     atomic — a reclaim can trust "no complete row" to mean "no domain write happened either".
 *  If step 2 throws, a fenced follow-up UPDATE marks the row `error` (best-effort; if even that
 *  is lost to a crash, the row is picked up by the next call's expired-lease/attempts check). */
export async function runToolOperation(db: Db, p: RunToolOperationParams): Promise<{ replayed: boolean; result: unknown; eventSeq?: number }> {
  const claim: ClaimStep = await db.transaction(async (tx) => {
    const [turn] = await tx.select({ leaseToken: assistantTurn.leaseToken })
      .from(assistantTurn).where(eq(assistantTurn.id, p.turnId)).limit(1);
    if (!turn || turn.leaseToken !== p.leaseToken) throw new Error("LEASE_LOST");

    const [existing] = await tx.select().from(assistantToolExecution)
      .where(and(eq(assistantToolExecution.turnId, p.turnId), eq(assistantToolExecution.operationKey, p.operationKey)))
      .limit(1);

    if (existing?.status === "complete") {
      const replayToolCallIds = existing.replayToolCallIds.includes(p.toolCallId)
        ? existing.replayToolCallIds : [...existing.replayToolCallIds, p.toolCallId];
      await tx.update(assistantToolExecution)
        .set({ replayToolCallIds, replayCount: existing.replayCount + 1 })
        .where(and(eq(assistantToolExecution.id, existing.id), turnLeaseLive(p.turnId, p.leaseToken)));
      return { kind: "replay", result: existing.result, eventSeq: existing.eventSeq ?? undefined };
    }

    if (existing?.status === "error") {
      // Already given up on a prior attempt — surface the same terminal error, don't retry.
      return { kind: "error", errorCode: existing.errorCode ?? "MAX_ATTEMPTS" };
    }

    if (existing?.status === "running") {
      if (existing.leaseToken === p.leaseToken) throw new Error("OPERATION_IN_FLIGHT");
      // A different (and, since turn.leaseToken === p.leaseToken above, necessarily dead)
      // owner started this and never finished it.
      if (existing.attempts >= 2) {
        await tx.update(assistantToolExecution)
          .set({ status: "error", errorCode: existing.errorCode ?? "MAX_ATTEMPTS", completedAt: new Date() })
          .where(and(eq(assistantToolExecution.id, existing.id), turnLeaseLive(p.turnId, p.leaseToken)));
        return { kind: "error", errorCode: existing.errorCode ?? "MAX_ATTEMPTS" };
      }
      const [row] = await tx.update(assistantToolExecution)
        .set({ leaseToken: p.leaseToken, attempts: existing.attempts + 1 })
        .where(and(eq(assistantToolExecution.id, existing.id), turnLeaseLive(p.turnId, p.leaseToken)))
        .returning({ id: assistantToolExecution.id });
      if (!row) throw new Error("LEASE_LOST");
      return { kind: "run", id: row.id };
    }

    const [row] = await tx.insert(assistantToolExecution).values({
      turnId: p.turnId, toolCallId: p.toolCallId, operationKey: p.operationKey, name: p.name,
      leaseToken: p.leaseToken, status: "running", input: p.input as object, inputHash: inputHash(p.input),
    }).returning({ id: assistantToolExecution.id });
    return { kind: "run", id: row!.id };
  });

  if (claim.kind === "replay") return { replayed: true, result: claim.result, eventSeq: claim.eventSeq };
  if (claim.kind === "error") throw new Error(claim.errorCode);

  const startedAt = Date.now();
  try {
    return await db.transaction(async (tx) => {
      const out = await p.exec(tx);
      const [row] = await tx.update(assistantToolExecution)
        .set({
          status: "complete", result: out.result as object, runId: out.runId ?? null,
          affectedProjectVersion: out.affectedProjectVersion ?? null, eventSeq: out.eventSeq ?? null,
          durationMs: Date.now() - startedAt, completedAt: new Date(),
        })
        .where(and(
          eq(assistantToolExecution.id, claim.id), eq(assistantToolExecution.leaseToken, p.leaseToken),
          turnLeaseLive(p.turnId, p.leaseToken),
        ))
        .returning({ id: assistantToolExecution.id });
      if (!row) throw new Error("LEASE_LOST");
      return { replayed: false, result: out.result, eventSeq: out.eventSeq };
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "EXEC_FAILED";
    if (message !== "LEASE_LOST") {
      // Best-effort: fenced (both the operation row's own lease AND the turn's current lease)
      // so a stale owner's failure can't stomp a newer owner's row; if this itself is lost to a
      // crash, the next caller's expired-lease/attempts check recovers it.
      await db.update(assistantToolExecution)
        .set({ status: "error", errorCode: message, completedAt: new Date() })
        .where(and(
          eq(assistantToolExecution.id, claim.id), eq(assistantToolExecution.leaseToken, p.leaseToken),
          turnLeaseLive(p.turnId, p.leaseToken),
        ));
    }
    throw e;
  }
}

export type FinalizeTurnParams = {
  turnId: string;
  leaseToken: string;
  status: "partial" | "complete" | "failed";
  errorCode?: string;
  assistantUi?: MessageContent["ui"];
  assistantModel?: unknown[];
  conversationId: string;
  suggestions?: string[];
};

/** Fenced terminal-status UPDATE; on success (lease still held) upserts the assistant message
 *  row and bumps the conversation's `updatedAt`, all in one transaction. False (never throws)
 *  when the lease was already lost — a stale owner must silently no-op, not overwrite a newer
 *  owner's in-progress or already-finalized turn. */
export async function finalizeTurn(db: Db, p: FinalizeTurnParams): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx.update(assistantTurn)
      .set({ status: p.status, errorCode: p.errorCode ?? null, completedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(assistantTurn.id, p.turnId), eq(assistantTurn.leaseToken, p.leaseToken)))
      .returning({ id: assistantTurn.id });
    if (!updated.length) return false;

    if (p.assistantUi) {
      const content: MessageContent = {
        ui: { ...p.assistantUi, ...(p.suggestions ? { suggestions: p.suggestions } : {}) },
        model: p.assistantModel ?? [],
      };
      await tx.insert(assistantMessage).values({
        conversationId: p.conversationId, turnId: p.turnId, role: "assistant", createdByUserId: null, content,
      }).onConflictDoUpdate({ target: [assistantMessage.turnId, assistantMessage.role], set: { content } });
    }

    await tx.update(assistantConversation).set({ updatedAt: new Date() }).where(eq(assistantConversation.id, p.conversationId));
    return true;
  });
}
