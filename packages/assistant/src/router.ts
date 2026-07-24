import { ORPCError, eventIterator } from "@orpc/server";
import type { BuilderWithMiddlewares, Context, Schema } from "@orpc/server";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { assistantConversation, assistantMessage, assistantTurn } from "./schema.ts";
import { listProviders } from "./provider.ts";
import { AssistantEventZ } from "./events.ts";
import { runTurn, makeAssistChatInputZ, type AssistantDeps } from "./loop.ts";

// CRUD half of the Chati router (conversation providers/list/get/delete) plus the streaming
// `chat` procedure (Task 13, loop.ts). This package never imports apps/server's `userProcedure`
// directly (packages can't depend on the app that consumes them) — instead `createAssistantRouter`
// is generic over the injected procedure builder, so the server wires its own `userProcedure`
// (context `{ tenantId, userId, ... }`) through at the call site with full type safety, no `any`
// in the public surface.
//
// oRPC findings (orpc skill, checked against the installed @orpc/server types): `eventIterator`
// wraps a zod schema as a streaming `.output()`; a generator handler (`async function* ({ input,
// context, signal }) { ... }`) is a first-class handler shape — no adapter-specific wiring
// needed. `signal` is the real per-request `AbortSignal` (aborts on client disconnect), passed
// straight through to `runTurn`. Event ids for SSE resumption are stamped by `withEventMeta`
// inside `loop.ts`'s `eventFor` helper (`{turnId}:{seq}`), not here — keeps the id right next to
// the seq allocation that produces it.

export type { AssistantDeps };

/** The minimal context every procedure here needs; the server's real userProcedure context
 *  (which also carries `role`) is a subtype and satisfies this structurally. */
type AssistantContext = { tenantId: string; userId: string };

/** Matches the shape of `os`-derived builders (like the server's `userProcedure`) after any
 *  number of `.use()` middleware calls: same input/output/error/meta type parameters as `os`
 *  itself, `TInitialContext` left open (it's whatever the server's Hono adapter provides),
 *  only `TCurrentContext` narrowed to what our procedures actually read. */
type AssistantBase<TInitialContext extends Context, TCurrentContext extends AssistantContext> = BuilderWithMiddlewares<
  TInitialContext, TCurrentContext, Schema<unknown, unknown>, Schema<unknown, unknown>, Record<never, never>, Record<never, never>
>;

// Opaque keyset cursors: base64("iso|id"). Stable under inserts, never split a turn.
const btoaCursor = (at: Date, id: string) => Buffer.from(`${at.toISOString()}|${id}`).toString("base64url");
const atobCursor = (s: string) => {
  const [iso, id] = Buffer.from(s, "base64url").toString().split("|");
  const updatedAt = new Date(iso ?? "");
  if (!id || Number.isNaN(updatedAt.getTime())) throw new ORPCError("BAD_REQUEST", { message: "Bad cursor" });
  return { updatedAt, id };
};

export function createAssistantRouter<TInitialContext extends Context, TCurrentContext extends AssistantContext>(
  base: AssistantBase<TInitialContext, TCurrentContext>,
  deps: AssistantDeps,
) {
  const scoped = async (tenantId: string, projectId: string, conversationId: string) => {
    const [c] = await deps.db.select().from(assistantConversation).where(and(
      eq(assistantConversation.id, conversationId),
      eq(assistantConversation.tenantId, tenantId),
      eq(assistantConversation.projectId, projectId),
    )).limit(1);
    if (!c) throw new ORPCError("NOT_FOUND");
    return c;
  };

  return {
    providers: base.handler(() => listProviders()),

    list: base
      .input(z.strictObject({ projectId: z.uuid(), cursor: z.string().max(200).optional(), limit: z.number().int().min(1).max(50).default(20) }))
      .handler(async ({ input, context }) => {
        const cur = input.cursor ? atobCursor(input.cursor) : null;
        const rows = await deps.db.select({
          id: assistantConversation.id, title: assistantConversation.title,
          provider: assistantConversation.provider, updatedAt: assistantConversation.updatedAt,
        }).from(assistantConversation)
          .where(and(
            eq(assistantConversation.tenantId, context.tenantId),
            eq(assistantConversation.projectId, input.projectId),
            ...(cur ? [sql`(${assistantConversation.updatedAt}, ${assistantConversation.id}) < (${cur.updatedAt}, ${cur.id})`] : []),
          ))
          .orderBy(desc(assistantConversation.updatedAt), desc(assistantConversation.id))
          .limit(input.limit + 1);
        const items = rows.slice(0, input.limit);
        const last = items.at(-1);
        return { items, nextCursor: rows.length > input.limit && last ? btoaCursor(last.updatedAt, last.id) : null };
      }),

    get: base
      .input(z.strictObject({ projectId: z.uuid(), conversationId: z.uuid(), beforeTurn: z.string().max(200).optional(), limit: z.number().int().min(1).max(50).default(20) }))
      .handler(async ({ input, context }) => {
        const c = await scoped(context.tenantId, input.projectId, input.conversationId);
        const cur = input.beforeTurn ? atobCursor(input.beforeTurn) : null;
        const turns = await deps.db.select().from(assistantTurn)
          .where(and(eq(assistantTurn.conversationId, c.id),
            ...(cur ? [sql`(${assistantTurn.startedAt}, ${assistantTurn.id}) < (${cur.updatedAt}, ${cur.id})`] : [])))
          .orderBy(desc(assistantTurn.startedAt), desc(assistantTurn.id))
          .limit(input.limit + 1);
        const page = turns.slice(0, input.limit);
        const msgs = page.length
          ? await deps.db.select().from(assistantMessage)
              .where(inArray(assistantMessage.turnId, page.map((t) => t.id)))
          : [];
        const uiOf = (turnId: string, role: "user" | "assistant") =>
          msgs.find((m) => m.turnId === turnId && m.role === role)?.content.ui ?? null;
        const last = page.at(-1);
        return {
          turns: page.map((t) => ({
            turnId: t.id, status: t.status, startedAt: t.startedAt,
            user: uiOf(t.id, "user"), assistant: uiOf(t.id, "assistant"),
          })).reverse(), // oldest-first within the page for straight rendering
          nextCursor: turns.length > input.limit && last ? btoaCursor(last.startedAt, last.id) : null,
        };
      }),

    delete: base
      .input(z.strictObject({ projectId: z.uuid(), conversationId: z.uuid() }))
      .handler(async ({ input, context }) => {
        const c = await scoped(context.tenantId, input.projectId, input.conversationId);
        const [live] = await deps.db.select({ id: assistantTurn.id }).from(assistantTurn).where(and(
          eq(assistantTurn.conversationId, c.id), eq(assistantTurn.status, "running"),
          gt(assistantTurn.leaseExpiresAt, new Date()),
        )).limit(1);
        if (live) throw new ORPCError("CONFLICT", { message: "TURN_IN_PROGRESS" });
        await deps.db.delete(assistantConversation).where(eq(assistantConversation.id, c.id));
        return { ok: true };
      }),

    chat: base
      .input(makeAssistChatInputZ(deps.fileSchema))
      .output(eventIterator(AssistantEventZ))
      .handler(async function* ({ input, context, signal }) {
        yield* runTurn(deps, context, input, signal ?? new AbortController().signal);
      }),
  };
}
