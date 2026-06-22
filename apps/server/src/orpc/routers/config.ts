import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db, configModel } from "@hera/db";
import { lintModel, type Model } from "@hera/config-engine";
import { adminProcedure, userProcedure } from "../base.ts";

// Zod mirror of the engine's Model — structural validation at the trust boundary before persisting.
const ValueZ = z.union([z.string(), z.number(), z.boolean()]);
const IdentZ = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a valid identifier");
const ParamDomainZ = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("static"), values: z.array(ValueZ) }),
  z.object({ kind: z.literal("range"), min: z.number(), max: z.number(), step: z.number().positive() }),
  z.object({ kind: z.literal("datasource"), entity: z.string(), valueField: z.string(), labelField: z.string().optional(), filter: z.string().optional() }),
  z.object({ kind: z.literal("input") }),
]);
const PushTargetZ = z.object({
  entity: z.string(),
  map: z.record(z.string(), z.string()),
  linesField: z.string().optional(),
  header: z.record(z.string(), z.unknown()).optional(),
  keyField: z.string().optional(),
});
const ModelZ = z.object({
  name: z.string().min(1),
  family: z.string().default(""),
  parameters: z.array(z.object({ name: IdentZ, label: z.string(), type: z.enum(["enum", "number", "bool"]), domain: ParamDomainZ })),
  constraints: z.array(z.object({ expr: z.string(), vars: z.array(z.string()) })),
  formulas: z.array(z.object({ name: IdentZ, expr: z.string() })),
  bom: z.array(z.object({ item: z.string(), qtyExpr: z.string(), condition: z.string().optional() })),
  routing: z.array(z.object({ operation: z.string(), timeExpr: z.string(), condition: z.string().optional() })),
  pricing: z.object({ costExpr: z.string(), markupExpr: z.string() }),
  bomTarget: PushTargetZ.optional(),
  routingTarget: PushTargetZ.optional(),
});

export const configRouter = {
  // Summaries for menus (runtime filters to published; the builder shows all).
  list: userProcedure.handler(async ({ context }) =>
    db
      .select({ id: configModel.id, name: configModel.name, family: configModel.family, published: configModel.published, updatedAt: configModel.updatedAt })
      .from(configModel)
      .where(eq(configModel.tenantId, context.tenantId))
      .orderBy(desc(configModel.updatedAt)),
  ),

  // Full definition — the runtime needs it to drive the engine in-browser; the builder to edit.
  get: userProcedure.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
    const [row] = await db
      .select()
      .from(configModel)
      .where(and(eq(configModel.id, input.id), eq(configModel.tenantId, context.tenantId)))
      .limit(1);
    if (!row) throw new ORPCError("NOT_FOUND");
    return row;
  }),

  // Create or update. Lint the model (expressions parse, constraint vars valid) before saving.
  save: adminProcedure
    .input(z.object({ id: z.string().optional(), definition: ModelZ }))
    .handler(async ({ input, context }) => {
      const model = input.definition as Model;
      const errs = lintModel(model);
      if (errs.length) throw new ORPCError("BAD_REQUEST", { message: errs.join("; ") });

      // jsonb column is typed Record<string, unknown>; a Model interface has no index signature.
      const definition = model as unknown as Record<string, unknown>;
      if (input.id) {
        const [row] = await db
          .update(configModel)
          .set({ name: model.name, family: model.family, definition, updatedAt: new Date() })
          .where(and(eq(configModel.id, input.id), eq(configModel.tenantId, context.tenantId)))
          .returning({ id: configModel.id });
        if (!row) throw new ORPCError("NOT_FOUND");
        return { id: row.id };
      }
      const [row] = await db
        .insert(configModel)
        .values({ tenantId: context.tenantId, name: model.name, family: model.family, definition })
        .returning({ id: configModel.id });
      return { id: row!.id };
    }),

  publish: adminProcedure
    .input(z.object({ id: z.string(), published: z.boolean() }))
    .handler(async ({ input, context }) => {
      await db
        .update(configModel)
        .set({ published: input.published, updatedAt: new Date() })
        .where(and(eq(configModel.id, input.id), eq(configModel.tenantId, context.tenantId)));
      return { ok: true };
    }),

  remove: adminProcedure.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
    await db.delete(configModel).where(and(eq(configModel.id, input.id), eq(configModel.tenantId, context.tenantId)));
    return { ok: true };
  }),
};
