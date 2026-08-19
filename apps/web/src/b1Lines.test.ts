import { describe, expect, test } from "bun:test";
import {
  applyItemDefaults,
  recalcDocumentTotals,
  recalcLine,
  shouldReprice,
  type PriceSource,
} from "./b1Lines.ts";

describe("applyItemDefaults", () => {
  test("applies non-dirty sales defaults", () => {
    const next = applyItemDefaults(
      { ItemCode: "A1", Quantity: 2, UnitPrice: 10, priceSource: "sap" as PriceSource },
      {
        ItemDescription: "Pump",
        UoMCode: "pcs",
        TaxCode: "A1",
        WarehouseCode: "01",
        Length1: 1,
        Factor1: 2,
      },
      "sales-document",
      new Set(),
    );
    expect(next).toEqual({
      ItemCode: "A1",
      Quantity: 2,
      UnitPrice: 10,
      priceSource: "sap",
      ItemDescription: "Pump",
      UoMCode: "pcs",
      TaxCode: "A1",
      WarehouseCode: "01",
      Length1: 1,
      Factor1: 2,
    });
  });

  test("skips dirty paths", () => {
    const next = applyItemDefaults(
      { ItemCode: "A1", TaxCode: "KEEP", WarehouseCode: "99" },
      { TaxCode: "NEW", WarehouseCode: "01", ItemDescription: "Pump" },
      "sales-document",
      new Set(["DocumentLines.0.TaxCode"]),
      "DocumentLines.0",
    );
    expect(next.TaxCode).toBe("KEEP");
    expect(next.WarehouseCode).toBe("01");
    expect(next.ItemDescription).toBe("Pump");
  });

  test("does not overwrite config/manual unit price from sap defaults", () => {
    const defaults = { UnitPrice: 99, DiscountPercent: 5 };
    expect(
      applyItemDefaults(
        { UnitPrice: 12, priceSource: "config" as PriceSource },
        defaults,
        "sales-document",
        new Set(),
      ).UnitPrice,
    ).toBe(12);
    expect(
      applyItemDefaults(
        { UnitPrice: 12, priceSource: "manual" as PriceSource },
        defaults,
        "purchase-document",
        new Set(),
      ).UnitPrice,
    ).toBe(12);
  });

  test("sap blank price can take UnitPrice from defaults and stay sap", () => {
    const next = applyItemDefaults(
      { UnitPrice: null, priceSource: "sap" as PriceSource },
      { UnitPrice: 25, DiscountPercent: 0 },
      "sales-document",
      new Set(),
    );
    expect(next.UnitPrice).toBe(25);
    expect(next.DiscountPercent).toBe(0);
    expect(next.priceSource).toBe("sap");
  });
});

describe("recalcLine / recalcDocumentTotals", () => {
  test("recalcLine computes LineTotal from qty, price, discount", () => {
    expect(recalcLine({ Quantity: 10, UnitPrice: 5, DiscountPercent: 10 })).toEqual({
      Quantity: 10,
      UnitPrice: 5,
      DiscountPercent: 10,
      LineTotal: 45,
    });
  });

  test("recalcDocumentTotals sums line totals", () => {
    const doc = recalcDocumentTotals({
      DocumentLines: [
        { Quantity: 10, UnitPrice: 5, DiscountPercent: 10 },
        { Quantity: 2, UnitPrice: 10, DiscountPercent: 0 },
      ],
    });
    expect(doc.DocumentLines?.[0]).toEqual(expect.objectContaining({ LineTotal: 45 }));
    expect(doc.DocumentLines?.[1]).toEqual(expect.objectContaining({ LineTotal: 20 }));
    expect(doc.DocTotal).toBe(65);
  });
});

describe("shouldReprice", () => {
  test("only sap lines reprice on context paths", () => {
    expect(shouldReprice("sap", "ItemCode")).toBe(true);
    expect(shouldReprice("sap", "CardCode")).toBe(true);
    expect(shouldReprice("sap", "Quantity")).toBe(true);
    expect(shouldReprice("sap", "UoMEntry")).toBe(true);
    expect(shouldReprice("sap", "DocDate")).toBe(true);
    expect(shouldReprice("sap", "DocCurrency")).toBe(true);
    expect(shouldReprice("sap", "PriceList")).toBe(true);
    expect(shouldReprice("sap", "Comments")).toBe(false);
  });

  test("config and manual never auto-reprice", () => {
    expect(shouldReprice("config", "ItemCode")).toBe(false);
    expect(shouldReprice("manual", "Quantity")).toBe(false);
  });
});
