import { describe, expect, test } from "bun:test";
import type { EnabledEntity } from "@hera/db";
import {
  buildItemContextAgentPayload,
  mapItemDefaults,
  profiledItemSelect,
  resolveLookupTarget,
} from "../src/orpc/routers/entities.ts";

const quotation: EnabledEntity = {
  name: "Quotations",
  typeName: "Document",
  keys: ["DocEntry"],
  editable: true,
  properties: [
    {
      name: "CardCode",
      type: "Edm.String",
      nullable: true,
      lookup: { entitySet: "BusinessPartners", valueField: "CardCode", labelField: "CardName" },
    },
    { name: "CardName", type: "Edm.String", nullable: true },
    { name: "Comments", type: "Edm.String", nullable: true },
  ],
  collections: [
    {
      name: "DocumentLines",
      typeName: "DocumentLine",
      many: true,
      properties: [
        {
          name: "ItemCode",
          type: "Edm.String",
          nullable: true,
          lookup: { entitySet: "Items", valueField: "ItemCode", labelField: "ItemName" },
        },
        { name: "ItemDescription", type: "Edm.String", nullable: true },
        { name: "WarehouseCode", type: "Edm.String", nullable: true },
      ],
    },
  ],
};

describe("resolveLookupTarget", () => {
  test("resolves header CardCode lookup", () => {
    expect(resolveLookupTarget(quotation, "CardCode")).toEqual({
      entitySet: "BusinessPartners",
      valueField: "CardCode",
      labelField: "CardName",
    });
  });

  test("resolves collection ItemCode lookup", () => {
    expect(resolveLookupTarget(quotation, "ItemCode")).toEqual({
      entitySet: "Items",
      valueField: "ItemCode",
      labelField: "ItemName",
    });
  });

  test("rejects field without lookup", () => {
    expect(() => resolveLookupTarget(quotation, "Comments")).toThrow(/lookup/i);
  });

  test("rejects unknown field", () => {
    expect(() => resolveLookupTarget(quotation, "NotAField")).toThrow(/Unknown field|lookup/i);
  });
});

describe("profiled item select + defaults mapping", () => {
  test("sales select includes sales UoM/VAT/dims and not purchase equivalents", () => {
    const select = profiledItemSelect("sales-document");
    expect(select).toEqual(
      expect.arrayContaining([
        "ItemCode",
        "ItemName",
        "SalesUnit",
        "SalesVATGroup",
        "DefaultWarehouse",
        "SalesUnitLength",
        "SalesUnitWidth",
        "SalesUnitHeight",
        "SalesUnitVolume",
        "SalesUnitWeight",
        "SalesFactor1",
      ]),
    );
    expect(select).not.toContain("PurchaseUnit");
    expect(select).not.toContain("PurchaseVATGroup");
  });

  test("purchase select includes purchasing equivalents", () => {
    const select = profiledItemSelect("purchase-document");
    expect(select).toEqual(
      expect.arrayContaining([
        "ItemCode",
        "ItemName",
        "PurchaseUnit",
        "PurchaseVATGroup",
        "DefaultWarehouse",
        "PurchaseUnitLength",
        "PurchaseFactor1",
      ]),
    );
    expect(select).not.toContain("SalesUnit");
  });

  test("mapItemDefaults maps sales fields onto document line", () => {
    expect(
      mapItemDefaults(
        {
          ItemCode: "A1",
          ItemName: "Pump",
          SalesUnit: "pcs",
          SalesVATGroup: "A1",
          DefaultWarehouse: "01",
          SalesUnitLength: 1,
          SalesFactor1: 2,
        },
        "sales-document",
      ),
    ).toEqual({
      ItemCode: "A1",
      ItemDescription: "Pump",
      UoMCode: "pcs",
      TaxCode: "A1",
      WarehouseCode: "01",
      Length1: 1,
      Factor1: 2,
    });
  });

  test("mapItemDefaults maps purchase fields onto document line", () => {
    expect(
      mapItemDefaults(
        {
          ItemCode: "B1",
          ItemName: "Bolt",
          PurchaseUnit: "box",
          PurchaseVATGroup: "P1",
          DefaultWarehouse: "02",
          PurchaseUnitWeight: 0.5,
        },
        "purchase-document",
      ),
    ).toEqual({
      ItemCode: "B1",
      ItemDescription: "Bolt",
      UoMCode: "box",
      TaxCode: "P1",
      WarehouseCode: "02",
      Weight1: 0.5,
    });
  });
});

describe("buildItemContextAgentPayload", () => {
  test("sends fixed select and InventoryQuantity price params", () => {
    const payload = buildItemContextAgentPayload({
      family: "sales-document",
      itemCode: "A0001",
      cardCode: "C1",
      inventoryQuantity: 5,
      date: "2026-07-29",
    });
    expect(payload.itemCode).toBe("A0001");
    expect(payload.select).toEqual(profiledItemSelect("sales-document"));
    expect(payload.price).toEqual(
      expect.objectContaining({
        itemCode: "A0001",
        cardCode: "C1",
        inventoryQuantity: 5,
        date: "2026-07-29",
      }),
    );
    expect(JSON.stringify(payload)).not.toMatch(/"Quantity"\s*:/);
  });

  test("rejects master-data family for item context", () => {
    expect(() =>
      buildItemContextAgentPayload({ family: "master-data", itemCode: "A1" }),
    ).toThrow(/document/i);
  });
});
