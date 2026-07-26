import { and, eq } from "drizzle-orm";
import { db, uiVariant } from "@hera/db";

// Variant seeding lives here, not in routers/variants.ts, so it imports @hera/db and nothing else.
// auth.ts calls it from the afterCreateOrganization hook, and routers/variants.ts pulls in base.ts
// which pulls in auth.ts — putting these in the router would close that cycle.

// Preseed the shared "Standard" view for both pages of an entity, idempotent via isStandard —
// called when an admin enables a B1 entity, on tenant creation, and from scripts/seed-standard.ts.
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
      definition:
        page === "list"
          ? { select: [], filter: [], orderby: [], filterBar: [] }
          : { fields: [], sections: [] },
    });
  }
}

// The configurator lists are variant-backed like the B1 entity lists, but they have no "enable"
// event to hang seeding off — so every tenant gets them at creation. `entity` is free text on
// ui_variant (no FK, no schema validation), so "models"/"configs" are legal keys as-is.
export async function ensureConfiguratorVariants(tenantId: string, userId: string) {
  for (const entity of ["models", "configs"]) await ensureStandardVariants(tenantId, userId, entity);

  // Replaces the old "Requested" tab on the configs list: a shared view instead of a bespoke filter
  // control, so it shows up in the same dropdown as everything else. Keyed by name — a tenant that
  // renames or deletes it does not get it back.
  const [hit] = await db
    .select({ id: uiVariant.id })
    .from(uiVariant)
    .where(
      and(
        eq(uiVariant.tenantId, tenantId),
        eq(uiVariant.page, "list"),
        eq(uiVariant.entity, "configs"),
        eq(uiVariant.name, "Requested"),
      ),
    )
    .limit(1);
  if (hit) return;
  await db.insert(uiVariant).values({
    tenantId,
    userId,
    page: "list",
    entity: "configs",
    name: "Requested",
    shared: true,
    isDefault: false,
    definition: {
      select: [],
      filter: [{ field: "status", op: "eq", value: "requested" }],
      orderby: [{ field: "updatedAt", dir: "desc" }],
      filterBar: ["status"],
    },
  });
}
