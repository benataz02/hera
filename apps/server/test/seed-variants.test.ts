import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, uiVariant, ListVariantDefZ, ObjectVariantDefZ } from "@hera/db";
import { b1VariantKey, entityVariantDefs, ensurePortalVariants } from "../src/seed-variants.ts";
import { ENTITY_PROFILES } from "../src/entity-profiles.ts";
import { makeTenant, makeUser } from "./harness.ts";

// The seeded definitions are written by hand and go straight into jsonb — the variants router
// would reject a malformed one on save, but nothing validates the seed itself.
describe("entityVariantDefs", () => {
  test("every curated entity produces a valid list + object definition", () => {
    for (const entity of Object.keys(ENTITY_PROFILES)) {
      const defs = entityVariantDefs(entity);
      expect(ListVariantDefZ.safeParse(defs.list).success).toBe(true);
      expect(ObjectVariantDefZ.safeParse(defs.object).success).toBe(true);
      expect(defs.list.select.length).toBeGreaterThan(0);
    }
  });

  test("a document shows its header fields and DocumentLines columns", () => {
    const { list, object } = entityVariantDefs("Orders");
    expect(list.select).toEqual(["DocNum", "CardCode", "CardName", "DocDueDate", "NumAtCard"]);
    expect(object.header.map((f) => f.name)).toEqual(list.select);
    expect(list.filterBar).toEqual(list.select);
    expect(list.orderby).toEqual([{ field: "DocEntry", dir: "desc" }]);
    const lines = object.sections.find((s) => s.id === "DocumentLines");
    expect(lines?.fields.map((f) => f.name)).toEqual([
      "VisOrder", "ItemCode", "ItemDescription", "Quantity", "UnitPrice", "LineTotal",
    ]);
  });

  // The pages read views under `b1:<Entity>` (EntityListPage). Seeding the bare name writes rows
  // nothing ever loads, and the list silently falls back to every column.
  test("views are seeded under the b1: key the pages read", () => {
    expect(b1VariantKey("Quotations")).toBe("b1:Quotations");
  });

  test("a non-document entity gets its profile's title/subtitle and no line section", () => {
    const { list, object } = entityVariantDefs("BusinessPartners");
    expect(list.select).toEqual(["CardName", "CardCode", "CardType"]);
    expect(object.sections).toEqual([]);
  });
});

// Real Postgres, like the rest of the integration suites — skipped when DATABASE_URL is unset.
describe.skipIf(!process.env.DATABASE_URL)("ensurePortalVariants", () => {
  test("portal document views are seeded, shared and read-only-shaped", async () => {
    const { tenantId } = await makeTenant();
    const user = await makeUser("owner", tenantId);
    await ensurePortalVariants(tenantId, user.userId);

    const rows = await db.select().from(uiVariant)
      .where(and(eq(uiVariant.tenantId, tenantId), eq(uiVariant.entity, "portal:Invoices")));
    expect(rows.map((r) => r.page).sort()).toEqual(["list", "object"]);
    const list = rows.find((r) => r.page === "list")!;
    expect(list.shared).toBe(true);
    expect(list.isStandard).toBe(true);
    const def = list.definition as { select: string[] };
    expect(def.select).toContain("DocNum");
    // The client IS the card: no CardCode/CardName, and no cost or margin fields.
    for (const banned of ["CardCode", "CardName", "GrossProfit", "SalesPersonCode"])
      expect(def.select).not.toContain(banned);

    // Idempotent.
    await ensurePortalVariants(tenantId, user.userId);
    const again = await db.select().from(uiVariant)
      .where(and(eq(uiVariant.tenantId, tenantId), eq(uiVariant.entity, "portal:Invoices")));
    expect(again).toHaveLength(2);
  });
});
