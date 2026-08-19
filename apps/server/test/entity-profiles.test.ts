import { afterAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, uiVariant, type EntitySchema } from "@hera/db";
import { getEntityProfile } from "../src/entity-profiles.ts";
import { isEmptyObjectDef, seedObjectDef } from "../src/objectSeed.ts";
import { ensureStandardVariants } from "../src/seed-variants.ts";
import { call, makeTenant, makeUser, tenantHeaders } from "./harness.ts";
import { router } from "../src/orpc/router.ts";

const quotationSchema: EntitySchema = {
  name: "Quotations",
  typeName: "Document",
  keys: ["DocEntry"],
  properties: [
    { name: "DocEntry", type: "Edm.Int32", nullable: false },
    { name: "DocNum", type: "Edm.Int32", nullable: true },
    { name: "CardCode", type: "Edm.String", nullable: true },
    { name: "CardName", type: "Edm.String", nullable: true },
    { name: "DocDate", type: "Edm.DateTimeOffset", nullable: true },
    { name: "DocDueDate", type: "Edm.DateTimeOffset", nullable: true },
    { name: "DocumentStatus", type: "Edm.String", nullable: true },
    { name: "DocCurrency", type: "Edm.String", nullable: true },
    { name: "DocTotal", type: "Edm.Double", nullable: true },
    { name: "SalesPersonCode", type: "Edm.Int32", nullable: true },
    { name: "Comments", type: "Edm.String", nullable: true },
    { name: "NumAtCard", type: "Edm.String", nullable: true },
  ],
  collections: [
    {
      name: "DocumentLines",
      typeName: "DocumentLine",
      many: true,
      properties: [
        { name: "LineNum", type: "Edm.Int32", nullable: true },
        { name: "ItemCode", type: "Edm.String", nullable: true },
        { name: "ItemDescription", type: "Edm.String", nullable: true },
        { name: "Quantity", type: "Edm.Double", nullable: true },
        { name: "UnitPrice", type: "Edm.Double", nullable: true },
        { name: "DiscountPercent", type: "Edm.Double", nullable: true },
        { name: "TaxCode", type: "Edm.String", nullable: true },
        { name: "WarehouseCode", type: "Edm.String", nullable: true },
        { name: "LineTotal", type: "Edm.Double", nullable: true },
      ],
    },
  ],
};

describe("entity profiles and object seeds", () => {
  test("Quotations profile exposes editable DocumentLines identity", () => {
    expect(getEntityProfile("Quotations")?.collections.DocumentLines).toEqual(
      expect.objectContaining({ parentKey: "DocEntry", rowKey: "LineNum", editable: true }),
    );
  });

  test("unknown entities have no profile fields", () => {
    expect(getEntityProfile("Unknown")?.fields).toBeUndefined();
  });

  test("seed intersects preferred fields with metadata and hides DocEntry", () => {
    const profile = getEntityProfile("Quotations");
    const seed = seedObjectDef(quotationSchema, profile);
    expect(seed.header.map((x) => x.name)).toContain("DocTotal");
    expect(seed.sections.find((x) => x.id === "DocumentLines")?.fields.map((x) => x.name)).toEqual(
      expect.arrayContaining(["ItemCode", "Quantity", "UnitPrice", "LineTotal"]),
    );
    expect(seed.header.some((x) => x.name === "DocEntry")).toBe(false);
  });

  test("seed never invents properties missing from metadata", () => {
    const thin: EntitySchema = {
      ...quotationSchema,
      properties: quotationSchema.properties.filter((p) => p.name !== "DocTotal"),
      collections: [
        {
          ...quotationSchema.collections[0]!,
          properties: quotationSchema.collections[0]!.properties.filter((p) => p.name !== "UnitPrice"),
        },
      ],
    };
    const seed = seedObjectDef(thin, getEntityProfile("Quotations"));
    expect(seed.header.map((x) => x.name)).not.toContain("DocTotal");
    expect(seed.sections.find((x) => x.id === "DocumentLines")?.fields.map((x) => x.name)).not.toContain(
      "UnitPrice",
    );
  });

  test("isEmptyObjectDef covers legacy and new empty shapes", () => {
    expect(isEmptyObjectDef({ fields: [], sections: [] })).toBe(true);
    expect(isEmptyObjectDef({ header: [], sections: [] })).toBe(true);
    expect(
      isEmptyObjectDef({
        header: [{ name: "CardCode", visible: false }],
        sections: [{ id: "general", visible: false, fields: [{ name: "Comments", visible: false }] }],
      }),
    ).toBe(true);
    expect(
      isEmptyObjectDef({
        header: [{ name: "CardCode", visible: true }],
        sections: [],
      }),
    ).toBe(false);
  });

  test("Orders / Items / BusinessPartners are profiled; purchase docs share family", () => {
    expect(getEntityProfile("Orders")?.family).toBe("sales-document");
    expect(getEntityProfile("PurchaseOrders")?.family).toBe("purchase-document");
    expect(getEntityProfile("Items")?.family).toBe("master-data");
    expect(getEntityProfile("BusinessPartners")?.family).toBe("master-data");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("Standard variant upgrade and protection", () => {
  const tenants: string[] = [];

  afterAll(async () => {
    for (const tenantId of tenants) {
      await db.delete(uiVariant).where(eq(uiVariant.tenantId, tenantId));
    }
  });

  test("ensureStandardVariants upgrades only empty Standard object defs", async () => {
    const { tenantId } = await makeTenant();
    tenants.push(tenantId);
    const userId = crypto.randomUUID();
    const profile = getEntityProfile("Quotations");

    await ensureStandardVariants(tenantId, userId, "Quotations", quotationSchema, profile);
    const [first] = await db
      .select()
      .from(uiVariant)
      .where(
        and(
          eq(uiVariant.tenantId, tenantId),
          eq(uiVariant.entity, "Quotations"),
          eq(uiVariant.page, "object"),
          eq(uiVariant.isStandard, true),
        ),
      )
      .limit(1);
    expect(first).toBeDefined();
    const seeded = first!.definition as { header: Array<{ name: string }> };
    expect(seeded.header.map((x) => x.name)).toContain("DocTotal");

    // Non-empty custom Standard must not be overwritten.
    const custom = {
      header: [{ name: "Comments", visible: true }],
      sections: [{ id: "general", visible: true, fields: [{ name: "NumAtCard", visible: true }] }],
    };
    await db.update(uiVariant).set({ definition: custom }).where(eq(uiVariant.id, first!.id));
    await ensureStandardVariants(tenantId, userId, "Quotations", quotationSchema, profile);
    const [kept] = await db.select().from(uiVariant).where(eq(uiVariant.id, first!.id)).limit(1);
    expect(kept!.definition).toEqual(custom);

    // Legacy empty Standard is upgraded.
    await db
      .update(uiVariant)
      .set({ definition: { fields: [], sections: [] } })
      .where(eq(uiVariant.id, first!.id));
    await ensureStandardVariants(tenantId, userId, "Quotations", quotationSchema, profile);
    const [upgraded] = await db.select().from(uiVariant).where(eq(uiVariant.id, first!.id)).limit(1);
    const upgradedDef = upgraded!.definition as { header: Array<{ name: string }> };
    expect(upgradedDef.header.map((x) => x.name)).toContain("DocTotal");
  });

  test("Standard cannot be renamed or deleted", async () => {
    const { tenantId, slug } = await makeTenant();
    tenants.push(tenantId);
    const admin = await makeUser("owner", tenantId);
    const ctx = { context: { headers: tenantHeaders(slug, admin.cookie) } };
    const profile = getEntityProfile("Quotations");
    await ensureStandardVariants(tenantId, admin.userId, "Quotations", quotationSchema, profile);

    const listed = await call(router.variants.list, { page: "object", entity: "Quotations" }, ctx);
    const standard = listed.variants.find((v) => v.isStandard);
    expect(standard).toBeDefined();

    const rename = await call(
      router.variants.save,
      {
        id: standard!.id,
        page: "object" as const,
        entity: "Quotations",
        name: "NotStandard",
        shared: true,
        isDefault: true,
        definition: standard!.definition as {
          header: Array<{ name: string; visible: boolean }>;
          sections: Array<{ id: string; visible: boolean; fields: Array<{ name: string; visible: boolean }> }>;
        },
      },
      ctx,
    ).catch((e) => e as { code?: string });
    expect((rename as { code?: string }).code).toBe("FORBIDDEN");

    const remove = await call(router.variants.remove, { id: standard!.id }, ctx).catch(
      (e) => e as { code?: string },
    );
    expect((remove as { code?: string }).code).toBe("FORBIDDEN");
  });
});
