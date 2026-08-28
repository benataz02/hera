import { and, eq } from "drizzle-orm";
import { db, uiVariant, type ListVariantDef, type ObjectVariantDef, type VariantDef } from "@hera/db";
import { ENTITY_PROFILES } from "./entity-profiles.ts";

// Variant seeding lives here, not in routers/variants.ts, so it imports @hera/db and nothing else.
// auth.ts calls it from the afterCreateOrganization hook, and routers/variants.ts pulls in base.ts
// which pulls in auth.ts — putting these in the router would close that cycle.

const EMPTY_DEFS = {
  list: { select: [], filter: [], orderby: [], filterBar: [] } as ListVariantDef,
  object: { header: [], sections: [] } as ObjectVariantDef,
};

/** An empty Standard row means "show everything" — the state we may overwrite with defaults. */
function isEmptyDef(d: VariantDef): boolean {
  return "select" in d ? !d.select.length : !d.header.length && !d.sections.length;
}

export async function ensureStandardVariants(
  tenantId: string,
  userId: string,
  entity: string,
  defs: { list: ListVariantDef; object: ObjectVariantDef } = EMPTY_DEFS,
  force = false,
) {
  for (const page of ["list", "object"] as const) {
    const [hit] = await db
      .select({ id: uiVariant.id, definition: uiVariant.definition })
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

    const definition = defs[page];
    if (hit) {
      // Backfill a Standard row seeded before these defaults existed. An admin's edits survive —
      // only `force` overwrites a view someone has already shaped.
      if ((force || isEmptyDef(hit.definition)) && !isEmptyDef(definition)) {
        await db.update(uiVariant).set({ definition, updatedAt: new Date() }).where(eq(uiVariant.id, hit.id));
      }
      continue;
    }

    await db.insert(uiVariant).values({
      tenantId,
      userId,
      page,
      entity,
      name: "Standard",
      isStandard: true,
      shared: true,
      isDefault: true,
      definition,
    });
  }
}

// The configurator lists are variant-backed. `entity` is free text on ui_variant (no FK), so
// "models"/"configs" are legal keys as-is.
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

// --- B1 entity Standard views ------------------------------------------------------------------
// Without these every B1 list and object page renders whatever $metadata returns — ~90 columns on a
// sales document, which is unreadable and a wide read over the tunnel. The field lists are
// hand-picked for the same reason entity-profiles.ts is: no rule over $metadata picks "the five
// fields a salesperson looks at".

const DOC_HEADER = ["DocNum", "CardCode", "CardName", "DocDueDate", "NumAtCard"];
const DOC_LINES = ["VisOrder", "ItemCode", "ItemDescription", "Quantity", "UnitPrice", "LineTotal"];
const DOC_ENTITIES = new Set(["Quotations", "Orders", "DeliveryNotes", "Invoices", "PurchaseOrders"]);

const shown = (names: string[]) => names.map((name) => ({ name, visible: true }));

/** The Standard list + object definitions for one curated B1 entity. */
export function entityVariantDefs(entity: string): { list: ListVariantDef; object: ObjectVariantDef } {
  const profile = ENTITY_PROFILES[entity];
  const isDoc = DOC_ENTITIES.has(entity);
  // ponytail: a non-document entity gets the columns its profile already names (title + subtitle);
  // hand-pick a wider list per entity when someone asks for one.
  const header = isDoc
    ? DOC_HEADER
    : [profile?.titleField, ...(profile?.subtitleFields ?? [])].filter((f): f is string => !!f);

  return {
    // The header fields are also the filter bar: the five things you search a document list by are
    // the five it shows. Newest first — DocEntry, not DocNum, which restarts per series.
    list: {
      select: header,
      filter: [],
      orderby: isDoc ? [{ field: "DocEntry", dir: "desc" as const }] : [],
      filterBar: header,
    },
    object: {
      header: shown(header),
      // Only DocumentLines is laid out: it is the one collection with a canonical reading order.
      sections: isDoc ? [{ id: "DocumentLines", visible: true, fields: shown(DOC_LINES) }] : [],
    },
  };
}

/** The `entity` key a B1 page saves its views under — `b1:` namespaced so a B1 entity set can
 *  never collide with a HERA list key like "models". Must match EntityListPage's `b1:${entity}`. */
export const b1VariantKey = (entity: string) => `b1:${entity}`;

/** Standard list + object views for every curated B1 entity. Idempotent. */
export async function ensureEntityVariants(tenantId: string, userId: string, force = false) {
  for (const entity of Object.keys(ENTITY_PROFILES)) {
    await ensureStandardVariants(tenantId, userId, b1VariantKey(entity), entityVariantDefs(entity), force);
  }
}
