import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db, quote, agentRequest, configModel } from "@hera/db";
import { validate, evaluate, type Model } from "@hera/config-engine";
import { outboxChannel, quoteChannel, waitForNotify } from "@hera/db/listener";
import { userProcedure } from "../base.ts";

const ValueZ = z.union([z.string(), z.number(), z.boolean()]);

export const quoteRouter = {
  // Write the business row AND its queue row in one tx, then ring the doorbell.
  // Both commit or neither -> the intent to sync can never be lost.
  create: userProcedure
    .input(
      z.object({
        payload: z.record(z.string(), z.unknown()),
        // Optional configurator selection. The server re-validates every chosen configuration
        // against the model (never trusts the browser) and recomputes its BOM/routing/price.
        config: z
          .object({
            modelId: z.string(),
            batches: z.array(z.number()).default([]),
            configurations: z.array(z.object({ assignment: z.record(z.string(), ValueZ) })),
          })
          .optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const { tenantId } = context;

      let payload: Record<string, unknown> = input.payload;
      if (input.config) {
        const [m] = await db
          .select({ definition: configModel.definition })
          .from(configModel)
          .where(and(eq(configModel.id, input.config.modelId), eq(configModel.tenantId, tenantId)))
          .limit(1);
        if (!m) throw new ORPCError("NOT_FOUND", { message: "Configurator model not found" });
        const model = m.definition as unknown as Model;
        const configurations = input.config.configurations.map((c) => {
          const v = validate(model, c.assignment);
          if (!v.ok) throw new ORPCError("BAD_REQUEST", { message: `Invalid configuration: ${v.reason}` });
          return { assignment: c.assignment, ...evaluate(model, c.assignment) };
        });
        payload = {
          ...input.payload,
          config: { modelId: input.config.modelId, batches: input.config.batches, configurations },
        };
      }

      const created = await db.transaction(async (tx) => {
        const [q] = await tx
          .insert(quote)
          .values({ tenantId, status: "syncing", payload })
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
