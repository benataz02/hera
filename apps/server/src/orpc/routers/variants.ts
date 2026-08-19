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
  // Names must be unique within personal-per-user or shared-tenant scope (case-insensitive).
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
        updatedAt: new Date(),
      };
      // Soft uniqueness within personal-per-user or shared-tenant scope (case-insensitive).
      {
        const scope = input.shared
          ? and(
              eq(uiVariant.tenantId, context.tenantId),
              eq(uiVariant.page, input.page),
              eq(uiVariant.entity, input.entity),
              eq(uiVariant.shared, true),
            )
          : and(
              eq(uiVariant.tenantId, context.tenantId),
              eq(uiVariant.page, input.page),
              eq(uiVariant.entity, input.entity),
              eq(uiVariant.userId, context.userId),
              eq(uiVariant.shared, false),
            );
        const peers = await tx
          .select({ id: uiVariant.id, name: uiVariant.name })
          .from(uiVariant)
          .where(scope);
        const key = input.name.trim().toLowerCase();
        const clash = peers.find((p) => p.id !== id && p.name.trim().toLowerCase() === key);
        if (clash) {
          throw new ORPCError("CONFLICT", {
            message: input.shared
              ? "A shared view with this name already exists"
              : "A personal view with this name already exists",
          });
        }
      }
      if (id) {
        const [row] = await tx
          .select({ userId: uiVariant.userId, shared: uiVariant.shared, isStandard: uiVariant.isStandard, name: uiVariant.name })
          .from(uiVariant)
          .where(and(eq(uiVariant.id, id), eq(uiVariant.tenantId, context.tenantId)))
          .limit(1);
        if (!row) throw new ORPCError("NOT_FOUND");
        if (row.isStandard && input.name !== "Standard") {
          throw new ORPCError("FORBIDDEN", { message: "Standard view cannot be renamed" });
        }
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

  // Delete a view: your own personal one, or any (incl. shared) if admin. Standard is never deletable.
  remove: userProcedure.input(z.object({ id: z.string().uuid() })).handler(async ({ input, context }) => {
    const isAdmin = context.role === "admin" || context.role === "owner";
    const [row] = await db
      .select({ userId: uiVariant.userId, shared: uiVariant.shared, isStandard: uiVariant.isStandard })
      .from(uiVariant)
      .where(and(eq(uiVariant.id, input.id), eq(uiVariant.tenantId, context.tenantId)))
      .limit(1);
    if (!row) throw new ORPCError("NOT_FOUND");
    if (row.isStandard) throw new ORPCError("FORBIDDEN", { message: "Standard view cannot be deleted" });
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
