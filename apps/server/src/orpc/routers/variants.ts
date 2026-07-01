import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, eq, ne, or } from "drizzle-orm";
import { db, uiVariant, user, ListVariantDefZ, ObjectVariantDefZ, WidthsZ, type ListVariantDef } from "@hera/db";
import { userProcedure } from "../base.ts";

// Saved SAP-Fiori "views" for entity pages. Per-user, plus admin-published `shared` (public) views.
// SaveZ validates the definition's SHAPE per page at save time; field-name EXISTENCE against the
// live B1 schema is still only checked downstream, by entities.list, since that's the only place
// that knows the current schema.

const PageZ = z.enum(["list", "object"]);

const base = {
  id: z.uuid().optional(),
  entity: z.string(),
  name: z.string().min(1),
  shared: z.boolean().default(false),
  isDefault: z.boolean().default(false),
  applyAutomatically: z.boolean().default(true),
};
const SaveZ = z.discriminatedUnion("page", [
  z.object({ page: z.literal("list"), definition: ListVariantDefZ, ...base }),
  z.object({ page: z.literal("object"), definition: ObjectVariantDefZ, ...base }),
]);

export const variantsRouter = {
  // A user's own views plus every shared view for this (page, entity). `isAdmin` lets the client
  // decide which views are read-only (shared views are admin-managed).
  list: userProcedure
    .input(z.object({ page: PageZ, entity: z.string() }))
    .handler(async ({ input, context }) => {
      const isAdmin = context.role === "admin" || context.role === "owner";
      const rows = await db
        .select({
          id: uiVariant.id,
          name: uiVariant.name,
          shared: uiVariant.shared,
          isDefault: uiVariant.isDefault,
          isStandard: uiVariant.isStandard,
          applyAutomatically: uiVariant.applyAutomatically,
          definition: uiVariant.definition,
          userId: uiVariant.userId,
          author: user.name,
        })
        .from(uiVariant)
        .innerJoin(user, eq(user.id, uiVariant.userId))
        .where(
          and(
            eq(uiVariant.tenantId, context.tenantId),
            eq(uiVariant.page, input.page),
            eq(uiVariant.entity, input.entity),
            or(eq(uiVariant.userId, context.userId), eq(uiVariant.shared, true)),
          ),
        );
      const variants = rows.map((r) => ({
        ...r,
        // Owns a personal view, or is an admin managing any (incl. shared).
        canManage: (r.userId === context.userId && !r.shared) || isAdmin,
      }));
      return { variants, isAdmin };
    }),

  // Upsert a view. Publishing/editing a shared view is admin-only. Setting a view as default clears
  // the previous default within the same owner scope (personal-per-user, or shared-tenant-wide).
  save: userProcedure.input(SaveZ).handler(async ({ input, context }) => {
    const isAdmin = context.role === "admin" || context.role === "owner";
    if (input.shared && !isAdmin) throw new ORPCError("FORBIDDEN", { message: "Only admins can publish shared views" });

    return db.transaction(async (tx) => {
      let id = input.id;
      const fields = {
        name: input.name,
        definition: input.definition,
        shared: input.shared,
        isDefault: input.isDefault,
        applyAutomatically: input.applyAutomatically,
        updatedAt: new Date(),
      };
      if (id) {
        const [row] = await tx
          .select({ userId: uiVariant.userId, shared: uiVariant.shared })
          .from(uiVariant)
          .where(and(eq(uiVariant.id, id), eq(uiVariant.tenantId, context.tenantId)))
          .limit(1);
        if (!row) throw new ORPCError("NOT_FOUND");
        const owns = row.userId === context.userId && !row.shared;
        if (!owns && !isAdmin) throw new ORPCError("FORBIDDEN", { message: "Not allowed to edit this view" });
        await tx.update(uiVariant).set(fields).where(eq(uiVariant.id, id));
      } else {
        const [ins] = await tx
          .insert(uiVariant)
          .values({ tenantId: context.tenantId, userId: context.userId, page: input.page, entity: input.entity, ...fields })
          .returning({ id: uiVariant.id });
        id = ins!.id;
      }
      if (input.isDefault) {
        const scope = and(
          eq(uiVariant.tenantId, context.tenantId),
          eq(uiVariant.page, input.page),
          eq(uiVariant.entity, input.entity),
          ne(uiVariant.id, id),
          input.shared ? eq(uiVariant.shared, true) : and(eq(uiVariant.userId, context.userId), eq(uiVariant.shared, false)),
        );
        await tx.update(uiVariant).set({ isDefault: false }).where(scope);
      }
      return { id };
    });
  }),

  // Delete a view: your own personal one, or any (incl. shared) if admin.
  remove: userProcedure.input(z.object({ id: z.string().uuid() })).handler(async ({ input, context }) => {
    const isAdmin = context.role === "admin" || context.role === "owner";
    const [row] = await db
      .select({ userId: uiVariant.userId, shared: uiVariant.shared })
      .from(uiVariant)
      .where(and(eq(uiVariant.id, input.id), eq(uiVariant.tenantId, context.tenantId)))
      .limit(1);
    if (!row) throw new ORPCError("NOT_FOUND");
    const owns = row.userId === context.userId && !row.shared;
    if (!owns && !isAdmin) throw new ORPCError("FORBIDDEN", { message: "Not allowed to delete this view" });
    await db.delete(uiVariant).where(eq(uiVariant.id, input.id));
    return { ok: true };
  }),

  // Narrow write path for column-resize drag: reusing `save` would force choosing between
  // blocking non-admins entirely or letting them overwrite a whole shared view.
  setWidths: userProcedure
    .input(z.object({ id: z.uuid(), widths: WidthsZ }))
    .handler(async ({ input, context }) => {
      const [row] = await db
        .select({ definition: uiVariant.definition, userId: uiVariant.userId, shared: uiVariant.shared })
        .from(uiVariant)
        .where(and(eq(uiVariant.id, input.id), eq(uiVariant.tenantId, context.tenantId)))
        .limit(1);
      if (!row) throw new ORPCError("NOT_FOUND");
      // Low-stakes display state: anyone who can SEE the view (own or shared-in-tenant) may set widths.
      if (!(row.userId === context.userId || row.shared)) throw new ORPCError("FORBIDDEN");
      const def = { ...(row.definition as ListVariantDef), widths: input.widths };
      await db.update(uiVariant).set({ definition: def, updatedAt: new Date() }).where(eq(uiVariant.id, input.id));
      return { ok: true };
    }),
};

// Preseed the shared "Standard" view for both pages of an entity, idempotent via isStandard —
// called once when an admin enables the entity, and from scripts/seed-standard.ts as a backfill.
export async function ensureStandardVariants(tenantId: string, userId: string, entity: string) {
  for (const page of ["list", "object"] as const) {
    const [hit] = await db
      .select({ id: uiVariant.id })
      .from(uiVariant)
      .where(
        and(
          eq(uiVariant.tenantId, tenantId),
          eq(uiVariant.page, page),
          eq(uiVariant.entity, entity),
          eq(uiVariant.isStandard, true),
        ),
      )
      .limit(1);
    if (hit) continue;
    await db.insert(uiVariant).values({
      tenantId,
      userId,
      page,
      entity,
      name: "Standard",
      isStandard: true,
      shared: true,
      isDefault: true,
      applyAutomatically: true,
      definition:
        page === "list"
          ? { select: [], filter: [], orderby: [], filterBar: [] }
          : { fields: [], sections: [] },
    });
  }
}
