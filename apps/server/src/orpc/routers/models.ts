import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, configModel } from "@hera/db";
import { lintModel, type Model } from "@hera/config-engine";
import { adminProcedure, userProcedure } from "../base.ts";

// Zod mirror of the engine Model tree — the trust boundary for a stored model (its expressions are
// later re-evaluated server-side at quote time). Kept in step with packages/config-engine/types.ts.
export const ValueZ = z.union([z.string(), z.number(), z.boolean()]);

const DataSourceZ = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("normal"), values: z.array(ValueZ).optional() }),
  z.object({ kind: z.literal("masterdata"), masterdataId: z.string() }),
]);

const ItemValueZ = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("formula"), expr: z.string() }),
  z.object({ kind: z.literal("manual") }),
]);

const FormItemZ = z.object({
  id: z.string(),
  name: z.string(),
  label: z.string(),
  visibility: z.string().optional(),
  input: z.object({
    mandatory: z.boolean(),
    dataSource: DataSourceZ,
    inputType: z.enum(["input", "radio", "checkbox", "multicombo"]),
    value: ItemValueZ,
  }),
  output: z.unknown().optional(),
  price: z.string().optional(),
});

const FormGroupZ = z.object({
  id: z.string(),
  label: z.string(),
  visibility: z.string().optional(),
  items: z.array(FormItemZ),
});

const FormSectionZ = z.object({
  id: z.string(),
  label: z.string(),
  visibility: z.string().optional(),
  groups: z.array(FormGroupZ),
});

const ModelZ = z.object({
  name: z.string().min(1),
  family: z.string().default(""),
  sections: z.array(FormSectionZ),
  // label/guided are builder sugar; the trust boundary runs only expr+vars (expr is authoritative), so
  // guided is z.unknown() — validating its sub-shape buys nothing. Without these, Zod strips them on save.
  rules: z
    .array(z.object({ expr: z.string(), vars: z.array(z.string()), label: z.string().optional(), guided: z.unknown().optional() }))
    .default([]),
  formulas: z.array(z.object({ id: z.string(), name: z.string(), expr: z.string() })).default([]),
});

export const modelsRouter = {
  // Summaries for the list page + the runtime model picker (published flag included).
  list: userProcedure.handler(async ({ context }) =>
    db
      .select({ id: configModel.id, name: configModel.name, family: configModel.family, published: configModel.published })
      .from(configModel)
      .where(eq(configModel.tenantId, context.tenantId)),
  ),

  get: userProcedure.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
    const [row] = await db
      .select()
      .from(configModel)
      .where(and(eq(configModel.id, input.id), eq(configModel.tenantId, context.tenantId)))
      .limit(1);
    if (!row) throw new ORPCError("NOT_FOUND");
    return row;
  }),

  // Lint before storing — a model with a bad expression must never reach the runtime/quote path.
  save: adminProcedure
    .input(z.object({ id: z.string().optional(), definition: ModelZ }))
    .handler(async ({ input, context }) => {
      const def = input.definition;
      const errs = lintModel(def as Model);
      if (errs.length) throw new ORPCError("BAD_REQUEST", { message: errs.join("; ") });
      const { tenantId } = context;
      const definition = def as unknown as Record<string, unknown>;
      if (input.id) {
        const [row] = await db
          .update(configModel)
          .set({ name: def.name, family: def.family, definition, updatedAt: new Date() })
          .where(and(eq(configModel.id, input.id), eq(configModel.tenantId, tenantId)))
          .returning({ id: configModel.id });
        if (!row) throw new ORPCError("NOT_FOUND");
        return { id: row.id };
      }
      const [row] = await db
        .insert(configModel)
        .values({ tenantId, name: def.name, family: def.family, definition })
        .returning({ id: configModel.id });
      return { id: row!.id };
    }),

  publish: adminProcedure
    .input(z.object({ id: z.string(), published: z.boolean() }))
    .handler(async ({ input, context }) => {
      const [row] = await db
        .update(configModel)
        .set({ published: input.published, updatedAt: new Date() })
        .where(and(eq(configModel.id, input.id), eq(configModel.tenantId, context.tenantId)))
        .returning({ id: configModel.id });
      if (!row) throw new ORPCError("NOT_FOUND");
      return { ok: true };
    }),

  remove: adminProcedure.input(z.object({ id: z.string() })).handler(async ({ input, context }) => {
    await db.delete(configModel).where(and(eq(configModel.id, input.id), eq(configModel.tenantId, context.tenantId)));
    return { ok: true };
  }),
};
