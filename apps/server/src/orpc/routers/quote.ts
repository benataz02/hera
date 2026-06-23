import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db, quote, agentRequest } from "@hera/db";
import { outboxChannel, quoteChannel, waitForNotify } from "@hera/db/listener";
import { userProcedure } from "../base.ts";

export const quoteRouter = {
  // Write the business row AND its queue row in one tx, then ring the doorbell.
  // Both commit or neither -> the intent to sync can never be lost.
  create: userProcedure
    .input(z.object({ payload: z.record(z.string(), z.unknown()) }))
    .handler(async ({ input, context }) => {
      const { tenantId } = context;
      const created = await db.transaction(async (tx) => {
        const [q] = await tx
          .insert(quote)
          .values({ tenantId, status: "syncing", payload: input.payload })
          .returning();
        await tx.insert(agentRequest).values({
          tenantId,
          kind: "quote",
          payload: { quoteId: q!.id, data: input.payload },
          dedupKey: q!.id, // == external key (U_CpqExtId) the agent stamps into B1
        });
        // pg_notify fires on commit -> a parked agent pull wakes in ms.
        await tx.execute(sql`select pg_notify(${outboxChannel(tenantId)}, '')`);
        return q!;
      });
      return { id: created.id, status: created.status };
    }),

  // Browser long-poll: stream this quote's status until it reaches a terminal state.
  watch: userProcedure
    .input(z.object({ id: z.string() }))
    .handler(async function* ({ input, context, signal }) {
      while (!signal?.aborted) {
        const [q] = await db
          .select({ status: quote.status, docEntry: quote.docEntry })
          .from(quote)
          .where(and(eq(quote.id, input.id), eq(quote.tenantId, context.tenantId)))
          .limit(1);
        if (!q) throw new ORPCError("NOT_FOUND");
        yield { status: q.status, docEntry: q.docEntry };
        if (q.status === "synced" || q.status === "failed") return;
        await waitForNotify(quoteChannel(input.id), 30_000);
      }
    }),
};
